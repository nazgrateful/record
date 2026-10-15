// AudioWorklet that watches incoming audio for a list of named target
// frequencies (Goertzel algorithm), reports when each one is present, and can
// optionally silence the output while a target marked "mute" is present.
//
// It runs on the audio thread, so detection keeps working when the tab is in
// the background (where timers and requestAnimationFrame get throttled). It
// also posts a "tick" ~30x per second, which the page uses to draw video
// frames for the same reason.

const MIN_WINDOW = 1024;  // ~21 ms at 48 kHz: fast reaction for wide targets
const MAX_WINDOW = 16384; // ~0.34 s: fine resolution for narrow targets
const REPORT = 1024;      // samples between status messages to the page
const MAX_BINS = 24;      // Goertzel bins per target
const TICK_HZ = 30;

class FreqGuardProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cfg = { threshold: 0.25, minDb: -55, holdMs: 250, targets: [] };
    this.gain = 1;
    this.levelN = 0;
    this.levelEnergy = 0;
    this.changed = false;
    this.tickEvery = Math.round(sampleRate / TICK_HZ);
    this.tickCount = 0;
    this.targets = [];
    this.configure();
    this.port.onmessage = (e) => {
      Object.assign(this.cfg, e.data);
      this.configure();
    };
  }

  configure() {
    this.targets = this.cfg.targets.map((t) => {
      // Each target gets its own window length: a narrow +/- tolerance needs a
      // long window to tell e.g. 417 Hz from 432 Hz; a wide one reacts faster
      // with a short window. Frequency resolution is about sampleRate / N.
      const tol = Math.max(1.5, t.tolerance);
      const N = Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, Math.round(sampleRate / (2 * tol))));
      const step = sampleRate / N / 2; // half a bin so no tone slips between bins
      const lo = Math.max(1, t.freq - t.tolerance);
      const hi = Math.min(sampleRate / 2 - 1, t.freq + t.tolerance);
      const count = Math.min(MAX_BINS, Math.max(1, Math.floor((hi - lo) / step) + 1));
      const coeffs = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const f = count === 1 ? t.freq : lo + ((hi - lo) * i) / (count - 1);
        coeffs[i] = 2 * Math.cos((2 * Math.PI * f) / sampleRate);
      }
      const prev = this.targets.find((p) => p.id === t.id);
      return {
        id: t.id, mute: !!t.mute, coeffs, N, n: 0, energy: 0,
        s1: new Float32Array(count), s2: new Float32Array(count),
        hold: prev ? prev.hold : 0, detected: prev ? prev.detected : false, ratio: 0,
      };
    });
  }

  endWindow(t) {
    const N = t.n;
    let best = 0;
    for (let i = 0; i < t.coeffs.length; i++) {
      const a = t.s1[i], b = t.s2[i];
      const p = a * a + b * b - t.coeffs[i] * a * b;
      if (p > best) best = p;
    }
    // Share of the window's energy at this frequency: ~1 for a pure sine,
    // ~0 for broadband audio.
    t.ratio = t.energy > 0 ? Math.min(1, (2 * best) / (N * t.energy)) : 0;
    const rms = Math.sqrt(t.energy / N);
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    const hit = t.ratio >= this.cfg.threshold && db >= this.cfg.minDb;
    if (hit) t.hold = Math.round((this.cfg.holdMs / 1000) * sampleRate);
    else t.hold = Math.max(0, t.hold - N);
    const now = hit || t.hold > 0;
    if (now !== t.detected) this.changed = true;
    t.detected = now;
    t.s1.fill(0);
    t.s2.fill(0);
    t.n = 0;
    t.energy = 0;
  }

  report() {
    const rms = Math.sqrt(this.levelEnergy / this.levelN);
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    this.port.postMessage({
      type: 'status', changed: this.changed, db, time: currentTime,
      targets: this.targets.map((t) => ({ id: t.id, detected: t.detected, ratio: t.ratio })),
    });
    this.changed = false;
    this.levelN = 0;
    this.levelEnergy = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const frames = output[0].length;
    const inL = input[0];
    const inR = input[1] || input[0];
    const targets = this.targets;
    const fade = 1 - Math.exp(-1 / (0.005 * sampleRate)); // ~5 ms gain ramp
    let muted = false;
    for (const t of targets) if (t.mute && t.detected) muted = true;

    for (let j = 0; j < frames; j++) {
      const l = inL ? inL[j] : 0;
      const r = inR ? inR[j] : 0;
      const x = (l + r) * 0.5;

      const xx = x * x;
      let ended = false;
      for (let ti = 0; ti < targets.length; ti++) {
        const t = targets[ti], c = t.coeffs, s1 = t.s1, s2 = t.s2;
        for (let k = 0; k < c.length; k++) {
          const s = x + c[k] * s1[k] - s2[k];
          s2[k] = s1[k];
          s1[k] = s;
        }
        t.energy += xx;
        if (++t.n >= t.N) { this.endWindow(t); ended = true; }
      }
      if (ended) {
        muted = false;
        for (const t of targets) if (t.mute && t.detected) muted = true;
      }
      this.levelEnergy += xx;
      if (++this.levelN >= REPORT) this.report();

      this.gain += ((muted ? 0 : 1) - this.gain) * fade;
      output[0][j] = l * this.gain;
      if (output[1]) output[1][j] = r * this.gain;
    }

    this.tickCount += frames;
    if (this.tickCount >= this.tickEvery) {
      this.tickCount -= this.tickEvery;
      this.port.postMessage({ type: 'tick' });
    }
    return true;
  }
}

registerProcessor('freq-guard', FreqGuardProcessor);
