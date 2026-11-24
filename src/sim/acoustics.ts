// From sources to the microphone: direct sound, the ground reflection, and a car body.
//
// The body is two enclosed air spaces, the engine bay and the cabin, treated as small
// reverberant rooms (power in = power absorbed + power leaving through openings and panels),
// plus two solid boxes that shadow sound travelling outside the car.

import { Params } from './params';
import { Box, GROUND_Y, Placement, Vec3, inside } from './placement';

const C = 343;
export const OUTSIDE = 0, BAY = 1, CABIN = 2;

/** One path from a source to the microphone. */
export interface Tap {
  /** Pressure per unit source strength (the 1 / 4 pi r of a monopole, times any losses). */
  gain: number;
  /** Seconds. */
  delay: number;
  /** Low-pass corner, Hz (0 = none), and the fraction that passes above it. */
  fc: number;
  floor: number;
  /** Arrives as the diffuse field of the space the microphone is in. */
  diffuse: boolean;
}

export interface Scene {
  zone: number;
  /** Decay time of the space the microphone is in, s (0 outside). */
  t60: number;
  /** Size of that space, m: sets the spacing of its echoes. */
  size: number;
  outlets: Tap[][];
  intake: Tap[];
  engine: Tap[];
  /** Tyre and wind noise arrive from all round the car: a gain and a low-pass corner. */
  road: { gain: number; fc: number; floor: number };
}

interface Leak { at: Vec3; area: number; fc: number }

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Mass law: a panel passes sound like a low-pass at 224 / (kg per m2) Hz. */
const massCorner = (kgm2: number) => 224 / kgm2;

/** Extra path length round a box that blocks the straight line, m; 0 when the line is clear. */
export function detour(a: Vec3, b: Vec3, box: Box): number {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) { if (a[k] <= box[k] || a[k] >= box[k + 3]) return 0; continue; }
    let u = (box[k] - a[k]) / d, v = (box[k + 3] - a[k]) / d;
    if (u > v) { const w = u; u = v; v = w; }
    if (u > t0) t0 = u;
    if (v < t1) t1 = v;
    if (t1 - t0 < 1e-3) return 0;
  }
  const tm = 0.5 * (t0 + t1), direct = dist(a, b);
  const m: Vec3 = [a[0] + (b[0] - a[0]) * tm, a[1] + (b[1] - a[1]) * tm, a[2] + (b[2] - a[2]) * tm];
  let best = Infinity;
  // the shortest way round passes one of the faces beside the line, not the ones it goes in and out through
  for (let k = 0; k < 3; k++) for (const hi of [0, 3]) {
    if (Math.abs(b[k] - a[k]) > 0.8 * direct) continue;
    const q: Vec3 = [m[0], m[1], m[2]];
    q[k] = box[k + hi] + (hi ? 0.03 : -0.03);
    if (q[1] < GROUND_Y + 0.02) continue;
    best = Math.min(best, dist(a, q) + dist(q, b) - direct);
  }
  return Math.max(1e-3, best);
}

/**
 * Sound between two points outside the car. A blocked line bends round the body and loses
 * its high frequencies (Maekawa: 5 dB at the shadow edge, more as the detour grows).
 */
function outdoor(a: Vec3, b: Vec3, blockers: Box[], reflect: number, scale = 1, extra = 0, fc = 0): Tap[] {
  const taps: Tap[] = [];
  const one = (src: Vec3, k: number) => {
    const r = Math.max(0.25, dist(src, b));
    let d = 0;
    for (const box of blockers) d += detour(src, b, box);
    const shadow = d > 0;
    const corner = shadow ? 51 / d : 0;
    taps.push({
      gain: (k * scale * (shadow ? 0.58 : 1)) / (4 * Math.PI * r), delay: (r + d) / C + extra,
      fc: fc && corner ? Math.min(fc, corner) : fc || corner, floor: shadow ? 0.1 : 0, diffuse: false,
    });
  };
  one(a, 1);
  if (reflect > 0) one([a[0], 2 * GROUND_Y - a[1], a[2]], reflect);
  return taps;
}

