// Mechanical noise: forces the simulation already knows (gas load, piston side thrust, valve
// seating, timing-drive meshing) excite a set of structural modes of the block and head, and the
// vibrating surfaces radiate sound. The forces are computed; the structure is a generic modal
// model scaled with engine size, not a finite-element model of a particular block.

import { RHO_ATM } from './gas';

const NM = 16;
/** Mode frequencies of an 86 mm-bore four-cylinder block and head: one per third octave from 400 Hz. */
const MODE_HZ = Array.from({ length: NM }, (_, k) => 400 * 2 ** (k / 3));
/** Modal mass per litre of displacement at 400 Hz, kg; big panels are heavy, local modes light. */
const MODE_MASS = 16;
const DAMPING = 0.03;
/**
 * How well each mode radiates, dB. Fitted so the K24 at idle has the spectrum of an engine-bay
 * recording; the overall scale puts a 2.4 litre four at 3000 rpm and full load near 87 dB at 1 m,
 * the level published correlations predict (50 log N + 60 log B - 203 dB(A) for petrol engines).
 */
export const MODE_GAIN = Float64Array.from([6.4, 10.9, -9.8, -7.1, -9.6, -12, -10.1, -15.9, -21.2, -18.8, -19.3, -26.9, -25.8, -22.3, -24.1, -25.6]);
/**
 * Where each kind of force puts its energy (centre frequency Hz, width in octaves) and how
 * strongly it couples into the radiating structure. The couplings set the balance of ticks
 * against steady noise heard in the recording at idle.
 */
const SHAPE = {
  gas: [1800, 1, 1],
  slap: [1800, 1.5, 0.5],
  valve: [4000, 1.6, 5],
  injector: [6000, 1.4, 2],
  drive: [1500, 1.6, 1],
  rough: [1000, 1e3, 1],
  // the turbocharger is bolted to the manifold: its shake reaches the whole structure
  turbo: [2500, 2.5, 5],
};
/** Liner contact: stiffness N/m, damping N s/m, and the oil film's resistance to sideways motion. */
const K_LINER = 1.5e8;
const C_LINER = 8000;
/** Oil-film damping at a 40 micron clearance. */
const C_OIL = 1500;
/** Valve seating: restitution, and the cam's closing-ramp height (mm) and velocity (mm per cam degree). */
const RESTITUTION = 0.3;
export const RAMP_HEIGHT = 0.25;
const RAMP_RATE = 0.02;
/** Impacts are spread over this contact time, s. */
const T_CONTACT = 1.2e-4;
/** Timing drive: teeth on the crank sprocket and moving mass per tooth pitch (kg) for belt, chain, gears. */
export const DRIVE_TEETH = [22, 18, 40];
const DRIVE_MASS = [0.0004, 0.005, 0.012];
const DRIVE_PITCH = [0.008, 0.008, 0.004];
/** Injector: impulse of the needle hitting its stop on opening and its seat on closing, N s. */
const INJ_OPEN = 0.004;
const INJ_CLOSE = 0.003;
/**
 * Sliding and rolling contacts (rings, skirts, bearings, cam followers, chain guides, the belt
 * drive) ride over surface roughness, a steady broadband force that grows with rubbing speed.
 * Force spectral density per rad/s of crank speed, N per root Hz.
 */
const ROUGH = 0.001;
/** Link-to-link variation in chain or tooth impacts. */
const DRIVE_SPREAD = 0.3;
/** Sources per cylinder: gas, slap, intake valves, exhaust valves, injector. */
const PER = 5;

/** Gain on each kind of source, for calibration scripts and tests. */
export const MECH_TUNE = { gas: 1, slap: 1, valve: 1, injector: 1, drive: 1, rough: 1 };

function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface MechConfig {
  cylinders: number;
  bore: number;
  displacement: number;
  /** Piston-to-bore clearance, m. */
  clearance: number;
  /** Mass that moves sideways in slap: the piston and pin, kg. */
  pistonMass: number;
  /** Valve lash, mm (0 = hydraulic adjusters), and moving mass per valve set, kg. */
  lash: number;
  valveMassIn: number;
  valveMassEx: number;
  /** 0 belt, 1 chain, 2 gears; -1 none. */
  drive: number;
  /** Port or direct injection rather than a carburettor. */
  injectors: boolean;
  /** Loudness of each kind of source, 1 = as calibrated. */
  gains?: { gas: number; slap: number; valve: number; injector: number; drive: number; rough: number; turbo?: number };
  /** Fraction of critical damping of the block's modes (default 0.03). */
  damping?: number;
  /** Tilt of the radiated spectrum about 1.6 kHz, dB per octave. */
  tilt?: number;
  /** Velocity of the cam's closing ramp, mm per cam degree (default 0.02). */
  rampRate?: number;
  /** Link-to-link variation of timing-drive impacts, 0 to 1 (default 0.3). */
  driveSpread?: number;
  /** Oil-film resistance to the piston crossing the bore, 1 = warm oil. */
  oilFilm?: number;
}

