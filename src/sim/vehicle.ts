// The car: clutch, gearbox, driven wheels, tyres and a planar chassis.
// Stepped once per audio sample from the engine model, so the crankshaft really is loaded by the car.

import { Params } from './params';
import { Track, TrackPos, locate } from './track';

const G0 = 9.81;
const RHO_AIR = 1.2;
const WHEELBASE = 2.67;
const CG_HEIGHT = 0.5;
const HALF_TRACK = 0.78;
const STEER_MAX = 0.58;
/** Slip ratio and slip-angle tangent at peak grip. */
const KAPPA_PEAK = 0.11;
const TAN_ALPHA_PEAK = 0.14;
/** Tyre curve sin(C atan(B s)): peak 1 at s = 1, falling to 0.85 when fully sliding. */
const TYRE_C = 1.35;
const TYRE_B = 2.318;
const CLUTCH_K = 150;
const SHIFT_TIME = 0.18;
const V_MIN = 2;
export const GEARS = 6;

export class Vehicle {
  x = 0; y = 0; psi = 0;
  /** Body-frame velocities (forward, left) and yaw rate. */
  vx = 0; vy = 0; yaw = 0;
  /** Axle wheel speeds, rad/s, and accumulated rotation for drawing. */
  wF = 0; wR = 0; rotF = 0; rotR = 0;
  steer = 0;
  gear = 1;
  /** Clutch engagement, 0 open to 1 clamped. */
  clutch = 0;
  ax = 0; ay = 0;
  /** Combined slip relative to the grip peak, per axle: above 1 the tyre is sliding. */
  slipF = 0; slipR = 0;
  grass = 0;
  /** Torque the clutch takes from the crankshaft, N·m. */
  clutchTorque = 0;
  /** Throttle the gearbox or traction control asks for instead of the pedal; -1 for none. */
  thrOverride = -1;
  absActive = false; tcActive = false;

  lapTime = 0; lastLap = 0; bestLap = 0; laps = 0;
  readonly pos: TrackPos = { index: -1, s: 0, d: 0 };
  private sector = 0;
  private shiftT = 0; private sinceShift = 1; private pending = 1;
  private muF = 1; private muR = 1; private roll = 0.015; private tick = 0;
  private axF = 0;

