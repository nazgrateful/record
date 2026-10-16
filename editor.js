// Audio editor: import an audio (or video) file of any length — up to 12
// hours and beyond — see the whole recording, move through it, select a part
// and edit it, then save or download the result.
//
// The sound lives in the browser's storage in blocks (see pcm.js); only what
// is being drawn, played or processed is loaded. Cut / copy / paste / delete /
// trim / silence just rearrange segments, so they are instant on any length;
// effects stream through the selection and write new blocks.

import * as pcm from './pcm.js';
import { decodeFile } from './decoders.js';
import { encode, docSource, formatById, FORMATS, supportedFormats, downloadParts } from './export.js';
import { analyze, suggestions } from './health.js';
import { VIDEO_FORMATS, videoFormatLabels } from './video.js';
import { addTones, describe, normalizeLayer, freqsFor, WAVES, EARS, BINAURAL_PRESETS } from './tones.js';
import { PRESET_LIBRARY } from './presets.js';
import { playTone } from './tone-player.js';
import { Wsola, Resampler } from './stretch.js';
import { findStreetNoise, tonalPeaks, TYPES as STREET_TYPES } from './street.js';

const $ = (id) => document.getElementById(id);
const UNDO_LIMIT = 50;
const WIN = 1 << 18;          // samples processed per step

let deps = null;              // functions from app.js
let doc = null;               // { id, name, rate, ch, segs, meta }
let total = 0;                // length in samples
let undoStack = [], redoStack = [];
let clip = null;              // copied segments
let noiseClip = null;         // learned noise sample (planar floats)
let selA = 0, selB = 0;       // selection in samples (equal: just a cursor)
let view0 = 0, view1 = 0;     // range shown in the main waveform
let playing = null;
let busy = false;
let overview = null;          // cached overview peaks
let drawQueued = false;

export function initEditor(d) {
  deps = d;
  const file = $('ed-file');
  file.addEventListener('change', () => { if (file.files[0]) openFile(file.files[0]); file.value = ''; });
  const drop = $('ed-drop');
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
  });

  setupWave();
  setupOverview();
  setupTones();
  for (const b of document.querySelectorAll('[data-speed]')) {
    b.addEventListener('click', () => { if (doc && !busy) changeSpeed(+b.dataset.speed); });
  }
  $('ed-rate').addEventListener('change', () => { if (playing) { const sel = hasSel() && playing.to === selB; stop(); play(sel); } });

  const actions = {
    'ed-play': () => (playing ? stop() : play(false)),
    'ed-play-sel': () => play(true),
    'ed-start': () => { stop(); setCursor(0); },
    'ed-back': () => { stop(); setCursor(selA - doc.rate * 10); },
    'ed-fwd': () => { stop(); setCursor(selA + doc.rate * 10); },
    'ed-end': () => { stop(); setCursor(total); },
    'ed-goto-btn': goTo,
    'ed-select-all': () => { selA = 0; selB = total; draw(); },
    'ed-zoom-in': () => zoom(0.5),
    'ed-zoom-out': () => zoom(2),
    'ed-zoom-sel': zoomToSelection,
    'ed-zoom-all': () => { view0 = 0; view1 = total; draw(); },
    'ed-undo': undo,
    'ed-redo': redo,
    'ed-trim': trim,
    'ed-delete': removeRange,
    'ed-silence': silenceRange,
    'ed-cut': () => { if (copy()) removeRange(); },
    'ed-copy': () => copy() && deps.toast('Copied.'),
    'ed-paste': paste,
    'ed-fade-in': () => effect('Faded in', (x, at, span) => { for (let i = 0; i < x.length; i++) x[i] *= (at + i) / span; }),
    'ed-fade-out': () => effect('Faded out', (x, at, span) => { for (let i = 0; i < x.length; i++) x[i] *= 1 - (at + i) / span; }),
    'ed-amplify': () => {
      const g = Math.pow(10, (+$('ed-gain').value || 0) / 20);
      effect('Volume changed', (x) => { for (let i = 0; i < x.length; i++) x[i] *= g; });
    },
    'ed-normalize': normalize,
    'ed-reverse': reverse,
    'ed-learn-noise': learnNoise,
    'ed-denoise': denoise,
    'ed-save': save,
    'ed-download': download,
    'ed-close': close,
    'ed-health': checkHealth,
    'ed-tones-apply': applyTones,
    'ed-tones-preview': previewTones,
    'ed-notch-btn': removeFrequency,
    'ed-speed-apply': () => changeSpeed(+$('ed-speed').value / 100),
    'ed-street-find': findStreet,
    'ed-street-apply': applyStreet,
    'ed-street-all': () => { streetEvents.forEach((e) => { e.on = true; }); renderStreet(); },
    'ed-street-none': () => { streetEvents.forEach((e) => { e.on = false; }); renderStreet(); },
  };
  for (const [id, fn] of Object.entries(actions)) {
    $(id).addEventListener('click', () => { if (doc && !busy) fn(); });
  }
  $('ed-goto').addEventListener('keydown', (e) => { if (e.key === 'Enter') goTo(); });
  $('ed-scroll').addEventListener('input', () => {
    const span = view1 - view0;
    view0 = Math.round((+$('ed-scroll').value / 10000) * (total - span));
    view1 = view0 + span;
    draw();
  });
  $('ed-wave').addEventListener('keydown', onKey);
  window.addEventListener('resize', () => { overview = null; draw(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { overview = null; draw(); });
  fillFormats($('ed-format'));

  // Pick up where we left off: imported audio stays in the browser's storage.
  pcm.restoreDoc().then((d) => {
    if (d) {
      show(d);
      deps.toast(d.missing
        ? `Reopened "${d.name}", but ${fmt(d.missing / d.rate)} of it was missing from storage and is now silent.`
        : `Reopened "${d.name}" in the editor.`, d.missing ? 9000 : 3500);
    }
  }).catch(() => {});
}

// ------------------------------------------------------------- loading --

// Opens a file or a Blob (e.g. a saved recording) in the editor.
// Closes what's open (after asking) so something else can be opened.
async function makeRoom() {
  if (busy) { deps.toast('Wait for the current job to finish.'); return false; }
  if (doc && !confirm('Close the audio that is open in the editor? Save or download it first if you need it.')) return false;
  stop();
  if (doc) { await pcm.discardDoc(doc).catch(() => {}); doc = null; }
  return true;
}

export async function openFile(file, baseName) {
  if (!(await makeRoom())) return;
  const name = baseName || (file.name || 'audio').replace(/\.[^.]+$/, '');
  const mono = $('ed-mono').checked;
  let d = null, writer = null;
  const sink = {
    push(planar, rate) {
      if (!d) {
        d = pcm.newDoc(name, rate, mono ? 1 : Math.min(planar.length, 8));
        writer = new pcm.BlockWriter(d);
      }
      if (mono && planar.length > 1) {
        const m = new Float32Array(planar[0].length);
        for (const x of planar) for (let i = 0; i < m.length; i++) m[i] += x[i] / planar.length;
        planar = [m];
      }
      writer.push(planar);
    },
    drain: () => (writer ? writer.drain() : Promise.resolve()),
  };
  await job(`Importing ${file.name || name}…`, async (progress) => {
    try {
      await decodeFile(file, sink, { onProgress: progress, fallback: deps.decode });
      if (!d) throw new Error('No audio found in this file.');
      d.segs = await writer.finish();
      if (!pcm.totalLen(d.segs)) throw new Error('No audio found in this file.');
      await pcm.saveDoc(d);
      show(d);
      deps.toast(`Opened "${name}" (${fmt(total / d.rate)}).`);
      if ($('ed-keep-original').checked && file instanceof File) await deps.saveOriginal(file);
    } catch (err) {
      if (d) pcm.discardDoc(d).catch(() => {});
      const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message));
      deps.toast(quota
        ? 'Not enough space in this website\'s storage for this file. Free some space (delete saved recordings) or tick "Import as mono".'
        : `Couldn't open "${file.name || name}": ${err.message || err}`, 9000);
    }
  });
}

