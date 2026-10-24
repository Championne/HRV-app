import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseHeartRate, filterRR, hrvStats, hrvScore, scoreZone, sessionCsv, sessionSummary } from '../js/hrv.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('parse: uint8 HR, no RR, no contact support', () => {
  const m = parseHeartRate([0x00, 72]);
  assert.deepEqual(m, { hr: 72, rr: [], contact: null, energy: null });
});
test('parse: uint8 HR + contact detected + 2 RR (Polar H10 typical 0x16)', () => {
  // RR raw 1024 -> 1000 ms, 820 -> 800.78125 ms
  const m = parseHeartRate([0x16, 60, 0x00, 0x04, 0x34, 0x03]);
  assert.equal(m.hr, 60); assert.equal(m.contact, true);
  assert.deepEqual(m.rr, [1000, 820 * 1000 / 1024]);
});
test('parse: contact supported but not detected (0x14)', () => {
  assert.equal(parseHeartRate([0x14, 80]).contact, false);
});
test('parse: uint16 HR + energy expended + RR', () => {
  const m = parseHeartRate(new DataView(Uint8Array.of(0x19, 0x2c, 0x01, 0x10, 0x00, 0x00, 0x02).buffer));
  assert.equal(m.hr, 300); assert.equal(m.energy, 16); assert.deepEqual(m.rr, [500]);
});
test('parse: odd trailing byte is ignored; DataView with offset works', () => {
  const buf = Uint8Array.of(0xff, 0x10, 70, 0x00, 0x04, 0x99).buffer;
  const m = parseHeartRate(new DataView(buf, 1));
  assert.equal(m.hr, 70); assert.deepEqual(m.rr, [1000]);
});
test('parse: too short throws', () => assert.throws(() => parseHeartRate([0x10])));

test('filter: drops out-of-range and >20% jumps', () => {
  const rr = [900, 910, 250, 905, 2500, 895, 1700, 900, 910, 450, 905];
  const { clean, flags } = filterRR(rr);
  assert.deepEqual(clean, [900, 910, 905, 895, 900, 910, 905]);
  assert.deepEqual(flags, [true, true, false, true, false, true, false, true, true, false, true]);
});

test('stats: hand-computed RMSSD / SDNN / pNN50', () => {
  const s = hrvStats([800, 860, 780, 840]);
  // diffs 60,-80,60 -> rmssd sqrt((3600+6400+3600)/3)
  near(s.rmssd_ms, Math.sqrt(13600 / 3));
  near(s.mean_rr_ms, 820); near(s.mean_hr, 60000 / 820);
  near(s.sdnn_ms, Math.sqrt((400 + 1600 + 1600 + 400) / 3));
  near(s.pnn50_pct, 100); near(s.ln_rmssd, Math.log(Math.sqrt(13600 / 3)));
  assert.equal(s.beats, 4); assert.equal(s.clean_beats, 4);
});
test('stats: fewer than 3 clean beats -> no HRV keys', () => {
  const s = hrvStats([900, 910]);
  assert.equal(s.rmssd_ms, undefined); assert.equal(s.clean_beats, 2);
});
test('score + zones', () => {
  near(hrvScore(6.5), 100); near(hrvScore(0), 0); assert.equal(hrvScore(null), null);
  assert.equal(hrvScore(8), 100);
  assert.equal(scoreZone(30).key, 'low'); assert.equal(scoreZone(50).key, 'mid');
  assert.equal(scoreZone(60).key, 'good'); assert.equal(scoreZone(80).key, 'high'); assert.equal(scoreZone(null).key, 'none');
});

function fakeSession() {
  const start = new Date(2026, 9, 24, 15, 0, 0).getTime();
  const beats = [];
  let t = start;
  const rrs = [900, 950, 880, 400, 920, 970, 890, 930];
  rrs.forEach((rr, k) => { t += rr; beats.push({ t, el: (t - start) / 1000, hr: 65 + (k % 3), rr, contact: true }); });
  beats.push({ t: t + 1000, el: (t + 1000 - start) / 1000, hr: 64, rr: null, contact: false });
  return { id: 'x', start, end: t + 2000, device: 'Polar H10 TEST', beats, reconnects: 2 };
}
test('CSV: laptop-tool columns, one row per beat', () => {
  const csv = sessionCsv(fakeSession()).trim().split('\r\n');
  assert.equal(csv[0], 'time,elapsed_s,hr_bpm,rr_ms,contact');
  assert.equal(csv.length, 1 + 9);
  assert.equal(csv[1], '2026-10-24T15:00:00.900,0.90,65,900.0,True');
  assert.match(csv[9], /^2026-10-24T15:00:0\d\.\d{3},\d+\.\d\d,64,,False$/);
});
test('summary: sessions.csv fields', () => {
  const s = sessionSummary(fakeSession());
  for (const k of ['start', 'duration_min', 'device', 'mean_hr', 'min_hr', 'max_hr', 'rmssd_ms', 'ln_rmssd', 'sdnn_ms', 'pnn50_pct', 'beats', 'clean_beats', 'reconnects', 'file'])
    assert.ok(k in s, k);
  assert.equal(s.start, '2026-10-24T15:00:00');
  assert.equal(s.min_hr, 64); assert.equal(s.max_hr, 67);
  assert.equal(s.beats, 8); assert.equal(s.clean_beats, 7); assert.equal(s.reconnects, 2);
  assert.equal(s.file, '2026-10-24_150000_hr.csv');
});

// Cross-check against the laptop tool's Python implementation (same numbers on phone and laptop).
const PY = '/workspace/polar-hrv/polar_hrv.py';
test('matches polar_hrv.py hrv_stats + parser on random data', { skip: !existsSync(PY) && 'laptop tool source not on box' }, () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let trial = 0; trial < 5; trial++) {
    const rr = Array.from({ length: 300 }, () => { let x = 850 + (rnd() - 0.5) * 120; const u = rnd(); if (u < 0.03) x *= 0.5; else if (u < 0.05) x *= 1.9; else if (u < 0.06) x = 2500; return Math.round(x * 10) / 10; });
    const packet = [0x16, 71, ...rr.slice(0, 3).flatMap((ms) => { const v = Math.round(ms * 1024 / 1000); return [v & 255, v >> 8]; })];
    const py = JSON.parse(execFileSync('python3', ['-c', `
import sys, json, importlib.util
spec = importlib.util.spec_from_file_location("p", "${PY}"); p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
d = json.load(sys.stdin)
hr, rrs, c = p.parse_hr_measurement(bytes(d["packet"]))
print(json.dumps({"stats": p.hrv_stats(d["rr"]), "parse": [hr, rrs, c]}))`], { input: JSON.stringify({ rr, packet }) }).toString());
    const js = hrvStats(rr);
    for (const k of ['beats', 'clean_beats', 'mean_rr_ms', 'mean_hr', 'rmssd_ms', 'sdnn_ms', 'pnn50_pct', 'ln_rmssd']) near(js[k], py.stats[k], 1e-9);
    const m = parseHeartRate(packet);
    assert.equal(m.hr, py.parse[0]); assert.equal(m.contact, py.parse[2]);
    m.rr.forEach((x, i) => near(x, py.parse[1][i], 1e-9));
  }
});
