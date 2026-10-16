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

// ================================================================ editing --
//
// Exports an edited copy of a video: only the kept time ranges, joined with
// no gaps, with the sound kept (optionally louder/quieter), removed, or taken
// from the audio editor. Everything is decoded and re-encoded (screen
// recordings have very few key frames, so cutting needs re-encoding).

// ---- MP4 demux (normal and fragmented), video + sound.

function boxesOf(buf) {
  const out = [];
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let o = 0; o + 8 <= buf.length;) {
    let size = v.getUint32(o), head = 8;
    if (size === 1) { size = Number(v.getBigUint64(o + 8)); head = 16; }
    if (size === 0) size = buf.length - o;
    if (size < 8) break;
    out.push({ type: String.fromCharCode(...buf.subarray(o + 4, o + 8)), body: buf.subarray(o + head, o + size) });
    o += size;
  }
  return out;
}
const childOf = (buf, ...path) => {
  for (const t of path) { const b = buf && boxesOf(buf).find((x) => x.type === t); if (!b) return null; buf = b.body; }
  return buf;
};
const dvOf = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const hex2 = (n) => n.toString(16).padStart(2, '0');

async function topBoxes(r, fn) {
  r.pos = 0;
  while (r.pos < r.size) {
    if ((await r.ensure(16)) < 8) return;
    let size = r.at(0) * 2 ** 24 + ((r.at(1) << 16) | (r.at(2) << 8) | r.at(3));
    const type = r.str(4, 4);
    let head = 8;
    if (size === 1) { size = Number(new DataView(r.copy(16).buffer).getBigUint64(8)); head = 16; }
    if (size === 0) size = r.size - r.pos;
    if (size < 8) return;
    const start = r.pos;
    if ((await fn(type, start, size, head)) === false) return;
    r.pos = start + size;
  }
}

function mp4Track(trak) {
  const tkhd = dvOf(childOf(trak, 'tkhd'));
  const id = tkhd.getUint8(0) === 1 ? tkhd.getUint32(20) : tkhd.getUint32(12);
  const mdhd = dvOf(childOf(trak, 'mdia', 'mdhd'));
  const timescale = mdhd.getUint8(0) === 1 ? mdhd.getUint32(20) : mdhd.getUint32(12);
  const hdlr = childOf(trak, 'mdia', 'hdlr');
  const handler = String.fromCharCode(...hdlr.subarray(8, 12));
  const stbl = childOf(trak, 'mdia', 'minf', 'stbl');
  const entry = boxesOf(childOf(stbl, 'stsd').subarray(8))[0];
  const t = { id, timescale, stbl, kind: handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : null };
  if (!entry || !t.kind) return t;
  const e = entry.body;
  if (t.kind === 'video') {
    const v = dvOf(e);
    t.width = v.getUint16(24); t.height = v.getUint16(26);
    const kids = e.subarray(78);
    if (entry.type === 'avc1' || entry.type === 'avc3') {
      const c = childOf(kids, 'avcC');
      if (c) { t.codec = `avc1.${hex2(c[1])}${hex2(c[2])}${hex2(c[3])}`; t.description = c.slice(); }
    } else if (entry.type === 'vp09') {
      const c = childOf(kids, 'vpcC');
      t.codec = c ? `vp09.${String(c[4]).padStart(2, '0')}.${String(c[5]).padStart(2, '0')}.${String(c[6] >> 4).padStart(2, '0')}` : 'vp09.00.10.08';
    } else if (entry.type === 'av01') {
      const c = childOf(kids, 'av1C');
      t.codec = 'av01.0.08M.08';
      if (c) t.description = c.slice();
    } else if (entry.type === 'vp08') t.codec = 'vp8';
  } else {
    const v = dvOf(e);
    const ver = v.getUint16(8);
    t.channels = v.getUint16(16); t.rate = v.getUint32(24) >>> 16;
    const kids = e.subarray(28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0));
    if (entry.type === 'Opus') {
      const d = childOf(kids, 'dOps');
      if (d) {
        const head = new Uint8Array(19), h = new DataView(head.buffer), dv = dvOf(d);
        head.set([...'OpusHead'].map((x) => x.charCodeAt(0)));
        head[8] = 1; head[9] = d[1];
        h.setUint16(10, dv.getUint16(2), true); h.setUint32(12, dv.getUint32(4), true); h.setInt16(16, dv.getInt16(8), true);
        t.codec = 'opus'; t.rate = 48000; t.channels = d[1]; t.description = head;
      }
    } else if (entry.type === 'mp4a') {
      const esds = childOf(kids, 'esds');
      let asc = null, obj = 0;
      const walk = (b) => {
        for (let o = 0; o < b.length;) {
          const tag = b[o++];
          let len = 0, c;
          do { c = b[o++]; len = (len << 7) | (c & 0x7f); } while (c & 0x80);
          const body = b.subarray(o, o + len);
          if (tag === 3) { const f = body[2]; let k = 3 + (f & 0x80 ? 2 : 0); if (f & 0x40) k += 1 + body[k]; if (f & 0x20) k += 2; walk(body.subarray(k)); }
          else if (tag === 4) { obj = body[0]; walk(body.subarray(13)); }
          else if (tag === 5) asc = body.slice();
          o += len;
        }
      };
      if (esds) walk(esds.subarray(4));
      if (obj === 0x40 && asc) { t.codec = `mp4a.40.${asc[0] >> 3}`; t.description = asc; }
      else if (obj === 0x6b || obj === 0x69) t.codec = 'mp3';
    }
  }
  return t;
}

