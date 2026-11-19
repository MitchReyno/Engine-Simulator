import { EngineSim } from '../src/sim/engine';

/** In-place radix-2 FFT; returns magnitude spectrum of a Hann-windowed signal. */
export function spectrum(x: Float32Array | Float64Array): Float64Array {
  const n = x.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

/** Record n samples of a chosen signal and the mean rpm over the window. */
export function record(sim: EngineSim, n: number, pick: (s: EngineSim, y: number) => number): { x: Float64Array; rpm: number } {
  const x = new Float64Array(n);
  let rpm = 0;
  for (let i = 0; i < n; i++) {
    if (i % 128 === 0) sim.beginBlock();
    const y = sim.step();
    x[i] = pick(sim, y);
    rpm += sim.rpm;
  }
  return { x, rpm: rpm / n };
}

/** Sum of spectral power within +-halfWidth bins of a frequency. */
export function bandPower(mag: Float64Array, hz: number, binHz: number, halfWidth = 2): number {
  const c = Math.round(hz / binHz);
  let s = 0;
  for (let i = Math.max(1, c - halfWidth); i <= c + halfWidth && i < mag.length; i++) s += mag[i] * mag[i];
  return s;
}