function show(d) {
  doc = d;
  total = pcm.totalLen(doc.segs);
  undoStack = []; redoStack = [];
  noiseClip = null;
  selA = selB = 0;
  view0 = 0; view1 = total;
  overview = null;
  $('ed-name').value = `${doc.name}-edited`;
  $('ed-noise-status').textContent = 'Noise: automatic';
  $('ed-body').hidden = false;
  draw();
  $('editor-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function close() {
  if (!confirm('Close this audio? Edits that you haven\'t saved or downloaded will be lost.')) return;
  stop();
  const old = doc;
  doc = null;
  $('ed-body').hidden = true;
  await pcm.discardDoc(old).catch(() => {});
}

const hasSel = () => selB > selA;
const range = () => (hasSel() ? [selA, selB] : [0, total]);
const needSel = () => { deps.toast('Select a part first: drag on the waveform.'); };

// Runs a long task with a progress bar; blocks other edits meanwhile.
async function job(label, fn) {
  busy = true;
  document.body.classList.add('ed-busy');
  $('ed-job').hidden = false;
  $('ed-job-label').textContent = label;
  $('ed-progress').value = 0;
  try {
    await fn((f) => { $('ed-progress').value = f; });
  } finally {
    busy = false;
    document.body.classList.remove('ed-busy');
    $('ed-job').hidden = true;
  }
}

// --------------------------------------------------------------- edits --

function setSegs(segs, msg) {
  undoStack.push({ segs: doc.segs, selA, selB });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
  doc.segs = segs;
  changed(msg);
}

function changed(msg) {
  total = pcm.totalLen(doc.segs);
  selA = Math.min(selA, total); selB = Math.min(selB, total);
  if (view1 > total || view1 - view0 < 2) { view1 = Math.min(total, view1); view0 = Math.max(0, Math.min(view0, view1 - 2)); }
  if (view1 - view0 < 2) { view0 = 0; view1 = total; }
  overview = null;
  pcm.saveDoc(doc).catch(() => {});
  draw();
  if (msg) deps.toast(msg);
}

function undo() {
  if (!undoStack.length) return;
  stop();
  redoStack.push({ segs: doc.segs, selA, selB });
  ({ segs: doc.segs, selA, selB } = undoStack.pop());
  changed();
}
function redo() {
  if (!redoStack.length) return;
  stop();
  undoStack.push({ segs: doc.segs, selA, selB });
  ({ segs: doc.segs, selA, selB } = redoStack.pop());
  changed();
}

function trim() {
  if (!hasSel()) return needSel();
  stop();
  const segs = pcm.extract(doc.segs, selA, selB);
  selB -= selA; selA = 0;
  view0 = 0; view1 = selB;
  setSegs(segs, 'Trimmed to the selection.');
}

function removeRange() {
  if (!hasSel()) return needSel();
  if (selB - selA >= total) return deps.toast("Can't delete everything — use Close instead.");
  stop();
  const segs = pcm.replace(doc.segs, selA, selB, []);
  selB = selA;
  setSegs(segs, 'Deleted.');
}

function silenceRange() {
  if (!hasSel()) return needSel();
  stop();
  setSegs(pcm.replace(doc.segs, selA, selB, [pcm.silence(selB - selA)]), 'Silenced.');
}

function copy() {
  if (!hasSel()) { needSel(); return false; }
  clip = pcm.extract(doc.segs, selA, selB);
  return true;
}

function paste() {
  if (!clip) return deps.toast('Copy or cut something first.');
  stop();
  const n = pcm.totalLen(clip);
  const segs = pcm.replace(doc.segs, selA, selB, clip);
  selB = selA + n;
  setSegs(segs, 'Pasted.');
}

// Rewrites [a, b) by streaming it through `make(pos, n)` -> planar floats,
// storing the result as new blocks.
async function rewrite(label, a, b, make, { backwards = false } = {}) {
  stop();
  let ok = false;
  await job(label, async (progress) => {
    const writer = new pcm.BlockWriter(doc);
    try {
      const span = b - a;
      for (let done = 0; done < span;) {
        const n = Math.min(WIN, span - done);
        const pos = backwards ? b - done - n : a + done;
        writer.push(await make(pos, n));
        await writer.drain();
        done += n;
        progress(done / span);
      }
      setSegs(pcm.replace(doc.segs, a, b, await writer.finish()));
      ok = true;
    } catch (err) {
      deps.toast(`${label.replace('…', '')} failed: ${err.message}`, 8000);
    }
  });
  return ok;
}

async function effect(msg, fn) {
  const [a, b] = range();
  const ok = await rewrite(msg + '…', a, b, async (pos, n) => {
    const chs = await pcm.readRange(doc, pos, n);
    for (const x of chs) {
      fn(x, pos - a, b - a);
      for (let i = 0; i < x.length; i++) x[i] = x[i] > 1 ? 1 : x[i] < -1 ? -1 : x[i];
    }
    return chs;
  });
  if (ok) deps.toast(msg + (hasSel() ? ' (selection).' : ' (whole recording).'));
}

async function reverse() {
  const [a, b] = range();
  const ok = await rewrite('Reversing…', a, b, async (pos, n) => {
    const chs = await pcm.readRange(doc, pos, n);
    chs.forEach((x) => x.reverse());
    return chs;
  }, { backwards: true });
  if (ok) deps.toast('Reversed.');
}

// Loudest sample in [a, b), from the stored peaks (no sound needs loading).
function peakIn(a, b) {
  let peak = 0;
  pcm.eachSeg(doc.segs, a, b, (s, t) => {
    if (!s.key) return;
    const m = doc.meta.get(s.key);
    const from = s.start + Math.max(0, a - t), to = s.start + Math.min(pcm.segLen(s), b - t);
    for (let k = Math.floor(from / pcm.P1); k * pcm.P1 < to; k++) peak = Math.max(peak, -m.p1[2 * k], m.p1[2 * k + 1]);
  });
  return peak / 32768;
}

function normalize() {
  const [a, b] = range();
  const peak = peakIn(a, b);
  if (peak < 1e-4) return deps.toast('That part is silent.');
  const g = 0.98 / peak;
  return effect('Normalized', (x) => { for (let i = 0; i < x.length; i++) x[i] *= g; });
}

async function learnNoise() {
  if (!hasSel()) return deps.toast('Select a part with only background noise (no voice or music) first.');
  const n = Math.min(selB - selA, doc.rate * 10);
  noiseClip = await pcm.readRange(doc, selA, n);
  $('ed-noise-status').textContent = `Noise: learned from ${fmt(n / doc.rate, true)}`;
  deps.toast('Noise learned. Now select a part (or nothing for everything) and press Remove noise.');
}

// The recorder's noise remover, run offline over the selection (or all).
async function denoise() {
  const [a, b] = range();
  const PRE = Math.round(doc.rate * 2); // context before each piece so it starts settled
  const ok = await rewrite('Removing noise…', a, b, async (pos, n) => {
    const pre = Math.min(PRE, pos);
    const input = await pcm.readRange(doc, pos - pre, n + pre);
    const out = await renderDenoise(input, doc.rate, noiseClip);
    return out.map((x) => x.subarray(pre));
  });
  if (ok) deps.toast('Noise removed' + (hasSel() ? ' (selection).' : ' (whole recording).'));
}

const DN_LATENCY = 1024; // the worklet's FFT size: its output lags by this much

async function renderDenoise(chs, rate, noise) {
  const n = chs[0].length;
  const pre = noise ? noise[0].length : 0;
  const len = pre + n + DN_LATENCY;
  const oc = new OfflineAudioContext(chs.length, len, rate);
  await oc.audioWorklet.addModule('denoise-worklet.js');
  const buf = oc.createBuffer(chs.length, len, rate);
  chs.forEach((x, c) => {
    const d = buf.getChannelData(c);
    if (noise) d.set(noise[c % noise.length]);
    d.set(x, pre);
  });
  const src = oc.createBufferSource();
  src.buffer = buf;
  const { strength, floor } = deps.denoiseSettings();
  const node = new AudioWorkletNode(oc, 'denoise', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [chs.length],
    processorOptions: { enabled: true, strength, floor, ...(noise ? { learn: pre / rate } : {}) },
  });
  src.connect(node).connect(oc.destination);
  src.start();
  const r = await oc.startRendering();
  const start = pre + DN_LATENCY;
  return chs.map((_, c) => r.getChannelData(c).slice(start, start + n));
}

// ------------------------------------------------------------ playback --

