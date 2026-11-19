import { EngineSim } from '../src/sim/engine';
import { presetParams } from '../src/sim/params';
import { bandPower, record, spectrum } from '../tests/util';
const SR = 48000, N = 65536, bin = SR / N;
function peaks(mag: Float64Array, count: number, lo = 15, hi = 1500) {
  const out: [number, number][] = [];
  for (let i = Math.round(lo / bin); i < hi / bin; i++) if (mag[i] > mag[i - 1] && mag[i] >= mag[i + 1]) out.push([i * bin, mag[i]]);
  return out.sort((a, b) => b[1] - a[1]).slice(0, count);
}
// 1) firing frequency
for (const id of ['i4', 'thumper', 'flat6']) {
  const sim = new EngineSim(SR, presetParams(id));
  sim.run(3); sim.setParams({ throttle: 100, load: 100 }); sim.run(4);
  const { x, rpm } = record(sim, N, (s) => s.lastEx);
  const ff = (rpm * sim.n) / 120;
  console.log(id, 'rpm', rpm.toFixed(0), 'f_fire', ff.toFixed(1), 'peaks', peaks(spectrum(x), 5).map((p) => `${p[0].toFixed(1)}(${(p[0] / ff).toFixed(2)}x)`).join(' '));
}
// 2) exhaust length vs resonance: thumper, open header, steady low rpm
for (const L of [500, 1000]) {
  const sim = new EngineSim(SR, { ...presetParams('thumper'), collector: 3, headerLength: L, throttle: 35, load: 100 });
  sim.run(6);
  const { x, rpm } = record(sim, N, (s) => s.lastEx);
  const mag = spectrum(x);
  // envelope: power in 25 Hz bands
  const env: [number, number][] = [];
  for (let f = 50; f < 900; f += 25) { let s = 0; for (let i = Math.round(f / bin); i < (f + 25) / bin; i++) s += mag[i] * mag[i]; env.push([f, s]); }
  const top = env.slice().sort((a, b) => b[1] - a[1]).slice(0, 5).map((e) => e[0]);
  let cen = 0, tot = 0; for (const [f, s] of env) { cen += (f + 12) * s; tot += s; }
  console.log('header', L, 'rpm', rpm.toFixed(0), 'top bands', top.join(','), 'centroid', (cen / tot).toFixed(0), 'headerT', sim.gas.vT[2].toFixed(0));
}
// 3) cross vs flat plane
for (const id of ['v8cross', 'v8flat']) {
  const sim = new EngineSim(SR, { ...presetParams('v8cross'), crank: id === 'v8cross' ? 0 : 1, throttle: 100, load: 100 });
  sim.run(6);
  const { x, rpm } = record(sim, N, (s) => s.lastEx);
  const mag = spectrum(x);
  const ff = (rpm * 8) / 120;
  const orders = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((o) => `${o}:${(10 * Math.log10(bandPower(mag, o * ff, bin, 3) / bandPower(mag, ff, bin, 3))).toFixed(1)}dB`);
  console.log(id, 'rpm', rpm.toFixed(0), 'f_fire', ff.toFixed(1), orders.join('  '));
}
