// 1D unsteady gas dynamics: finite-volume Euler in pipes, coupled to 0D volumes.
//
// Pipes: MUSCL-Hancock (second order, limited) with a Rusanov flux on a uniform
// grid per pipe, constant area per pipe. A passive scalar Y (burned-gas mass
// fraction) is advected first-order upwind.
// Volumes: mass / internal energy / burned mass. Every pipe end connects to a
// volume (or a wall) through an orifice of area ratio phi; the boundary flux is
// the closed-form intersection of the pipe's outgoing characteristic with an
// ISO-6358-style elliptic compressible orifice law (with choking).

export const GAMMA = 1.35; // single calorically-perfect gas everywhere
export const R_GAS = 287;
export const G1 = GAMMA - 1;
export const CV = R_GAS / G1;
export const CP = GAMMA * CV;
export const P_ATM = 101325;
export const T_ATM = 298;
export const RHO_ATM = P_ATM / (R_GAS * T_ATM);
const C_ATM = Math.sqrt(GAMMA * R_GAS * T_ATM);
/** Turbulent flame speed of afterfire in a pipe, m/s. */
const FLAME_SPEED = 25;
/** Radiation resistance of an unflanged pipe end, in units of rho c. */
const RAD_R = 1.5;
/** How long expelled gas stays near a pipe mouth, s. */
const PUFF_TAU = 0.03;
/** Pressure difference below which orifice flow is made linear, Pa. */
const P_SMOOTH = 150;
const Z_RAD = RAD_R * RHO_ATM * C_ATM;

/** Critical pressure ratio and choked flow-function value. */
export const B_CRIT = Math.pow(2 / (GAMMA + 1), GAMMA / G1);
export const PSI_STAR = Math.sqrt(GAMMA) * Math.pow(2 / (GAMMA + 1), (GAMMA + 1) / (2 * G1));

const ONE_MINUS_B = 1 - B_CRIT;
const Q_ELL = 1 / (ONE_MINUS_B * ONE_MINUS_B);
const A2_ELL = 1 - Q_ELL * B_CRIT * B_CRIT;
const SQRT_GAMMA = Math.sqrt(GAMMA);
const IG1 = 1 / G1;

/** Exact isentropic orifice mass flow (kg/s). Reference for tests. */
export function orificeMassFlowExact(aEff: number, p0: number, T0: number, pDown: number): number {
  let r = pDown / p0;
  if (r >= 1) return 0;
  if (r < B_CRIT) r = B_CRIT;
  const psi = Math.sqrt(((2 * GAMMA) / G1) * (Math.pow(r, 2 / GAMMA) - Math.pow(r, (GAMMA + 1) / GAMMA)));
  return (aEff * p0 * psi) / Math.sqrt(R_GAS * T0);
}

/** Elliptic approximation used by the solver (no pow calls). */
export function orificeMassFlow(aEff: number, p0: number, T0: number, pDown: number): number {
  const r = pDown / p0;
  if (r >= 1) return 0;
  const g = (aEff * p0 * PSI_STAR) / Math.sqrt(R_GAS * T0);
  if (r <= B_CRIT) return g;
  const x = (r - B_CRIT) / ONE_MINUS_B;
  return g * Math.sqrt(1 - x * x);
}

export interface PipeSpec {
  length: number;
  diameter: number;
  /** Optional taper: diameter at each of the cells + 1 faces. */
  profile?: number[];
  cells: number;
  /** Volume index at each end, or -1 for a closed wall. */
  volL: number;
  volR: number;
  wallT: number;
  friction?: number;
}

export interface VolumeSpec {
  volume: number;
  /** Fixed-state reservoir (ambient). */
  fixed?: boolean;
  p?: number;
  T?: number;
}

const RHO_MIN = 1e-3;
const P_MIN = 500;

export class GasNetwork {
  // volumes
  readonly nv: number;
  readonly vm: Float64Array;
  readonly vE: Float64Array;
  readonly vmY: Float64Array;
  readonly vV: Float64Array;
  readonly vp: Float64Array;
  readonly vT: Float64Array;
  readonly vY: Float64Array;
  readonly vG: Float64Array;
  readonly vFixed: Uint8Array;
  private readonly vdm: Float64Array;
  private readonly vdE: Float64Array;
  private readonly vdmY: Float64Array;

