import { PRESET_LIBRARY, NOTE_NAMES, noteToFreq, freqToNote } from './presets.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['#ff6b6b', '#4dabf7', '#ffd43b', '#69db7c', '#da77f2', '#ff922b', '#38d9a9', '#f783ac'];
const STORE_KEY = 'freq-recorder.v1';

// ---------------------------------------------------------------- settings --

const defaults = {
  targets: [{ id: uid(), name: 'Censor bleep', freq: 1000, tolerance: 15, mute: false }],
  threshold: 0.25,
  minDb: -55,
  holdMs: 250,
  dnStrength: 1.5,
  dnFloorDb: -24,
};
const settings = loadSettings();

function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && Array.isArray(saved.targets)) return { ...defaults, ...saved };
  } catch {}
  return structuredClone(defaults);
}
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch {}
}
function colorFor(target) {
  return COLORS[settings.targets.indexOf(target) % COLORS.length];
}

// ----------------------------------------------------------- audio graph --

let ctx = null;
let nodes = null;          // shared processing nodes, created once
let display = null;        // { stream, source, video }
let mic = null;            // { stream, source }
let tones = null;          // { stop() }
const detected = new Map(); // target id -> { start }
let lastStatus = { db: -Infinity, targets: [] };

async function ensureAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') await ctx.resume();
    return;
  }
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await Promise.all([
    ctx.audioWorklet.addModule('freq-guard-worklet.js'),
    ctx.audioWorklet.addModule('denoise-worklet.js'),
  ]);

  const opts = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] };
  const intIn = ctx.createGain();      // internal audio (screen share + test tones)
  const micIn = ctx.createGain();      // microphone
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.Q.value = 0.707;
  const dnInt = new AudioWorkletNode(ctx, 'denoise', opts);
  const dnMic = new AudioWorkletNode(ctx, 'denoise', opts);
  const mix = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0.6;
  const guard = new AudioWorkletNode(ctx, 'freq-guard', opts);
  const recDest = ctx.createMediaStreamDestination();
  const monitor = ctx.createGain();
  monitor.gain.value = 0;

  intIn.connect(dnInt).connect(mix);
  micIn.connect(highpass).connect(dnMic).connect(mix);
  mix.connect(analyser);
  mix.connect(guard);
  guard.connect(recDest);
  // Always connected to the speakers (at zero gain unless monitoring) so the
  // graph keeps rendering and the guard keeps sending ticks.
  guard.connect(monitor).connect(ctx.destination);

  guard.port.onmessage = (e) => {
    if (e.data.type === 'tick') onTick();
    else if (e.data.type === 'status') onStatus(e.data);
  };
  for (const dn of [dnInt, dnMic]) {
    dn.port.onmessage = (e) => {
      if (e.data.type === 'learned') {
        $('dn-mode').textContent = 'Mode: learned noise profile';
        $('btn-learn').disabled = false;
        $('btn-forget').disabled = false;
        toast('Noise profile learned.');
      }
    };
  }

  nodes = { intIn, micIn, highpass, dnInt, dnMic, mix, analyser, guard, recDest, monitor };
  sendGuardConfig();
  sendDenoiseConfig();
  applyMonitor();
}

function sendGuardConfig() {
  if (!nodes) return;
  nodes.guard.port.postMessage({
    threshold: settings.threshold,
    minDb: settings.minDb,
    holdMs: settings.holdMs,
    targets: settings.targets
      .filter((t) => t.freq > 0)
      .map(({ id, freq, tolerance, mute }) => ({ id, freq, tolerance: Math.max(0, tolerance || 0), mute })),
  });
}

function sendDenoiseConfig() {
  if (!nodes) return;
  const floor = Math.pow(10, settings.dnFloorDb / 20);
  nodes.dnInt.port.postMessage({ enabled: $('opt-dn-int').checked, strength: settings.dnStrength, floor });
  nodes.dnMic.port.postMessage({ enabled: $('opt-dn-mic').checked, strength: settings.dnStrength, floor });
  nodes.highpass.frequency.value = $('opt-hp').checked ? 80 : 1;
}

function applyMonitor() {
  if (nodes) nodes.monitor.gain.value = $('opt-monitor').checked ? 1 : 0;
}