export class MechNoise {
  private w2 = new Float64Array(NM); private sig = new Float64Array(NM); private wd = new Float64Array(NM); private invM = new Float64Array(NM); private rad = new Float64Array(NM);
  private q = new Float64Array(NM); private v = new Float64Array(NM); private f = new Float64Array(NM);
  // exact one-step response of each mode, rebuilt when the step changes
  private a11 = new Float64Array(NM); private a12 = new Float64Array(NM); private a21 = new Float64Array(NM); private a22 = new Float64Array(NM);
  private dtCoef = 0;
  /** Participation of each source in each mode: PER per cylinder, then the drive. */
  private phi = new Float64Array(0);
  private n = 0;
  private cfg: MechConfig | null = null;
  // piston secondary motion
  private y = new Float64Array(12); private yv = new Float64Array(12); private touch = new Uint8Array(12);
  // impulses waiting to be delivered over the contact time, per source
  private pend = new Float64Array(0);
  // time until each open injector closes, s
  private injT = new Float64Array(12);
  private drivePhase = 0;
  private omega = 0;
  private seed = 0x2545f491;
  private cOil = C_OIL;
  private rampRate = RAMP_RATE; private driveSpread = DRIVE_SPREAD;
  /** Volume acceleration of the radiating surfaces, m3/s2 (times rho0 / 4 pi r gives pressure). */
  out = 0;
  /** Running totals for inspection: impulse delivered by each kind of source, N s. */
  stats = { slap: 0, valve: 0, drive: 0, injector: 0, slapHits: 0 };

  configure(cfg: MechConfig): void {
    const n = cfg.cylinders;
    if (n !== this.n) {
      this.n = n;
      this.phi = new Float64Array((PER * n + 3) * NM);
      this.pend = new Float64Array(PER * n + 1);
      this.y.fill(0);
      this.yv.fill(0);
      this.injT.fill(0);
    }
    this.cfg = cfg;
    this.dtCoef = 0;
    // a squeeze film resists far less across a wide gap than a narrow one
    this.cOil = Math.min(6000, Math.max(100, C_OIL * (40e-6 / cfg.clearance) ** 2)) * (cfg.oilFilm ?? 1);
    this.rampRate = cfg.rampRate ?? RAMP_RATE;
    this.driveSpread = cfg.driveSpread ?? DRIVE_SPREAD;
    const damping = cfg.damping ?? DAMPING, tilt = cfg.tilt ?? 0;
    const g = cfg.gains ?? { gas: 1, slap: 1, valve: 1, injector: 1, drive: 1, rough: 1 };
    const kindGain = [g.gas, g.slap, g.valve, g.valve, g.injector, g.drive, g.rough, g.turbo ?? 1];
    // Smaller engines are stiffer for their mass, so their modes sit higher.
    const scale = Math.pow(0.086 / cfg.bore, 0.8) * Math.pow(4 / Math.max(1, Math.min(n, 6)), 0.25);
    const litres = Math.max(0.3, cfg.displacement * 1e3);
    const hz = new Float64Array(NM);
    for (let k = 0; k < NM; k++) {
      hz[k] = Math.min(15000, MODE_HZ[k] * scale);
      const w = 2 * Math.PI * hz[k];
      this.w2[k] = w * w;
      this.sig[k] = damping * w;
      this.wd[k] = w * Math.sqrt(1 - damping * damping);
      this.invM[k] = 1 / (MODE_MASS * Math.pow(400 / MODE_HZ[k], 0.65) * litres);
      // radiating area grows with the engine's surface
      this.rad[k] = 0.05 * Math.pow(litres / 2.4, 2 / 3) * Math.pow(10, (MODE_GAIN[k] + tilt * Math.log2(MODE_HZ[k] / 1600)) / 20) * (k & 1 ? -1 : 1);
    }
    const kinds = [SHAPE.gas, SHAPE.slap, SHAPE.valve, SHAPE.valve, SHAPE.injector];
    for (let s = 0; s < PER * n + 3; s++) {
      const kind = s < PER * n ? s % PER : s - PER * n + PER, cyl = s < PER * n ? (s / PER) | 0 : 0;
      // roughness is spread over the whole structure, so it drives every mode alike
      const [f0, width, coupling] = kind === PER + 2 ? SHAPE.turbo : kind > PER ? SHAPE.rough : kind === PER ? SHAPE.drive : kinds[kind];
      for (let k = 0; k < NM; k++) {
        const oct = Math.log2(hz[k] / f0) / width;
        // each source sits somewhere different on the structure: a fixed pseudo-random mode shape value
        const h = hash(kind, cyl, k);
        this.phi[s * NM + k] = kindGain[kind] * coupling * Math.exp(-0.5 * oct * oct) * (0.5 + h) * (hash(k, kind, cyl + 7) < 0.5 ? -1 : 1);
      }
    }
  }