  // pipes
  readonly np: number;
  readonly pOff: Int32Array;
  readonly pN: Int32Array;
  readonly pDx: Float64Array;
  readonly pArea: Float64Array;
  readonly pDiam: Float64Array;
  readonly pVolL: Int32Array;
  readonly pVolR: Int32Array;
  readonly pPhiL: Float64Array;
  readonly pPhiR: Float64Array;
  readonly pTw: Float64Array;
  /** Linear flow resistance at each end, Pa per (kg/m^2 s): a filter element. */
  /** Heat that has flowed from the gas into each pipe's wall since last cleared, J. */
  readonly pQw: Float64Array;
  /** Pipes where unburned charge may ignite (afterfire model). */
  readonly pReact: Uint8Array;
  /** Heat released per kg of fresh charge burned in a pipe, J/kg. */
  reactQ = 0;
  readonly pResL: Float64Array;
  readonly pResR: Float64Array;
  readonly pFr: Float64Array;
  /** Mass flow rate (kg/s) in +x at the left / right end of each pipe. */
  readonly pMdotL: Float64Array;
  readonly pMdotR: Float64Array;

  // cells
  readonly nCells: number;
  readonly rho: Float64Array;
  readonly mom: Float64Array;
  readonly ene: Float64Array;
  readonly rY: Float64Array;
  /** Primitives from the start of the most recent step (for display). */
  readonly cu: Float64Array;
  readonly cp: Float64Array;
  readonly cc: Float64Array;
  readonly cY: Float64Array;
  /** Quasi-1D areas: 1 / cell area, and face areas (cells + 1 per pipe, at offset + pipe index). */
  readonly iaC: Float64Array;
  readonly aF: Float64Array;
  private readonly ci: Float64Array;

  private readonly eRl: Float64Array;
  private readonly eUl: Float64Array;
  private readonly ePl: Float64Array;
  private readonly eRr: Float64Array;
  private readonly eUr: Float64Array;
  private readonly ePr: Float64Array;
  private readonly f0: Float64Array;
  private readonly f1: Float64Array;
  private readonly f2: Float64Array;
  private readonly f3: Float64Array;

  /** max (|u|+c)/dx seen in the last step: dt * this is the CFL number. */
  maxRate = 0;

  // boundary solve outputs
  private bm = 0;
  private bp = 0;
  private bh = 0;
  private bY = 0;
  /** Afterfire: per-cell flame timer, and a count of spontaneous ignitions. */
  private flame!: Float32Array; private seed = 2463534242; pops = 0;
  /** Gas recently expelled from each radiating end, per unit pipe area: mass, enthalpy, burned mass. */
  private puffM!: Float64Array; private puffH!: Float64Array; private puffY!: Float64Array;
  private puffDt = 0; private pRadLen = 0;
  /** Open-end radiation: end-correction length (0 = off) and the velocity through the inertance. */
  pRadL!: Float64Array; pRadR!: Float64Array; pRadUL!: Float64Array; pRadUR!: Float64Array;
  private br = 1;

