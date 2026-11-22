// A closed circuit as an evenly sampled centreline. No DOM or three.js: the audio thread uses it too.

export interface Track {
  n: number;
  /** Sample spacing along the centreline, m. */
  ds: number;
  length: number;
  halfWidth: number;
  x: Float64Array;
  y: Float64Array;
  /** Unit tangent. The left-hand normal is (-ty, tx). */
  tx: Float64Array;
  ty: Float64Array;
  /** Signed curvature, 1/m, positive turning left. */
  curv: Float64Array;
}

export function buildTrack(points: [number, number][], halfWidth = 6, spacing = 2): Track {
  const m = points.length;
  // Closed uniform Catmull-Rom through the control points, sampled densely.
  const fx: number[] = [], fy: number[] = [];
  const per = 48;
  for (let i = 0; i < m; i++) {
    const p0 = points[(i + m - 1) % m], p1 = points[i], p2 = points[(i + 1) % m], p3 = points[(i + 2) % m];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      const c0 = -0.5 * t3 + t2 - 0.5 * t, c1 = 1.5 * t3 - 2.5 * t2 + 1, c2 = -1.5 * t3 + 2 * t2 + 0.5 * t, c3 = 0.5 * t3 - 0.5 * t2;
      fx.push(c0 * p0[0] + c1 * p1[0] + c2 * p2[0] + c3 * p3[0]);
      fy.push(c0 * p0[1] + c1 * p1[1] + c2 * p2[1] + c3 * p3[1]);
    }
  }
  const nf = fx.length;
  const cum = new Float64Array(nf + 1);
  for (let i = 0; i < nf; i++) cum[i + 1] = cum[i] + Math.hypot(fx[(i + 1) % nf] - fx[i], fy[(i + 1) % nf] - fy[i]);
  const length = cum[nf];
  const n = Math.round(length / spacing);
  const ds = length / n;
  const x = new Float64Array(n), y = new Float64Array(n), tx = new Float64Array(n), ty = new Float64Array(n), curv = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    while (cum[j + 1] < s) j++;
    const w = (s - cum[j]) / (cum[j + 1] - cum[j]);
    const a = j % nf, b = (j + 1) % nf;
    x[i] = fx[a] + (fx[b] - fx[a]) * w;
    y[i] = fy[a] + (fy[b] - fy[a]) * w;
  }
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, b = (i + 1) % n;
    const dx = x[b] - x[a], dy = y[b] - y[a], d = Math.hypot(dx, dy);
    tx[i] = dx / d;
    ty[i] = dy / d;
  }
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, b = (i + 1) % n;
    curv[i] = (tx[a] * ty[b] - ty[a] * tx[b]) / (2 * ds);
  }
  return { n, ds, length, halfWidth, x, y, tx, ty, curv };
}

export interface TrackPos {
  index: number;
  /** Distance along the lap, m. */
  s: number;
  /** Offset from the centreline, m, positive to the left. */
  d: number;
}

/** Nearest centreline sample. Pass the previous index as `hint` for a cheap local search, or -1 to search the whole lap. */
export function locate(t: Track, px: number, py: number, hint: number, out: TrackPos): TrackPos {
  let best = 0, bestD = Infinity;
  if (hint < 0) {
    for (let i = 0; i < t.n; i++) {
      const dx = px - t.x[i], dy = py - t.y[i], d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = i; }
    }
  } else {
    for (let k = -12; k <= 12; k++) {
      const i = (hint + k + t.n) % t.n;
      const dx = px - t.x[i], dy = py - t.y[i], d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = i; }
    }
  }
  const dx = px - t.x[best], dy = py - t.y[best];
  out.index = best;
  out.s = best * t.ds + dx * t.tx[best] + dy * t.ty[best];
  out.d = -dx * t.ty[best] + dy * t.tx[best];
  return out;
}

/** An original 2 km layout: long straight, fast esses, two slow corners. Metres, driven anticlockwise. */
const POINTS: [number, number][] = [
  [0, 0], [200, 0], [420, 0], [540, 20], [610, 90], [620, 200], [580, 290], [480, 330], [380, 300], [300, 230],
  [220, 250], [170, 330], [90, 380], [-30, 370], [-120, 300], [-170, 200], [-185, 90], [-140, 15], [-60, 0],
];

export const CIRCUIT = buildTrack(POINTS);