// Streams the sound from storage a couple of seconds at a time.
async function play(selectionOnly) {
  stop();
  if (selectionOnly && !hasSel()) return needSel();
  const { ctx, nodes } = await deps.audioGraph();
  const out = ctx.createGain();
  out.connect(ctx.destination);
  // Also feed the frequency detector (it doesn't play it a second time).
  if ($('ed-detect').checked) out.connect(nodes.intIn);
  const from = selectionOnly ? selA : selA >= total ? 0 : selA;
  const to = selectionOnly ? selB : total;
  const speed = +$('ed-rate').value || 1; // listening speed only (pitch changes)
  const p = { ctx, out, from, to, speed, loop: $('ed-loop').checked, startAt: null, stopped: false, endsAt: null, sources: new Set() };
  playing = p;
  $('ed-play').textContent = '❚❚ Pause';
  requestAnimationFrame(tick);
  const step = Math.round(doc.rate * 2);
  let pos = from, t = 0;
  while (!p.stopped) {
    if (pos >= to) {
      if (!p.loop) { p.endsAt = t; break; }
      pos = from;
    }
    const n = Math.min(step, to - pos);
    let chs;
    try { chs = await pcm.readRange(doc, pos, n); } catch (err) { deps.toast(err.message, 6000); stop(); return; }
    if (p.stopped) break;
    const buf = ctx.createBuffer(doc.ch, n, doc.rate);
    chs.forEach((x, c) => buf.copyToChannel(x, c));
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = speed;
    s.connect(out);
    if (p.startAt === null) { p.startAt = t = ctx.currentTime + 0.05; }
    s.start(t);
    p.sources.add(s);
    s.onended = () => p.sources.delete(s);
    t += n / doc.rate / speed;
    pos += n;
    while (!p.stopped && t - ctx.currentTime > 4) await new Promise((r) => setTimeout(r, 250));
  }
}

function stop() {
  if (!playing) return;
  const p = playing;
  playing = null;
  p.stopped = true;
  // Pausing leaves the cursor where playback got to.
  if (!hasSel() && doc) selA = selB = position(p);
  for (const s of p.sources) { try { s.stop(); } catch {} }
  p.out.disconnect();
  $('ed-play').textContent = '▶ Play';
  draw();
}

function position(p) {
  if (p.startAt === null) return p.from;
  const played = Math.max(0, (p.ctx.currentTime - p.startAt) * doc.rate * p.speed);
  if (p.loop) return p.from + Math.floor(played % Math.max(1, p.to - p.from));
  return Math.min(p.to, Math.round(p.from + played));
}

function tick() {
  const p = playing;
  if (!p) return;
  if (p.endsAt !== null && p.ctx.currentTime >= p.endsAt) { stop(); return; }
  const pos = position(p);
  // Keep the playhead in view: page along with it.
  if ($('ed-follow').checked && (pos < view0 || pos > view1)) {
    const span = view1 - view0;
    view0 = Math.max(0, Math.min(total - span, Math.round(pos - span * 0.05)));
    view1 = view0 + span;
  }
  render(pos);
  requestAnimationFrame(tick);
}

// ------------------------------------------------------ views & moving --

function setCursor(s) {
  selA = selB = Math.round(Math.max(0, Math.min(total, s)));
  if (selA < view0 || selA > view1) {
    const span = view1 - view0;
    view0 = Math.round(Math.max(0, Math.min(total - span, selA - span / 2)));
    view1 = view0 + span;
  }
  draw();
}

// Accepts 1:23:45, 23:45, 95 or 1h 20m.
function parseTime(str) {
  str = str.trim().toLowerCase();
  const hms = str.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:([\d.]+)\s*s?)?$/);
  if (/[hm]/.test(str) && hms) return (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);
  const parts = str.split(':').map(Number);
  if (!parts.length || parts.some((x) => !Number.isFinite(x))) return null;
  return parts.reduce((t, x) => t * 60 + x, 0);
}

function goTo() {
  const s = parseTime($('ed-goto').value);
  if (s === null) return deps.toast('Type a time like 2:15:30 or 45:00.');
  const wasPlaying = !!playing;
  stop();
  setCursor(s * doc.rate);
  if (wasPlaying) play(false);
}

function zoom(factor, centre) {
  const span = view1 - view0;
  const c = centre ?? (hasSel() && selA >= view0 && selB <= view1 ? (selA + selB) / 2 : view0 + span / 2);
  const ns = Math.max(Math.min(total, 64), Math.min(total, span * factor));
  const frac = (c - view0) / span;
  view0 = Math.round(Math.max(0, Math.min(total - ns, c - ns * frac)));
  view1 = Math.round(view0 + ns);
  draw();
}

function zoomToSelection() {
  if (!hasSel()) return needSel();
  const pad = (selB - selA) * 0.05;
  view0 = Math.max(0, Math.round(selA - pad));
  view1 = Math.min(total, Math.round(selB + pad));
  draw();
}

// Main waveform: drag to select, click to place the cursor, Shift-click to
// extend; the wheel moves through the recording, Ctrl/⌘ + wheel zooms.
function setupWave() {
  const cv = $('ed-wave');
  const toSample = (e) => {
    const r = cv.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(total, view0 + ((e.clientX - r.left) / r.width) * (view1 - view0))));
  };
  let anchor = null;
  cv.addEventListener('pointerdown', (e) => {
    if (!doc) return;
    cv.focus({ preventScroll: true });
    cv.setPointerCapture(e.pointerId);
    const s = toSample(e);
    anchor = e.shiftKey ? (Math.abs(s - selA) < Math.abs(s - selB) ? selB : selA) : s;
    if (playing) stop();
    selA = Math.min(anchor, s); selB = Math.max(anchor, s);
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (anchor === null) return;
    const s = toSample(e);
    selA = Math.min(anchor, s); selB = Math.max(anchor, s);
    draw();
  });
  const end = () => { anchor = null; };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('wheel', (e) => {
    if (!doc) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) return zoom(e.deltaY > 0 ? 1.25 : 0.8, toSample(e));
    const span = view1 - view0;
    const d = ((e.deltaX || e.deltaY) / cv.clientWidth) * span;
    view0 = Math.round(Math.max(0, Math.min(total - span, view0 + d)));
    view1 = view0 + span;
    draw();
  }, { passive: false });
}

// Overview: always the whole recording. The box is the part shown above:
// drag it to move through the recording, or click anywhere to jump there.
function setupOverview() {
  const cv = $('ed-overview');
  let grab = null;
  const toSample = (e) => {
    const r = cv.getBoundingClientRect();
    return Math.max(0, Math.min(total, ((e.clientX - r.left) / r.width) * total));
  };
  cv.addEventListener('pointerdown', (e) => {
    if (!doc) return;
    cv.setPointerCapture(e.pointerId);
    const s = toSample(e);
    const span = view1 - view0;
    if (s < view0 || s > view1) {
      view0 = Math.round(Math.max(0, Math.min(total - span, s - span / 2)));
      view1 = view0 + span;
      if (!playing) selA = selB = Math.round(s);
    }
    grab = s - view0;
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (grab === null) return;
    const span = view1 - view0;
    view0 = Math.round(Math.max(0, Math.min(total - span, toSample(e) - grab)));
    view1 = view0 + span;
    draw();
  });
  const end = () => { grab = null; };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

function onKey(e) {
  if (!doc || busy) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  const step = (view1 - view0) / 10;
  const keys = {
    ' ': () => (playing ? stop() : play(false)),
    delete: removeRange, backspace: removeRange,
    arrowleft: () => { stop(); setCursor(selA - step); },
    arrowright: () => { stop(); setCursor(selA + step); },
    home: () => { stop(); setCursor(0); },
    end: () => { stop(); setCursor(total); },
    '+': () => zoom(0.5), '=': () => zoom(0.5), '-': () => zoom(2),
  };
  const modKeys = {
    z: () => (e.shiftKey ? redo() : undo()), y: redo,
    a: () => { selA = 0; selB = total; draw(); },
    c: () => copy(), x: () => { if (copy()) removeRange(); }, v: paste,
  };
  const fn = mod ? modKeys[k] : keys[k];
  if (fn) { e.preventDefault(); fn(); }
}

// ------------------------------------------------------------- drawing --

function colors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { wave: v('--accent'), line: v('--line'), muted: v('--muted'), text: v('--text'), play: v('--rec') };
}

function sizeCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return [w, h, dpr];
}

