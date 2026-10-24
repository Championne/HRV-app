import { parseHeartRate, filterRR, hrvStats, hrvScore, scoreZone, sessionCsv, sessionSummary, sessionFileBase, localIso } from './hrv.js';
import { saveSession, listSessions, deleteSession, getSession, persist } from './store.js';
import { SIM, SPEED, now, fakeBluetooth } from './sim.js';
import { drawGauge, drawTacho } from './charts.js';
import { Feed, FEED_INTERVAL_MS, buildReading, DEFAULT_REPO } from './feed.js';

const APP_VERSION = '1.1.0';
const WINDOW_MS = 60000;       // rolling RMSSD window
const TACHO_MS = 120000;       // tachogram span
const UPDATE_MS = 2000;        // HRV refresh (real time)
const AUTOSAVE_MS = 15000;
const BACKOFF_MIN = 1000, BACKOFF_MAX = 30000, CONNECT_TIMEOUT = 20000;
// Rolling feed interval (real time). ?feedInterval=<ms> is honoured in simulation mode only (tests).
const FEED_MS = (() => {
  const v = Number(new URLSearchParams(location.search).get('feedInterval'));
  return SIM && v >= 500 ? v : FEED_INTERVAL_MS;
})();

const $ = (id) => document.getElementById(id);
const bt = SIM ? fakeBluetooth : navigator.bluetooth;

const state = {
  device: null, hrChar: null, batChar: null, connected: false, userDisconnect: false,
  reconnectTimer: null, backoff: BACKOFF_MIN, liveReconnects: 0,
  live: [],            // [{t, rr}] beat-timed RR for last TACHO_MS
  lastHr: null, lastContact: null, lastPacket: 0,
  session: null, autosaveTimer: null, wakeLock: null,
  feedTimer: null, feedSince: 0,
};

const feed = new Feed({ onStatus: renderFeedStatus });

// ------------------------------------------------------------------ UI helpers
function banner(msg, kind = '') {
  const b = $('banner');
  if (!msg) { b.classList.add('hidden'); return; }
  b.textContent = msg; b.className = 'banner ' + kind;
}
function setConn(mode, text) {
  $('conn-dot').className = 'dot ' + mode;
  $('conn-text').textContent = text;
}
const fmt = (v, d = 0) => (v == null || !isFinite(v) ? '–' : v.toFixed(d));
function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
function showView(v) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('hidden', s.id !== 'view-' + v));
  if (v === 'sessions') renderSessions();
}

// ------------------------------------------------------------------ Bluetooth
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))]);

async function connectClicked() {
  if (state.connected || state.reconnectTimer) { userDisconnect(); return; }
  banner('');
  try {
    const device = await bt.requestDevice({
      filters: [{ namePrefix: 'Polar' }],
      optionalServices: ['heart_rate', 'battery_service'],
    });
    state.device = device;
    state.userDisconnect = false;
    device.addEventListener('gattserverdisconnected', onDisconnected);
    await openGatt();
  } catch (e) {
    if (e && e.name === 'NotFoundError') { setConn('off', 'No strap chosen'); return; }
    console.error(e);
    setConn('off', 'Not connected');
    banner(`Couldn't connect: ${e.message || e}. Is the strap on with wet electrodes, and is Elite HRV closed?`, 'err');
  }
  updateButtons();
}

async function openGatt() {
  setConn('wait', 'Connecting…');
  const server = await withTimeout(state.device.gatt.connect(), CONNECT_TIMEOUT, 'Connect');
  const hrs = await server.getPrimaryService('heart_rate');
  const ch = await hrs.getCharacteristic('heart_rate_measurement');
  ch.addEventListener('characteristicvaluechanged', onHrValue);
  await ch.startNotifications();
  state.hrChar = ch;
  state.connected = true;
  state.backoff = BACKOFF_MIN;
  setConn('on', state.device.name || 'Connected');
  readBattery(server);
  requestWakeLock();
  updateButtons();
}

async function readBattery(server) {
  try {
    const bs = await server.getPrimaryService('battery_service');
    const c = await bs.getCharacteristic('battery_level');
    const show = (dv) => { const el = $('battery'); el.textContent = `🔋 ${dv.getUint8(0)}%`; el.classList.remove('hidden'); };
    show(await c.readValue());
    try { c.addEventListener('characteristicvaluechanged', (e) => show(e.target.value)); await c.startNotifications(); } catch { /* optional */ }
  } catch { /* battery service not available: fine */ }
}

