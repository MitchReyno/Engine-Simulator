// Geometry helpers for the detailed mechanical view: chain paths, sprockets, springs, cam lobes.

import * as THREE from 'three';

export interface Circle { x: number; y: number; r: number }

interface Seg { line: boolean; len: number; x: number; y: number; ang: number; r: number }

/** A chain wrapped around the outside of a set of sprockets, travelling counter-clockwise. */
export class BeltPath {
  readonly segs: Seg[] = [];
  readonly total: number;
  /** Straight runs: midpoint, direction angle and length, in the same order as the circles. */
  readonly spans: { x: number; y: number; ang: number; len: number; from: number }[] = [];

  constructor(circles: Circle[]) {
    const cx = circles.reduce((s, c) => s + c.x, 0) / circles.length;
    const cy = circles.reduce((s, c) => s + c.y, 0) / circles.length;
    const order = circles.map((c, i) => ({ c, i, a: Math.atan2(c.y - cy, c.x - cx) })).sort((p, q) => p.a - q.a);
    const n = order.length;
    // Outer tangent between consecutive sprockets: the normal on the right of travel.
    const normals: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = order[k].c, b = order[(k + 1) % n].c;
      const dx = b.x - a.x, dy = b.y - a.y, D = Math.hypot(dx, dy);
      const q = (a.r - b.r) / D, w = Math.sqrt(Math.max(0, 1 - q * q));
      normals.push(Math.atan2((dy / D) * q - (dx / D) * w, (dx / D) * q + (dy / D) * w));
    }
    let total = 0;
    for (let k = 0; k < n; k++) {
      const a = order[k].c, b = order[(k + 1) % n].c;
      const nIn = normals[(k + n - 1) % n], nOut = normals[k];
      let sweep = nOut - nIn;
      while (sweep < 0) sweep += 2 * Math.PI;
      while (sweep >= 2 * Math.PI) sweep -= 2 * Math.PI;
      this.segs.push({ line: false, len: sweep * a.r, x: a.x, y: a.y, ang: nIn, r: a.r });
      const x0 = a.x + a.r * Math.cos(nOut), y0 = a.y + a.r * Math.sin(nOut);
      const x1 = b.x + b.r * Math.cos(nOut), y1 = b.y + b.r * Math.sin(nOut);
      const len = Math.hypot(x1 - x0, y1 - y0), ang = Math.atan2(y1 - y0, x1 - x0);
      this.segs.push({ line: true, len, x: x0, y: y0, ang, r: 0 });
      this.spans.push({ x: 0.5 * (x0 + x1), y: 0.5 * (y0 + y1), ang, len, from: order[k].i });
      total += sweep * a.r + len;
    }
    this.total = total;
  }

  /** Position and travel direction at arc length s (wraps). */
  at(s: number, out: { x: number; y: number; ang: number }): void {
    s %= this.total;
    if (s < 0) s += this.total;
    for (const g of this.segs) {
      if (s > g.len) { s -= g.len; continue; }
      if (g.line) {
        out.x = g.x + Math.cos(g.ang) * s;
        out.y = g.y + Math.sin(g.ang) * s;
        out.ang = g.ang;
      } else {
        const a = g.ang + s / g.r;
        out.x = g.x + g.r * Math.cos(a);
        out.y = g.y + g.r * Math.sin(a);
        out.ang = a + Math.PI / 2;
      }
      return;
    }
  }
}

/** Toothed disc in the XY plane, centred on z. */
export function sprocketGeometry(pitchRadius: number, teeth: number, thickness: number, toothDepth: number): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  const root = pitchRadius - toothDepth, tip = pitchRadius + 0.4 * toothDepth;
  for (let k = 0; k < teeth; k++) {
    for (const [f, rad] of [[0.1, root], [0.35, tip], [0.65, tip], [0.9, root]] as const) {
      const a = ((k + f) / teeth) * 2 * Math.PI;
      if (k === 0 && f === 0.1) sh.moveTo(rad * Math.cos(a), rad * Math.sin(a));
      else sh.lineTo(rad * Math.cos(a), rad * Math.sin(a));
    }
  }
  sh.closePath();
  const geo = new THREE.ExtrudeGeometry(sh, { depth: thickness, bevelEnabled: false });
  geo.translate(0, 0, -thickness / 2);
  return geo;
}

class Helix extends THREE.Curve<THREE.Vector3> {
  constructor(private radius: number, private turns: number, private height: number) {
    super();
  }
  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const a = t * this.turns * 2 * Math.PI;
    return target.set(this.radius * Math.cos(a), t * this.height, this.radius * Math.sin(a));
  }
}

/** Coil spring along +Y from 0 to height; compress it by scaling Y. */
export function springGeometry(radius: number, wire: number, turns: number, height: number): THREE.BufferGeometry {
  return new THREE.TubeGeometry(new Helix(radius, turns, height), turns * 14, wire, 5, false);
}

/**
 * Cam lobe outline from the same lift law the simulation uses, nose along +X.
 * `gain` is follower travel per unit valve lift (the rocker ratio seen at the roller).
 */
export function lobeGeometry(base: number, lift: number, durationCrankDeg: number, exponent: number, gain: number, width: number): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  const steps = 96;
  for (let i = 0; i < steps; i++) {
    const camDeg = (i / steps) * 360 - 180;
    const x = (4 * camDeg) / durationCrankDeg;
    const rad = base + (x > -1 && x < 1 ? gain * lift * Math.pow(1 - x * x, exponent) : 0);
    const a = (camDeg * Math.PI) / 180;
    if (i === 0) sh.moveTo(rad * Math.cos(a), rad * Math.sin(a));
    else sh.lineTo(rad * Math.cos(a), rad * Math.sin(a));
  }
  sh.closePath();
  const geo = new THREE.ExtrudeGeometry(sh, { depth: width, bevelEnabled: false });
  geo.translate(0, 0, -width / 2);
  return geo;
}