// Min/max per column for samples [a, b): from stored peaks when zoomed out,
// from the sound itself when zoomed in (loading blocks as needed).
function columns(a, b, cols) {
  const mins = new Float32Array(cols), maxs = new Float32Array(cols);
  const spc = (b - a) / cols;
  const colOf = (t) => Math.max(0, Math.min(cols - 1, Math.floor((t - a) / spc)));
  let missing = false;
  pcm.eachSeg(doc.segs, a, b, (s, t) => {
    const from = Math.max(a, t), to = Math.min(b, t + pcm.segLen(s));
    if (!s.key) return; // silence: leave at zero
    if (spc >= pcm.P1) {
      const bin = spc >= pcm.P2 ? pcm.P2 : pcm.P1;
      const pk = spc >= pcm.P2 ? doc.meta.get(s.key).p2 : doc.meta.get(s.key).p1;
      const o0 = s.start + (from - t), o1 = s.start + (to - t);
      for (let k = Math.floor(o0 / bin); k * bin < o1; k++) {
        const t0 = t + Math.max(k * bin, o0) - s.start, t1 = t + Math.min((k + 1) * bin, o1) - s.start - 1;
        const lo = pk[2 * k] / 32768, hi = pk[2 * k + 1] / 32768;
        for (let c = colOf(t0), ce = colOf(t1); c <= ce; c++) {
          if (lo < mins[c]) mins[c] = lo;
          if (hi > maxs[c]) maxs[c] = hi;
        }
      }
    } else {
      const chs = pcm.cachedBlock(s.key);
      if (!chs) {
        missing = true;
        pcm.loadBlock(s.key).then(draw, () => {});
        return;
      }
      for (const x of chs) {
        for (let tt = from; tt < to; tt++) {
          const v = x[s.start + tt - t] / 32768, c = colOf(tt);
          if (v < mins[c]) mins[c] = v;
          if (v > maxs[c]) maxs[c] = v;
        }
      }
    }
  });
  return { mins, maxs, missing };
}

function drawWave(g, h, p, col) {
  g.fillStyle = col;
  const mid = h / 2;
  for (let i = 0; i < p.mins.length; i++) {
    const y0 = mid - p.maxs[i] * mid * 0.95, y1 = mid - p.mins[i] * mid * 0.95;
    g.fillRect(i, y0, 1, Math.max(1, y1 - y0));
  }
}

function draw() {
  updateTonesTarget();
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; if (!playing) render(); });
}

function render(playPos) {
  if (!doc) return;
  const c = colors(), rate = doc.rate;

  // Main waveform with a time ruler.
  const cv = $('ed-wave'), g = cv.getContext('2d');
  const [w, h, dpr] = sizeCanvas(cv);
  const xOf = (s) => ((s - view0) / (view1 - view0)) * w;
  g.clearRect(0, 0, w, h);
  g.fillStyle = c.line;
  g.fillRect(0, h / 2, w, 1);
  drawWave(g, h, columns(view0, view1, w), c.wave);
  const spanS = (view1 - view0) / rate;
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const step = steps.find((x) => spanS / x <= 10) || 7200;
  g.font = `${11 * dpr}px system-ui, sans-serif`;
  g.textBaseline = 'top';
  g.fillStyle = c.muted;
  for (let t = Math.ceil(view0 / rate / step) * step; t <= view1 / rate; t += step) {
    const x = xOf(t * rate);
    g.fillRect(x, 0, 1, 6 * dpr);
    g.fillText(fmt(t, step < 1), x + 3 * dpr, 2 * dpr);
  }
  if (hasSel()) { g.fillStyle = c.wave + '33'; g.fillRect(xOf(selA), 0, xOf(selB) - xOf(selA), h); }
  // Street noises found: coloured bands (ticked ones stronger).
  if (streetFresh()) {
    for (const ev of streetEvents) {
      if (ev.end < view0 || ev.start > view1) continue;
      const col = STREET_TYPES[ev.type].color;
      g.fillStyle = col + (ev.on ? '30' : '14');
      g.fillRect(xOf(ev.start), 0, Math.max(dpr, xOf(ev.end) - xOf(ev.start)), h);
      g.fillStyle = col;
      g.fillRect(xOf(ev.start), h - 5 * dpr, Math.max(dpr, xOf(ev.end) - xOf(ev.start)), 5 * dpr);
    }
  }
  g.fillStyle = c.text;
  g.fillRect(xOf(selA) - dpr / 2, 0, dpr, h);
  if (hasSel()) g.fillRect(xOf(selB) - dpr / 2, 0, dpr, h);
  if (playPos !== undefined) { g.fillStyle = c.play; g.fillRect(xOf(playPos) - dpr, 0, 2 * dpr, h); }

  // Overview of the whole recording.
  const ov = $('ed-overview'), o = ov.getContext('2d');
  const [ow, oh, odpr] = sizeCanvas(ov);
  if (!overview || overview.mins.length !== ow) overview = columns(0, total, ow);
  const oxOf = (s) => (s / total) * ow;
  o.clearRect(0, 0, ow, oh);
  drawWave(o, oh, overview, c.muted);
  if (streetFresh()) {
    for (const ev of streetEvents) {
      o.fillStyle = STREET_TYPES[ev.type].color;
      o.fillRect((ev.start / total) * ow, 0, Math.max(2 * odpr, ((ev.end - ev.start) / total) * ow), 4 * odpr);
    }
  }
  if (hasSel()) { o.fillStyle = c.wave + '55'; o.fillRect(oxOf(selA), 0, Math.max(odpr, oxOf(selB) - oxOf(selA)), oh); }
  const vx = oxOf(view0), vw = Math.max(6 * odpr, oxOf(view1) - vx);
  o.fillStyle = c.wave + '22';
  o.fillRect(vx, 0, vw, oh);
  o.strokeStyle = c.wave;
  o.lineWidth = 2 * odpr;
  o.strokeRect(vx + odpr, odpr, vw - 2 * odpr, oh - 2 * odpr);
  o.fillStyle = c.play;
  if (playPos !== undefined) o.fillRect(oxOf(playPos) - odpr, 0, 2 * odpr, oh);
  // Hour marks on the overview.
  o.fillStyle = c.muted;
  o.font = `${10 * odpr}px system-ui, sans-serif`;
  o.textBaseline = 'bottom';
  const ostep = steps.find((x) => total / rate / x <= 8) || 7200;
  for (let t = ostep; t < total / rate; t += ostep) {
    const x = oxOf(t * rate);
    o.fillRect(x, oh - 4 * odpr, 1, 4 * odpr);
    o.fillText(fmt(t), x + 2 * odpr, oh - odpr);
  }

  // Scroll bar and readouts.
  const sb = $('ed-scroll');
  const room = total - (view1 - view0);
  sb.disabled = room <= 0;
  sb.value = room > 0 ? Math.round((view0 / room) * 10000) : 0;
  const chName = doc.ch === 1 ? 'mono' : doc.ch === 2 ? 'stereo' : `${doc.ch} channels`;
  $('ed-info').textContent = `${doc.name} · ${fmt(total / rate)} · ${(rate / 1000).toFixed(1)} kHz ${chName}`;
  $('ed-pos').textContent = `${fmt((playPos ?? selA) / rate, true)} / ${fmt(total / rate, true)}`;
  $('ed-sel').textContent = hasSel()
    ? `Selected ${fmt(selA / rate, true)} – ${fmt(selB / rate, true)} (${fmt((selB - selA) / rate, true)})`
    : 'No selection: effects apply to the whole recording';
  $('ed-view').textContent = `Showing ${fmt(view0 / rate)} – ${fmt(view1 / rate)}`;
  $('ed-undo').disabled = !undoStack.length;
  $('ed-redo').disabled = !redoStack.length;
}

function fmt(s, ms) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ss = ms ? sec.toFixed(2).padStart(5, '0') : String(Math.floor(sec)).padStart(2, '0');
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')) + ':' + ss;
}

// -------------------------------------------------------------- export --

