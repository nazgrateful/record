// Speed changes for the editor, streamed window by window so they work on
// recordings of any length.
//
//   Wsola:     changes speed but keeps the pitch (voices stay natural). Short
//              overlapping pieces are re-spaced in time; each piece is shifted
//              a little to where it lines up best with the previous one
//              (WSOLA: waveform-similarity overlap-add).
//   Resampler: changes speed and pitch together, like a tape or record
//              played faster/slower (windowed-sinc, filtered when speeding up
//              so it doesn't alias).
//
// Both take planar Float32 input via push() and return output pieces;
// flush() returns the rest, trimmed to exactly input length / speed.

class Buffer {
  constructor(ch) { this.ch = ch; this.data = Array.from({ length: ch }, () => new Float32Array(1 << 16)); this.base = 0; this.len = 0; }
  get end() { return this.base + this.len; }
  append(chs, n) {
    if (this.len + n > this.data[0].length) {
      const size = Math.max(this.data[0].length * 2, this.len + n);
      this.data = this.data.map((d) => { const x = new Float32Array(size); x.set(d.subarray(0, this.len)); return x; });
    }
    for (let c = 0; c < this.ch; c++) {
      const src = chs ? chs[c % chs.length] : null;
      if (src) this.data[c].set(src.subarray(0, n), this.len); else this.data[c].fill(0, this.len, this.len + n);
    }
    this.len += n;
  }
  // Forget everything before absolute position `pos`.
  dropBefore(pos) {
    const k = Math.min(this.len, Math.max(0, Math.floor(pos) - this.base));
    if (k < 4096) return;
    for (const d of this.data) d.copyWithin(0, k, this.len);
    this.base += k;
    this.len -= k;
  }
  at(c, pos) { const i = pos - this.base; return i >= 0 && i < this.len ? this.data[c][i] : 0; }
}

// ---------------------------------------------------------------- WSOLA --

export class Wsola {
  constructor(ch, rate, speed) {
    this.ch = ch;
    this.speed = speed;
    this.N = 1 << Math.round(Math.log2(rate * 0.04)); // ~40 ms pieces
    this.Hs = this.N / 2;                              // output hop
    this.Ha = this.Hs * speed;                         // input hop
    this.tol = this.N / 4;                             // how far a piece may shift
    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N);
    this.inp = new Buffer(ch);
    this.mono = new Buffer(1);
    this.acc = Array.from({ length: ch }, () => new Float32Array(this.N));
    this.ana = 0;
    this.prev = null;
    this.realIn = 0;
    this.out = 0;          // samples emitted so far (after the lead-in)
    this.skip = this.Hs;   // the lead-in that only covers the padding
    // Pad the start so the first piece's fade-in falls on silence.
    this.feed(null, this.Hs);
  }

  feed(chs, n) {
    this.inp.append(chs, n);
    if (!chs) { this.mono.append(null, n); return; }
    const m = new Float32Array(n);
    for (const x of chs) for (let i = 0; i < n; i++) m[i] += x[i];
    this.mono.append([m], n);
  }

  push(chs) {
    const n = chs[0].length;
    this.realIn += n;
    this.feed(chs, n);
    return this.run();
  }

  flush() {
    this.feed(null, this.N * 2 + this.tol * 2);
    const parts = this.run();
    const want = Math.round(this.realIn / this.speed);
    return trimTo(parts, this.ch, want, this.out - this.lastLen(parts));
  }

  lastLen(parts) { return parts.reduce((n, p) => n + p[0].length, 0); }

  // Best start near `target` to continue smoothly from the previous piece.
  align(target) {
    if (this.prev === null) return target;
    const { Hs, tol } = this;
    const natural = this.prev + Hs;
    const m = this.mono.data[0], b = this.mono.base;
    const lo = Math.max(b, target - tol), hi = target + tol;
    const score = (c, stride) => {
      let dot = 0, e = 1e-9;
      for (let i = 0; i < Hs; i += stride) {
        const v = m[c - b + i];
        dot += v * m[natural - b + i];
        e += v * v;
      }
      return dot / Math.sqrt(e);
    };
    let best = Math.min(hi, Math.max(lo, target)), bestS = -Infinity;
    for (let c = lo; c <= hi; c += 4) { const s = score(c, 4); if (s > bestS) { bestS = s; best = c; } }
    const c0 = best;
    for (let c = Math.max(lo, c0 - 3); c <= Math.min(hi, c0 + 3); c++) { const s = score(c, 1); if (s > bestS) { bestS = s; best = c; } }
    return best;
  }

  run() {
    const { N, Hs, tol } = this;
    const parts = [];
    while (true) {
      const target = Math.round(this.ana);
      const natural = this.prev === null ? target : this.prev + Hs;
      if (Math.max(target + tol, natural) + N > this.inp.end) break;
      const s = this.align(target);
      for (let c = 0; c < this.ch; c++) {
        const acc = this.acc[c], d = this.inp.data[c], off = s - this.inp.base;
        for (let i = 0; i < N; i++) acc[i] += d[off + i] * this.win[i];
      }
      // The first half is complete now.
      let piece = this.acc.map((a) => a.slice(0, Hs));
      for (const a of this.acc) { a.copyWithin(0, Hs); a.fill(0, N - Hs); }
      this.prev = s;
      this.ana += this.Ha;
      if (this.skip > 0) {
        const k = Math.min(this.skip, Hs);
        this.skip -= k;
        piece = k < Hs ? piece.map((p) => p.subarray(k)) : null;
      }
      if (piece) { parts.push(piece); this.out += piece[0].length; }
      const keep = Math.min(this.prev, Math.round(this.ana) - tol) - 1;
      this.inp.dropBefore(keep);
      this.mono.dropBefore(keep);
    }
    return parts;
  }
}

