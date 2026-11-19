// The engine model: cylinders (0D), crank dynamics, valve flow coupling to the
// 1D gas network, and the radiated-sound output. One step() per audio sample.

import { CP, CV, G1, GasNetwork, P_ATM, RHO_ATM, R_GAS, T_ATM } from './gas';
import { DEG, ValveEvents, valveEvents } from './kinematics';
import { LAYOUT_KINDS, ResolvedLayout, resolveLayout } from './layouts';
import { HIDDEN_DEFAULTS, PARAM_DEFS, Params } from './params';
import { C, FLAG_IGNITION, FLAG_LIMITER, FLAG_PAUSED, FLAG_STARTER, H, SNAP_CYL_STRIDE, SNAP_HEADER, TRACE_BINS } from './snapshot';
import { Topology, VOL_CYL0, VOL_PLENUM, buildTopology } from './topology';

const RAD2DEG = 180 / Math.PI;
const LHV = 44e6;
const AFR_STOICH = 14.7;
/** Fraction of fuel energy released as heat in the constant-gamma gas (see README). */
const COMB_EFF = 0.75;
const T_WALL_CYL = 450;
const C_SOUND = 343;
/** Pascals at the listener that map to full scale before the soft clipper. */
const P_REF = 10;

const STRUCTURAL = ['layout', 'cylinders', 'crank', 'firingOrder', 'bankAngle', 'collector', 'cellBudget'];
const GEOMETRY = [
  'bore', 'stroke', 'rodLength', 'compression', 'throttleBody', 'intakeLength', 'runnerLength', 'runnerDiameter',
  'plenumVolume', 'headerLength', 'headerDiameter', 'midLength', 'mufflerVolume', 'tailLength', 'tailDiameter',
];

const SMOOTH_KEYS = PARAM_DEFS.filter((d) => d.kind === 'slider' && d.smooth).map((d) => d.key);
const SMOOTH_SPAN = PARAM_DEFS.filter((d) => d.kind === 'slider' && d.smooth).map((d) => d.max - d.min);
const DIRECT_KEYS = [...PARAM_DEFS.filter((d) => !(d.kind === 'slider' && d.smooth)).map((d) => d.key), ...Object.keys(HIDDEN_DEFAULTS)];

function crossed(prev: number, now: number, mark: number): boolean {
  return now >= prev ? prev < mark && mark <= now : mark > prev || mark <= now;
}

const mod720 = (a: number) => ((a % 720) + 720) % 720;

