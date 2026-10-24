// Canvas drawing: readiness gauge and RR tachogram. No libraries.
const ZONES = [[0, 40, '#ff5d5d'], [40, 55, '#ffc145'], [55, 70, '#3ddc84'], [70, 100, '#6ee7b7']];

export function drawGauge(cv, score) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H - 30, r = Math.min(W / 2 - 30, H - 50), lw = 34;
  const ang = (v) => Math.PI + (v / 100) * Math.PI;
  g.lineWidth = lw; g.lineCap = 'butt';
  for (const [a, b, col] of ZONES) {
    g.strokeStyle = col; g.globalAlpha = 0.28;
    g.beginPath(); g.arc(cx, cy, r, ang(a) + 0.01, ang(b) - 0.01); g.stroke();
  }
  g.globalAlpha = 1;
  if (score != null) {
    const col = (ZONES.find(([a, b]) => score >= a && score < b) || ZONES[3])[2];
    g.strokeStyle = col; g.lineCap = 'round';
    g.beginPath(); g.arc(cx, cy, r, ang(0) + 0.01, ang(Math.max(1, score))); g.stroke();
    const a = ang(score);
    g.fillStyle = '#e9eef5';
    g.beginPath(); g.arc(cx + r * Math.cos(a), cy + r * Math.sin(a), lw / 2 + 4, 0, 2 * Math.PI); g.fill();
  }
  g.fillStyle = '#8b98a8'; g.font = '22px -apple-system, sans-serif'; g.textAlign = 'center';
  g.textAlign = 'left'; g.fillText('stress', cx - r - lw / 2, cy + 28);
  g.textAlign = 'right'; g.fillText('relaxed', cx + r + lw / 2, cy + 28);
}

/** points: [{t, rr, ok}] ; windowMs: visible span ending at tEnd */
export function drawTacho(cv, points, tEnd, windowMs = 120000) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const padL = 56, padR = 8, padT = 10, padB = 28;
  const vis = points.filter((p) => p.t >= tEnd - windowMs);
  const good = vis.filter((p) => p.ok).map((p) => p.rr);
  let lo = 600, hi = 1100;
  if (good.length > 3) {
    lo = Math.min(...good); hi = Math.max(...good);
    const pad = Math.max(40, (hi - lo) * 0.15); lo = Math.floor((lo - pad) / 50) * 50; hi = Math.ceil((hi + pad) / 50) * 50;
  }
  const x = (t) => padL + ((t - (tEnd - windowMs)) / windowMs) * (W - padL - padR);
  const y = (v) => padT + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (H - padT - padB);
  g.strokeStyle = '#26303d'; g.fillStyle = '#8b98a8'; g.lineWidth = 1; g.font = '20px -apple-system, sans-serif'; g.textAlign = 'right';
  const step = (hi - lo) > 400 ? 200 : (hi - lo) > 200 ? 100 : 50;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    g.beginPath(); g.moveTo(padL, y(v)); g.lineTo(W - padR, y(v)); g.stroke();
    g.fillText(String(v), padL - 8, y(v) + 7);
  }
  g.textAlign = 'center';
  for (let s = 0; s <= windowMs / 1000; s += 30) {
    g.textAlign = s === 0 ? 'right' : s === windowMs / 1000 ? 'left' : 'center';
    g.fillText(s === 0 ? 'now' : `-${s}s`, x(tEnd - s * 1000), H - 4);
  }
  g.strokeStyle = '#39c0ff'; g.lineWidth = 3; g.lineJoin = 'round';
  g.beginPath(); let started = false;
  let prevT = null;
  for (const p of vis) {
    if (!p.ok) continue;
    // break the line over gaps (signal lost / reconnecting) instead of drawing a fake straight segment
    if (!started || p.t - prevT > Math.max(3000, 2.5 * p.rr)) { g.moveTo(x(p.t), y(p.rr)); started = true; } else g.lineTo(x(p.t), y(p.rr));
    prevT = p.t;
  }
  g.stroke();
  g.fillStyle = '#ff5d5d';
  for (const p of vis) if (!p.ok) { g.beginPath(); g.arc(x(p.t), y(p.rr), 6, 0, 2 * Math.PI); g.fill(); }
}
