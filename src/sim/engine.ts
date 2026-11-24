// The engine model: cylinders (0D), crank dynamics, valve flow coupling to the
// 1D gas network, and the radiated-sound output. One step() per audio sample.

import { B_CRIT, CP, CV, G1, GasNetwork, PSI_STAR, P_ATM, RHO_ATM, R_GAS, T_ATM } from './gas';
import { CAM_EXPONENTS, DEG, ValveEvents, valveEvents } from './kinematics';
import { LAYOUT_KINDS, ResolvedLayout, resolveLayout } from './layouts';
import { HIDDEN_DEFAULTS, PARAM_DEFS, Params } from './params';
import { C, FLAG_IGNITION, FLAG_LIMITER, FLAG_PAUSED, FLAG_STARTER, H, SNAP_CELL_FIELDS, SNAP_CYL_STRIDE, SNAP_HEADER, TRACE_BINS } from './snapshot';
import { FILTER_RES, FINE_ABOVE, SHARP_ENTRY, Topology, VOL_CYL0, VOL_PLENUM, buildTopology } from './topology';
import { CIRCUIT } from './track';
import { BLADES, Boost } from './boost';
import { MechNoise } from './mech';
import { Scene, Tap, buildScene } from './acoustics';
import { Placement, place } from './placement';
import { Vehicle } from './vehicle';

const RAD2DEG = 180 / Math.PI;
const LHV = 44e6;
const AFR_STOICH = 14.7;
/** Fraction of fuel energy released as heat in the constant-gamma gas (see README). */
const COMB_EFF = 0.75;
/** With temperature-dependent specific heat only real combustion inefficiency is left. */
const COMB_EFF_REAL = 0.9;
const T_WALL_CYL = 450;
const REED_W2 = (2 * Math.PI * 180) ** 2;
const REED_2ZW = 2 * 0.35 * 2 * Math.PI * 180;
const C_SOUND = 343;
/** Sound sources: up to 12 pipe outlets, then the intake mouth and the engine block. */
const N_SRC = 14, SRC_INTAKE = 12, SRC_ENGINE = 13, TAPS = 8;
/** Fraction of an unburned charge's heating value released when it burns in the exhaust. */
const AFTERFIRE_EFF = 0.4;
/** Constants set against the K24 recordings (see scripts/compare.ts). */
export const TUNE = {
  /** RMS flicker of valve flow area from jet turbulence. */
  valve: 0.02,
  /** Scale on Lighthill jet-noise pressure: the free-jet constant is about 10 dB too loud for a tailpipe. */
  jet: 0.3,
  /** Cycle-to-cycle scatter of heat release and burn duration at zero residual, and the cylinder-to-cylinder spread. */
  cycHeat: 0.02,
  cycBurn: 0.03,
  cylHeat: 0.05,
};
/** Fixed pattern of cylinder offsets, zero mean over any four neighbours. */
const CYL_BIAS = [0.9, -1.1, 0.4, -0.2, -0.8, 1.0, -0.5, 0.3, 0.7, -0.9, 0.2, -0.6];
/** Lighthill jet noise, folded into the monopole source: 4 pi * 3e-5 * (4/pi) * rho0 c0 / c0^5. */
const JET_K = (4 * Math.PI * 3e-5 * (4 / Math.PI) * RHO_ATM * C_SOUND) / C_SOUND ** 5;
/** Pascals at the listener that map to full scale before the soft clipper. */
const P_REF = 10;