function fileName() {
  return ($('ed-name').value.trim() || `${doc.name}-edited`).replace(/[\\/:*?"<>|]+/g, '-');
}

// Fills a <select> with the formats this browser can make.
export async function fillFormats(sel, { video = false } = {}) {
  const ok = await supportedFormats();
  const audio = FORMATS.map((f) => {
    const o = new Option(f.label + (ok[f.id] ? '' : ' — not in this browser'), f.id);
    o.disabled = !ok[f.id];
    return o;
  });
  if (!video) {
    sel.replaceChildren(...audio);
    sel.value = 'mp3';
    return;
  }
  // Screen recordings: video formats first, then sound-only ones.
  const labels = await videoFormatLabels();
  const group = (label, opts) => { const g = document.createElement('optgroup'); g.label = label; g.append(...opts); return g; };
  sel.replaceChildren(
    group('Video', VIDEO_FORMATS.map((f) => new Option(labels[f.id], f.id))),
    group('Sound only', audio),
  );
  sel.value = 'v-mp4';
}

function exportJob(progress) {
  const f = formatById($('ed-format').value);
  return { f, makeParts: () => encode(docSource(doc, total), f.id, { bitrate: +$('ed-bitrate').value, onProgress: progress }) };
}

async function save() {
  stop();
  await job('Saving…', async (progress) => {
    const { f, makeParts } = exportJob(progress);
    try {
      await deps.saveStream({ name: fileName(), ext: f.ext, mime: f.mime, seconds: total / doc.rate, parts: makeParts() });
    } catch (err) {
      deps.toast('Saving failed: ' + err.message, 8000);
    }
  });
}

async function download() {
  stop();
  let progress = () => {};
  const { f, makeParts } = exportJob((x) => progress(x));
  const filename = `${fileName()}.${f.ext}`;
  // The file picker must open straight from the click, so start the job inside.
  await job(`Converting to ${f.label.split(' (')[0]}…`, async (p) => {
    progress = p;
    try {
      if (await downloadParts(makeParts, filename, f.mime)) deps.toast(`Saved ${filename}.`);
    } catch (err) {
      deps.toast('Download failed: ' + err.message, 8000);
    }
  });
}

// ---------------------------------------------------------- audio health --

let lastHealth = null;

async function checkHealth() {
  stop();
  await job('Checking the audio…', async (progress) => {
    try {
      lastHealth = await analyze(doc, progress);
      renderHealth(suggestions(lastHealth, (x) => fmt(x)));
    } catch (err) {
      deps.toast('The check failed: ' + err.message, 7000);
    }
  });
}

export function renderHealthList(box, items, onFix) {
  const icon = { ok: '✓', warn: '⚠', bad: '✕' };
  box.replaceChildren(...items.map((it) => {
    const row = document.createElement('div');
    row.className = `health ${it.level}`;
    row.innerHTML = '<span class="icon"></span><div><b></b><div class="muted"></div></div>';
    row.querySelector('.icon').textContent = icon[it.level];
    row.querySelector('b').textContent = it.title;
    row.querySelector('.muted').textContent = it.detail || '';
    if (it.fix) {
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = it.fix.label;
      b.addEventListener('click', async () => { b.disabled = true; await onFix(it.fix.action); });
      row.appendChild(b);
    }
    return row;
  }));
  const bad = items.filter((i) => i.level !== 'ok').length;
  return bad;
}

function renderHealth(items) {
  const bad = renderHealthList($('ed-health-list'), items, async (action) => {
    if (busy) return;
    await applyFix(action);
    await checkHealth();
  });
  $('ed-health-summary').textContent = bad ? `${bad} thing${bad === 1 ? '' : 's'} to improve` : 'Healthy — nothing to fix.';
  $('ed-health-box').hidden = false;
}

async function applyFix(action) {
  selA = selB = 0; // fixes apply to the whole recording
  const m = lastHealth;
  const all = (label, fn) => rewrite(label, 0, total, async (pos, n) => fn(await pcm.readRange(doc, pos, n)));
  if (action === 'normalize') return normalize();
  if (action === 'denoise') return denoise();
  if (action.startsWith('gain')) {
    const g = Math.pow(10, +action.slice(4) / 20);
    return effect('Volume changed', (x) => { for (let i = 0; i < x.length; i++) x[i] *= g; });
  }
  if (action === 'hum50' || action === 'hum60') {
    const base = +action.slice(3);
    return filterAll(`Removing ${base} Hz hum…`, (oc) => [1, 2, 3, 4].map((k) => {
      const f = oc.createBiquadFilter();
      f.type = 'notch'; f.frequency.value = base * k; f.Q.value = 30;
      return f;
    }));
  }
  if (action === 'highpass') {
    return filterAll('Cutting rumble…', (oc) => [0, 1].map(() => {
      const f = oc.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 80; f.Q.value = 0.707;
      return f;
    }));
  }
  if (action === 'dc') return all('Removing DC offset…', (chs) => { chs.forEach((x, c) => { const d = m.dc[c] || 0; for (let i = 0; i < x.length; i++) x[i] -= d; }); return chs; });
  if (action === 'useL' || action === 'useR') {
    const from = action === 'useL' ? 0 : 1;
    return all('Copying channel…', (chs) => chs.map(() => chs[from].slice()));
  }
  if (action === 'balance') {
    const [l, r] = m.chRmsDb, mid = (l + r) / 2;
    const g = [Math.pow(10, (mid - l) / 20), Math.pow(10, (mid - r) / 20)];
    return all('Balancing…', (chs) => { chs.forEach((x, c) => { const k = g[c] ?? 1; for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i] * k)); }); return chs; });
  }
  if (action === 'invertR') return all('Flipping right side…', (chs) => { if (chs[1]) for (let i = 0; i < chs[1].length; i++) chs[1][i] = -chs[1][i]; return chs; });
  if (action === 'trimEnds') {
    const pad = Math.round(doc.rate * 0.3);
    const a = Math.max(0, m.leadSilence - pad), b = Math.min(total, total - m.tailSilence + pad);
    if (b > a) { view0 = 0; view1 = b - a; setSegs(pcm.extract(doc.segs, a, b), 'Trimmed the silent ends.'); }
  }
}

// Runs the whole recording through Web Audio filters (with some sound before
// each piece so the filters are settled and pieces join seamlessly).
function filterAll(label, build) {
  return filterRange(label, 0, total, build);
}

function filterRange(label, a, b, build) {
  const PRE = Math.round(doc.rate * 1);
  return rewrite(label, a, b, async (pos, n) => {
    const pre = Math.min(PRE, pos);
    const input = await pcm.readRange(doc, pos - pre, n + pre);
    const oc = new OfflineAudioContext(doc.ch, n + pre, doc.rate);
    const b = oc.createBuffer(doc.ch, n + pre, doc.rate);
    input.forEach((x, c) => b.copyToChannel(x, c));
    const src = oc.createBufferSource();
    src.buffer = b;
    let node = src;
    for (const f of build(oc)) { node.connect(f); node = f; }
    node.connect(oc.destination);
    src.start();
    const r = await oc.startRendering();
    return input.map((_, c) => r.getChannelData(c).slice(pre));
  });
}

// ------------------------------------------------------- add frequencies --
//
// Layers of tones (from the named frequencies, the built-in library, binaural
// presets or any Hz) mixed into the selection / whole recording, or inserted
// at the cursor as new audio. A new, silent audio of any length can be made
// to build a frequency track from scratch.

let previewNodes = null;

function layers() {
  const s = deps.settings;
  if (!Array.isArray(s.toneLayers)) s.toneLayers = [];
  s.toneLayers = s.toneLayers.map(normalizeLayer);
  return s.toneLayers;
}
function saveLayers() { deps.saveSettings(); renderLayers(); }

function setupTones() {
  const pick = $('ed-tones-add');
  fillPicker();
  // Refresh before it opens (the named frequencies may have changed).
  pick.addEventListener('pointerenter', fillPicker);
  pick.addEventListener('focus', fillPicker);
  pick.addEventListener('change', () => {
    const v = pick.value;
    pick.value = '';
    if (!v) return;
    const ears = $('ed-tones-ears').value;
    let layer;
    if (v === 'custom') layer = { name: 'Custom tone', ears, hz: 432 };
    else if (v.startsWith('bin:')) { const b = BINAURAL_PRESETS[+v.slice(4)]; layer = { name: b.name, ears: 'split', left: b.left, right: b.right, hz: b.left }; }
    else { const [, f, ...name] = v.split(':'); layer = { name: name.join(':'), ears, hz: +f }; }
    layers().push(normalizeLayer({ id: Math.random().toString(36).slice(2, 9), wave: 'sine', db: -18, ...layer }));
    saveLayers();
  });
  $('ed-new-tones').addEventListener('click', newToneAudio);
  for (const id of ['ed-tones-where', 'ed-tones-original']) $(id).addEventListener('change', updateTonesUi);
  renderLayers();
  updateTonesUi();
}

