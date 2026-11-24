// Mechanical noise level at 1 m against engine speed, beside the published correlation.
import { EngineSim } from '../src/sim/engine';
import { aimMic } from '../tests/util';
import { presetParams } from '../src/sim/params';
const sr = 44100;
for (const target of [0, 2000, 3000, 5000, 7000]) {
  const sim = new EngineSim(sr, { ...presetParams(process.env.PRESET ?? 'k24'), fxGround: 0, revLimit: 8000 });
  aimMic(sim, 'engine', 1);
  sim.run(3);
  sim.setParams({ throttle: target ? 100 : 0 });
  let load = 40;
  for (let k = 0; k < 40; k++) { if (target) { load = Math.min(100, Math.max(0.5, load * (1 + 1.5 * (sim.rpmAvg - target) / target))); sim.setParams({ load }); } sim.run(0.1); }
  let ms = 0, rpm = 0; const n = sr;
  for (let i = 0; i < n; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); ms += sim.lastMech ** 2 / n; rpm += sim.rpm / n; }
  console.log(`${rpm.toFixed(0).padStart(5)} rpm: ${(10 * Math.log10(ms / 4e-10)).toFixed(1)} dB, correlation ${(50 * Math.log10(rpm) + 60 * Math.log10(sim.cur.bore) - 203.4).toFixed(1)}`);
}
