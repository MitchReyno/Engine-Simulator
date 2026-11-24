// Forced induction: a centrifugal compressor between two volumes of the intake, driven either by
// an exhaust turbine on the same shaft (turbocharger) or by the crank (supercharger).
// Lumped models from textbook turbomachinery, not a compressor or turbine map of a real unit.

import { B_CRIT, CP, GAMMA, GasNetwork, PSI_STAR, P_ATM, R_GAS, T_ATM } from './gas';

// the gas model has one ratio of specific heats for intake air and exhaust alike
const KC = (GAMMA - 1) / GAMMA;
const KT = KC;
/** Work input per unit of tip speed squared (slip and backsweep), and compressor efficiency. */
const SLIP = 0.7;
const ETA_C = 0.72;
const ETA_T = 0.65;
/** Flow coefficient of the wheel treated as an orifice of its inducer area. */
const CD_WHEEL = 0.75;
/** Flow coefficient (axial speed over tip speed) below which the compressor stalls, and the share of its pressure rise it keeps when stalled. */
const PHI_SURGE = 0.07;
const STALL_SHARE = 0.4;
/** Flow coefficient of the wheel for air forced backwards through it. */
const CD_BACK = 0.4;
/** Length of the column of air that has to be accelerated through the compressor and its pipes, m. */
const DUCT_LENGTH = 0.6;
/** Linear flow loss through the wheel, Pa per kg/s. */
const WHEEL_LOSS = 9000;
/** Power a stalled wheel wastes churning the air, as a share of rho A U^3. It is what slows the wheel and ends the flutter. */
const CHURN = 0.04;
/** Pressure ratios between which stalling comes in: none below the first, complete above the second. */
const STALL_FROM = 1.15;
const STALL_FULL = 1.4;
/** Fastest the wheel's rim may go before it would burst, m/s. */
const TIP_LIMIT = 540;
/**
 * Unevenness of the flow reaching the wheel at the blade-count harmonic, as a fraction (from the
 * bend and housing ahead of it). Each blade's load fluctuates by this much once per blade spacing,
 * which is what sends a plane wave at the blade-passing frequency up the intake.
 */
const INLET_DISTORTION = 0.002;
/**
 * Blow-off valve: moving mass kg, spring rate N/m, spring preload as a pressure difference Pa, full lift m.
 * The preload has to beat idle vacuum, or the valve would hang open at idle and leak the compressor's flow.
 * That means it lifts only once the manifold has been pumped down after the throttle shuts, a few
 * hundredths of a second in which the compressor can get one surge pulse out first.
 */
const BOV_MASS = 0.03;
const BOV_RATE = 2500;
const BOV_CRACK = 85e3;
const BOV_LIFT = 0.008;
/** Residual imbalance of a rotor balanced to the usual tolerance, kg m, for a 56 mm wheel. */
const UNBALANCE = 0.12 * (2.5e-3 / 15700);
/** Full blades on the compressor wheel: the whistle is at this many times the shaft speed. */
export const BLADES = 6;

export interface BoostConfig {
  /** 0 none, 1 turbocharger, 2 supercharger. */
  kind: number;
  /** Compressor wheel diameter, m. */
  wheel: number;
  /** Boost the wastegate (or the supercharger's gearing) aims for, Pa above atmospheric. */
  target: number;
  /** Intercooler effectiveness, 0 to 1. */
  intercooler: number;
  /** 0 none, 1 vent to atmosphere, 2 recirculate, 3 a small stiff valve venting to atmosphere. */
  bov: number;
  /** Blow-off valve as a sprung piston with its own motion, rather than an instant open and shut. */
  bovSprung?: boolean;
  /** Crank speed at the rev limit, rad/s (sets a supercharger's drive ratio). */
  crankMax: number;
}

