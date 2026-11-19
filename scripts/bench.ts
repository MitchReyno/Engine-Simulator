// Real-time factor of the full simulation per preset (lower is better; 1.0 = real time).
import { EngineSim } from '../src/sim/engine';
import { presetParams } from '../src/sim/params';
for (const id of ['thumper', 'i4', 'flat6', 'v8cross']) {
  for (const budget of [120, 200]) {
    const sim = new EngineSim(48000, { ...presetParams(id), cellBudget: budget });
    sim.run(2);
    sim.setParams({ throttle: 60, load: 30 });
    sim.run(1);
    const t0 = performance.now();
    sim.run(3);
    const rt = (performance.now() - t0) / 3000;
    console.log(`${id.padEnd(8)} budget ${budget}  cells ${String(sim.gas.nCells).padStart(3)}  rpm ${sim.rpm.toFixed(0).padStart(5)}  load ${(rt * 100).toFixed(1)}% of real time`);
  }
}
