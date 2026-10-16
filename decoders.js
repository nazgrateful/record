// Streaming import: reads an audio or video file a few MB at a time and
// hands decoded audio to `sink.push(planar, sampleRate)` piece by piece, so
// files many hours long never have to be decoded in one go.
//
// WAV is read directly. WebM/MKV, Ogg, MP3 and MP4/M4A are split into
// packets here and decoded with WebCodecs' AudioDecoder. Anything else falls
// back to the browser's one-shot decoder (fine for shorter files).

const WINDOW = 4 << 20;

class Reader {
  constructor(blob) { this.blob = blob; this.size = blob.size; this.pos = 0; this.buf = new Uint8Array(0); this.bs = 0; }
  // Makes n bytes from pos available; returns how many there are (less at the end).
  async ensure(n) {
    const avail = this.bs + this.buf.length - this.pos;
    if (this.pos >= this.bs && avail >= n) return n;
    const end = Math.min(this.size, this.pos + Math.max(n, WINDOW));
    this.buf = new Uint8Array(await this.blob.slice(this.pos, end).arrayBuffer());
    this.bs = this.pos;
    return Math.min(n, this.buf.length);
  }
  at(i) { return this.buf[this.pos - this.bs + i]; }
  view(n) { return this.buf.subarray(this.pos - this.bs, this.pos - this.bs + n); }
  copy(n) { return this.view(n).slice(); }
  str(i, n) { let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(this.at(i + k)); return s; }
}

export async function decodeFile(file, sink, { onProgress = () => {}, fallback } = {}) {
  const r = new Reader(file);
  await r.ensure(64);
  const kind =
    (r.str(0, 4) === 'RIFF' || r.str(0, 4) === 'RF64') && r.str(8, 4) === 'WAVE' ? 'wav'
    : r.at(0) === 0x1a && r.at(1) === 0x45 && r.at(2) === 0xdf && r.at(3) === 0xa3 ? 'webm'
    : r.str(0, 4) === 'OggS' ? 'ogg'
    : r.str(4, 4) === 'ftyp' ? 'mp4'
    : r.str(0, 3) === 'ID3' || (r.at(0) === 0xff && (r.at(1) & 0xe0) === 0xe0) ? 'mp3'
    : 'other';
  const progress = () => onProgress(Math.min(1, r.pos / r.size));

  if (kind === 'wav') return decodeWav(r, sink, progress);
  if (kind !== 'other' && window.AudioDecoder) {
    const packets = kind === 'webm' ? webmPackets(r) : kind === 'ogg' ? oggPackets(r) : kind === 'mp4' ? mp4Packets(r) : mp3Packets(r);
    try {
      return await runDecoder(packets, sink, progress);
    } catch (err) {
      if (!err.unsupported) throw err;
    }
  }
  // Fallback: the browser decodes the whole file at once.
  if (file.size > 300 << 20) throw new Error('This file is too large to open in this format here. Convert it to WAV, MP3, M4A, OGG or WebM, or use Chrome/Edge.');
  const buf = await fallback(await file.arrayBuffer());
  const chs = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  for (let off = 0; off < buf.length; off += 1 << 18) {
    sink.push(chs.map((x) => x.subarray(off, Math.min(buf.length, off + (1 << 18)))), buf.sampleRate);
    await sink.drain();
    onProgress(off / buf.length);
  }
}

