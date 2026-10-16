// Checks that updating the site never loses saved data.
//
// For every earlier storage layout the site has used, this fills a browser
// with recordings, settings and editor audio exactly as that version saved
// them, then opens the current site and checks everything is still there,
// byte for byte. It also checks: a tab still open on the old version, a
// recording in progress in another tab, and backup + restore.
//
// Run before publishing any update:
//   npm install        (once; installs Playwright)
//   npm run test:upgrade

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/__blank') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>blank</title>'); }
  const file = path.join(root, url === '/' ? 'index.html' : url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(launchOpts);

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '  ✓' : '  ✗'} ${msg}`); if (!ok) failures++; };

// --- Writes data the way each earlier version did (runs in the page). ---
function seed(version) {
  const bytes = (n, k) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (i * 31 + k) & 255; return a; };
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('freq-recorder', version);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('recordings', { keyPath: 'id' });
      db.createObjectStore('chunks', { keyPath: ['recId', 'seq'] }).createIndex('recId', 'recId');
      if (version >= 2) db.createObjectStore('kv');
      if (version >= 3) { db.createObjectStore('pcm'); db.createObjectStore('pcmMeta'); }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const stores = ['recordings', 'chunks', ...(version >= 2 ? ['kv'] : []), ...(version >= 3 ? ['pcm', 'pcmMeta'] : [])];
      const t = db.transaction(stores, 'readwrite');
      const expected = {};
      // v1: { id, name, ext, mime, audioOnly, createdAt, seconds, size, cues, complete }
      const recs = [
        { id: `v${version}a`, name: 'old-video', ext: 'webm', mime: 'video/webm;codecs=vp9,opus', audioOnly: false, createdAt: Date.now() - 86400000 * 3, seconds: 3, size: 0, cues: [{ text: 'Censor bleep (1 kHz)', start: 0.5, end: 1 }], complete: true },
        { id: `v${version}b`, name: 'old-audio', ext: 'webm', mime: 'audio/webm;codecs=opus', audioOnly: true, createdAt: Date.now() - 86400000 * 2, seconds: 2, size: 0, cues: [], complete: true },
        // Interrupted by a crash in that version (not complete).
        { id: `v${version}c`, name: 'old-crashed', ext: 'webm', mime: 'audio/webm;codecs=opus', audioOnly: true, createdAt: Date.now() - 86400000, seconds: 0, size: 0, cues: [], complete: false },
      ];
      if (version >= 2) Object.assign(recs[0], { kind: 'combined', group: 'g1', savedToDisk: false });
      recs.forEach((r, k) => {
        const chunks = [bytes(1000 + k, k), bytes(777, k + 1), bytes(3000, k + 2)];
        r.size = chunks.reduce((n, c) => n + c.length, 0);
        expected[r.id] = Array.from(new Uint8Array(chunks.reduce((a, c) => [...a, ...c], [])));
        t.objectStore('recordings').put(r);
        chunks.forEach((c, seq) => t.objectStore('chunks').put({ recId: r.id, seq, blob: new Blob([c]) }));
      });
      if (version >= 3) {
        const ch = [new Int16Array(4096).map((_, i) => (i * 13) % 2000 - 1000)];
        const meta = { len: 4096, p1: new Int16Array(16), p2: new Int16Array(2) };
        t.objectStore('pcm').put(ch.map((x) => x.buffer), 'doc-old:b1');
        t.objectStore('pcmMeta').put(meta, 'doc-old:b1');
        t.objectStore('kv').put({ id: 'doc-old', name: 'editing', rate: 48000, ch: 1, segs: [{ key: 'doc-old:b1', start: 0, end: 4096 }] }, 'editorDoc');
      }
      const saved = { targets: [{ id: 'x1', name: 'My tone', freq: 432, tolerance: 2, mute: true }], threshold: 0.4, minDb: -60, holdMs: 300 };
      // Frequency layers as first saved: { left, right } (right 0 = same).
      if (version >= 3) saved.toneLayers = [{ id: 'l1', name: 'old binaural', left: 100, right: 104, wave: 'sine', db: -18 }, { id: 'l2', name: 'old 432', left: 432, right: 0, wave: 'triangle', db: -12 }];
      localStorage.setItem('freq-recorder.v1', JSON.stringify(saved));
      t.oncomplete = () => { db.close(); resolve(expected); };
      t.onerror = () => reject(t.error);
    };
  });
}

// Reads back what the current site sees (runs in the page).
async function readBack() {
  const store = await import('./db.js');
  const out = {};
  for (const r of await store.listRecordings()) {
    out[r.id] = { rec: r, bytes: Array.from(new Uint8Array(await (await store.getBlob(r)).arrayBuffer())) };
  }
  const ed = await import('./editor.js');
  const layers = [...document.querySelectorAll('#ed-tones-body tr')].map((tr) => {
    const v = (k) => tr.querySelector(`[data-k=${k}]`)?.value;
    return v('name') && { name: v('name'), ears: v('ears'), hz: +v('hz'), left: +v('left'), right: +v('right'), wave: v('wave'), db: +v('db') };
  }).filter(Boolean);
  return { layers, recs: out, settings: JSON.parse(localStorage.getItem('freq-recorder.v1')), editor: ed.editorState.doc && { name: ed.editorState.doc.name, total: ed.editorState.total }, shown: document.querySelectorAll('#recordings .recording').length };
}

async function freshPage() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

for (const version of [1, 2, 3]) {
  console.log(`Data saved by storage version ${version} → current site`);
  const { ctx, page, errors } = await freshPage();
  await page.goto(base + '/__blank');
  const expected = await page.evaluate(seed, version);
  await page.goto(base + '/');
  await page.waitForTimeout(1500);
  const got = await page.evaluate(readBack);
  for (const [id, bytes] of Object.entries(expected)) {
    const g = got.recs[id];
    check(!!g, `recording ${id} still listed`);
    if (g) check(g.bytes.length === bytes.length && g.bytes.every((b, i) => b === bytes[i]), `recording ${id}: all ${bytes.length} bytes identical`);
  }
  check(got.recs[`v${version}c`] && got.recs[`v${version}c`].rec.complete && got.recs[`v${version}c`].rec.recovered, 'interrupted recording recovered, not deleted');
  check(got.shown === Object.keys(expected).length, `all ${Object.keys(expected).length} recordings shown on the page (${got.shown})`);
  check(got.settings && got.settings.targets.some((t) => t.name === 'My tone' && t.freq === 432 && t.mute) && got.settings.threshold === 0.4, 'settings and named frequencies kept');
  if (version >= 3) check(got.editor && got.editor.name === 'editing' && got.editor.total === 4096, 'audio open in the editor kept');
  if (version >= 3) {
    const [a, b] = got.layers;
    check(got.layers.length === 2 && a.ears === 'split' && a.left === 100 && a.right === 104 && b.ears === 'both' && b.hz === 432 && b.wave === 'triangle' && b.db === -12,
      'saved frequency layers kept (and shown with their ears)');
  }
  check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  await ctx.close();
}

console.log('A tab still open on the old version while the update loads');
{
  const ctx = await browser.newContext();
  const old = await ctx.newPage();
  await old.goto(base + '/__blank');
  await old.evaluate(seed, 2);
  // Old code kept its connection open and didn't react to upgrades.
  await old.evaluate(() => new Promise((r) => { const q = indexedDB.open('freq-recorder', 2); q.onsuccess = () => { window.keep = q.result; r(); }; }));
  const page = await ctx.newPage();
  await page.goto(base + '/');
  await page.waitForTimeout(1500);
  check(await page.isVisible('#notice'), 'the new tab says to close the old one (instead of showing an empty list)');
  await old.close();
  await page.waitForTimeout(1500);
  const got = await page.evaluate(readBack);
  check(Object.keys(got.recs).length === 3, 'after the old tab closes, the upgrade finishes with all recordings');
  await ctx.close();
}

console.log('A recording in progress in another tab');
{
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await a.goto(base + '/');
  await a.waitForTimeout(800);
  // Tab A has just started recording: entry saved, no audio chunk yet.
  await a.evaluate(async () => {
    const store = await import('./db.js');
    navigator.locks.request('freq-recorder:recording:live1', () => new Promise(() => {}));
    await store.putRecording({ id: 'live1', name: 'live', ext: 'webm', mime: 'audio/webm', audioOnly: true, createdAt: Date.now(), seconds: 0, size: 0, cues: [], complete: false });
  });
  const b = await ctx.newPage();
  await b.goto(base + '/');
  await b.waitForTimeout(1500);
  const still = await b.evaluate(async () => (await import('./db.js')).hasRecording('live1'));
  check(still, 'opening the site in another tab leaves the live recording alone');
  await ctx.close();
}

console.log('Back up, lose everything, restore');
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => { window.showDirectoryPicker = async () => { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle('backup', { create: true }); }; });
  await page.goto(base + '/__blank');
  const expected = await page.evaluate(seed, 3);
  await page.goto(base + '/');
  await page.waitForTimeout(1500);
  await page.click('#btn-backup');
  await page.waitForFunction(() => !document.getElementById('btn-backup').disabled);
  // The browser's site data gets cleared (except the backup folder).
  await page.evaluate(async () => {
    const store = await import('./db.js');
    for (const r of await store.listRecordings()) await store.deleteRecording(r.id);
  });
  await page.click('#btn-restore');
  await page.waitForFunction(() => !document.getElementById('btn-restore').disabled);
  const got = await page.evaluate(readBack);
  for (const [id, bytes] of Object.entries(expected)) {
    const g = got.recs[id];
    check(g && g.bytes.length === bytes.length && g.bytes.every((x, i) => x === bytes[i]), `restored ${id} byte for byte`);
  }
  await page.click('#btn-backup');
  await page.waitForFunction(() => !document.getElementById('btn-backup').disabled);
  check(/0 copied, 3 already there/.test(await page.textContent('#toast')), 'backing up again copies nothing new');
  await ctx.close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) FAILED — do not publish this update.` : '\nAll data-safety checks passed.');
process.exit(failures ? 1 : 0);