class Biquad {
  b0 = 0; b2 = 0; a1 = 0; a2 = 0;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  bandpass(f0: number, q: number, sampleRate: number): void {
    const w = (2 * Math.PI * Math.min(f0, 0.45 * sampleRate)) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  run(x: number): number {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

export interface TopologyInfo {
  id: number;
  nCyl: number;
  totalCells: number;
  pipes: { kind: string; cyl: number; group: number; cells: number; offset: number; length: number; diameter: number; volL: number; volR: number }[];
  volumes: { kind: string; group: number; volume: number }[];
}

export class EngineSim {
  readonly sampleRate: number;
  readonly dt: number;
  target: Params;
  cur: Params;
  layout!: ResolvedLayout;
  topo!: Topology;
  gas!: GasNetwork;
  topoId = 0;

  theta = 0;
  omega = 0;
  simTime = 0;
  autoStart = true;
  private autoStartTime = 0;
  resets = 0;
  nsub = 1;
  cpuLoad = 0;

  // derived
  n = 1;
  private fire = new Float64Array(1);
  private r = 0.04; private l = 0.14; private bore = 0.086; private Ap = 0; private Vc = 0; private VdTot = 0;
  ev!: ValveEvents;
  private kCurtIn = 0; private kCurtEx = 0; private portIn = 0; private portEx = 0;
  private aRun = 1; private aHead = 1;
  private sparkAngle = 700; private ivcAngle = 600;
  private inertia = 0.2; private loadK = 0; private starterT0 = 100;
  private radPipes: number[] = [];

  // per cylinder
  private aPrev = new Float64Array(1);
  private burning = new Uint8Array(1);
  private burnAng = new Float64Array(1);
  private burnDur = new Float64Array(1);
  private qTot = new Float64Array(1);
  private xbPrev = new Float64Array(1);
  private hCoef = new Float64Array(1);
  readonly liftIn = new Float64Array(12);
  readonly liftEx = new Float64Array(12);
  readonly flash = new Float64Array(12);
  private veCyl = new Float64Array(12);
  private trace = new Float32Array(12 * TRACE_BINS);
  private traceBin = new Int32Array(12);

  // running state
  private stepCount = 0;
  private iac = 1;
  private iacBase = 0.008;
  private throttlePhi = 0.01;
  limiterCut = false;
  starterOn = false;
  private meanPistonSpeed = 0;
  private torqueAcc = 0; private mapAcc = 0; private angAcc = 0; private timeAcc = 0;
  brakeTorque = 0; power = 0; ve = 0; map = P_ATM; instTorque = 0; rpmAvg = 0; mdotAir = 0;

  // audio
  private mInPrev = 0;
  private lpIn = 0; private lpA = 0.7;
  private delayIn = new Float32Array(4096); private delayPos = 0;
  private dIn = 1; private rIn = 1; private rMech = 1;
  // one monopole per radiating pipe end
  private srcPrev = new Float64Array(12); private srcLp = new Float64Array(12);
  private srcGain = new Float64Array(12); private srcDelay = new Int32Array(12);
  private srcBuf = new Float32Array(12 * 4096);
  private hpX = 0; private hpY = 0; private hpR = 0.998;
  private fadeGain = 0; private fadeTarget = 1; private fadeStep = 1e-3;
  private pendingStructural = false;
  private bpComb = new Biquad(); private bpTick = new Biquad();
  private tickEnv = 0; private tickDecay = 0.99; private seed = 12345;
  private sumPcyl = 0;
  peakOut = 0;
  private stepDeg = 0;
  /** Unclipped component pressures at the listener (Pa), last sample. */
  lastEx = 0; lastIn = 0; lastMech = 0;

  constructor(sampleRate: number, params: Params) {
    this.sampleRate = sampleRate;
    this.dt = 1 / sampleRate;
    this.target = { ...HIDDEN_DEFAULTS, ...params };
    this.cur = { ...this.target };
    this.lpA = 1 - Math.exp((-2 * Math.PI * 9000) / sampleRate);
    this.hpR = 1 - (2 * Math.PI * 12) / sampleRate;
    this.fadeStep = 1 / (0.02 * sampleRate);
    this.tickDecay = Math.exp(-1 / (0.0012 * sampleRate));
    this.bpComb.bandpass(1700, 0.7, sampleRate);
    this.bpTick.bandpass(4200, 2.5, sampleRate);
    this.rebuild(false);
  }

  setParams(values: Params): void {
    for (const k in values) this.target[k] = values[k];
  }

  requestStepDegrees(deg: number): void {
    this.stepDeg += deg;
  }

  // ---------------------------------------------------------------- build

  private resolve(p: Params): ResolvedLayout {
    return resolveLayout(LAYOUT_KINDS[p.layout | 0] ?? 'inline', p.cylinders | 0, p.bankAngle, p.crank | 0, p.firingOrder | 0);
  }

  private derive(): void {
    const p = this.cur;
    const n = this.n;
    this.bore = p.bore * 1e-3;
    const stroke = p.stroke * 1e-3;
    this.r = 0.5 * stroke;
    this.l = Math.max(p.rodLength * 1e-3, 0.66 * stroke);
    this.Ap = 0.25 * Math.PI * this.bore * this.bore;
    const Vd = this.Ap * stroke;
    this.Vc = Vd / (p.compression - 1);
    this.VdTot = Vd * n;
    this.ev = valveEvents(p.intakeDuration, p.exhaustDuration, p.lsa, p.camAdvance);
    const dIn = 0.36 * this.bore;
    const dEx = 0.31 * this.bore;
    this.kCurtIn = 0.7 * 2 * Math.PI * dIn;
    this.kCurtEx = 0.7 * 2 * Math.PI * dEx;
    this.portIn = 0.9 * 2 * 0.25 * Math.PI * dIn * dIn;
    this.portEx = 0.9 * 2 * 0.25 * Math.PI * dEx * dEx;
    this.aRun = 0.25 * Math.PI * (p.runnerDiameter * 1e-3) ** 2;
    this.aHead = 0.25 * Math.PI * (p.headerDiameter * 1e-3) ** 2;
    this.sparkAngle = mod720(720 - p.ignitionAdvance);
    this.ivcAngle = mod720(this.ev.ivc);
    const litres = this.VdTot * 1e3;
    this.inertia = p.flywheel + 0.015 * litres;
    this.loadK = ((p.load / 100) * 100 * litres) / (314.16 * 314.16);
    this.starterT0 = 80 * litres + 0.9 * p.compression * P_ATM * this.Ap * this.r;
    // Feed-forward idle air: roughly what the engine needs at ~35 kPa manifold pressure.
    const aTb = 0.25 * Math.PI * (p.throttleBody * 1e-3) ** 2;
    this.iacBase = (0.35 * RHO_ATM * this.VdTot * (p.idleRpm / 120) * 0.85) / (0.88 * aTb * 234) * 0.45;
    this.rIn = Math.max(0.3, Math.hypot(p.listenerPos, p.listenerDist));
    this.rMech = Math.hypot(p.listenerPos - 0.6, p.listenerDist);
    this.placeSources();
    this.dIn = Math.min(4000, (this.rIn / C_SOUND) * this.sampleRate);
  }

  /** Listener geometry: each radiating pipe end is a monopole at its own position. */
  private placeSources(): void {
    if (!this.topo) return;
    const p = this.cur;
    const rad = this.radPipes;
    for (let i = 0; i < rad.length && i < 12; i++) {
      const q = this.topo.pipes[rad[i]];
      let x = 3.5, y = 0.45;
      if (q.kind === 'tail') {
        if (rad.length > 1) y = q.group === 0 ? 0.6 : -0.6;
      } else {
        x = 0.9;
        y = this.layout.def.bank[q.cyl] > 0 ? -0.45 : 0.45;
      }
      const r = Math.max(0.3, Math.hypot(p.listenerPos - x, p.listenerDist - y));
      this.srcGain[i] = 1 / (4 * Math.PI * r);
      this.srcDelay[i] = Math.min(4000, Math.round((r / C_SOUND) * this.sampleRate));
    }
  }

  private cylVolumeAt(i: number): number {
    const a = mod720(this.theta - this.fire[i]) * DEG;
    const sn = Math.sin(a);
    return this.Vc + this.Ap * (this.r + this.l - (this.r * Math.cos(a) + Math.sqrt(this.l * this.l - this.r * this.r * sn * sn)));
  }

  private rescaleVolume(v: number, vNew: number): void {
    const g = this.gas;
    const k = vNew / g.vV[v];
    g.vm[v] *= k;
    g.vE[v] *= k;
    g.vmY[v] *= k;
    g.vV[v] = vNew;
    g.refreshVolume(v);
  }

  private rebuild(keep: boolean): void {
    const old = keep ? this.gas : undefined;
    const oldTopo = this.topo;
    this.layout = this.resolve(this.cur);
    const n = this.layout.n;
    if (n !== this.n || this.aPrev.length !== n) {
      this.aPrev = new Float64Array(n);
      this.burning = new Uint8Array(n);
      this.burnAng = new Float64Array(n);
      this.burnDur = new Float64Array(n);
      this.qTot = new Float64Array(n);
      this.xbPrev = new Float64Array(n);
      this.hCoef = new Float64Array(n);
      this.fire = new Float64Array(n);
      this.trace.fill(P_ATM);
    }
    this.n = n;
    for (let i = 0; i < n; i++) this.fire[i] = this.layout.fire[i];
    this.derive();
    const topo = buildTopology(this.cur, this.layout, this.dt);
    const gas = new GasNetwork(
      topo.volumes.map((v) => ({ volume: v.volume, fixed: v.kind === 'ambient' })),
      topo.pipes.map((q) => ({ length: q.length, diameter: q.diameter, cells: q.cells, volL: q.volL, volR: q.volR, wallT: q.wallT })),
    );
    if (old && oldTopo && oldTopo.signature === topo.signature) {
      for (let v = 1; v < gas.nv; v++) gas.setVolumeState(v, old.vp[v], old.vT[v], old.vY[v]);
      for (let k = 0; k < gas.np; k++) {
        const nNew = gas.pN[k], nOld = old.pN[k], o0 = old.pOff[k], o1 = gas.pOff[k];
        for (let i = 0; i < nNew; i++) {
          let f = ((i + 0.5) / nNew) * nOld - 0.5;
          if (f < 0) f = 0;
          if (f > nOld - 1) f = nOld - 1;
          const i0 = Math.min(nOld - 2, Math.floor(f));
          const w = nOld > 1 ? f - i0 : 0;
          const a = o0 + Math.max(0, i0), b = o0 + Math.max(0, i0) + (nOld > 1 ? 1 : 0);
          gas.rho[o1 + i] = old.rho[a] * (1 - w) + old.rho[b] * w;
          gas.mom[o1 + i] = old.mom[a] * (1 - w) + old.mom[b] * w;
          gas.ene[o1 + i] = old.ene[a] * (1 - w) + old.ene[b] * w;
          gas.rY[o1 + i] = old.rY[a] * (1 - w) + old.rY[b] * w;
        }
      }
    } else {
      this.burning.fill(0);
      this.mInPrev = 0;
      this.lpIn = 0;
      this.srcPrev.fill(0);
      this.srcLp.fill(0);
    }
    this.gas = gas;
    this.topo = topo;
    this.topoId++;
    for (let i = 0; i < n; i++) {
      this.rescaleVolume(VOL_CYL0 + i, this.cylVolumeAt(i));
      this.aPrev[i] = mod720(this.theta - this.fire[i]);
      this.traceBin[i] = Math.floor(this.aPrev[i]) % TRACE_BINS;
    }
    this.radPipes = [];
    topo.pipes.forEach((q, k) => q.radiates && this.radPipes.push(k));
    this.placeSources();
    this.nsub = 1;
  }

  private applyGeometry(): void {
    this.derive();
    const topo = buildTopology(this.cur, this.layout, this.dt);
    let same = topo.signature === this.topo.signature;
    if (same) for (let k = 0; k < topo.pipes.length; k++) if (topo.pipes[k].cells !== this.topo.pipes[k].cells) same = false;
    if (!same) {
      this.rebuild(true);
      return;
    }
    const g = this.gas;
    for (let k = 0; k < topo.pipes.length; k++) g.setPipeGeometry(k, topo.pipes[k].length, topo.pipes[k].diameter);
    for (let v = 1; v < topo.volumes.length; v++) {
      if (topo.volumes[v].kind !== 'cylinder') this.rescaleVolume(v, topo.volumes[v].volume);
    }
    for (let i = 0; i < this.n; i++) this.rescaleVolume(VOL_CYL0 + i, this.cylVolumeAt(i));
    this.topo = topo;
  }

  /** Call once per audio block: slews parameters and applies structural changes. */
  beginBlock(blockSamples = 128): void {
    const alpha = 1 - Math.exp((-blockSamples * this.dt) / 0.045);
    const cur = this.cur, tgt = this.target;
    let changed = false, geom = false;
    for (let i = 0; i < SMOOTH_KEYS.length; i++) {
      const k = SMOOTH_KEYS[i];
      const d = tgt[k] - cur[k];
      if (d === 0) continue;
      cur[k] = Math.abs(d) > 2e-4 * SMOOTH_SPAN[i] ? cur[k] + d * alpha : tgt[k];
      changed = true;
      if (GEOMETRY.indexOf(k) >= 0) geom = true;
    }
    let structural = false;
    for (let i = 0; i < DIRECT_KEYS.length; i++) {
      const k = DIRECT_KEYS[i];
      if (tgt[k] === cur[k]) continue;
      if (STRUCTURAL.indexOf(k) >= 0) structural = true;
      else {
        cur[k] = tgt[k];
        changed = true;
      }
    }
    if (structural) {
      if (!this.pendingStructural) {
        const merged = { ...cur };
        for (const k of STRUCTURAL) merged[k] = tgt[k];
        const sig = buildTopology(merged, this.resolve(merged), this.dt).signature;
        if (sig === this.topo.signature) {
          for (const k of STRUCTURAL) cur[k] = tgt[k];
          this.rebuild(true);
        } else {
          this.pendingStructural = true;
        }
      }
      if (this.pendingStructural && this.fadeGain <= 1e-3) {
        for (const k of STRUCTURAL) cur[k] = tgt[k];
        this.rebuild(false);
        this.pendingStructural = false;
      }
    }
    if (geom) this.applyGeometry();
    else if (changed) this.derive();

    const ts = cur.timeScale;
    const audible = ts >= 0.999 ? 1 : Math.min(1, Math.max(0, (ts - 0.08) / 0.2));
    this.fadeTarget = this.pendingStructural || cur.paused ? 0 : audible;
    this.starterOn = cur.starter > 0.5 || this.autoStart;
    if (!Number.isFinite(this.omega) || !Number.isFinite(this.gas.maxRate) || !Number.isFinite(this.gas.vp[VOL_PLENUM]) || !Number.isFinite(this.hpY)) this.recover();
  }

  private recover(): void {
    this.resets++;
    if (!Number.isFinite(this.omega)) this.omega = 0;
    this.hpX = this.hpY = 0;
    this.lpIn = 0;
    this.srcLp.fill(0);
    this.bpComb = new Biquad();
    this.bpTick = new Biquad();
    this.bpComb.bandpass(1700, 0.7, this.sampleRate);
    this.bpTick.bandpass(4200, 2.5, this.sampleRate);
    this.rebuild(false);
  }

  // ----------------------------------------------------------------- step

  /** Advance one audio sample; returns the output sample in [-1, 1]. */
  step(): number {
    const cur = this.cur;
    if (cur.paused && this.fadeGain <= 0) {
      if (this.stepDeg > 0) {
        const before = this.theta;
        this.substep(this.dt);
        let d = this.theta - before;
        if (d < 0) d += 720;
        this.stepDeg -= d > 0 ? d : 0.002;
        for (let i = 0; i < this.radPipes.length; i++) this.srcPrev[i] = this.gas.pMdotR[this.radPipes[i]];
        this.mInPrev = this.gas.pMdotL[0];
      }
      return 0;
    }
    const ts = cur.timeScale;
    const nsub = this.nsub;
    const dt = (this.dt * ts) / nsub;
    for (let s = 0; s < nsub; s++) this.substep(dt);
    const cfl = this.gas.maxRate * this.dt * ts * 1.15;
    this.nsub = cfl > 0.9 ? Math.min(8, Math.ceil(cfl / 0.9)) : 1;
    return this.audio(dt * nsub, ts);
  }

  private substep(dt: number): void {
    const g = this.gas;
    const n = this.n;
    const cur = this.cur;
    const r = this.r, l = this.l, Ap = this.Ap, Vc = this.Vc;
    const dth = this.omega * dt * RAD2DEG;
    let th = this.theta + dth;
    if (th >= 720) th -= 720;
    this.theta = th;
    this.simTime += dt;
    const rpm = this.omega * 9.549297;

    // Rev limiter with hysteresis.
    if (rpm > cur.revLimit) this.limiterCut = true;
    else if (rpm < cur.revLimit - 120) this.limiterCut = false;
    const sparkOk = cur.ignition > 0.5 && !this.limiterCut && this.omega > 8;

    const hUpdate = (this.stepCount & 7) === 0;
    const ivcA = this.ivcAngle, spkA = this.sparkAngle;
    const ci = this.ev.intakeCentre, ce = this.ev.exhaustCentre;
    const durI = cur.intakeDuration, durE = cur.exhaustDuration;
    const LI = cur.intakeLift * 1e-3, LE = cur.exhaustLift * 1e-3;
    const topo = this.topo;
    let torque = 0;
    let sumP = 0;

    for (let i = 0; i < n; i++) {
      let a = th - this.fire[i];
      if (a < 0) a += 720;
      const ar = a * DEG;
      const sn = Math.sin(ar), cs = Math.cos(ar);
      const root = Math.sqrt(l * l - r * r * sn * sn);
      const x = r + l - (r * cs + root);
      const V = Vc + Ap * x;
      const dVdth = Ap * r * sn * (1 + (r * cs) / root);
      const v = VOL_CYL0 + i;
      const V0 = g.vV[v];
      const k = 0.5 * G1 * (V - V0);
      let E = (g.vE[v] * (1 - k / V0)) / (1 + k / V);
      const m = g.vm[v];
      const ap = this.aPrev[i];

      if (dth > 0 && crossed(ap, a, spkA) && sparkOk && !this.burning[i]) {
        const mY = g.vmY[v];
        const fresh = m - mY;
        const lam = cur.afr / AFR_STOICH;
        const resid = mY / m;
        // Empirical flammability window and dilution slow-down (approximated).
        let fl = 1;
        if (lam < 0.75) fl = Math.max(0, (lam - 0.55) / 0.2);
        else if (lam > 1.35) fl = Math.max(0, (1.7 - lam) / 0.35);
        if (resid > 0.5) fl *= Math.max(0, (0.8 - resid) / 0.3);
        if (fl > 0.02 && fresh > 0) {
          this.qTot[i] = ((LHV * fresh) / AFR_STOICH) * Math.min(1, 1 / lam) * COMB_EFF * fl;
          this.burnDur[i] = cur.burnDuration * (1 + 2.2 * (lam - 0.9) * (lam - 0.9) + 1.2 * resid);
          this.burnAng[i] = 0;
          this.xbPrev[i] = 0;
          this.burning[i] = 1;
        }
      }
      let flash = this.flash[i] * 0.985;
      if (this.burning[i]) {
        const ba = this.burnAng[i] + dth;
        this.burnAng[i] = ba;
        const xr = ba / this.burnDur[i];
        let xb = xr >= 1 ? 1 : 1 - Math.exp(-5 * xr * xr * xr);
        const xp = this.xbPrev[i];
        const dxb = xb - xp;
        E += this.qTot[i] * dxb;
        g.vmY[v] += (m - g.vmY[v]) * (dxb / (1 - xp + 1e-9));
        this.xbPrev[i] = xb;
        if (xr >= 1) this.burning[i] = 0;
        const rate = dth > 0 ? (dxb / dth) * this.burnDur[i] : 0;
        if (rate > flash) flash = rate > 1.5 ? 1.5 : rate;
      }
      this.flash[i] = flash;

      // Wall heat loss (Hohenberg correlation, coefficient refreshed every 8 steps).
      const T = E / (m * CV);
      if (hUpdate) {
        const p0 = (G1 * E) / V;
        this.hCoef[i] = 130 * Math.pow(V, -0.06) * Math.pow(p0 * 1e-5, 0.8) * Math.pow(T, -0.4) * Math.pow(this.meanPistonSpeed + 1.4, 0.8);
      }
      let dQ = this.hCoef[i] * (2 * Ap + Math.PI * this.bore * x) * (T - T_WALL_CYL) * dt;
      if (dQ > 0.2 * E) dQ = 0.2 * E;
      E -= dQ;

      g.vE[v] = E;
      g.vV[v] = V;
      g.refreshVolume(v);
      const p = g.vp[v];
      torque += (p - P_ATM) * dVdth;
      sumP += p;

      // Valve lift -> effective orifice area ratio at the pipe ends.
      let d = a - ci;
      if (d > 360) d -= 720; else if (d < -360) d += 720;
      let xx = (2 * d) / durI;
      let lift = 0;
      if (xx > -1 && xx < 1) { const q = 1 - xx * xx; lift = LI * q * q; }
      if (lift === 0 && this.liftIn[i] > 0) this.tickEnv += 0.5 + rpm * 2e-4;
      this.liftIn[i] = lift;
      let ac = this.kCurtIn * lift;
      let phi = (ac * this.portIn) / Math.sqrt(ac * ac + this.portIn * this.portIn) / this.aRun;
      g.pPhiR[topo.runnerPipe[i]] = phi > 1 ? 1 : phi;

      d = a - ce;
      if (d > 360) d -= 720; else if (d < -360) d += 720;
      xx = (2 * d) / durE;
      lift = 0;
      if (xx > -1 && xx < 1) { const q = 1 - xx * xx; lift = LE * q * q; }
      if (lift === 0 && this.liftEx[i] > 0) this.tickEnv += 0.5 + rpm * 2e-4;
      this.liftEx[i] = lift;
      ac = this.kCurtEx * lift;
      phi = (ac * this.portEx) / Math.sqrt(ac * ac + this.portEx * this.portEx) / this.aHead;
      g.pPhiL[topo.headerPipe[i]] = phi > 1 ? 1 : phi;

      if (dth > 0 && crossed(ap, a, ivcA)) {
        this.veCyl[i] = (m - g.vmY[v]) / (RHO_ATM * Ap * 2 * r);
      }

      // Pressure trace, one bin per crank degree.
      let bin = a | 0;
      if (bin >= TRACE_BINS) bin = TRACE_BINS - 1;
      let b = this.traceBin[i];
      if (b !== bin) {
        const base = i * TRACE_BINS;
        let guard = 0;
        while (b !== bin && guard++ < 16) {
          b = b + 1 === TRACE_BINS ? 0 : b + 1;
          this.trace[base + b] = p;
        }
        this.traceBin[i] = bin;
      }
      this.aPrev[i] = a;
    }
    this.sumPcyl = sumP;

    // Throttle plate plus idle air valve (integral controller, like a real IAC).
    const thr = cur.throttle * 0.01;
    const idleErr = (cur.idleRpm - rpm) / cur.idleRpm;
    let idleAir = 0;
    if (thr < 0.02) {
      // Integrate only near the setpoint so a start-up flare or overrun does not wind it shut.
      if (sparkOk && idleErr > -0.6) this.iac += 0.5 * idleErr * dt;
      if (this.iac < 0.1) this.iac = 0.1; else if (this.iac > 8) this.iac = 8;
      // Gentle proportional trim, plus a strong opening if the engine is about to stall.
      idleAir = this.iac + 0.5 * idleErr + (idleErr > 0.2 ? 6 * (idleErr - 0.2) : 0);
      if (idleAir < 0.15) idleAir = 0.15;
    } else {
      idleAir = this.iac;
    }
    let open = 1 - Math.cos(thr * 0.5 * Math.PI) + this.iacBase * idleAir;
    if (open > 1) open = 1;
    this.throttlePhi = 0.88 * open;
    g.pPhiR[topo.intakePipe] = this.throttlePhi;

    this.stepCount++;
    g.step(dt, dt);

    // Crank dynamics.
    const sp = (2 * r * 2 * this.omega) / (2 * Math.PI);
    this.meanPistonSpeed = sp;
    const fmep = (0.45 + 0.06 * sp + 0.0015 * sp * sp) * 1e5;
    const tFric = (fmep * this.VdTot) / (4 * Math.PI);
    let tStart = 0;
    if (this.starterOn) {
      tStart = this.starterT0 * Math.max(0, 1 - rpm / 380);
      if (this.autoStart) {
        this.autoStartTime += dt;
        if (rpm > 0.7 * cur.idleRpm || this.autoStartTime > 4) this.autoStart = false;
      }
    }
    const drive = torque + tStart - this.loadK * this.omega * this.omega;
    let om = this.omega;
    if (om > 0) om += ((drive - tFric) / this.inertia) * dt;
    else if (drive > tFric) om += ((drive - tFric) / this.inertia) * dt;
    if (om < 0) om = 0;
    this.omega = om;
    this.instTorque = torque - tFric;

    // Cycle-averaged gauges.
    this.torqueAcc += (torque - tFric) * dth;
    this.mapAcc += g.vp[VOL_PLENUM] * dth;
    this.angAcc += dth;
    this.timeAcc += dt;
    if (this.angAcc >= 720) {
      this.brakeTorque = this.torqueAcc / this.angAcc;
      this.map = this.mapAcc / this.angAcc;
      this.rpmAvg = this.angAcc / this.timeAcc / 6;
      this.power = this.brakeTorque * this.rpmAvg * 0.104720;
      let ve = 0;
      for (let i = 0; i < n; i++) ve += this.veCyl[i];
      this.ve = ve / n;
      this.torqueAcc = this.mapAcc = this.angAcc = this.timeAcc = 0;
    } else if (this.timeAcc > 0.5) {
      // Stalled or barely turning: do not leave stale numbers on the gauges.
      this.brakeTorque = this.angAcc > 1 ? this.torqueAcc / this.angAcc : 0;
      this.map = this.angAcc > 1 ? this.mapAcc / this.angAcc : g.vp[VOL_PLENUM];
      this.rpmAvg = this.angAcc / this.timeAcc / 6;
      this.power = this.brakeTorque * this.rpmAvg * 0.104720;
      this.torqueAcc = this.mapAcc = this.angAcc = this.timeAcc = 0;
    }
    this.mdotAir = g.pMdotL[topo.intakePipe];
  }

  private audio(dt: number, ts: number): number {
    const g = this.gas;
    const cur = this.cur;
    const mIn = g.pMdotL[0];
    const inv = 1 / dt;
    const pos = this.delayPos;
    // Monopole radiation: p(r) = d(mdot_out)/dt / (4 pi r), summed over outlets.
    let pEx = 0;
    const rad = this.radPipes;
    for (let i = 0; i < rad.length; i++) {
      const m = g.pMdotR[rad[i]];
      const lp = this.srcLp[i] + this.lpA * ((m - this.srcPrev[i]) * inv - this.srcLp[i]);
      this.srcLp[i] = lp;
      this.srcPrev[i] = m;
      const base = i << 12;
      this.srcBuf[base + pos] = lp * this.srcGain[i];
      pEx += this.srcBuf[base + ((pos - this.srcDelay[i]) & 4095)];
    }
    this.lpIn += this.lpA * (-(mIn - this.mInPrev) * inv - this.lpIn);
    this.mInPrev = mIn;
    this.delayIn[pos] = this.lpIn / (4 * Math.PI * this.rIn);
    const pIn = this.delayIn[(pos - (this.dIn | 0)) & 4095];
    this.delayPos = (pos + 1) & 4095;

    // Mechanical noise is NOT simulated: band-passed cylinder pressure for
    // block-radiated combustion noise plus noise bursts at valve closures.
    let pMech = 0;
    if (ts >= 0.999) {
      this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0;
      const noise = this.seed * 4.6566e-10;
      this.tickEnv *= this.tickDecay;
      if (this.tickEnv > 4) this.tickEnv = 4;
      pMech = (this.bpComb.run(this.sumPcyl) * 4.8e-6 + this.bpTick.run(noise * this.tickEnv) * 3) / this.rMech;
    }
    this.lastEx = pEx;
    this.lastIn = pIn;
    this.lastMech = pMech;

    const y = (cur.mixExhaust * pEx + cur.mixIntake * pIn + cur.mixMech * pMech) * (0.01 / P_REF);
    const hp = y - this.hpX + this.hpR * this.hpY;
    this.hpX = y;
    this.hpY = hp;
    if (this.fadeGain < this.fadeTarget) this.fadeGain = Math.min(this.fadeTarget, this.fadeGain + this.fadeStep);
    else if (this.fadeGain > this.fadeTarget) this.fadeGain = Math.max(this.fadeTarget, this.fadeGain - this.fadeStep);
    const out = Math.tanh(hp * this.fadeGain);
    const ao = out < 0 ? -out : out;
    if (ao > this.peakOut) this.peakOut = ao;
    return out;
  }

  get rpm(): number {
    return this.omega * 9.549297;
  }

  /** Run for a duration with block processing; returns nothing. For tests and warm-up. */
  run(seconds: number, sink?: Float32Array): void {
    const total = Math.round(seconds * this.sampleRate);
    for (let i = 0; i < total; i++) {
      if (i % 128 === 0) this.beginBlock(128);
      const y = this.step();
      if (sink && i < sink.length) sink[i] = y;
    }
  }

  // ------------------------------------------------------------ telemetry

  topologyInfo(): TopologyInfo {
    const g = this.gas;
    return {
      id: this.topoId,
      nCyl: this.n,
      totalCells: g.nCells,
      pipes: this.topo.pipes.map((q, k) => ({ kind: q.kind, cyl: q.cyl, group: q.group, cells: g.pN[k], offset: g.pOff[k], length: q.length, diameter: q.diameter, volL: q.volL, volR: q.volR })),
      volumes: this.topo.volumes.map((v) => ({ kind: v.kind, group: v.group, volume: v.volume })),
    };
  }

  snapshotFloats(): number {
    return SNAP_HEADER + this.n * SNAP_CYL_STRIDE + this.gas.nv * 3 + this.gas.nCells * 4 + this.n * TRACE_BINS;
  }

  writeSnapshot(out: Float32Array, withTraces: boolean): void {
    const g = this.gas;
    const n = this.n;
    out[H.theta] = this.theta;
    out[H.rpm] = this.rpm;
    out[H.torque] = this.brakeTorque;
    out[H.power] = this.power;
    out[H.ve] = this.ve;
    out[H.map] = this.map;
    out[H.throttle] = this.throttlePhi / 0.88;
    out[H.nCyl] = n;
    out[H.nVol] = g.nv;
    out[H.nCells] = g.nCells;
    out[H.cpuLoad] = this.cpuLoad;
    out[H.flags] = (this.starterOn ? FLAG_STARTER : 0) | (this.limiterCut ? FLAG_LIMITER : 0) | (this.cur.ignition > 0.5 ? FLAG_IGNITION : 0) | (this.cur.paused ? FLAG_PAUSED : 0);
    out[H.simTime] = this.simTime;
    out[H.instTorque] = this.instTorque;
    out[H.timeScale] = this.cur.timeScale;
    out[H.hasTraces] = withTraces ? 1 : 0;
    out[H.resets] = this.resets;
    out[H.substeps] = this.nsub;
    out[H.mdotAir] = this.mdotAir;
    out[H.topoId] = this.topoId;
    out[H.peakOut] = this.peakOut;
    this.peakOut = 0;
    let o = SNAP_HEADER;
    for (let i = 0; i < n; i++) {
      const v = VOL_CYL0 + i;
      out[o + C.angle] = this.aPrev[i];
      out[o + C.p] = g.vp[v];
      out[o + C.T] = g.vT[v];
      out[o + C.V] = g.vV[v];
      out[o + C.Y] = g.vY[v];
      out[o + C.liftIn] = this.liftIn[i];
      out[o + C.liftEx] = this.liftEx[i];
      out[o + C.flash] = this.flash[i];
      out[o + C.mdotIn] = g.pMdotR[this.topo.runnerPipe[i]];
      out[o + C.mdotEx] = g.pMdotL[this.topo.headerPipe[i]];
      o += SNAP_CYL_STRIDE;
    }
    for (let v = 0; v < g.nv; v++) {
      out[o++] = g.vp[v];
      out[o++] = g.vT[v];
      out[o++] = g.vY[v];
    }
    const nc = g.nCells;
    for (let j = 0; j < nc; j++) {
      const p = g.cp[j];
      out[o + j] = p;
      out[o + nc + j] = p / (g.rho[j] * R_GAS);
      out[o + 2 * nc + j] = g.cu[j];
      out[o + 3 * nc + j] = g.cY[j];
    }
    o += 4 * nc;
    if (withTraces) out.set(this.trace.subarray(0, n * TRACE_BINS), o);
  }
}

export { CP, T_ATM };