  constructor(volumes: VolumeSpec[], pipes: PipeSpec[]) {
    const nv = (this.nv = volumes.length);
    this.vm = new Float64Array(nv);
    this.vE = new Float64Array(nv);
    this.vmY = new Float64Array(nv);
    this.vV = new Float64Array(nv);
    this.vp = new Float64Array(nv);
    this.vT = new Float64Array(nv);
    this.vY = new Float64Array(nv);
    this.vG = new Float64Array(nv);
    this.vFixed = new Uint8Array(nv);
    this.vdm = new Float64Array(nv);
    this.vdE = new Float64Array(nv);
    this.vdmY = new Float64Array(nv);
    for (let v = 0; v < nv; v++) {
      const s = volumes[v];
      this.vV[v] = s.volume;
      this.vFixed[v] = s.fixed ? 1 : 0;
      this.setVolumeState(v, s.p ?? P_ATM, s.T ?? T_ATM, 0);
    }

    const np = (this.np = pipes.length);
    this.pOff = new Int32Array(np);
    this.pN = new Int32Array(np);
    this.pDx = new Float64Array(np);
    this.pArea = new Float64Array(np);
    this.pDiam = new Float64Array(np);
    this.pVolL = new Int32Array(np);
    this.pVolR = new Int32Array(np);
    this.pPhiL = new Float64Array(np).fill(1);
    this.pPhiR = new Float64Array(np).fill(1);
    this.pTw = new Float64Array(np);
    this.pQw = new Float64Array(np);
    this.pReact = new Uint8Array(np);
    this.pResL = new Float64Array(np);
    this.pResR = new Float64Array(np);
    this.pFr = new Float64Array(np);
    this.pMdotL = new Float64Array(np);
    this.pMdotR = new Float64Array(np);
    this.pRadL = new Float64Array(np);
    this.pRadR = new Float64Array(np);
    this.pRadUL = new Float64Array(np);
    this.pRadUR = new Float64Array(np);
    this.puffM = new Float64Array(2 * np);
    this.puffH = new Float64Array(2 * np);
    this.puffY = new Float64Array(2 * np);
    let total = 0;
    let maxN = 0;
    for (let k = 0; k < np; k++) {
      const s = pipes[k];
      const n = Math.max(2, s.cells | 0);
      this.pOff[k] = total;
      this.pN[k] = n;
      this.pVolL[k] = s.volL;
      this.pVolR[k] = s.volR;
      this.pTw[k] = s.wallT;
      this.pFr[k] = s.friction ?? 0.02;
      total += n;
      if (n > maxN) maxN = n;
    }
    this.nCells = total;
    this.rho = new Float64Array(total);
    this.mom = new Float64Array(total);
    this.ene = new Float64Array(total);
    this.rY = new Float64Array(total);
    this.cu = new Float64Array(total);
    this.cp = new Float64Array(total);
    this.cc = new Float64Array(total);
    this.cY = new Float64Array(total);
    this.iaC = new Float64Array(total);
    this.aF = new Float64Array(total + np);
    for (let k = 0; k < np; k++) this.setPipeGeometry(k, pipes[k].length, pipes[k].diameter, pipes[k].profile);
    this.ci = new Float64Array(total);
    this.flame = new Float32Array(total);
    this.eRl = new Float64Array(total);
    this.eUl = new Float64Array(total);
    this.ePl = new Float64Array(total);
    this.eRr = new Float64Array(total);
    this.eUr = new Float64Array(total);
    this.ePr = new Float64Array(total);
    this.f0 = new Float64Array(maxN + 1);
    this.f1 = new Float64Array(maxN + 1);
    this.f2 = new Float64Array(maxN + 1);
    this.f3 = new Float64Array(maxN + 1);
    for (let k = 0; k < np; k++) this.setPipeState(k, P_ATM, T_ATM, 0, 0);
  }

  setPipeGeometry(k: number, length: number, diameter: number, profile?: number[]): void {
    const n = this.pN[k];
    const off = this.pOff[k];
    this.pDx[k] = length / n;
    this.pDiam[k] = diameter;
    this.pArea[k] = 0.25 * Math.PI * diameter * diameter;
    const fo = off + k;
    for (let f = 0; f <= n; f++) {
      const d = profile && profile.length === n + 1 ? profile[f] : diameter;
      this.aF[fo + f] = 0.25 * Math.PI * d * d;
    }
    // frustum volume / dx, so tapered cells hold the right amount of gas
    for (let i = 0; i < n; i++) {
      const a0 = this.aF[fo + i], a1 = this.aF[fo + i + 1];
      this.iaC[off + i] = 3 / (a0 + a1 + Math.sqrt(a0 * a1));
    }
  }

  setPipeState(k: number, p: number, T: number, u: number, Y: number): void {
    const off = this.pOff[k];
    const n = this.pN[k];
    const r = p / (R_GAS * T);
    for (let i = 0; i < n; i++) this.setCell(off + i, r, u, p, Y);
  }