// Sample list of a non-fragmented track: [{ off, size, dts, cto, key }].
function sampleTable(t) {
  const stbl = t.stbl;
  const stsz = dvOf(childOf(stbl, 'stsz'));
  const fixed = stsz.getUint32(4), count = stsz.getUint32(8);
  if (!count) return [];
  const stsc = dvOf(childOf(stbl, 'stsc'));
  const runs = [];
  for (let i = 0, n = stsc.getUint32(4); i < n; i++) runs.push([stsc.getUint32(8 + 12 * i), stsc.getUint32(12 + 12 * i)]);
  const co = childOf(stbl, 'stco'), co64 = childOf(stbl, 'co64');
  const cv = dvOf(co || co64), chunks = cv.getUint32(4);
  const stts = dvOf(childOf(stbl, 'stts'));
  const cttsB = childOf(stbl, 'ctts'), ctts = cttsB && dvOf(cttsB);
  const stssB = childOf(stbl, 'stss'), stss = stssB && dvOf(stssB);
  const keys = stss ? new Set(Array.from({ length: stss.getUint32(4) }, (_, i) => stss.getUint32(8 + 4 * i) - 1)) : null;
  const out = new Array(count);
  let s = 0;
  for (let c = 0, run = 0; c < chunks && s < count; c++) {
    while (run + 1 < runs.length && runs[run + 1][0] <= c + 1) run++;
    let off = co ? cv.getUint32(8 + 4 * c) : Number(cv.getBigUint64(8 + 8 * c));
    for (let k = 0; k < runs[run][1] && s < count; k++, s++) {
      const size = fixed || stsz.getUint32(12 + 4 * s);
      out[s] = { off, size, dts: 0, cto: 0, key: keys ? keys.has(s) : true };
      off += size;
    }
  }
  let dts = 0;
  for (let i = 0, k = 0, n = stts.getUint32(4); i < n; i++) {
    const cnt = stts.getUint32(8 + 8 * i), d = stts.getUint32(12 + 8 * i);
    for (let j = 0; j < cnt && k < count; j++, k++) { out[k].dts = dts; dts += d; }
  }
  if (ctts) {
    const ver = ctts.getUint8(0);
    for (let i = 0, k = 0, n = ctts.getUint32(4); i < n; i++) {
      const cnt = ctts.getUint32(8 + 8 * i), o = ver === 1 ? ctts.getInt32(12 + 8 * i) : ctts.getUint32(12 + 8 * i);
      for (let j = 0; j < cnt && k < count; j++, k++) out[k].cto = o;
    }
  }
  return out;
}

