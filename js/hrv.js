// Pure functions: BLE Heart Rate Measurement parsing + HRV math.
// Mirrors polar_hrv.py (laptop tool) so phone and laptop numbers match.

/** Parse a Heart Rate Measurement characteristic (0x2A37) value.
 *  @param {DataView|Uint8Array|ArrayBuffer|number[]} value
 *  @returns {{hr:number, rr:number[], contact:(boolean|null), energy:(number|null)}}
 *  rr is in milliseconds (raw unit is 1/1024 s). */
export function parseHeartRate(value) {
  let bytes;
  if (value instanceof DataView) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else bytes = Uint8Array.from(value);
  if (bytes.length < 2) throw new Error('HR measurement too short');
  const u16 = (i) => bytes[i] | (bytes[i + 1] << 8);
  const flags = bytes[0];
  let i = 1;
  let hr;
  if (flags & 0x01) { hr = u16(i); i += 2; } else { hr = bytes[i]; i += 1; }
  const contact = (flags & 0x04) ? Boolean(flags & 0x02) : null;
  let energy = null;
  if (flags & 0x08) { energy = u16(i); i += 2; }
  const rr = [];
  if (flags & 0x10) {
    while (i + 1 < bytes.length) { rr.push(u16(i) * 1000 / 1024); i += 2; }
  }
  return { hr, rr, contact, energy };
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length, m = n >> 1;
  return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/** Artefact filter: keep 300-2000 ms, then drop beats >20 % off the local median (±5 beats).
 *  Returns {clean:number[], flags:boolean[]} where flags[k] is true if rr[k] was kept. */
export function filterRR(rr) {
  const flags = rr.map(() => false);
  const inRangeIdx = [];
  rr.forEach((x, k) => { if (x >= 300 && x <= 2000) inRangeIdx.push(k); });
  const inRange = inRangeIdx.map((k) => rr[k]);
  const clean = [];
  inRange.forEach((x, k) => {
    const med = median(inRange.slice(Math.max(0, k - 5), k + 6));
    if (Math.abs(x - med) <= 0.2 * med) { clean.push(x); flags[inRangeIdx[k]] = true; }
  });
  return { clean, flags };
}

/** HRV statistics over a list of RR intervals (ms). Same keys as polar_hrv.py hrv_stats(). */
export function hrvStats(rr) {
  const { clean } = filterRR(rr);
  const out = { beats: rr.length, clean_beats: clean.length };
  if (clean.length >= 3) {
    const diffs = [];
    for (let k = 1; k < clean.length; k++) diffs.push(clean[k] - clean[k - 1]);
    const m = mean(clean);
    out.mean_rr_ms = m;
    out.mean_hr = 60000 / m;
    out.rmssd_ms = Math.sqrt(mean(diffs.map((d) => d * d)));
    out.sdnn_ms = Math.sqrt(clean.reduce((s, x) => s + (x - m) ** 2, 0) / (clean.length - 1)); // sample SD
    out.pnn50_pct = 100 * diffs.filter((d) => Math.abs(d) > 50).length / diffs.length;
    out.ln_rmssd = out.rmssd_ms > 0 ? Math.log(out.rmssd_ms) : null;
  }
  return out;
}

/** 0-100 HRV score from ln(RMSSD) (common "ln RMSSD x ~15.4" scale; ln 6.5 -> 100). */
export function hrvScore(lnRmssd) {
  if (lnRmssd == null || !isFinite(lnRmssd)) return null;
  return Math.max(0, Math.min(100, lnRmssd * (100 / 6.5)));
}

/** Readiness / stress zone for a score. Generic population bands; a personal baseline is better. */
export function scoreZone(score) {
  if (score == null) return { key: 'none', label: 'Collecting…' };
  if (score < 40) return { key: 'low', label: 'High stress / low' };
  if (score < 55) return { key: 'mid', label: 'Moderate' };
  if (score < 70) return { key: 'good', label: 'Good' };
  return { key: 'high', label: 'Relaxed / recovered' };
}

/** Local ISO timestamp with ms and no zone, like Python datetime.isoformat(timespec="milliseconds"). */
export function localIso(ms, withMs = true) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return withMs ? `${base}.${p(d.getMilliseconds(), 3)}` : base;
}

const pyBool = (c) => (c === true ? 'True' : c === false ? 'False' : 'None');

/** Per-beat CSV with the laptop tool's columns: time, elapsed_s, hr_bpm, rr_ms, contact. */
export function sessionCsv(session) {
  const lines = ['time,elapsed_s,hr_bpm,rr_ms,contact'];
  for (const b of session.beats) {
    lines.push([localIso(b.t), b.el.toFixed(2), b.hr, b.rr == null ? '' : b.rr.toFixed(1), pyBool(b.contact)].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Session summary with the same fields as the laptop tool's sessions.csv. */
export function sessionSummary(session) {
  const rr = session.beats.filter((b) => b.rr != null).map((b) => b.rr);
  const hrs = session.beats.map((b) => b.hr);
  const s = hrvStats(rr);
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const end = session.end ?? (session.beats.length ? session.beats[session.beats.length - 1].t : session.start);
  return {
    start: localIso(session.start, false),
    duration_min: r1((end - session.start) / 60000),
    device: session.device || '',
    mean_hr: r1(s.mean_hr ?? (hrs.length ? mean(hrs) : null)),
    min_hr: hrs.length ? Math.min(...hrs) : null,
    max_hr: hrs.length ? Math.max(...hrs) : null,
    rmssd_ms: r1(s.rmssd_ms),
    ln_rmssd: s.ln_rmssd == null ? null : Math.round(s.ln_rmssd * 100) / 100,
    sdnn_ms: r1(s.sdnn_ms),
    pnn50_pct: r1(s.pnn50_pct),
    beats: s.beats,
    clean_beats: s.clean_beats,
    reconnects: session.reconnects || 0,
    file: sessionFileBase(session) + '_hr.csv',
    source: 'hrv-phone',
  };
}

export function sessionFileBase(session) {
  const d = new Date(session.start);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