// --------------------------------------------------------------- sources --

async function startScreen() {
  try {
    await ensureAudio();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
      systemAudio: 'include',
      surfaceSwitching: 'include',
    });
    stopScreen();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    // Kept in the DOM (but invisible) so browsers keep decoding frames.
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0';
    document.body.appendChild(video);
    await video.play().catch(() => {});

    let source = null;
    if (stream.getAudioTracks().length) {
      source = ctx.createMediaStreamSource(stream);
      source.connect(nodes.intIn);
    } else {
      toast('No audio was shared. Share again and turn on "Share audio" to capture internal sound.', 7000);
    }
    display = { stream, source, video };
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (recorder && recorder.usesDisplayTrack) stopRecording();
      stopScreen();
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast('Screen capture failed: ' + err.message, 6000);
  }
  updateSources();
}

function stopScreen() {
  if (!display) return;
  display.stream.getTracks().forEach((t) => t.stop());
  display.source && display.source.disconnect();
  display.video.remove();
  display = null;
  updateSources();
}

function micConstraints() {
  const ns = $('opt-browser-ns').checked;
  return { echoCancellation: ns, noiseSuppression: ns, autoGainControl: false };
}

async function startMic() {
  try {
    await ensureAudio();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
    stopMic();
    const source = ctx.createMediaStreamSource(stream);
    source.connect(nodes.micIn);
    mic = { stream, source };
  } catch (err) {
    toast('Microphone failed: ' + err.message, 6000);
  }
  updateSources();
}

function stopMic() {
  if (!mic) return;
  mic.stream.getTracks().forEach((t) => t.stop());
  mic.source.disconnect();
  mic = null;
  updateSources();
}

// Demo signal: background hiss plus beeps at each named frequency in turn, so
// you can try detection and noise removal without sharing anything.
async function startTones() {
  await ensureAudio();
  if (tones) return;
  const out = ctx.createGain();
  out.connect(nodes.intIn);

  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.03;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;
  noise.loop = true;
  noise.connect(out);
  noise.start();

  let i = 0;
  let osc = null;
  const beep = () => {
    const list = settings.targets.filter((t) => t.freq > 0 && t.freq < ctx.sampleRate / 2);
    if (!list.length) return;
    const t = list[i++ % list.length];
    osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = t.freq;
    const now = ctx.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.25, now + 0.02);
    g.gain.setValueAtTime(0.25, now + 1.0);
    g.gain.linearRampToValueAtTime(0, now + 1.05);
    osc.connect(g).connect(out);
    osc.start(now);
    osc.stop(now + 1.1);
  };
  beep();
  const timer = setInterval(beep, 2000);
  tones = {
    stop() {
      clearInterval(timer);
      noise.stop();
      osc && osc.stop();
      out.disconnect();
    },
  };
  updateSources();
}

function stopTones() {
  if (!tones) return;
  tones.stop();
  tones = null;
  updateSources();
}

function stopAll() {
  if (recorder) stopRecording();
  stopScreen();
  stopMic();
  stopTones();
}

function updateSources() {
  const parts = [];
  if (display) parts.push(display.source ? 'Screen + internal audio' : 'Screen (no audio)');
  if (mic) parts.push('Microphone');
  if (tones) parts.push('Test tones');
  $('sources').textContent = parts.length ? 'Live: ' + parts.join(' · ') : 'No sources yet.';
  $('btn-release').disabled = !parts.length;
  $('btn-mic').textContent = mic ? 'Remove microphone' : 'Add microphone (external audio)';
  $('btn-test').textContent = tones ? 'Stop test tones' : 'Play test tones';
  $('btn-record').disabled = !parts.length || !!recorder;
}

// ------------------------------------------------------------- detection --

function onStatus(msg) {
  lastStatus = msg;
  const now = performance.now();
  for (const r of msg.targets) {
    const target = settings.targets.find((t) => t.id === r.id);
    if (!target) continue;
    const open = detected.get(r.id);
    if (r.detected && !open) {
      const entry = { id: r.id, name: target.name, freq: target.freq, start: now, end: null };
      log.push(entry);
      detected.set(r.id, entry);
      renderLog();
    } else if (!r.detected && open) {
      // The guard keeps reporting a tone for holdMs after it stops; take that off.
      open.end = Math.max(open.start, now - settings.holdMs);
      detected.delete(r.id);
      renderLog();
    }
  }
  if (msg.changed) renderNow();
}