// The "+ Add a frequency" menu, refreshed each time (named frequencies change).
let pickerKey = null;

function fillPicker() {
  const pick = $('ed-tones-add');
  const key = JSON.stringify(deps.settings.targets.map((t) => [t.name, t.freq]));
  if (key === pickerKey) return; // unchanged: don't rebuild while it's in use
  pickerKey = key;
  const opt = (label, value) => new Option(label, value);
  const group = (label, opts) => { const g = document.createElement('optgroup'); g.label = label; g.append(...opts); return g; };
  const named = deps.settings.targets.filter((t) => t.freq > 0);
  pick.replaceChildren(
    opt('+ Add a frequency…', ''),
    opt('Custom frequency (type any Hz)', 'custom'),
    ...(named.length ? [group('My named frequencies', named.map((t) => opt(`${t.name} — ${hz(t.freq)}`, `f:${t.freq}:${t.name}`)))] : []),
    group('Binaural beats (use headphones)', BINAURAL_PRESETS.map((b, i) => opt(b.name, `bin:${i}`))),
    ...PRESET_LIBRARY.map((cat) => group(cat.category, cat.items.map((it) => opt(`${it.name} — ${hz(it.freq)}`, `f:${it.freq}:${it.name}`)))),
  );
}

const hz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(2)} kHz` : `${+(+f).toFixed(2)} Hz`);

let renderingLayers = false;

function renderLayers() {
  if (renderingLayers) return;
  renderingLayers = true;
  try { drawLayers(); } finally { renderingLayers = false; }
}

function drawLayers() {
  const body = $('ed-tones-body');
  const list = layers();
  // Let a box being edited commit before the rows are rebuilt.
  if (body.contains(document.activeElement)) document.activeElement.blur();
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted">No frequencies yet: choose one from "+ Add a frequency".</td></tr>';
  } else {
    body.replaceChildren(...list.map((l) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><input type="text" data-k="name" aria-label="Name"></td>
        <td><select data-k="ears" aria-label="Ears"></select></td>
        <td class="hz-cell">
          <label class="one"><input type="number" data-k="hz" min="1" max="24000" step="any" class="num"> Hz</label>
          <label class="two">L <input type="number" data-k="left" min="1" max="24000" step="any" class="num"></label>
          <label class="two">R <input type="number" data-k="right" min="1" max="24000" step="any" class="num"></label>
          <div class="muted beat"></div>
        </td>
        <td><select data-k="wave" aria-label="Wave"></select></td>
        <td><input type="number" data-k="db" min="-60" max="0" step="1" class="num" aria-label="Volume dB"></td>
        <td class="row-btns"><button class="small play" data-play title="Hear it (each ear its own frequency — use headphones)">▶</button><button class="small" data-del title="Remove">✕</button></td>`;
      const $k = (k) => tr.querySelector(`[data-k=${k}]`);
      $k('ears').append(...Object.entries(EARS).map(([v, label]) => new Option(label, v)));
      $k('wave').append(...Object.entries(WAVES).map(([v, label]) => new Option(label, v)));
      const split = l.ears === 'split';
      tr.querySelector('.one').hidden = split;
      tr.querySelectorAll('.two').forEach((e) => { e.hidden = !split; });
      for (const k of ['name', 'ears', 'hz', 'left', 'right', 'wave', 'db']) $k(k).value = l[k];
      tr.querySelector('.beat').textContent = describe(l);
      const num = (k, min, max, dflt) => Math.min(max, Math.max(min, +$k(k).value || dflt));
      $k('name').addEventListener('change', () => { l.name = $k('name').value; deps.saveSettings(); });
      $k('ears').addEventListener('change', () => {
        const was = l.ears;
        l.ears = $k('ears').value;
        // Switching to "different in each ear" starts from the current Hz.
        if (l.ears === 'split' && was !== 'split') { l.left = l.hz; l.right = l.hz + 4; }
        if (l.ears !== 'split' && was === 'split') l.hz = l.left;
        saveLayers();
      });
      $k('hz').addEventListener('change', () => { l.hz = num('hz', 1, 24000, 432); saveLayers(); });
      $k('left').addEventListener('change', () => { l.left = num('left', 1, 24000, 432); saveLayers(); });
      $k('right').addEventListener('change', () => { l.right = num('right', 1, 24000, 432); saveLayers(); });
      $k('wave').addEventListener('change', () => { l.wave = $k('wave').value; deps.saveSettings(); });
      $k('db').addEventListener('change', () => { l.db = num('db', -60, 0, -18); saveLayers(); });
      tr.querySelector('[data-play]').addEventListener('click', (e) => {
        const [L] = freqsFor(l, 0, true), [R] = freqsFor(l, 1, true);
        playTone({ left: L || 0, right: R || 0 }, e.currentTarget, { wave: l.wave, db: Math.max(-40, Math.min(-10, l.db)) });
      });
      tr.querySelector('[data-del]').addEventListener('click', () => {
        deps.settings.toneLayers = list.filter((x) => x !== l);
        saveLayers();
      });
      return tr;
    }));
  }
  $('ed-tones-apply').disabled = !list.length;
  $('ed-tones-preview').disabled = !list.length;
  updateTonesTarget();
}

// Says exactly which sound the frequencies will go into.
export function updateTonesTarget() {
  const el = $('ed-tones-target');
  if (!el) return;
  if (!doc) { el.textContent = 'No sound open: import one, pick "Add frequencies" on a saved recording, or start from silence.'; return; }
  const where = $('ed-tones-where').value;
  el.textContent = where === 'insert'
    ? `Into "${doc.name}": new audio inserted at ${fmt(selA / doc.rate)}.`
    : hasSel()
      ? `Into "${doc.name}": the selected part ${fmt(selA / doc.rate)} – ${fmt(selB / doc.rate)}.`
      : `Into "${doc.name}": the whole sound (${fmt(total / doc.rate)}). Drag on the waveform to add them to just one part.`;
}

function updateTonesUi() {
  updateTonesTarget();
  const insert = $('ed-tones-where').value === 'insert';
  $('ed-tones-length-wrap').hidden = !insert;
  $('ed-tones-original-wrap').hidden = insert;
}

async function applyTones() {
  const list = layers();
  if (!list.length) return deps.toast('Add a frequency first.');
  stop();
  if (doc.ch < 2 && list.some((l) => l.ears !== 'both')) {
    deps.toast('This sound is mono (one channel), so left/right choices are mixed into that one channel. Import it without "mono" to place frequencies in each ear.', 8000);
  }
  const fade = Math.round(doc.rate * Math.max(0, +$('ed-tones-fade').value || 0));
  const label = list.length === 1 ? `${list[0].name} (${list[0].ears === 'split' ? `${hz(list[0].left)} / ${hz(list[0].right)}` : hz(list[0].hz)})` : `${list.length} frequencies`;
  if ($('ed-tones-where').value === 'insert') {
    const secs = parseTime($('ed-tones-length').value);
    if (!(secs > 0)) return deps.toast('Type how long to insert, e.g. 30, 5:00 or 1:00:00.');
    const n = Math.round(secs * doc.rate), at = selA;
    let ok = false;
    await job(`Making ${fmt(secs)} of ${label}…`, async (progress) => {
      const writer = new pcm.BlockWriter(doc);
      try {
        for (let done = 0; done < n;) {
          const k = Math.min(WIN, n - done);
          const chs = Array.from({ length: doc.ch }, () => new Float32Array(k));
          writer.push(addTones(chs, list, { rate: doc.rate, at: done, span: n, fade }));
          await writer.drain();
          done += k;
          progress(done / n);
        }
        const segs = await writer.finish();
        selA = at; selB = at + n;
        setSegs(pcm.replace(doc.segs, at, at, segs));
        ok = true;
      } catch (err) {
        deps.toast('Adding frequencies failed: ' + err.message, 8000);
      }
    });
    if (ok) deps.toast(`Inserted ${fmt(secs)} of ${label} at ${fmt(at / doc.rate)}.`);
    return;
  }
  const [a, b] = range();
  const duck = +$('ed-tones-original').value; // dB for the original sound; -99 = remove it
  const g = duck <= -99 ? 0 : Math.pow(10, duck / 20);
  const ok = await rewrite(`Adding ${label}…`, a, b, async (pos, n) => {
    const chs = await pcm.readRange(doc, pos, n);
    if (g !== 1) for (const x of chs) for (let i = 0; i < x.length; i++) x[i] *= g;
    return addTones(chs, list, { rate: doc.rate, at: pos - a, span: b - a, fade });
  });
  if (ok) deps.toast(`Added ${label} to ${hasSel() ? 'the selection' : 'the whole recording'}.`);
}

