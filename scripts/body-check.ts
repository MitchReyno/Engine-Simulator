// Attenuation of each source by the car body for a few microphone positions, dB re body off.
import { Tap, buildScene, tapLevel as level } from '../src/sim/acoustics';
import { resolveLayout, LAYOUT_KINDS } from '../src/sim/layouts';
import { presetParams } from '../src/sim/params';
import { GROUND_Y, place } from '../src/sim/placement';
import { buildTopology } from '../src/sim/topology';

const p = presetParams(process.env.PRESET ?? 'k24');
const layout = resolveLayout(LAYOUT_KINDS[p.layout | 0], p.cylinders | 0, p.bankAngle, p.crank | 0, p.firingOrder | 0, p.strokes > 0.5);
const pl = place(p, layout, buildTopology(p, layout, 1 / 48000));
const b = pl.body;
console.log('engine', pl.engine.map((v) => v.toFixed(2)), 'mouth', pl.mouth.map((v) => v.toFixed(2)), 'outlets', pl.outlets.map((o) => o.map((v) => v.toFixed(2)).join(',')));
console.log('body: front', b.frontZ.toFixed(2), 'firewall', b.firewallZ.toFixed(2), 'cabin rear', b.cabinRearZ.toFixed(2), 'rear', b.rearZ.toFixed(2), 'bonnet', (b.bonnetY - GROUND_Y).toFixed(2), 'roof', (b.roofY - GROUND_Y).toFixed(2));
const mics: Record<string, number[]> = {
  'beside engine 2 m': [2, 1.2, 0], 'in front 2 m': [0, 1.2, b.frontZ - 2], 'over bonnet': [0, b.bonnetY - GROUND_Y + 0.6, -0.3],
  'in bay': [0.5, 0.8, -0.2], 'cabin (driver)': [0.35, 1.1, b.firewallZ + 0.9], 'behind tail 1 m': [0, 1.2, b.rearZ + 1],
};
const variants: Record<string, Record<string, number>> = { closed: {}, 'bonnet open': { bonnetOpen: 100 }, 'windows open': { windowsOpen: 100 }, undertray: { undertray: 1 } };
for (const [name, m] of Object.entries(mics)) {
  const at = { micX: m[0], micY: m[1], micZ: m[2] };
  const off = buildScene({ ...p, ...at, carBody: 0 }, pl);
  console.log(`\n${name}`);
  for (const [vn, v] of Object.entries(variants)) {
    const sc = buildScene({ ...p, ...at, carBody: 1, ...v }, pl);
    const row = (label: string, on: Tap[], ref: Tap[]) => `${label} ${[125, 1000, 4000].map((hz) => (level(on, hz) - level(ref, hz)).toFixed(0).padStart(4)).join('')}`;
    console.log(`  ${vn.padEnd(13)} zone ${sc.zone} t60 ${(sc.t60 * 1000).toFixed(0).padStart(3)} ms | ${row('engine', sc.engine, off.engine)} | ${row('intake', sc.intake, off.intake)} | ${row('exhaust', sc.outlets.flat(), off.outlets.flat())}  (dB at 125 Hz, 1 kHz, 4 kHz)`);
  }
}