function currentNames() {
  return settings.targets.filter((t) => detected.has(t.id));
}

function renderNow() {
  const names = currentNames();
  const el = $('now-names');
  el.classList.toggle('none', !names.length);
  el.textContent = names.length ? names.map((t) => t.name).join(' · ') : '—';
  for (const row of document.querySelectorAll('#targets-body tr')) {
    row.classList.toggle('active', detected.has(row.dataset.id));
  }
}

// ---------------------------------------------------------- drawing/tick --

const preview = $('preview');
const pctx = preview.getContext('2d');
const spectrum = $('spectrum');
const sctx = spectrum.getContext('2d');
let freqData = null;
let peak = null;

function onTick() {
  readSpectrum();
  drawPreview();
  drawSpectrum();
  if (recorder) $('rec-time').textContent = fmtTime((performance.now() - recorder.startedAt) / 1000);
}

function readSpectrum() {
  const an = nodes.analyser;
  if (!freqData) freqData = new Float32Array(an.frequencyBinCount);
  an.getFloatFrequencyData(freqData);
  const binHz = ctx.sampleRate / an.fftSize;
  let best = 3;
  for (let i = 4; i < freqData.length - 1; i++) if (freqData[i] > freqData[best]) best = i;
  if (freqData[best] > -85) {
    // Parabolic interpolation for a sub-bin estimate.
    const a = freqData[best - 1], b = freqData[best], c = freqData[best + 1];
    const shift = (a - c) / (2 * (a - 2 * b + c)) || 0;
    peak = (best + shift) * binHz;
  } else peak = null;

  if (peak) {
    const note = freqToNote(peak);
    $('now-peak').textContent = `${fmtHz(peak)} · ${note.name}${note.cents ? ` ${note.cents > 0 ? '+' : ''}${note.cents}¢` : ''}`;
  } else $('now-peak').textContent = '—';
  $('now-level').textContent = Number.isFinite(lastStatus.db) ? `${lastStatus.db.toFixed(0)} dB` : '—';
}

function drawPreview() {
  const v = display && display.video;
  const hasVideo = v && v.videoWidth > 0 && !$('opt-audio-only').checked;
  if (hasVideo) {
    const w = Math.min(1920, v.videoWidth);
    const h = Math.round((v.videoHeight / v.videoWidth) * w);
    if (preview.width !== w || preview.height !== h) {
      if (!recorder) { preview.width = w; preview.height = h; }
    }
    pctx.drawImage(v, 0, 0, preview.width, preview.height);
  } else {
    pctx.fillStyle = '#0d0f13';
    pctx.fillRect(0, 0, preview.width, preview.height);
    drawBars(pctx, preview.width, preview.height, '#3a4150', true);
  }
  if ($('opt-burn').checked) drawLabels(pctx, preview.width, preview.height);
}

