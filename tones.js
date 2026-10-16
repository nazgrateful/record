// Tone generator for the editor's "Add frequencies": layers of tones (sine,
// triangle, square or sawtooth), each with its own volume and optionally a
// choice of ears: both, left only, right only, or a different frequency in
// each ear (a binaural beat).
//
// Phase is computed from the absolute sample position, so a tone generated
// window by window joins up seamlessly.

import { beatBand } from './presets.js';

export const WAVES = { sine: 'Sine (pure)', triangle: 'Triangle (soft)', square: 'Square (buzzy)', sawtooth: 'Sawtooth (bright)' };

// Ready-made binaural beats: a carrier in the left ear, carrier + beat in the right.
export const BINAURAL_PRESETS = [
  { name: 'Delta 2 Hz on 100 Hz (deep sleep)', left: 100, right: 102 },
  { name: 'Focus 10: 4 Hz on 100 Hz (mind awake, body asleep)', left: 100, right: 104 },
  { name: 'Theta 6 Hz on 200 Hz (meditation)', left: 200, right: 206 },
  { name: 'Theta 7 Hz on 100 Hz (deep meditation, REM)', left: 100, right: 107 },
  { name: 'Alpha 10 Hz on 300 Hz (relaxed awareness)', left: 300, right: 310 },
  { name: 'Beta 15 Hz on 200 Hz (alert focus)', left: 200, right: 215 },
  { name: 'Gamma 40 Hz on 200 Hz (high focus)', left: 200, right: 240 },
];

const TAU = 2 * Math.PI;

function wave(type, p) {
  // p: phase in cycles, 0..1
  switch (type) {
    case 'triangle': return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    case 'square': return p < 0.5 ? 1 : -1;
    case 'sawtooth': return 2 * p - 1;
    default: return Math.sin(TAU * p);
  }
}

export const EARS = {
  both: 'Both ears',
  left: 'Left ear only',
  right: 'Right ear only',
  split: 'Different in each ear',
};

// Brings layers saved by earlier versions ({ left, right }) to the current
// shape ({ ears, hz, left, right }). Missing fields get defaults.
export function normalizeLayer(l) {
  const out = { wave: 'sine', db: -18, name: 'Tone', ...l };
  if (!EARS[out.ears]) {
    if (out.right > 0 && out.right !== out.left) out.ears = 'split';
    else { out.ears = 'both'; out.hz = out.left; }
  }
  out.hz = +out.hz > 0 ? +out.hz : +out.left > 0 ? +out.left : 432;
  out.left = +out.left > 0 ? +out.left : out.hz;
  out.right = +out.right > 0 ? +out.right : out.hz;
  return out;
}

// The frequencies one layer plays in channel c (0 = left, 1 = right).
export function freqsFor(layer, c, stereo) {
  const { ears, hz, left, right } = layer;
  if (!stereo) return ears === 'split' ? [left, right] : [hz]; // mono: everything in the one channel
  if (ears === 'both') return [hz];
  if (ears === 'left') return c === 0 ? [hz] : [];
  if (ears === 'right') return c === 1 ? [hz] : [];
  return [c === 0 ? left : right];
}

// Adds the layers to `chs` (planar floats for samples [at, at + n) of a span
// `span` samples long), with fades at both ends of the span.
export function addTones(chs, layers, { rate, at, span, fade }) {
  const n = chs[0].length;
  const stereo = chs.length >= 2;
  for (const layer of layers) {
    const amp = Math.pow(10, layer.db / 20);
    for (let c = 0; c < chs.length; c++) {
      const freqs = freqsFor(layer, c, stereo).filter((f) => f > 0 && f < rate / 2);
      const a = amp / Math.max(1, freqs.length);
      const x = chs[c];
      for (const f of freqs) {
        for (let i = 0; i < n; i++) {
          const s = at + i;
          const env = fade > 0 ? Math.min(1, s / fade, (span - s) / fade) : 1;
          x[i] += a * env * wave(layer.wave, ((f * s) / rate) % 1);
        }
      }
    }
  }
  for (const x of chs) for (let i = 0; i < n; i++) x[i] = x[i] > 1 ? 1 : x[i] < -1 ? -1 : x[i];
  return chs;
}

// e.g. "4 Hz beat · Theta" for different tones in each ear.
export function describe(layer) {
  if (layer.ears !== 'split' || layer.left === layer.right) return '';
  const beat = Math.abs(layer.right - layer.left);
  const band = beatBand(beat);
  return `${+beat.toFixed(2)} Hz binaural beat${band ? ` · ${band.name}` : ''}`;
}
