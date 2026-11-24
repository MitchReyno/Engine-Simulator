// Layout of the Float32Array state snapshot posted from the audio thread.

export const SNAP_HEADER = 64;
export const SNAP_CYL_STRIDE = 10;
export const SNAP_VOL_STRIDE = 3;
/** Per pipe cell: pressure, temperature, velocity, burned fraction, afterfire brightness. */
export const SNAP_CELL_FIELDS = 5;
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
  wallT: 21,
  strokes: 22,
  /** Intake cam phaser advance, crank degrees. */
  vtc: 23,
  /** 1 when the rockers are locked to the high lobes. */
  vtec: 24,
  // Car state, driving mode. Positions in metres on the track plane, heading anticlockwise from +x.
  drive: 32,
  carX: 33,
  carY: 34,
  carPsi: 35,
  carVx: 36,
  carVy: 37,
  carYaw: 38,
  carSteer: 39,
  carGear: 40,
  carRotF: 41,
  carRotR: 42,
  carSlipF: 43,
  carSlipR: 44,
  carGrass: 45,
  lapTime: 46,
  lastLap: 47,
  bestLap: 48,
  laps: 49,
  carS: 50,
  carClutch: 51,
  carAx: 52,
  carAy: 53,
  carAids: 54,
  /** Sound pressure level of exhaust plus intake at the listener, dB re 20 uPa. */
  spl: 55,
  /** Forced induction: charge pressure above atmospheric (Pa), compressor speed (rpm), wastegate opening 0..1. */
  boost: 56,
  turboRpm: 57,
  wastegate: 58,
  /** Torque absorbed by the speed-holding dynamometer, N m, and crank speed averaged over the last cycle. */
  dynoTorque: 59,
  rpmAvg: 60,
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
  /** Combustion brightness: burn rate scaled by the size of the charge, peak since the last snapshot. */
  flash: 7,
  mdotIn: 8,
  mdotEx: 9,
} as const;

export function snapshotSize(nCyl: number, nVol: number, nCells: number): number {
  return SNAP_HEADER + nCyl * SNAP_CYL_STRIDE + nVol * SNAP_VOL_STRIDE + nCells * SNAP_CELL_FIELDS + nCyl * TRACE_BINS;
}

export const SNAP_MAX_FLOATS = snapshotSize(12, 32, 1200);

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
  /** Afterfire burning in this cell, 0..1. */
  cellFire(j: number): number { return this.a[this.cellBase + 4 * this.nCells + j]; }
  get traceBase(): number { return this.cellBase + SNAP_CELL_FIELDS * this.nCells; }
}