  constructor(readonly track: Track) {
    this.reset(true);
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  /** Stop the car on the centreline: on the grid, or where it last was on the lap. */
  reset(toGrid: boolean): void {
    const t = this.track;
    let i = toGrid || this.pos.index < 0 ? t.n - Math.round(12 / t.ds) : this.pos.index;
    i = ((i % t.n) + t.n) % t.n;
    this.x = t.x[i];
    this.y = t.y[i];
    this.psi = Math.atan2(t.ty[i], t.tx[i]);
    this.vx = this.vy = this.yaw = this.wF = this.wR = this.steer = 0;
    this.ax = this.ay = this.axF = 0;
    this.clutch = 0;
    this.gear = this.pending = 1;
    this.shiftT = 0;
    this.pos.index = i;
    if (toGrid) {
      this.startArmed = true;
      this.lapTime = 0;
      this.sector = 0;
      this.laps = 0;
    }
  }

  /** Request a gear change: +1 up, -1 down. Order is R, N, 1..6. */
  shift(dir: number, autoClutch = true): void {
    const from = this.shiftT > 0 ? this.pending : this.gear;
    let to = from + (dir > 0 ? 1 : -1);
    if (to < -1 || to > GEARS) return;
    // No reverse while rolling forwards, no forward gear while rolling backwards.
    if (to < 0 && this.vx > 2) return;
    if (to > 0 && from <= 0 && this.vx < -2) return;
    this.pending = to;
    this.sinceShift = 0;
    if (autoClutch) this.shiftT = SHIFT_TIME;
    else this.gear = to;
  }

  private ratio(p: Params, gear: number): number {
    return gear === 0 ? 0 : gear < 0 ? -3.3 : p['gear' + gear];
  }

  step(dt: number, omegaE: number, p: Params, throttle: number, clutchCap: number): void {
    const t = this.track;
    const m = p.carMass, layout = p.drivetrain | 0;
    const frontShare = layout === 0 ? 0.6 : layout === 1 ? 0.5 : 0.56;
    const a = WHEELBASE * (1 - frontShare), b = WHEELBASE * frontShare;
    const R = p.tyreDiameter * 0.5e-3;
    const brake = p.brake * 0.01;
    const rpm = omegaE * 9.549297;

    // Surface under each axle, refreshed about once a millisecond.
    if ((this.tick++ & 31) === 0) {
      locate(t, this.x, this.y, this.pos.index, this.pos);
      const i = this.pos.index;
      const cs = Math.cos(this.psi), sn = Math.sin(this.psi);
      const nx = -t.ty[i], ny = t.tx[i];
      const along = cs * nx + sn * ny, across = -sn * nx + cs * ny;
      const off = (lx: number, ly: number) => (Math.abs(this.pos.d + lx * along + ly * across) > t.halfWidth ? 0.5 : 0);
      const gF = off(a, HALF_TRACK) + off(a, -HALF_TRACK), gR = off(-b, HALF_TRACK) + off(-b, -HALF_TRACK);
      // A little more grip at the rear, as chassis tuning gives a road car: it pushes wide before it spins.
      const bias = layout === 1 ? 0.03 : 0.05;
      this.muF = p.tyreGrip * (1 - bias) * (1 - 0.45 * gF);
      this.muR = p.tyreGrip * (1 + bias) * (1 - 0.45 * gR);
      this.grass = 0.5 * (gF + gR);
      this.roll = 0.015 + 0.1 * this.grass;
      this.timing(32 * dt);
    }

    // Gearbox logic.
    this.sinceShift += dt;
    const auto = p.autoClutch > 0.5;
    if (this.shiftT > 0) {
      this.shiftT -= dt;
      if (this.shiftT <= 0.5 * SHIFT_TIME) this.gear = this.pending;
    }
    const gear = this.gear;
    const G = this.ratio(p, gear) * p.finalDrive;
    const wDriven = layout === 0 ? this.wF : layout === 1 ? this.wR : 0.5 * (this.wF + this.wR);
    const wIn = wDriven * G;
    const rpmIn = Math.abs(wIn) * 9.549297;
    if (p.autoShift > 0.5 && gear >= 1 && this.shiftT <= 0 && this.sinceShift > 0.45) {
      // Sport logic: hold the gear on a lifted throttle, change down under braking and on kick-down.
      const up = throttle < 0.15 ? Infinity : p.revLimit * (throttle > 0.6 ? 0.93 : 0.75);
      const down = p.revLimit * (brake > 0.1 ? 0.45 : 0.25 + 0.2 * throttle);
      if (gear < GEARS && rpm > up && this.clutch > 0.9) this.shift(1);
      else if (gear > 1 && rpmIn < down && (rpmIn * p['gear' + (gear - 1)]) / p['gear' + gear] < 0.84 * p.revLimit) this.shift(-1);
    }
    let override = -1;
    if (this.shiftT > 0 && auto) override = this.pending > gear || this.pending === 0 ? 0 : Math.max(throttle, 0.25);

    // Clutch: automatic (slips above idle to pull away, opens before a stall) or the pedal.
    if (auto) {
      let want = 0;
      if (gear !== 0 && this.shiftT <= 0) {
        const slipLaw = (rpm - (p.idleRpm + 150)) / 900;
        want = rpmIn > 1.25 * p.idleRpm ? 1 : slipLaw < 0 ? 0 : slipLaw > 1 ? 1 : slipLaw;
        // Foot off the throttle at walking pace: stay open, so the car does not creep.
        if (throttle < 0.03 && rpmIn < 1.25 * p.idleRpm) want = 0;
      }
      const rate = (want > this.clutch ? 4 : 25) * dt;
      this.clutch = Math.abs(want - this.clutch) <= rate ? want : this.clutch + Math.sign(want - this.clutch) * rate;
    } else {
      this.clutch = 1 - p.clutch * 0.01;
    }
    let Tc = 0;
    if (G !== 0) {
      const cap = this.clutch * clutchCap;
      Tc = CLUTCH_K * (omegaE - wIn);
      if (Tc > cap) Tc = cap; else if (Tc < -cap) Tc = -cap;
    }
    this.clutchTorque = Tc;
    const tAxle = Tc * G * 0.94;
    const tDriveF = layout === 0 ? tAxle : layout === 1 ? 0 : 0.5 * tAxle;
    const tDriveR = tAxle - tDriveF;

    // Steering and vertical loads (longitudinal load transfer only).
    this.steer += (p.steer * 0.01 * STEER_MAX - this.steer) * Math.min(1, dt / 0.05);
    const cd = Math.cos(this.steer), sd = Math.sin(this.steer);
    this.axF += (this.ax - this.axF) * Math.min(1, dt / 0.06);
    const shiftLoad = (m * this.axF * CG_HEIGHT) / WHEELBASE;
    const FzF = Math.max(0, (m * G0 * b) / WHEELBASE - shiftLoad), FzR = Math.max(0, (m * G0 * a) / WHEELBASE + shiftLoad);

    // Front tyres, in the steered wheel frame.
    const vyF = this.vy + a * this.yaw;
    const vlF = this.vx * cd + vyF * sd, vtF = -this.vx * sd + vyF * cd;
    let den = Math.abs(vlF) > V_MIN ? Math.abs(vlF) : V_MIN;
    let sx = (this.wF * R - vlF) / den / KAPPA_PEAK, sy = -vtF / den / TAN_ALPHA_PEAK;
    let sig = Math.hypot(sx, sy);
    let F = sig > 1e-6 ? (this.muF * FzF * Math.sin(TYRE_C * Math.atan(TYRE_B * sig))) / sig : 0;
    const FxF = F * sx, FyF = F * sy;
    this.slipF = sig;
    const kF = sx * KAPPA_PEAK;
    // Rear tyres.
    const vyR = this.vy - b * this.yaw;
    den = Math.abs(this.vx) > V_MIN ? Math.abs(this.vx) : V_MIN;
    sx = (this.wR * R - this.vx) / den / KAPPA_PEAK;
    sy = -vyR / den / TAN_ALPHA_PEAK;
    sig = Math.hypot(sx, sy);
    F = sig > 1e-6 ? (this.muR * FzR * Math.sin(TYRE_C * Math.atan(TYRE_B * sig))) / sig : 0;
    const FxR = F * sx, FyR = F * sy;
    this.slipR = sig;
    const kR = sx * KAPPA_PEAK;

    // Brakes, with ABS releasing an axle that is locking.
    const fBrake = brake * p.brakeForce * m * G0 * R;
    let tbF = 0.64 * fBrake, tbR = 0.36 * fBrake;
    this.absActive = false;
    if (p.abs > 0.5 && this.vx > 3) {
      if (kF < -0.14) { tbF *= 0.25; this.absActive = true; }
      if (kR < -0.14) { tbR *= 0.25; this.absActive = true; }
    }
    // Traction control: lift the throttle while a driven axle spins.
    this.tcActive = false;
    if (p.tc > 0.5 && throttle > 0.05 && gear !== 0) {
      // Driven tyres past their grip peak while being driven: that is wheelspin or power understeer.
      const kd = (layout === 0 ? kF : layout === 1 ? kR : Math.max(kF, kR)) * Math.sign(G);
      const sd = layout === 0 ? this.slipF : layout === 1 ? this.slipR : Math.max(this.slipF, this.slipR);
      if (kd > 0.03 && sd > 1.1) { this.tcActive = true; if (override < 0) override = 0.12 * throttle; }
    }
    this.thrOverride = override;

    // Wheels. Driveline inertia sits on the driven axle.
    const iF = 2 + (layout !== 1 ? 0.4 : 0), iR = 2 + (layout !== 0 ? 0.4 : 0);
    this.wF = spinWheel(this.wF, tDriveF - FxF * R, tbF, iF, dt);
    this.wR = spinWheel(this.wR, tDriveR - FxR * R, tbR, iR, dt);
    this.rotF = (this.rotF + this.wF * dt) % (2 * Math.PI);
    this.rotR = (this.rotR + this.wR * dt) % (2 * Math.PI);

    // Chassis.
    const v = this.speed;
    const resist = v > 0.05 ? (0.5 * RHO_AIR * p.dragArea * v * v + this.roll * m * G0) / v : 0;
    const Fx = FxF * cd - FyF * sd + FxR - resist * this.vx;
    const Fy = FxF * sd + FyF * cd + FyR - resist * this.vy;
    const Mz = a * (FxF * sd + FyF * cd) - b * FyR;
    this.ax = Fx / m;
    this.ay = Fy / m;
    this.vx += (this.ax + this.vy * this.yaw) * dt;
    this.vy += (this.ay - this.vx * this.yaw) * dt;
    this.yaw += (Mz / (m * a * b)) * dt;
    this.psi += this.yaw * dt;
    const cs = Math.cos(this.psi), sn = Math.sin(this.psi);
    this.x += (this.vx * cs - this.vy * sn) * dt;
    this.y += (this.vx * sn + this.vy * cs) * dt;
  }

  /** Lap timing: three sectors must be passed in order before the line counts. */
  private timing(dt: number): void {
    this.lapTime += dt;
    const f = this.pos.s / this.track.length;
    if (Math.abs(this.pos.d) > 40) return;
    if (this.sector < 3) {
      const gate = (this.sector + 1) * 0.25;
      if (f > gate && f < gate + 0.1) this.sector++;
    } else if (f < 0.05 && f >= 0) {
      this.lastLap = this.lapTime;
      if (this.bestLap === 0 || this.lapTime < this.bestLap) this.bestLap = this.lapTime;
      this.laps++;
      this.lapTime = 0;
      this.sector = 0;
    }
    // The first crossing from the grid starts the clock.
    if (this.laps === 0 && this.sector === 0 && f < 0.05 && this.lapTime > 0 && this.startArmed) {
      this.lapTime = 0;
      this.startArmed = false;
    }
    if (f > 0.9) this.startArmed = true;
  }
  private startArmed = true;
}

function spinWheel(w: number, torque: number, brake: number, inertia: number, dt: number): number {
  w += (torque / inertia) * dt;
  const db = (brake / inertia) * dt;
  if (w > db) return w - db;
  if (w < -db) return w + db;
  return 0;
}