const STRUCTURAL = ['airbox', 'boost', 'rearSplit', 'catalyst', 'mufflerType', 'strokes', 'chamberSilencer', 'layout', 'cylinders', 'crank', 'firingOrder', 'bankAngle', 'collector', 'cellBudget'];
const GEOMETRY = [
  'airboxVolume', 'snorkelLength', 'snorkelDiameter', 'intakePipeRatio', 'runnerTaper', 'chargeVolume',
  'headerSpread', 'bore', 'stroke', 'rodLength', 'compression', 'throttleBody', 'intakeLength', 'runnerLength', 'runnerDiameter',
  'plenumVolume', 'chamberDiameter', 'crankcaseCR', 'exhaustPortOpen', 'transferPortOpen', 'headerLength', 'headerDiameter', 'midLength', 'mufflerVolume', 'tailLength', 'tailDiameter',
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
  private turbLp = new Float64Array(24); private jetLp = new Float64Array(24); private jetA = 0.27; private seedT = 55555;
  private srcCell = new Int32Array(12); private srcArea = new Float64Array(12);
  private splMs = 0; private splA = 1e-4;
  /** Structure-borne noise from simulated forces. */
  readonly mech = new MechNoise();
  readonly boost = new Boost();
  // compressor tone on its way out: mouth area, filter loss, and the airbox as an expansion chamber
  private whineArea = 0; private whineFilter = 1; private whineBox = 0; private whineBoxLen = 0;
  private surgeLp = 0;
  private bovPrev = 0; private bovLp = 0; private bovJet = 0; private bovJet2 = 0; private whinePhase = 0;
  /** The car the engine drives in driving mode. */
  readonly car = new Vehicle(CIRCUIT);
  private clutchCap = 400; private wasDriving = false;
  private bpSqueal = new Biquad(); private windLp = 0; private rumbleLp = 0; private sqEnv = 0; private seedCar = 987654321;
  lastCar = 0;
  /** Variable valvetrain: phaser advance (crank deg), lock request, per-cylinder lobe in use. */
  vtcAdv = 0; vtecOn = false;
  private hiIn = new Uint8Array(12).fill(1); private hiEx = new Uint8Array(12).fill(1);
  /** Two-stroke state: cycle length, port edges (piston travel), port widths, crankcase. */
  two = false; private cyc = 720;
  private camShape = -1; private camTab = new Float64Array(514);
  private xEoLow = 0; private xIo = 0; private wInd = 0; private reedW2 = REED_W2; private reed2ZW = REED_2ZW;
  private xEo = 0; private xTo = 0; private wEx = 0; private wTr = 0; private aTr = 1; private vccMin = 1e-4;
  private reedX = new Float64Array(12); private reedV = new Float64Array(12);
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
  private spkCyl = new Float64Array(1);
  readonly liftIn = new Float64Array(12);
  readonly liftEx = new Float64Array(12);
  readonly flash = new Float64Array(12);
  /** Brightest moment of each cylinder's burn since the last snapshot, so a slow display cannot miss it. */
  private flashPeak = new Float64Array(12);
  private flashGain = new Float64Array(12);
  private qFull = 1;
  private veCyl = new Float64Array(12);
  private trace = new Float32Array(12 * TRACE_BINS);
  private traceBin = new Int32Array(12);

  // running state
  private stepCount = 0;
  private idleW = 1; private idleErr = 0;
  private thrSm = 0; private thrA = 0.002;
  private iac = 1;
  private dynoInt = 0;
  /** Torque the dynamometer is absorbing, N m (0 when it is off). */
  dynoTorque = 0;
  private iacBase = 0.008;
  /** Throttle bore area over the area of the pipe it sits in. */
  private tbRatio = 1;
  private throttlePhi = 0.01;
  limiterCut = false;
  fuelCutOn = false;
  private airFlush = 0;
  /** Overrun settings act while true; time left after lift-off; armed again once the throttle reopens. */
  overrunOn = false;
  private overrunLeft = 0; private overrunArmed = true; private overrunSeed = 987654321;
  starterOn = false;
  private meanPistonSpeed = 0;
  private torqueAcc = 0; private mapAcc = 0; private angAcc = 0; private timeAcc = 0;
  brakeTorque = 0; power = 0; ve = 0; map = P_ATM; instTorque = 0; rpmAvg = 0; mdotAir = 0;

  // audio
  private mInPrev = 0;
  private lpIn = 0; private lpA = 0.7;
  private delayPos = 0;
  // one monopole per radiating pipe end
  private srcPrev = new Float64Array(12); private srcLp = new Float64Array(12);
  // Paths to the microphone: TAPS slots per source (12 outlets, the intake mouth, the engine).
  private tapGain = new Float64Array(N_SRC * TAPS); private tapCur = new Float64Array(N_SRC * TAPS);
  private tapDelay = new Int32Array(N_SRC * TAPS).fill(1); private tapA = new Float64Array(N_SRC * TAPS).fill(1);
  private tapFloor = new Float64Array(N_SRC * TAPS); private tapDiffuse = new Uint8Array(N_SRC * TAPS); private tapLp = new Float64Array(N_SRC * TAPS);
  private tapList = new Int32Array(N_SRC * TAPS); private tapCount = 0;
  private tapSlew = 0.005;
  // the space the microphone is in, when it is inside the car: three echoes per sound group
  private revBuf = new Float32Array(9 * 2048); private revPos = 0; private revOn = false;
  private revLen = new Int32Array(3).fill(100); private revFb = new Float64Array(3); private revNorm = new Float64Array(3);
  private roadGain = 1; private roadA = 1; private roadFloor = 0; private roadLp = 0;
  /** Source positions and car body for the current parameters. */
  placement: Placement | null = null;
  scene: Scene | null = null;
  /** Hottest header wall, K (for display). */
  headerWallT = 650;
  private srcBuf = new Float32Array(N_SRC * 4096);
  private hpX = 0; private hpY = 0; private hpR = 0.998;
  private fadeGain = 0; private fadeTarget = 1; private fadeStep = 1e-3;
  private pendingStructural = false;
  private bpComb = new Biquad(); private bpTick = new Biquad();
  private tickEnv = 0; private tickTgt = 0; private tickAtt = 0.05; private tickDecay = 0.99; private seed = 12345;
  private sumPcyl = 0;
  peakOut = 0;
  private stepDeg = 0;
  /** Unclipped component pressures at the listener (Pa), last sample. */
  lastEx = 0; lastIn = 0; lastMech = 0;
  /** The mixed sound before the slow-motion fade and the rumble filter, for the waveform display. */
  lastMonitor = 0;

  constructor(sampleRate: number, params: Params) {
    this.sampleRate = sampleRate;
    this.dt = 1 / sampleRate;
    this.target = { ...HIDDEN_DEFAULTS, ...params };
    this.cur = { ...this.target };
    this.lpA = 1 - Math.exp((-2 * Math.PI * 9000) / sampleRate);
    this.hpR = 1 - (2 * Math.PI * 12) / sampleRate;
    this.fadeStep = 1 / (0.02 * sampleRate);
    this.thrA = 1 - Math.exp(-1 / (0.02 * sampleRate));
    this.tickDecay = Math.exp(-1 / (0.0012 * sampleRate));
    this.bpComb.bandpass(1700, 0.7, sampleRate);
    this.bpTick.bandpass(2800, 1.2, sampleRate);
    this.tickAtt = 1 - Math.exp(-1 / (0.0004 * sampleRate));
    this.bpSqueal.bandpass(1050, 7, sampleRate);
    this.splA = 1 - Math.exp(-1 / (0.25 * sampleRate));
    this.jetA = 1 - Math.exp((-2 * Math.PI * 2400) / sampleRate);
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
    return resolveLayout(LAYOUT_KINDS[p.layout | 0] ?? 'inline', p.cylinders | 0, p.bankAngle, p.crank | 0, p.firingOrder | 0, p.strokes > 0.5);
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
    this.qFull = (LHV * RHO_ATM * Vd) / AFR_STOICH;
    this.ev = valveEvents(p.intakeDuration, p.exhaustDuration, p.lsa, p.camAdvance);
    // Valve count and size, clamped to what fits in the bore.
    const vpc = p.valvesPerCyl | 0;
    const nIn = vpc === 0 ? 1 : vpc === 1 ? 2 : 3, nEx = vpc === 0 ? 1 : 2;
    const dIn = Math.min(p.intakeValveSize * 0.01, nIn === 1 ? 0.52 : nIn === 2 ? 0.4 : 0.33) * this.bore;
    const dEx = Math.min(p.exhaustValveSize * 0.01, nEx === 1 ? 0.45 : 0.34) * this.bore;
    this.kCurtIn = 0.7 * nIn * Math.PI * dIn;
    this.kCurtEx = 0.7 * nEx * Math.PI * dEx;
    this.portIn = 0.9 * nIn * 0.25 * Math.PI * dIn * dIn;
    this.portEx = 0.9 * nEx * 0.25 * Math.PI * dEx * dEx;
    if ((p.camProfile | 0) !== this.camShape) {
      this.camShape = p.camProfile | 0;
      const e = CAM_EXPONENTS[this.camShape] ?? 2;
      for (let i = 0; i <= 512; i++) this.camTab[i] = Math.pow(1 - (i / 512) ** 2, e);
      this.camTab[513] = 0;
    }
    this.aRun = 0.25 * Math.PI * (p.runnerDiameter * 1e-3) ** 2;
    this.aHead = 0.25 * Math.PI * (p.headerDiameter * 1e-3) ** 2;
    const two = (this.two = p.strokes > 0.5);
    const cyc = (this.cyc = two ? 360 : 720);
    this.sparkAngle = (((cyc - p.ignitionAdvance) % cyc) + cyc) % cyc;
    this.ivcAngle = two ? 360 - p.exhaustPortOpen : mod720(this.ev.ivc);
    if (two) {
      const travel = (deg: number) => {
        const a = deg * DEG, sn = Math.sin(a);
        return this.r + this.l - (this.r * Math.cos(a) + Math.sqrt(this.l * this.l - this.r * this.r * sn * sn));
      };
      // Ports are windows in the liner; the piston crown uncovers them on the way down.
      this.xEo = travel(p.exhaustPortOpen);
      this.xTo = travel(Math.max(p.transferPortOpen, p.exhaustPortOpen + 2));
      this.xEoLow = travel(p.exhaustPortOpen + 8);
      this.wEx = 0.8 * p.exhaustPortWidth * 0.01 * this.bore;
      this.wTr = 0.75 * p.transferPortWidth * 0.01 * this.bore;
      this.xIo = travel(p.inductionDuration / 2);
      this.wInd = 0.8 * 0.6 * this.bore;
      const w = 2 * Math.PI * p.reedStiffness;
      this.reedW2 = w * w;
      this.reed2ZW = 2 * 0.35 * w;
      this.aTr = 0.25 * Math.PI * (0.5 * this.bore) ** 2;
      this.vccMin = Vd / (p.crankcaseCR - 1);
    }
    const litres = this.VdTot * 1e3;
    this.inertia = p.flywheel + 0.015 * litres;
    this.loadK = ((p.load / 100) * 100 * litres) / (314.16 * 314.16);
    this.starterT0 = 80 * litres + 0.9 * p.compression * P_ATM * this.Ap * this.r;
    this.clutchCap = 260 * litres + 60;
    // steel valve: head disc, stem, and a share of spring and retainer
    const valveMass = (d: number) => 7800 * 0.25 * Math.PI * (d * d * 0.004 + (0.16 * d) ** 2 * 2.8 * d) * 1.3;
    this.mech.configure({
      cylinders: n, bore: this.bore, displacement: this.VdTot, clearance: p.pistonClearance * 1e-6, pistonMass: 0.75 * 650 * this.bore ** 3,
      lash: p.valveLash, valveMassIn: nIn * valveMass(dIn), valveMassEx: nEx * valveMass(dEx), drive: two ? -1 : p.timingDrive | 0, injectors: !two,
      gains: { gas: p.mechGas / 100, slap: p.mechSlap / 100, valve: p.mechValve / 100, injector: p.mechInjector / 100, drive: p.mechDrive / 100, rough: p.mechRough / 100, turbo: p.mechTurbo },
      damping: p.mechDamping / 100, tilt: p.mechTilt, rampRate: p.mechRamp, driveSpread: p.mechDriveSpread / 100, oilFilm: p.mechOil / 100,
    });
    this.boost.configure({
      kind: two ? 0 : p.boost | 0, wheel: p.turboSize * 1e-3, target: p.boostTarget * 1e3, intercooler: p.intercooler / 100, bov: p.bov | 0, bovSprung: p.fxBov > 0.5,
      crankMax: (p.revLimit * Math.PI) / 30,
    });
    {
      const box = !two && p.airbox > 0.5;
      const dMouth = (box ? p.snorkelDiameter : p.throttleBody * (p.intakePipeRatio / 100)) * 1e-3;
      this.whineArea = 0.25 * Math.PI * dMouth * dMouth;
      // loss of a wave at several kilohertz crossing the element, dB: none, paper, gauze, foam, clogged paper
      this.whineFilter = Math.pow(10, -([0, 6, 3, 5, 10][p.airFilter | 0] ?? 0) / 20);
      const side = Math.cbrt(p.airboxVolume * 1e-3);
      const m = box ? (side * side) / this.whineArea : 1;
      this.whineBox = box ? 0.25 * (m - 1 / m) ** 2 : 0;
      this.whineBoxLen = side;
    }
    // Feed-forward idle air: roughly what the engine needs at ~35 kPa manifold pressure.
    const aTb = 0.25 * Math.PI * (p.throttleBody * 1e-3) ** 2;
    this.tbRatio = two ? 1 : Math.min(1, 1 / ((p.boost | 0) > 0 ? 1 : (p.intakePipeRatio / 100) ** 2));
    this.iacBase = ((0.35 * RHO_ATM * this.VdTot * (p.idleRpm / (two ? 60 : 120)) * 0.85) / (0.88 * aTb * (two ? n : 1) * 234)) * (two ? 1.1 : 0.45);
    if (!two) {
      // A late-closing intake pushes charge back out at idle speed, so it needs more idle air.
      const durIdle = p.vtec > 0.5 ? Math.min(p.lowIntakeDuration, p.intakeDuration) : p.intakeDuration;
      const trapped = (ivcDeg: number) => {
        const a = ivcDeg * DEG, sn = Math.sin(a);
        return this.Vc + this.Ap * (this.r + this.l - (this.r * Math.cos(a) + Math.sqrt(this.l * this.l - this.r * this.r * sn * sn)));
      };
      const k = trapped(593) / trapped(Math.min(700, Math.max(540, this.ev.intakeCentre + durIdle / 2)));
      this.iacBase *= k * k;
    }
    this.placeSources();
  }

  /** Work out every path from each source to the microphone for the current geometry. */
  private placeSources(): void {
    if (!this.topo) return;
    const pl = (this.placement = place(this.cur, this.layout, this.topo));
    const sc = (this.scene = buildScene(this.cur, pl));
    this.tapGain.fill(0);
    const put = (src: number, taps: Tap[]) => {
      // strongest first, so anything dropped for lack of slots is the least audible
      const sorted = taps.filter((t) => t.gain > 0).sort((a, b) => b.gain - a.gain).slice(0, TAPS);
      sorted.forEach((t, j) => {
        const o = src * TAPS + j;
        this.tapGain[o] = t.gain;
        this.tapDelay[o] = Math.max(1, Math.min(4000, Math.round(t.delay * this.sampleRate)));
        this.tapA[o] = t.fc > 0 ? 1 - Math.exp((-2 * Math.PI * t.fc) / this.sampleRate) : 1;
        this.tapFloor[o] = t.floor;
        this.tapDiffuse[o] = t.diffuse ? 1 : 0;
      });
    };
    sc.outlets.forEach((t, i) => i < 12 && put(i, t));
    put(SRC_INTAKE, sc.intake);
    put(SRC_ENGINE, sc.engine);
    this.tapCount = 0;
    for (let o = 0; o < N_SRC * TAPS; o++) if (this.tapGain[o] !== 0 || this.tapCur[o] !== 0) this.tapList[this.tapCount++] = o;
    this.roadGain = sc.road.gain;
    this.roadA = sc.road.fc > 0 ? 1 - Math.exp((-2 * Math.PI * sc.road.fc) / this.sampleRate) : 1;
    this.roadFloor = sc.road.floor;
    const on = sc.t60 > 0;
    if (on && !this.revOn) this.revBuf.fill(0);
    this.revOn = on;
    if (on) {
      // echoes a few body lengths apart, each fading by 60 dB in the space's decay time
      [1.9, 2.7, 3.7].forEach((k, c) => {
        const d = (k * sc.size) / C_SOUND;
        this.revLen[c] = Math.max(8, Math.min(2040, Math.round(d * this.sampleRate)));
        this.revFb[c] = Math.pow(10, (-3 * d) / sc.t60);
        this.revNorm[c] = Math.sqrt((1 - this.revFb[c] * this.revFb[c]) / 3);
      });
    }
  }

  private cylVolumeAt(i: number): number {
    const a = mod720(this.theta - this.fire[i]) * DEG;
    const sn = Math.sin(a);
    return this.Vc + this.Ap * (this.r + this.l - (this.r * Math.cos(a) + Math.sqrt(this.l * this.l - this.r * this.r * sn * sn)));
  }

  private ccVolumeAt(i: number): number {
    return this.vccMin + this.Ap * 2 * this.r - (this.cylVolumeAt(i) - this.Vc);
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
      this.spkCyl = new Float64Array(n).fill(700);
      this.fire = new Float64Array(n);
      this.trace.fill(P_ATM);
    }
    this.n = n;
    for (let i = 0; i < n; i++) this.fire[i] = this.layout.fire[i];
    this.derive();
    const topo = buildTopology(this.cur, this.layout, this.dt);
    const gas = new GasNetwork(
      topo.volumes.map((v) => ({ volume: v.volume, fixed: v.kind === 'ambient' })),
      topo.pipes.map((q) => ({ length: q.length, diameter: q.diameter, profile: q.profile, cells: q.cells, volL: q.volL, volR: q.volR, wallT: q.wallT })),
    );
    if (old && oldTopo && oldTopo.signature === topo.signature) {
      for (let v = 1; v < gas.nv; v++) gas.setVolumeState(v, old.vp[v], old.vT[v], old.vY[v]);
      for (let k = 0; k < gas.np; k++) {
        gas.pTw[k] = old.pTw[k];
        // carry the end flows over so the radiated-sound derivative sees no step
        gas.pMdotL[k] = old.pMdotL[k];
        gas.pMdotR[k] = old.pMdotR[k];
        gas.pRadUL[k] = old.pRadUL[k];
        gas.pRadUR[k] = old.pRadUR[k];
      }
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
      this.mech.reset();
      this.boost.reset();
      this.mInPrev = 0;
      this.lpIn = 0;
      this.srcPrev.fill(0);
      this.srcLp.fill(0);
    }
    this.gas = gas;
    this.topo = topo;
    this.applyRadiation();
    this.applyResistance();
    this.topoId++;
    for (let i = 0; i < n; i++) {
      this.rescaleVolume(VOL_CYL0 + i, this.cylVolumeAt(i));
      if (topo.twoStroke) this.rescaleVolume(topo.crankcase[i], this.ccVolumeAt(i));
      this.aPrev[i] = mod720(this.theta - this.fire[i]) % this.cyc;
      this.traceBin[i] = Math.floor(this.aPrev[i]) % TRACE_BINS;
    }
    this.radPipes = [];
    topo.pipes.forEach((q, k) => q.radiates && this.radPipes.push(k));
    this.radPipes.forEach((k, i) => {
      if (i >= 12) return;
      this.srcCell[i] = gas.pOff[k] + gas.pN[k] - 1;
      this.srcArea[i] = 0.25 * Math.PI * topo.pipes[k].diameter ** 2;
    });
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
    for (let k = 0; k < topo.pipes.length; k++) g.setPipeGeometry(k, topo.pipes[k].length, topo.pipes[k].diameter, topo.pipes[k].profile);
    for (let v = 1; v < topo.volumes.length; v++) {
      if (topo.volumes[v].kind !== 'cylinder' && topo.volumes[v].kind !== 'crankcase') this.rescaleVolume(v, topo.volumes[v].volume);
    }
    for (let i = 0; i < this.n; i++) {
      this.rescaleVolume(VOL_CYL0 + i, this.cylVolumeAt(i));
      if (topo.twoStroke) this.rescaleVolume(topo.crankcase[i], this.ccVolumeAt(i));
    }
    this.topo = topo;
    this.applyRadiation();
    this.applyResistance();
  }

  private applyResistance(): void {
    this.topo.pipes.forEach((q, k) => {
      if (!this.topo.filterPipes.includes(k)) this.gas.pResL[k] = q.resL ?? 0;
      this.gas.pResR[k] = q.resR ?? 0;
    });
  }

  /** Open ends to the atmosphere radiate; ends into volumes do not. */
  private applyRadiation(): void {
    const on = (this.cur.fxEnds | 0) === 2;
    const vols = this.topo.volumes;
    this.topo.pipes.forEach((q, k) => this.gas.setRadiation(k, on && vols[q.volL].kind === 'ambient', on && vols[q.volR].kind === 'ambient'));
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
        if (k === 'fxEnds') geom = true;
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

    this.updateWalls(cur.paused ? 0 : blockSamples * this.dt * cur.timeScale);
    const driving = cur.drive > 0.5;
    if (driving && !this.wasDriving) this.car.reset(true);
    this.wasDriving = driving;

    const ts = cur.timeScale;
    const audible = ts >= 0.999 ? 1 : Math.min(1, Math.max(0, (ts - 0.08) / 0.2));
    this.fadeTarget = this.pendingStructural || cur.paused ? 0 : audible;
    this.starterOn = cur.starter > 0.5 || this.autoStart;
    if (!Number.isFinite(this.omega) || !Number.isFinite(this.gas.maxRate) || !Number.isFinite(this.gas.vp[VOL_PLENUM]) || !Number.isFinite(this.hpY)) this.recover();
  }

  /** Lumped wall thermal model per pipe, and the afterfire switches. Once per block. */
  private updateWalls(dt: number): void {
    const g = this.gas, cur = this.cur;
    const thermal = cur.fxWalls > 0.5;
    const lam = cur.afr / AFR_STOICH;
    // Charge that burns in the pipe is poorly mixed and partly leaves before it burns.
    // after a fuel cut the pipes hold plain air for a moment: nothing there to burn
    if (this.fuelCutOn) this.airFlush = 0.4; else if (this.airFlush > 0) this.airFlush -= dt;
    g.reactQ = cur.fxAfterfire > 0.5 && this.airFlush <= 0 && lam > 0.6 && lam < 1.6 ? (LHV / AFR_STOICH) * Math.min(1, 1 / lam) * AFTERFIRE_EFF : 0;
    const cast = cur.manifold > 0.5;
    let hot = 0;
    for (let k = 0; k < g.np; k++) {
      const q = this.topo.pipes[k];
      const exhaust = q.kind === 'header' || q.kind === 'mid' || q.kind === 'tail';
      g.pReact[k] = exhaust ? 1 : 0;
      g.pFr[k] = cast && q.kind === 'header' ? 0.045 : 0.02;
      if (!thermal) {
        g.pTw[k] = q.wallT;
      } else if (dt > 0) {
        // Steel tube 1.5 mm for the exhaust, 3 mm aluminium for the intake.
        const wall = cast && q.kind === 'header' ? 7200 * 500 * 0.006 : exhaust ? 7800 * 480 * 0.0015 : 2700 * 900 * 0.003;
        const areaOut = Math.PI * q.diameter * q.length;
        const Tw = g.pTw[k];
        const Ta = exhaust ? 320 : 310;
        const loss = ((exhaust ? 30 : 15) * (Tw - Ta) + (exhaust ? 0.7 : 0.3) * 5.67e-8 * (Tw * Tw * Tw * Tw - Ta * Ta * Ta * Ta)) * areaOut * dt;
        let next = Tw + (g.pQw[k] - loss) / (wall * areaOut);
        if (next < 280) next = 280; else if (next > 1400) next = 1400;
        g.pTw[k] = next;
      }
      g.pQw[k] = 0;
      if (q.kind === 'header' && g.pTw[k] > hot) hot = g.pTw[k];
    }
    this.headerWallT = hot;
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
    this.bpTick.bandpass(2800, 1.2, this.sampleRate);
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
        this.mInPrev = this.intakeFlow();
      }
      return 0;
    }
    const ts = cur.timeScale;
    const nsub = this.nsub;
    const dt = (this.dt * ts) / nsub;
    for (let s = 0; s < nsub; s++) this.substep(dt);
    const cfl = this.gas.maxRate * this.dt * ts * 1.15;
    // extra-fine cells are sized for two steps per sample: holding them to that keeps still gas from ringing
    const least = cur.cellBudget > 1.5 * FINE_ABOVE ? 3 : cur.cellBudget > FINE_ABOVE ? 2 : 1;
    this.nsub = cfl > 0.9 ? Math.min(8, Math.max(least, Math.ceil(cfl / 0.9))) : least;
    return this.audio(dt * nsub, ts);
  }

  private intakeFlow(): number {
    const ip = this.topo.intakePipes;
    let m = 0;
    for (let i = 0; i < ip.length; i++) m += this.gas.pMdotL[ip[i]];
    return m;
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
    // Overrun fuel cut, as an injection ECU does: no fuel with the throttle shut above idle,
    // instead of a starved charge that fires now and then.
    if (cur.fuelCut > 0.5 && !this.two && this.thrSm < 0.02 && !this.starterOn) {
      if (rpm > cur.idleRpm + 700) this.fuelCutOn = true;
      else if (rpm < cur.idleRpm + 350) this.fuelCutOn = false;
    } else this.fuelCutOn = false;
    // Overrun spark cut, retard and air act for a while after lift-off, above a set speed.
    if (this.thrSm > 0.05) this.overrunArmed = true;
    else if (this.thrSm < 0.02 && this.overrunArmed) { this.overrunArmed = false; this.overrunLeft = cur.overrunTime; }
    if (this.overrunLeft > 0) this.overrunLeft -= dt;
    this.overrunOn = !this.two && !this.starterOn && this.thrSm < 0.02 && this.overrunLeft > 0 && rpm > cur.overrunRpm;
    const fuelOk = !this.fuelCutOn;

    const hUpdate = (this.stepCount & 7) === 0;
    // Idle spark control: hold some advance in reserve and trade it for torque, as an ECU does.
    let spkA = this.sparkAngle;
    if (this.idleW > 0) {
      let trim = 45 * this.idleErr;
      if (trim > 12) trim = 12; else if (trim < -12) trim = -12;
      spkA -= this.idleW * (trim - 8);
      if (spkA >= this.cyc) spkA -= this.cyc; else if (spkA < 0) spkA += this.cyc;
    }
    if (this.overrunOn && cur.overrunRetard > 0) {
      spkA += cur.overrunRetard;
      if (spkA >= this.cyc) spkA -= this.cyc;
    }
    // Intake cam phaser: an ECU map of speed and manifold pressure, slewed at an oil-limited rate.
    if (cur.vtc > 0.5 && !this.two) {
      const fr = rpm < 1000 ? 0 : rpm < 2200 ? (rpm - 1000) / 1200 : rpm < 3800 ? 1 : rpm < 5500 ? 1 - 0.4 * ((rpm - 3800) / 1700) : 0.6;
      let fl = (g.vp[VOL_PLENUM] - 40e3) / 40e3;
      if (fl < 0) fl = 0; else if (fl > 1) fl = 1;
      const want = cur.vtcRange * fr * (0.15 + 0.85 * fl);
      const maxStep = 150 * dt;
      const d = want - this.vtcAdv;
      this.vtcAdv += d > maxStep ? maxStep : d < -maxStep ? -maxStep : d;
    } else this.vtcAdv = 0;
    const vtec = this.two ? 0 : cur.vtec | 0;
    if (vtec > 0) {
      if (rpm > cur.vtecRpm) this.vtecOn = true;
      else if (rpm < cur.vtecRpm - 300) this.vtecOn = false;
    } else this.vtecOn = false;
    const wantIn = vtec === 0 || this.vtecOn ? 1 : 0, wantEx = vtec !== 1 || this.vtecOn ? 1 : 0;
    const ci = this.ev.intakeCentre - this.vtcAdv, ce = this.ev.exhaustCentre;
    const durIH = cur.intakeDuration, durEH = cur.exhaustDuration;
    const durIL = cur.lowIntakeDuration < durIH ? cur.lowIntakeDuration : durIH, durEL = cur.lowExhaustDuration < durEH ? cur.lowExhaustDuration : durEH;
    const LIH = cur.intakeLift * 1e-3, LEH = cur.exhaustLift * 1e-3;
    const LIL = cur.lowIntakeLift * 1e-3, LEL = cur.lowExhaustLift * 1e-3;
    let ivcA = ci + 0.5 * (wantIn ? durIH : durIL);
    if (ivcA >= 720) ivcA -= 720;
    if (this.two) ivcA = this.ivcAngle;
    const topo = this.topo;
    let torque = 0;
    let sumP = 0;
    const camTab = this.camTab;
    const two = this.two;
    // Power valve: the port's top edge sits lower until the engine is revving.
    let xEo = this.xEo;
    if (two && cur.powerValve > 0.5) { const w = rpm < 5500 ? 1 : rpm > 7500 ? 0 : (7500 - rpm) / 2000; xEo += w * (this.xEoLow - xEo); }
    const induction = cur.induction | 0;
    const bdcMark = two ? 180 : 540;
    const gasVar = cur.fxGas > 0.5;
    const blowby = cur.fxBlowby > 0.5 ? 2e-7 * (this.bore / 0.086) : 0;
    const mRec = cur.fxInertia > 0.5 ? 650 * this.bore * this.bore * this.bore : 0;
    let jRec = 0, cRec = 0;
    const mechOn = (cur.fxMech | 0) === 2;
    const mech = this.mech;
    const mSlide = 650 * this.bore * this.bore * this.bore;
    const camRate = 0.5 * this.omega * RAD2DEG;
    const turb = cur.fxTurb > 0.5 ? TUNE.valve * 4.1 : 0;
    const tl = this.turbLp;

    for (let i = 0; i < n; i++) {
      let a = th - this.fire[i];
      if (a < 0) a += 720;
      if (two && a >= 360) a -= 360;
      const ar = a * DEG;
      const sn = Math.sin(ar), cs = Math.cos(ar);
      const root = Math.sqrt(l * l - r * r * sn * sn);
      const x = r + l - (r * cs + root);
      const V = Vc + Ap * x;
      const dVdth = Ap * r * sn * (1 + (r * cs) / root);
      const v = VOL_CYL0 + i;
      const V0 = g.vV[v];
      let m = g.vm[v];
      const T0 = g.vE[v] / (m * CV);
      // Specific heat: constant, or rising with temperature. 650 + 0.2 T gives 710 J/kg K at 300 K,
      // 850 at 1000 K (air) and 1150 at 2500 K (burned gas with dissociation): gamma 1.40 down to 1.25.
      const cv = gasVar ? 650 + 0.2 * (T0 < 3500 ? T0 : 3500) : CV;
      const k = (0.5 * R_GAS * (V - V0)) / cv;
      let T = (T0 * (1 - k / V0)) / (1 + k / V);
      const ap = this.aPrev[i];

      // Latch this cylinder's spark angle at BDC so a moving setpoint can never skip a spark.
      if (crossed(ap, a, bdcMark)) this.spkCyl[i] = spkA;
      // port injection onto the closed intake valve, late in the exhaust stroke
      if (mechOn && fuelOk && dth > 0 && crossed(ap, a, 300)) mech.injector(i, 0.0015 + (0.009 * this.map) / P_ATM);
      let fire = dth > 0 && crossed(ap, a, this.spkCyl[i]) && sparkOk && fuelOk && !this.burning[i];
      if (fire && this.overrunOn && cur.overrunCut > 0) {
        this.overrunSeed = (Math.imul(this.overrunSeed, 1664525) + 1013904223) | 0;
        if ((this.overrunSeed >>> 8) < cur.overrunCut * 0.01 * 16777216) fire = false;
      }
      if (fire) {
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
          this.qTot[i] = ((LHV * fresh) / AFR_STOICH) * Math.min(1, 1 / lam) * (gasVar ? COMB_EFF_REAL : COMB_EFF) * fl;
          this.burnDur[i] = cur.burnDuration * (1 + 2.2 * (lam - 0.9) * (lam - 0.9) + 1.2 * resid);
          if (cur.fxVar > 0.5) {
            // Cycle-to-cycle scatter grows with residual gas; each cylinder also has a fixed offset.
            const amp = resid < 0.3 ? 1 + 1.5 * resid : 1.45;
            this.qTot[i] *= 1 + TUNE.cylHeat * CYL_BIAS[i] + TUNE.cycHeat * amp * this.gauss();
            this.burnDur[i] *= 1 + TUNE.cycBurn * amp * this.gauss();
          }
          // a full atmospheric charge burns at brightness 1; idle is dim
          this.flashGain[i] = Math.sqrt(Math.min(1.5, this.qTot[i] / this.qFull));
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
        T += (this.qTot[i] * dxb) / (m * cv);
        g.vmY[v] += (m - g.vmY[v]) * (dxb / (1 - xp + 1e-9));
        this.xbPrev[i] = xb;
        if (xr >= 1) this.burning[i] = 0;
        const rate = dth > 0 ? (dxb / dth) * this.burnDur[i] : 0;
        // the Wiebe burn rate peaks at about 2 in these units
        const lit = (rate > 2 ? 1 : 0.5 * rate) * this.flashGain[i];
        if (lit > flash) flash = lit;
      }
      this.flash[i] = flash;
      if (flash > this.flashPeak[i]) this.flashPeak[i] = flash;

      // Wall heat loss (Hohenberg correlation, coefficient refreshed every 8 steps).
      if (hUpdate) {
        const p0 = (m * R_GAS * T) / V;
        this.hCoef[i] = 130 * Math.pow(V, -0.06) * Math.pow(p0 * 1e-5, 0.8) * Math.pow(T, -0.4) * Math.pow(this.meanPistonSpeed + 1.4, 0.8);
      }
      let dQ = this.hCoef[i] * (2 * Ap + Math.PI * this.bore * x) * (T - T_WALL_CYL) * dt;
      let dT = dQ / (m * cv);
      if (dT > 0.2 * T) dT = 0.2 * T;
      T -= dT;

      // Ring blow-by: a small orifice from the cylinder to the crankcase.
      if (blowby > 0) {
        const pc = (m * R_GAS * T) / V;
        if (pc > P_ATM) {
          const rr = P_ATM / pc;
          let ef = 1;
          if (rr > B_CRIT) { const xr = (rr - B_CRIT) / (1 - B_CRIT); ef = Math.sqrt(1 - xr * xr); }
          let dm = ((blowby * pc * PSI_STAR) / Math.sqrt(R_GAS * T)) * ef * dt;
          if (dm > 0.05 * m) dm = 0.05 * m;
          if (two) {
            const vc = topo.crankcase[i];
            g.vm[vc] += dm;
            g.vE[vc] += dm * CP * T;
            g.vmY[vc] += (dm * g.vmY[v]) / m;
          }
          g.vmY[v] *= 1 - dm / m;
          m -= dm;
          g.vm[v] = m;
        }
      }

      g.vE[v] = m * CV * T;
      g.vV[v] = V;
      g.refreshVolume(v);
      const p = g.vp[v];
      let pUnder = P_ATM;
      if (two) {
        // Crankcase: the underside of the piston is the scavenge pump.
        const vc = topo.crankcase[i];
        const Vn = this.vccMin + Ap * (2 * r - x);
        const Vo = g.vV[vc];
        const kc = 0.5 * G1 * (Vn - Vo);
        g.vE[vc] = (g.vE[vc] * (1 - kc / Vo)) / (1 + kc / Vn);
        g.vV[vc] = Vn;
        g.refreshVolume(vc);
        pUnder = g.vp[vc];
      }
      torque += (p - pUnder) * dVdth;
      if (mRec > 0 || mechOn) {
        // Reciprocating mass: s' and s'' of the piston with respect to crank angle.
        const s1 = -r * sn - (r * r * sn * cs) / root;
        const s2 = -r * cs - (r * r * (cs * cs - sn * sn)) / root - (r * r * r * r * sn * sn * cs * cs) / (root * root * root);
        jRec += mRec * s1 * s1;
        cRec += mRec * s1 * s2;
        // The rod carries gas force plus piston inertia; its angle turns part of that into side thrust.
        if (mechOn) mech.cylinder(i, (p - P_ATM) * Ap, ((p - pUnder) * Ap + mSlide * s2 * this.omega * this.omega) * ((r * sn) / root), dt);
      }
      sumP += p;

      if (two) {
        // Piston-controlled ports: open height is how far the crown is below the port's top edge.
        const he = x > xEo ? x - xEo : 0;
        this.liftEx[i] = he;
        let phi = (this.wEx * he) / this.aHead;
        if (turb > 0 && he > 0) {
          this.seedT = (Math.imul(this.seedT, 1664525) + 1013904223) | 0;
          tl[i] += 0.3 * (this.seedT * 4.6566e-10 - tl[i]);
          phi *= 1 + turb * tl[i];
        }
        g.pPhiL[topo.headerPipe[i]] = phi > 1 ? 1 : phi;
        const ht = x > this.xTo ? x - this.xTo : 0;
        this.liftIn[i] = ht;
        phi = (this.wTr * ht) / this.aTr;
        g.pPhiR[topo.transferPipe[i]] = phi > 1 ? 1 : phi;
        const rk = topo.runnerPipe[i];
        if (induction === 0) {
          // Reed valve: a sprung petal (damping 0.35) pushed open by the pressure across it.
          const dp = g.cp[g.pOff[rk] + g.pN[rk] - 1] - pUnder;
          let rx = this.reedX[i], rv = this.reedV[i];
          rv += (this.reedW2 * (dp / 6000 - rx) - this.reed2ZW * rv) * dt;
          rx += rv * dt;
          if (rx < 0) { rx = 0; if (rv < 0) rv = 0; } else if (rx > 1) { rx = 1; if (rv > 0) rv = 0; }
          this.reedX[i] = rx;
          this.reedV[i] = rv;
          g.pPhiR[rk] = 0.75 * rx;
        } else if (induction === 1) {
          // Piston port: the skirt uncovers the inlet around TDC, symmetrically.
          const hi = x < this.xIo ? this.xIo - x : 0;
          phi = (this.wInd * hi) / this.aRun;
          g.pPhiR[rk] = phi > 0.9 ? 0.9 : phi;
        } else {
          // Rotary disc: open for a fixed window that closes at a chosen angle after TDC.
          let d = cur.inductionClose - a;
          if (d < 0) d += 360;
          const dur = cur.inductionDuration;
          const edge = d < dur ? Math.min(d, dur - d) / 12 : 0;
          g.pPhiR[rk] = 0.9 * (edge > 1 ? 1 : edge);
        }
      } else {
        // Valve lift -> effective orifice area ratio at the pipe ends.
        let d = a - ci;
        if (d > 360) d -= 720; else if (d < -360) d += 720;
        // The lock pin can only move while the high lobe is on its base circle.
        if (this.hiIn[i] !== wantIn && (2 * d >= durIH || 2 * d <= -durIH)) this.hiIn[i] = wantIn;
        let xx = (2 * d) / (this.hiIn[i] ? durIH : durIL);
        let lift = 0;
        if (xx > -1 && xx < 1) { const f = (xx < 0 ? -xx : xx) * 512, i0 = f | 0; lift = (this.hiIn[i] ? LIH : LIL) * (camTab[i0] + (camTab[i0 + 1] - camTab[i0]) * (f - i0)); }
        if (lift === 0 && this.liftIn[i] > 0) this.tick(rpm);
        if (mechOn) mech.valve(i, false, this.liftIn[i], lift, dt, camRate);
        this.liftIn[i] = lift;
        let ac = this.kCurtIn * lift;
        let phi = (ac * this.portIn) / Math.sqrt(ac * ac + this.portIn * this.portIn) / this.aRun;
        // Turbulence in the valve jet: the effective flow area flickers by a few percent.
        if (turb > 0 && lift > 0) {
          this.seedT = (Math.imul(this.seedT, 1664525) + 1013904223) | 0;
          tl[12 + i] += 0.3 * (this.seedT * 4.6566e-10 - tl[12 + i]);
          phi *= 1 + turb * tl[12 + i];
        }
        g.pPhiR[topo.runnerPipe[i]] = phi > 1 ? 1 : phi;

        d = a - ce;
        if (d > 360) d -= 720; else if (d < -360) d += 720;
        if (this.hiEx[i] !== wantEx && (2 * d >= durEH || 2 * d <= -durEH)) this.hiEx[i] = wantEx;
        xx = (2 * d) / (this.hiEx[i] ? durEH : durEL);
        lift = 0;
        if (xx > -1 && xx < 1) { const f = (xx < 0 ? -xx : xx) * 512, i0 = f | 0; lift = (this.hiEx[i] ? LEH : LEL) * (camTab[i0] + (camTab[i0 + 1] - camTab[i0]) * (f - i0)); }
        if (lift === 0 && this.liftEx[i] > 0) this.tick(rpm);
        if (mechOn) mech.valve(i, true, this.liftEx[i], lift, dt, camRate);
        this.liftEx[i] = lift;
        ac = this.kCurtEx * lift;
        phi = (ac * this.portEx) / Math.sqrt(ac * ac + this.portEx * this.portEx) / this.aHead;
        if (turb > 0 && lift > 0) {
          this.seedT = (Math.imul(this.seedT, 1664525) + 1013904223) | 0;
          tl[i] += 0.3 * (this.seedT * 4.6566e-10 - tl[i]);
          phi *= 1 + turb * tl[i];
        }
        g.pPhiL[topo.headerPipe[i]] = phi > 1 ? 1 : phi;
      }

      if (dth > 0 && crossed(ap, a, ivcA)) {
        this.veCyl[i] = (m - g.vmY[v]) / (RHO_ATM * Ap * 2 * r);
      }

      // Pressure trace, one bin per crank degree.
      let bin = a | 0;
      if (bin >= this.cyc) bin = this.cyc - 1;
      let b = this.traceBin[i];
      if (b !== bin) {
        const base = i * TRACE_BINS;
        let guard = 0;
        while (b !== bin && guard++ < 16) {
          b = b + 1 >= this.cyc ? 0 : b + 1;
          this.trace[base + b] = p;
        }
        this.traceBin[i] = bin;
      }
      this.aPrev[i] = a;
    }
    this.sumPcyl = sumP;
    if (mechOn) {
      if (mechOn && this.boost.cfg.kind > 0) mech.turbo(this.boost.shake, this.boost.omega, dt);
      mech.drive(dth, this.omega);
      mech.step(dt);
    }

    // Throttle plate plus idle air valve (integral controller, like a real IAC).
    // Per-sample slew: moving the plate in block-sized steps would ring the intake tract.
    const driving = cur.drive > 0.5;
    const pedal = cur.throttle * 0.01;
    this.thrSm += ((driving && this.car.thrOverride >= 0 ? this.car.thrOverride : pedal) - this.thrSm) * this.thrA;
    const thr = this.thrSm;
    const idleErr = (cur.idleRpm - rpm) / cur.idleRpm;
    // Idle authority fades out smoothly as the pedal opens, so nothing switches abruptly.
    const idleW = thr < 0.05 ? 1 - thr * 20 : 0;
    this.idleW = idleW;
    this.idleErr = idleErr;
    if (thr < 0.02 && sparkOk && idleErr > -0.6) this.iac += 0.35 * idleErr * dt;
    if (this.iac < 0.1) this.iac = 0.1; else if (this.iac > 8) this.iac = 8;
    // Gentle proportional trim, plus a stronger opening if the engine is about to stall.
    let trimmed = this.iac + 0.3 * idleErr + (idleErr > 0.25 ? 3 * (idleErr - 0.25) : 0);
    if (trimmed < 0.15) trimmed = 0.15;
    const idleAir = this.iac + idleW * (trimmed - this.iac);
    const plate = this.overrunOn && cur.overrunAir * 0.01 > thr ? cur.overrunAir * 0.01 : thr;
    let open = 1 - Math.cos(plate * 0.5 * Math.PI) + this.iacBase * idleAir;
    if (open > 1) open = 1;
    // the throttle plate is sized by its own bore, which may be narrower than the pipe it sits in
    this.throttlePhi = Math.min(1, 0.88 * open * this.tbRatio);
    const filt = FILTER_RES[cur.airFilter | 0] ?? 0;
    for (let q = 0; q < topo.throttlePipes.length; q++) g.pPhiR[topo.throttlePipes[q]] = this.throttlePhi;
    for (let q = 0; q < topo.filterPipes.length; q++) g.pResL[topo.filterPipes[q]] = filt;
    if (!two) {
      // air entering a runner from the plenum necks down past a sharp edge; a bellmouth lets the full bore flow
      const entry = cur.bellmouth > 0.5 ? 1 : SHARP_ENTRY;
      for (let i = 0; i < n; i++) g.pPhiL[topo.runnerPipe[i]] = entry;
    }
    this.boost.step(g, topo.boost, dt, this.omega, g.vp[VOL_PLENUM]);

    this.stepCount++;
    g.step(dt, dt);

    // Crank dynamics.
    const sp = (2 * r * 2 * this.omega) / (2 * Math.PI);
    this.meanPistonSpeed = sp;
    const fmep = (0.45 + 0.06 * sp + 0.0015 * sp * sp) * 1e5;
    // A two-stroke has no valvetrain but rubs through every revolution's power stroke.
    // a supercharger's drive is a load on the crank like any other accessory
    const tFric = ((fmep * this.VdTot) / (4 * Math.PI)) * (two ? 1.3 : 1) + this.boost.crankPower / Math.max(this.omega, 30);
    let tStart = 0;
    if (this.starterOn) {
      tStart = this.starterT0 * Math.max(0, 1 - rpm / 380);
      if (this.autoStart) {
        this.autoStartTime += dt;
        if (rpm > 0.7 * cur.idleRpm || this.autoStartTime > 4) {
          this.autoStart = false;
          this.autoStartTime = 0;
        }
      }
    }
    // (I + sum m s'^2) dw/dt = T - sum m s' s'' w^2  (energy-consistent reciprocating inertia)
    // In driving mode the clutch replaces the dyno brake as the load on the crank.
    let tLoad = this.loadK * this.omega * this.omega;
    if (cur.dynoRpm > 0 && !driving) {
      // Speed-holding dynamometer: an absorber that takes whatever torque keeps the crank at the set speed.
      // It can only brake, so an engine too weak to reach the speed is simply left unloaded.
      const err = this.omega - (cur.dynoRpm * Math.PI) / 30;
      const kp = 60 * this.inertia;
      this.dynoInt += 12 * kp * err * dt;
      const cap = 900 * this.VdTot * 1e3 + 200;
      if (this.dynoInt < 0) this.dynoInt = 0; else if (this.dynoInt > cap) this.dynoInt = cap;
      tLoad = kp * err + this.dynoInt;
      tLoad = tLoad < 0 ? 0 : tLoad > cap ? cap : tLoad;
      this.dynoTorque = tLoad;
    } else {
      this.dynoInt = tLoad;
      this.dynoTorque = 0;
    }
    if (driving) {
      this.car.step(dt, this.omega, cur, pedal, this.clutchCap);
      tLoad = this.car.clutchTorque;
    }
    const drive = torque + tStart - tLoad - cRec * this.omega * this.omega;
    const inertia = this.inertia + jRec;
    let om = this.omega;
    if (om > 0) om += ((drive - tFric) / inertia) * dt;
    else if (drive > tFric) om += ((drive - tFric) / inertia) * dt;
    if (om < 0) om = 0;
    this.omega = om;
    this.instTorque = torque - tFric;

    // Cycle-averaged gauges.
    this.torqueAcc += (torque - tFric) * dth;
    this.mapAcc += g.vp[VOL_PLENUM] * dth;
    this.angAcc += dth;
    this.timeAcc += dt;
    if (this.angAcc >= this.cyc) {
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
    this.mdotAir = this.intakeFlow();
  }

  private audio(dt: number, ts: number): number {
    const g = this.gas;
    const cur = this.cur;
    const mIn = this.intakeFlow();
    const inv = 1 / dt;
    const pos = this.delayPos;
    // Monopole radiation: p(r) = d(mdot_out)/dt / (4 pi r), summed over outlets.
    const rad = this.radPipes;
    const jet = cur.fxTurb > 0.5 && ts >= 0.999;
    for (let i = 0; i < rad.length; i++) {
      const m = g.pMdotR[rad[i]];
      const lp = this.srcLp[i] + this.lpA * ((m - this.srcPrev[i]) * inv - this.srcLp[i]);
      this.srcLp[i] = lp;
      this.srcPrev[i] = m;
      const base = i << 12;
      let src = lp;
      if (jet) {
        // Jet mixing noise: Lighthill's U^8 law for the power, radiated as shaped noise.
        const rj = g.rho[this.srcCell[i]];
        let u2 = m / (rj * this.srcArea[i]);
        u2 *= u2;
        if (u2 > 117600) u2 = 117600;
        this.seedT = (Math.imul(this.seedT, 1664525) + 1013904223) | 0;
        // two low-pass stages: the second, at 2.4 kHz, is set from a recording, whose noise
        // falls about 8 dB per octave above that
        this.jetLp[i] += 0.3 * (this.seedT * 4.6566e-10 - this.jetLp[i]);
        const jn = (this.jetLp[12 + i] += this.jetA * (this.jetLp[i] - this.jetLp[12 + i]));
        src += jn * 4.1 * TUNE.jet * Math.sqrt(JET_K * rj * u2 * u2 * u2 * u2 * this.srcArea[i]);
      }
      this.srcBuf[base + pos] = src;
    }
    this.lpIn += this.lpA * (-(mIn - this.mInPrev) * inv - this.lpIn);
    this.mInPrev = mIn;
    const buf = this.srcBuf;
    let sIntake = this.lpIn;
    const bs = this.boost;
    if (bs.cfg.kind > 0) {
      // A venting blow-off valve is a second outlet beside the intake: its flow change, plus the hiss of its jet.
      const mb = cur.mixBov * 0.01, mw = cur.mixWhine * 0.01;
      this.bovLp += this.lpA * ((bs.mdotBov - this.bovPrev) * inv - this.bovLp);
      this.bovPrev = bs.mdotBov;
      sIntake += mb * this.bovLp;
      if (ts >= 0.999) {
        if (bs.mdotBov > 1e-4 && cur.fxTurb > 0.5) {
          this.seedT = (Math.imul(this.seedT, 1664525) + 1013904223) | 0;
          this.bovJet += 0.5 * (this.seedT * 4.6566e-10 - this.bovJet);
          this.bovJet2 += 0.6 * (this.bovJet - this.bovJet2);
          let u2 = bs.jetU * bs.jetU;
          if (u2 > 117600) u2 = 117600;
          sIntake += mb * this.bovJet2 * 4.1 * TUNE.jet * Math.sqrt(JET_K * bs.jetRho * u2 * u2 * u2 * u2 * bs.jetArea);
        }
        if (bs.backU > 1 && cur.fxTurb > 0.5) {
          // surge: noise of the reversed flow through the wheel, by the same scaling law as a jet, muffled by the filter and airbox on its way out
          this.seedT = (Math.imul(this.seedT, 1664525) + 1013904223) | 0;
          this.surgeLp += 0.35 * (this.seedT * 4.6566e-10 - this.surgeLp);
          let u2 = bs.backU * bs.backU;
          if (u2 > 117600) u2 = 117600;
          sIntake += this.surgeLp * 4.1 * TUNE.jet * Math.sqrt(JET_K * bs.backRho * u2 * u2 * u2 * u2 * bs.backArea) * this.whineFilter * (this.whineBox > 0 ? 0.35 : 1);
        }
        const w = BLADES * bs.omega, mode = cur.fxWhine | 0;
        this.whinePhase += w * dt;
        if (this.whinePhase > 6.2831853) this.whinePhase -= 6.2831853 * Math.floor(this.whinePhase / 6.2831853);
        if (mode > 0 && bs.mdot > 0 && w < 0.9 * Math.PI * this.sampleRate) {
          if (mode === 1) {
            // faked: each blade passing modulates the flow by a fixed fraction of a percent
            sIntake += mw * 0.001 * bs.mdot * w * Math.cos(this.whinePhase) * (cur.airbox > 0.5 ? 0.3 : 1);
          } else {
            // A plane wave of amplitude toneP leaves the wheel, loses some of itself in the filter and (as an
            // expansion chamber) the airbox, and drives the air at the mouth: volume flow p A / (rho c).
            let pass = this.whineFilter;
            if (this.whineBox > 0) {
              const sn = Math.sin((w / C_SOUND) * this.whineBoxLen);
              pass /= Math.sqrt(1 + this.whineBox * sn * sn);
            }
            sIntake += mw * ((bs.toneP * pass * this.whineArea) / C_SOUND) * w * Math.cos(this.whinePhase);
          }
        }
      }
    }
    buf[(SRC_INTAKE << 12) + pos] = sIntake;

    // Mechanical noise as a source strength (pressure times 4 pi r).
    let sMech = 0;
    if ((cur.fxMech | 0) === 2) {
      // simulated forces on the block's structural modes, radiated from the engine's position
      if (ts >= 0.999) sMech = RHO_ATM * this.mech.out;
    } else if (ts >= 0.999 && cur.fxMech > 0.5) {
      // NOT simulated: band-passed cylinder pressure plus noise bursts at valve closures
      this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0;
      const noise = this.seed * 4.6566e-10;
      // the envelope rises over a fraction of a millisecond: an instant step would be a hard click
      this.tickTgt *= this.tickDecay;
      if (this.tickTgt > 4) this.tickTgt = 4;
      this.tickEnv += (this.tickTgt - this.tickEnv) * this.tickAtt;
      sMech = 4 * Math.PI * 0.35 * (this.bpComb.run(this.sumPcyl) * 4.8e-6 + this.bpTick.run(noise * this.tickEnv) * 1.2);
    }
    buf[(SRC_ENGINE << 12) + pos] = sMech;
    this.delayPos = (pos + 1) & 4095;

    // Sum every path; diffuse arrivals go through the echoes of the space the microphone is in.
    let pEx = 0, pIn = 0, pMech = 0, dEx = 0, dIn = 0, dMech = 0;
    const slew = this.tapSlew;
    for (let k = 0; k < this.tapCount; k++) {
      const o = this.tapList[k];
      const g = (this.tapCur[o] += (this.tapGain[o] - this.tapCur[o]) * slew);
      const src = (o / TAPS) | 0;
      let x = buf[(src << 12) + ((pos - this.tapDelay[o]) & 4095)];
      const a = this.tapA[o];
      if (a < 1) {
        const lp = (this.tapLp[o] += a * (x - this.tapLp[o]));
        x = lp + this.tapFloor[o] * (x - lp);
      }
      x *= g;
      if (this.tapDiffuse[o]) { if (src < SRC_INTAKE) dEx += x; else if (src === SRC_INTAKE) dIn += x; else dMech += x; }
      else if (src < SRC_INTAKE) pEx += x; else if (src === SRC_INTAKE) pIn += x; else pMech += x;
    }
    if (this.revOn) {
      const rb = this.revBuf, rp = this.revPos;
      for (let c = 0; c < 3; c++) {
        const rd = (rp - this.revLen[c]) & 2047, fb = this.revFb[c], nm = this.revNorm[c];
        let y = rb[c * 2048 + rd];
        rb[c * 2048 + rp] = dEx + fb * y;
        pEx += nm * y;
        y = rb[(3 + c) * 2048 + rd];
        rb[(3 + c) * 2048 + rp] = dIn + fb * y;
        pIn += nm * y;
        y = rb[(6 + c) * 2048 + rd];
        rb[(6 + c) * 2048 + rp] = dMech + fb * y;
        pMech += nm * y;
      }
      this.revPos = (rp + 1) & 2047;
    }
    // Tyre squeal, wind and grass rumble are NOT simulated: shaped noise driven by slip and speed.
    let pCar = 0;
    if (cur.drive > 0.5 && ts >= 0.999) {
      this.seedCar = (Math.imul(this.seedCar, 1664525) + 1013904223) | 0;
      const noise = this.seedCar * 4.6566e-10;
      const car = this.car, v = car.speed;
      let sq = ((car.slipF > car.slipR ? car.slipF : car.slipR) - 1) / 1.5;
      sq = v < 2 || sq < 0 ? 0 : sq > 1 ? 1 : sq;
      this.sqEnv += (sq * (1 - car.grass) - this.sqEnv) * 0.0006;
      this.windLp += 0.05 * (noise - this.windLp);
      this.rumbleLp += 0.012 * (noise - this.rumbleLp);
      const vs = v / 55;
      pCar = this.bpSqueal.run(noise) * this.sqEnv * 30 + this.windLp * 5 * vs * vs + this.rumbleLp * (4 + 26 * car.grass) * (v < 25 ? v / 25 : 1);
      if (this.roadA < 1) {
        // heard through the cabin's glass and panels
        this.roadLp += this.roadA * (pCar - this.roadLp);
        pCar = this.roadLp + this.roadFloor * (pCar - this.roadLp);
      }
      pCar *= this.roadGain;
    }
    this.lastEx = pEx;
    this.lastIn = pIn;
    this.lastMech = pMech;
    this.lastCar = pCar;
    const pp = pEx + pIn + ((cur.fxMech | 0) === 2 ? pMech : 0);
    this.splMs += (pp * pp - this.splMs) * this.splA;

    const y = (cur.mixExhaust * pEx + cur.mixIntake * pIn + cur.mixMech * pMech + cur.mixCar * pCar) * (0.01 / P_REF);
    this.lastMonitor = Math.tanh(y);
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

  /** A valve landing on its seat (faked): louder with speed, and never two alike. */
  private tick(rpm: number): void {
    this.seedT = (Math.imul(this.seedT, 1664525) + 1013904223) | 0;
    this.tickTgt += rpm * 2.5e-4 * (1 + 0.4 * this.seedT * 4.6566e-10);
  }

  /** Roughly normal random number, unit variance. */
  private gauss(): number {
    let s = 0;
    for (let k = 0; k < 3; k++) { this.seedT = (Math.imul(this.seedT, 1664525) + 1013904223) | 0; s += this.seedT * 4.6566e-10; }
    return s;
  }

  /** Exhaust plus intake sound pressure level at the listener, dB re 20 uPa, 0.25 s average. */
  get spl(): number {
    return 10 * Math.log10(this.splMs / 4e-10 + 1e-12);
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
    return SNAP_HEADER + this.n * SNAP_CYL_STRIDE + this.gas.nv * 3 + this.gas.nCells * SNAP_CELL_FIELDS + this.n * TRACE_BINS;
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
    out[H.wallT] = this.headerWallT;
    out[H.strokes] = this.two ? 2 : 4;
    out[H.vtc] = this.vtcAdv;
    out[H.vtec] = this.vtecOn ? 1 : 0;
    const car = this.car;
    out[H.drive] = this.cur.drive;
    out[H.carX] = car.x;
    out[H.carY] = car.y;
    out[H.carPsi] = car.psi;
    out[H.carVx] = car.vx;
    out[H.carVy] = car.vy;
    out[H.carYaw] = car.yaw;
    out[H.carSteer] = car.steer;
    out[H.carGear] = car.gear;
    out[H.carRotF] = car.rotF;
    out[H.carRotR] = car.rotR;
    out[H.carSlipF] = car.slipF;
    out[H.carSlipR] = car.slipR;
    out[H.carGrass] = car.grass;
    out[H.lapTime] = car.lapTime;
    out[H.lastLap] = car.lastLap;
    out[H.bestLap] = car.bestLap;
    out[H.laps] = car.laps;
    out[H.carS] = car.pos.s;
    out[H.carClutch] = car.clutch;
    out[H.carAx] = car.ax;
    out[H.carAy] = car.ay;
    out[H.carAids] = (car.absActive ? 1 : 0) | (car.tcActive ? 2 : 0);
    out[H.spl] = this.spl;
    out[H.dynoTorque] = this.dynoTorque;
    out[H.rpmAvg] = this.rpmAvg;
    out[H.boost] = this.boost.cfg.kind > 0 ? this.boost.boostPa : 0;
    out[H.turboRpm] = this.boost.cfg.kind > 0 ? this.boost.omega * 9.549 : 0;
    out[H.wastegate] = this.boost.wastegate;
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
      out[o + C.flash] = this.flashPeak[i];
      this.flashPeak[i] = this.flash[i];
      out[o + C.mdotIn] = g.pMdotR[this.two ? this.topo.transferPipe[i] : this.topo.runnerPipe[i]];
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
    g.readFire(out, o + 4 * nc);
    o += SNAP_CELL_FIELDS * nc;
    if (withTraces) out.set(this.trace.subarray(0, n * TRACE_BINS), o);
  }
}

export { CP, T_ATM };
