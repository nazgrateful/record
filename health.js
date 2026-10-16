// "Audio health" check: measures a document and suggests fixes.
//
// Peaks (clipping, headroom, silence at the ends) come from the stored peaks,
// so they cover the whole recording instantly. Loudness, noise, hum, rumble,
// DC offset and stereo balance need the sound itself: short recordings are
// read in full, long ones are sampled at a few hundred evenly spread places
// so the check takes seconds even on 12 hours.

import * as pcm from './pcm.js';

const dB = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const SILENT = Math.pow(10, -50 / 20); // below -50 dBFS counts as silence

export async function analyze(doc, onProgress = () => {}) {
  const total = pcm.totalLen(doc.segs), rate = doc.rate;
  const m = { total, rate, ch: doc.ch };

  // --- From the stored peaks (whole recording).
  let peak = 0, clipBins = 0, firstLoud = -1, lastLoud = -1;
  const binLevels = []; // [timeline position, level] for long-silence search
  pcm.eachSeg(doc.segs, 0, total, (s, t) => {
    const L = pcm.segLen(s);
    if (!s.key) { binLevels.push([t, 0, L]); return; }
    const p1 = doc.meta.get(s.key).p1;
    for (let k = Math.floor(s.start / pcm.P1); k * pcm.P1 < s.end; k++) {
      const lv = Math.max(-p1[2 * k], p1[2 * k + 1]) / 32768;
      if (lv > peak) peak = lv;
      if (lv >= 0.998) clipBins++;
      const pos = t + Math.max(0, k * pcm.P1 - s.start);
      if (lv > SILENT) { if (firstLoud < 0) firstLoud = pos; lastLoud = Math.min(total, pos + pcm.P1); }
      binLevels.push([pos, lv, pcm.P1]);
    }
  });
  m.peakDb = dB(peak);
  m.clipBins = clipBins;
  m.leadSilence = firstLoud < 0 ? total : firstLoud;
  m.tailSilence = firstLoud < 0 ? 0 : total - lastLoud;
  let gaps = 0, gapTotal = 0, run = 0;
  for (const [, lv, n] of binLevels) {
    if (lv <= SILENT) run += n;
    else { if (run >= rate * 30) { gaps++; gapTotal += run; } run = 0; }
  }
  m.longSilences = gaps; m.longSilenceSeconds = gapTotal / rate;

  // --- From the sound (all of it, or a sample).
  const winLen = Math.min(total, rate * 2);
  const starts = [];
  if (total <= rate * 60 * 20) for (let p = 0; p < total; p += winLen) starts.push(p);
  else {
    const n = 240;
    for (let i = 0; i < n; i++) starts.push(Math.floor(((total - winLen) * i) / (n - 1)));
  }
  m.sampled = total > rate * 60 * 20;
  const st = new Stats(rate, doc.ch);
  for (let w = 0; w < starts.length; w++) {
    st.add(await pcm.readRange(doc, starts[w], Math.min(winLen, total - starts[w])));
    onProgress((w + 1) / starts.length);
  }
  Object.assign(m, st.result());
  return m;
}

// Running measurements over chunks of planar audio.
export class Stats {
  constructor(rate, ch) {
    this.rate = rate; this.ch = ch;
    this.frame = Math.max(1, Math.round(rate * 0.05));
    this.frameDb = [];
    this.sum = new Float64Array(ch); this.sq = new Float64Array(ch);
    this.lr = 0; this.count = 0; this.lowE = 0; this.allE = 0; this.y = 0;
    this.peak = 0; this.clips = 0;
    this.humFreqs = [50, 100, 150, 60, 120, 180];
    this.hum = new Float64Array(6); this.humBlocks = 0;
    this.lowA = 1 - Math.exp((-2 * Math.PI * 40) / rate); // 40 Hz one-pole low-pass
  }

