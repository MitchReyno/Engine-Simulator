// usage: vite-node scripts/bay-run.ts '{"param":value,"mech.slap":0}' ...
import { MECH_TUNE } from '../src/sim/mech';
import { printFeatures, recordingIdle, simulatedIdle } from './bay';
printFeatures('Recording (engine bay, idle 655 rpm)', recordingIdle().f);
const args = process.argv.filter((a) => a.startsWith('{'));
const tune0 = { ...MECH_TUNE };
for (const a of args.length ? args : ['{}']) {
  const extra = JSON.parse(a) as Record<string, number>;
  Object.assign(MECH_TUNE, tune0);
  for (const k in extra) if (k.startsWith('mech.')) { (MECH_TUNE as Record<string, number>)[k.slice(5)] = extra[k]; delete extra[k]; }
  const s = simulatedIdle(extra, 8, true);
  console.log(`Simulator ${a} at ${s.rpm.toFixed(0)} rpm; exhaust/intake/mechanical ${s.rms.map((v) => v.toFixed(0)).join('/')} dB`);
  printFeatures('  mechanical only', s.mech);
}