function onDisconnected() {
  state.connected = false;
  if (state.hrChar) { state.hrChar.removeEventListener('characteristicvaluechanged', onHrValue); state.hrChar = null; }
  if (state.userDisconnect) { setConn('off', 'Disconnected'); updateButtons(); releaseWakeLock(); return; }
  scheduleReconnect();
}

function scheduleReconnect() {
  const d = state.backoff;
  setConn('wait', `Signal lost – reconnecting in ${Math.round(d / 1000)} s…`);
  updateButtons();
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    try {
      await openGatt();
      state.liveReconnects++;
      if (state.session) state.session.reconnects++;
      renderCounters();
    } catch (e) {
      console.warn('reconnect failed', e);
      state.backoff = Math.min(BACKOFF_MAX, state.backoff * 2);
      if (!state.userDisconnect) scheduleReconnect();
    }
  }, d);
}

function userDisconnect() {
  state.userDisconnect = true;
  clearTimeout(state.reconnectTimer); state.reconnectTimer = null;
  if (state.device && state.device.gatt.connected) state.device.gatt.disconnect();
  else { state.connected = false; setConn('off', 'Disconnected'); }
  releaseWakeLock();
  updateButtons();
}

function onHrValue(ev) {
  let m;
  try { m = parseHeartRate(ev.target.value); } catch { return; }
  const t = now();
  state.lastHr = m.hr; state.lastContact = m.contact; state.lastPacket = t;
  // Beat times for the live window: last RR in the packet ends "now".
  let tb = t;
  for (let k = m.rr.length - 1; k >= 0; k--) { state.live.push({ t: tb, rr: m.rr[k] }); tb -= m.rr[k]; }
  state.live.sort((a, b) => a.t - b.t);
  while (state.live.length && state.live[0].t < t - TACHO_MS - 5000) state.live.shift();
  if (state.session) {
    const el = (t - state.session.start) / 1000;
    if (m.rr.length) for (const rr of m.rr) state.session.beats.push({ t, el, hr: m.hr, rr, contact: m.contact });
    else state.session.beats.push({ t, el, hr: m.hr, rr: null, contact: m.contact });
  }
  $('hr').textContent = m.hr;
  const c = $('contact');
  if (m.contact === null) c.classList.add('hidden');
  else { c.classList.remove('hidden'); c.textContent = m.contact ? 'skin contact ✓' : 'no skin contact – wet the strap'; c.classList.toggle('bad', !m.contact); }
}

// ------------------------------------------------------------------ periodic refresh
function refreshHrv() {
  const t = now();
  const win = state.live.filter((p) => p.t >= t - WINDOW_MS).map((p) => p.rr);
  const s = hrvStats(win);
  $('rmssd').textContent = fmt(s.rmssd_ms);
  $('sdnn').textContent = fmt(s.sdnn_ms);
  $('lnrmssd').textContent = fmt(s.ln_rmssd, 2);
  $('pnn50').textContent = fmt(s.pnn50_pct);
  // Need ~20 clean beats before the score means anything.
  const score = s.clean_beats >= 20 ? hrvScore(s.ln_rmssd) : null;
  const z = scoreZone(score);
  $('score').textContent = score == null ? '–' : Math.round(score);
  $('zone').textContent = z.label; $('zone').className = 'zone ' + z.key;
  drawGauge($('gauge'), score);
  const vis = state.live.filter((p) => p.t >= t - TACHO_MS);
  const { flags } = filterRR(vis.map((p) => p.rr));
  drawTacho($('tacho'), vis.map((p, k) => ({ ...p, ok: flags[k] })), t, TACHO_MS);
  const bad = flags.filter((f) => !f).length;
  $('artefacts').textContent = bad ? `· ${bad} artefact${bad > 1 ? 's' : ''} ignored` : '';
  if (state.connected && state.lastPacket && t - state.lastPacket > 10000 * (SIM ? SPEED : 1)) setConn('wait', 'Connected – no data (strap on? wet electrodes?)');
  else if (state.connected) setConn('on', state.device.name || 'Connected');
}
function tick() {
  if (state.session) $('timer').textContent = mmss(now() - state.session.start);
  renderCounters();
}
function renderCounters() {
  $('beats').textContent = state.session ? state.session.beats.filter((b) => b.rr != null).length : 0;
  $('reconnects').textContent = state.session ? state.session.reconnects : state.liveReconnects;
}