// Plays the tones alone for 6 seconds (or stops a preview).
async function previewTones() {
  if (previewNodes) { stopPreview(); return; }
  const list = layers();
  if (!list.length) return;
  const { ctx } = await deps.audioGraph();
  const out = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  merger.connect(out).connect(ctx.destination);
  const now = ctx.currentTime, secs = 6;
  out.gain.setValueAtTime(0, now);
  out.gain.linearRampToValueAtTime(1, now + 0.3);
  out.gain.setValueAtTime(1, now + secs - 0.3);
  out.gain.linearRampToValueAtTime(0, now + secs);
  const oscs = [];
  for (const l of list) {
    for (const [ch, f] of [0, 1].flatMap((c) => freqsFor(l, c, true).map((f) => [c, f]))) {
      const o = ctx.createOscillator();
      o.type = l.wave;
      o.frequency.value = f;
      const gn = ctx.createGain();
      gn.gain.value = Math.pow(10, l.db / 20);
      o.connect(gn).connect(merger, 0, ch);
      o.start(now);
      o.stop(now + secs);
      oscs.push(o);
    }
  }
  previewNodes = { oscs, out };
  $('ed-tones-preview').textContent = '■ Stop preview';
  oscs[0].onended = () => { if (previewNodes && previewNodes.oscs === oscs) stopPreview(); };
}

function stopPreview() {
  if (!previewNodes) return;
  previewNodes.oscs.forEach((o) => { try { o.stop(); } catch {} });
  previewNodes.out.disconnect();
  previewNodes = null;
  $('ed-tones-preview').textContent = '▶ Preview (6 s)';
}

// Takes one frequency (and optionally its harmonics) out with narrow notches.
async function removeFrequency() {
  const f = +$('ed-notch-hz').value;
  if (!(f > 0) || f >= doc.rate / 2) return deps.toast('Type the frequency to remove, in Hz.');
  const harmonics = $('ed-notch-harm').checked ? 4 : 1;
  const [a, b] = range();
  const ok = await filterRange(`Removing ${hz(f)}…`, a, b, (oc) => {
    const fs = [];
    for (let k = 1; k <= harmonics && f * k < doc.rate / 2; k++) {
      for (let pass = 0; pass < 2; pass++) { // two notches deep, so it's really gone
        const n = oc.createBiquadFilter();
        n.type = 'notch'; n.frequency.value = f * k; n.Q.value = Math.max(5, (f * k) / 4);
        fs.push(n);
      }
    }
    return fs;
  });
  if (ok) deps.toast(`Removed ${hz(f)}${harmonics > 1 ? ' and its harmonics' : ''} from ${hasSel() ? 'the selection' : 'the whole recording'}.`);
}

