// Lift-off pops with the overrun settings: rev up, close the throttle, count afterfire ignitions on the way down.
import { EngineSim } from '../src/sim/engine';
import { presetParams } from '../src/sim/params';

const SR = 48000;
function run(name: string, over: Record<string, number>, preset = 'k24'): void {
  const sim = new EngineSim(SR, { ...presetParams(preset), fxAfterfire: 1, flywheel: 1, ...over });
  sim.run(4);
  // a heavy flywheel stands in for the car holding the revs up in gear
  sim.setParams({ throttle: 100, load: 20 });
  sim.run(6);
  sim.setParams({ load: 4 });
  const rpm0 = sim.rpm, p0 = sim.gas.pops;
  sim.setParams({ throttle: 0 });
  let peak = 0, on = 0;
  const N = SR * 4;
  let rpmAt2 = 0;
  for (let i = 0; i < N; i++) {
    if (i % 128 === 0) sim.beginBlock();
    sim.step();
    peak = Math.max(peak, Math.abs(sim.lastEx));
    if (sim.overrunOn) on++;
    if (i === SR * 2) rpmAt2 = sim.rpm;
  }
  console.log(`${name.padEnd(34)} rpm ${rpm0.toFixed(0)} -> ${rpmAt2.toFixed(0)} -> ${sim.rpm.toFixed(0)}  pops ${sim.gas.pops - p0}  map on ${(on / SR).toFixed(2)} s  peak ${peak.toFixed(1)}  resets ${sim.resets}`);
}
const which = process.argv[2] ?? 'k24';
run('defaults', {}, which);
run('fuel on only', { fuelCut: 0 }, which);
run('cut 50 retard 30 air 8', { fuelCut: 0, overrunCut: 50, overrunRetard: 30, overrunAir: 8 }, which);
run('cut 100 air 8', { fuelCut: 0, overrunCut: 100, overrunAir: 8 }, which);
run('cut 50 retard 0 air 8', { fuelCut: 0, overrunCut: 50, overrunAir: 8 }, which);
run('cut 50 retard 30 air 0', { fuelCut: 0, overrunCut: 50, overrunRetard: 30 }, which);
run('cut 50 retard 30 air 20', { fuelCut: 0, overrunCut: 50, overrunRetard: 30, overrunAir: 20 }, which);
run('cut 30 retard 50 air 15', { fuelCut: 0, overrunCut: 30, overrunRetard: 50, overrunAir: 15 }, which);
run('cut 70 retard 40 air 12', { fuelCut: 0, overrunCut: 70, overrunRetard: 40, overrunAir: 12 }, which);