// ------------------------------------------------------------------ rolling feed (Vita)
function makeReading(session, t) {
  const windowRR = state.live.filter((p) => p.t >= t - WINDOW_MS && p.t <= t).map((p) => p.rr);
  const r = buildReading({ t, session, since: state.feedSince, windowRR, contact: state.lastContact });
  state.feedSince = t;
  return r;
}
function feedTick() {
  if (!state.session) return;
  const t = now();
  if (feed.active) feed.enqueueReading(makeReading(state.session, t), t);
  else state.feedSince = t;
  feed.flush();
}
function renderFeedStatus(st) {
  const el = $('feed-status');
  if (!el) return;
  el.textContent = st.text; el.className = 'feed-status ' + st.kind;
}
function initSettings() {
  const tok = $('set-token'), repo = $('set-repo'), on = $('set-feed'), out = $('set-result');
  tok.value = feed.token; repo.value = feed.repo; repo.placeholder = DEFAULT_REPO; on.checked = feed.enabled;
  const syncToggle = () => { on.disabled = !feed.token; if (!feed.token) on.checked = false; };
  syncToggle();
  tok.addEventListener('change', () => { feed.setToken(tok.value); syncToggle(); out.textContent = feed.token ? 'Token saved on this phone.' : 'Token removed.'; out.className = 'set-result'; });
  repo.addEventListener('change', () => { feed.setRepo(repo.value); repo.value = feed.repo; });
  on.addEventListener('change', () => feed.setEnabled(on.checked));
  $('btn-test').onclick = async () => {
    feed.setToken(tok.value); feed.setRepo(repo.value); syncToggle();
    out.textContent = 'Testing…'; out.className = 'set-result';
    const r = await feed.test();
    out.textContent = r.msg; out.className = 'set-result ' + (r.ok ? 'ok' : r.warn ? 'warn' : 'err');
  };
  $('btn-clear-token').onclick = () => { tok.value = ''; feed.setToken(''); feed.setEnabled(false); syncToggle(); out.textContent = 'Token removed from this phone.'; out.className = 'set-result'; };
  window.addEventListener('online', () => { feed.offline = false; feed.flush(); });
  window.addEventListener('offline', () => { if (feed.active && feed.queue.length) { feed.offline = true; feed.status(); } });
  feed.status();
  if (feed.active && feed.queue.length) feed.flush();
}

// ------------------------------------------------------------------ sessions
function uid() { return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }

async function sessionClicked() {
  if (!state.session) {
    state.session = { id: uid(), start: now(), end: null, device: state.device ? state.device.name : '', beats: [], reconnects: 0, simulated: SIM };
    $('timer').classList.add('rec');
    state.autosaveTimer = setInterval(() => saveSession(state.session).catch(console.error), AUTOSAVE_MS);
    state.feedSince = state.session.start;
    state.feedTimer = setInterval(feedTick, FEED_MS);
    await saveSession(state.session);
    persist();
  } else {
    const s = state.session; state.session = null;
    clearInterval(state.autosaveTimer);
    clearInterval(state.feedTimer); state.feedTimer = null;
    s.end = now(); s.summary = sessionSummary(s);
    await saveSession(s);
    if (feed.active) {
      // Last partial interval (if at least 10 s), then the full summary.
      if (s.end - state.feedSince >= 10000) feed.enqueueReading(makeReading(s, s.end), s.end);
      feed.enqueueSummary(s);
      feed.flush();
    }
    $('timer').classList.remove('rec');
    banner(`Session saved: ${mmss(s.end - s.start)}, RMSSD ${fmt(s.summary.rmssd_ms, 1)} ms, ${s.summary.clean_beats} clean beats.`);
    setTimeout(() => banner(''), 6000);
  }
  updateButtons(); tick();
}

function updateButtons() {
  const linked = state.connected || !!state.reconnectTimer;
  $('btn-connect').textContent = linked ? 'Disconnect' : 'Connect strap';
  $('btn-connect').className = 'btn ' + (linked ? 'ghost' : 'primary');
  const b = $('btn-session');
  b.disabled = !state.session && !state.connected;
  b.textContent = state.session ? 'Stop & save' : 'Start session';
  b.className = 'btn ' + (state.session ? 'stop' : 'rec');
}