// Opens a sound (e.g. a saved recording) with the frequencies panel ready.
export async function openForTones(file, name) {
  await openFile(file, name);
  if (!doc) return;
  $('ed-tones').open = true;
  updateTonesTarget();
  $('ed-tones').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// A new, silent audio to build a frequency track on.
async function newToneAudio() {
  const secs = parseTime($('ed-new-length').value);
  if (!(secs > 0) || secs > 48 * 3600) return deps.toast('Type a length like 10:00 or 1:00:00 (up to 48 hours).');
  if (!(await makeRoom())) return;
  const d = pcm.newDoc('frequencies', 48000, 2);
  d.segs = [pcm.silence(Math.round(secs * 48000))]; // silence takes no space
  await pcm.saveDoc(d);
  show(d);
  $('ed-tones-where').value = 'mix';
  $('ed-tones-original').value = '0';
  updateTonesUi();
  $('ed-tones').open = true;
  deps.toast(`New ${fmt(secs)} audio. Add frequencies below, then press "Add to audio".`, 6000);
  $('ed-tones').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------------------------------------------------------------- speed --

// Slows down / speeds up the selection (or everything). With "keep pitch"
// voices stay natural (time-stretch); without it, it's like a tape played
// faster or slower.
async function changeSpeed(speed) {
  if (!(speed >= 0.25 && speed <= 4)) return deps.toast('Speed must be between 25% and 400%.');
  if (speed === 1) return;
  const keep = $('ed-keep-pitch').checked;
  const [a, b] = range();
  const proc = keep ? new Wsola(doc.ch, doc.rate, speed) : new Resampler(doc.ch, speed);
  const what = speed < 1 ? `Slowing down to ${Math.round(speed * 100)}%` : `Speeding up to ${Math.round(speed * 100)}%`;
  const ok = await transform(`${what}…`, a, b, proc);
  if (ok) deps.toast(`${what.replace('Slowing', 'Slowed').replace('Speeding', 'Sped')} ${keep ? '(same pitch)' : '(pitch changed too)'}.`);
}

// Like rewrite(), but the result may be longer or shorter than [a, b).
async function transform(label, a, b, proc) {
  stop();
  let ok = false;
  const wasSel = hasSel();
  await job(label, async (progress) => {
    const writer = new pcm.BlockWriter(doc);
    try {
      for (let pos = a; pos < b;) {
        const n = Math.min(WIN, b - pos);
        for (const part of proc.push(await pcm.readRange(doc, pos, n))) writer.push(part);
        await writer.drain();
        pos += n;
        progress((pos - a) / (b - a));
        await new Promise((r) => setTimeout(r));
      }
      for (const part of proc.flush()) writer.push(part);
      const segs = await writer.finish();
      setSegs(pcm.replace(doc.segs, a, b, segs));
      const n = pcm.totalLen(segs);
      if (wasSel) { selA = a; selB = a + n; } else { selA = selB = 0; }
      view0 = 0; view1 = total;
      draw();
      ok = true;
    } catch (err) {
      deps.toast(`${label.replace('…', '')} failed: ${err.message}`, 8000);
    }
  });
  return ok;
}

// --------------------------------------------------------- street noise --

let streetEvents = [];
let streetFor = null;     // the segments the events were found in
let streetRumble = false;

const streetFresh = () => streetEvents.length && doc && streetFor === doc.segs;

async function findStreet() {
  stop();
  await job('Listening for street noises…', async (progress) => {
    try {
      const r = await findStreetNoise(doc, { sensitivity: +$('ed-street-sens').value, onProgress: progress });
      streetEvents = r.events.map((e) => ({ ...e, on: e.conf >= 0.35 }));
      streetFor = doc.segs;
      streetRumble = r.backgroundRumble;
      renderStreet();
      draw();
    } catch (err) {
      deps.toast('Searching failed: ' + err.message, 7000);
    }
  });
}

function renderStreet() {
  const box = $('ed-street-list');
  const fresh = streetFresh();
  const counts = {};
  for (const e of streetEvents) counts[e.type] = (counts[e.type] || 0) + 1;
  const summary = streetEvents.length
    ? `Found ${streetEvents.length}: ` + Object.entries(counts).map(([t, n]) => `${n} ${STREET_TYPES[t].label.toLowerCase()}${n > 1 ? 's' : ''}`).join(', ')
    : streetFor ? 'No street noises found.' : '';
  $('ed-street-summary').textContent = fresh || !streetEvents.length ? summary : 'The audio changed since the search; press "Find street noises" again.';
  const rows = [];
  if (streetRumble && streetFor) {
    const row = document.createElement('div');
    row.className = 'health warn';
    row.innerHTML = '<span class="icon">⚠</span><div><b>Constant traffic rumble in the background</b><div class="muted">Deep traffic noise runs through most of the recording. A low cut removes it without touching voices; Remove noise takes care of the rest of the hiss.</div></div><span class="row"><button class="small" data-a="highpass">Cut rumble</button><button class="small" data-a="denoise">Remove noise</button></span>';
    for (const b of row.querySelectorAll('button')) b.addEventListener('click', async () => { if (!busy) { await applyFix(b.dataset.a); streetFor = null; renderStreet(); } });
    rows.push(row);
  }
  if (fresh) {
    for (const ev of streetEvents) {
      const t = STREET_TYPES[ev.type];
      const row = document.createElement('div');
      row.className = 'street-row';
      row.innerHTML = `<input type="checkbox" aria-label="Remove this one">
        <span class="swatch" style="background:${t.color}"></span>
        <span class="street-name"></span>
        <span class="muted street-time"></span>
        <span class="muted street-conf"></span>
        <span class="street-btns"><button class="small" data-play title="Listen (with a bit before and after)">▶</button><button class="small" data-sel>Select</button></span>`;
      const cb = row.querySelector('input');
      cb.checked = ev.on;
      cb.addEventListener('change', () => { ev.on = cb.checked; updateStreetButton(); draw(); });
      row.querySelector('.street-name').textContent = `${t.icon} ${t.label}${ev.freq ? ` (${hz(ev.freq)})` : ''}`;
      row.querySelector('.street-time').textContent = `${fmt(ev.start / doc.rate, true)} – ${fmt(ev.end / doc.rate, true)} (${((ev.end - ev.start) / doc.rate).toFixed(1)} s)`;
      row.querySelector('.street-conf').textContent = ev.conf >= 0.7 ? 'very likely' : ev.conf >= 0.35 ? 'likely' : 'maybe';
      row.querySelector('[data-play]').addEventListener('click', () => {
        if (busy) return;
        const pad = doc.rate * 0.7;
        selA = Math.max(0, Math.round(ev.start - pad)); selB = Math.min(total, Math.round(ev.end + pad));
        zoomToSelection();
        play(true);
      });
      row.querySelector('[data-sel]').addEventListener('click', () => { selA = ev.start; selB = ev.end; zoomToSelection(); });
      rows.push(row);
    }
  }
  box.replaceChildren(...rows);
  $('ed-street-actions').hidden = !fresh;
  updateStreetButton();
}

function updateStreetButton() {
  const n = streetEvents.filter((e) => e.on).length;
  $('ed-street-apply').textContent = `Remove ticked (${n})`;
  $('ed-street-apply').disabled = !n;
}

// Joins overlapping ranges (keeping all their kinds and pitches).
function unionRanges(evs) {
  const out = [];
  for (const e of [...evs].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && e.start <= last.end + doc.rate * 0.03) { last.end = Math.max(last.end, e.end); last.evs.push(e); }
    else out.push({ start: e.start, end: e.end, evs: [e] });
  }
  return out;
}

async function applyStreet() {
  if (!streetFresh()) return deps.toast('Press "Find street noises" first.');
  const ranges = unionRanges(streetEvents.filter((e) => e.on));
  if (!ranges.length) return;
  const mode = $('ed-street-action').value;
  stop();
  let ok = false;
  await job('Removing street noises…', async (progress) => {
    try {
      let segs = doc.segs;
      const rate = doc.rate;
      // Work from the end so earlier positions stay valid.
      const desc = [...ranges].reverse();
      for (let i = 0; i < desc.length; i++) {
        const r = desc[i];
        if (mode === 'cut') {
          // Cut it out, crossfading the two sides over 10 ms (no click).
          const X = Math.min(Math.round(rate * 0.01), r.start, total - r.end);
          if (X > 0) {
            const A = await pcm.readRange(doc, r.start - X, X), B = await pcm.readRange(doc, r.end, X);
            const mixed = A.map((a, c) => a.map((v, k) => v * (1 - k / X) + B[c][k] * (k / X)));
            const w = new pcm.BlockWriter(doc);
            w.push(mixed);
            segs = pcm.replace(segs, r.start - X, r.end + X, await w.finish());
          } else segs = pcm.replace(segs, r.start, r.end, []);
        } else {
          // For horns and squeals, find their exact tones (two-tone horns
          // have two notes) so the filter can take all of them out.
          if (mode === 'filter' && r.evs.some((e) => e.type === 'horn' || e.type === 'squeal')) {
            const n = Math.min(r.end - r.start, rate * 3);
            r.tones = tonalPeaks(await pcm.readRange(doc, r.start, n), rate);
          }
          const w = new pcm.BlockWriter(doc);
          for (let pos = r.start; pos < r.end;) {
            const n = Math.min(WIN, r.end - pos);
            w.push(await streetPiece(r, pos, n, mode));
            await w.drain();
            pos += n;
          }
          segs = pcm.replace(segs, r.start, r.end, await w.finish());
        }
        progress((i + 1) / desc.length);
      }
      const removed = ranges.reduce((n, r) => n + r.end - r.start, 0);
      selA = selB = Math.min(selA, total);
      setSegs(segs);
      streetEvents = streetEvents.filter((e) => !e.on);
      streetFor = null;
      renderStreet();
      ok = { n: ranges.length, secs: removed / rate };
    } catch (err) {
      deps.toast('Removing failed: ' + err.message, 8000);
    }
  });
  if (ok) {
    const how = { cut: 'Cut out', filter: 'Filtered out', duck: 'Turned down', silence: 'Silenced' }[mode];
    deps.toast(`${how} ${ok.n} street noise${ok.n === 1 ? '' : 's'} (${ok.secs.toFixed(1)} s). Undo brings them back.`, 6000);
  }
}

// One piece of a range with the noise turned down, silenced or filtered;
// 40 ms ramps at the edges so nothing clicks.
async function streetPiece(r, pos, n, mode) {
  const rate = doc.rate, R = Math.round(rate * 0.04);
  const ramp = (k) => Math.min(1, (k - r.start) / R, (r.end - k) / R);
  const types = new Set(r.evs.map((e) => e.type));
  const canFilter = mode === 'filter' && ![...types].some((t) => t === 'siren' || t === 'bang');
  if (!canFilter) {
    // Silence, or turn down 20 dB (also used for sirens and bangs, which move
    // too much to filter cleanly).
    const G = mode === 'silence' ? 0 : 0.1;
    const chs = await pcm.readRange(doc, pos, n);
    for (const x of chs) for (let i = 0; i < n; i++) { const w = ramp(pos + i); x[i] *= 1 - (1 - G) * Math.max(0, w); }
    return chs;
  }
  // Filter: high-pass for engines/rumble; notches at the horn/squeal pitch
  // and its harmonics. Rendered with a second of sound before it so the
  // filters are settled.
  const pre = Math.min(rate, pos);
  const input = await pcm.readRange(doc, pos - pre, n + pre);
  const oc = new OfflineAudioContext(doc.ch, n + pre, rate);
  const b = oc.createBuffer(doc.ch, n + pre, rate);
  input.forEach((x, c) => b.copyToChannel(x, c));
  const src = oc.createBufferSource();
  src.buffer = b;
  let node = src;
  const add = (type, f, q) => { const bq = oc.createBiquadFilter(); bq.type = type; bq.frequency.value = f; bq.Q.value = q; node.connect(bq); node = bq; };
  if (types.has('vehicle')) for (let k = 0; k < 3; k++) add('highpass', 180, 0.707);
  const tones = r.tones && r.tones.length ? r.tones : r.evs.filter((e) => e.freq).map((e) => e.freq);
  for (const f of tones) {
    for (let k = 1; k <= 6 && f * k < rate / 2; k++) { add('notch', f * k, 15); add('notch', f * k, 15); }
  }
  node.connect(oc.destination);
  src.start();
  const out = await oc.startRendering();
  return input.map((x, c) => {
    const f = out.getChannelData(c);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) { const w = Math.max(0, ramp(pos + i)); y[i] = x[pre + i] * (1 - w) + f[pre + i] * w; }
    return y;
  });
}

// The sound open in the editor, for the video editor to use as a video's sound.
export function editorAudio() {
  if (!doc) return null;
  const d = doc;
  return { name: d.name, rate: d.rate, ch: d.ch, total, read: (pos, n) => pcm.readRange(d, pos, n) };
}

// Exposed for automated tests.
export const editorState = {
  get doc() { return doc; }, get total() { return total; }, get busy() { return busy; }, get playing() { return !!playing; },
  get sel() { return [selA, selB]; }, set sel([a, b]) { selA = a; selB = b; draw(); },
  get view() { return [view0, view1]; },
};
