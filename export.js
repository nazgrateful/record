// Converting and exporting audio, streamed so that even 12-hour files never
// have to be held in memory at once.
//
// A *source* gives planar float audio window by window: either the editor's
// document (docSource) or any audio/video file decoded on the fly
// (fileSource). `encode(source, format)` turns it into a series of parts
// { blob } to write one after another. A part with `at: 0` instead replaces
// the bytes at the very start of the file (a header whose sizes are only
// known at the end); writeParts / partsToBlob handle that.
//
// Formats: WAV (16-bit, 24-bit, 32-bit float; RF64 above 4 GB), MP3 (LAME,
// loaded on demand), Opus in Ogg or WebM, and AAC in M4A (WebCodecs; the
// muxers are loaded on demand).

import { readRange } from './pcm.js';
import { decodeFile } from './decoders.js';

const WIN = 1 << 18;
const LIBS = {
  lame: 'https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/dist/lamejs.js',
  webm: 'https://cdn.jsdelivr.net/npm/webm-muxer@5.1.4/build/webm-muxer.mjs',
  mp4: 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs',
};
const load = (lib) => import(LIBS[lib]).catch(() => {
  throw new Error('Could not load the converter (needs an internet connection the first time).');
});

export const FORMATS = [
  { id: 'mp3', label: 'MP3 (plays everywhere)', ext: 'mp3', mime: 'audio/mpeg', lossy: true },
  { id: 'm4a', label: 'M4A / AAC (Apple, phones)', ext: 'm4a', mime: 'audio/mp4', lossy: true, codec: 'mp4a.40.2' },
  { id: 'ogg', label: 'Opus in OGG (smallest)', ext: 'ogg', mime: 'audio/ogg', lossy: true, codec: 'opus' },
  { id: 'webm', label: 'Opus in WebM', ext: 'webm', mime: 'audio/webm', lossy: true, codec: 'opus' },
  { id: 'wav16', label: 'WAV 16-bit (CD quality)', ext: 'wav', mime: 'audio/wav', bits: 16 },
  { id: 'wav24', label: 'WAV 24-bit (studio)', ext: 'wav', mime: 'audio/wav', bits: 24 },
  { id: 'wav32f', label: 'WAV 32-bit float', ext: 'wav', mime: 'audio/wav', bits: 32 },
];
export const formatById = (id) => FORMATS.find((f) => f.id === id) || FORMATS[0];

