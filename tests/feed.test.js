import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReading, buildSummary, appendJsonl, b64encode, b64decode, isoLocal, localDate, livePath, summaryPath,
  GitHubClient, Feed, KEYS, DEFAULT_REPO } from '../js/feed.js';

// ---- in-memory localStorage + mock GitHub contents API
class MemStorage { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
function mockGitHub({ isPrivate = true } = {}) {
  const files = new Map(); // path -> {sha, text}
  const log = []; let shaN = 0; let failNext = null; let offline = false;
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, opt = {}) => {
    if (offline) throw new TypeError('Failed to fetch');
    const u = new URL(url); const method = opt.method || 'GET';
    log.push({ method, path: u.pathname, auth: opt.headers && opt.headers.Authorization, accept: opt.headers && opt.headers.Accept });
    if (failNext && failNext.method === method) { const f = failNext; failNext = null; if (f.mutate) f.mutate(); return res(f.status, { message: 'conflict' }); }
    const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)(?:\/contents\/(.+))?$/);
    if (!m) return res(404, {});
    if (!m[2]) return res(200, { full_name: m[1], private: isPrivate, permissions: { push: true } });
    const path = decodeURIComponent(m[2]);
    if (method === 'GET') { const f = files.get(path); return f ? res(200, { sha: f.sha, encoding: 'base64', content: b64encode(f.text).replace(/(.{60})/g, '$1\n') }) : res(404, {}); }
    if (method === 'PUT') {
      const body = JSON.parse(opt.body); const f = files.get(path);
      if (f && body.sha !== f.sha) return res(409, { message: 'sha mismatch' });
      if (!f && body.sha) return res(422, { message: 'sha for missing file' });
      const nf = { sha: 's' + (++shaN), text: b64decode(body.content) }; files.set(path, nf);
      return res(f ? 200 : 201, { content: { sha: nf.sha } });
    }
    return res(405, {});
  };
  return { files, log, fetchImpl, set failNext(v) { failNext = v; }, set offline(v) { offline = v; } };
}

function session() {
  const start = new Date(2026, 9, 24, 7, 0, 0).getTime();
  const beats = []; let t = start;
  for (let k = 0; k < 200; k++) { const rr = k === 50 ? 300 : 900 + (k % 2 ? 40 : -40); t += rr; beats.push({ t, el: (t - start) / 1000, hr: 60 + (k % 5), rr, contact: true }); }
  return { id: 'sess-1', start, end: t, device: 'Polar H10 TEST', beats, reconnects: 1 };
}