async function* mp4Frames(blob, onProgress) {
  const r = new Reader(blob);
  let moov = null;
  await topBoxes(r, async (type, start, size, head) => {
    if (type !== 'moov') return true;
    r.pos = start;
    await r.ensure(size);
    moov = r.copy(size).subarray(head);
    return false;
  });
  if (!moov) throw new Error('Broken MP4 file (no moov box).');
  const traks = boxesOf(moov).filter((b) => b.type === 'trak').map((b) => mp4Track(b.body));
  const vt = traks.find((t) => t.kind === 'video' && t.codec) || null;
  const at = traks.find((t) => t.kind === 'audio' && t.codec) || null;
  yield { type: 'tracks', video: vt && { codec: vt.codec, width: vt.width, height: vt.height, description: vt.description }, audio: at && { codec: at.codec, rate: at.rate, channels: at.channels, description: at.description } };
  const byId = new Map([vt, at].filter(Boolean).map((t) => [t.id, t]));
  const emit = function* (list) {
    list.sort((a, b) => a.off - b.off);
    for (const s of list) yield s;
  };
  const read = async (s) => {
    r.pos = s.off;
    if ((await r.ensure(s.size)) < s.size) return null;
    const t = s.t;
    return { type: t.kind, data: r.copy(s.size), ts: Math.round(((s.dts + s.cto) * 1e6) / t.timescale), key: s.key };
  };
  const all = [];
  for (const t of byId.values()) for (const s of sampleTable(t)) all.push({ ...s, t });
  if (all.length) {
    let n = 0;
    for (const s of emit(all)) {
      const f = await read(s);
      if (!f) return;
      yield f;
      if (++n % 200 === 0) onProgress && onProgress(s.off / r.size);
    }
    onProgress && onProgress(1);
    return;
  }
  // Fragmented: samples are listed in each moof.
  const mvex = childOf(moov, 'mvex');
  const trex = new Map((mvex ? boxesOf(mvex) : []).filter((b) => b.type === 'trex').map((b) => { const v = dvOf(b.body); return [v.getUint32(4), { dur: v.getUint32(12), size: v.getUint32(16), flags: v.getUint32(20) }]; }));
  const dtsOf = new Map();
  const moofs = [];
  await topBoxes(r, async (type, start, size, head) => {
    if (type === 'moof') moofs.push([start, size, head]);
    return true;
  });
  for (const [start, size, head] of moofs) {
    r.pos = start;
    await r.ensure(size);
    const moof = r.copy(size).subarray(head);
    const list = [];
    for (const traf of boxesOf(moof).filter((b) => b.type === 'traf')) {
      const kids = boxesOf(traf.body);
      const tf = kids.find((b) => b.type === 'tfhd');
      if (!tf) continue;
      const v = dvOf(tf.body), flags = v.getUint32(0) & 0xffffff, id = v.getUint32(4), t = byId.get(id);
      if (!t) continue;
      const d = trex.get(id) || { dur: 0, size: 0, flags: 0 };
      let o = 8, base = start, dDur = d.dur, dSize = d.size, dFlags = d.flags;
      if (flags & 0x1) { base = Number(v.getBigUint64(o)); o += 8; }
      if (flags & 0x2) o += 4;
      if (flags & 0x8) { dDur = v.getUint32(o); o += 4; }
      if (flags & 0x10) { dSize = v.getUint32(o); o += 4; }
      if (flags & 0x20) { dFlags = v.getUint32(o); o += 4; }
      const tfdt = kids.find((b) => b.type === 'tfdt');
      let dts = dtsOf.get(id) || 0;
      if (tfdt) { const w = dvOf(tfdt.body); dts = w.getUint8(0) === 1 ? Number(w.getBigUint64(4)) : w.getUint32(4); }
      for (const tr of kids.filter((b) => b.type === 'trun')) {
        const u = dvOf(tr.body), tflags = u.getUint32(0) & 0xffffff, ver = u.getUint8(0), n = u.getUint32(4);
        let p = 8, off = base, first = null;
        if (tflags & 0x1) { off = base + u.getInt32(p); p += 4; }
        if (tflags & 0x4) { first = u.getUint32(p); p += 4; }
        for (let i = 0; i < n; i++) {
          let dur = dDur, sz = dSize, fl = i === 0 && first !== null ? first : dFlags, cto = 0;
          if (tflags & 0x100) { dur = u.getUint32(p); p += 4; }
          if (tflags & 0x200) { sz = u.getUint32(p); p += 4; }
          if (tflags & 0x400) { fl = u.getUint32(p); p += 4; }
          if (tflags & 0x800) { cto = ver === 1 ? u.getInt32(p) : u.getUint32(p); p += 4; }
          list.push({ off, size: sz, dts, cto, key: t.kind === 'audio' || !((fl >> 16) & 1), t });
          off += sz; dts += dur;
        }
      }
      dtsOf.set(id, dts);
    }
    for (const s of emit(list)) { const f = await read(s); if (!f) return; yield f; }
    onProgress && onProgress((start + size) / r.size);
  }
  onProgress && onProgress(1);
}

