// Video editor for screen recordings: see the whole video, cut parts out or
// keep only a part, change or replace the sound, then save or download the
// edited copy (MP4 or WebM). The original recording is never changed.

import { exportEdited, videoFormatLabels, VIDEO_FORMATS } from './video.js';
import { downloadParts } from './export.js';

const $ = (id) => document.getElementById(id);

let deps = null;     // from app.js
let blob = null;     // the video being edited
let url = null;
let name = 'video';
let duration = 0;    // seconds
let removed = [];    // [[a, b], …] seconds, sorted, not overlapping
let undoStack = [];
let selA = 0, selB = 0;
let thumbs = null;   // canvas with the thumbnail strip
let busy = false;

export function initVideoEditor(d) {
  deps = d;
  const file = $('ve-file');
  file.addEventListener('change', () => { if (file.files[0]) openVideo(file.files[0], file.files[0].name.replace(/\.[^.]+$/, '')); file.value = ''; });
  const v = $('ve-video');
  v.addEventListener('timeupdate', skipRemoved);
  v.addEventListener('play', () => { $('ve-play').textContent = '❚❚ Pause'; tick(); });
  v.addEventListener('pause', () => { $('ve-play').textContent = '▶ Play'; draw(); });
  const act = {
    've-play': () => (v.paused ? playFromHere() : v.pause()),
    've-back': () => seek(v.currentTime - 5),
    've-fwd': () => seek(v.currentTime + 5),
    've-in': () => { selA = v.currentTime; if (selB < selA) selB = Math.min(duration, selA + 1); draw(); },
    've-out': () => { selB = v.currentTime; if (selB < selA) selA = Math.max(0, selB - 1); draw(); },
    've-cut': cutSelection,
    've-keep': keepSelection,
    've-undo': () => { if (undoStack.length) { removed = undoStack.pop(); draw(); } },
    've-reset': () => { if (removed.length) { undoStack.push(removed); removed = []; draw(); } },
    've-play-sel': () => { if (selB > selA) { seek(selA); v.play(); } },
    've-save': () => exportVideo(true),
    've-download': () => exportVideo(false),
    've-edit-sound': () => deps.editSound(blob, `${name}-sound`),
    've-close': close,
  };
  for (const [id, fn] of Object.entries(act)) $(id).addEventListener('click', () => { if (blob && !busy) fn(); });
  setupTimeline();
  videoFormatLabels().then((labels) => {
    $('ve-format').replaceChildren(...VIDEO_FORMATS.map((f) => new Option(labels[f.id], f.id)));
  });
  $('ve-sound').addEventListener('change', soundUi);
  window.addEventListener('resize', () => { thumbs = null; makeThumbs(); });
}

// ------------------------------------------------------------- open/close --

export async function openVideo(b, baseName) {
  if (busy) return;
  close();
  blob = b;
  name = baseName || 'video';
  url = URL.createObjectURL(blob);
  removed = []; undoStack = []; selA = selB = 0;
  $('ve-body').hidden = false;
  $('ve-name').value = `${name}-edited`;
  const v = $('ve-video');
  v.src = url;
  duration = await fullDuration(v);
  if (!(duration > 0)) {
    deps.toast("Couldn't read this video's length; it may not play in this browser.", 7000);
    duration = 0;
  }
  v.currentTime = 0;
  thumbs = null;
  draw();
  makeThumbs();
  soundUi();
  $('video-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function close() {
  const v = $('ve-video');
  v.pause();
  v.removeAttribute('src');
  v.load();
  if (url) URL.revokeObjectURL(url);
  url = null; blob = null; duration = 0;
  $('ve-body').hidden = true;
}

// Recordings straight from the browser don't store their length; seeking
// far past the end makes the browser work it out.
function fullDuration(v) {
  return new Promise((resolve) => {
    const done = () => resolve(Number.isFinite(v.duration) ? v.duration : 0);
    const timer = setTimeout(done, 15000);
    v.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(v.duration)) { clearTimeout(timer); return done(); }
      const onChange = () => {
        if (!Number.isFinite(v.duration)) return;
        v.removeEventListener('durationchange', onChange);
        clearTimeout(timer);
        done();
      };
      v.addEventListener('durationchange', onChange);
      v.currentTime = 1e101;
    }, { once: true });
    v.addEventListener('error', () => { clearTimeout(timer); resolve(0); }, { once: true });
  });
}

// ---------------------------------------------------------------- editing --

const kept = () => {
  const out = [];
  let t = 0;
  for (const [a, b] of removed) { if (a > t) out.push([t, a]); t = Math.max(t, b); }
  if (t < duration) out.push([t, duration]);
  return out.filter(([a, b]) => b - a > 0.01);
};
const keptLength = () => kept().reduce((n, [a, b]) => n + b - a, 0);