// Which formats this browser can produce.
export async function supportedFormats() {
  const ok = {};
  for (const f of FORMATS) {
    if (!f.codec) { ok[f.id] = true; continue; }
    ok[f.id] = false;
    if (!window.AudioEncoder) continue;
    try {
      ok[f.id] = (await AudioEncoder.isConfigSupported({ codec: f.codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported;
    } catch {}
  }
  return ok;
}

// ------------------------------------------------------------- sources --

export function docSource(doc, total) {
  return {
    rate: doc.rate, ch: doc.ch, total,
    async *windows(onProgress) {
      for (let pos = 0; pos < total; pos += WIN) {
        const n = Math.min(WIN, total - pos);
        yield await readRange(doc, pos, n);
        onProgress && onProgress((pos + n) / total);
      }
    },
  };
}

// Decodes a file while it's being converted. Resolves once the audio format
// is known.
export function fileSource(file, { fallback } = {}) {
  const queue = [];
  let done = false, error = null, wake = null, space = null, progress = 0;
  let resolveFmt, rejectFmt;
  const fmt = new Promise((res, rej) => { resolveFmt = res; rejectFmt = rej; });
  const ping = () => { if (wake) { wake(); wake = null; } };
  const sink = {
    push(planar, rate) {
      resolveFmt({ rate, ch: planar.length });
      queue.push(planar);
      ping();
    },
    async drain() { while (queue.length > 16) await new Promise((r) => { space = r; }); },
  };
  decodeFile(file, sink, { fallback, onProgress: (f) => { progress = f; } })
    .then(() => { done = true; ping(); rejectFmt(new Error('No audio found in this file.')); },
      (err) => { error = err; done = true; ping(); rejectFmt(err); });
  return fmt.then(({ rate, ch }) => ({
    rate, ch, total: null,
    async *windows(onProgress) {
      while (true) {
        if (queue.length) {
          const x = queue.shift();
          if (space) { space(); space = null; }
          yield x;
          onProgress && onProgress(progress);
          continue;
        }
        if (error) throw error;
        if (done) return;
        await new Promise((r) => { wake = r; });
      }
    },
  }));
}

// Windows converted to `rate` and `ch` channels (mixing down or copying).
async function* adapt(source, { rate, ch }, onProgress) {
  let inPos = 0, outPos = 0;
  for await (let chs of source.windows(onProgress)) {
    if (chs.length !== ch) {
      if (ch === 1) {
        const m = new Float32Array(chs[0].length);
        for (const x of chs) for (let i = 0; i < m.length; i++) m[i] += x[i] / chs.length;
        chs = [m];
      } else chs = Array.from({ length: ch }, (_, c) => chs[c % chs.length]);
    }
    const n = chs[0].length;
    if (source.rate !== rate) {
      const end = Math.round(((inPos + n) * rate) / source.rate);
      const oc = new OfflineAudioContext(ch, Math.max(1, end - outPos), rate);
      const b = oc.createBuffer(ch, n, source.rate);
      chs.forEach((x, c) => b.copyToChannel(x, c));
      const s = oc.createBufferSource();
      s.buffer = b;
      s.connect(oc.destination);
      s.start();
      const rb = await oc.startRendering();
      chs = Array.from({ length: ch }, (_, c) => rb.getChannelData(c));
      outPos = end;
    }
    inPos += n;
    yield chs;
  }
}

// ---------------------------------------------------------------- encode --

export function encode(source, formatId, { bitrate = 128000, onProgress } = {}) {
  const f = formatById(formatId);
  if (f.bits) return wav(source, f.bits, onProgress);
  if (f.id === 'mp3') return mp3(source, bitrate, onProgress);
  return webcodecs(source, f, bitrate, onProgress);
}

async function* wav(source, bits, onProgress) {
  const ch = source.ch, rate = source.rate, bps = bits / 8, float = bits === 32;
  // RF64 layout (80 bytes) always, so the header has the same size whatever
  // the final length; it's written as plain RIFF/WAVE (with a JUNK chunk in
  // place of ds64) when the file is under 4 GB.
  const header = (frames) => {
    const dataBytes = frames * ch * bps;
    const big = dataBytes + 72 > 0xffffffff;
    const v = new DataView(new ArrayBuffer(80));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, big ? 'RF64' : 'RIFF'); v.setUint32(4, big ? 0xffffffff : 72 + dataBytes, true); str(8, 'WAVE');
    str(12, big ? 'ds64' : 'JUNK'); v.setUint32(16, 28, true);
    if (big) { v.setBigUint64(20, BigInt(72 + dataBytes), true); v.setBigUint64(28, BigInt(dataBytes), true); v.setBigUint64(36, BigInt(frames), true); }
    str(48, 'fmt '); v.setUint32(52, 16, true); v.setUint16(56, float ? 3 : 1, true); v.setUint16(58, ch, true);
    v.setUint32(60, rate, true); v.setUint32(64, rate * ch * bps, true); v.setUint16(68, ch * bps, true); v.setUint16(70, bits, true);
    str(72, 'data'); v.setUint32(76, big ? 0xffffffff : dataBytes, true);
    return new Blob([v.buffer]);
  };
  yield { blob: header(source.total || 0) };
  let frames = 0;
  for await (const chs of source.windows(onProgress)) {
    const n = chs[0].length;
    const out = new DataView(new ArrayBuffer(n * ch * bps));
    for (let i = 0, o = 0; i < n; i++) {
      for (let c = 0; c < ch; c++, o += bps) {
        const x = chs[c][i];
        if (float) { out.setFloat32(o, x, true); continue; }
        const v = x >= 1 ? 1 : x <= -1 ? -1 : x;
        if (bits === 16) out.setInt16(o, Math.round(v * 32767), true);
        else { const s = Math.round(v * 8388607); out.setUint8(o, s & 255); out.setUint8(o + 1, (s >> 8) & 255); out.setInt8(o + 2, s >> 16); }
      }
    }
    frames += n;
    yield { blob: new Blob([out.buffer]) };
  }
  if (frames !== source.total) yield { blob: header(frames), at: 0 };
}

const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

async function* mp3(source, bitrate, onProgress) {
  const { Mp3Encoder } = await load('lame');
  const ch = Math.min(2, source.ch);
  const rate = MP3_RATES.includes(source.rate) ? source.rate : 44100;
  const kbps = Math.max(32, Math.min(320, Math.round(bitrate / 1000)));
  const enc = new Mp3Encoder(ch, rate, kbps);
  const toInt = (x) => {
    const o = new Int16Array(x.length);
    for (let i = 0; i < x.length; i++) { const v = x[i]; o[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767); }
    return o;
  };
  for await (const chs of adapt(source, { rate, ch }, onProgress)) {
    const l = toInt(chs[0]), r = ch === 2 ? toInt(chs[1]) : undefined;
    const out = [];
    for (let i = 0; i < l.length; i += 1152 * 20) {
      const buf = enc.encodeBuffer(l.subarray(i, i + 1152 * 20), r && r.subarray(i, i + 1152 * 20));
      if (buf.length) out.push(new Uint8Array(buf));
    }
    if (out.length) yield { blob: new Blob(out) };
    await new Promise((res) => setTimeout(res)); // let the page breathe
  }
  const end = enc.flush();
  if (end.length) yield { blob: new Blob([new Uint8Array(end)]) };
}

// Opus (Ogg, WebM) and AAC (M4A) through WebCodecs' AudioEncoder.
async function* webcodecs(source, f, bitrate, onProgress) {
  const ch = Math.min(2, source.ch);
  const rate = f.codec === 'opus' ? 48000 : [44100, 48000].includes(source.rate) ? source.rate : 48000;
  const config = { codec: f.codec, sampleRate: rate, numberOfChannels: ch, bitrate };
  if (!window.AudioEncoder || !(await AudioEncoder.isConfigSupported(config).catch(() => ({}))).supported) {
    throw new Error(`This browser can't make ${f.label.split(' (')[0]} files. Try MP3 or WAV.`);
  }
  const out = f.id === 'ogg' ? oggContainer(source.rate) : await muxContainer(f.id, { codec: f.codec, rate, ch });
  let error = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => { try { out.add(chunk, meta); } catch (e) { error = error || e; } },
    error: (e) => { error = error || e; },
  });
  enc.configure(config);
  let ts = 0, frames = 0;
  for await (const chs of adapt(source, { rate, ch }, onProgress)) {
    const n = chs[0].length;
    const data = new Float32Array(n * ch);
    chs.forEach((x, c) => data.set(x, c * n));
    const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: ch, timestamp: ts, data });
    ts += Math.round((n * 1e6) / rate);
    frames += n;
    enc.encode(ad);
    ad.close();
    if (error) throw error;
    while (enc.encodeQueueSize > 4) await new Promise((r) => enc.addEventListener('dequeue', r, { once: true }));
    const part = out.take();
    if (part) yield { blob: part };
  }
  await enc.flush();
  enc.close();
  if (error) throw error;
  const last = out.finish(frames, rate);
  if (last) yield { blob: last };
}

