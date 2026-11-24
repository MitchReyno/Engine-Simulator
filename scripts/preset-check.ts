// Idle, and full-throttle torque on the dyno brake at 55 % and 90 % of the rev limit, for each preset.
// usage: vite-node scripts/preset-check.ts   (SET='{"k24":{"airbox":1}}' adds changes to named presets)
import { EngineSim } from '../src/sim/engine';
import { PRESETS, presetParams } from '../src/sim/params';

const extra = JSON.parse(process.env.SET ?? '{}') as Record<string, Record<string, number>>;
for (const pr of PRESETS) {
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(pr.id)) continue;
  for (const variant of extra[pr.id] ? ['now', 'changed'] : ['now']) {
    const p = { ...presetParams(pr.id), ...(variant === 'changed' ? extra[pr.id] : {}) };
    const sim = new EngineSim(48000, p);
    sim.run(5);
    const idle = sim.rpmAvg;
    let lo = Infinity, hi = 0;
    for (let k = 0; k < 20; k++) { sim.run(0.1); lo = Math.min(lo, sim.rpmAvg); hi = Math.max(hi, sim.rpmAvg); }
    sim.setParams({ throttle: 100 });
    const out: string[] = [];
    for (const f of [0.55, 0.9]) {
      const rpm = Math.round((f * p.revLimit) / 100) * 100;
      sim.setParams({ dynoRpm: rpm });
      sim.run(2.2);
      let ex = 0, inn = 0; const n = 24000;
      for (let i = 0; i < n; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); ex += sim.lastEx ** 2 / n; inn += sim.lastIn ** 2 / n; }
      out.push(`${rpm} rpm ${sim.brakeTorque.toFixed(0).padStart(4)} N m (held ${sim.rpmAvg.toFixed(0)}) ex ${(10 * Math.log10(ex / 4e-10)).toFixed(0)} in ${(10 * Math.log10(inn / 4e-10)).toFixed(0)} dB`);
    }
    console.log(`${pr.id.padEnd(8)} ${variant.padEnd(7)} idle ${idle.toFixed(0).padStart(5)} (${lo.toFixed(0)}-${hi.toFixed(0)}, target ${p.idleRpm})  ${out.join(' | ')}${sim.resets ? '  RESETS ' + sim.resets : ''}`);
  }
}