  add(chs) {
    const n = chs[0].length, ch = this.ch, rate = this.rate;
    const mix = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const x = chs[c % chs.length];
      let s = 0, q = 0;
      for (let i = 0; i < n; i++) {
        const v = x[i];
        s += v; q += v * v; mix[i] += v / ch;
        const a = v < 0 ? -v : v;
        if (a > this.peak) this.peak = a;
        if (a >= 0.999) this.clips++;
      }
      this.sum[c] += s; this.sq[c] += q;
    }
    if (ch >= 2 && chs.length >= 2) for (let i = 0; i < n; i++) this.lr += chs[0][i] * chs[1][i];
    this.count += n;
    const fr = this.frame;
    for (let f = 0; f + fr <= n; f += fr) {
      let e = 0;
      for (let i = f; i < f + fr; i++) e += mix[i] * mix[i];
      this.frameDb.push(dB(Math.sqrt(e / fr)));
    }
    let y = this.y;
    for (let i = 0; i < n; i++) { y += this.lowA * (mix[i] - y); this.lowE += y * y; this.allE += mix[i] * mix[i]; }
    this.y = y;
    // Goertzel over 1-second pieces (1 Hz wide, so mains drift doesn't matter).
    const blk = Math.min(rate, n);
    for (let b = 0; b + blk <= n && blk >= rate / 4; b += blk) {
      this.humFreqs.forEach((f, j) => {
        const k = 2 * Math.cos((2 * Math.PI * f) / rate);
        let s1 = 0, s2 = 0;
        for (let i = b; i < b + blk; i++) { const s0 = mix[i] + k * s1 - s2; s2 = s1; s1 = s0; }
        this.hum[j] += (2 * (s1 * s1 + s2 * s2 - k * s1 * s2)) / (blk * blk); // = A²/2 for a sine of amplitude A
      });
      this.humBlocks++;
    }
  }

  result() {
    const { sum, sq, count } = this;
    const sorted = this.frameDb.filter(Number.isFinite).sort((a, b) => a - b);
    const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : -Infinity);
    const humDb = (js) => dB(Math.sqrt((js.reduce((a, j) => a + this.hum[j], 0) / Math.max(1, this.humBlocks)) * 2));
    return {
      dc: Array.from(sum, (s) => s / Math.max(1, count)),
      chRmsDb: Array.from(sq, (s) => dB(Math.sqrt(s / Math.max(1, count)))),
      correlation: this.ch >= 2 && sq[0] > 0 && sq[1] > 0 ? this.lr / Math.sqrt(sq[0] * sq[1]) : null,
      lowShare: this.allE > 0 ? this.lowE / this.allE : 0,
      noiseFloorDb: pct(0.1),   // the quiet moments
      levelDb: pct(0.9),        // the loud moments (speech/music level)
      hum50Db: humDb([0, 1, 2]),
      hum60Db: humDb([3, 4, 5]),
      samplePeakDb: dB(this.peak),
      clipSamples: this.clips,
    };
  }
}

