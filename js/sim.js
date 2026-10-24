// Simulation mode (?simulate=1): a fake Polar H10 that looks like the Web Bluetooth API.
// Options: &speed=N (time runs N x faster), &drop=S (drop the link every S simulated seconds).
const params = new URLSearchParams(location.search);
export const SIM = params.has('simulate');
export const SPEED = Math.max(1, Number(params.get('speed')) || 1);
const DROP_S = Number(params.get('drop')) || 0;
const t0 = Date.now();
/** App-wide clock. In simulation it runs SPEED x faster so tests can cover minutes quickly. */
export const now = () => (SIM ? t0 + (Date.now() - t0) * SPEED : Date.now());

function encode(hr, rrs, contact = true) {
  const flags = 0x10 | 0x04 | (contact ? 0x02 : 0); // RR present, contact supported(+detected)
  const b = new Uint8Array(2 + rrs.length * 2);
  b[0] = flags; b[1] = hr;
  rrs.forEach((ms, k) => { const v = Math.round(ms * 1024 / 1000); b[2 + 2 * k] = v & 255; b[3 + 2 * k] = v >> 8; });
  return new DataView(b.buffer);
}

class FakeChar extends EventTarget {
  constructor(dev, kind) { super(); this.dev = dev; this.kind = kind; this.value = null; }
  async startNotifications() { if (this.kind === 'hr') this.dev._startStream(this); return this; }
  async stopNotifications() { this.dev._stopStream(); return this; }
  async readValue() { return new DataView(Uint8Array.of(this.dev.battery).buffer); }
}
class FakeServer {
  constructor(dev) { this.device = dev; this.connected = false; }
  async connect() {
    await new Promise((r) => setTimeout(r, 300));
    this.connected = true; this.device._connectedAt = now(); return this;
  }
  disconnect() { if (!this.connected) return; this.connected = false; this.device._stopStream(); this.device.dispatchEvent(new Event('gattserverdisconnected')); }
  async getPrimaryService(name) {
    if (!this.connected) throw new Error('GATT Server is disconnected.');
    const dev = this.device;
    return { getCharacteristic: async (c) => new FakeChar(dev, c === 'heart_rate_measurement' ? 'hr' : 'bat') };
  }
}
class FakeDevice extends EventTarget {
  constructor() { super(); this.name = 'Polar H10 SIM0001'; this.id = 'sim'; this.battery = 87; this.gatt = new FakeServer(this); this._timer = null; this._phase = 0; }
  _nextRR() {
    // ~66 bpm baseline, breathing (RSA, ~6 s at rest), slow drift, noise and rare artefacts.
    const t = (now() - t0) / 1000;
    let rr = 900 + 45 * Math.sin(2 * Math.PI * t / 6) + 30 * Math.sin(2 * Math.PI * t / 90) + (Math.random() - 0.5) * 30;
    const u = Math.random();
    if (u < 0.01) rr = rr * 0.5;        // extra/split beat
    else if (u < 0.02) rr = rr * 1.9;   // missed beat
    return rr;
  }
  _startStream(ch) {
    this._stopStream();
    const tick = () => {
      if (!this.gatt.connected) return;
      if (DROP_S && now() - this._connectedAt > DROP_S * 1000) { this.gatt.disconnect(); return; }
      const rrs = []; let sum = 0;
      while (sum < 1000) { const r = this._nextRR(); rrs.push(r); sum += r; }
      const plain = rrs.filter((r) => r > 600 && r < 1300);
      const hr = Math.round(60000 / (plain.length ? plain.reduce((a, b) => a + b, 0) / plain.length : 900));
      ch.value = encode(Math.min(255, hr), rrs);
      ch.dispatchEvent(new Event('characteristicvaluechanged'));
      this._timer = setTimeout(tick, sum / SPEED);
    };
    this._timer = setTimeout(tick, 200);
  }
  _stopStream() { clearTimeout(this._timer); this._timer = null; }
}
export const fakeBluetooth = {
  async getAvailability() { return true; },
  async requestDevice() { return new FakeDevice(); },
};
