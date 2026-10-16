// Tone generator for the editor's "Add frequencies": layers of tones (sine,
// triangle, square or sawtooth), each with its own volume and optionally a
// different frequency in the right ear (binaural beat).
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

// Adds the layers to `chs` (planar floats for samples [at, at + n) of a span
// `span` samples long), with fades at both ends of the span.
export function addTones(chs, layers, { rate, at, span, fade }) {
  const n = chs[0].length;
  const stereo = chs.length >= 2;
  for (const layer of layers) {
    const amp = Math.pow(10, layer.db / 20);
    for (let c = 0; c < chs.length; c++) {
      const right = stereo && c === 1 && layer.right > 0;
      const freqs = right ? [layer.right]
        // Mono file with a binaural pair: both tones (heard as a pulsing beat).
        : !stereo && layer.right > 0 ? [layer.left, layer.right] : [layer.left];
      const a = amp / freqs.length;
      const x = chs[c];
      for (const f of freqs) {
        if (!(f > 0) || f >= rate / 2) continue;
        for (let i = 0; i < n; i++) {
          const s = at + i;
          const env = fade > 0 ? Math.min(1, s / fade, (span - s) / fade) : 1;
          const p = ((f * s) / rate) % 1;
          x[i] += a * env * wave(layer.wave, p);
        }
      }
    }
  }
  for (const x of chs) for (let i = 0; i < n; i++) x[i] = x[i] > 1 ? 1 : x[i] < -1 ? -1 : x[i];
  return chs;
}

export function describe(layer) {
  if (!(layer.right > 0) || layer.right === layer.left) return '';
  const beat = Math.abs(layer.right - layer.left);
  const band = beatBand(beat);
  return `${+beat.toFixed(2)} Hz beat${band ? ` · ${band.name}` : ''}`;
}