function drawLabels(g, w, h) {
  const names = currentNames();
  if (!names.length) return;
  const size = Math.max(18, Math.round(h / 22));
  g.font = `700 ${size}px system-ui, sans-serif`;
  g.textBaseline = 'middle';
  let y = h - size * 1.6;
  for (const t of names.slice().reverse()) {
    const text = `${t.name} · ${fmtHz(t.freq)}`;
    const tw = g.measureText(text).width;
    const pad = size * 0.5;
    g.fillStyle = 'rgba(0,0,0,0.72)';
    roundRect(g, size * 0.8, y - size * 0.75, tw + pad * 2 + size * 0.9, size * 1.5, size * 0.35);
    g.fillStyle = colorFor(t);
    g.beginPath();
    g.arc(size * 0.8 + pad + size * 0.3, y, size * 0.28, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.fillText(text, size * 0.8 + pad + size * 0.8, y);
    y -= size * 1.8;
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
  g.fill();
}

// Log-frequency axis from 20 Hz to 20 kHz.
const F_MIN = 20, F_MAX = 20000;
const xOf = (f, w) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w;

function drawBars(g, w, h, color, big) {
  if (!freqData) return;
  const binHz = ctx.sampleRate / nodes.analyser.fftSize;
  g.fillStyle = color;
  const cols = big ? 160 : 300;
  for (let i = 0; i < cols; i++) {
    const f0 = F_MIN * Math.pow(F_MAX / F_MIN, i / cols);
    const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (i + 1) / cols);
    let m = -140;
    for (let b = Math.floor(f0 / binHz); b <= Math.ceil(f1 / binHz) && b < freqData.length; b++) m = Math.max(m, freqData[b]);
    const v = Math.max(0, Math.min(1, (m + 100) / 80));
    const x = (i / cols) * w;
    g.fillRect(x, h - v * h, w / cols - 1, v * h);
  }
}

function drawSpectrum() {
  const w = spectrum.width, h = spectrum.height;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  sctx.clearRect(0, 0, w, h);
  drawBars(sctx, w, h, dark ? '#4a5568' : '#b8c0cc', false);

  sctx.font = '20px system-ui, sans-serif';
  sctx.fillStyle = dark ? '#9aa1ad' : '#646a76';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    sctx.fillText(fmtHz(f), xOf(f, w) + 3, 22);
  }
  for (const t of settings.targets) {
    if (!(t.freq > 0)) continue;
    const x0 = xOf(Math.max(F_MIN, t.freq - t.tolerance), w);
    const x1 = xOf(Math.min(F_MAX, t.freq + t.tolerance), w);
    const on = detected.has(t.id);
    sctx.fillStyle = colorFor(t) + (on ? 'aa' : '44');
    sctx.fillRect(x0 - 1, 0, Math.max(3, x1 - x0 + 2), h);
  }
  if (peak) {
    sctx.fillStyle = dark ? '#e8eaee' : '#16181d';
    sctx.fillRect(xOf(peak, w) - 1, 30, 2, h - 30);
  }
}

// ------------------------------------------------------------- recording --

let recorder = null;
const recordings = [];
const log = [];

