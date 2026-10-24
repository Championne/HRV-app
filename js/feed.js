// Rolling HRV feed to a PRIVATE GitHub repository (for Vita). Off unless a token is set and the feed is switched on.
// Only derived numbers leave the phone (one reading every 2 min + a summary per session); raw RR data never does.
// The token lives only in this browser's localStorage. It is never logged and never written to any repository.
import { filterRR, hrvStats, hrvScore, scoreZone, sessionSummary, sessionFileBase } from './hrv.js';

export const DEFAULT_REPO = 'Championne/hrv-sessions';
export const FEED_INTERVAL_MS = 120000;
export const API = 'https://api.github.com';
export const KEYS = { token: 'hrvFeed.token', repo: 'hrvFeed.repo', enabled: 'hrvFeed.enabled', queue: 'hrvFeed.queue', lastSync: 'hrvFeed.lastSync' };
const QUEUE_MAX = 5000; // ~7 days of 2-min readings; oldest dropped beyond this

// ------------------------------------------------------------------ helpers (pure)
const p2 = (n) => String(n).padStart(2, '0');
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);

/** ISO 8601 in local time with the UTC offset, e.g. 2026-10-24T16:30:00+01:00. */
export function isoLocal(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}
/** Local calendar date YYYY-MM-DD (the daily JSONL file name). */
export function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
export const livePath = (ms) => `live/${localDate(ms)}.jsonl`;
export const summaryPath = (session) => `sessions/${sessionFileBase(session)}.json`;

/** UTF-8 safe base64 (btoa alone breaks on non-Latin-1 text). */
export function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** One rolling reading.
 *  @param {object} o
 *  @param {number} o.t          now (ms)
 *  @param {object} o.session    the recording session ({id, beats:[{t,hr,rr,contact}]})
 *  @param {number} o.since      start of this interval (ms; previous reading or session start)
 *  @param {number[]} o.windowRR RR intervals of the last 60 s (same window as the live RMSSD on screen)
 *  @param {boolean|null} o.contact latest skin-contact flag
 *  HR avg/min/max and clean_beats/artefacts cover the interval since the last reading (normally 2 min);
 *  RMSSD/SDNN/ln RMSSD/score cover the last 60 s, exactly like the live screen. */
