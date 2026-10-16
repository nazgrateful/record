// Plays a frequency so you can hear it: one at a time, with a gentle fade in
// and out. A spec is { hz } (both ears) or { left, right } (each ear its own;
// a 0 / missing side is silent there). Clicking the same button again stops.

let current = null; // { stop, btn }
let ctxPromise = null;

function audioContext() {
  if (!ctxPromise) ctxPromise = Promise.resolve(new AudioContext());
  return ctxPromise.then(async (ctx) => { if (ctx.state === 'suspended') await ctx.resume(); return ctx; });
}

export function stopTone() {
  if (!current) return;
  const c = current;
  current = null;
  c.stop();
  if (c.btn) { c.btn.textContent = c.label; c.btn.classList.remove('playing'); }
}

export async function playTone(spec, btn, { seconds = 3, wave = 'sine', db = null } = {}) {
  if (current && current.btn === btn) { stopTone(); return; }
  stopTone();
  const ctx = await audioContext();
  const left = spec.left ?? spec.hz, right = spec.right ?? spec.hz;
  const top = Math.max(left || 0, right || 0);
  // Quieter for piercing high tones.
  const level = db !== null ? Math.pow(10, db / 20) : top > 4000 ? 0.06 : 0.15;
  const out = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  merger.connect(out).connect(ctx.destination);
  const now = ctx.currentTime;
  out.gain.setValueAtTime(0, now);
  out.gain.linearRampToValueAtTime(level, now + 0.08);
  out.gain.setValueAtTime(level, now + seconds - 0.25);
  out.gain.linearRampToValueAtTime(0, now + seconds);
  const oscs = [];
  [left, right].forEach((f, ch) => {
    if (!(f > 0) || f >= ctx.sampleRate / 2) return;
    const o = ctx.createOscillator();
    o.type = wave;
    o.frequency.value = f;
    o.connect(merger, 0, ch);
    o.start(now);
    o.stop(now + seconds);
    oscs.push(o);
  });
  const label = btn ? btn.textContent : '';
  const me = {
    btn, label,
    stop: () => { const t = ctx.currentTime; out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(out.gain.value, t); out.gain.linearRampToValueAtTime(0, t + 0.05); oscs.forEach((o) => { try { o.stop(t + 0.06); } catch {} }); setTimeout(() => out.disconnect(), 200); },
  };
  current = me;
  if (btn) { btn.textContent = '■'; btn.classList.add('playing'); }
  if (oscs[0]) oscs[0].onended = () => { if (current === me) stopTone(); };
}