function addRemoved(a, b) {
  const list = [...removed, [Math.max(0, a), Math.min(duration, b)]].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 0.001) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

function cutSelection() {
  if (!(selB - selA > 0.05)) return deps.toast('Select a part first: drag on the timeline, or use Mark start / Mark end.');
  const before = keptLength();
  const next = addRemoved(selA, selB);
  if (lengthWith(next) < 0.1) return deps.toast("That would cut everything — use Close instead.");
  undoStack.push(removed);
  removed = next;
  selB = selA;
  draw();
  deps.toast(`Cut out ${fmt(before - keptLength())}. The edited video is now ${fmt(keptLength())} long.`);
}

function lengthWith(r) { const save = removed; removed = r; const n = keptLength(); removed = save; return n; }

function keepSelection() {
  if (!(selB - selA > 0.05)) return deps.toast('Select the part to keep first: drag on the timeline.');
  undoStack.push(removed);
  removed = addRemoved(0, selA);
  removed = addRemoved(selB, duration);
  draw();
  deps.toast(`Keeping ${fmt(selA)} – ${fmt(selB)} only.`);
}

// Preview plays the edited version: cut parts are skipped.
function skipRemoved() {
  const v = $('ve-video');
  const r = removed.find(([a, b]) => v.currentTime >= a && v.currentTime < b - 0.05);
  if (r) {
    if (r[1] >= duration - 0.05) v.pause();
    else v.currentTime = r[1];
  }
}

function playFromHere() {
  const v = $('ve-video');
  skipRemoved();
  v.play().catch(() => {});
}

function seek(t) {
  const v = $('ve-video');
  v.currentTime = Math.max(0, Math.min(duration, t));
  draw();
}

function tick() {
  const v = $('ve-video');
  skipRemoved();
  draw();
  if (!v.paused) requestAnimationFrame(tick);
}

// --------------------------------------------------------------- timeline --