  setCell(j: number, r: number, u: number, p: number, Y: number): void {
    this.rho[j] = r;
    this.mom[j] = r * u;
    this.ene[j] = p / G1 + 0.5 * r * u * u;
    this.rY[j] = r * Y;
    this.cu[j] = u;
    this.cp[j] = p;
    this.cc[j] = Math.sqrt((GAMMA * p) / r);
    this.cY[j] = Y;
  }

  setVolumeState(v: number, p: number, T: number, Y: number): void {
    const m = (p * this.vV[v]) / (R_GAS * T);
    this.vm[v] = m;
    this.vE[v] = m * CV * T;
    this.vmY[v] = m * Y;
    this.refreshVolume(v);
  }

  /** Recompute p, T, Y of a volume after its m / E / V were changed externally. */
  refreshVolume(v: number): void {
    const m = this.vm[v];
    const p = (G1 * this.vE[v]) / this.vV[v];
    const T = this.vE[v] / (m * CV);
    this.vp[v] = p;
    this.vT[v] = T;
    let Y = this.vmY[v] / m;
    if (Y < 0) Y = 0;
    else if (Y > 1) Y = 1;
    this.vY[v] = Y;
    this.vG[v] = (p * PSI_STAR) / Math.sqrt(R_GAS * T);
  }

  /**
   * Radiation impedance at an open end: an inertance (the air just outside, 0.61 radii long)
   * in parallel with a resistance of 1.5 rho c. Low frequencies reflect almost completely;
   * high frequencies radiate away instead of feeding the pipe's upper resonances.
   */
  setRadiation(k: number, left: boolean, right: boolean): void {
    const fo = this.pOff[k] + k;
    this.pRadL[k] = left ? 0.6133 * Math.sqrt(this.aF[fo] / Math.PI) : 0;
    this.pRadR[k] = right ? 0.6133 * Math.sqrt(this.aF[fo + this.pN[k]] / Math.PI) : 0;
    if (!left) this.pRadUL[k] = 0;
    if (!right) this.pRadUR[k] = 0;
  }

  pipeMass(k: number): number {
    let s = 0;
    const off = this.pOff[k];
    for (let i = 0; i < this.pN[k]; i++) s += this.rho[off + i] / this.iaC[off + i];
    return s * this.pDx[k];
  }

  pipeEnergy(k: number): number {
    let s = 0;
    const off = this.pOff[k];
    for (let i = 0; i < this.pN[k]; i++) s += this.ene[off + i] / this.iaC[off + i];
    return s * this.pDx[k];
  }