  private random(): number {
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x;
    return (x >>> 0) / 4294967296;
  }

  /** Gas force on the head (and, through the crank, the bearings) and the piston's side thrust on the liner. */
  cylinder(i: number, gasForce: number, sideForce: number, dt: number): void {
    const cfg = this.cfg!;
    const f = this.f, phi = this.phi;
    let o = PER * i * NM;
    const g = gasForce * MECH_TUNE.gas;
    for (let k = 0; k < NM; k++) f[k] += g * phi[o + k];
    // Secondary motion: the piston is pushed across its clearance when the side thrust reverses
    // and lands on the opposite wall of the liner.
    const half = 0.5 * cfg.clearance;
    let y = this.y[i], yv = this.yv[i];
    const pen = y > half ? y - half : y < -half ? y + half : 0;
    const kc = pen !== 0 ? K_LINER : 0, cc = this.cOil + (pen !== 0 ? C_LINER : 0);
    // implicit in the contact stiffness and damping: a light piston on a stiff liner must stay stable
    const im = dt / cfg.pistonMass;
    yv = (yv + im * (sideForce - kc * pen)) / (1 + im * (cc + kc * dt));
    y += yv * dt;
    this.y[i] = y;
    this.yv[i] = yv;
    const contact = pen !== 0 ? -kc * (pen + yv * dt) - C_LINER * yv : 0;
    if (contact !== 0) {
      // the liner feels the opposite of what the piston feels
      o += NM;
      const c = contact * MECH_TUNE.slap;
      for (let k = 0; k < NM; k++) f[k] -= c * phi[o + k];
      this.stats.slap += Math.abs(contact) * dt;
    }
    const touching = contact !== 0 ? 1 : 0;
    if (touching && !this.touch[i]) this.stats.slapHits++;
    this.touch[i] = touching;
  }

  /**
   * A valve set landing on its seats or being picked up by the rockers. `prev` and `lift` are
   * cam lift in metres on successive steps; the valve itself moves only above the lash.
   */
  valve(i: number, exhaust: boolean, prev: number, lift: number, dt: number, camDegPerSec: number): void {
    const cfg = this.cfg!;
    const lash = cfg.lash * 1e-3;
    const closing = prev > lash && lift <= lash, opening = prev <= lash && lift > lash;
    if (!closing && !opening) return;
    let vel = Math.abs(lift - prev) / dt;
    // Within the ramp height the cam moves the valve at the ramp's constant velocity; with
    // hydraulic adjusters there is no gap and the valve is set down at a fraction of that.
    const ramp = this.rampRate * 1e-3 * camDegPerSec;
    if (cfg.lash <= 0) vel = 0.3 * ramp;
    else if (cfg.lash <= RAMP_HEIGHT) vel = Math.min(vel, ramp);
    const mass = exhaust ? cfg.valveMassEx : cfg.valveMassIn;
    // seating: the valve stops on the head; opening: the rocker picks up half the mass
    const impulse = closing ? mass * vel * (1 + RESTITUTION) : cfg.lash > 0 ? 0.5 * mass * vel : 0;
    this.pend[PER * i + (exhaust ? 3 : 2)] += impulse * MECH_TUNE.valve;
    this.stats.valve += impulse;
  }

