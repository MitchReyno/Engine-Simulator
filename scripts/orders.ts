// Order tracking: find engine speed from the harmonic comb in a recording, then read the level of each engine order.
import { spectrum } from '../tests/util';

export interface OrderFrame { t: number; rpm: number; score: number; orders: Float64Array; floor: number; total: number }
export const ORDERS = Array.from({ length: 32 }, (_, i) => (i + 1) * 0.5);

/** x mono, returns one frame per hop. Orders are multiples of 0.5 up to 16; levels are linear magnitudes. */
export function trackOrders(x: Float64Array, sr: number, opts: { n?: number; hop?: number; rpmLo?: number; rpmHi?: number; rpmHint?: (t: number) => number } = {}): OrderFrame[] {
  const n = opts.n ?? 16384, hop = opts.hop ?? 2048, bin = sr / n;
  const lo = opts.rpmLo ?? 600, hi = opts.rpmHi ?? 8000;
  const out: OrderFrame[] = [];
  let prev = 0;
  for (let s = 0; s + n <= x.length; s += hop) {
    const mag = spectrum(x.subarray(s, s + n));
    const at = (hz: number) => { const b = hz / bin, i = Math.round(b); return i > 1 && i < mag.length - 2 ? Math.max(mag[i - 1], mag[i], mag[i + 1]) : 0; };
    const t = (s + n / 2) / sr;
    let best = 0, bestScore = -Infinity;
    const hint = opts.rpmHint?.(t) ?? prev;
    const a = hint ? Math.max(lo, hint * 0.88) : lo, b = hint ? Math.min(hi, hint * 1.12) : hi;
    for (let rpm = a; rpm <= b; rpm += 4) {
      const f1 = rpm / 60;
      let sc = 0;
      // integer orders are present in a four-cylinder; half orders are not, which pins the octave
      for (let k = 2; k <= 12; k += 2) sc += Math.log(at(k * f1) + 1e-9) - 0.5 * Math.log(at((k + 1) * f1) + 1e-9) * 0 - 0.5 * (Math.log(at((k - 0.5) * f1) + 1e-9) + Math.log(at((k + 0.5) * f1) + 1e-9));
      if (sc > bestScore) { bestScore = sc; best = rpm; }
    }
    // refine on the strongest of orders 2 and 4
    const f1 = best / 60;
    let k = at(4 * f1) > at(2 * f1) ? 4 : 2, pb = Math.round((k * f1) / bin);
    for (let i = pb - 2; i <= pb + 2; i++) if (mag[i] > mag[pb]) pb = i;
    const d = 0.5 * (mag[pb - 1] - mag[pb + 1]) / (mag[pb - 1] - 2 * mag[pb] + mag[pb + 1] || 1);
    const rpm = (((pb + d) * bin) / k) * 60;
    prev = rpm;
    const orders = new Float64Array(ORDERS.length);
    ORDERS.forEach((o, i) => (orders[i] = at((o * rpm) / 60)));
    // broadband floor: median of bins at quarter orders between 300 Hz and 4 kHz
    const fl: number[] = [];
    for (let q = 0.25; (q * rpm) / 60 < 4000; q += 0.5) if ((q * rpm) / 60 > 300) fl.push(mag[Math.round((q * rpm) / 60 / bin)]);
    fl.sort((p, q) => p - q);
    let total = 0;
    for (let i = 4; i < mag.length; i++) total += mag[i] * mag[i];
    out.push({ t, rpm, score: bestScore, orders, floor: fl[fl.length >> 1] ?? 0, total: Math.sqrt(total) });
  }
  return out;
}
