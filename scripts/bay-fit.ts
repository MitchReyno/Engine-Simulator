// Fit the block's per-mode radiation to the engine-bay recording at idle, then report the level at 3000 rpm.
// usage: vite-node scripts/bay-fit.ts [rounds]   ('{"mech.slap":0.3}' sets source gains first)
import { EngineSim } from '../src/sim/engine';
import { MECH_TUNE, MODE_GAIN } from '../src/sim/mech';
import { presetParams } from '../src/sim/params';
import { aimMic } from '../tests/util';
import { printFeatures, recordingIdle, simulatedIdle, THIRDS } from './bay';

const real = recordingIdle().f;
for (const a of process.argv.filter((v) => v.startsWith('{'))) { const o = JSON.parse(a) as Record<string, number>; for (const k in o) (MECH_TUNE as Record<string, number>)[k.replace('mech.', '')] = o[k]; }
const rounds = Number(process.argv.find((v) => /^\d+$/.test(v)) ?? 4);
if (rounds > 0) MODE_GAIN.fill(0);
const first = THIRDS.findIndex((f) => f > 390);
for (let r = 0; r < rounds; r++) {
  const s = simulatedIdle({}, 6, true).mech;
  let err = 0;
  for (let k = 0; k < MODE_GAIN.length; k++) { const d = real.thirds[first + k] - s.thirds[first + k]; MODE_GAIN[k] += 0.8 * d; err += Math.abs(d) / MODE_GAIN.length; }
  if (r === rounds - 1) console.log(`round ${r}: mean error ${err.toFixed(1)} dB`);
}
const s = simulatedIdle({}, 8, true);
const idle = s.rms[2] + 20 * Math.log10(Math.hypot(0.6, 0) / 1);
printFeatures(`Simulated idle, mechanical only`, s.mech);
const sim = new EngineSim(44100, { ...presetParams('k24'), fxGround: 0, throttle: 100 });
aimMic(sim, 'engine', 1);
sim.run(3);
let load = 40;
for (let k = 0; k < 40; k++) { load = Math.min(100, Math.max(0.5, load * (1 + 1.5 * (sim.rpmAvg - 3000) / 3000))); sim.setParams({ load }); sim.run(0.1); }
let ms = 0; const n = 44100;
for (let i = 0; i < n; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); ms += sim.lastMech ** 2 / n; }
const level = 10 * Math.log10(ms / 4e-10);
console.log(`after scaling 3000 rpm to 87 dB at 1 m, idle is ${(idle + 87 - level).toFixed(1)} dB at 1 m`);
console.log('MODE_GAIN', Array.from(MODE_GAIN, (v) => +(v + 87 - level).toFixed(1)).join(', '));
