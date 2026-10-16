// Street-noise finder for the editor.
//
// Scans the sound in ~21 ms frames and looks for the patterns typical of
// street noise:
//   Car horn         a loud, steady, buzzy tone (250–1100 Hz) for 0.25 s+
//   Siren            a loud tone sweeping up and down (450–2000 Hz)
//   Brake squeal     a loud, piercing tone above 2.5 kHz
//   Passing vehicle  a swell of deep rumble well above the usual background
//   Bang / knock     a sudden, short, broadband burst (door, bump, clatter)
// It also notices constant traffic rumble in the background.
//
// This is pattern matching, not a trained recognizer: it lists what it found
// for you to listen to and tick before anything is removed. Music (held
// notes, vibrato) can look like horns or sirens.

import * as pcm from './pcm.js';

export const TYPES = {
  horn: { label: 'Car horn', icon: '📯', color: '#ff6b6b' },
  siren: { label: 'Siren', icon: '🚨', color: '#f06595' },
  squeal: { label: 'Brake squeal / whistle', icon: '🛞', color: '#cc5de8' },
  vehicle: { label: 'Passing vehicle / engine', icon: '🚗', color: '#ff922b' },
  bang: { label: 'Bang / knock', icon: '💥', color: '#fab005' },
};

function makeFft(N) {
  const rev = new Uint32Array(N), bits = Math.log2(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float32Array(N / 2), sin = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / N); sin[i] = Math.sin((2 * Math.PI * i) / N); }
  return (re, im) => {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let s = 0; s < N; s += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = -sin[k * step], a = s + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

const dB = (p) => 10 * Math.log10(p + 1e-12);

// The strongest steady tones in a stretch of sound (for filtering a horn or a
// squeal out precisely): an averaged spectrum, then peaks that stand well
// above their neighbourhood. Returns up to `max` frequencies in Hz.
export function tonalPeaks(chs, rate, { lo = 200, hi = 6000, max = 8 } = {}) {
  const N = 1 << Math.round(Math.log2(rate * 0.17)); // ~6 Hz resolution
  const fft = makeFft(N);
  const re = new Float32Array(N), im = new Float32Array(N), avg = new Float64Array(N / 2);
  const len = chs[0].length;
  let frames = 0;
  for (let o = 0; o + N <= len || (frames === 0 && o === 0); o += N / 2) {
    for (let i = 0; i < N; i++) {
      let v = 0;
      for (const x of chs) v += x[o + i] || 0;
      re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)); im[i] = 0;
    }
    fft(re, im);
    for (let i = 1; i < N / 2; i++) avg[i] += re[i] * re[i] + im[i] * im[i];
    frames++;
    if (o + N > len) break;
  }
  const binHz = rate / N, a = Math.max(2, Math.round(lo / binHz)), b = Math.min(N / 2 - 3, Math.round(hi / binHz));
  const found = [];
  for (let i = a; i <= b; i++) {
    if (!(avg[i] > avg[i - 1] && avg[i] >= avg[i + 1])) continue;
    const neigh = [];
    for (let k = Math.max(1, i - 30); k <= Math.min(N / 2 - 1, i + 30); k++) if (Math.abs(k - i) > 3) neigh.push(avg[k]);
    neigh.sort((x, y) => x - y);
    const prom = dB(avg[i]) - dB(neigh[neigh.length >> 1]);
    if (prom > 15) found.push({ f: i * binHz, p: avg[i] });
  }
  return found.sort((x, y) => y.p - x.p).slice(0, max).map((x) => x.f);
}

