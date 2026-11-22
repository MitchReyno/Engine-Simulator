// usage: vite-node scripts/compare-run.ts '{"param":value,"tune.valve":0.01}' ...   (PRESET=k24, QUIET=1 for scores only)
import { printRows, recording, score, simulated } from './compare';

const real = recording();
const quiet = !!process.env.QUIET;
if (!quiet) printRows('Recording (near exhaust), dB re order 2', real);
const id = process.env.PRESET ?? 'k24';
const args = process.argv.filter((a) => a.startsWith('{'));
for (const a of args.length ? args : ['{}']) {
  const sim = simulated(id, JSON.parse(a));
  if (!quiet) printRows(`Simulator ${id} ${a}`, sim);
  console.log(`score ${score(real, sim).toFixed(2)} dB  ${a}`);
}