function pickMime(audioOnly) {
  const list = audioOnly
    ? ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function startRecording() {
  if (!nodes || recorder) return;
  const audioOnly = $('opt-audio-only').checked;
  const tracks = [...nodes.recDest.stream.getAudioTracks()];
  let usesDisplayTrack = false;
  if (!audioOnly) {
    if (display && !$('opt-burn').checked) {
      tracks.push(display.stream.getVideoTracks()[0]);
      usesDisplayTrack = true;
    } else {
      tracks.push(preview.captureStream(30).getVideoTracks()[0]);
    }
  }
  const mimeType = pickMime(audioOnly);
  let mr;
  try {
    mr = new MediaRecorder(new MediaStream(tracks), mimeType ? { mimeType } : undefined);
  } catch (err) {
    toast('Could not start recording: ' + err.message, 6000);
    return;
  }
  const chunks = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = () => finishRecording(chunks, mr.mimeType || mimeType, audioOnly);
  mr.start(1000);
  recorder = { mr, startedAt: performance.now(), usesDisplayTrack, canvasTrack: usesDisplayTrack || audioOnly ? null : tracks[tracks.length - 1] };
  $('rec-badge').hidden = false;
  $('btn-stop').disabled = false;
  $('opt-audio-only').disabled = true;
  $('opt-burn').disabled = true;
  updateSources();
}

function stopRecording() {
  if (!recorder) return;
  recorder.stoppedAt = performance.now();
  recorder.mr.stop();
}

function finishRecording(chunks, mimeType, audioOnly) {
  const { startedAt, stoppedAt = performance.now(), canvasTrack } = recorder;
  canvasTrack && canvasTrack.stop();
  recorder = null;
  $('rec-badge').hidden = true;
  $('btn-stop').disabled = true;
  $('opt-audio-only').disabled = false;
  $('opt-burn').disabled = false;
  updateSources();

  const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
  const ext = mimeType.includes('mp4') ? (audioOnly ? 'm4a' : 'mp4') : mimeType.includes('ogg') ? 'ogg' : 'webm';
  const cues = log
    .filter((e) => (e.end ?? stoppedAt) > startedAt && e.start < stoppedAt)
    .map((e) => ({
      text: `${e.name} (${fmtHz(e.freq)})`,
      start: Math.max(0, (e.start - startedAt) / 1000),
      end: Math.max(0.1, ((e.end ?? stoppedAt) - startedAt) / 1000),
    }));
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  recordings.unshift({
    name: `recording-${stamp}`,
    ext,
    url: URL.createObjectURL(blob),
    vtt: URL.createObjectURL(new Blob([toVtt(cues)], { type: 'text/vtt' })),
    srt: URL.createObjectURL(new Blob([toSrt(cues)], { type: 'text/plain' })),
    audioOnly,
    seconds: (stoppedAt - startedAt) / 1000,
    size: blob.size,
    cues: cues.length,
  });
  renderRecordings();
}

function toVtt(cues) {
  const t = (s) => fmtClock(s, '.');
  return 'WEBVTT\n\n' + cues.map((c, i) => `${i + 1}\n${t(c.start)} --> ${t(c.end)}\n${c.text}\n`).join('\n');
}
function toSrt(cues) {
  const t = (s) => fmtClock(s, ',');
  return cues.map((c, i) => `${i + 1}\n${t(c.start)} --> ${t(c.end)}\n${c.text}\n`).join('\n');
}

function renderRecordings() {
  const box = $('recordings');
  box.innerHTML = '';
  for (const r of recordings) {
    const row = document.createElement('div');
    row.className = 'recording';
    const media = document.createElement(r.audioOnly ? 'audio' : 'video');
    media.controls = true;
    media.src = r.url;
    if (!r.audioOnly) {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = 'Detected frequencies';
      track.src = r.vtt;
      media.appendChild(track);
    }
    const info = document.createElement('div');
    info.innerHTML = `<div><b>${r.name}.${r.ext}</b></div>
      <div class="muted">${fmtTime(r.seconds)} · ${(r.size / 1048576).toFixed(1)} MB · ${r.cues} detection${r.cues === 1 ? '' : 's'}</div>
      <div class="links row">
        <a download="${r.name}.${r.ext}" href="${r.url}">Download recording</a>
        <a download="${r.name}.vtt" href="${r.vtt}">Subtitles (.vtt)</a>
        <a download="${r.name}.srt" href="${r.srt}">Subtitles (.srt)</a>
      </div>`;
    row.append(media, info);
    box.appendChild(row);
  }
}

// ------------------------------------------------------------------- log --

function renderLog() {
  const body = $('log-body');
  body.innerHTML = '';
  for (const e of log.slice().reverse().slice(0, 300)) {
    const tr = document.createElement('tr');
    const len = e.end ? `${((e.end - e.start) / 1000).toFixed(2)} s` : 'now';
    tr.innerHTML = `<td></td><td>${fmtHz(e.freq)}</td><td>${new Date(performance.timeOrigin + e.start).toLocaleTimeString()}</td>
      <td>${e.end ? new Date(performance.timeOrigin + e.end).toLocaleTimeString() : '…'}</td><td>${len}</td>`;
    tr.firstChild.textContent = e.name;
    body.appendChild(tr);
  }
}

function downloadCsv() {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const rows = [['name', 'frequency_hz', 'start', 'end', 'seconds']];
  for (const e of log) {
    rows.push([
      q(e.name), e.freq,
      new Date(performance.timeOrigin + e.start).toISOString(),
      e.end ? new Date(performance.timeOrigin + e.end).toISOString() : '',
      e.end ? ((e.end - e.start) / 1000).toFixed(3) : '',
    ]);
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }));
  a.download = 'frequency-detections.csv';
  a.click();
}

// --------------------------------------------------------------- targets --

function addTarget(t) {
  const dup = settings.targets.find((x) => Math.abs(x.freq - t.freq) < 0.01 && x.name === t.name);
  if (dup) { toast(`"${t.name}" is already in your list.`); return; }
  settings.targets.push({ id: uid(), mute: false, ...t });
  targetsChanged();
}

function targetsChanged() {
  saveSettings();
  sendGuardConfig();
  renderTargets();
}

