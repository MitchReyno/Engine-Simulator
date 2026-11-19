// Torque curve: hold a set of loads at full throttle and report where the engine settles.
import { EngineSim } from '../src/sim/engine';
import { presetParams } from '../src/sim/params';
const id = process.argv[2] ?? '2t250';
const extra = JSON.parse(process.argv[3] ?? '{}');
const sim = new EngineSim(48000, { ...presetParams(id), ...extra });
sim.run(4);
sim.setParams({ throttle: 100 });
for (const load of [100, 60, 40, 28, 20, 15, 11, 8, 6, 4.5, 3.5, 2.5]) {
  sim.setParams({ load });
  sim.run(3.5);
  const g = sim.gas, t = sim.topo;
  const cc = t.twoStroke ? `ccY ${g.vY[t.crankcase[0]].toFixed(2)} cylY@now ${g.vY[2].toFixed(2)}` : '';
  console.log(`load ${String(load).padStart(4)}  rpm ${sim.rpmAvg.toFixed(0).padStart(5)}  torque ${sim.brakeTorque.toFixed(1).padStart(6)} Nm  power ${(sim.power / 1000).toFixed(1).padStart(5)} kW  trapped fresh ${(sim.ve * 100).toFixed(0)}%  air ${(sim.mdotAir * 1000).toFixed(1)} g/s ${cc} vtc ${sim.vtcAdv.toFixed(0)} vtec ${sim.vtecOn ? 1 : 0} wall ${sim.headerWallT.toFixed(0)}K resets ${sim.resets}`);
}