// Sound check before recording: `quiet` was measured while the user stayed
// silent, `active` while they spoke or played normally. The fixes are
// actions app.js knows how to apply live.
export function liveSuggestions(quiet, active, ctx) {
  const out = [];
  const add = (level, title, detail, fix) => out.push({ level, title, detail, fix });
  const r = (x) => (Number.isFinite(x) ? x.toFixed(0) : '−∞');
  const noise = quiet.levelDb;            // loudest moments of the quiet part
  const level = active.levelDb;
  const snr = level - Math.max(noise, quiet.noiseFloorDb);

  if (!ctx.sources) {
    add('bad', 'Nothing to record yet', 'Share your screen with audio, add the microphone, or play test tones first.');
    return out;
  }
  if (ctx.screenWithoutAudio && !ctx.mic) {
    add('bad', 'The screen share has no sound', 'Share again and turn on "Share audio" in the share dialog (for a whole screen on macOS/Linux, share a browser tab instead).');
  }
  if (level === -Infinity || level < -70) {
    add('bad', 'No sound is coming in', ctx.mic
      ? 'The microphone is silent. Check it isn\'t muted (also in your system settings), and that the browser is using the right one.'
      : 'The shared tab or screen played no sound during the test.');
    return out;
  }

  if (active.clipSamples > 0 || active.samplePeakDb > -1) {
    add('bad', 'Too loud: the sound is clipping', `Peaks reach ${r(active.samplePeakDb)} dBFS and get cut off (crackly, distorted). Move back from the mic or turn it down.`,
      ctx.mic ? { label: 'Turn mic down 6 dB', action: 'micGain-6' } : null);
  } else if (level > -10) {
    add('warn', 'Quite loud', `Loud parts reach ${r(level)} dBFS; leave some room so sudden sounds don't clip.`, ctx.mic ? { label: 'Turn mic down 4 dB', action: 'micGain-4' } : null);
  } else if (level < -32) {
    const boost = Math.min(24, Math.round(-18 - level));
    add('warn', 'Too quiet', `Your voice/sound is at ${r(level)} dBFS; aim for about −20 to −12. Move closer to the mic (about a hand's width away) or raise the volume.`,
      ctx.mic ? { label: `Turn mic up ${boost} dB`, action: `micGain+${boost}` } : null);
  } else add('ok', 'Good level', `Loud parts around ${r(level)} dBFS, peaks at ${r(active.samplePeakDb)} dBFS.`);

  if (noise > level - 6) {
    add('warn', "It wasn't quiet during the first part", `The "stay quiet" seconds were about as loud as the rest (${r(noise)} dBFS), so background noise couldn't be measured. Stay silent and pause anything playing for the first 3 seconds, then run the sound check again.`);
  } else if (snr < 30 || noise > -55) {
    const fix = !ctx.denoiseOn
      ? { label: 'Turn on noise removal', action: 'denoiseOn' }
      : ctx.learned ? { label: 'Stronger noise removal', action: 'denoiseStronger' } : { label: 'Learn this room\'s noise', action: 'learnNoise' };
    add(snr < 15 ? 'bad' : 'warn', 'Background noise', `When you're quiet the room is at ${r(noise)} dBFS, only ${r(snr)} dB under your sound (30 dB or more sounds clean). Turn off fans or AC if you can, close windows, and get closer to the mic.`, fix);
  } else add('ok', 'Quiet background', `${r(snr)} dB between your sound and the room noise.`);

  const humHz = quiet.hum50Db >= quiet.hum60Db ? 50 : 60, hum = Math.max(quiet.hum50Db, quiet.hum60Db);
  if (hum > -60 && hum > quiet.noiseFloorDb - 3 && ctx.humFilter !== humHz) {
    add('warn', `Mains hum (${humHz} Hz)`, `An electrical hum at ${r(hum)} dBFS. Try another USB port or power socket, keep cables away from chargers, or unplug the laptop charger.`, { label: `Filter out ${humHz} Hz hum`, action: `hum${humHz}` });
  } else add('ok', 'No mains hum');

  if (quiet.lowShare > 0.3 || active.lowShare > 0.35) {
    if (!ctx.highpass) add('warn', 'Low rumble', 'Deep rumbling (traffic, wind, desk bumps, handling noise). Put the mic on a stand or soft pad.', { label: 'Cut rumble below 80 Hz', action: 'highpassOn' });
    else add('warn', 'Low rumble', 'Deep rumbling even with the low cut on: put the mic on a stand or a soft pad, away from the desk.');
  }

  if (Math.max(...active.dc.map(Math.abs)) > 0.005 && !ctx.highpass) {
    add('warn', 'DC offset', 'The signal is shifted off centre (often a cheap sound card). The low cut removes it.', { label: 'Turn on low cut', action: 'highpassOn' });
  }

  if (active.chRmsDb.length >= 2) {
    const [l, rr] = active.chRmsDb;
    if (Math.abs(l - rr) > 20 || !Number.isFinite(l) || !Number.isFinite(rr)) {
      add('warn', 'Sound on one side only', 'One channel is silent; listeners will hear it in one ear. You can fix it after recording in the editor ("Check audio health").');
    } else if (active.correlation !== null && active.correlation < -0.3) {
      add('warn', 'Left and right are out of phase', 'The sides cancel out in mono or on phone speakers. Can be fixed afterwards in the editor.');
    }
  }

  if (ctx.monitor && ctx.mic) add('warn', 'Listening through speakers?', '"Hear processed audio" is on: use headphones, or the mic will pick up the speakers (echo/feedback).');
  if (ctx.mic && !ctx.browserNs && snr < 30) add('warn', 'Browser noise suppression is off', 'Turning on "Browser noise suppression + echo cancel" helps in noisy rooms (it can make music sound worse).', { label: 'Turn it on', action: 'browserNsOn' });
  return out;
}