function renderTargets() {
  const body = $('targets-body');
  body.innerHTML = '';
  if (!settings.targets.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">No frequencies yet. Add a built-in one below or a custom one.</td></tr>';
    return;
  }
  for (const t of settings.targets) {
    const tr = document.createElement('tr');
    tr.dataset.id = t.id;
    tr.classList.toggle('active', detected.has(t.id));
    tr.innerHTML = `
      <td><div class="name-cell"><span class="swatch" style="background:${colorFor(t)}"></span><input type="text" data-k="name"></div></td>
      <td><input type="number" data-k="freq" min="1" max="24000" step="any"></td>
      <td><input type="number" data-k="tolerance" min="0" max="2000" step="any"></td>
      <td><input type="checkbox" data-k="mute" title="Silence the recording while this frequency is present"></td>
      <td><button class="small" data-del>✕</button></td>`;
    const name = tr.querySelector('[data-k=name]');
    const freq = tr.querySelector('[data-k=freq]');
    const tol = tr.querySelector('[data-k=tolerance]');
    const mute = tr.querySelector('[data-k=mute]');
    name.value = t.name;
    freq.value = +t.freq.toFixed(2);
    tol.value = t.tolerance;
    mute.checked = !!t.mute;
    name.addEventListener('change', () => { t.name = name.value.trim() || `${fmtHz(t.freq)} tone`; saveSettings(); });
    freq.addEventListener('change', () => { t.freq = Math.max(1, +freq.value || 1); targetsChanged(); });
    tol.addEventListener('change', () => { t.tolerance = Math.max(0, +tol.value || 0); targetsChanged(); });
    mute.addEventListener('change', () => { t.mute = mute.checked; saveSettings(); sendGuardConfig(); });
    tr.querySelector('[data-del]').addEventListener('click', () => {
      settings.targets = settings.targets.filter((x) => x !== t);
      detected.delete(t.id);
      targetsChanged();
      renderNow();
    });
    body.appendChild(tr);
  }
}

function renderLibrary() {
  const q = $('library-search').value.trim().toLowerCase();
  const box = $('library');
  box.innerHTML = '';
  for (const cat of PRESET_LIBRARY) {
    const items = cat.items.filter((i) => !q || cat.category.toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || String(i.freq).includes(q));
    if (!items.length) continue;
    const div = document.createElement('div');
    div.className = 'lib-cat';
    const head = document.createElement('div');
    head.className = 'lib-item';
    head.innerHTML = `<h4></h4><button class="small">Add all</button>`;
    head.querySelector('h4').textContent = cat.category;
    head.querySelector('button').addEventListener('click', () => items.forEach((i) => addTarget({ ...i })));
    div.appendChild(head);
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'lib-item';
      row.innerHTML = `<span><span class="n"></span> <span class="hz">${fmtHz(item.freq)} ±${item.tolerance}</span></span><button class="small">+ Add</button>`;
      row.querySelector('.n').textContent = item.name;
      row.querySelector('button').addEventListener('click', () => addTarget({ ...item }));
      div.appendChild(row);
    }
    box.appendChild(div);
  }
  if (!box.children.length) box.innerHTML = '<p class="muted">No built-ins match.</p>';
}

function setupNotePicker() {
  const ns = $('note-name'), oc = $('note-octave');
  NOTE_NAMES.forEach((n) => ns.add(new Option(n, n)));
  for (let o = 0; o <= 8; o++) oc.add(new Option(String(o), String(o)));
  ns.value = 'A';
  oc.value = '4';
  const update = () => { $('note-freq').textContent = fmtHz(noteToFreq(ns.value, +oc.value)); };
  ns.addEventListener('change', update);
  oc.addEventListener('change', update);
  update();
  $('btn-add-note').addEventListener('click', () => {
    const f = noteToFreq(ns.value, +oc.value);
    // About a quarter of a semitone either side.
    addTarget({ name: `Note ${ns.value}${oc.value}`, freq: +f.toFixed(2), tolerance: +Math.max(1, f * 0.015).toFixed(1) });
  });
}

// ------------------------------------------------------------- utilities --

