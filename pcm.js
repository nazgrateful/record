// Long audio for the editor, kept in the browser's storage instead of memory.
//
// Twelve hours of decoded stereo sound is ~16 GB as floats, far more than a
// tab can hold, so decoded sound is stored in blocks of 16-bit samples
// (~11 s each). A "document" is a list of segments, each a slice of a block
// (or of silence). Cutting, pasting and undo only rearrange segments; effects
// write new blocks. Each block also stores min/max peaks at two zoom levels
// so the whole recording can be drawn without loading the sound itself.

import * as store from './db.js';

export const BLOCK = 1 << 19;   // samples per block
export const P1 = 512;          // fine peaks: one min/max pair per 512 samples
export const P2 = 16384;        // coarse peaks, for long views

const uid = () => Math.random().toString(36).slice(2, 10);

function peaksOf(chs, len, bin) {
  const n = Math.ceil(len / bin);
  const out = new Int16Array(n * 2);
  for (let k = 0; k < n; k++) {
    let lo = 0, hi = 0;
    const end = Math.min(len, (k + 1) * bin);
    for (const x of chs) {
      for (let i = k * bin; i < end; i++) {
        const v = x[i];
        if (v < lo) lo = v; else if (v > hi) hi = v;
      }
    }
    out[2 * k] = lo; out[2 * k + 1] = hi;
  }
  return out;
}

function makeMeta(chs, len) {
  return { len, p1: peaksOf(chs, len, P1), p2: peaksOf(chs, len, P2) };
}

// Collects planar float audio, cuts it into blocks and stores them.
export class BlockWriter {
  constructor(doc) {
    this.doc = doc;
    this.buf = Array.from({ length: doc.ch }, () => new Float32Array(BLOCK));
    this.fill = 0;
    this.segs = [];
    this.chain = Promise.resolve();
    this.inFlight = 0;
    this.error = null;
  }

  push(planar) {
    const n = planar[0].length;
    let off = 0;
    while (off < n) {
      const take = Math.min(n - off, BLOCK - this.fill);
      for (let c = 0; c < this.doc.ch; c++) {
        const src = planar.length === 1 ? planar[0] : planar[c % planar.length];
        this.buf[c].set(src.subarray(off, off + take), this.fill);
      }
      this.fill += take;
      off += take;
      if (this.fill === BLOCK) this.flushBlock();
    }
  }

  flushBlock() {
    const len = this.fill;
    if (!len) return;
    this.fill = 0;
    const chs = this.buf.map((x) => {
      const out = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        const v = x[i];
        out[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
      }
      return out;
    });
    const key = `${this.doc.id}:${uid()}`;
    const meta = makeMeta(chs, len);
    this.doc.meta.set(key, meta);
    cache.set(key, chs);
    trimCache();
    this.segs.push({ key, start: 0, end: len });
    this.inFlight++;
    this.chain = this.chain
      .then(() => store.putBlock(key, chs.map((x) => x.buffer), meta))
      .catch((err) => { this.error = this.error || err; })
      .finally(() => { this.inFlight--; });
  }

  // Wait if too many blocks are waiting to be written.
  async drain() {
    if (this.inFlight > 3) await this.chain;
    if (this.error) throw this.error;
  }

  async finish() {
    this.flushBlock();
    await this.chain;
    if (this.error) throw this.error;
    return this.segs;
  }
}

// ------------------------------------------------------------- reading --

const cache = new Map(); // key -> Int16Array[] (most recently used last)
const loading = new Map();
const CACHE_BLOCKS = 32;

function trimCache() {
  while (cache.size > CACHE_BLOCKS) cache.delete(cache.keys().next().value);
}

export function cachedBlock(key) {
  const b = cache.get(key);
  if (b) { cache.delete(key); cache.set(key, b); }
  return b;
}

export function loadBlock(key) {
  const b = cachedBlock(key);
  if (b) return Promise.resolve(b);
  if (!loading.has(key)) {
    loading.set(key, store.getBlock(key).then((bufs) => {
      if (!bufs) throw new Error('Missing audio block — the browser may have cleared its storage.');
      const chs = bufs.map((x) => new Int16Array(x));
      cache.set(key, chs);
      trimCache();
      return chs;
    }).finally(() => loading.delete(key)));
  }
  return loading.get(key);
}

export const segLen = (s) => s.end - s.start;
export const totalLen = (segs) => segs.reduce((n, s) => n + segLen(s), 0);

// Calls fn(seg, timelineStart) for each segment overlapping [a, b).
export function eachSeg(segs, a, b, fn) {
  let t = 0;
  for (const s of segs) {
    const L = segLen(s);
    if (t + L > a && t < b) fn(s, t);
    t += L;
    if (t >= b) break;
  }
}

// Planar Float32 audio for timeline samples [a, a + n).
export async function readRange(doc, a, n) {
  const out = Array.from({ length: doc.ch }, () => new Float32Array(n));
  const parts = [];
  eachSeg(doc.segs, a, a + n, (s, t) => parts.push([s, t]));
  for (const [s, t] of parts) {
    const from = Math.max(a, t), to = Math.min(a + n, t + segLen(s));
    if (!s.key) continue; // silence
    const chs = await loadBlock(s.key);
    const off = s.start + (from - t);
    for (let c = 0; c < doc.ch; c++) {
      const src = chs[c % chs.length], dst = out[c];
      for (let i = 0, j = from - a; i < to - from; i++, j++) dst[j] = src[off + i] / 32768;
    }
  }
  return out;
}

// ------------------------------------------------------- segment edits --

// Makes sure a segment starts at sample s; returns that segment's index.
export function splitAt(segs, s) {
  let t = 0;
  for (let i = 0; i < segs.length; i++) {
    const L = segLen(segs[i]);
    if (s === t) return i;
    if (s < t + L) {
      const cut = segs[i].start + (s - t);
      segs.splice(i, 1, { ...segs[i], end: cut }, { ...segs[i], start: cut });
      return i + 1;
    }
    t += L;
  }
  return segs.length;
}

export function extract(segs, a, b) {
  const s = segs.slice();
  const i = splitAt(s, a), j = splitAt(s, b);
  return s.slice(i, j);
}

export function replace(segs, a, b, insert) {
  const s = segs.slice();
  const i = splitAt(s, a), j = splitAt(s, b);
  s.splice(i, j - i, ...insert);
  return s;
}

export const silence = (n) => ({ key: null, start: 0, end: n });

// ------------------------------------------------------------- documents --

export function newDoc(name, rate, ch) {
  return { id: 'doc-' + uid(), name, rate, ch, segs: [], meta: new Map() };
}

export async function saveDoc(doc) {
  const { id, name, rate, ch, segs } = doc;
  await store.setValue('editorDoc', { id, name, rate, ch, segs });
}

export async function restoreDoc() {
  const saved = await store.getValue('editorDoc');
  if (!saved) return null;
  const doc = { ...saved, meta: new Map(await store.listBlockMeta(saved.id + ':')) };
  // Drop blocks only reachable through the (unsaved) undo history.
  const used = new Set(doc.segs.map((s) => s.key));
  const unused = [...doc.meta.keys()].filter((k) => !used.has(k));
  unused.forEach((k) => doc.meta.delete(k));
  store.deleteBlockKeys(unused).catch(() => {});
  if (doc.segs.some((s) => s.key && !doc.meta.has(s.key))) {
    await discardDoc(doc);
    return null;
  }
  return doc;
}

export async function discardDoc(doc) {
  for (const k of doc.meta.keys()) cache.delete(k);
  await store.setValue('editorDoc', undefined);
  await store.deleteBlocks(doc.id + ':');
}