// WebM frames in the same shape as mp4Frames.
async function* webmFramesStd(blob, onProgress) {
  const it = webmFrames(blob, onProgress);
  for await (const f of it) {
    if (f.type === 'tracks') {
      const v = f.video, a = f.audio;
      yield {
        type: 'tracks',
        video: v && VCODEC[v.codec] ? { codec: VCODEC[v.codec], width: v.width, height: v.height, description: v.codec === 'V_AV1' ? v.priv : undefined } : null,
        audio: a && a.codec === 'A_OPUS' ? { codec: 'opus', rate: 48000, channels: a.channels || 2, description: a.priv } : null,
      };
    } else yield f;
  }
}

export async function videoFrames(blob, onProgress) {
  return (await isWebm(blob)) ? webmFramesStd(blob, onProgress) : mp4Frames(blob, onProgress);
}

// ---- export

// keep: [[startSec, endSec], …] (sorted); null = everything.
// sound: { mode: 'keep' | 'mute', gainDb, source? } — source: { rate, ch,
// read(posSamples, n) → planar floats } to use instead of the video's own
// sound (the audio editor), on the same timeline as the video.
export async function* exportEdited(blob, target, { keep = null, sound = { mode: 'keep', gainDb: 0 }, duration, onProgress } = {}) {
  const support = await videoSupport();
  const frames = await videoFrames(blob, onProgress);
  const first = await frames.next();
  if (first.done || first.value.type !== 'tracks') throw new Error('No video found in this file.');
  const { video: vt, audio: at } = first.value;
  if (!vt) throw new Error('This file has no video.');
  try {
    if (!(await VideoDecoder.isConfigSupported({ codec: vt.codec, codedWidth: vt.width, codedHeight: vt.height, description: vt.description })).supported) throw 0;
  } catch { throw new Error(`This browser can't read this video (${vt.codec}). Try Chrome or Edge.`); }

  const mp4 = target === 'mp4';
  const vOut = mp4 ? (support.h264 ? 'avc' : 'vp9') : support.vp9 ? 'vp9' : 'vp8';
  const useSource = sound.mode !== 'mute' && sound.source;
  const hasAudio = sound.mode !== 'mute' && (useSource || at);
  const aOut = mp4 && support.aac ? 'aac' : 'opus';
  const aRate = 48000;
  const aCh = hasAudio ? Math.min(2, useSource ? sound.source.ch : at.channels || 2) : 0;
  const gain = Math.pow(10, (sound.gainDb || 0) / 20);

  // Kept ranges in µs, and where each starts in the output.
  const total = (duration || 1e9) * 1e6;
  const ranges = (keep && keep.length ? keep : [[0, duration || 1e9]]).map(([a, b]) => [a * 1e6, Math.min(b * 1e6, total)]);
  let acc = 0;
  const starts = ranges.map(([a, b]) => { const s = acc; acc += b - a; return s; });
  const outLen = acc;
  const rangeOf = (t) => { for (let i = 0; i < ranges.length; i++) if (t >= ranges[i][0] && t < ranges[i][1]) return i; return -1; };

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
  W -= W % 2; H -= H % 2;
  const muxer = new lib.Muxer({
    target: targetObj,
    ...(mp4 ? { fastStart: 'fragmented' } : { type: 'webm', streaming: true }),
    video: { codec: mp4 ? vOut : { vp9: 'V_VP9', vp8: 'V_VP8' }[vOut], width: W, height: H, frameRate: 30 },
    ...(hasAudio ? { audio: { codec: mp4 ? aOut : 'A_OPUS', sampleRate: aRate, numberOfChannels: aCh } } : {}),
    firstTimestampBehavior: 'offset',
  });
  const take = () => { if (!pending.length) return null; const b = new Blob(pending); pending = []; return { blob: b }; };
  let error = null;
  const fail = (e) => { error = error || e; };

  // Video: decode everything, keep and re-time the kept frames, encode.
  let codec = vOut === 'vp8' ? 'vp8' : 'vp09.00.10.08';
  if (vOut === 'avc') {
    const level = W * H <= 1280 * 720 ? '1f' : W * H <= 1920 * 1088 ? '28' : W * H <= 2560 * 1600 ? '32' : '33';
    codec = null;
    for (const c of ['6400', '4d00', '4200'].map((p) => `avc1.${p}${level}`)) if (await supported('video', { codec: c, width: W, height: H, bitrate: 4e6, framerate: 30 })) { codec = c; break; }
    if (!codec) throw new Error(`This browser can't make ${W}×${H} H.264 video.`);
  }
  const venc = new VideoEncoder({ output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { fail(e); } }, error: fail });
  venc.configure({ codec, width: W, height: H, framerate: 30, latencyMode: 'quality', bitrate: Math.round(Math.min(12e6, Math.max(1.5e6, W * H * 30 * 0.1))), ...(vOut === 'avc' ? { avc: { format: 'avc' } } : {}) });
  let lastKey = -Infinity, lastRange = -1, canvas = null, g2 = null, lastOut = -1;
  const vdec = new VideoDecoder({
    output: (frame) => {
      try {
        const ri = rangeOf(frame.timestamp);
        if (ri < 0) { frame.close(); return; }
        const t = Math.round(starts[ri] + frame.timestamp - ranges[ri][0]);
        if (t <= lastOut) { frame.close(); return; }
        lastOut = t;
        let src = frame;
        if (frame.displayWidth !== W || frame.displayHeight !== H) {
          if (!canvas) { canvas = new OffscreenCanvas(W, H); g2 = canvas.getContext('2d'); }
          g2.fillStyle = '#000'; g2.fillRect(0, 0, W, H);
          const s = Math.min(W / frame.displayWidth, H / frame.displayHeight);
          g2.drawImage(frame, (W - frame.displayWidth * s) / 2, (H - frame.displayHeight * s) / 2, frame.displayWidth * s, frame.displayHeight * s);
          src = canvas;
        }
        const out = new VideoFrame(src, { timestamp: t });
        frame.close();
        const key = ri !== lastRange || t - lastKey >= 2e6;
        if (key) { lastKey = t; lastRange = ri; }
        venc.encode(out, { keyFrame: key });
        out.close();
      } catch (e) { fail(e); frame.close(); }
    },
    error: fail,
  });
  vdec.configure({ codec: vt.codec, codedWidth: vt.width, codedHeight: vt.height, ...(vt.description ? { description: vt.description } : {}) });

  // Sound: one continuous stream of the kept parts, in order.
  let aenc = null, aFrames = 0, resampler = null, resRate = 0;
  const audioOut = (planar, rate) => {
    if (!aenc || !planar[0].length) return;
    let chs = Array.from({ length: aCh }, (_, c) => {
      const x = planar[c % planar.length];
      if (gain === 1) return x;
      const y = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) { const v = x[i] * gain; y[i] = v > 1 ? 1 : v < -1 ? -1 : v; }
      return y;
    });
    if (rate !== aRate) {
      if (!resampler || resRate !== rate) { resampler = new SimpleResampler(aCh, rate / aRate); resRate = rate; }
      chs = resampler.push(chs);
      if (!chs[0].length) return;
    }
    const n = chs[0].length, data = new Float32Array(n * aCh);
    chs.forEach((x, c) => data.set(x, c * n));
    const ad = new AudioData({ format: 'f32-planar', sampleRate: aRate, numberOfFrames: n, numberOfChannels: aCh, timestamp: Math.round((aFrames * 1e6) / aRate), data });
    aFrames += n;
    aenc.encode(ad);
    ad.close();
  };
  let adec = null;
  if (hasAudio) {
    aenc = new AudioEncoder({ output: (chunk, meta) => { try { muxer.addAudioChunk(chunk, meta); } catch (e) { fail(e); } }, error: fail });
    aenc.configure({ codec: aOut === 'aac' ? 'mp4a.40.2' : 'opus', sampleRate: aRate, numberOfChannels: aCh, bitrate: 160000 });
    if (!useSource) {
      adec = new AudioDecoder({
        output: (ad) => {
          try {
            const rate = ad.sampleRate, n = ad.numberOfFrames, t0 = ad.timestamp;
            const planar = [];
            for (let c = 0; c < ad.numberOfChannels; c++) { const f = new Float32Array(n); ad.copyTo(f, { planeIndex: c, format: 'f32-planar' }); planar.push(f); }
            // Keep only the samples inside kept ranges.
            for (const [a, b] of ranges) {
              const s0 = Math.max(0, Math.ceil(((a - t0) * rate) / 1e6)), s1 = Math.min(n, Math.ceil(((b - t0) * rate) / 1e6));
              if (s1 > s0) audioOut(planar.map((x) => x.subarray(s0, s1)), rate);
            }
          } catch (e) { fail(e); }
          ad.close();
        },
        error: fail,
      });
      adec.configure({ codec: at.codec, sampleRate: at.rate, numberOfChannels: at.channels, ...(at.description ? { description: at.description } : {}) });
    }
  }
  // Sound from the audio editor, pumped along with the video.
  let srcRange = 0, srcPos = ranges[0][0];
  const pumpSource = async (untilUs) => {
    const src = sound.source;
    while (srcRange < ranges.length && srcPos < untilUs) {
      const [, b] = ranges[srcRange];
      const end = Math.min(b, untilUs, srcPos + 2e6);
      const p0 = Math.round((srcPos * src.rate) / 1e6), p1 = Math.min(src.total, Math.round((end * src.rate) / 1e6));
      if (p1 > p0) audioOut(await src.read(p0, p1 - p0), src.rate);
      else if (p0 >= src.total && end > srcPos) audioOut(Array.from({ length: aCh }, () => new Float32Array(Math.round(((end - srcPos) * src.rate) / 1e6))), src.rate);
      srcPos = end;
      if (srcPos >= b) { srcRange++; srcPos = srcRange < ranges.length ? ranges[srcRange][0] : srcPos; }
    }
  };

  let sawKey = false;
  for await (const f of frames) {
    if (error) throw error;
    if (f.type === 'video') {
      if (!sawKey) { if (!f.key) continue; sawKey = true; }
      vdec.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.ts, data: f.data }));
      while (!error && (vdec.decodeQueueSize > 6 || venc.encodeQueueSize > 6)) await new Promise((r) => setTimeout(r, 5));
      if (useSource) await pumpSource(f.ts + 1e6);
    } else if (f.type === 'audio' && adec) {
      adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: f.ts, data: f.data }));
    }
    const part = take();
    if (part) yield part;
  }
  await vdec.flush(); vdec.close();
  await venc.flush(); venc.close();
  if (adec) { await adec.flush(); adec.close(); }
  if (useSource) await pumpSource(Infinity);
  if (aenc) { await aenc.flush(); aenc.close(); }
  if (error) throw error;
  muxer.finalize();
  const part = take();
  if (part) yield part;
  return outLen;
}

// Small streaming linear resampler for the sound (in rate / out rate = ratio).
class SimpleResampler {
  constructor(ch, ratio) { this.ch = ch; this.ratio = ratio; this.t = 0; this.prev = new Float32Array(ch); }
  push(chs) {
    const n = chs[0].length, out = [];
    const count = Math.max(0, Math.floor((n - this.t) / this.ratio));
    for (let c = 0; c < this.ch; c++) {
      const x = chs[c], y = new Float32Array(count);
      for (let j = 0; j < count; j++) {
        const p = this.t + j * this.ratio, i = Math.floor(p), f = p - i;
        const a = i < 0 ? this.prev[c] : x[i], b = x[Math.min(n - 1, i + 1)];
        y[j] = a + (b - a) * f;
      }
      this.prev[c] = x[n - 1];
      out.push(y);
    }
    this.t = this.t + count * this.ratio - n;
    return out;
  }
}