/** Level of a set of paths at one frequency, dB (paths added as powers). */
export function tapLevel(taps: Tap[], hz: number): number {
  let sum = 0;
  for (const t of taps) {
    const h = t.fc > 0 ? t.floor + (1 - t.floor) / Math.sqrt(1 + (hz / t.fc) ** 2) : 1;
    sum += (t.gain * h) ** 2;
  }
  return 10 * Math.log10(sum + 1e-30);
}

const sabine = (volume: number, absorption: number) => (0.161 * volume) / absorption;

export function buildScene(p: Params, pl: Placement): Scene {
  const mic: Vec3 = [p.micX, GROUND_Y + p.micY, p.micZ];
  const reflect = p.fxGround > 0.5 ? 0.85 : 0;
  const b = pl.body;
  if (p.carBody < 0.5) {
    return {
      zone: OUTSIDE, t60: 0, size: 0,
      outlets: pl.outlets.map((o) => outdoor(o, mic, [], reflect)),
      intake: outdoor(pl.mouth, mic, [], reflect), engine: outdoor(pl.engine, mic, [], reflect),
      road: { gain: 1, fc: 0, floor: 0 },
    };
  }
  const solid = [b.lower, b.greenhouse];
  const zone = inside(b.cabin, mic[0], mic[1], mic[2]) ? CABIN : inside(b.bay, mic[0], mic[1], mic[2]) ? BAY : OUTSIDE;

  // ---- engine bay: what it absorbs and where sound gets out
  const bayLen = b.firewallZ - b.frontZ, bayMid = 0.5 * (b.firewallZ + b.frontZ), bayW = 2 * b.halfWidth;
  const open = Math.max(0, Math.min(1, p.bonnetOpen / 100));
  const theta = (open * 60 * Math.PI) / 180;
  // a lid hinged at the firewall: the gap along the front edge and the two triangular sides
  const bonnetArea = Math.min(bayW * bayLen, (bayW * bayLen + bayLen * bayLen) * Math.sin(theta));
  const bayLeaks: Leak[] = [
    { at: [0, GROUND_Y + 0.08, bayMid], area: p.undertray > 0.5 ? 0.06 : 0.5, fc: 0 },
    { at: [0, GROUND_Y + 0.5, b.frontZ - 0.03], area: 0.1, fc: 0 },
    { at: [0, b.bonnetY + 0.06, b.frontZ + 0.35 * bayLen], area: bonnetArea, fc: 0 },
    // through the bonnet skin itself
    { at: [0, b.bonnetY + 0.04, bayMid], area: open < 1 ? bayW * bayLen : 0, fc: massCorner(7) },
  ];
  const bayOpen = bayLeaks[0].area + bayLeaks[1].area + bayLeaks[2].area;
  const bayAbs = (0.08 + 0.5 * (p.bayLining / 100)) * 2 * (bayW * bayLen + bayLen * 0.7 + bayW * 0.7) + bayOpen;
  const bayVol = 0.45 * bayW * bayLen * (b.bonnetY - b.floorY);

  // ---- cabin
  const cabLen = b.cabinRearZ - b.firewallZ, cabMid = 0.5 * (b.cabinRearZ + b.firewallZ);
  const win = 0.35 * Math.max(0, Math.min(1, p.windowsOpen / 100));
  const winY = b.bonnetY + 0.22;
  const cabAbs = p.cabinAbsorb + 2 * win;
  const cabVol = 1.5 * cabLen * (b.roofY - b.floorY - 0.12) * 0.75;
  const shell = { area: 2 * (1.5 * cabLen + cabLen * 1.1 + 1.5 * 1.1), fc: massCorner(p.cabinMass) };
  const firewall = { area: 1.5 * 0.7, fc: massCorner(p.firewallMass) };
  const nearest = (s: Vec3): Vec3 => [Math.max(b.cabin[0], Math.min(b.cabin[3], s[0])), Math.max(b.cabin[1], Math.min(b.cabin[4], s[1])), Math.max(b.cabin[2], Math.min(b.cabin[5], s[2]))];

  /** Sound arriving outside the cabin at `s` (already attenuated by `scale`), heard inside it. */
  const intoCabin = (s: Vec3, scale: number, extra: number, fc0: number): Tap[] => {
    const taps: Tap[] = [];
    // level inside = level outside - panel loss + 10 log(S / A); an open window cannot do better than no wall
    const add = (t: Tap[], k: number) => { for (const x of t) taps.push({ ...x, gain: x.gain * k, diffuse: true }); };
    // the shell is lit unevenly: take the level half a cabin beyond its nearest point
    const r = dist(s, nearest(s)) + 0.7;
    const fc = fc0 ? Math.min(fc0, shell.fc) : shell.fc;
    add([{ gain: scale / (4 * Math.PI * r), delay: r / C + extra, fc, floor: 0, diffuse: true }], Math.sqrt(shell.area / cabAbs));
    if (win > 0) for (const side of [-1, 1]) add(outdoor(s, [side * (b.halfWidth + 0.02), winY, cabMid], [b.lower], 0, scale, extra, fc0), Math.min(1, Math.sqrt(win / cabAbs)));
    return taps;
  };

  const share = (l: Leak) => (l.fc ? Math.sqrt(l.area / bayAbs) : Math.min(1, Math.sqrt(l.area / bayAbs)));
  const route = (s0: Vec3): Tap[] => {
    let s = s0;
    const inBay = inside(b.bay, s[0], s[1], s[2]);
    // an outlet under the floor radiates from beneath the car
    if (!inBay && inside(b.lower, s[0], s[1], s[2])) s = [s[0], GROUND_Y + 0.09, s[2]];
    if (!inBay) {
      if (zone === OUTSIDE) return outdoor(s, mic, solid, reflect);
      if (zone === CABIN) return intoCabin(s, 1, 0, 0);
      // into the bay through its openings
      return bayLeaks.filter((l) => l.area > 0).flatMap((l) => outdoor(s, l.at, [b.lower], 0, share(l), 0, l.fc).map((t) => ({ ...t, diffuse: true })));
    }
    // a source in the bay fills it with a diffuse field: p = strength / sqrt(pi A)
    if (zone === BAY) {
      const r = Math.max(0.15, dist(s, mic));
      return [
        { gain: 1 / (4 * Math.PI * r), delay: r / C, fc: 0, floor: 0, diffuse: false },
        { gain: 1 / Math.sqrt(Math.PI * bayAbs), delay: 0.001, fc: 0, floor: 0, diffuse: true },
      ];
    }
    const taps: Tap[] = [];
    for (const l of bayLeaks) {
      if (l.area <= 0) continue;
      // the share of the bay's sound power that leaves this way, re-radiated from the opening
      const k = share(l), lag = dist(s, l.at) / C;
      if (zone === OUTSIDE) taps.push(...outdoor(l.at, mic, solid, reflect, k, lag, l.fc));
      else taps.push(...intoCabin(l.at, k, lag, l.fc));
    }
    if (zone === CABIN) taps.push({ gain: Math.sqrt(firewall.area / cabAbs) / Math.sqrt(Math.PI * bayAbs), delay: 0.002, fc: firewall.fc, floor: 0, diffuse: true });
    return taps;
  };

  let road = { gain: 1, fc: 0, floor: 0 };
  if (zone === CABIN) {
    // through the shell (bass only) and, flat, through any open window
    const ks = Math.sqrt(shell.area / cabAbs), kw = Math.min(1, Math.sqrt((2 * win) / cabAbs));
    road = { gain: Math.max(ks, kw), fc: shell.fc, floor: kw / Math.max(ks, kw) };
  } else if (zone === BAY) road = { gain: Math.min(1, Math.sqrt(bayOpen / bayAbs)), fc: 0, floor: 0 };

  return {
    zone,
    t60: zone === CABIN ? sabine(cabVol, cabAbs) : zone === BAY ? sabine(bayVol, bayAbs) : 0,
    size: zone === CABIN ? Math.cbrt(cabVol) : zone === BAY ? Math.cbrt(bayVol) : 0,
    outlets: pl.outlets.map(route), intake: route(pl.mouth), engine: route(pl.engine), road,
  };
}
