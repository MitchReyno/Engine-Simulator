// Where things are: sound sources, the microphone's reference frame and the car body.
// One frame for the simulation and the 3D view: origin at the middle of the crankshaft,
// x to the car's left, y up, z towards the rear. Metres.

import { ResolvedLayout } from './layouts';
import { Params } from './params';
import { Topology } from './topology';

export type Vec3 = [number, number, number];
/** min corner then max corner. */
export type Box = [number, number, number, number, number, number];

/** Height of the road under the crank centreline. */
export const GROUND_Y = -0.44;
export const MUFFLER_RADIUS = 0.085;

export interface Opening { at: Vec3; area: number }

export interface BodyGeom {
  halfWidth: number;
  /** Heights above the crank centreline. */
  floorY: number; bonnetY: number; roofY: number;
  frontZ: number; firewallZ: number; cabinRearZ: number; rearZ: number;
  /** Solid shapes that block sound outside the car. */
  lower: Box; greenhouse: Box;
  /** Air spaces a microphone or a source can be inside. */
  bay: Box; cabin: Box;
}

export interface Placement {
  /** Half the length of the cylinder row. */
  half: number;
  mouth: Vec3;
  engine: Vec3;
  /** One per radiating pipe, in pipe order. */
  outlets: Vec3[];
  body: BodyGeom;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function place(p: Params, layout: ResolvedLayout, topo: Topology): Placement {
  const B = p.bore * 1e-3, S = p.stroke * 1e-3, r = S / 2;
  const l = Math.max(p.rodLength * 1e-3, 0.66 * S);
  const deck = r + l + 0.42 * B;
  const kind = layout.def.kind;
  const upright = kind === 'inline' || kind === 'single';
  const stagger = kind === 'v' ? 0.27 * B : kind === 'flat' ? 0.5 * B : 0;
  const pitch = 1.2 * B + stagger;
  const zs = layout.def.slot.map((s, i) => s * pitch + (layout.def.bank[i] > 0 ? stagger : 0));
  const zMid = 0.5 * (Math.min(...zs) + Math.max(...zs));
  const z = zs.map((v) => v - zMid);
  const half = Math.max(...z);
  const beta = layout.beta.map((b) => (b * Math.PI) / 180);
  const top = Math.max(...beta.map((b) => (deck + 1.2 * B) * Math.cos(b)));

  // exhaust ports face away from the intake: the right side of an upright engine, the outside of a V
  const portX = (i: number) => {
    const sgn = layout.beta[i] <= 0 ? 1 : -1;
    return -sgn * (0.66 * B * Math.cos(beta[i]) + deck * Math.abs(Math.sin(beta[i])));
  };
  const sideX = (i: number) => (upright ? portX(i) - 0.14 : portX(i) + Math.sign(portX(i) || 1) * 0.1);
  const lowY = -Math.max(r + 0.35 * B, 0.1);
  const Lh = clamp(p.headerLength * 1e-3, 0.15, 1.4);
  const collZ = half + 0.7 * B + 0.12 + 0.3 * Lh;
  const mid = clamp(p.midLength * 1e-3, 0.2, 3);
  const split = !topo.twoStroke && p.rearSplit > 0.5 && (p.collector | 0) < 2 ? 0.45 : 0;
  const Lt = clamp(p.tailLength * 1e-3, 0.2, 3);
  const mufflers = topo.volumes.map((v, idx) => ({ v, idx })).filter((x) => x.v.kind === 'muffler');

  const outlets: Vec3[] = [];
  topo.pipes.forEach((q) => {
    if (!q.radiates) return;
    if (topo.twoStroke) {
      const i = q.kind === 'tail' ? topo.pipes.findIndex((h) => h.kind === 'header' && h.volR === q.volL) : -1;
      const cyl = q.kind === 'tail' ? (i >= 0 ? topo.pipes[i].cyl : 0) : q.cyl;
      const Lc = clamp(topo.pipes[topo.headerPipe[cyl]].length, 0.4, 2) * 0.62;
      const tail = q.kind === 'tail' ? clamp(topo.volumes[q.volL].volume / (Math.PI * 0.035 * 0.035), 0.08, 0.3) + 0.16 : 0;
      outlets.push([portX(cyl) * 1.2 - Math.sign(portX(cyl) || 1) * 0.16, deck - S - 0.1 - 0.03 * (cyl % 2), z[cyl] + 0.1 + Lc + tail]);
    } else if (q.kind === 'tail') {
      const k = Math.max(0, mufflers.findIndex((m) => m.idx === q.volL));
      const len = clamp(topo.volumes[q.volL].volume / (Math.PI * MUFFLER_RADIUS * MUFFLER_RADIUS), 0.1, 0.9);
      const x = mufflers.length > 1 ? (k === 0 ? 0.6 : -0.6) : upright ? portX(0) - 0.12 : 0;
      outlets.push([x, lowY - 0.04, collZ + mid + split + 0.12 + len + MUFFLER_RADIUS * 0.5 + Lt]);
    } else {
      // open headers end beside the engine
      outlets.push([sideX(q.cyl), lowY + 0.02 * (q.cyl % 3), z[q.cyl] + 0.25 + 0.5 * Lh]);
    }
  });

  const Lr = clamp(p.runnerLength * 1e-3, 0.1, 0.55);
  const Li = clamp(p.intakeLength * 1e-3, 0.1, 0.8) * 0.8;
  const mouth: Vec3 = topo.twoStroke
    ? [-portX(0) * 1.6, deck - S * 0.6, 0]
    : [upright ? 0.66 * B + 0.8 * Lr + 0.07 : 0, upright ? deck + 0.5 * B + 0.3 * Lr : top + 0.3 * Lr, -(half + 0.5 * B + 0.07 + Li)];
  const engine: Vec3 = [0, 0.5 * deck * Math.cos(beta[0]), 0];

  // ---- car body, sized around this engine and exhaust
  const halfWidth = 0.88;
  const floorY = GROUND_Y + 0.17;
  const bonnetY = Math.max(GROUND_Y + 0.95, top + 0.1, mouth[1] + 0.12);
  const roofY = bonnetY + 0.5;
  const frontZ = Math.min(mouth[2] - 0.2, -half - 0.45);
  const firewallZ = half + 0.3;
  const tailZ = outlets.length ? Math.max(...outlets.map((o) => o[2])) : 0;
  const cabinRearZ = firewallZ + clamp(tailZ - firewallZ - 0.8, 1.2, 2);
  const rearZ = Math.max(cabinRearZ + 0.6, tailZ - 0.06);
  const body: BodyGeom = {
    halfWidth, floorY, bonnetY, roofY, frontZ, firewallZ, cabinRearZ, rearZ,
    lower: [-halfWidth, floorY, frontZ, halfWidth, bonnetY, rearZ],
    greenhouse: [-0.76, bonnetY, firewallZ + 0.3, 0.76, roofY, cabinRearZ + 0.15],
    bay: [-0.8, floorY, frontZ + 0.05, 0.8, bonnetY, firewallZ],
    cabin: [-0.8, floorY + 0.12, firewallZ, 0.8, roofY, cabinRearZ],
  };
  return { half, mouth, engine, outlets, body };
}

export interface MicPreset { name: string; hint: string; at: Vec3 }

/** Useful places to listen from: sideways, height above the ground, towards the rear. */
export function micPresets(pl: Placement): MicPreset[] {
  const b = pl.body;
  const tailZ = pl.outlets.length ? Math.max(...pl.outlets.map((o) => o[2])) : b.rearZ;
  const r = (v: number) => Math.round(v * 20) / 20;
  const at = (x: number, y: number, z: number): Vec3 => [r(x), r(y), r(z)];
  return [
    { name: 'Behind the exhaust', hint: 'Standing 1 m behind the tailpipes.', at: at(0, 1.2, tailZ + 1) },
    { name: 'Beside the engine', hint: 'Standing 2 m to the side of the engine.', at: at(2, 1.2, 0) },
    { name: 'Over the engine', hint: 'Leaning over the engine bay, as with the bonnet up.', at: at(0, b.bonnetY - GROUND_Y + 0.6, -0.2) },
    { name: 'In the engine bay', hint: 'Beside the engine, under the bonnet line. With the car body on this is inside the bay.', at: at(0.5, Math.min(0.8, b.bonnetY - GROUND_Y - 0.1), -0.2) },
    { name: "Driver's seat", hint: 'Head height in the front seat. With the car body on this is inside the cabin.', at: at(0.35, 1.1, b.firewallZ + 0.9) },
    { name: 'In front of the car', hint: 'Standing 2 m ahead of the nose.', at: at(0, 1.2, b.frontZ - 2) },
    { name: 'Roadside, 7.5 m', hint: 'The drive-by noise test position: 7.5 m to the side, 1.2 m high.', at: at(7.5, 1.2, 0.5 * (b.frontZ + b.rearZ)) },
  ];
}

export const inside = (b: Box, x: number, y: number, z: number) => x > b[0] && x < b[3] && y > b[1] && y < b[4] && z > b[2] && z < b[5];