  /**
   * Boundary solve at a pipe end. wc is the end-cell velocity along the inward
   * direction (into the pipe). Sets bm (inward mass flux per pipe area), bp
   * (face pressure), bh (specific total enthalpy carried), bY and br.
   */
  private bc(v: number, phi: number, rc: number, wc: number, pc: number, cc: number, Yc: number, dpv: number, z0 = 0, zu = 0, pe = 0): void {
    const mc = rc * wc;
    // Outgoing characteristic, linearised about the cell: p_f = pStar + cc * m_f.
    // The linearisation fails near sonic inflow, so pStar is floored.
    let pStar = pc - cc * mc;
    if (pStar < 0.25 * pc) pStar = 0.25 * pc;
    if (v < 0 || phi <= 1e-7) {
      this.bm = 0;
      this.bp = pStar > 0.1 * pc ? pStar : 0.1 * pc;
      this.bh = 0;
      this.bY = Yc;
      this.br = rc;
      return;
    }
    const pv = this.vp[v] + dpv;
    if (z0 > 0) {
      // Radiating open end: the pressure just outside is p_v + z0 (u - uL), with u the outward
      // velocity at the face. Solved together with the characteristic, so it is implicit in the flow.
      const q = pStar - pv + zu;
      if (q >= 0) {
        let m = q / (cc + z0 / rc);
        const wpos = wc < 0 ? -wc : 0;
        const mMax = wpos >= cc ? rc * wpos : rc * (0.34 * cc + 0.66 * wpos);
        if (m > mMax) m = mMax;
        this.bm = -m;
        this.bp = pStar - cc * m;
        this.bh = (GAMMA / G1) * (pc / rc) + 0.5 * wc * wc;
        this.bY = Yc;
        this.br = rc;
        // what leaves hangs just outside the mouth for a moment
        const dm = m * this.puffDt;
        this.puffM[pe] += dm;
        this.puffH[pe] += dm * this.bh;
        this.puffY[pe] += dm * Yc;
      } else {
        // Inflow accelerates from rest outside: static face pressure is lower by the dynamic head.
        // The gas drawn in is first the puff that just left, then outside air: when the flow only
        // sloshes in and out, the same hot gas returns and nothing jumps at the reversal.
        const pm = this.puffM[pe];
        const w = pm / (pm + rc * this.pRadLen);
        const Tv = pm > 1e-12 ? w * (this.puffH[pe] / (pm * CP)) + (1 - w) * this.vT[v] : this.vT[v];
        // outside air drawn into an exhaust pipe carries no fuel, so it counts as inert there
        const Ya = this.pReact[pe >> 1] ? 1 : this.vY[v];
        const Yv = pm > 1e-12 ? w * (this.puffY[pe] / pm) + (1 - w) * Ya : Ya;
        const rv = pv / (R_GAS * Tv);
        // same radiation term as the outflow branch, so the flow has no kink where it reverses
        const ce = cc + z0 / rc;
        let m = (-2 * q) / (ce + Math.sqrt(ce * ce - (2 * q) / rv));
        if (m > this.vG[v]) m = this.vG[v];
        this.bm = m;
        this.bp = pStar + cc * m;
        this.bh = CP * Tv;
        this.bY = Yv;
        this.br = rv;
        if (pm > 1e-12) {
          let k = 1 - (w * m * this.puffDt) / pm;
          if (k < 0) k = 0;
          this.puffM[pe] = pm * k;
          this.puffH[pe] *= k;
          this.puffY[pe] *= k;
        }
      }
      return;
    }
    if (pStar < pv) {
      // Volume -> pipe: upstream stagnation is the volume.
      const g = dpv === 0 ? phi * this.vG[v] : (phi * this.vG[v] * pv) / this.vp[v];
      let m: number;
      if (pStar + cc * g <= B_CRIT * pv) {
        m = g; // choked
      } else {
        const alpha = (pStar / pv - B_CRIT) / ONE_MINUS_B;
        const bg = (cc * g) / (pv * ONE_MINUS_B);
        let disc = bg * bg + 1 - alpha * alpha;
        if (disc < 0) disc = 0;
        m = (g * (Math.sqrt(disc) - alpha * bg)) / (1 + bg * bg);
        if (m < 0) m = 0;
      }
      // An orifice law goes as the square root of the pressure difference, which has a cusp where the
      // flow reverses. Real flow has inertia there; make it linear below a few hundred pascals.
      // (only at a real restriction: an open end must stay transparent to small waves)
      if (phi < 0.9995) m *= Math.sqrt((pv - pStar) / (pv - pStar + P_SMOOTH));
      const pf = pStar + cc * m;
      const Tv = this.vT[v];
      this.bm = m;
      this.bp = pf;
      this.bh = CP * Tv;
      this.bY = this.vY[v];
      // Density no lower than the sonic (critical) state of the upstream gas.
      const pCrit = B_CRIT * pv;
      this.br = (pf > pCrit ? pf : pCrit) / (R_GAS * Tv);
    } else {
      // Pipe -> volume. Static face pressure is upstream; the approach velocity
      // is folded into the area ratio so phi = 1 gives p_f = p_volume exactly.
      const wo = -wc;
      let invG2 = 0;
      if (phi < 0.9995) {
        const psiC = (PSI_STAR * SQRT_GAMMA) / cc;
        invG2 = (1 - phi * phi) / (phi * phi * psiC * psiC);
      }
      const a1 = 2 * Q_ELL * B_CRIT * pv;
      const fQ = A2_ELL * pStar * pStar + a1 * pStar - Q_ELL * pv * pv;
      const A = A2_ELL * cc * cc - invG2;
      const Bq = -(2 * A2_ELL * pStar + a1) * cc;
      let disc = Bq * Bq - 4 * A * fQ;
      if (disc < 0) disc = 0;
      let m = fQ > 0 ? (2 * fQ) / (-Bq + Math.sqrt(disc)) : 0;
      let pf = pStar - cc * m;
      if (pf * B_CRIT > pv) {
        // choked at the orifice: m = G * p_f
        if (invG2 > 0) {
          const G = 1 / Math.sqrt(invG2);
          m = (G * pStar) / (1 + G * cc);
        } else {
          m = pStar / cc;
        }
      }
      if (invG2 > 0) m *= Math.sqrt((pStar - pv) / (pStar - pv + P_SMOOTH));
      // Sonic limit of the pipe end itself (simple-wave estimate).
      const wpos = wo > 0 ? wo : 0;
      const mMax = wpos >= cc ? rc * wpos : rc * (0.34 * cc + 0.66 * wpos);
      if (m > mMax) m = mMax;
      pf = pStar - cc * m;
      if (pf < 0.2 * pc) pf = 0.2 * pc;
      this.bm = -m;
      this.bp = pf;
      this.bh = (GAMMA / G1) * (pc / rc) + 0.5 * wc * wc;
      this.bY = Yc;
      this.br = rc;
    }
  }

