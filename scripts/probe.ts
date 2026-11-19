// Ad-hoc engine probe: node-side run of the same EngineSim the worklet uses.
import { EngineSim } from '../src/sim/engine';
import { presetParams } from '../src/sim/params';
import { P_ATM } from '../src/sim/gas';

const SR = 48000;
function report(id: string) {
  const sim = new EngineSim(SR, presetParams(id));
  const t0 = performance.now();
  sim.run(8);
  const wall = (performance.now() - t0) / 8000;
  const line = (tag: string) => console.log(`${id.padEnd(8)} ${tag.padEnd(22)} rpm ${sim.rpm.toFixed(0).padStart(5)}  T ${sim.brakeTorque.toFixed(1).padStart(7)} Nm  P ${(sim.power / 1000).toFixed(1).padStart(6)} kW  VE ${(sim.ve * 100).toFixed(0).padStart(3)}%  MAP ${(sim.map / 1000).toFixed(0).padStart(3)} kPa  nsub ${sim.nsub} resets ${sim.resets}`);
  line(`idle (load ${(wall * 100).toFixed(0)}% rt, ${sim.gas.nCells} cells)`);
  sim.setParams({ throttle: 100, load: 100 }); sim.run(4); line('WOT load 100');
  sim.setParams({ load: 40 }); sim.run(4); line('WOT load 40');
  sim.setParams({ load: 0 }); sim.run(3); line('WOT free (limiter)');
  void P_ATM;
}
for (const id of process.argv.slice(2).length ? process.argv.slice(2) : ['i4', 'thumper', 'v8cross', 'v8flat', 'flat6', 'vtwin', 'i6', '2t250', '2t350', '2t750']) report(id);