// The timeline always shows the whole video: drag to select a part, click to
// jump there.
function setupTimeline() {
  const cv = $('ve-timeline');
  const toT = (e) => { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration)); };
  let anchor = null, moved = false;
  cv.addEventListener('pointerdown', (e) => {
    if (!blob || !duration) return;
    cv.setPointerCapture(e.pointerId);
    anchor = toT(e); moved = false;
    selA = selB = anchor;
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (anchor === null) return;
    const t = toT(e);
    if (Math.abs(t - anchor) > duration / 500) moved = true;
    selA = Math.min(anchor, t); selB = Math.max(anchor, t);
    draw();
  });
  const end = (e) => {
    if (anchor === null) return;
    if (!moved) { seek(anchor); selA = selB = 0; }
    anchor = null;
    draw();
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

// A strip of small pictures across the whole video (made with a second,
// hidden player so the main one isn't disturbed).
async function makeThumbs() {
  if (!blob || !duration) return;
  const mine = blob;
  const cv = $('ve-timeline');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  const strip = document.createElement('canvas');
  strip.width = w; strip.height = h;
  const g = strip.getContext('2d');
  thumbs = strip;
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = url;
  const real = await fullDuration(v);
  if (!real) return;
  const tw = Math.max(40, Math.round(h * ((v.videoWidth || 16) / (v.videoHeight || 9))));
  const n = Math.max(1, Math.ceil(w / tw));
  for (let i = 0; i < n; i++) {
    if (blob !== mine || thumbs !== strip) return; // something else opened
    await new Promise((res) => { const t = setTimeout(res, 3000); v.addEventListener('seeked', () => { clearTimeout(t); res(); }, { once: true }); v.currentTime = Math.min(real - 0.05, ((i + 0.5) / n) * real); });
    try { g.drawImage(v, i * tw, 0, tw, h); } catch {}
    draw();
  }
  v.removeAttribute('src'); v.load();
}

function draw() {
  if (!blob) return;
  const cv = $('ve-timeline');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  const cs = getComputedStyle(document.documentElement);
  const col = (n) => cs.getPropertyValue(n).trim();
  g.fillStyle = '#111';
  g.fillRect(0, 0, w, h);
  if (thumbs) g.drawImage(thumbs, 0, 0, w, h);
  const x = (t) => (duration ? (t / duration) * w : 0);
  // Cut parts: dark and crossed out.
  for (const [a, b] of removed) {
    g.fillStyle = 'rgba(0,0,0,0.72)';
    g.fillRect(x(a), 0, x(b) - x(a), h);
    g.strokeStyle = col('--rec');
    g.lineWidth = 2 * dpr;
    g.beginPath(); g.moveTo(x(a), 0); g.lineTo(x(b), h); g.moveTo(x(a), h); g.lineTo(x(b), 0); g.stroke();
  }
  if (selB > selA) {
    g.fillStyle = col('--accent') + '55';
    g.fillRect(x(selA), 0, x(selB) - x(selA), h);
    g.strokeStyle = col('--accent');
    g.lineWidth = 2 * dpr;
    g.strokeRect(x(selA), dpr, x(selB) - x(selA), h - 2 * dpr);
  }
  // Time marks.
  g.font = `${10 * dpr}px system-ui, sans-serif`;
  g.fillStyle = '#fff';
  g.textBaseline = 'bottom';
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const step = steps.find((s) => duration / s <= 10) || 7200;
  for (let t = step; t < duration; t += step) { g.fillRect(x(t), h - 6 * dpr, 1, 6 * dpr); g.fillText(fmt(t), x(t) + 2 * dpr, h - dpr); }
  // Playhead.
  const v = $('ve-video');
  g.fillStyle = col('--rec');
  g.fillRect(x(v.currentTime) - dpr, 0, 2 * dpr, h);

  $('ve-time').textContent = `${fmt(v.currentTime, true)} / ${fmt(duration, true)}`;
  $('ve-sel').textContent = selB > selA ? `Selected ${fmt(selA, true)} – ${fmt(selB, true)} (${fmt(selB - selA, true)})` : 'Drag on the timeline to select a part';
  $('ve-length').textContent = removed.length ? `Edited length ${fmt(keptLength())} (${removed.length} cut${removed.length === 1 ? '' : 's'})` : `Length ${fmt(duration)}`;
  $('ve-undo').disabled = !undoStack.length;
}

function fmt(s, ms) {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ss = ms ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0');
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')) + ':' + ss;
}

// ------------------------------------------------------------------ sound --

function soundUi() {
  const mode = $('ve-sound').value;
  $('ve-gain-wrap').hidden = mode === 'mute';
  const src = deps.editorAudio();
  const note = $('ve-sound-note');
  if (mode === 'editor') {
    if (!src) note.textContent = 'Nothing is open in the audio editor (section 6). Press "Edit this video\'s sound" first.';
    else {
      const diff = Math.abs(src.total / src.rate - duration);
      note.textContent = `Using "${src.name}" from the audio editor (${fmt(src.total / src.rate)}).` + (diff > 0.5 ? ` ⚠ It's ${fmt(diff)} ${src.total / src.rate > duration ? 'longer' : 'shorter'} than the video, so sound and picture will drift apart; avoid cutting or changing speed in the audio editor (use this video editor's cuts instead).` : ' Cuts made here apply to it too.');
    }
  } else note.textContent = '';
}

// ----------------------------------------------------------------- export --

async function exportVideo(save) {
  const mode = $('ve-sound').value;
  let source = null;
  if (mode === 'editor') {
    source = deps.editorAudio();
    if (!source) return deps.toast('Open the sound in the audio editor first ("Edit this video\'s sound").');
  }
  const f = VIDEO_FORMATS.find((x) => x.id === $('ve-format').value) || VIDEO_FORMATS[0];
  const file = ($('ve-name').value.trim() || `${name}-edited`).replace(/[\\/:*?"<>|]+/g, '-');
  const opts = {
    keep: removed.length ? kept() : null,
    duration,
    sound: { mode: mode === 'mute' ? 'mute' : 'keep', gainDb: +$('ve-gain').value || 0, source },
    onProgress: (x) => { $('ve-progress').value = x; },
  };
  $('ve-video').pause();
  busy = true;
  document.body.classList.add('ve-busy');
  $('ve-job').hidden = false;
  $('ve-progress').value = 0;
  try {
    const make = () => exportEdited(blob, f.ext, opts);
    if (save) {
      await deps.saveStream({ name: file, ext: f.ext, mime: f.mime, seconds: keptLength(), parts: make(), video: true });
    } else if (await downloadParts(make, `${file}.${f.ext}`, f.mime)) deps.toast(`Saved ${file}.${f.ext}.`);
  } catch (err) {
    deps.toast('Saving the video failed: ' + err.message, 9000);
  } finally {
    busy = false;
    document.body.classList.remove('ve-busy');
    $('ve-job').hidden = true;
  }
}

// For tests.
export const videoEditorState = {
  get duration() { return duration; }, get removed() { return removed; }, get busy() { return busy; },
  set sel([a, b]) { selA = a; selB = b; draw(); }, get kept() { return kept(); },
};
