// Torque, boost and intake/exhaust loudness for intake variants, held at a few speeds at full throttle.
// usage: vite-node scripts/intake-check.ts   (PRESET=k24)
import { EngineSim } from '../src/sim/engine';
import { presetParams } from '../src/sim/params';
import { aimMic } from '../tests/util';

const id = process.env.PRESET ?? 'k24';
const variants: Record<string, Record<string, number>> = process.env.SET ? JSON.parse(process.env.SET) : {
  'as preset': {}, 'no filter': { airFilter: 0 }, 'clogged filter': { airFilter: 4 }, 'airbox': { airbox: 1 }, 'tapered runners + bellmouths': { runnerTaper: 25, bellmouth: 1 },
  'muffler delete': { mufflerType: 3 }, 'turbo 70 kPa': { boost: 1 }, 'turbo 120 kPa, big wheel': { boost: 1, boostTarget: 120, turboSize: 70 }, 'supercharger 50 kPa': { boost: 2, boostTarget: 50 },
};
for (const [name, v] of Object.entries(variants)) {
  const sim = new EngineSim(48000, { ...presetParams(id), ...v });
  aimMic(sim, 'engine', 2);
  sim.run(3);
  sim.setParams({ throttle: 100 });
  const cols: string[] = [];
  for (const target of [2500, 4500, 6500]) {
    let load = 40;
    for (let k = 0; k < 50; k++) { load = Math.min(100, Math.max(0.5, load * (1 + 1.5 * (sim.rpmAvg - target) / target))); sim.setParams({ load }); sim.run(0.1); }
    let ex = 0, inn = 0; const n = 24000;
    for (let i = 0; i < n; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); ex += sim.lastEx ** 2 / n; inn += sim.lastIn ** 2 / n; }
    const db = (e: number) => (10 * Math.log10(e / 4e-10 + 1e-30)).toFixed(0);
    cols.push(`${sim.rpmAvg.toFixed(0)} rpm ${sim.brakeTorque.toFixed(0).padStart(4)} N m  boost ${(sim.boost.boostPa / 1e3).toFixed(0).padStart(3)} kPa turbo ${(sim.boost.omega * 9.549 / 1000).toFixed(0).padStart(3)}k  ex ${db(ex)} in ${db(inn)} dB`);
  }
  console.log(name.padEnd(30), cols.join(' | '), sim.resets ? `RESETS ${sim.resets}` : '');
}