export class Boost {
  cfg: BoostConfig = { kind: 0, wheel: 0.056, target: 70e3, intercooler: 0.7, bov: 1, crankMax: 700 };
  /** Shaft speed, rad/s. */
  omega = 0;
  /** Wastegate opening, 0 to 1. */
  wastegate = 0;
  /** Blow-off valve opening, 0 to 1. */
  bovOpen = 0;
  /** Mass flows, kg/s: through the compressor (negative when it surges backwards) and out of the blow-off valve to the air. */
  mdot = 0;
  mdotBov = 0;
  /** Charge pressure above atmospheric, Pa, and compressor outlet temperature before the intercooler, K. */
  boostPa = 0;
  outletT = T_ATM;
  /** Power taken from the crank by a supercharger, W. */
  crankPower = 0;
  private rc = 0.028; private aInd = 1e-3; private aTurb = 5e-4; private aBov = 4e-4; private inertia = 3e-5; private ratio = 8;
  private wgInt = 0;
  private bovX = 0; private bovV = 0; private bovCrack = BOV_CRACK;
  private stallFrac = 0;
  /** Air blowing back through the spinning wheel: its speed relative to the blades (m/s), density and the inducer area, for the noise it makes. */
  backU = 0; backRho = 1.2; backArea = 0;
  /** Pressure amplitude of the blade-passing wave at the wheel's inlet face, Pa. */
  toneP = 0;
  /** The blow-off valve's jet: speed m/s, density kg/m3 and area m2. */
  jetU = 0; jetRho = 1.2; jetArea = 0;
  /** Out-of-balance force of the rotor, N, turning at shaft speed. */
  shake = 0;

  configure(cfg: BoostConfig): void {
    this.cfg = cfg;
    const d = cfg.wheel;
    this.rc = d / 2;
    this.aInd = Math.PI * (0.35 * d) ** 2;
    // nozzle sized to pass the compressor's full flow at an expansion ratio near 2
    this.aTurb = 0.45 * this.aInd;
    // the small stiff valve passes a fifth of the flow and needs half as much pressure again to lift
    this.aBov = (cfg.bov === 3 ? 0.8e-4 : 4e-4) * (d / 0.056) ** 2;
    this.bovCrack = cfg.bov === 3 ? 1.5 * BOV_CRACK : BOV_CRACK;
    this.inertia = 3e-5 * Math.pow(d / 0.06, 4);
    // a supercharger is geared to make its target boost, with a margin, at the rev limit
    const pr = 1 + (1.9 * cfg.target) / P_ATM;
    const tip = Math.min(TIP_LIMIT, Math.sqrt((CP * T_ATM * (Math.pow(pr, KC) - 1)) / (ETA_C * SLIP)));
    this.ratio = tip / (this.rc * Math.max(100, cfg.crankMax));
  }

  reset(): void {
    this.omega = this.wastegate = this.bovOpen = this.mdot = this.mdotBov = this.boostPa = this.crankPower = this.wgInt = 0;
    this.bovX = this.bovV = this.toneP = this.jetU = this.jetArea = this.shake = this.stallFrac = this.backU = 0;
    this.outletT = T_ATM;
  }

  /** Compressible flow through an orifice from (p0, T0) to p1, kg/s per m2. */
  private static flux(p0: number, T0: number, p1: number): number {
    const rr = p1 / p0;
    let ef = 1;
    if (rr > B_CRIT) {
      const x = (rr - B_CRIT) / (1 - B_CRIT);
      ef = Math.sqrt(1 - x * x);
    }
    return ((p0 * PSI_STAR) / Math.sqrt(R_GAS * T0)) * ef;
  }

  private static move(g: GasNetwork, from: number, to: number, dm: number, hFrom: number, hTo: number): void {
    const y = g.vmY[from] / g.vm[from];
    g.vm[from] -= dm;
    g.vE[from] -= dm * hFrom;
    g.vmY[from] -= dm * y;
    if (to > 0) {
      g.vm[to] += dm;
      g.vE[to] += dm * hTo;
      g.vmY[to] += dm * y;
    }
  }