// webm-muxer / mp4-muxer writing strictly in order (streaming WebM,
// fragmented MP4), so the output can be passed on as it's made.
async function muxContainer(kind, { codec, rate, ch }) {
  const lib = await load(kind === 'webm' ? 'webm' : 'mp4');
  let pending = [], expected = 0;
  const target = new lib.StreamTarget({
    onData: (data, position) => {
      if (position !== expected) throw new Error('Unexpected seek while writing the file.');
      expected += data.byteLength;
      pending.push(data.slice());
    },
    chunked: true,
  });
  const muxer = kind === 'webm'
    ? new lib.Muxer({ target, type: 'webm', streaming: true, audio: { codec: 'A_OPUS', sampleRate: rate, numberOfChannels: ch }, firstTimestampBehavior: 'offset' })
    : new lib.Muxer({ target, fastStart: 'fragmented', audio: { codec: codec === 'opus' ? 'opus' : 'aac', sampleRate: rate, numberOfChannels: ch }, firstTimestampBehavior: 'offset' });
  const take = () => { if (!pending.length) return null; const b = new Blob(pending); pending = []; return b; };
  return {
    add: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    take,
    finish: () => { muxer.finalize(); return take(); },
  };
}

function oggContainer(inputRate) {
  const RATE = 48000;
  const ogg = new OggWriter();
  let packets = [], preskip = 312, headerDone = false, granule = 0, ch = 2;
  const header = () => {
    const h = new Uint8Array(19);
    h.set([...'OpusHead'].map((c) => c.charCodeAt(0)));
    const v = new DataView(h.buffer);
    h[8] = 1; h[9] = ch; v.setUint16(10, preskip, true); v.setUint32(12, inputRate, true);
    const vendor = [...'record'].map((c) => c.charCodeAt(0));
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set([...'OpusTags'].map((c) => c.charCodeAt(0)));
    new DataView(tags.buffer).setUint32(8, vendor.length, true);
    tags.set(vendor, 12);
    return [ogg.page([h], 0, 0x02), ogg.page([tags], 0, 0)];
  };
  const pages = (final, totalFrames) => {
    const out = [];
    if (!headerDone && (packets.length || final)) { out.push(...header()); headerDone = true; }
    while (packets.length >= 30 || (final && packets.length)) {
      const group = packets.splice(0, 30);
      for (const p of group) granule += p.samples;
      const last = final && !packets.length;
      // The last page's position marks where the real audio ends (trims padding).
      out.push(ogg.page(group.map((p) => p.data), last ? preskip + totalFrames : preskip + granule, last ? 0x04 : 0));
    }
    return out.length ? new Blob(out) : null;
  };
  return {
    add(chunk, meta) {
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      packets.push({ data: d, samples: Math.round(((chunk.duration || 20000) * RATE) / 1e6) });
      const cfg = meta && meta.decoderConfig;
      if (cfg) {
        ch = cfg.numberOfChannels || ch;
        const desc = cfg.description;
        if (desc && desc.byteLength >= 12) {
          const b = desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
          if (String.fromCharCode(...b.subarray(0, 8)) === 'OpusHead') preskip = b[10] | (b[11] << 8);
        }
      }
    },
    take: () => pages(false),
    finish: (frames, rate) => pages(true, Math.round((frames * RATE) / rate)),
  };
}

const CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  CRC[i] = r >>> 0;
}

class OggWriter {
  constructor() { this.serial = (Math.random() * 0xffffffff) >>> 0; this.seq = 0; }
  page(packets, granule, flags) {
    const lacing = [];
    for (const p of packets) {
      let n = p.length;
      while (n >= 255) { lacing.push(255); n -= 255; }
      lacing.push(n);
    }
    const bodyLen = packets.reduce((n, p) => n + p.length, 0);
    const page = new Uint8Array(27 + lacing.length + bodyLen);
    const v = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53]);
    page[5] = flags;
    v.setBigUint64(6, BigInt(granule), true);
    v.setUint32(14, this.serial, true);
    v.setUint32(18, this.seq++, true);
    page[26] = lacing.length;
    page.set(lacing, 27);
    let o = 27 + lacing.length;
    for (const p of packets) { page.set(p, o); o += p.length; }
    let crc = 0;
    for (let i = 0; i < page.length; i++) crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ page[i]) & 0xff]) >>> 0;
    v.setUint32(22, crc, true);
    return page;
  }
}

// ------------------------------------------------------------ consumers --

export async function partsToBlob(parts, mime) {
  const all = [];
  for await (const p of parts) {
    if (p.at === 0) all[0] = p.blob; else all.push(p.blob);
  }
  return new Blob(all, { type: mime });
}

export async function writeParts(writable, parts) {
  let pos = 0;
  for await (const p of parts) {
    if (p.at === 0) await writable.write({ type: 'write', position: 0, data: p.blob });
    else { await writable.write({ type: 'write', position: pos, data: p.blob }); pos += p.blob.size; }
  }
}

// Downloads parts: straight into a file the user picks when the browser
// allows it (best for huge files), otherwise as a normal download.
export async function downloadParts(makeParts, filename, mime) {
  let writable = null;
  if (window.showSaveFilePicker) {
    try {
      writable = await (await window.showSaveFilePicker({ suggestedName: filename })).createWritable();
    } catch (err) {
      if (err.name === 'AbortError') return false;
    }
  }
  if (writable) {
    try {
      await writeParts(writable, makeParts());
      await writable.close();
    } catch (err) {
      writable.abort().catch(() => {});
      throw err;
    }
    return true;
  }
  const blob = await partsToBlob(makeParts(), mime);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 120000);
  return true;
}
