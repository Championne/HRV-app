// Headless end-to-end test in simulation mode (Chromium, iPhone 13 Pro Max-sized viewport).
// Run: node tests/e2e.mjs  (needs playwright; serves this folder on http://127.0.0.1:8642)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(process.env.PW_DIR ? process.env.PW_DIR + '/' : import.meta.url);
const { chromium } = require('playwright');

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 8642, BASE = `http://127.0.0.1:${PORT}/`;
const SHOTS = ROOT + 'screenshots/';
mkdirSync(SHOTS, { recursive: true });
const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const results = [];
const ok = (name) => { results.push('PASS ' + name); console.log('PASS', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
  const external = [];
  ctx.on('request', (r) => { if (!r.url().startsWith(BASE)) external.push(r.url()); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // 1. Live view, sped-up simulation with a forced link drop every 50 simulated seconds.
  await page.goto(BASE + 'index.html?simulate=1&speed=10&drop=50');
  await page.click('#btn-connect');
  await page.waitForFunction(() => document.getElementById('conn-text').textContent.includes('Polar H10'));
  ok('simulated strap connects');
  await page.waitForFunction(() => /\d/.test(document.getElementById('battery').textContent));
  ok('battery level shown: ' + await page.textContent('#battery'));
  await page.click('#btn-session');
  await sleep(14000); // ~140 simulated seconds
  const hr = Number(await page.textContent('#hr')), rmssd = Number(await page.textContent('#rmssd'));
  assert.ok(hr > 50 && hr < 90, 'hr ' + hr); assert.ok(rmssd > 10 && rmssd < 150, 'rmssd ' + rmssd);
  ok(`live values HR ${hr} bpm, RMSSD ${rmssd} ms, SDNN ${await page.textContent('#sdnn')}, score ${await page.textContent('#score')} (${await page.textContent('#zone')})`);
  const rec = Number(await page.textContent('#reconnects'));
  assert.ok(rec >= 1, 'expected auto-reconnects, got ' + rec);
  ok(`auto-reconnect after simulated drops: ${rec} reconnects`);
  await page.screenshot({ path: SHOTS + '01-live.png', fullPage: true });
  await page.screenshot({ path: SHOTS + '01-live-viewport.png' });

  // 2. Stop + saved session list.
  await page.click('#btn-session');
  await page.waitForFunction(() => document.getElementById('banner').textContent.includes('Session saved'));
  ok('session saved: ' + await page.textContent('#banner'));
  await page.click('.tab[data-view=sessions]');
  await page.waitForSelector('#session-list li .s-actions');
  await page.screenshot({ path: SHOTS + '02-sessions.png', fullPage: true });

  // 3. Export CSV + JSON (headless has no share sheet -> falls back to download).
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#session-list li [data-a=csv]')]);
  const csv = readFileSync(await dl.path(), 'utf8').trim().split(/\r?\n/);
  assert.equal(csv[0], 'time,elapsed_s,hr_bpm,rr_ms,contact');
  assert.ok(csv.length > 100);
  assert.match(csv[1], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3},\d+\.\d\d,\d+,\d+\.\d,True$/);
  ok(`CSV export ${dl.suggestedFilename()} (${csv.length - 1} beat rows)`);
  const [dj] = await Promise.all([page.waitForEvent('download'), page.click('#session-list li [data-a=json]')]);
  const js = JSON.parse(readFileSync(await dj.path(), 'utf8'));
  for (const k of ['mean_hr', 'min_hr', 'max_hr', 'rmssd_ms', 'sdnn_ms', 'pnn50_pct', 'beats', 'reconnects']) assert.ok(js[k] != null, k);
  ok('JSON summary ' + dj.suggestedFilename() + ' ' + JSON.stringify(js));

  // 4. Persistence across reload (IndexedDB) and offline (service worker).
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(() => true));
  await page.reload(); await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.goto(BASE + 'index.html?simulate=1');
  await page.click('.tab[data-view=sessions]');
  await page.waitForSelector('#session-list li .s-actions');
  ok('works offline after first load; session still listed from IndexedDB');
  await ctx.setOffline(false);

  // 5. Disconnect button stops reconnecting.
  await page.click('.tab[data-view=live]');
  await page.click('#btn-connect'); await page.waitForFunction(() => document.getElementById('conn-dot').className.includes('on'));
  await page.click('#btn-connect'); await sleep(1500);
  assert.equal(await page.textContent('#conn-text'), 'Disconnected');
  ok('manual disconnect does not auto-reconnect');

  assert.deepEqual(external, [], 'external requests: ' + external.join(', '));
  ok('no network requests outside the app origin');
  assert.deepEqual(errors, [], errors.join('\n'));
  ok('no page/console errors');
  await ctx.close();

  // 6. Browser without Web Bluetooth (e.g. Safari on iPhone).
  const ctx2 = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true });
  await ctx2.addInitScript(() => Object.defineProperty(Navigator.prototype, 'bluetooth', { get: () => undefined }));
  const p2 = await ctx2.newPage();
  await p2.goto(BASE + 'index.html');
  assert.match(await p2.textContent('#banner'), /Bluefy/);
  assert.equal(await p2.isDisabled('#btn-connect'), true);
  await p2.screenshot({ path: SHOTS + '03-no-web-bluetooth.png' });
  ok('no-Web-Bluetooth message shown, Connect disabled');
  await ctx2.close();
} finally {
  await browser.close(); srv.kill();
}
console.log(`\n${results.length} checks passed`);