export function buildReading({ t, session, since, windowRR, contact }) {
  const inInt = session.beats.filter((b) => b.t > since && b.t <= t);
  const seen = new Set(), hrs = [];
  for (const b of inInt) if (!seen.has(b.t)) { seen.add(b.t); if (b.hr > 0) hrs.push(b.hr); } // one HR per packet
  const rrInt = inInt.filter((b) => b.rr != null).map((b) => b.rr);
  const clean = filterRR(rrInt).clean.length;
  const s = hrvStats(windowRR || []);
  const score = s.clean_beats >= 20 ? hrvScore(s.ln_rmssd) : null;
  return {
    ts: isoLocal(t),
    session_id: session.id,
    hr_avg_2min: hrs.length ? r1(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
    hr_min: hrs.length ? Math.min(...hrs) : null,
    hr_max: hrs.length ? Math.max(...hrs) : null,
    rmssd_ms: r1(s.rmssd_ms),
    sdnn_ms: r1(s.sdnn_ms),
    ln_rmssd: r2(s.ln_rmssd),
    score: score == null ? null : Math.round(score),
    zone: scoreZone(score).key,
    clean_beats: clean,
    artefacts: rrInt.length - clean,
    contact: contact ?? null,
  };
}

/** Full end-of-session summary (no raw RR). */
export function buildSummary(session) {
  const sum = session.summary || sessionSummary(session);
  const end = session.end ?? Date.now();
  const score = sum.ln_rmssd == null ? null : hrvScore(sum.ln_rmssd);
  return {
    session_id: session.id,
    start: isoLocal(session.start),
    end: isoLocal(end),
    duration_s: Math.round((end - session.start) / 1000),
    duration_min: sum.duration_min,
    hr_mean: sum.mean_hr, hr_min: sum.min_hr, hr_max: sum.max_hr,
    rmssd_ms: sum.rmssd_ms, sdnn_ms: sum.sdnn_ms, ln_rmssd: sum.ln_rmssd, pnn50_pct: sum.pnn50_pct,
    score: score == null ? null : Math.round(score), zone: scoreZone(score).key,
    beats: sum.beats, clean_beats: sum.clean_beats, artefacts: sum.beats - sum.clean_beats,
    reconnects: sum.reconnects, device: sum.device, simulated: !!session.simulated, source: 'hrv-phone',
  };
}

/** Append JSONL lines to existing file text, skipping lines already present (makes a retried PUT idempotent). */
export function appendJsonl(existing, lines) {
  let text = existing || '';
  const have = new Set(text.split('\n'));
  const add = lines.filter((l) => !have.has(l));
  if (!add.length) return { text, added: 0 };
  if (text && !text.endsWith('\n')) text += '\n';
  return { text: text + add.join('\n') + '\n', added: add.length };
}

// ------------------------------------------------------------------ GitHub contents API
export class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
function friendly(status, body) {
  if (status === 401) return 'token rejected (401) – check or renew it';
  if (status === 403) return /rate limit/i.test(body) ? 'GitHub rate limit – will retry' : 'no permission (403) – token needs Contents: Read and write on this repo';
  if (status === 404) return 'repo not found, or the token has no access to it (404)';
  return `GitHub error ${status}`;
}

export class GitHubClient {
  constructor({ token, repo, fetchImpl }) {
    this.token = token; this.repo = repo; this.fetch = fetchImpl || ((...a) => fetch(...a));
  }
  async req(method, path, body) {
    const res = await this.fetch(`${API}${path}`, {
      method, cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: {
        Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }
  async repoInfo() {
    const res = await this.req('GET', `/repos/${this.repo}`);
    if (!res.ok) throw new HttpError(res.status, friendly(res.status, await res.text().catch(() => '')));
    return res.json();
  }
  contentsPath(path) { return `/repos/${this.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`; }
  /** @returns {Promise<{sha:string,text:string}|null>} null when the file does not exist yet */
  async getFile(path) {
    const res = await this.req('GET', this.contentsPath(path));
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(res.status, friendly(res.status, await res.text().catch(() => '')));
    const j = await res.json();
    let text = j.content != null && j.encoding === 'base64' ? b64decode(j.content) : null;
    if (text == null && j.download_url) text = await (await this.fetch(j.download_url, { cache: 'no-store' })).text(); // >1 MB files
    return { sha: j.sha, text: text || '' };
  }
  async putFile(path, text, sha, message) {
    const res = await this.req('PUT', this.contentsPath(path), { message, content: b64encode(text), ...(sha ? { sha } : {}) });
    if (!res.ok) throw new HttpError(res.status, friendly(res.status, await res.text().catch(() => '')));
    return res.json();
  }
  /** GET → append → PUT with sha (create on 404). Retries once on a 409/422 sha conflict. */
  async appendLines(path, lines, message) {
    for (let attempt = 0; ; attempt++) {
      const cur = await this.getFile(path);
      const { text, added } = appendJsonl(cur ? cur.text : '', lines);
      if (!added) return { added: 0 };
      try { await this.putFile(path, text, cur && cur.sha, message); return { added }; }
      catch (e) { if (attempt === 0 && (e.status === 409 || e.status === 422)) continue; throw e; }
    }
  }
  /** Create or overwrite a JSON file. Retries once on a 409/422 sha conflict. */
  async putJson(path, obj, message) {
    const text = JSON.stringify(obj, null, 2) + '\n';
    for (let attempt = 0; ; attempt++) {
      const cur = await this.getFile(path);
      if (cur && cur.text === text) return;
      try { await this.putFile(path, text, cur && cur.sha, message); return; }
      catch (e) { if (attempt === 0 && (e.status === 409 || e.status === 422)) continue; throw e; }
    }
  }
}

// ------------------------------------------------------------------ settings + offline queue + flushing
export class Feed {
  /** @param {{storage?:Storage, fetchImpl?:Function, onStatus?:Function, clock?:Function}} o */
  constructor({ storage, fetchImpl, onStatus, clock } = {}) {
    this.ls = storage || globalThis.localStorage;
    this.fetchImpl = fetchImpl; this.onStatus = onStatus || (() => {}); this.clock = clock || Date.now;
    this.flushing = null; this.lastError = null; this.offline = false; this.repoChecked = null;
  }
  get token() { return this.ls.getItem(KEYS.token) || ''; }
  get repo() { return this.ls.getItem(KEYS.repo) || DEFAULT_REPO; }
  get enabled() { return this.ls.getItem(KEYS.enabled) === '1'; }
  /** Feed is active only with a token AND the switch on. */
  get active() { return this.enabled && !!this.token; }
  setToken(t) { t = (t || '').trim(); if (t) this.ls.setItem(KEYS.token, t); else this.ls.removeItem(KEYS.token); this.repoChecked = null; this.status(); }
  setRepo(r) { r = (r || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, ''); this.ls.setItem(KEYS.repo, r || DEFAULT_REPO); this.repoChecked = null; this.status(); }
  setEnabled(on) { this.ls.setItem(KEYS.enabled, on ? '1' : '0'); this.status(); if (on) this.flush(); }
  client() { return new GitHubClient({ token: this.token, repo: this.repo, fetchImpl: this.fetchImpl }); }

  get queue() { try { return JSON.parse(this.ls.getItem(KEYS.queue) || '[]'); } catch { return []; } }
  saveQueue(q) { if (q.length > QUEUE_MAX) q = q.slice(q.length - QUEUE_MAX); this.ls.setItem(KEYS.queue, JSON.stringify(q)); }
  enqueueReading(reading, t) {
    if (!this.active) return false;
    const q = this.queue; q.push({ kind: 'reading', path: livePath(t), line: JSON.stringify(reading) }); this.saveQueue(q);
    return true;
  }
  enqueueSummary(session) {
    if (!this.active) return false;
    const q = this.queue; q.push({ kind: 'summary', path: summaryPath(session), obj: buildSummary(session) }); this.saveQueue(q);
    return true;
  }

  /** Test connection: GET the repo. Never sends health data. */
  async test() {
    if (!this.token) return { ok: false, msg: 'Enter a token first.' };
    try {
      const r = await this.client().repoInfo();
      if (!r.private) return { ok: false, warn: true, msg: `⚠ ${r.full_name} is PUBLIC. Make it private first – the feed will not send health data to a public repo.` };
      const canWrite = !r.permissions || r.permissions.push !== false;
      this.repoChecked = true;
      return canWrite ? { ok: true, msg: `✓ Connected to ${r.full_name} (private).` } : { ok: false, msg: `Connected to ${r.full_name}, but the token can't write (needs Contents: Read and write).` };
    } catch (e) {
      return { ok: false, msg: e instanceof HttpError ? e.message : 'No connection to GitHub (offline?).' };
    }
  }

  /** Send queued items in order. Consecutive readings for the same day go in one commit. */
  flush() {
    if (this.flushing) { this.again = true; return this.flushing; } // re-run once the current pass ends
    this.flushing = (async () => {
      do { this.again = false; await this._flush(); } while (this.again && !this.offline && !this.lastError);
    })().finally(() => { this.flushing = null; this.status(); });
    return this.flushing;
  }
  async _flush() {
    if (!this.active || !this.queue.length) return;
    const gh = this.client();
    try {
      if (!this.repoChecked) { // privacy guard: never send to a public repo
        const info = await gh.repoInfo();
        if (!info.private) { this.lastError = `${info.full_name} is public – not sending`; return; }
        this.repoChecked = true;
      }
      for (let q = this.queue; q.length; q = this.queue) {
        const head = q[0];
        let n = 1;
        if (head.kind === 'reading') {
          while (n < q.length && q[n].kind === 'reading' && q[n].path === head.path) n++;
          const lines = q.slice(0, n).map((x) => x.line);
          await gh.appendLines(head.path, lines, `HRV readings ${head.path.slice(5, 15)} (+${lines.length})`);
        } else {
          await gh.putJson(head.path, head.obj, `HRV session ${head.path.slice(9, -5)}`);
        }
        // Drop what was sent; re-read so items queued meanwhile are kept.
        const now = this.queue; now.splice(0, n); this.saveQueue(now);
        this.ls.setItem(KEYS.lastSync, String(this.clock()));
      }
      this.lastError = null; this.offline = false;
    } catch (e) {
      if (e instanceof HttpError) { this.lastError = e.message; this.offline = false; if (e.status === 401 || e.status === 404) this.repoChecked = null; }
      else { this.offline = true; this.lastError = null; } // fetch() TypeError = no network
    }
  }

  /** Status line text shown near the timer. */
  statusText() {
    if (!this.active) return { text: 'Feed off', kind: 'off' };
    const n = this.queue.length;
    if (this.offline) return { text: `Offline – ${n} queued`, kind: 'warn' };
    if (this.lastError) return { text: `Feed error: ${this.lastError}${n ? ` – ${n} queued` : ''}`, kind: 'err' };
    const last = Number(this.ls.getItem(KEYS.lastSync)) || 0;
    if (n) return { text: `Sending… ${n} queued`, kind: 'wait' };
    if (last) { const d = new Date(last); return { text: `Synced ${p2(d.getHours())}:${p2(d.getMinutes())}`, kind: 'ok' }; }
    return { text: 'Feed on – waiting for first reading', kind: 'wait' };
  }
  status() { const s = this.statusText(); this.onStatus(s); return s; }
}