  /**
   * Advance one step. `v` names the volumes either side of the compressor and turbine (-1 where
   * absent); `plenumP` is manifold pressure, which the blow-off valve compares with charge pressure.
   */
  step(g: GasNetwork, v: { compIn: number; charge: number; turbIn: number; turbOut: number }, dt: number, crankOmega: number, plenumP: number): void {
    const cfg = this.cfg;
    if (cfg.kind === 0 || v.compIn < 0) return;
    const ci = v.compIn, ch = v.charge;
    if (cfg.kind === 2) this.omega = this.ratio * Math.max(0, crankOmega);

    // ---- compressor: it supports a pressure ratio set by tip speed; flow follows the pressure left over
    const p1 = g.vp[ci], T1 = g.vT[ci], p2 = g.vp[ch], T2 = g.vT[ch];
    const tip = this.omega * this.rc;
    const ideal = Math.pow(1 + (ETA_C * SLIP * tip * tip) / (CP * T1), 1 / KC);
    // A wheel that is barely turning has an almost flat characteristic: there is nothing to stall. Without
    // this the idling compressor would surge against the intake pipe and whistle at the pipe's resonance.
    const working = ideal <= STALL_FROM ? 0 : ideal >= STALL_FULL ? 1 : (ideal - STALL_FROM) / (STALL_FULL - STALL_FROM);
    const rho1 = p1 / (R_GAS * T1), rho2 = p2 / (R_GAS * T2);
    // The compressor's characteristic, as in Greitzer's surge model: the pressure rise it supports against the
    // flow through it. Highest at the surge flow; falling away at higher flow (the normal working range);
    // sagging to a "shut-off" value at no flow, where the blades are stalled; and climbing steeply for flow
    // forced backwards through the wheel. The sag is what makes low flow unstable.
    const peak = p1 * (ideal - 1), shut = peak * (1 - (1 - STALL_SHARE) * working);
    const mSurge = PHI_SURGE * rho1 * this.aInd * tip;
    const m = this.mdot;
    let rise: number, stall: number;
    if (m >= mSurge) {
      const x = (m - mSurge) / (CD_WHEEL * this.aInd);
      rise = peak - (x * x) / (2 * rho1);
      stall = 0;
    } else if (m >= 0) {
      const k = mSurge > 0 ? m / mSurge : 1;
      const up = k * k * (3 - 2 * k);
      rise = shut + (peak - shut) * up;
      stall = 1 - up;
    } else {
      const x = m / (CD_BACK * this.aInd);
      rise = shut + (x * x) / (2 * rho2);
      stall = 1;
    }
    // friction through the wheel: keeps a little damping when it is hardly turning
    rise -= WHEEL_LOSS * m;
    this.stallFrac = stall * working;
    // the air in the wheel, housing and pipe has inertia: L dm/dt = pressure left over
    this.mdot += ((this.aInd / DUCT_LENGTH) * (p1 + rise - p2)) * dt;
    let dm = this.mdot * dt;
    let pc = 0;
    if (dm >= 0) {
      if (dm > 0.1 * g.vm[ci]) dm = 0.1 * g.vm[ci];
      const pr = Math.max(1, p2 / p1);
      const tOut = T1 * (1 + (Math.pow(pr, KC) - 1) / ETA_C);
      this.outletT = tOut;
      pc = (dm / dt) * CP * (tOut - T1);
      Boost.move(g, ci, ch, dm, CP * T1, CP * (tOut - cfg.intercooler * (tOut - T_ATM)));
    } else {
      // surge: charge air blows back through the wheel
      if (dm < -0.1 * g.vm[ch]) dm = -0.1 * g.vm[ch];
      Boost.move(g, ch, ci, -dm, CP * T2, CP * T2);
    }
    // a stalled wheel still takes power: it churns the air instead of pumping it
    pc += CHURN * this.stallFrac * (p1 / (R_GAS * T1)) * this.aInd * tip * tip * tip;
    // backflow is torn up by blades going past it at tip speed: the rasp inside each flutter burst
    const ub = this.mdot < 0 ? -this.mdot / ((p2 / (R_GAS * T2)) * this.aInd) : 0;
    this.backU = ub > 0 ? Math.sqrt(ub * ub + 0.25 * tip * tip) * Math.min(1, ub / 30) : 0;
    this.backRho = p1 / (R_GAS * T1);
    this.backArea = this.aInd;
    this.boostPa = p2 - P_ATM;
    // each blade carries its share of the wheel's torque; the uneven inflow modulates it
    this.toneP = this.mdot > 0 ? (INLET_DISTORTION * this.mdot * SLIP * tip) / this.aInd : 0;
    this.shake = UNBALANCE * Math.pow(this.rc / 0.028, 3) * this.omega * this.omega;

    // ---- blow-off valve: opens when the throttle shuts on a pressurised charge pipe
    if (cfg.bov > 0 && cfg.bovSprung) {
      // A piston with charge pressure under it and manifold pressure plus a spring on top. It lifts when the
      // throttle shuts on boost, and can chatter as venting drops the pressure that holds it open.
      const ap = 5e-4 * (this.rc / 0.028) ** 2;
      const force = (p2 - plenumP - this.bovCrack) * ap - BOV_RATE * this.bovX;
      const damp = 2 * 0.5 * Math.sqrt(BOV_RATE * BOV_MASS);
      this.bovV = (this.bovV + (force / BOV_MASS) * dt) / (1 + (damp / BOV_MASS) * dt);
      this.bovX += this.bovV * dt;
      if (this.bovX <= 0) { this.bovX = 0; if (this.bovV < 0) this.bovV = 0; }
      else if (this.bovX >= BOV_LIFT) { this.bovX = BOV_LIFT; if (this.bovV > 0) this.bovV = 0; }
      this.bovOpen = this.bovX / BOV_LIFT;
    } else {
      const lift = cfg.bov > 0 && p2 > 1.12 * P_ATM && plenumP < 0.72 * p2 ? 1 : 0;
      this.bovOpen += (lift - this.bovOpen) * Math.min(1, dt / 4e-3);
    }
    this.mdotBov = 0;
    if (this.bovOpen > 1e-3) {
      const to = cfg.bov === 2 ? ci : 0;
      const back = to > 0 ? g.vp[to] : P_ATM;
      if (p2 > back) {
        const flow = this.aBov * this.bovOpen * Boost.flux(p2, T2, back);
        const out = Math.min(flow * dt, 0.1 * g.vm[ch]);
        Boost.move(g, ch, to, out, CP * T2, CP * T2);
        if (to === 0) {
          this.mdotBov = out / dt;
          // the jet leaving the valve, expanded to atmospheric pressure (sonic at most)
          const m2 = Math.min(1, (2 / (GAMMA - 1)) * (Math.pow(p2 / P_ATM, KC) - 1));
          const te = T2 / (1 + 0.5 * (GAMMA - 1) * m2);
          this.jetU = Math.sqrt(m2 * GAMMA * R_GAS * te);
          this.jetRho = P_ATM / (R_GAS * te);
          this.jetArea = this.jetU > 1 ? this.mdotBov / (this.jetRho * this.jetU) : 0;
        }
      }
    }
    g.refreshVolume(ci);
    g.refreshVolume(ch);

    if (cfg.kind === 2) {
      this.crankPower = pc;
      return;
    }
    this.crankPower = 0;

    // ---- turbine and wastegate
    const ti = v.turbIn, to = v.turbOut;
    let pt = 0;
    if (ti > 0 && to > 0) {
      const up = g.vp[ti] >= g.vp[to] ? ti : to, dn = up === ti ? to : ti;
      const p0 = g.vp[up], T0 = g.vT[up];
      const fl = Boost.flux(p0, T0, g.vp[dn]);
      const through = this.aTurb * fl * dt, bypass = this.aTurb * 1.2 * this.wastegate * fl * dt;
      let total = through + bypass;
      const cap = 0.15 * g.vm[up];
      const k = total > cap ? cap / total : 1;
      total *= k;
      // only gas that goes through the wheel, in the forward direction, does work
      const work = up === ti ? ETA_T * through * k * CP * T0 * (1 - Math.pow(Math.max(0.3, g.vp[dn] / p0), KT)) : 0;
      pt = work / dt;
      Boost.move(g, up, dn, total, CP * T0, CP * T0 - (total > 0 ? work / total : 0));
      g.refreshVolume(ti);
      g.refreshVolume(to);
    }

    // ---- shaft
    const w = Math.max(this.omega, 400);
    this.omega += ((pt - pc - 2e-6 * this.omega * this.omega) / (this.inertia * w)) * dt;
    if (this.omega < 0) this.omega = 0;
    // boost control: the wastegate opens on charge pressure above target, and to hold the wheel under its speed limit
    const err = (p2 - P_ATM - cfg.target) / 1e5 + Math.max(0, tip / TIP_LIMIT - 0.97) * 20;
    this.wgInt += 12 * err * dt;
    if (this.wgInt < 0) this.wgInt = 0; else if (this.wgInt > 1) this.wgInt = 1;
    const wg = this.wgInt + 4 * err;
    this.wastegate = wg < 0 ? 0 : wg > 1 ? 1 : wg;
  }
}