  /** An injector opening for `pulse` seconds: the needle clicks against its stop, then against its seat. */
  injector(i: number, pulse: number): void {
    if (!this.cfg!.injectors) return;
    const j = INJ_OPEN * MECH_TUNE.injector;
    this.pend[PER * i + 4] += j;
    this.stats.injector += j;
    this.injT[i] = pulse;
  }

  private spin = 0;
  /** A turbocharger rotor's out-of-balance force, N, going round at shaft speed: a pure tone into the structure. */
  turbo(force: number, omega: number, dt: number): void {
    if (force <= 0) return;
    this.spin += omega * dt;
    if (this.spin > 6.283185307) this.spin -= 6.283185307 * Math.floor(this.spin / 6.283185307);
    const fr = force * Math.cos(this.spin);
    const o = (PER * this.n + 2) * NM, f = this.f, phi = this.phi;
    for (let k = 0; k < NM; k++) f[k] += fr * phi[o + k];
  }

  /** Timing drive: every tooth engagement is a small impact, so the rate follows crank speed exactly. */
  drive(dTheta: number, omega: number): void {
    const cfg = this.cfg!;
    this.omega = Math.abs(omega);
    if (cfg.drive < 0) return;
    this.drivePhase += (dTheta * DRIVE_TEETH[cfg.drive]) / 360;
    if (this.drivePhase >= 1) {
      this.drivePhase -= Math.floor(this.drivePhase);
      // chordal action: the link meets the sprocket at about omega * pitch
      const impulse = DRIVE_MASS[cfg.drive] * omega * DRIVE_PITCH[cfg.drive] * 3 * (1 + this.driveSpread * (2 * this.random() - 1));
      this.pend[PER * this.n] += impulse * MECH_TUNE.drive;
      this.stats.drive += impulse;
    }
  }

  step(dt: number): void {
    const f = this.f, phi = this.phi, pend = this.pend;
    for (let i = 0; i < this.n; i++) {
      if (this.injT[i] <= 0) continue;
      if ((this.injT[i] -= dt) <= 0) {
        const j = INJ_CLOSE * MECH_TUNE.injector;
        pend[PER * i + 4] += j;
        this.stats.injector += j;
      }
    }
    // deliver pending impulses over the contact time
    const frac = dt >= T_CONTACT ? 1 : dt / T_CONTACT;
    for (let s = 0; s < pend.length; s++) {
      const p = pend[s];
      if (p < 1e-12) continue;
      const force = (p * frac) / dt;
      pend[s] = p * (1 - frac);
      const o = s * NM;
      for (let k = 0; k < NM; k++) f[k] += force * phi[o + k];
    }
    // white force: variance of a sample is density squared times half the sample rate
    const fr = ROUGH * MECH_TUNE.rough * this.omega * Math.sqrt(0.5 / dt) * 2.449 * (this.random() + this.random() - 1);
    const or = (PER * this.n + 1) * NM;
    for (let k = 0; k < NM; k++) f[k] += fr * phi[or + k];
    if (dt !== this.dtCoef) {
      this.dtCoef = dt;
      for (let k = 0; k < NM; k++) {
        const e = Math.exp(-this.sig[k] * dt), c = Math.cos(this.wd[k] * dt), s = Math.sin(this.wd[k] * dt) / this.wd[k];
        this.a11[k] = e * (c + this.sig[k] * s);
        this.a12[k] = e * s;
        this.a21[k] = -e * this.w2[k] * s;
        this.a22[k] = e * (c - this.sig[k] * s);
      }
    }
    let out = 0;
    for (let k = 0; k < NM; k++) {
      // exact for a force held over the step, so the highest modes stay in tune at audio rate
      const af = f[k] * this.invM[k], qe = af / this.w2[k];
      const u = this.q[k] - qe, v = this.v[k];
      const q = qe + this.a11[k] * u + this.a12[k] * v;
      this.v[k] = this.a21[k] * u + this.a22[k] * v;
      this.q[k] = q;
      out += this.rad[k] * (af - 2 * this.sig[k] * this.v[k] - this.w2[k] * q);
      f[k] = 0;
    }
    this.out = out;
  }

  reset(): void {
    this.q.fill(0); this.v.fill(0); this.f.fill(0); this.pend.fill(0); this.y.fill(0); this.yv.fill(0); this.injT.fill(0);
    this.out = 0;
  }

  /** Sound pressure at distance r in free field, Pa. */
  pressure(r: number): number {
    return (RHO_ATM * this.out) / (4 * Math.PI * r);
  }
}