  /**
   * Advance pipes and volumes by dt. srcDt > 0 also applies wall friction and
   * heat transfer over that interval (the caller may sub-cycle these).
   */
  step(dt: number, srcDt: number): void {
    const { rho, mom, ene, rY, cu, cp, cc, cY, ci } = this;
    const { eRl, eUl, ePl, eRr, eUr, ePr, f0, f1, f2, f3 } = this;
    const { vdm, vdE, vdmY, iaC, aF } = this;
    let maxRate = 0;
    // puffs outside the open ends disperse over a few hundredths of a second
    this.puffDt = dt;
    const fade = 1 - dt / PUFF_TAU;
    for (let e = 0; e < this.puffM.length; e++) {
      this.puffM[e] *= fade;
      this.puffH[e] *= fade;
      this.puffY[e] *= fade;
    }

    for (let k = 0; k < this.np; k++) {
      const off = this.pOff[k];
      const n = this.pN[k];
      const dx = this.pDx[k];
      const lam = dt / dx;
      const hl = 0.5 * lam;
      const fo = off + k;
      const areaL = aF[fo], areaR = aF[fo + n];
      const end = off + n;

      let smax = 0;
      for (let j = off; j < end; j++) {
        const iv = 1 / rho[j];
        const u = mom[j] * iv;
        const p = G1 * (ene[j] - 0.5 * mom[j] * u);
        const c = Math.sqrt(GAMMA * p * iv);
        cu[j] = u;
        cp[j] = p;
        cc[j] = c;
        ci[j] = iv;
        cY[j] = rY[j] * iv;
        smax = Math.max(smax, Math.abs(u) + c);
      }
      if (smax / dx > maxRate) maxRate = smax / dx;

      // Reconstruction (monotonised-central limiter) + Hancock half-step predictor.
      for (let j = off + 1; j < end - 1; j++) {
        const r = rho[j];
        const u = cu[j];
        const p = cp[j];
        let a = r - rho[j - 1];
        let b = rho[j + 1] - r;
        let h = 0.5 * (a + b);
        let dr = Math.max(0, Math.min(a + a, b + b, h)) + Math.min(0, Math.max(a + a, b + b, h));
        a = u - cu[j - 1];
        b = cu[j + 1] - u;
        h = 0.5 * (a + b);
        let du = Math.max(0, Math.min(a + a, b + b, h)) + Math.min(0, Math.max(a + a, b + b, h));
        a = p - cp[j - 1];
        b = cp[j + 1] - p;
        h = 0.5 * (a + b);
        let dp = Math.max(0, Math.min(a + a, b + b, h)) + Math.min(0, Math.max(a + a, b + b, h));
        let rp = r - hl * (u * dr + r * du);
        let pp = p - hl * (u * dp + GAMMA * p * du);
        let up = u - hl * (u * du + dp * ci[j]);
        if (rp - 0.5 * Math.abs(dr) < 0.2 * r || pp - 0.5 * Math.abs(dp) < 0.2 * p) {
          dr = 0;
          du = 0;
          dp = 0;
          rp = r;
          pp = p;
          up = u;
        }
        eRl[j] = rp - 0.5 * dr;
        eRr[j] = rp + 0.5 * dr;
        eUl[j] = up - 0.5 * du;
        eUr[j] = up + 0.5 * du;
        ePl[j] = pp - 0.5 * dp;
        ePr[j] = pp + 0.5 * dp;
      }
      // End cells: piecewise constant.
      eRl[off] = eRr[off] = rho[off];
      eUl[off] = eUr[off] = cu[off];
      ePl[off] = ePr[off] = cp[off];
      const jl = end - 1;
      eRl[jl] = eRr[jl] = rho[jl];
      eUl[jl] = eUr[jl] = cu[jl];
      ePl[jl] = ePr[jl] = cp[jl];

      // Left boundary.
      let v = this.pVolL[k];
      // a filter's pressure drop uses last step's flux (stable while resistance << c)
      let dpv = (-this.pResL[k] * this.pMdotL[k]) / areaL;
      let rad = this.pRadL[k];
      this.pRadLen = rad;
      this.bc(v, this.pPhiL[k], rho[off], cu[off], cp[off], cc[off], cY[off], dpv, rad > 0 ? Z_RAD : 0, Z_RAD * this.pRadUL[k], 2 * k);
      let m = this.bm;
      if (rad > 0) this.pRadUL[k] += (-m / rho[off] - this.pRadUL[k]) * (1 - Math.exp((-dt * C_ATM * RAD_R) / rad));
      f0[0] = m;
      f1[0] = this.bp + (m * m) / this.br;
      f2[0] = m * this.bh;
      f3[0] = m * this.bY;
      this.pMdotL[k] = m * areaL;
      if (v >= 0) {
        const w = areaL * dt;
        vdm[v] -= m * w;
        vdE[v] -= m * this.bh * w;
        vdmY[v] -= m * this.bY * w;
      }
      // Right boundary.
      v = this.pVolR[k];
      dpv = (this.pResR[k] * this.pMdotR[k]) / areaR;
      rad = this.pRadR[k];
      this.pRadLen = rad;
      this.bc(v, this.pPhiR[k], rho[jl], -cu[jl], cp[jl], cc[jl], cY[jl], dpv, rad > 0 ? Z_RAD : 0, Z_RAD * this.pRadUR[k], 2 * k + 1);
      m = this.bm;
      if (rad > 0) this.pRadUR[k] += (-m / rho[jl] - this.pRadUR[k]) * (1 - Math.exp((-dt * C_ATM * RAD_R) / rad));
      f0[n] = -m;
      f1[n] = this.bp + (m * m) / this.br;
      f2[n] = -m * this.bh;
      f3[n] = -m * this.bY;
      this.pMdotR[k] = -m * areaR;
      if (v >= 0) {
        const w = areaR * dt;
        vdm[v] -= m * w;
        vdE[v] -= m * this.bh * w;
        vdmY[v] -= m * this.bY * w;
      }

      // Interior faces (Rusanov).
      for (let f = 1; f < n; f++) {
        const jr = off + f;
        const jL = jr - 1;
        const rl = eRr[jL];
        const ul = eUr[jL];
        const pl = ePr[jL];
        const rr = eRl[jr];
        const ur = eUl[jr];
        const pr = ePl[jr];
        const ml = rl * ul;
        const mr = rr * ur;
        const El = pl * IG1 + 0.5 * ml * ul;
        const Er = pr * IG1 + 0.5 * mr * ur;
        const s = Math.max(Math.abs(ul) + cc[jL], Math.abs(ur) + cc[jr]);
        const fm = 0.5 * (ml + mr - s * (rr - rl));
        f0[f] = fm;
        f1[f] = 0.5 * (ml * ul + pl + mr * ur + pr - s * (mr - ml));
        f2[f] = 0.5 * (ul * (El + pl) + ur * (Er + pr) - s * (Er - El));
        // upwind scalar, written without a branch
        f3[f] = 0.5 * (fm * (cY[jL] + cY[jr]) - Math.abs(fm) * (cY[jr] - cY[jL]));
      }

      // Conservative update (+ optional wall friction / heat).
      const doSrc = srcDt > 0;
      const diam = this.pDiam[k];
      const fr = this.pFr[k];
      const kf = (fr / (2 * diam)) * srcDt;
      const kh = (4 / diam) * (fr / 8) * GAMMA * srcDt;
      const rtw = R_GAS * this.pTw[k];
      const react = this.pReact[k] === 1 && this.reactQ > 0;
      const kReact = Math.min(1, srcDt / 2e-3);
      const kFade = srcDt / 6e-3;
      const flame = this.flame;
      let qGas = 0;
      for (let i = 0; i < n; i++) {
        const j = off + i;
        // Quasi-1D: fluxes weighted by face area, plus the wall pressure term p dA/dx.
        const a0 = aF[fo + i], a1 = aF[fo + i + 1];
        const la = lam * iaC[j];
        let r = rho[j] - la * (f0[i + 1] * a1 - f0[i] * a0);
        let mo = mom[j] - la * (f1[i + 1] * a1 - f1[i] * a0 - cp[j] * (a1 - a0));
        let e = ene[j] - la * (f2[i + 1] * a1 - f2[i] * a0);
        let y = rY[j] - la * (f3[i + 1] * a1 - f3[i] * a0);
        if (!(r > RHO_MIN)) r = RHO_MIN;
        // positivity of pressure without a division: e*r - mo^2/2 > pmin*r/(g-1)
        if (!(e * r - 0.5 * mo * mo > P_MIN * IG1 * r)) e = P_MIN * IG1 + (0.5 * mo * mo) / r;
        if (doSrc) {
          // Wall friction and heat transfer, every step: applying them in
          // bursts would put a tone at the burst rate into the radiated sound.
          const iv = 1 / r;
          const au = Math.abs(mo * iv);
          mo *= 1 - Math.min(0.5, kf * au);
          const p = G1 * (e - 0.5 * mo * mo * iv);
          const de = Math.min(0.5, kh * (au + 5)) * (r * rtw - p) * IG1;
          e += de;
          qGas += de;
          if (react) {
            // Afterfire. A pocket of unburned charge ignites at random, at a rate set by the hottest
            // gas touching it; the flame then spreads cell to cell at a turbulent flame speed.
            const fresh = r - y;
            const fl = flame[j];
            if (fl > 0) {
              const db = fresh * kReact;
              y += db;
              e += db * this.reactQ;
              flame[j] = fl > kFade ? fl - kFade : 0;
            } else if (fresh > 0.5 * r) {
              const lit = (i > 0 && flame[j - 1] > 0) || (i < n - 1 && flame[j + 1] > 0);
              let rate = lit ? FLAME_SPEED / dx : 0;
              // Too diluted to light by itself below 60 % fresh charge.
              if (fresh > 0.6 * r) {
                let c = cc[j];
                if (i > 0 && cc[j - 1] > c) c = cc[j - 1];
                if (i < n - 1 && cc[j + 1] > c) c = cc[j + 1];
                const T = (c * c) / (GAMMA * R_GAS);
                if (T > 750) rate += 1e6 * Math.exp(-12000 / T);
              }
              if (rate > 0) {
                this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0;
                if ((this.seed >>> 8) < rate * srcDt * 16777216) {
                  flame[j] = 1;
                  if (!lit) this.pops++;
                }
              }
            }
          }
        }
        if (y < 0) y = 0;
        else if (y > r) y = r;
        rho[j] = r;
        mom[j] = mo;
        ene[j] = e;
        rY[j] = y;
      }
      this.pQw[k] -= qGas * this.pArea[k] * dx;
    }
    this.maxRate = maxRate;

    for (let v = 0; v < this.nv; v++) {
      if (!this.vFixed[v]) {
        let m = this.vm[v] + vdm[v];
        let E = this.vE[v] + vdE[v];
        if (!(m > 1e-9)) m = 1e-9;
        if (!(E > m * CV * 150)) E = m * CV * 150;
        this.vm[v] = m;
        this.vE[v] = E;
        let mY = this.vmY[v] + vdmY[v];
        if (mY < 0) mY = 0;
        else if (mY > m) mY = m;
        this.vmY[v] = mY;
        this.refreshVolume(v);
      }
      vdm[v] = 0;
      vdE[v] = 0;
      vdmY[v] = 0;
    }
  }
}
