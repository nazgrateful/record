// Video conversion for saved screen recordings, streamed so long recordings
// don't have to fit in memory.
//
// Screen recordings are usually WebM (VP8/VP9 video, Opus sound), which
// iPhones, QuickTime and Windows' built-in player don't play. This turns them
// into MP4:
//   * with H.264 video (and AAC sound) when the browser can encode it
//     (Chrome/Edge on Windows/macOS, Safari): plays everywhere;
//   * otherwise with the VP9 video copied as is (fast, no quality loss),
//     which plays in Chrome, Firefox, Edge, Android and VLC.
// It can also make a WebM copy (VP9 + Opus) of any WebM.
//
// Also used to pick MediaRecorder formats so new screen recordings can be
// recorded straight to MP4.

import { Reader } from './decoders.js';

const LIBS = {
  webm: 'https://cdn.jsdelivr.net/npm/webm-muxer@5.1.4/build/webm-muxer.mjs',
  mp4: 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs',
};
const load = (lib) => import(LIBS[lib]).catch(() => {
  throw new Error('Could not load the converter (needs an internet connection the first time).');
});

// ------------------------------------------------------- what's possible --

const AVC = ['avc1.640028', 'avc1.4d0028', 'avc1.42002a', 'avc1.42001f'];

async function supported(kind, config) {
  try {
    const C = kind === 'video' ? window.VideoEncoder : window.AudioEncoder;
    return !!C && (await C.isConfigSupported(config)).supported;
  } catch { return false; }
}

let planPromise = null;
// { h264: bool, aac: bool, vp9: bool } for converting.
export function videoSupport() {
  if (!planPromise) {
    planPromise = (async () => {
      const v = { codec: AVC[0], width: 1280, height: 720, bitrate: 4e6, framerate: 30 };
      let h264 = false;
      for (const codec of AVC) if (await supported('video', { ...v, codec })) { h264 = true; break; }
      return {
        h264,
        aac: await supported('audio', { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }),
        vp9: await supported('video', { ...v, codec: 'vp09.00.10.08' }),
        decode: !!window.VideoDecoder,
      };
    })();
  }
  return planPromise;
}

export const VIDEO_FORMATS = [
  { id: 'v-mp4', ext: 'mp4', mime: 'video/mp4' },
  { id: 'v-webm', ext: 'webm', mime: 'video/webm' },
];

export async function videoFormatLabels() {
  const s = await videoSupport();
  return {
    'v-mp4': s.h264 ? 'MP4 video (H.264: plays everywhere)' : 'MP4 video (VP9: Chrome, Firefox, Android, VLC — not iPhone)',
    'v-webm': 'WebM video',
  };
}