function fmtHz(f) {
  if (f >= 1000) return `${+(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz`;
  return `${+f.toFixed(f < 100 ? 1 : 0)} Hz`;
}
function fmtTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function fmtClock(s, sep) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000) % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}${sep}${String(ms).padStart(3, '0')}`;
}
let toastTimer = null;
function toast(msg, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function bindSlider(id, key, fmt, onChange) {
  const input = $(id), out = $(id.replace('opt-', 'out-'));
  input.value = settings[key];
  out.textContent = fmt(settings[key]);
  input.addEventListener('input', () => {
    settings[key] = +input.value;
    out.textContent = fmt(settings[key]);
    saveSettings();
    onChange();
  });
}

// ----------------------------------------------------------------- setup --

function init() {
  if (!navigator.mediaDevices || !window.AudioWorkletNode || !window.MediaRecorder) {
    toast('This browser is missing screen capture or Web Audio support. Use a recent Chrome, Edge or Firefox.', 10000);
  }
  if (location.protocol === 'file:') {
    toast('Open this page through a web server (see README); browsers block audio processing on file:// pages.', 10000);
  }

  $('btn-capture').addEventListener('click', startScreen);
  $('btn-mic').addEventListener('click', () => (mic ? stopMic() : startMic()));
  $('btn-test').addEventListener('click', () => (tones ? stopTones() : startTones()));
  $('btn-release').addEventListener('click', stopAll);
  $('btn-record').addEventListener('click', startRecording);
  $('btn-stop').addEventListener('click', stopRecording);
  $('opt-monitor').addEventListener('change', applyMonitor);

  for (const id of ['opt-dn-mic', 'opt-dn-int', 'opt-hp']) $(id).addEventListener('change', sendDenoiseConfig);
  $('opt-browser-ns').addEventListener('change', () => {
    if (mic) mic.stream.getAudioTracks()[0].applyConstraints(micConstraints()).catch(() => {});
  });
  $('btn-learn').addEventListener('click', async () => {
    await ensureAudio();
    nodes.dnInt.port.postMessage({ learn: 2 });
    nodes.dnMic.port.postMessage({ learn: 2 });
    $('btn-learn').disabled = true;
    $('dn-mode').textContent = 'Listening to the background noise… stay quiet.';
  });
  $('btn-forget').addEventListener('click', () => {
    nodes.dnInt.port.postMessage({ forget: true });
    nodes.dnMic.port.postMessage({ forget: true });
    $('btn-forget').disabled = true;
    $('dn-mode').textContent = 'Mode: automatic (tracks the background noise as it goes)';
  });

  bindSlider('opt-threshold', 'threshold', (v) => `${Math.round(v * 100)}%`, sendGuardConfig);
  bindSlider('opt-mindb', 'minDb', (v) => `${v} dB`, sendGuardConfig);
  bindSlider('opt-hold', 'holdMs', (v) => `${v} ms`, sendGuardConfig);
  bindSlider('opt-dn-strength', 'dnStrength', (v) => `${v.toFixed(1)}×`, sendDenoiseConfig);
  bindSlider('opt-dn-floor', 'dnFloorDb', (v) => `${v} dB`, sendDenoiseConfig);

  $('btn-add-custom').addEventListener('click', () => {
    const freq = peak ? Math.round(peak) : 1000;
    addTarget({ name: `Custom ${fmtHz(freq)}`, freq, tolerance: 10 });
  });
  $('btn-clear-targets').addEventListener('click', () => {
    if (settings.targets.length && !confirm('Remove all named frequencies?')) return;
    settings.targets = [];
    detected.clear();
    targetsChanged();
    renderNow();
  });
  $('library-search').addEventListener('input', renderLibrary);
  $('btn-log-csv').addEventListener('click', downloadCsv);
  $('btn-log-clear').addEventListener('click', () => {
    log.splice(0, log.length, ...log.filter((e) => !e.end));
    renderLog();
  });

  setupNotePicker();
  renderTargets();
  renderLibrary();
  renderNow();
  updateSources();
  pctx.fillStyle = '#0d0f13';
  pctx.fillRect(0, 0, preview.width, preview.height);
}

init();

// Exposed for automated tests.
window.__freqRecorder = { settings, detected, log, recordings, startTones, stopTones, startRecording, stopRecording, ensureAudio, get nodes() { return nodes; } };
