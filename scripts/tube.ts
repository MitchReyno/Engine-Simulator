// Tube bench: drive one end of a pipe with noise and report how sharply each resonance stands out
// at the open end. The numerical version of talking into a length of tube.
import { GasNetwork, P_ATM } from '../src/sim/gas';
import { spectrum } from '../tests/util';

export interface TubeResult { modes: { hz: number; peakDb: number; q: number }[] }

export function tubeBench(opts: { length: number; diameter: number; cells: number; T?: number; radiation?: boolean; seconds?: number; sr?: number }): TubeResult {
  const sr = opts.sr ?? 48000, dt = 1 / sr, T = opts.T ?? 300;
  const g = new GasNetwork(
    [{ volume: 1, fixed: true }, { volume: 3e-5 }],
    [{ length: opts.length, diameter: opts.diameter, cells: opts.cells, volL: 1, volR: 0, wallT: T }],
  );
  g.setVolumeState(1, P_ATM, T, 0);
  g.setPipeState(0, P_ATM, T, 0, 0);
  if (opts.radiation) g.setRadiation(0, false, true);
  const N = 1 << 17;
  const x = new Float64Array(N);
  let seed = 99, prev = 0;
  const warm = sr / 2;
  for (let i = 0; i < N + warm; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    // small enough to stay linear: about 30 Pa in the driver volume
    const dm = seed * 4.6566e-10 * 2e-9;
    g.vm[1] += dm;
    g.vE[1] += dm * 1004 * T;
    g.refreshVolume(1);
    g.step(dt, dt);
    const m = g.pMdotR[0];
    if (i >= warm) x[i - warm] = (m - prev) * sr;
    prev = m;
  }
  const mag = spectrum(x), bin = sr / N;
  const c = Math.sqrt(1.35 * 287 * T);
  const modes: TubeResult['modes'] = [];
  const db = (v: number) => 20 * Math.log10(v + 1e-30);
  // smooth over ~6 Hz so single noisy bins do not count as peaks
  const sm = new Float64Array(mag.length);
  for (let i = 8; i < mag.length - 8; i++) { let s = 0; for (let k = -8; k <= 8; k++) s += mag[i + k] * mag[i + k]; sm[i] = Math.sqrt(s / 17); }
  const f1 = c / (4 * (opts.length + 0.6 * opts.diameter / 2));
  for (let n = 1; n <= 8; n++) {
    const fc = (2 * n - 1) * f1;
    let pk = 0, pi = 0;
    for (let i = Math.round((fc - 0.45 * f1) / bin); i <= Math.round((fc + 0.45 * f1) / bin); i++) if (sm[i] > pk) { pk = sm[i]; pi = i; }
    // trough half-way to the next mode
    let tr = Infinity;
    for (let i = Math.round((fc + 0.7 * f1) / bin); i <= Math.round((fc + 1.3 * f1) / bin); i++) if (sm[i] < tr) tr = sm[i];
    // -3 dB width
    let lo = pi, hi = pi;
    while (lo > 1 && sm[lo] > pk * 0.7071) lo--;
    while (hi < sm.length - 1 && sm[hi] > pk * 0.7071) hi++;
    modes.push({ hz: pi * bin, peakDb: db(pk) - db(tr), q: (pi * bin) / Math.max(bin, (hi - lo) * bin) });
  }
  return { modes };
}
