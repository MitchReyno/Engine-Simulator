import { EngineSim } from '../src/sim/engine';
import { presetParams } from '../src/sim/params';
import { record, spectrum } from '../tests/util';
const SR = 48000, N = 32768, bin = SR / N;
function report(tag: string, x: Float64Array) {
  const mag = spectrum(x);
  let lowP = 0; for (let i = Math.round(20 / bin); i < 1500 / bin; i++) lowP += mag[i] * mag[i];
  const bands = [[1500, 3000], [3000, 5000], [5000, 7000], [7000, 11000], [11000, 13000], [13000, 23000]].map(([a, b]) => {
    let s = 0, pk = 0, pf = 0; for (let i = Math.round(a / bin); i < b / bin; i++) { s += mag[i] * mag[i]; if (mag[i] > pk) { pk = mag[i]; pf = i * bin; } }
    // tonality: peak bin power vs band mean
    const mean = s / ((b - a) / bin);
    return `${a / 1000}-${b / 1000}k ${(10 * Math.log10(s / lowP)).toFixed(0)}dB pk@${pf.toFixed(0)}Hz(+${(10 * Math.log10(pk * pk / mean)).toFixed(0)})`;
  });
  console.log(tag.padEnd(16), bands.join(' | '));
}
for (const [id, thr, load] of [['i4', 0, 0], ['i4', 100, 60], ['v8cross', 0, 0]] as [string, number, number][]) {
  const sim = new EngineSim(SR, presetParams(id));
  sim.run(5); sim.setParams({ throttle: thr, load }); sim.run(3);
  const ex = new Float64Array(N), inn = new Float64Array(N), me = new Float64Array(N);
  const { x, rpm } = record(sim, N, (s, y) => y);
  const sim2 = sim; let i = 0;
  const r2 = record(sim2, N, (s) => { ex[i] = s.lastEx; inn[i] = s.lastIn; me[i] = s.lastMech; i++; return 0; });
  console.log(`--- ${id} thr ${thr} rpm ${rpm.toFixed(0)}  (band power relative to 20-1500 Hz)`);
  report('output', x); report('exhaust', ex); report('intake', inn); report('mech', me);
  void r2;
}
