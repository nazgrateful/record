// AudioWorklet that removes steady background noise (fans, hiss, hum, room
// tone) with spectral subtraction.
//
// The audio is cut into overlapping 1024-sample frames, turned into a spectrum
// with an FFT, and every frequency bin is turned down by how much of it is
// noise. The noise profile is either tracked automatically (the quietest level
// each bin has had recently) or learned from a few seconds of "noise only"
// audio when the page sends { learn: seconds }.

const N = 1024;          // FFT size (~21 ms at 48 kHz)
const HOP = N / 4;       // 75% overlap
const BINS = N / 2 + 1;

// Precomputed tables for an in-place radix-2 FFT.
const WINDOW = new Float32Array(N);
for (let i = 0; i < N; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
const OLA_NORM = 1 / 1.5; // sum of Hann^2 at 75% overlap
const REV = new Uint32Array(N);
for (let i = 0, bits = Math.log2(N); i < N; i++) {
  let r = 0;
  for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
  REV[i] = r;
}
const COS = new Float32Array(N / 2);
const SIN = new Float32Array(N / 2);
for (let i = 0; i < N / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / N);
  SIN[i] = Math.sin((2 * Math.PI * i) / N);
}

function fft(re, im, inverse) {
  for (let i = 0; i < N; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * step], wi = sign * SIN[k * step];
        const a = start + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  if (inverse) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
}

class DenoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.enabled = true;
    this.strength = 1.5;  // over-subtraction factor; higher removes more noise
    this.floor = 0.06;    // never turn a bin down below this (~-24 dB) to avoid "underwater" artefacts
    this.mode = 'auto';   // 'auto' | 'learned'
    this.learnFrames = 0;
    this.learnAcc = new Float32Array(BINS);
    this.learnCount = 0;

    this.inFifo = [new Float32Array(N), new Float32Array(N)];
    this.acc = [new Float32Array(N), new Float32Array(N)];
    this.ready = [new Float32Array(HOP), new Float32Array(HOP)];
    this.pos = 0;
    this.re = [new Float32Array(N), new Float32Array(N)];
    this.im = [new Float32Array(N), new Float32Array(N)];
    this.power = new Float32Array(BINS);        // smoothed signal power per bin
    this.noise = new Float32Array(BINS).fill(1e-9);
    this.slow = new Float32Array(BINS);
    this.minSlow = new Float32Array(BINS);
    this.learned = null;
    this.gain = new Float32Array(BINS).fill(1);
    this.frames = 0;

    this.port.onmessage = (e) => this.configure(e.data);
    // Offline use (the audio editor) passes its settings up front.
    if (options && options.processorOptions) this.configure(options.processorOptions);
  }

  configure(d) {
    if ('enabled' in d) this.enabled = d.enabled;
    if ('strength' in d) this.strength = d.strength;
    if ('floor' in d) this.floor = d.floor;
    if ('mode' in d) this.mode = d.mode;
    if (d.learn) {
      this.learnFrames = Math.round((d.learn * sampleRate) / HOP);
      this.learnAcc.fill(0);
      this.learnCount = 0;
    }
    if (d.forget) { this.learned = null; this.mode = 'auto'; }
  }

  processFrame(channels) {
    const { re, im, power, noise, gain } = this;
    for (let c = 0; c < channels; c++) {
      const r = re[c], m = im[c], src = this.inFifo[c];
      for (let i = 0; i < N; i++) { r[i] = src[i] * WINDOW[i]; m[i] = 0; }
      fft(r, m, false);
    }

    // Per-bin power (mid of all channels), smoothed over time. `power` follows
    // the signal quickly; `slow` is heavily smoothed and its running minimum is
    // the automatic noise estimate (minimum statistics), scaled up by BIAS
    // because the minimum of a fluctuating level sits below its average.
    const rise = 1.003; // auto noise estimate can creep up ~2.5 dB/s
    const BIAS = 1.8;
    const slow = this.slow;
    for (let k = 0; k < BINS; k++) {
      let p = 0;
      for (let c = 0; c < channels; c++) p += re[c][k] * re[c][k] + im[c][k] * im[c][k];
      p /= channels;
      if (this.frames === 0) { power[k] = p; slow[k] = p; }
      power[k] = 0.5 * power[k] + 0.5 * p;
      slow[k] = 0.92 * slow[k] + 0.08 * p;
      if (slow[k] < this.minSlow[k] || this.frames < 8) this.minSlow[k] = slow[k];
      else this.minSlow[k] *= rise;
      noise[k] = this.minSlow[k] * BIAS;
      if (this.learnFrames > 0) this.learnAcc[k] += p;
    }
    this.frames++;

    if (this.learnFrames > 0) {
      this.learnCount++;
      if (--this.learnFrames === 0) {
        this.learned = new Float32Array(BINS);
        for (let k = 0; k < BINS; k++) this.learned[k] = this.learnAcc[k] / this.learnCount;
        this.mode = 'learned';
        this.port.postMessage({ type: 'learned' });
      }
    }

    const profile = this.mode === 'learned' && this.learned ? this.learned : noise;
    const s = this.strength, floor = this.floor;
    for (let k = 0; k < BINS; k++) {
      const p = power[k] > 1e-12 ? power[k] : 1e-12;
      let g = 1 - (s * profile[k]) / p;
      g = g > 0 ? Math.sqrt(g) : 0;
      if (g < floor) g = floor;
      // Smooth over time: fast to open, slower to close (less "musical noise").
      gain[k] = g > gain[k] ? 0.6 * g + 0.4 * gain[k] : 0.3 * g + 0.7 * gain[k];
    }

    for (let c = 0; c < channels; c++) {
      const r = re[c], m = im[c];
      for (let k = 0; k < BINS; k++) {
        r[k] *= gain[k]; m[k] *= gain[k];
        if (k > 0 && k < N / 2) { r[N - k] = r[k]; m[N - k] = -m[k]; }
      }
      fft(r, m, true);
      const acc = this.acc[c];
      for (let i = 0; i < N; i++) acc[i] += r[i] * WINDOW[i] * OLA_NORM;
      this.ready[c].set(acc.subarray(0, HOP));
      acc.copyWithin(0, HOP);
      acc.fill(0, N - HOP);
      this.inFifo[c].copyWithin(0, HOP);
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const frames = output[0].length;
    const inL = input[0], inR = input[1];
    const channels = inR ? 2 : 1;

    if (!this.enabled || !inL) {
      for (let c = 0; c < output.length; c++) {
        const src = input[c] || inL;
        if (src) output[c].set(src); else output[c].fill(0);
      }
      return true;
    }

    for (let j = 0; j < frames; j++) {
      const idx = N - HOP + this.pos;
      this.inFifo[0][idx] = inL[j];
      if (inR) this.inFifo[1][idx] = inR[j];
      const yL = this.ready[0][this.pos];
      output[0][j] = yL;
      if (output[1]) output[1][j] = inR ? this.ready[1][this.pos] : yL;
      if (++this.pos === HOP) {
        this.pos = 0;
        this.processFrame(channels);
      }
    }
    return true;
  }
}

registerProcessor('denoise', DenoiseProcessor);