// Runs packets through an AudioDecoder. The packet generator yields a
// decoder config first, then Uint8Array packets.
async function runDecoder(packets, sink, progress) {
  let error = null, dec = null, ts = 0, count = 0;
  for await (const p of packets) {
    if (!dec) {
      const config = p;
      let ok = false;
      try { ok = (await AudioDecoder.isConfigSupported(config)).supported; } catch {}
      if (!ok) throw Object.assign(new Error('unsupported codec ' + config.codec), { unsupported: true });
      dec = new AudioDecoder({
        output: (ad) => {
          try {
            const planar = [];
            for (let c = 0; c < ad.numberOfChannels; c++) {
              const f = new Float32Array(ad.numberOfFrames);
              ad.copyTo(f, { planeIndex: c, format: 'f32-planar' });
              planar.push(f);
            }
            sink.push(planar, ad.sampleRate);
          } catch (err) { error = error || err; }
          ad.close();
        },
        error: (e) => { error = error || e; },
      });
      dec.configure(config);
      continue;
    }
    if (error) throw error;
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: p }));
    ts += 20000;
    if (dec.decodeQueueSize > 32) await new Promise((res) => dec.addEventListener('dequeue', res, { once: true }));
    if (++count % 64 === 0) { await sink.drain(); progress(); }
  }
  if (!dec) throw new Error('No audio found in this file.');
  await dec.flush();
  dec.close();
  if (error) throw error;
  progress();
}

// ----------------------------------------------------------------- WAV --

async function decodeWav(r, sink, progress) {
  r.pos = 12;
  let fmt = null, dataSize64 = null;
  while (true) {
    if ((await r.ensure(8)) < 8) throw new Error('No audio data in this WAV file.');
    const id = r.str(0, 4);
    let size = r.at(4) | (r.at(5) << 8) | (r.at(6) << 16) | (r.at(7) << 24 >>> 0);
    size >>>= 0;
    r.pos += 8;
    await r.ensure(Math.min(size, 64));
    if (id === 'fmt ') {
      const v = new DataView(r.copy(Math.min(size, 40)).buffer);
      let tag = v.getUint16(0, true);
      if (tag === 0xfffe && size >= 26) tag = v.getUint16(24, true);
      fmt = { tag, ch: v.getUint16(2, true), rate: v.getUint32(4, true), bits: v.getUint16(14, true) };
    } else if (id === 'ds64') {
      const v = new DataView(r.copy(16).buffer);
      dataSize64 = Number(v.getBigUint64(8, true));
    } else if (id === 'data') {
      if (!fmt) throw new Error('Broken WAV file (no format).');
      if (size === 0xffffffff || dataSize64) size = dataSize64 ?? r.size - r.pos;
      size = Math.min(size, r.size - r.pos);
      break;
    }
    r.pos += size + (size & 1);
  }
  const { tag, ch, rate, bits } = fmt;
  const bps = bits / 8, frameBytes = bps * ch;
  if (!((tag === 1 && [8, 16, 24, 32].includes(bits)) || (tag === 3 && [32, 64].includes(bits)))) {
    throw new Error(`Unsupported WAV format (code ${tag}, ${bits}-bit).`);
  }
  const end = r.pos + Math.floor((r.size - r.pos) / frameBytes) * frameBytes;
  const FRAMES = 1 << 17;
  while (r.pos < end) {
    const n = Math.min(FRAMES, (end - r.pos) / frameBytes);
    await r.ensure(n * frameBytes);
    const bytes = r.view(n * frameBytes);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const planar = Array.from({ length: ch }, () => new Float32Array(n));
    for (let i = 0, o = 0; i < n; i++) {
      for (let c = 0; c < ch; c++, o += bps) {
        let x;
        if (tag === 3) x = bits === 32 ? v.getFloat32(o, true) : v.getFloat64(o, true);
        else if (bits === 16) x = v.getInt16(o, true) / 32768;
        else if (bits === 24) x = ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16))) / 8388608;
        else if (bits === 32) x = v.getInt32(o, true) / 2147483648;
        else x = (v.getUint8(o) - 128) / 128;
        planar[c][i] = x;
      }
    }
    r.pos += n * frameBytes;
    sink.push(planar, rate);
    await sink.drain();
    progress();
  }
}

// --------------------------------------------------------- WebM / MKV --

const EBML_MASTER = new Set([0x18538067, 0x1f43b675, 0x1654ae6b, 0xae, 0xe1, 0xa0]);