// ------------------------------------------------------------ resampler --

export class Resampler {
  constructor(ch, speed) {
    this.ch = ch;
    this.speed = speed;
    this.cut = Math.min(1, 1 / speed);       // low-pass when speeding up
    this.W = Math.ceil(8 / this.cut);        // half the filter length, in input samples
    this.inp = new Buffer(ch);
    this.t = 0;                              // next output position, in input samples
    this.realIn = 0;
    this.out = 0;
  }

  // The filter, tabulated (256 steps per sample) so it's quick to apply.
  table() {
    if (this.tab) return this.tab;
    const { W, cut } = this, P = 256;
    const tab = new Float32Array(2 * W * P + 2);
    for (let i = 0; i < tab.length; i++) {
      const d = i / P - W;
      const x = Math.PI * cut * d;
      tab[i] = Math.abs(d) >= W ? 0 : cut * (x === 0 ? 1 : Math.sin(x) / x) * (0.5 + 0.5 * Math.cos((Math.PI * d) / W));
    }
    return (this.tab = tab);
  }

  push(chs) {
    this.realIn += chs[0].length;
    this.inp.append(chs, chs[0].length);
    return this.run(this.inp.end - this.W - 1);
  }

  flush() {
    this.inp.append(null, this.W * 2 + 2);
    const want = Math.round(this.realIn / this.speed);
    const parts = this.run(Infinity, want);
    return trimTo(parts, this.ch, want, this.out - parts.reduce((n, p) => n + p[0].length, 0));
  }

  run(maxPos, maxOut = Infinity) {
    const parts = [];
    const n = Math.max(0, Math.min(maxOut - this.out, Math.floor((Math.min(maxPos, this.inp.end - this.W - 1) - this.t) / this.speed) + 1));
    if (!n) return parts;
    const out = Array.from({ length: this.ch }, () => new Float32Array(n));
    const W = this.W, base = this.inp.base, tab = this.table(), P = 256;
    for (let j = 0; j < n; j++) {
      const t = this.t + j * this.speed;
      const k0 = Math.floor(t);
      for (let k = k0 - W + 1; k <= k0 + W; k++) {
        const pos = (t - k + W) * P, ip = pos | 0;
        const w = tab[ip] + (tab[ip + 1] - tab[ip]) * (pos - ip);
        const i = k - base;
        if (!w || i < 0 || i >= this.inp.len) continue;
        for (let c = 0; c < this.ch; c++) out[c][j] += this.inp.data[c][i] * w;
      }
    }
    this.t += n * this.speed;
    this.out += n;
    this.inp.dropBefore(this.t - W - 1);
    parts.push(out);
    return parts;
  }
}

// Makes the final parts end exactly at `want` samples in total, given that
// `before` samples were output before these parts.
function trimTo(parts, ch, want, before) {
  let have = before;
  const out = [];
  for (const p of parts) {
    const room = want - have;
    if (room <= 0) break;
    out.push(p[0].length > room ? p.map((x) => x.subarray(0, room)) : p);
    have += Math.min(room, p[0].length);
  }
  if (have < want) out.push(Array.from({ length: ch }, () => new Float32Array(want - have)));
  return out;
}
