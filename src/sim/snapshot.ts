// Layout of the Float32Array state snapshot posted from the audio thread.

export const SNAP_HEADER = 32;
export const SNAP_CYL_STRIDE = 10;
export const SNAP_VOL_STRIDE = 3;
export const TRACE_BINS = 720;

export const H = {
  theta: 0,
  rpm: 1,
  torque: 2,
  power: 3,
  ve: 4,
  map: 5,
  throttle: 6,
  nCyl: 7,
  nVol: 8,
  nCells: 9,
  cpuLoad: 10,
  flags: 11,
  simTime: 12,
  instTorque: 13,
  timeScale: 14,
  hasTraces: 15,
  resets: 16,
  substeps: 17,
  mdotAir: 18,
  topoId: 19,
  peakOut: 20,
} as const;

export const FLAG_STARTER = 1;
export const FLAG_LIMITER = 2;
export const FLAG_IGNITION = 4;
export const FLAG_PAUSED = 8;

/** Per-cylinder fields. */
export const C = {
  angle: 0,
  p: 1,
  T: 2,
  V: 3,
  Y: 4,
  liftIn: 5,
  liftEx: 6,
  flash: 7,
  mdotIn: 8,
  mdotEx: 9,
} as const;

export function snapshotSize(nCyl: number, nVol: number, nCells: number): number {
  return SNAP_HEADER + nCyl * SNAP_CYL_STRIDE + nVol * SNAP_VOL_STRIDE + nCells * 4 + nCyl * TRACE_BINS;
}

export const SNAP_MAX_FLOATS = snapshotSize(12, 32, 600);

/** Read-side helper. */
export class SnapshotView {
  constructor(public a: Float32Array) {}
  get nCyl(): number { return this.a[H.nCyl]; }
  get nVol(): number { return this.a[H.nVol]; }
  get nCells(): number { return this.a[H.nCells]; }
  h(i: number): number { return this.a[i]; }
  cyl(i: number, field: number): number { return this.a[SNAP_HEADER + i * SNAP_CYL_STRIDE + field]; }
  get volBase(): number { return SNAP_HEADER + this.nCyl * SNAP_CYL_STRIDE; }
  volP(v: number): number { return this.a[this.volBase + v * 3]; }
  volT(v: number): number { return this.a[this.volBase + v * 3 + 1]; }
  volY(v: number): number { return this.a[this.volBase + v * 3 + 2]; }
  get cellBase(): number { return this.volBase + this.nVol * SNAP_VOL_STRIDE; }
  cellP(j: number): number { return this.a[this.cellBase + j]; }
  cellT(j: number): number { return this.a[this.cellBase + this.nCells + j]; }
  cellU(j: number): number { return this.a[this.cellBase + 2 * this.nCells + j]; }
  cellY(j: number): number { return this.a[this.cellBase + 3 * this.nCells + j]; }
  get traceBase(): number { return this.cellBase + 4 * this.nCells; }
}