// sensitivity: 0 (fewer, surer finds) … 2 (more finds)
export async function findStreetNoise(doc, { sensitivity = 1, onProgress = () => {} } = {}) {
  const total = pcm.totalLen(doc.segs), rate = doc.rate;
  const N = 1 << Math.round(Math.log2(rate * 0.043)); // ~43 ms window
  const hop = N / 2;
  const fft = makeFft(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const binHz = rate / N;
  const bin = (f) => Math.max(1, Math.min(N / 2 - 1, Math.round(f / binHz)));
  const [b30, b120, b300, b3400, b4000, b8000, b250, b5000] = [30, 120, 300, 3400, 4000, 8000, 250, 5000].map(bin);

  const frames = Math.max(0, Math.floor((total - N) / hop) + 1);
  const F = { db: new Float32Array(frames), low: new Float32Array(frames), mid: new Float32Array(frames), pf: new Float32Array(frames), prom: new Float32Array(frames), flat: new Float32Array(frames) };
  const re = new Float32Array(N), im = new Float32Array(N), pw = new Float32Array(N / 2);
  const CH = 2048; // frames per read
  for (let f0 = 0; f0 < frames; f0 += CH) {
    const nf = Math.min(CH, frames - f0);
    const start = f0 * hop, len = (nf - 1) * hop + N;
    const chs = await pcm.readRange(doc, start, len);
    const mono = new Float32Array(len);
    for (const x of chs) for (let i = 0; i < len; i++) mono[i] += x[i] / chs.length;
    for (let k = 0; k < nf; k++) {
      const o = k * hop;
      for (let i = 0; i < N; i++) { re[i] = mono[o + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let all = 0, low = 0, mid = 0;
      for (let i = 1; i < N / 2; i++) {
        const p = (re[i] * re[i] + im[i] * im[i]) / (N * N);
        pw[i] = p; all += p;
        if (i >= b30 && i < b120) low += p; // below most voices else if (i >= b300 && i < b3400) mid += p;
      }
      // Strongest tone 250 Hz–5 kHz and how much it stands out from its neighbourhood.
      let pk = b250;
      for (let i = b250; i <= b5000; i++) if (pw[i] > pw[pk]) pk = i;
      const neigh = [];
      for (let i = Math.max(1, pk - 40); i <= Math.min(N / 2 - 1, pk + 40); i++) if (Math.abs(i - pk) > 2) neigh.push(pw[i]);
      neigh.sort((a, b) => a - b);
      const med = neigh[neigh.length >> 1] || 1e-12;
      const a = pw[pk - 1], b = pw[pk], c = pw[pk + 1];
      const shift = (a - c) / (2 * (a - 2 * b + c)) || 0;
      // Spectral flatness 300 Hz–8 kHz (1 = noise-like, 0 = tonal).
      let lg = 0, ar = 0, cnt = 0;
      for (let i = b300; i < b8000; i += 2) { lg += Math.log(pw[i] + 1e-14); ar += pw[i]; cnt++; }
      const j = f0 + k;
      F.db[j] = dB(all);
      F.low[j] = dB(low);
      F.mid[j] = dB(mid);
      F.pf[j] = (pk + Math.max(-0.5, Math.min(0.5, shift))) * binHz;
      F.prom[j] = dB(b) - dB(med);
      F.flat[j] = Math.exp(lg / cnt) / (ar / cnt + 1e-14);
    }
    onProgress(Math.min(1, (f0 + nf) / frames));
    await new Promise((r) => setTimeout(r));
  }
  return classify(F, frames, { rate, hop, total, sensitivity, b4000 });
}

function percentile(arr, p) {
  const s = Array.from(arr).filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : -120;
}

// Horns hold one or two fixed pitches (dual horns play two notes at once,
// so the strongest tone can flip between them); voices keep moving.
function steadyTones(pfs) {
  const bins = new Map();
  for (const f of pfs) { const k = Math.round(Math.log(f) / Math.log(1.01)); bins.set(k, (bins.get(k) || 0) + 1); }
  const counts = [...bins.entries()].sort((a, b) => b[1] - a[1]);
  // A pitch counts with its next-door bins (it can sit on a bin edge).
  let covered = 0;
  const used = new Set();
  for (const [k] of counts.slice(0, 2)) {
    for (const j of [k - 1, k, k + 1]) if (!used.has(j)) { used.add(j); covered += bins.get(j) || 0; }
  }
  return covered / pfs.length >= 0.9;
}

function classify(F, frames, { rate, hop, total, sensitivity }) {
  const fs = rate / hop;                      // frames per second
  const sec = (k) => (k * hop) / rate;
  const loose = [6, 3, 0][sensitivity] ?? 3;  // dB of slack
  const floor = percentile(F.db, 0.1);
  const usual = percentile(F.db, 0.8);        // typical level of the loud parts (speech)
  const events = [];

  // Background deep rumble per ~1 s block, then a rolling median (±10 s),
  // so a passing vehicle stands out from steady traffic.
  const B = Math.max(1, Math.round(fs));
  const blocks = [];
  for (let k = 0; k < frames; k += B) blocks.push(percentile(F.low.subarray(k, k + B), 0.5));
  const bgLow = blocks.map((_, i) => percentile(blocks.slice(Math.max(0, i - 10), i + 11), 0.5));

  // --- Tonal runs: horn, siren, squeal.
  const tonal = (k) => F.prom[k] > 18 + loose && F.db[k] > floor + 12 + loose;
  for (let k = 0; k < frames;) {
    if (!tonal(k)) { k++; continue; }
    let e = k, gap = 0;
    while (e + 1 < frames && gap <= 2) { e++; gap = tonal(e) ? 0 : gap + 1; }
    e -= gap;
    const idx = [];
    for (let i = k; i <= e; i++) if (tonal(i)) idx.push(i);
    const pfs = idx.map((i) => F.pf[i]).sort((a, b) => a - b);
    const med = pfs[pfs.length >> 1], lo = pfs[Math.floor(pfs.length * 0.05)], hi = pfs[Math.floor(pfs.length * 0.95)];
    // How smoothly the pitch moves frame to frame (sirens glide, voices jump).
    let jumps = 0;
    for (let i = 1; i < idx.length; i++) jumps += Math.abs(F.pf[idx[i]] - F.pf[idx[i - 1]]);
    const glide = idx.length > 1 ? jumps / (idx.length - 1) : 0;
    const dur = sec(e - k + 1);
    const loud = Math.max(...idx.map((i) => F.db[i])) - floor;
    let type = null;
    if (dur >= 0.8 && hi - lo > 150 && med > 450 && med < 2000 && glide < 40) type = 'siren';
    else if (med > 2500 && dur >= 0.12) type = 'squeal';
    if (type) events.push({ type, s: k, e: e + 1, freq: med, conf: Math.min(1, (loud - 12) / 25 + dur / 4) });
    k = e + 1;
  }

  // --- Horns: in a sliding 0.3 s window, a very prominent, loud tone that
  // stays on one or two exact pitches (a voice under it doesn't matter).
  const Wh = Math.max(4, Math.round(fs * 0.3));
  const hornish = (k) => F.prom[k] > 28 + loose && F.db[k] > floor + 15 + loose && F.pf[k] >= 250 && F.pf[k] <= 1100;
  const horn = new Uint8Array(frames);
  for (let k = 0; k + Wh <= frames; k++) {
    const idx = [];
    for (let i = k; i < k + Wh; i++) if (hornish(i)) idx.push(i);
    if (idx.length < Wh * 0.85) continue;
    if (steadyTones(idx.map((i) => F.pf[i]))) horn.fill(1, k, k + Wh);
  }
  for (let k = 0; k < frames;) {
    if (!horn[k]) { k++; continue; }
    let e = k;
    while (e + 1 < frames && horn[e + 1]) e++;
    const pf = [];
    let loud = -200;
    for (let i = k; i <= e; i++) { pf.push(F.pf[i]); loud = Math.max(loud, F.db[i] - floor); }
    pf.sort((a, b) => a - b);
    // Horns cut through: clearly louder than the usual sound. Steady tones that
    // aren't (a held note, a very even voice) are listed as "maybe".
    const over = loud + floor - usual;
    events.push({ type: 'horn', s: k, e: e + 1, freq: pf[pf.length >> 1], conf: over >= 3 ? Math.min(1, 0.5 + over / 12) : 0.25 });
    k = e + 1;
  }

  // --- Passing vehicles: deep rumble well above the background.
  const loudLow = (k) => F.low[k] > bgLow[Math.floor(k / B)] + 8 + loose && F.low[k] > F.mid[k] && F.low[k] > floor + 15;
  for (let k = 0; k < frames;) {
    if (!loudLow(k)) { k++; continue; }
    let e = k, gap = 0;
    while (e + 1 < frames && gap <= Math.round(fs * 0.5)) { e++; gap = loudLow(e) ? 0 : gap + 1; }
    e -= gap;
    if (sec(e - k + 1) >= 1) {
      let peak = -200;
      for (let i = k; i <= e; i++) peak = Math.max(peak, F.low[i] - bgLow[Math.floor(i / B)]);
      events.push({ type: 'vehicle', s: k, e: e + 1, conf: Math.min(1, (peak - 8) / 15 + 0.3) });
    }
    k = e + 1;
  }

  // --- Bangs: sudden, short, broadband jumps.
  for (let k = 3; k < frames; k++) {
    const before = Math.max(F.db[k - 1], F.db[k - 2], F.db[k - 3]);
    if (F.db[k] - before > 15 + loose && F.flat[k] > 0.25 && F.db[k] > floor + 20) {
      let e = k;
      while (e + 1 < frames && F.db[e + 1] > before + 6 && e - k < fs * 0.5) e++;
      if (sec(e - k + 1) <= 0.45) events.push({ type: 'bang', s: k, e: e + 1, conf: Math.min(1, (F.db[k] - before - 15) / 15 + 0.4) });
      k = e + 3;
    }
  }

  // Frames -> samples, with a little padding; merge overlaps of the same kind.
  const pad = Math.round(rate * 0.12);
  const out = events
    .map((ev) => ({ type: ev.type, start: Math.max(0, ev.s * hop - pad), end: Math.min(total, ev.e * hop + hop + pad), freq: ev.freq, conf: Math.max(0.1, ev.conf) }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const ev of out) {
    const last = merged[merged.length - 1];
    if (last && last.type === ev.type && ev.start <= last.end + rate * 0.3) { last.end = Math.max(last.end, ev.end); last.conf = Math.max(last.conf, ev.conf); }
    else merged.push({ ...ev });
  }

  // Constant traffic rumble: deep sound dominating most of the time.
  let rumbleFrames = 0;
  for (let k = 0; k < frames; k++) if (F.low[k] > F.mid[k] + 3 && F.low[k] > floor + 6) rumbleFrames++;
  return { events: merged, backgroundRumble: frames > 0 && rumbleFrames / frames > 0.5 };
}
