// Engine-bay comparison: spectral shape, low-frequency balance and how impulsive each band is.
import { aimMic, spectrum } from '../tests/util';
import { EngineSim } from '../src/sim/engine';
import { presetParams } from '../src/sim/params';
import { readWav } from './wav';

export const THIRDS = Array.from({ length: 22 }, (_, i) => 100 * 2 ** (i / 3));
export const BANDS: [number, number][] = [[500, 2000], [2000, 5000], [5000, 12000]];

export interface BayFeatures {
  /** Third-octave levels 100 Hz to 12.8 kHz, dB relative to the 400 Hz to 8 kHz total. */
  thirds: number[];
  /** Per band: envelope kurtosis (3 = steady noise) and modulation depth in dB at orders 0.5, 1, 2 and 4. */
  bands: { kurt: number; mod: number[] }[];
}

function bandpass(x: Float64Array, sr: number, lo: number, hi: number): Float64Array {
  // two cascaded one-pole pairs each way are enough to separate octave-wide bands
  const y = new Float64Array(x.length);
  const a = Math.exp((-2 * Math.PI * lo) / sr), b = 1 - Math.exp((-2 * Math.PI * hi) / sr);
  let h1 = 0, h2 = 0, l1 = 0, l2 = 0, p1 = 0, p2 = 0;
  for (let i = 0; i < x.length; i++) {
    const u = a * (h1 + x[i] - p1); p1 = x[i]; h1 = u;
    const v = a * (h2 + u - p2); p2 = u; h2 = v;
    l1 += b * (v - l1); l2 += b * (l1 - l2);
    y[i] = l2;
  }
  return y;
}

export function features(x: Float64Array, sr: number, rpm: number): BayFeatures {
  const N = 1 << 15, bin = sr / N;
  const pow = new Float64Array(N / 2);
  let frames = 0;
  for (let s = 0; s + N <= x.length; s += N / 2, frames++) { const m = spectrum(x.subarray(s, s + N)); for (let i = 0; i < m.length; i++) pow[i] += m[i] * m[i]; }
  const sum = (lo: number, hi: number) => { let e = 0; for (let i = Math.ceil(lo / bin); i < hi / bin && i < pow.length; i++) e += pow[i]; return e / frames; };
  const ref = sum(400, 8000);
  const thirds = THIRDS.map((fc) => 10 * Math.log10(sum(fc / 2 ** (1 / 6), fc * 2 ** (1 / 6)) / ref + 1e-20));
  const esr = 2000, dec = Math.round(sr / esr);
  const bands = BANDS.map(([lo, hi]) => {
    const y = bandpass(x, sr, lo, hi);
    const n = Math.floor(y.length / dec) - 1, env = new Float64Array(n);
    for (let i = 0; i < n; i++) { let e = 0; for (let k = 0; k < dec; k++) e += y[(i + 1) * dec + k] ** 2; env[i] = Math.sqrt(e / dec); }
    let m = 0; for (const v of env) m += v / n;
    let m2 = 0, m4 = 0; for (const v of env) { m2 += (v - m) ** 2 / n; m4 += (v - m) ** 4 / n; }
    // modulation: envelope spectrum at engine orders relative to its mean
    const M = 1 << Math.floor(Math.log2(n)), es = spectrum(env.subarray(0, M)), eb = sr / dec / M;
    const mod = [0.5, 1, 2, 4].map((o) => { const c = Math.round((o * rpm) / 60 / eb); let pk = 0; for (let i = c - 3; i <= c + 3; i++) pk = Math.max(pk, es[i]); return 20 * Math.log10((2 * pk) / (es[0] + 1e-20) + 1e-12); });
    return { kurt: m4 / (m2 * m2), mod };
  });
  return { thirds, bands };
}

export function recordingIdle(): { f: BayFeatures; rpm: number } {
  const { sr, ch } = readWav(new URL('../samples/K24-Engine-Bay.wav', import.meta.url).pathname);
  const a = Math.round(42 * sr), b = Math.round(51.5 * sr);
  const x = new Float64Array(b - a);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * (ch[0][a + i] + ch[ch.length - 1][a + i]);
  return { f: features(x, sr, 655), rpm: 655 };
}

/** The simulator heard from beside the engine with the bonnet up. */
export function simulatedIdle(extra: Record<string, number> = {}, seconds = 8, parts = false): { f: BayFeatures; rpm: number; mech: BayFeatures; rms: number[] } {
  const sr = 44100;
  const sim = new EngineSim(sr, { ...presetParams('k24'), idleRpm: 655, fxGround: 0, ...extra });
  aimMic(sim, 'engine', 0.6);
  sim.run(4);
  const n = Math.round(seconds * sr), x = new Float64Array(n), xm = new Float64Array(n);
  let rpm = 0; const e = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (i % 128 === 0) sim.beginBlock();
    sim.step();
    x[i] = sim.lastEx + sim.lastIn + sim.lastMech; xm[i] = sim.lastMech; rpm += sim.rpm / n;
    e[0] += sim.lastEx ** 2 / n; e[1] += sim.lastIn ** 2 / n; e[2] += sim.lastMech ** 2 / n;
  }
  return { f: features(x, sr, rpm), rpm, mech: parts ? features(xm, sr, rpm) : (null as never), rms: e.map((v) => 20 * Math.log10(Math.sqrt(v) / 2e-5)) };
}

export function printFeatures(title: string, f: BayFeatures): void {
  console.log(title);
  console.log('  thirds ' + f.thirds.map((v, i) => `${THIRDS[i] < 1000 ? THIRDS[i].toFixed(0) : (THIRDS[i] / 1000).toFixed(1) + 'k'}:${v.toFixed(0)}`).join(' '));
  f.bands.forEach((b, i) => console.log(`  ${BANDS[i][0]}-${BANDS[i][1]} Hz: kurtosis ${b.kurt.toFixed(1)}, modulation dB at orders 0.5/1/2/4: ${b.mod.map((v) => v.toFixed(0)).join(' ')}`));
}