// Turns measurements into a list of findings: { level: 'ok'|'warn'|'bad',
// title, detail, fix?: { label, action } }.
export function suggestions(m, fmt) {
  const out = [];
  const add = (level, title, detail, fix) => out.push({ level, title, detail, fix });
  const r = (x) => (Number.isFinite(x) ? x.toFixed(1) : '−∞');

  if (m.peakDb === -Infinity) {
    add('bad', 'The recording is silent', 'There is no sound at all. Check that the right microphone or "Share audio" was used.');
    return out;
  }

  if (m.clipBins > 0) {
    add(m.clipBins > 20 ? 'bad' : 'warn', `Clipping in ${m.clipBins} place${m.clipBins === 1 ? '' : 's'}`,
      'The sound hit the maximum level and got cut off (it sounds crackly or distorted there). This can\'t be fully undone; next time record a bit quieter. Turning it down 1 dB avoids clipping when you play or convert it.',
      { label: 'Lower by 1 dB', action: 'gain-1' });
  } else add('ok', 'No clipping', `Highest peak ${r(m.peakDb)} dBFS.`);

  if (m.levelDb < -30) {
    add('warn', 'Too quiet', `Loud parts are around ${r(m.levelDb)} dBFS; aim for about −20 to −12. Normalizing raises the volume so the loudest peak sits just under the maximum.`, { label: 'Normalize', action: 'normalize' });
  } else if (m.levelDb > -8) {
    add('warn', 'Very loud', `Loud parts are around ${r(m.levelDb)} dBFS, which is tiring to listen to and close to clipping.`, { label: 'Lower by 6 dB', action: 'gain-6' });
  } else if (m.peakDb < -6) {
    add('warn', 'Volume could be higher', `The highest peak is ${r(m.peakDb)} dBFS, so there's unused room.`, { label: 'Normalize', action: 'normalize' });
  } else add('ok', 'Good volume', `Loud parts around ${r(m.levelDb)} dBFS.`);

  const snr = m.levelDb - m.noiseFloorDb;
  if (m.noiseFloorDb > -50 && snr < 30) {
    add(snr < 15 ? 'bad' : 'warn', 'Background noise', `The quiet parts sit at ${r(m.noiseFloorDb)} dBFS, only ${r(snr)} dB below the main sound (30 dB or more is clean). Tip: select a stretch with only noise and press "Learn noise from selection" first for the best result.`, { label: 'Remove noise', action: 'denoise' });
  } else add('ok', 'Low background noise', `Quiet parts at ${r(m.noiseFloorDb)} dBFS.`);

  const humHz = m.hum50Db >= m.hum60Db ? 50 : 60, humLevel = Math.max(m.hum50Db, m.hum60Db);
  if (humLevel > -55 && humLevel > m.noiseFloorDb - 6) {
    add('warn', `Mains hum (${humHz} Hz)`, `An electrical hum at ${humHz} Hz and its harmonics, around ${r(humLevel)} dBFS. Usually from a ground loop or a cable near power.`, { label: `Remove ${humHz} Hz hum`, action: `hum${humHz}` });
  } else add('ok', 'No mains hum');

  if (m.lowShare > 0.3) {
    add('warn', 'Low rumble', `${Math.round(m.lowShare * 100)}% of the energy is below 40 Hz (wind, handling, traffic or desk bumps). A low cut removes it without changing voices.`, { label: 'Cut rumble (80 Hz)', action: 'highpass' });
  } else add('ok', 'No low rumble');

  const dc = Math.max(...m.dc.map(Math.abs));
  if (dc > 0.005) {
    add('warn', 'DC offset', `The waveform is shifted off centre by ${(dc * 100).toFixed(1)}%. It wastes headroom and can cause clicks at cuts.`, { label: 'Remove DC offset', action: 'dc' });
  } else add('ok', 'Centred waveform (no DC offset)');

  if (m.ch >= 2) {
    const [l, rr] = m.chRmsDb;
    if (!Number.isFinite(l) || !Number.isFinite(rr) || Math.abs(l - rr) > 20) {
      const louder = !Number.isFinite(rr) || l > rr ? 'left' : 'right';
      add('bad', `Only the ${louder} side has sound`, 'One channel is silent or nearly so, so listeners hear it in one ear only.', { label: `Use ${louder} on both sides`, action: louder === 'left' ? 'useL' : 'useR' });
    } else if (Math.abs(l - rr) > 6) {
      const louder = l > rr ? 'left' : 'right';
      add('warn', `Lopsided: ${louder} is ${Math.abs(l - rr).toFixed(0)} dB louder`, 'The sound leans to one side.', { label: 'Balance sides', action: 'balance' });
    } else if (m.correlation !== null && m.correlation < -0.3) {
      add('bad', 'Left and right are out of phase', 'The two sides cancel each other out on phone speakers and in mono. Flipping one side fixes it.', { label: 'Flip right side', action: 'invertR' });
    } else add('ok', 'Left and right are balanced');
  }

  const lead = m.leadSilence / m.rate, tail = m.tailSilence / m.rate;
  if (lead > 3 || tail > 3) {
    add('warn', 'Silence at the start or end', `${fmt(lead)} of silence at the start and ${fmt(tail)} at the end.`, { label: 'Trim silent ends', action: 'trimEnds' });
  }
  if (m.longSilences) add('warn', `${m.longSilences} long silent stretch${m.longSilences === 1 ? '' : 'es'}`, `${fmt(m.longSilenceSeconds)} in total of 30 s+ gaps. Select them on the waveform and press Delete to remove them.`);
  if (m.rate < 22050) add('warn', `Low sample rate (${(m.rate / 1000).toFixed(1)} kHz)`, 'Fine for speech, but music will sound dull. Record at 44.1 or 48 kHz if you can.');
  if (m.sampled) add('ok', 'Long recording: checked by sampling', 'Loudness, noise, hum and balance were measured at 240 places spread across the whole recording.');
  return out;
}