async function* webmPackets(r) {
  const tracks = [];
  let track = null, audio = null;
  const vint = (i, keepMarker) => {
    const b = r.at(i);
    let len = 1;
    while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
    let v = keepMarker ? b : b & (0xff >> len);
    let allOnes = v === (0xff >> len);
    for (let k = 1; k < len; k++) { v = v * 256 + r.at(i + k); if (r.at(i + k) !== 0xff) allOnes = false; }
    return [v, len, !keepMarker && allOnes];
  };
  const uint = (n) => { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + r.at(k); return v; };

  while (r.pos < r.size) {
    if ((await r.ensure(16)) < 2) break;
    const [id, il] = vint(0, true);
    const [size, sl, unknown] = vint(il, false);
    r.pos += il + sl;
    if (EBML_MASTER.has(id)) {
      if (id === 0xae) tracks.push(track = {});
      continue; // read the children
    }
    if (unknown) throw new Error('Unreadable WebM file.');
    await r.ensure(Math.min(size, 1 << 20));
    if (id === 0xa3 || id === 0xa1) {
      if (!audio) {
        audio = tracks.find((t) => t.type === 2);
        if (!audio) throw new Error('No audio track in this file.');
        yield webmConfig(audio);
      }
      await r.ensure(size);
      const [num, nl] = vint(0, false);
      const flags = r.at(nl + 2);
      if (num === audio.number && !(flags & 0x06)) yield r.view(size).slice(nl + 3);
    } else if (track) {
      if (id === 0xd7) track.number = uint(size);
      else if (id === 0x83) track.type = uint(size);
      else if (id === 0x86) track.codec = r.str(0, size);
      else if (id === 0x63a2) { await r.ensure(size); track.priv = r.copy(size); }
      else if (id === 0xb5) { const v = new DataView(r.copy(size).buffer); track.rate = size === 4 ? v.getFloat32(0) : v.getFloat64(0); }
      else if (id === 0x9f) track.channels = uint(size);
    }
    r.pos += size;
  }
  if (!audio) throw new Error('No audio found in this file.');
}

function webmConfig(t) {
  const codec = { A_OPUS: 'opus', A_VORBIS: 'vorbis', A_FLAC: 'flac', 'A_MPEG/L3': 'mp3' }[t.codec] || (t.codec?.startsWith('A_AAC') ? 'mp4a.40.2' : t.codec);
  const config = { codec, sampleRate: Math.round(t.rate || 48000), numberOfChannels: t.channels || 2 };
  if (t.priv && codec !== 'mp3') config.description = t.priv;
  if (codec === 'opus') config.sampleRate = 48000;
  return config;
}

// ----------------------------------------------------------------- Ogg --

async function* oggPackets(r) {
  let serial = null, parts = [], headers = [], configured = false;
  while (r.pos < r.size) {
    if ((await r.ensure(27)) < 27 || r.str(0, 4) !== 'OggS') break;
    const nseg = r.at(26);
    await r.ensure(27 + nseg);
    const table = r.copy(27 + nseg).subarray(27);
    const total = table.reduce((a, b) => a + b, 0);
    const pageSerial = (r.at(14) | (r.at(15) << 8) | (r.at(16) << 16) | (r.at(17) << 24)) >>> 0;
    await r.ensure(27 + nseg + total);
    const body = r.copy(27 + nseg + total).subarray(27 + nseg);
    r.pos += 27 + nseg + total;
    if (serial === null) serial = pageSerial;
    if (pageSerial !== serial) continue;
    let off = 0;
    for (const lace of table) {
      parts.push(body.subarray(off, off + lace));
      off += lace;
      if (lace === 255) continue;
      const pkt = concat(parts);
      parts = [];
      if (!configured) {
        headers.push(pkt);
        const head = String.fromCharCode(...pkt.subarray(0, 8));
        if (head === 'OpusHead') {
          yield { codec: 'opus', sampleRate: 48000, numberOfChannels: pkt[9], description: pkt };
          configured = 'opus';
        } else if (head.slice(1, 7) === 'vorbis' && headers.length === 3) {
          const v = headers[0];
          const rate = v[12] | (v[13] << 8) | (v[14] << 16) | (v[15] << 24);
          yield { codec: 'vorbis', sampleRate: rate, numberOfChannels: v[11], description: xiphLace(headers) };
          configured = 'vorbis';
        } else if (!head.includes('vorbis')) {
          throw Object.assign(new Error('unsupported Ogg codec'), { unsupported: true });
        }
        continue;
      }
      if (configured === 'opus' && String.fromCharCode(...pkt.subarray(0, 8)) === 'OpusTags') continue;
      yield pkt;
    }
  }
}