// MediaRecorder formats for new recordings: MP4 (H.264) if possible.
export function recorderMp4(audio, video) {
  if (!window.MediaRecorder) return '';
  const list = !video
    ? ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4']
    : audio
      ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,opus', 'video/mp4;codecs=avc1,opus']
      : ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1'];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

// ------------------------------------------------------------ WebM demux --

const MASTER = new Set([0x18538067, 0x1549a966, 0x1f43b675, 0x1654ae6b, 0xae, 0xe1, 0xe0, 0xa0]);

// Yields { type: 'tracks', video, audio } once, then
// { type: 'video'|'audio', data, ts (µs), key } for every frame in order.
async function* webmFrames(blob, onProgress) {
  const r = new Reader(blob);
  const tracks = [];
  let track = null, scale = 1e6, cluster = 0, announced = false, vTrack = null, aTrack = null, n = 0;
  // Frames inside a BlockGroup are key frames unless the group has a
  // ReferenceBlock, which comes after the frame: hold it until the group ends.
  let group = null; // { end, frame }
  const vint = (i, keep) => {
    const b = r.at(i);
    let len = 1;
    while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
    let v = keep ? b : b & (0xff >> len), ones = v === (0xff >> len);
    for (let k = 1; k < len; k++) { v = v * 256 + r.at(i + k); if (r.at(i + k) !== 0xff) ones = false; }
    return [v, len, !keep && ones];
  };
  const uint = (size) => { let v = 0; for (let k = 0; k < size; k++) v = v * 256 + r.at(k); return v; };
  while (r.pos < r.size) {
    if (group && r.pos >= group.end) { if (group.frame) yield group.frame; group = null; }
    if ((await r.ensure(16)) < 2) break;
    const [id, il] = vint(0, true);
    const [size, sl, unknown] = vint(il, false);
    r.pos += il + sl;
    if (id === 0xa0 && !unknown) { if (group && group.frame) yield group.frame; group = { end: r.pos + size, frame: null }; continue; }
    if (MASTER.has(id)) { if (id === 0xae) tracks.push(track = {}); continue; }
    if (unknown) throw new Error('Unreadable WebM file.');
    await r.ensure(Math.min(size, 1 << 20));
    if (id === 0x2ad7b1) scale = uint(size);
    else if (id === 0xe7) cluster = uint(size);
    else if (id === 0xa3 || id === 0xa1) {
      if (!announced) {
        vTrack = tracks.find((t) => t.type === 1) || null;
        aTrack = tracks.find((t) => t.type === 2) || null;
        yield { type: 'tracks', video: vTrack, audio: aTrack };
        announced = true;
      }
      await r.ensure(size);
      const [num, nl] = vint(0, false);
      const rel = (r.at(nl) << 8 | r.at(nl + 1)) << 16 >> 16; // signed 16-bit
      const flags = r.at(nl + 2);
      const t = num === vTrack?.number ? 'video' : num === aTrack?.number ? 'audio' : null;
      if (t && !(flags & 0x06)) {
        const frame = { type: t, data: r.view(size).slice(nl + 3), ts: Math.round(((cluster + rel) * scale) / 1000), key: id === 0xa3 ? !!(flags & 0x80) : true };
        if (id === 0xa1 && group) group.frame = frame; else yield frame;
      }
      if (++n % 200 === 0) onProgress && onProgress(r.pos / r.size);
    } else if (id === 0xfb && group && group.frame) {
      group.frame.key = false; // refers to an earlier frame
    } else if (track) {
      if (id === 0xd7) track.number = uint(size);
      else if (id === 0x83) track.type = uint(size);
      else if (id === 0x86) track.codec = r.str(0, size).replace(/\0+$/, '');
      else if (id === 0x63a2) { await r.ensure(size); track.priv = r.copy(size); }
      else if (id === 0xb0) track.width = uint(size);
      else if (id === 0xba) track.height = uint(size);
      else if (id === 0xb5) { const v = new DataView(r.copy(size).buffer); track.rate = size === 4 ? v.getFloat32(0) : v.getFloat64(0); }
      else if (id === 0x9f) track.channels = uint(size);
    }
    r.pos += size;
  }
  if (group && group.frame) yield group.frame;
  if (!announced) throw new Error('No video or sound found in this file.');
  onProgress && onProgress(1);
}

const VCODEC = { V_VP8: 'vp8', V_VP9: 'vp09.00.10.08', V_AV1: 'av01.0.08M.08' };

// ---------------------------------------------------------------- convert --

export async function isWebm(blob) {
  const b = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}

// Converts a WebM recording to 'mp4' or 'webm'. Yields Blob parts { blob }.
export async function* convertVideo(blob, target, { onProgress } = {}) {
  if (!(await isWebm(blob))) throw new Error('Only WebM recordings can be converted to video here; this one can be downloaded as it is.');
  const support = await videoSupport();
  const frames = webmFrames(blob, onProgress);
  const first = await frames.next();
  if (first.done || first.value.type !== 'tracks') throw new Error('No video found in this file.');
  const { video: vt, audio: at } = first.value;
  if (!vt) throw new Error('This recording has no video; use the sound formats instead.');
  const srcCodec = VCODEC[vt.codec];
  if (!srcCodec) throw new Error(`Can't convert ${vt.codec} video.`);

  // Plan: copy what can be copied, re-encode the rest.
  const mp4 = target === 'mp4';
  const vOut = mp4 ? (support.h264 ? 'avc' : 'vp9') : srcCodec === 'vp8' ? 'vp8' : 'vp9';
  const copyVideo = (vOut === 'vp9' && srcCodec.startsWith('vp09')) || (vOut === 'vp8' && srcCodec === 'vp8');
  if (!copyVideo && !(support.decode && (vOut === 'avc' ? support.h264 : support.vp9))) throw new Error("This browser can't convert this video.");
  const aOut = at ? (mp4 && support.aac ? 'aac' : 'opus') : null;
  const copyAudio = at && aOut === 'opus' && at.codec === 'A_OPUS';
  if (at && !copyAudio && aOut === 'opus' && at.codec !== 'A_OPUS') throw new Error(`Can't convert ${at.codec} sound.`);

  // Output, written strictly in order (fragmented MP4 / streaming WebM).
  const lib = await load(mp4 ? 'mp4' : 'webm');
  let pending = [], expected = 0;
  const targetObj = new lib.StreamTarget({
    onData: (data, position) => {
      if (position !== expected) throw new Error('Unexpected seek while writing the file.');
      expected += data.byteLength;
      pending.push(data.slice());
    },
    chunked: true,
  });
  let W = vt.width || 1280, H = vt.height || 720;
  if (vOut === 'avc') { W -= W % 2; H -= H % 2; }
  const opusRate = 48000, ch = at ? at.channels || 2 : 0;
  const muxer = new lib.Muxer({
    target: targetObj,
    ...(mp4 ? { fastStart: 'fragmented' } : { type: 'webm', streaming: true }),
    video: { codec: mp4 ? vOut : { vp9: 'V_VP9', vp8: 'V_VP8' }[vOut], width: W, height: H, frameRate: 30 },
    ...(at ? { audio: { codec: mp4 ? aOut : 'A_OPUS', sampleRate: aOut === 'aac' ? 48000 : opusRate, numberOfChannels: ch } } : {}),
    firstTimestampBehavior: 'offset',
  });
  const take = () => { if (!pending.length) return null; const b = new Blob(pending); pending = []; return { blob: b }; };

  let error = null;
  const fail = (e) => { error = error || e; };

  // --- Video
  let vdec = null, venc = null, lastKey = -Infinity, prevV = null, firstV = true;
  const vMeta = () => ({ decoderConfig: { codec: srcCodec, codedWidth: vt.width, codedHeight: vt.height, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } } });
  const pushCopiedVideo = (f, nextTs) => {
    const meta = firstV ? vMeta() : undefined;
    if (mp4) muxer.addVideoChunkRaw(f.data, f.key ? 'key' : 'delta', f.ts, Math.max(1, nextTs - f.ts), meta);
    else muxer.addVideoChunkRaw(f.data, f.key ? 'key' : 'delta', f.ts, meta);
    firstV = false;
  };
  let canvas = null, ctx2d = null;
  if (!copyVideo) {
    venc = new VideoEncoder({ output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { fail(e); } }, error: fail });
    let codec = 'vp09.00.10.08';
    if (vOut === 'avc') {
      const level = W * H <= 1280 * 720 ? '1f' : W * H <= 1920 * 1088 ? '28' : W * H <= 2560 * 1600 ? '32' : '33';
      const tries = ['6400', '4d00', '4200'].map((p) => `avc1.${p}${level}`);
      codec = null;
      for (const c of tries) if (await supported('video', { codec: c, width: W, height: H, bitrate: 4e6, framerate: 30 })) { codec = c; break; }
      if (!codec) throw new Error(`This browser can't make ${W}×${H} H.264 video.`);
    } else if (vOut === 'vp8') codec = 'vp8';
    venc.configure({
      codec, width: W, height: H, framerate: 30, latencyMode: 'quality',
      bitrate: Math.round(Math.min(12e6, Math.max(1.5e6, W * H * 30 * 0.1))),
      ...(vOut === 'avc' ? { avc: { format: 'avc' } } : {}),
    });
    vdec = new VideoDecoder({
      output: (frame) => {
        try {
          let f = frame;
          if (frame.displayWidth !== W || frame.displayHeight !== H) {
            // The shared window changed size: fit it into the video size.
            if (!canvas) { canvas = new OffscreenCanvas(W, H); ctx2d = canvas.getContext('2d'); }
            ctx2d.fillStyle = '#000';
            ctx2d.fillRect(0, 0, W, H);
            const s = Math.min(W / frame.displayWidth, H / frame.displayHeight);
            const w = frame.displayWidth * s, h = frame.displayHeight * s;
            ctx2d.drawImage(frame, (W - w) / 2, (H - h) / 2, w, h);
            f = new VideoFrame(canvas, { timestamp: frame.timestamp });
            frame.close();
          }
          const key = f.timestamp - lastKey >= 2e6;
          if (key) lastKey = f.timestamp;
          venc.encode(f, { keyFrame: key });
          f.close();
        } catch (e) { fail(e); frame.close(); }
      },
      error: fail,
    });
    vdec.configure({ codec: srcCodec, codedWidth: vt.width, codedHeight: vt.height, ...(vt.priv && srcCodec.startsWith('av01') ? { description: vt.priv } : {}) });
  }

  // --- Audio
  let adec = null, aenc = null, prevA = null, firstA = true;
  const aMeta = () => ({ decoderConfig: { codec: 'opus', numberOfChannels: ch, sampleRate: opusRate, ...(at.priv ? { description: at.priv } : {}) } });
  const pushCopiedAudio = (f, nextTs) => {
    const meta = firstA ? aMeta() : undefined;
    if (mp4) muxer.addAudioChunkRaw(f.data, 'key', f.ts, Math.max(1, nextTs - f.ts), meta);
    else muxer.addAudioChunkRaw(f.data, 'key', f.ts, meta);
    firstA = false;
  };
  if (at && !copyAudio) {
    aenc = new AudioEncoder({ output: (chunk, meta) => { try { muxer.addAudioChunk(chunk, meta); } catch (e) { fail(e); } }, error: fail });
    aenc.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: ch, bitrate: 160000 });
    adec = new AudioDecoder({ output: (ad) => { try { aenc.encode(ad); } catch (e) { fail(e); } ad.close(); }, error: fail });
    adec.configure({ codec: 'opus', sampleRate: opusRate, numberOfChannels: ch, ...(at.priv ? { description: at.priv } : {}) });
  }

  let sawKey = false;
  for await (const f of frames) {
    if (error) throw error;
    if (f.type === 'video') {
      if (!sawKey) { if (!f.key) continue; sawKey = true; } // must start on a key frame
      if (copyVideo) { if (prevV) pushCopiedVideo(prevV, f.ts); prevV = f; }
      else {
        vdec.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.ts, data: f.data }));
        while (!error && (vdec.decodeQueueSize > 6 || venc.encodeQueueSize > 6)) await new Promise((r) => setTimeout(r, 5));
      }
    } else if (f.type === 'audio') {
      if (copyAudio) { if (prevA) pushCopiedAudio(prevA, f.ts); prevA = f; }
      else if (adec) adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: f.ts, data: f.data }));
    }
    const part = take();
    if (part) yield part;
  }
  if (prevV) pushCopiedVideo(prevV, prevV.ts + 33333);
  if (prevA) pushCopiedAudio(prevA, prevA.ts + 20000);
  if (vdec) { await vdec.flush(); vdec.close(); }
  if (venc) { await venc.flush(); venc.close(); }
  if (adec) { await adec.flush(); adec.close(); }
  if (aenc) { await aenc.flush(); aenc.close(); }
  if (error) throw error;
  muxer.finalize();
  const part = take();
  if (part) yield part;
}