test('base64 is UTF-8 safe and round-trips', () => {
  const s = '{"zone":"Relaxed / recovered","note":"café ✓ 💓"}\n';
  assert.equal(b64decode(b64encode(s)), s);
  assert.equal(b64encode('abc'), 'YWJj');
  assert.equal(b64decode('YW\nJj'), 'abc');
});
test('dates: local date file name and ISO with offset', () => {
  const t = new Date(2026, 9, 24, 23, 59, 30).getTime();
  assert.equal(localDate(t), '2026-10-24');
  assert.equal(livePath(t), 'live/2026-10-24.jsonl');
  assert.match(isoLocal(t), /^2026-10-24T23:59:30[+-]\d\d:\d\d$/);
  assert.equal(new Date(isoLocal(t)).getTime(), t);
  assert.equal(summaryPath(session()), 'sessions/2026-10-24_070000.json');
});
test('buildReading: fields, 2-min HR window, 60 s HRV window, artefacts', () => {
  const s = session(); const t = s.beats[s.beats.length - 1].t; const since = t - 120000;
  const windowRR = s.beats.filter((b) => b.t >= t - 60000).map((b) => b.rr);
  const r = buildReading({ t, session: s, since, windowRR, contact: true });
  assert.deepEqual(Object.keys(r), ['ts', 'session_id', 'hr_avg_2min', 'hr_min', 'hr_max', 'rmssd_ms', 'sdnn_ms', 'ln_rmssd', 'score', 'zone', 'clean_beats', 'artefacts', 'contact']);
  assert.equal(r.session_id, 'sess-1'); assert.equal(r.contact, true);
  assert.equal(r.hr_min, 60); assert.equal(r.hr_max, 64); assert.ok(r.hr_avg_2min > 60 && r.hr_avg_2min < 64);
  assert.equal(r.rmssd_ms, 80); assert.ok(r.score > 60 && r.score <= 100); assert.equal(typeof r.zone, 'string');
  const inInt = s.beats.filter((b) => b.t > since && b.t <= t).length;
  assert.equal(r.clean_beats + r.artefacts, inInt);
  // The 300 ms beat (k=50) lies outside this interval; an interval that contains it counts one artefact.
  const r0 = buildReading({ t: s.beats[60].t, session: s, since: s.start, windowRR: [], contact: null });
  assert.equal(r0.artefacts, 1); assert.equal(r0.score, null); assert.equal(r0.zone, 'none'); assert.equal(r0.rmssd_ms, null);
  assert.ok(!('rr' in r) && !JSON.stringify(r).includes('"beats"'), 'no raw RR in a reading');
});
test('buildSummary: full session fields, no raw beats', () => {
  const s = buildSummary(session());
  for (const k of ['start', 'end', 'duration_s', 'hr_mean', 'hr_min', 'hr_max', 'rmssd_ms', 'sdnn_ms', 'ln_rmssd', 'pnn50_pct', 'score', 'zone', 'beats', 'artefacts', 'clean_beats'])
    assert.ok(s[k] != null, k);
  assert.equal(s.beats, 200); assert.equal(s.artefacts, s.beats - s.clean_beats); assert.ok(s.artefacts >= 1);
  assert.ok(!Array.isArray(s.beats));
});
test('appendJsonl: appends with newline, skips duplicates', () => {
  assert.deepEqual(appendJsonl('', ['{"a":1}']), { text: '{"a":1}\n', added: 1 });
  assert.deepEqual(appendJsonl('{"a":1}', ['{"b":2}']), { text: '{"a":1}\n{"b":2}\n', added: 1 });
  assert.deepEqual(appendJsonl('{"a":1}\n', ['{"a":1}', '{"c":3}']), { text: '{"a":1}\n{"c":3}\n', added: 1 });
  assert.equal(appendJsonl('{"a":1}\n', ['{"a":1}']).added, 0);
});
test('GitHubClient.appendLines: creates on 404, then GET sha + PUT; headers', async () => {
  const gh = mockGitHub(); const c = new GitHubClient({ token: 'tok123', repo: DEFAULT_REPO, fetchImpl: gh.fetchImpl });
  await c.appendLines('live/2026-10-24.jsonl', ['{"n":1}'], 'm');
  await c.appendLines('live/2026-10-24.jsonl', ['{"n":2}', '{"n":3}'], 'm');
  assert.equal(gh.files.get('live/2026-10-24.jsonl').text, '{"n":1}\n{"n":2}\n{"n":3}\n');
  assert.deepEqual(gh.log.map((l) => l.method), ['GET', 'PUT', 'GET', 'PUT']);
  assert.ok(gh.log.every((l) => l.auth === 'Bearer tok123' && l.accept === 'application/vnd.github+json'));
  assert.equal(gh.log[0].path, '/repos/Championne/hrv-sessions/contents/live/2026-10-24.jsonl');
});
test('GitHubClient.appendLines: retries once on 409 sha conflict and keeps the other writer\'s line', async () => {
  const gh = mockGitHub(); const c = new GitHubClient({ token: 't', repo: 'o/r', fetchImpl: gh.fetchImpl });
  await c.appendLines('live/d.jsonl', ['{"n":1}']);
  gh.failNext = { method: 'PUT', status: 409, mutate: () => gh.files.set('live/d.jsonl', { sha: 'other', text: '{"n":1}\n{"x":9}\n' }) };
  await c.appendLines('live/d.jsonl', ['{"n":2}']);
  assert.equal(gh.files.get('live/d.jsonl').text, '{"n":1}\n{"x":9}\n{"n":2}\n');
  // Two conflicts in a row -> gives up (error surfaces, caller keeps it queued).
  let calls = 0; const always409 = async (url, opt) => { calls++; return opt.method === 'PUT' ? { ok: false, status: 409, text: async () => '' } : { ok: false, status: 404, text: async () => '' }; };
  await assert.rejects(new GitHubClient({ token: 't', repo: 'o/r', fetchImpl: always409 }).appendLines('p', ['x']), (e) => e.status === 409);
  assert.equal(calls, 4);
});
test('Feed: off without token; queue persists offline and flushes in order', async () => {
  const gh = mockGitHub(); const ls = new MemStorage(); const statuses = [];
  const f = new Feed({ storage: ls, fetchImpl: gh.fetchImpl, onStatus: (s) => statuses.push(s.text), clock: () => new Date(2026, 9, 24, 7, 4).getTime() });
  assert.equal(f.statusText().text, 'Feed off');
  f.setEnabled(true); assert.equal(f.active, false, 'no token -> inactive');
  assert.equal(f.enqueueReading({ n: 0 }, Date.now()), false); assert.equal(f.queue.length, 0);
  f.setToken(' tok '); assert.equal(ls.getItem(KEYS.token), 'tok'); assert.equal(f.active, true); assert.equal(f.repo, DEFAULT_REPO);
  const day1 = new Date(2026, 9, 24, 7, 0).getTime(), day2 = new Date(2026, 9, 25, 0, 1).getTime();
  gh.offline = true;
  f.enqueueReading({ n: 1 }, day1); f.enqueueReading({ n: 2 }, day1);
  await f.flush();
  assert.equal(f.statusText().text, 'Offline – 2 queued');
  f.enqueueReading({ n: 3 }, day2);
  const s = session(); s.start = day1; f.enqueueSummary(s);
  assert.equal(JSON.parse(ls.getItem(KEYS.queue)).length, 4, 'persisted in storage');
  // A fresh Feed (page reload) sees the same queue.
  const f2 = new Feed({ storage: ls, fetchImpl: gh.fetchImpl, clock: () => new Date(2026, 9, 24, 7, 4).getTime() });
  assert.equal(f2.queue.length, 4);
  gh.offline = false; f2.offline = false;
  await f2.flush();
  assert.equal(f2.queue.length, 0);
  assert.equal(gh.files.get('live/2026-10-24.jsonl').text, '{"n":1}\n{"n":2}\n');
  assert.equal(gh.files.get('live/2026-10-25.jsonl').text, '{"n":3}\n');
  assert.equal(JSON.parse(gh.files.get('sessions/2026-10-24_070000.json').text).session_id, 'sess-1');
  const puts = gh.log.filter((l) => l.method === 'PUT').map((l) => l.path.split('/contents/')[1]);
  assert.deepEqual(puts, ['live/2026-10-24.jsonl', 'live/2026-10-25.jsonl', 'sessions/2026-10-24_070000.json'], 'in order, same-day readings batched');
  assert.equal(f2.statusText().text, 'Synced 07:04');
});
test('Feed: refuses to send to a public repo; test() warns', async () => {
  const gh = mockGitHub({ isPrivate: false }); const ls = new MemStorage();
  const f = new Feed({ storage: ls, fetchImpl: gh.fetchImpl });
  f.setToken('t'); f.setEnabled(true);
  const r = await f.test(); assert.equal(r.ok, false); assert.equal(r.warn, true); assert.match(r.msg, /PUBLIC/);
  f.enqueueReading({ n: 1 }, Date.now()); await f.flush();
  assert.equal(gh.log.filter((l) => l.method === 'PUT').length, 0); assert.equal(f.queue.length, 1);
  assert.match(f.statusText().text, /public – not sending – 1 queued/);
});
test('Feed: HTTP errors keep the queue and show a readable status; token never in status', async () => {
  const ls = new MemStorage();
  const f = new Feed({ storage: ls, fetchImpl: async () => ({ ok: false, status: 401, text: async () => '' }) });
  f.setToken('secret-token-xyz'); f.setEnabled(true); f.enqueueReading({ n: 1 }, Date.now());
  await f.flush();
  const st = f.statusText().text;
  assert.match(st, /401/); assert.match(st, /1 queued/); assert.ok(!st.includes('secret-token-xyz'));
  assert.equal((await f.test()).ok, false);
});