function xiphLace(pkts) {
  const out = [pkts.length - 1];
  for (const p of pkts.slice(0, -1)) {
    let n = p.length;
    while (n >= 255) { out.push(255); n -= 255; }
    out.push(n);
  }
  return concat([new Uint8Array(out), ...pkts]);
}

function concat(arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// ----------------------------------------------------------------- MP3 --

const BR = {
  '1-3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
BR['2-1'] = BR['2-2'];
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Frame(b0, b1, b2, b3) {
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const ver = (b1 >> 3) & 3, layer = (b1 >> 1) & 3, bri = b2 >> 4, sri = (b2 >> 2) & 3;
  if (ver === 1 || layer === 0 || bri === 0 || bri === 15 || sri === 3) return null;
  const br = BR[`${ver === 3 ? 1 : 2}-${layer}`][bri] * 1000, sr = SR[ver][sri], pad = (b2 >> 1) & 1;
  const len = layer === 3 ? Math.floor((12 * br) / sr + pad) * 4 : Math.floor(((layer === 1 && ver !== 3 ? 72 : 144) * br) / sr) + pad;
  return { len, sr, ch: b3 >> 6 === 3 ? 1 : 2, layer };
}

async function* mp3Packets(r) {
  await r.ensure(10);
  if (r.str(0, 3) === 'ID3') r.pos += 10 + (((r.at(6) & 0x7f) << 21) | ((r.at(7) & 0x7f) << 14) | ((r.at(8) & 0x7f) << 7) | (r.at(9) & 0x7f)) + (r.at(5) & 0x10 ? 10 : 0);
  let started = false;
  while (r.pos < r.size) {
    if ((await r.ensure(4)) < 4) break;
    const f = mp3Frame(r.at(0), r.at(1), r.at(2), r.at(3));
    if (!f) {
      if (r.str(0, 3) === 'TAG') break;
      r.pos++;
      continue;
    }
    if (!started) {
      if (f.layer !== 1) throw Object.assign(new Error('MPEG layer I/II'), { unsupported: true });
      yield { codec: 'mp3', sampleRate: f.sr, numberOfChannels: f.ch };
      started = { past: false };
    }
    if ((await r.ensure(f.len)) < f.len) break;
    const frame = r.copy(f.len);
    r.pos += f.len;
    // Skip the silent "Xing"/"Info" header frame many encoders put first.
    const tag = String.fromCharCode(...frame.subarray(4, 40));
    if (!started.past && (tag.includes('Xing') || tag.includes('Info'))) { started.past = true; continue; }
    started.past = true;
    yield frame;
  }
}

// ------------------------------------------------------------ MP4 / M4A --

async function* mp4Packets(r) {
  // Find the moov box (it can be at the start or the end).
  let moov = null;
  while (r.pos < r.size) {
    await r.ensure(16);
    let size = r.at(0) * 2 ** 24 + ((r.at(1) << 16) | (r.at(2) << 8) | r.at(3));
    const type = r.str(4, 4);
    let head = 8;
    if (size === 1) { size = Number(new DataView(r.copy(16).buffer).getBigUint64(8)); head = 16; }
    if (size === 0) size = r.size - r.pos;
    if (type === 'moov') {
      await r.ensure(size);
      moov = r.copy(size).subarray(head);
      break;
    }
    r.pos += size;
  }
  if (!moov) throw new Error('Broken MP4 file (no moov box).');

  const boxes = (buf) => {
    const out = [];
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let o = 0; o + 8 <= buf.length;) {
      let size = v.getUint32(o), head = 8;
      if (size === 1) { size = Number(v.getBigUint64(o + 8)); head = 16; }
      if (size < 8) break;
      out.push({ type: String.fromCharCode(...buf.subarray(o + 4, o + 8)), body: buf.subarray(o + head, o + size) });
      o += size;
    }
    return out;
  };
  const child = (buf, ...path) => {
    for (const t of path) { const b = boxes(buf).find((x) => x.type === t); if (!b) return null; buf = b.body; }
    return buf;
  };
  const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  const trak = boxes(moov).filter((b) => b.type === 'trak').map((b) => b.body)
    .find((t) => { const h = child(t, 'mdia', 'hdlr'); return h && String.fromCharCode(...h.subarray(8, 12)) === 'soun'; });
  if (!trak) throw new Error('No audio track in this file.');
  const stbl = child(trak, 'mdia', 'minf', 'stbl');
  const stsd = child(stbl, 'stsd');
  const entry = boxes(stsd.subarray(8))[0];
  if (!entry || entry.type !== 'mp4a') throw Object.assign(new Error('unsupported MP4 audio ' + (entry && entry.type)), { unsupported: true });
  const e = dv(entry.body);
  const qtVer = e.getUint16(8);
  const channels = e.getUint16(16), rate = e.getUint32(24) >>> 16;
  const esds = child(entry.body.subarray(28 + (qtVer === 1 ? 16 : qtVer === 2 ? 36 : 0)), 'esds');
  if (!esds) throw Object.assign(new Error('no esds'), { unsupported: true });
  // Walk the MPEG-4 descriptors for the object type and AudioSpecificConfig.
  let objType = 0, asc = null;
  const walk = (b) => {
    for (let o = 0; o < b.length;) {
      const tag = b[o++];
      let len = 0, c;
      do { c = b[o++]; len = (len << 7) | (c & 0x7f); } while (c & 0x80);
      const body = b.subarray(o, o + len);
      if (tag === 3) {
        const flags = body[2];
        let k = 3 + (flags & 0x80 ? 2 : 0);
        if (flags & 0x40) k += 1 + body[k];
        if (flags & 0x20) k += 2;
        walk(body.subarray(k));
      } else if (tag === 4) { objType = body[0]; walk(body.subarray(13)); }
      else if (tag === 5) asc = body.slice();
      o += len;
    }
  };
  walk(esds.subarray(4));
  let config;
  if (objType === 0x40 && asc) config = { codec: `mp4a.40.${asc[0] >> 3}`, sampleRate: rate, numberOfChannels: channels, description: asc };
  else if (objType === 0x6b || objType === 0x69) config = { codec: 'mp3', sampleRate: rate, numberOfChannels: channels };
  else throw Object.assign(new Error('unsupported MP4 audio'), { unsupported: true });

  // Sample sizes and file offsets from stsz / stsc / stco.
  const stsz = dv(child(stbl, 'stsz'));
  const fixed = stsz.getUint32(4), count = stsz.getUint32(8);
  const sizeOf = (i) => fixed || stsz.getUint32(12 + 4 * i);
  const stsc = dv(child(stbl, 'stsc'));
  const runs = [];
  for (let i = 0, n = stsc.getUint32(4); i < n; i++) runs.push([stsc.getUint32(8 + 12 * i), stsc.getUint32(12 + 12 * i)]);
  const co = child(stbl, 'stco'), co64 = child(stbl, 'co64');
  const cv = dv(co || co64), chunks = cv.getUint32(4);
  const chunkOffset = (i) => (co ? cv.getUint32(8 + 4 * i) : Number(cv.getBigUint64(8 + 8 * i)));

  yield config;
  let sample = 0;
  for (let c = 0, run = 0; c < chunks && sample < count; c++) {
    while (run + 1 < runs.length && runs[run + 1][0] <= c + 1) run++;
    let off = chunkOffset(c);
    for (let k = 0; k < runs[run][1] && sample < count; k++, sample++) {
      const sz = sizeOf(sample);
      r.pos = off;
      if ((await r.ensure(sz)) < sz) return;
      yield r.copy(sz);
      off += sz;
    }
  }
}