async function renderSessions() {
  const ul = $('session-list');
  const all = await listSessions();
  ul.innerHTML = '';
  if (!all.length) { ul.innerHTML = '<li class="empty">No sessions yet.</li>'; return; }
  for (const s of all) {
    const sum = s.summary || sessionSummary(s);
    const li = document.createElement('li');
    const d = new Date(s.start);
    li.innerHTML = `
      <div class="s-head"><span>${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}${s.simulated ? ' · sim' : ''}${s.end ? '' : ' · recording'}</span><span>${mmss((s.end || now()) - s.start)}</span></div>
      <div class="s-stats">
        <div><b>${fmt(sum.mean_hr)}</b>mean HR</div><div><b>${fmt(sum.rmssd_ms)}</b>RMSSD ms</div><div><b>${fmt(sum.sdnn_ms)}</b>SDNN ms</div>
        <div><b>${sum.min_hr ?? '–'}–${sum.max_hr ?? '–'}</b>HR range</div><div><b>${fmt(sum.pnn50_pct)}</b>pNN50 %</div><div><b>${sum.clean_beats}/${sum.beats}</b>clean beats</div>
      </div>
      <div class="s-actions"><button data-a="csv">Share CSV</button><button data-a="json">Share JSON</button><button class="del" data-a="del">Delete</button></div>`;
    li.querySelector('[data-a=csv]').onclick = () => exportSession(s.id, 'csv');
    li.querySelector('[data-a=json]').onclick = () => exportSession(s.id, 'json');
    li.querySelector('[data-a=del]').onclick = async () => {
      if (state.session && state.session.id === s.id) { alert('Stop the session first.'); return; }
      if (confirm('Delete this session from the phone? This cannot be undone.')) { await deleteSession(s.id); renderSessions(); }
    };
    ul.appendChild(li);
  }
}

async function exportSession(id, kind) {
  const s = (state.session && state.session.id === id) ? state.session : await getSession(id);
  const base = sessionFileBase(s);
  const file = kind === 'csv'
    ? new File([sessionCsv(s)], `${base}_hr.csv`, { type: 'text/csv' })
    : new File([JSON.stringify(s.summary || sessionSummary(s), null, 2) + '\n'], `${base}_summary.json`, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: file.name }); return; }
  } catch (e) { if (e.name === 'AbortError') return; console.warn('share failed, downloading', e); }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a'); a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Sessions left "recording" by a crash/closed tab: close them at their last beat.
async function recoverOpenSessions() {
  for (const s of await listSessions()) {
    if (!s.end) {
      s.end = s.beats.length ? s.beats[s.beats.length - 1].t : s.start;
      s.recovered = true; s.summary = sessionSummary(s);
      await saveSession(s);
    }
  }
}

// ------------------------------------------------------------------ wake lock
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    $('wake-hint').textContent = 'Screen kept awake while connected. If it still dims, enable keep-awake in Bluefy settings.';
  } catch { /* not allowed: the hint stays */ }
}
function releaseWakeLock() { if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; } }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (state.connected || state.session)) requestWakeLock();
  if (document.visibilityState === 'hidden' && state.session) saveSession(state.session).catch(() => {});
});
window.addEventListener('pagehide', () => { if (state.session) saveSession(state.session).catch(() => {}); });

// ------------------------------------------------------------------ init
async function init() {
  $('version').textContent = `Version ${APP_VERSION}${SIM ? ` · SIMULATION (speed ${SPEED}x)` : ''}`;
  $('btn-connect').onclick = connectClicked;
  $('btn-session').onclick = sessionClicked;
  if (SIM) banner(`Simulation mode – fake strap data${SPEED > 1 ? `, ${SPEED}x speed` : ''}.`);
  else if (!bt) {
    banner('This browser has no Bluetooth for web pages. On iPhone, open this page in the Bluefy browser (free in the App Store).', 'err');
    $('btn-connect').disabled = true;
  } else if (bt.getAvailability) {
    bt.getAvailability().then((ok) => { if (!ok) banner('Bluetooth looks off or not allowed for Bluefy. Turn it on in iPhone Settings.', 'err'); }).catch(() => {});
  }
  drawGauge($('gauge'), null);
  drawTacho($('tacho'), [], now());
  updateButtons();
  setInterval(refreshHrv, UPDATE_MS);
  setInterval(tick, 1000);
  recoverOpenSessions().catch(console.error);
  initSettings();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}
init();

// For headless tests only.
window.__hrv = { state, localIso, feed, FEED_MS };
