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

  // 7. Vita feed against a mocked GitHub API, accelerated interval (?feedInterval=2000 ms real = 20 s simulated).
  const TOKEN = 'github_pat_TEST_e2e_0123456789';
  const gh = { files: new Map(), log: [], offline: false, private: true, sha: 0 };
  const ctx3 = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Accept, Content-Type, X-GitHub-Api-Version', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS' };
  const reply = (route, status, body) => route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await ctx3.route('https://api.github.com/**', async (route) => {
    const req = route.request(), method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (gh.offline) return route.abort('internetdisconnected');
    const h = req.headers(), u = new URL(req.url());
    gh.log.push({ method, path: u.pathname, auth: h.authorization, accept: h.accept, body: req.postData() });
    const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)(?:\/contents\/(.+))?$/);
    if (!m || h.authorization !== 'Bearer ' + TOKEN) return reply(route, 401, { message: 'Bad credentials' });
    if (!m[2]) return reply(route, 200, { full_name: m[1], private: gh.private, permissions: { push: true } });
    const path = decodeURIComponent(m[2]), f = gh.files.get(path);
    if (method === 'GET') return f ? reply(route, 200, { sha: f.sha, encoding: 'base64', content: Buffer.from(f.text).toString('base64') }) : reply(route, 404, { message: 'Not Found' });
    const body = JSON.parse(req.postData());
    if (f && body.sha !== f.sha) return reply(route, 409, { message: 'sha mismatch' });
    gh.files.set(path, { sha: 's' + (++gh.sha), text: Buffer.from(body.content, 'base64').toString('utf8') });
    return reply(route, f ? 200 : 201, { content: { path } });
  });
  const p3 = await ctx3.newPage();
  const errs3 = [], consoleAll = [];
  p3.on('pageerror', (e) => errs3.push(String(e)));
  p3.on('console', (m) => { consoleAll.push(m.text()); if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(m.text())) errs3.push(m.text()); });
  await p3.goto(BASE + 'index.html?simulate=1&speed=10&feedInterval=2000');
  assert.equal(await p3.textContent('#feed-status'), 'Feed off');
  ok('feed status "Feed off" with no token');

  await p3.click('.tab[data-view=settings]');
  assert.equal(await p3.inputValue('#set-repo'), 'Championne/hrv-sessions');
  assert.equal(await p3.getAttribute('#set-token', 'type'), 'password');
  assert.equal(await p3.isDisabled('#set-feed'), true);
  gh.private = false;
  await p3.fill('#set-token', TOKEN); await p3.click('#btn-test');
  await p3.waitForFunction(() => /PUBLIC/.test(document.getElementById('set-result').textContent));
  ok('Test connection warns when the repo is public: ' + await p3.textContent('#set-result'));
  gh.private = true;
  await p3.click('#btn-test');
  await p3.waitForFunction(() => document.getElementById('set-result').textContent.startsWith('✓'));
  ok('Test connection ok: ' + await p3.textContent('#set-result'));
  await p3.check('#set-feed');
  assert.equal(await p3.evaluate(() => localStorage.getItem('hrvFeed.token')), TOKEN);
  await p3.screenshot({ path: SHOTS + '04-settings.png', fullPage: true });
  await p3.screenshot({ path: SHOTS + '04-settings-viewport.png' });
  ok('settings saved (token only in localStorage), screenshot 04-settings.png');

  await p3.click('.tab[data-view=live]');
  await p3.click('#btn-connect');
  await p3.waitForFunction(() => document.getElementById('conn-dot').className.includes('on'));
  await p3.click('#btn-session');
  await p3.waitForFunction(() => /^Synced \d\d:\d\d$/.test(document.getElementById('feed-status').textContent), null, { timeout: 15000 });
  await sleep(4500);
  const liveFiles = () => [...gh.files.keys()].filter((k) => k.startsWith('live/'));
  assert.equal(liveFiles().length, 1); assert.match(liveFiles()[0], /^live\/\d{4}-\d\d-\d\d\.jsonl$/);
  const n1 = gh.files.get(liveFiles()[0]).text.trim().split('\n').length;
  assert.ok(n1 >= 2, 'readings so far ' + n1);
  ok(`rolling readings appended to ${liveFiles()[0]}: ${n1} lines, status "${await p3.textContent('#feed-status')}"`);

  gh.offline = true;
  await p3.evaluate(() => window.dispatchEvent(new Event('offline')));
  await p3.waitForFunction(() => /^Offline – [1-9]\d* queued$/.test(document.getElementById('feed-status').textContent), null, { timeout: 10000 });
  await sleep(2500);
  const offTxt = await p3.textContent('#feed-status');
  const queued = await p3.evaluate(() => JSON.parse(localStorage.getItem('hrvFeed.queue')).length);
  assert.ok(queued >= 1);
  await p3.screenshot({ path: SHOTS + '05-feed-offline.png' });
  ok(`offline: "${offTxt}", ${queued} readings persisted in localStorage`);
  gh.offline = false;
  await p3.evaluate(() => window.dispatchEvent(new Event('online')));
  await p3.waitForFunction(() => /^Synced/.test(document.getElementById('feed-status').textContent) && JSON.parse(localStorage.getItem('hrvFeed.queue') || '[]').length === 0, null, { timeout: 10000 });
  ok('back online: queue flushed, status "' + await p3.textContent('#feed-status') + '"');

  await p3.click('#btn-session');
  await p3.waitForFunction(() => /^Synced/.test(document.getElementById('feed-status').textContent) && JSON.parse(localStorage.getItem('hrvFeed.queue') || '[]').length === 0, null, { timeout: 10000 });
  await sleep(500);
  const sumFiles = [...gh.files.keys()].filter((k) => k.startsWith('sessions/'));
  assert.equal(sumFiles.length, 1); assert.match(sumFiles[0], /^sessions\/\d{4}-\d\d-\d\d_\d{6}\.json$/);
  const sum = JSON.parse(gh.files.get(sumFiles[0]).text);
  for (const k of ['session_id', 'start', 'end', 'duration_s', 'hr_mean', 'hr_min', 'hr_max', 'rmssd_ms', 'sdnn_ms', 'ln_rmssd', 'pnn50_pct', 'score', 'zone', 'beats', 'artefacts']) assert.ok(sum[k] != null, 'summary ' + k);
  ok('session summary written to ' + sumFiles[0] + ' ' + JSON.stringify(sum));

  const lines = gh.files.get(liveFiles()[0]).text.trim().split('\n').map((l) => JSON.parse(l));
  const keys = ['ts', 'session_id', 'hr_avg_2min', 'hr_min', 'hr_max', 'rmssd_ms', 'sdnn_ms', 'ln_rmssd', 'score', 'zone', 'clean_beats', 'artefacts', 'contact'];
  for (const r of lines) assert.deepEqual(Object.keys(r), keys);
  const ts = lines.map((r) => new Date(r.ts).getTime());
  assert.ok(ts.every((t, i) => i === 0 || t > ts[i - 1]), 'readings in time order, no duplicates');
  assert.ok(lines.every((r) => r.session_id === sum.session_id && r.contact === true));
  assert.ok(lines.slice(1).every((r) => r.hr_avg_2min > 40 && r.rmssd_ms > 5 && r.score != null));
  ok(`${lines.length} readings in order, all fields present; last ${JSON.stringify(lines[lines.length - 1])}`);

  assert.ok(gh.log.length > 0 && gh.log.every((l) => l.auth === 'Bearer ' + TOKEN && l.accept === 'application/vnd.github+json'));
  assert.ok(gh.log.every((l) => !l.path.includes(TOKEN)), 'token never in a URL');
  const puts = gh.log.filter((l) => l.method === 'PUT').map((l) => Buffer.from(JSON.parse(l.body).content, 'base64').toString('utf8'));
  assert.ok(puts.every((t) => !/"rr"|rr_ms|"beats":\[/.test(t)), 'no raw RR data sent');
  assert.ok(consoleAll.every((t) => !t.includes(TOKEN)), 'token never logged');
  assert.deepEqual(errs3, [], errs3.join('\n'));
  ok(`${gh.log.length} GitHub API calls, all Bearer + vnd.github+json; no raw RR sent; token never logged; no page errors`);
  await ctx3.close();
} finally {
  await browser.close(); srv.kill();
}
console.log(`\n${results.length} checks passed`);
