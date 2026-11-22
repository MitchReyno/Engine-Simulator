// 3D engine view. Every moving part is posed from the audio-thread snapshot;
// nothing here integrates its own motion.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { TopologyInfo } from '../sim/engine';
import { P_ATM, T_ATM } from '../sim/gas';
import { CAM_EXPONENTS, DEG, camLift, valveEvents } from '../sim/kinematics';
import { LAYOUT_KINDS, ResolvedLayout, resolveLayout } from '../sim/layouts';
import { Params } from '../sim/params';
import { C, H, SnapshotView } from '../sim/snapshot';
import { buildTopology } from '../sim/topology';
import { CYL_SCALE, ColorMode, PIPE_SCALE, gasColor } from './colors';
import { BeltPath, Circle, lobeGeometry, springGeometry, sprocketGeometry } from './drive';
import { PART_INFO } from './parts';

interface CylRig {
  group: THREE.Group;
  piston: THREE.Group;
  rod: THREE.Group;
  gas: THREE.Mesh;
  gasMat: THREE.MeshStandardMaterial;
  head: THREE.Group;
  shell: THREE.Group;
  valvesIn: THREE.Group[];
  valvesEx: THREE.Group[];
  lobesIn: THREE.Mesh[];
  lobesEx: THREE.Mesh[];
  seatIn: THREE.Vector3;
  seatEx: THREE.Vector3;
  axisIn: THREE.Vector3;
  axisEx: THREE.Vector3;
  lobeAngleIn: number;
  lobeAngleEx: number;
  arrowIn: THREE.Mesh;
  arrowEx: THREE.Mesh;
  fire: number;
  gearIn: ValveGear | null;
  gearEx: ValveGear | null;
}

/** Detailed valvetrain on one side of one cylinder. */
interface ValveGear {
  rockers: THREE.Group[];
  mid: THREE.Group | null;
  pinMat: THREE.MeshStandardMaterial | null;
  springs: THREE.Mesh[];
  springLen: number;
  /** Rocker angle per metre of valve lift, signed. */
  perLift: number;
  rest: number;
  cam: THREE.Vector3;
}

interface ChainRig {
  mesh: THREE.InstancedMesh;
  path: BeltPath;
  z: number;
  links: number;
  /** Chain travel per full 720-degree cycle, in links. */
  linksPerCycle: number;
}

interface PortFrame {
  intake: THREE.Vector3;
  exhaust: THREE.Vector3;
  xferLow: THREE.Vector3;
  xferHigh: THREE.Vector3;
  out: THREE.Vector3;
  up: THREE.Vector3;
}

interface PipeRig {
  mesh: THREE.Mesh;
  rings: number;
  radial: number;
  index: number;
  home: THREE.Vector3;
  side: 'intake' | 'exhaust';
}

interface VolRig {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  vol: number;
  home: THREE.Vector3;
  side: 'intake' | 'exhaust';
}

const GEOMETRY_KEYS = [
  'layout', 'cylinders', 'bankAngle', 'crank', 'firingOrder', 'bore', 'stroke', 'rodLength', 'compression',
  'throttleBody', 'intakeLength', 'runnerLength', 'runnerDiameter', 'plenumVolume', 'headerLength', 'headerDiameter',
  'rearSplit', 'catalyst', 'mufflerType', 'headerSpread', 'mechDetail', 'strokes', 'valvesPerCyl', 'intakeValveSize', 'exhaustValveSize', 'exhaustPortOpen', 'transferPortOpen', 'chamberDiameter', 'chamberSilencer', 'collector', 'midLength', 'mufflerVolume', 'tailLength', 'tailDiameter', 'cellBudget',
];

/** Only the detailed view draws cam lobes to scale, so only it rebuilds for these. */
const DETAIL_KEYS = [
  'vtec', 'vtc', 'camProfile', 'intakeLift', 'exhaustLift', 'intakeDuration', 'exhaustDuration',
  'lowIntakeLift', 'lowExhaustLift', 'lowIntakeDuration', 'lowExhaustDuration', 'lsa', 'camAdvance',
];

const tmpColor: [number, number, number] = [0, 0, 0];
const tmpPt = { x: 0, y: 0, ang: 0 };
const tmpObj = new THREE.Object3D();
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export class EngineView {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private root = new THREE.Group();
  private crank = new THREE.Group();
  private cyls: CylRig[] = [];
  private pipes: PipeRig[] = [];
  private vols: VolRig[] = [];
  private shellMats: THREE.MeshStandardMaterial[] = [];
  private cutPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private params: Params | null = null;
  private geomSig = '';
  private layout: ResolvedLayout | null = null;
  private topo: TopologyInfo | null = null;
  private r = 0.04; private l = 0.14; private bore = 0.086; private compH = 0.03; private deck = 0.2; private hc = 0.01;
  private liftScale = 1;
  private detail = false;
  private cams: { g: THREE.Group; intake: boolean }[] = [];
  private camDrives: THREE.Group[] = [];
  private headLifts: THREE.Group[] = [];
  private chains: ChainRig[] = [];
  private frontDrive = new THREE.Group();
  private sump = new THREE.Group();
  private balancers: { g: THREE.Group; dir: number }[] = [];
  private mdotRef = 0.05;

  colorMode: ColorMode = 'pressure';
  cutaway = false;
  private explodeTarget = 0;
  private explode = 0;
  private frameSig = '';
  private lastFrameSig = '';

  private raycaster = new THREE.Raycaster();
  private picked: { object: THREE.Object3D; local: THREE.Vector3; key: string } | null = null;
  onPick: (info: { title: string; text: string } | null) => void = () => {};
  /** Screen position of the picked point, or null when nothing is picked / visible. */
  labelPos: { x: number; y: number } | null = null;

  constructor(private container: HTMLElement) {
    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x1a1d22, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1.2, 2, 1.5);
    this.scene.add(key);

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.02, 60);
    this.camera.position.set(0.9, 0.55, 1.1);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.15;
    this.controls.maxDistance = 8;
    this.scene.add(this.root);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    let down: { x: number; y: number } | null = null;
    renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this.pick(e);
      down = null;
    });
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setExploded(on: boolean): void {
    this.explodeTarget = on ? 1 : 0;
  }

  setCutaway(on: boolean): void {
    this.cutaway = on;
    this.applyShellStyle();
  }

  private applyShellStyle(): void {
    for (const m of this.shellMats) {
      m.transparent = !this.cutaway;
      m.opacity = this.cutaway ? 1 : 0.13;
      m.depthWrite = this.cutaway;
      m.clippingPlanes = this.cutaway ? [this.cutPlane] : [];
      m.needsUpdate = true;
    }
  }

  setTopology(t: TopologyInfo): void {
    this.topo = t;
  }

  setParams(p: Params): void {
    this.params = p;
    const keys = p.mechDetail > 0.5 && p.strokes < 0.5 ? [...GEOMETRY_KEYS, ...DETAIL_KEYS] : GEOMETRY_KEYS;
    const sig = keys.map((k) => p[k]).join(',');
    if (sig !== this.geomSig) {
      this.geomSig = sig;
      this.build();
    }
  }

  // ------------------------------------------------------------------ build

  private tag<T extends THREE.Object3D>(o: T, part: string): T {
    o.userData.part = part;
    return o;
  }

  private dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
    this.root.clear();
    this.crank = new THREE.Group();
    this.cyls = [];
    this.pipes = [];
    this.vols = [];
    this.shellMats = [];
    this.cams = [];
    this.camDrives = [];
    this.headLifts = [];
    this.chains = [];
    this.balancers = [];
    this.frontDrive = new THREE.Group();
    this.sump = new THREE.Group();
    this.picked = null;
    this.onPick(null);
  }

  private build(): void {
    const p = this.params!;
    this.dispose();
    const layout = (this.layout = resolveLayout(LAYOUT_KINDS[p.layout | 0] ?? 'inline', p.cylinders | 0, p.bankAngle, p.crank | 0, p.firingOrder | 0, p.strokes > 0.5));
    const two = p.strokes > 0.5;
    const detail = (this.detail = !two && p.mechDetail > 0.5);
    const n = layout.n;
    const B = (this.bore = p.bore * 1e-3);
    const S = p.stroke * 1e-3;
    const r = (this.r = S / 2);
    const l = (this.l = Math.max(p.rodLength * 1e-3, 0.66 * S));
    const Ap = 0.25 * Math.PI * B * B;
    const hc = (this.hc = (Ap * S) / (p.compression - 1) / Ap);
    const compH = (this.compH = 0.42 * B);
    const deck = (this.deck = r + l + compH);
    this.mdotRef = 0.09 * ((Ap * S) / 5e-4);

    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.85, roughness: 0.32 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x4a525b, metalness: 0.8, roughness: 0.4 });
    const alu = new THREE.MeshStandardMaterial({ color: 0xc8cdd2, metalness: 0.7, roughness: 0.38 });
    const aluD = new THREE.MeshStandardMaterial({ color: 0xc8cdd2, metalness: 0.7, roughness: 0.38, side: THREE.DoubleSide });
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a25a, metalness: 0.8, roughness: 0.35 });
    const shellMat = () => {
      const m = new THREE.MeshStandardMaterial({ color: 0x8d99a6, metalness: 0.5, roughness: 0.55, side: THREE.DoubleSide });
      this.shellMats.push(m);
      return m;
    };

    // Axial placement.
    const kind = layout.def.kind;
    const stagger = kind === 'v' ? 0.27 * B : kind === 'flat' ? 0.5 * B : 0;
    const pitch = 1.2 * B + stagger;
    const z = layout.def.slot.map((s, i) => s * pitch + (layout.def.bank[i] > 0 ? stagger : 0));
    const zMin = Math.min(...z), zMax = Math.max(...z);
    const zMid = 0.5 * (zMin + zMax);
    this.cutPlane.set(new THREE.Vector3(0, 0, 1), -(z[0] - zMid));
    const engine = new THREE.Group();
    engine.position.z = -zMid;
    this.root.add(engine);

    // ---- crankshaft
    const crank = this.crank;
    engine.add(crank);
    const jr = 0.26 * B, pr = 0.22 * B, wt = 0.1 * B, pinLen = 0.26 * B;
    const slots = new Map<string, number[]>();
    layout.def.slot.forEach((s, i) => {
      const k = `${s}:${layout.pins[i]}`;
      (slots.get(k) ?? slots.set(k, []).get(k)!).push(i);
    });
    const throws: { z0: number; z1: number; alpha: number }[] = [];
    for (const members of slots.values()) {
      const zs = members.map((i) => z[i]);
      throws.push({ z0: Math.min(...zs) - pinLen / 2, z1: Math.max(...zs) + pinLen / 2, alpha: layout.pins[members[0]] * DEG });
    }
    throws.sort((a, b) => a.z0 - b.z0);
    const cylZ = (radius: number, len: number, mat: THREE.Material, seg = 28) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, seg), mat);
      m.rotation.x = Math.PI / 2;
      return m;
    };
    const webShape = new THREE.Shape();
    webShape.absarc(0, 0, jr * 1.25, Math.PI, 0, false);
    webShape.lineTo(pr * 1.25, r);
    webShape.absarc(0, r, pr * 1.25, 0, Math.PI, false);
    webShape.lineTo(-jr * 1.25, 0);
    const cwShape = new THREE.Shape();
    cwShape.absarc(0, 0, Math.max(r * 1.15, jr * 1.6), Math.PI * 1.08, Math.PI * 1.92, false);
    cwShape.lineTo(0, 0);
    const webGeo = new THREE.ExtrudeGeometry(webShape, { depth: wt, bevelEnabled: false });
    const cwGeo = new THREE.ExtrudeGeometry(cwShape, { depth: wt, bevelEnabled: false });
    let prevEnd = throws[0].z0 - wt - 0.5 * B;
    const zNose = prevEnd;
    for (const t of throws) {
      const pin = this.tag(cylZ(pr, t.z1 - t.z0, steel), 'crankpin');
      pin.position.set(r * Math.sin(t.alpha), r * Math.cos(t.alpha), 0.5 * (t.z0 + t.z1));
      crank.add(pin);
      for (const zw of [t.z0 - wt, t.z1]) {
        const g = new THREE.Group();
        g.add(this.tag(new THREE.Mesh(webGeo, dark), 'web'), this.tag(new THREE.Mesh(cwGeo, dark), 'counterweight'));
        g.position.z = zw;
        g.rotation.z = -t.alpha;
        crank.add(g);
      }
      const j = this.tag(cylZ(jr, t.z0 - wt - prevEnd, steel), 'journal');
      j.position.z = 0.5 * (t.z0 - wt + prevEnd);
      crank.add(j);
      prevEnd = t.z1 + wt;
    }
    const tailJ = this.tag(cylZ(jr, 0.35 * B, steel), 'journal');
    tailJ.position.z = prevEnd + 0.175 * B;
    crank.add(tailJ);
    const flyR = Math.max(1.5 * r, 0.9 * B) + 0.4 * B * Math.min(1, p.flywheel);
    const fly = this.tag(cylZ(flyR, 0.18 * B, dark, 48), 'flywheel');
    fly.position.z = prevEnd + 0.35 * B + 0.09 * B;
    crank.add(fly);
    if (detail) {
      const ringGear = this.tag(new THREE.Mesh(sprocketGeometry(flyR + 0.02 * B, 96, 0.07 * B, 0.03 * B), steel), 'ringGear');
      ringGear.position.z = fly.position.z - 0.05 * B;
      crank.add(ringGear);
      for (let k = 0; k < 6; k++) {
        const bolt = this.tag(cylZ(0.045 * B, 0.06 * B, steel, 6), 'flywheel');
        bolt.position.set(0.32 * B * Math.cos(k * 1.0472), 0.32 * B * Math.sin(k * 1.0472), fly.position.z + 0.1 * B);
        crank.add(bolt);
      }
    }

    // ---- per-cylinder assemblies
    const ev = valveEvents(p.intakeDuration, p.exhaustDuration, p.lsa, p.camAdvance);
    this.liftScale = 1;
    const tilt = (detail ? 25 : 14) * DEG;
    const vpc = p.valvesPerCyl | 0;
    const nIn = vpc === 0 ? 1 : vpc === 1 ? 2 : 3, nEx = vpc === 0 ? 1 : 2;
    const rIn = 0.5 * Math.min(p.intakeValveSize * 0.01, nIn === 1 ? 0.52 : nIn === 2 ? 0.4 : 0.33) * B;
    const rEx = 0.5 * Math.min(p.exhaustValveSize * 0.01, nEx === 1 ? 0.45 : 0.34) * B;
    const spread = (count: number) => (count === 1 ? [0] : count === 2 ? [-0.23 * B, 0.23 * B] : [-0.31 * B, 0, 0.31 * B]);
    const lobeShape = (base: number, nose: number) => {
      const sh = new THREE.Shape();
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * 2 * Math.PI;
        const c = Math.cos(a);
        const rad = base + nose * Math.pow(Math.max(0, c), 2.2);
        if (i === 0) sh.moveTo(rad * Math.cos(a), rad * Math.sin(a));
        else sh.lineTo(rad * Math.cos(a), rad * Math.sin(a));
      }
      return sh;
    };
    const lobeGeo = new THREE.ExtrudeGeometry(lobeShape(0.085 * B, 0.07 * B), { depth: 0.12 * B, bevelEnabled: false });
    lobeGeo.translate(0, 0, -0.06 * B);
    const stemLen = (detail ? 0.95 : 0.62) * B;
    const seatRise = detail ? 0.09 * B : 0;
    const headH = (detail ? 0.95 : 0.62) * B, headW = (detail ? 1.5 : 1.3) * B;
    const camExp = CAM_EXPONENTS[p.camProfile | 0] ?? 2;
    const vtecIn = detail && p.vtec > 0.5 && nIn === 2, vtecEx = detail && (p.vtec | 0) === 1 && nEx === 2;
    // Roller rocker geometry: pivot inboard, roller under the cam, pad on the valve tip.
    const rockLen = 0.42 * B, rollerAt = 0.55, rollerR = 0.05 * B, camBase = 0.11 * B;
    const springBase = 0.47 * stemLen, springLen = stemLen - 0.09 * B - springBase;
    const springGeo = detail ? springGeometry(0.135 * B, 0.017 * B, 6, springLen) : null;
    const springMat = new THREE.MeshStandardMaterial({ color: 0x5f7fae, metalness: 0.75, roughness: 0.35 });
    const plastic = new THREE.MeshStandardMaterial({ color: 0x1b1e22, metalness: 0.1, roughness: 0.7 });
    const camPos: { in: THREE.Vector3; ex: THREE.Vector3; dirIn: number; dirEx: number }[] = [];
    const mkGear = (s: number, seat: THREE.Vector3, axis: THREE.Vector3, valves: THREE.Group[], vtecVis: boolean, head: THREE.Group): ValveGear => {
      const wdir = new THREE.Vector3(s * axis.y, -s * axis.x, 0);
      const pivot = seat.clone().addScaledVector(axis, stemLen).addScaledVector(wdir, -rockLen);
      const rest = Math.atan2(wdir.y, wdir.x);
      const perLift = 1 / (rockLen * (wdir.y * axis.x - wdir.x * axis.y));
      const mkRocker = (len: number, dz: number, pad: boolean, part: string) => {
        const g = new THREE.Group();
        const arm = this.tag(new THREE.Mesh(new THREE.BoxGeometry(len, 0.075 * B, 0.085 * B), alu), part);
        arm.position.x = len / 2;
        const boss = this.tag(cylZ(0.085 * B, 0.1 * B, alu, 18), part);
        const roller = this.tag(cylZ(rollerR, 0.07 * B, steel, 18), part);
        roller.position.set(rollerAt * rockLen, s * 0.035 * B, 0);
        g.add(arm, boss, roller);
        if (pad) {
          const tip = this.tag(new THREE.Mesh(new THREE.BoxGeometry(0.1 * B, 0.07 * B, 0.07 * B), steel), part);
          tip.position.set(len - 0.03 * B, -s * 0.05 * B, 0);
          g.add(tip);
        }
        g.position.set(pivot.x, pivot.y, dz);
        g.rotation.z = rest;
        head.add(g);
        return g;
      };
      const rockers: THREE.Group[] = [], springs: THREE.Mesh[] = [];
      for (const v of valves) {
        const push = (v.userData.push as number) ?? 0;
        const rk = mkRocker(rockLen, v.position.z, true, 'rocker');
        rk.position.x += push;
        rockers.push(rk);
        const spring = this.tag(new THREE.Mesh(springGeo!, springMat), 'valveSpring');
        spring.position.copy(seat).addScaledVector(axis, springBase);
        spring.position.x += push;
        spring.position.z = v.position.z;
        spring.rotation.z = v.rotation.z;
        head.add(spring);
        springs.push(spring);
        const guide = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(0.055 * B, 0.055 * B, 0.28 * B, 12), brass), 'valveGuide');
        guide.position.copy(seat).addScaledVector(axis, 0.3 * stemLen);
        guide.position.x += push;
        guide.position.z = v.position.z;
        guide.rotation.z = v.rotation.z;
        head.add(guide);
        const retainer = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(0.155 * B, 0.1 * B, 0.05 * B, 20), dark), 'valveSpring');
        retainer.position.y = stemLen - 0.065 * B;
        v.add(retainer);
      }
      let mid: THREE.Group | null = null, pinMat: THREE.MeshStandardMaterial | null = null;
      if (vtecVis) {
        mid = mkRocker(rockLen * 0.74, 0, false, 'vtecRocker');
        pinMat = new THREE.MeshStandardMaterial({ color: 0x30363c, metalness: 0.6, roughness: 0.4, emissive: 0x000000 });
        const pin = this.tag(cylZ(0.028 * B, 0.58 * B, pinMat, 12), 'vtecPin');
        pin.position.set(0.3 * rockLen, s * 0.045 * B, 0);
        mid.add(pin);
      }
      const shaft = this.tag(cylZ(0.05 * B, pitch * 1.02, steel, 14), 'rockerShaft');
      shaft.position.set(pivot.x, pivot.y, 0);
      head.add(shaft);
      const cam = pivot.clone().addScaledVector(wdir, rollerAt * rockLen).addScaledVector(axis, 0.035 * B + rollerR + camBase);
      return { rockers, mid, pinMat, springs, springLen, perLift, rest, cam };
    };
    const portW: PortFrame[] = [];
    const travel = (deg: number) => {
      const a = deg * DEG, sn = Math.sin(a);
      return r + l - (r * Math.cos(a) + Math.sqrt(l * l - r * r * sn * sn));
    };
    const xEo = travel(p.exhaustPortOpen), xTo = travel(Math.max(p.transferPortOpen, p.exhaustPortOpen + 2));
    const caseR0 = Math.max(r + 0.22 * B * 1.6, 0.26 * B * 2.2) * 1.12;

    for (let i = 0; i < n; i++) {
      const beta = layout.beta[i] * DEG;
      const sgn = layout.beta[i] <= 0 ? 1 : -1;
      const g = new THREE.Group();
      g.position.z = z[i];
      g.rotation.z = -beta;
      engine.add(g);

      const shell = new THREE.Group();
      g.add(shell);
      const linerLen = S + 0.75 * B;
      const liner = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(B * 0.56, B * 0.56, linerLen, 40, 1, true), shellMat()), 'liner');
      liner.position.y = deck - linerLen / 2;
      const jacket = this.tag(new THREE.Mesh(new THREE.BoxGeometry(B * 1.3, linerLen, B * 1.19), shellMat()), 'block');
      jacket.position.y = deck - linerLen / 2;
      shell.add(liner, jacket);

      const head = new THREE.Group();
      g.add(head);
      const headBox = this.tag(new THREE.Mesh(new THREE.BoxGeometry(headW, headH, B * 1.19), shellMat()), 'head');
      headBox.position.y = deck + hc + headH / 2;
      head.add(headBox);
      if (detail) {
        const cover = this.tag(new THREE.Mesh(new THREE.BoxGeometry(headW * 0.95, 0.56 * B, B * 1.19), shellMat()), 'valveCover');
        cover.position.y = deck + hc + headH + 0.28 * B;
        head.add(cover);
      }

      const piston = new THREE.Group();
      const crownH = (detail ? 0.3 : 0.62) * B;
      const crown = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(B * 0.49, B * 0.49, crownH, 40), alu), 'piston');
      crown.position.y = compH - crownH / 2;
      const wp = this.tag(cylZ(0.11 * B, 0.8 * B, steel, 16), 'wristpin');
      const ringSet: [number, number][] = detail ? [[0.06, 0.011], [0.13, 0.011], [0.215, 0.018]] : [[0.08, 0.012], [0.17, 0.012]];
      for (const [down, thick] of ringSet) {
        const ring = this.tag(new THREE.Mesh(new THREE.TorusGeometry(B * 0.492, B * thick, 6, 40), dark), 'rings');
        ring.rotation.x = Math.PI / 2;
        ring.position.y = compH - down * B;
        piston.add(ring);
      }
      piston.add(crown, wp);
      if (detail) {
        // Slipper skirt: two thrust faces and the pin bosses, as on a modern cast piston.
        for (const mid of [Math.PI / 2, 1.5 * Math.PI]) {
          const skirt = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(B * 0.488, B * 0.488, 0.42 * B, 18, 1, true, mid - 0.85, 1.7), aluD), 'pistonSkirt');
          skirt.position.y = compH - crownH - 0.21 * B;
          piston.add(skirt);
        }
        for (const dz of [-0.27 * B, 0.27 * B]) {
          const boss = this.tag(new THREE.Mesh(new THREE.BoxGeometry(0.36 * B, 0.3 * B, 0.1 * B), alu), 'piston');
          boss.position.set(0, compH - crownH - 0.13 * B, dz);
          piston.add(boss);
        }
      }
      g.add(piston);

      const rod = new THREE.Group();
      const big = this.tag(cylZ(pr + 0.07 * B, 0.24 * B, steel), 'rod');
      const small = this.tag(cylZ(0.17 * B, 0.22 * B, steel, 16), 'rod');
      small.position.y = l;
      rod.add(big, small);
      if (detail) {
        // I-beam shank, and a split big end with its cap bolts.
        const len = l - 0.36 * B, yc = l / 2 + 0.07 * B;
        const web = this.tag(new THREE.Mesh(new THREE.BoxGeometry(0.19 * B, len, 0.04 * B), steel), 'rod');
        web.position.y = yc;
        rod.add(web);
        for (const dx of [-0.095 * B, 0.095 * B]) {
          const flange = this.tag(new THREE.Mesh(new THREE.BoxGeometry(0.04 * B, len, 0.11 * B), steel), 'rod');
          flange.position.set(dx, yc, 0);
          rod.add(flange);
          const bolt = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(0.03 * B, 0.03 * B, 0.36 * B, 6), dark), 'rodBolt');
          bolt.position.set(Math.sign(dx) * (pr + 0.105 * B), -0.02 * B, 0);
          rod.add(bolt);
        }
        const shoulders = this.tag(new THREE.Mesh(new THREE.BoxGeometry(2 * (pr + 0.15 * B), 0.2 * B, 0.2 * B), steel), 'rod');
        rod.add(shoulders);
      } else {
        const shank = this.tag(new THREE.Mesh(new THREE.BoxGeometry(0.2 * B, l - 0.36 * B, 0.1 * B), steel), 'rod');
        shank.position.y = l / 2 + 0.07 * B;
        rod.add(shank);
      }
      g.add(rod);

      const gasMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.78, roughness: 0.9, metalness: 0, emissive: 0x000000, depthWrite: false });
      const gas = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(B * 0.485, B * 0.485, 1, 32), gasMat), 'gas');
      gas.renderOrder = 2;
      g.add(gas);

      // Valves: two intake on the +sgn side, two exhaust on the other.
      const axisIn = new THREE.Vector3(sgn * Math.sin(tilt), Math.cos(tilt), 0);
      const axisEx = new THREE.Vector3(-sgn * Math.sin(tilt), Math.cos(tilt), 0);
      const seatIn = new THREE.Vector3(sgn * 0.22 * B, deck + hc + seatRise, 0);
      const seatEx = new THREE.Vector3(-sgn * 0.23 * B, deck + hc + seatRise, 0);
      const mkValve = (rad: number, axis: THREE.Vector3, part: string, mat: THREE.Material) => {
        const v = new THREE.Group();
        const disc = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.55, rad, 0.05 * B, 24), mat), part);
        disc.position.y = 0.025 * B;
        const stem = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(0.03 * B, 0.03 * B, stemLen, 10), mat), part);
        stem.position.y = stemLen / 2;
        v.add(disc, stem);
        v.rotation.z = -Math.atan2(axis.x, axis.y);
        head.add(v);
        return v;
      };
      const valvesIn: THREE.Group[] = [], valvesEx: THREE.Group[] = [], lobesIn: THREE.Mesh[] = [], lobesEx: THREE.Mesh[] = [];
      const camIn = seatIn.clone().addScaledVector(axisIn, stemLen + 0.16 * B);
      const camEx = seatEx.clone().addScaledVector(axisEx, stemLen + 0.16 * B);
      for (const dz of two ? [] : spread(nIn)) {
        const vi = mkValve(rIn, axisIn, 'intakeValve', steel);
        // with three intake valves the middle one sits further out, as in real five-valve heads
        const push = nIn === 3 && dz === 0 ? 0.08 * B : 0;
        vi.position.set(seatIn.x + sgn * push, seatIn.y, dz);
        vi.userData.push = sgn * push;
        valvesIn.push(vi);
        if (detail) {
          const relief = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(rIn * 1.05, rIn * 1.05, 0.008 * B, 24), dark), 'valveRelief');
          relief.position.set(vi.position.x, compH + 0.002 * B, dz);
          piston.add(relief);
          continue;
        }
        const li = this.tag(new THREE.Mesh(lobeGeo, dark), 'camLobe');
        li.position.set(camIn.x, camIn.y, dz);
        head.add(li);
        lobesIn.push(li);
      }
      for (const dz of two ? [] : spread(nEx)) {
        const ve = mkValve(rEx, axisEx, 'exhaustValve', brass);
        ve.position.set(seatEx.x, seatEx.y, dz);
        valvesEx.push(ve);
        if (detail) {
          const relief = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(rEx * 1.05, rEx * 1.05, 0.008 * B, 24), dark), 'valveRelief');
          relief.position.set(ve.position.x, compH + 0.002 * B, dz);
          piston.add(relief);
          continue;
        }
        const le = this.tag(new THREE.Mesh(lobeGeo, dark), 'camLobe');
        le.position.set(camEx.x, camEx.y, dz);
        head.add(le);
        lobesEx.push(le);
      }
      let gearIn: ValveGear | null = null, gearEx: ValveGear | null = null;
      if (detail) {
        gearIn = mkGear(sgn, seatIn, axisIn, valvesIn, vtecIn, head);
        gearEx = mkGear(-sgn, seatEx, axisEx, valvesEx, vtecEx, head);
        camPos.push({ in: gearIn.cam, ex: gearEx.cam, dirIn: Math.atan2(-axisIn.y, -axisIn.x), dirEx: Math.atan2(-axisEx.y, -axisEx.x) });
        const top = deck + hc + seatRise;
        const plug = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(0.045 * B, 0.03 * B, 0.5 * B, 12), new THREE.MeshStandardMaterial({ color: 0xe9e6dc, roughness: 0.5 })), 'sparkPlug');
        plug.position.y = top + 0.27 * B;
        const coil = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(0.075 * B, 0.075 * B, 0.8 * B, 14), plastic), 'coil');
        coil.position.y = top + 0.92 * B;
        const coilTop = this.tag(new THREE.Mesh(new THREE.BoxGeometry(0.24 * B, 0.1 * B, 0.36 * B), plastic), 'coil');
        coilTop.position.y = deck + hc + headH + 0.61 * B;
        const inj = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(0.05 * B, 0.03 * B, 0.36 * B, 12), plastic), 'injector');
        inj.position.set(sgn * 0.82 * B, deck + hc + 0.62 * B, 0);
        inj.rotation.z = -sgn * 0.9;
        const rail = this.tag(cylZ(0.045 * B, pitch * 1.02, alu, 12), 'fuelRail');
        rail.position.set(sgn * 0.96 * B, deck + hc + 0.73 * B, 0);
        head.add(plug, coil, coilTop, inj, rail);
      }
      for (const [pos, part] of two || detail ? [] : ([[camIn, 'intakeCam'], [camEx, 'exhaustCam']] as const)) {
        const shaft = this.tag(cylZ(0.05 * B, pitch * 1.02, steel, 14), part);
        shaft.position.set(pos.x, pos.y, 0);
        head.add(shaft);
      }
      if (two) {
        // Ports are windows in the liner wall; a spark plug sits in the plain head.
        const portMat = new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.9, metalness: 0.1 });
        const exPort = this.tag(new THREE.Mesh(new THREE.BoxGeometry(0.1 * B, S - xEo, 0.5 * B), portMat), 'exhaustPort');
        exPort.position.set(-sgn * 0.56 * B, deck - 0.5 * (S + xEo), 0);
        shell.add(exPort);
        for (const dz of [-0.36 * B, 0.36 * B]) {
          const tp = this.tag(new THREE.Mesh(new THREE.BoxGeometry(0.34 * B, S - xTo, 0.1 * B), portMat), 'transferPort');
          tp.position.set(sgn * 0.12 * B, deck - 0.5 * (S + xTo), dz * 1.5);
          shell.add(tp);
        }
        const plug = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(0.06 * B, 0.06 * B, 0.5 * B, 12), brass), 'sparkPlug');
        plug.position.y = deck + hc + 0.62 * B;
        head.add(plug);
      }
      const arrowGeo = new THREE.ConeGeometry(0.07 * B, 0.22 * B, 14);
      const arrowIn = this.tag(new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0x4cc2ff })), 'flowArrow');
      const arrowEx = this.tag(new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0xff7a3c })), 'flowArrow');
      // rotation that points the cone along the forward-flow direction (dx, dy)
      const aim = (dx: number, dy: number) => -Math.atan2(dx, dy);
      if (two) {
        arrowIn.position.set(sgn * 0.3 * B, deck - 0.5 * (S + xTo), 0.62 * B);
        arrowEx.position.set(-sgn * 0.78 * B, deck - 0.5 * (S + xEo), 0);
        (two ? shell : head).add(arrowIn, arrowEx);
        arrowIn.userData.fwd = aim(-sgn * 0.5, 0.85);
        arrowEx.userData.fwd = aim(-sgn, 0.05);
      } else {
        arrowIn.position.set(sgn * 0.5 * B, deck + hc + 0.3 * B, 0);
        arrowEx.position.set(-sgn * 0.5 * B, deck + hc + 0.3 * B, 0);
        head.add(arrowIn, arrowEx);
        arrowIn.userData.fwd = aim(-sgn * 0.75, -0.66);
        arrowEx.userData.fwd = aim(-sgn * 0.75, 0.66);
      }

      this.cyls.push({
        group: g, piston, rod, gas, gasMat, head, shell, valvesIn, valvesEx, lobesIn, lobesEx, seatIn, seatEx, axisIn, axisEx,
        lobeAngleIn: Math.atan2(-axisIn.y, -axisIn.x), lobeAngleEx: Math.atan2(-axisEx.y, -axisEx.x), arrowIn, arrowEx, fire: layout.fire[i], gearIn, gearEx,
      });

      // World-space port positions for the manifolds.
      g.updateMatrixWorld(true);
      const toEngine = (v: THREE.Vector3) => v.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), -beta).add(new THREE.Vector3(0, 0, z[i]));
      const portY = deck + hc + 0.36 * B;
      portW.push({
        intake: toEngine(two ? new THREE.Vector3(sgn * caseR0 * 0.98, -0.1 * B, 0) : new THREE.Vector3(sgn * 0.66 * B, portY, 0)),
        exhaust: toEngine(two ? new THREE.Vector3(-sgn * 0.66 * B, deck - 0.5 * (S + xEo), 0) : new THREE.Vector3(-sgn * 0.66 * B, portY, 0)),
        xferLow: toEngine(new THREE.Vector3(sgn * 0.45 * B, caseR0 * 0.8, 0.58 * B)),
        xferHigh: toEngine(new THREE.Vector3(sgn * 0.5 * B, deck - 0.5 * (S + xTo), 0.58 * B)),
        out: new THREE.Vector3(sgn, 0, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), -beta),
        up: new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), -beta),
      });
    }
    // Crankcase shell.
    const caseR = Math.max(r + pr * 1.6, jr * 2.2);
    const crankcase = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(caseR * 1.12, caseR * 1.12, zMax - zMin + 1.4 * B, 40, 1, true), shellMat()), 'crankcase');
    crankcase.rotation.x = Math.PI / 2;
    crankcase.position.z = zMid;
    engine.add(crankcase);
    crankcase.userData.shellRoot = true;

    if (detail) {
      const rs = 0.22 * B, teeth = 18;
      const pitchLen = (2 * Math.PI * rs) / teeth;
      const gearCrank = sprocketGeometry(rs, teeth, 0.05 * B, 0.03 * B);
      const gearCam = sprocketGeometry(2 * rs, 2 * teeth, 0.05 * B, 0.03 * B);
      const linkMat = new THREE.MeshStandardMaterial({ color: 0x8a9199, metalness: 0.85, roughness: 0.35 });
      const guideMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, metalness: 0.1, roughness: 0.7 });
      const front = this.frontDrive;
      engine.add(front);
      const addChain = (circles: Circle[], zc: number, toothPitch: number, crankTeeth: number, guides: boolean) => {
        const path = new BeltPath(circles);
        const links = Math.max(8, Math.round(path.total / toothPitch));
        const mesh = this.tag(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), linkMat, links), 'timingChain');
        mesh.frustumCulled = false;
        front.add(mesh);
        this.chains.push({ mesh, path, z: zc, links, linksPerCycle: 2 * crankTeeth });
        if (!guides) return;
        for (const sp of path.spans) {
          if (sp.len < 2.5 * B) continue;
          const nx = Math.sin(sp.ang), ny = -Math.cos(sp.ang);
          const guide = this.tag(new THREE.Mesh(new THREE.BoxGeometry(sp.len * 0.84, 0.03 * B, 0.1 * B), guideMat), 'chainGuide');
          guide.position.set(sp.x + nx * 0.05 * B, sp.y + ny * 0.05 * B, zc);
          guide.rotation.z = sp.ang;
          front.add(guide);
          if (sp.from === 0) {
            // The run leaving the crank is the slack side: the tensioner pushes on its guide.
            const ten = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(0.06 * B, 0.06 * B, 0.26 * B, 14), steel), 'tensioner');
            ten.position.set(sp.x + nx * 0.2 * B + Math.cos(sp.ang) * 0.2 * sp.len, sp.y + ny * 0.2 * B + Math.sin(sp.ang) * 0.2 * sp.len, zc);
            ten.rotation.z = sp.ang;
            front.add(ten);
          }
        }
      };
      const lobe = (lift: number, dur: number, gain: number, width: number) => lobeGeometry(camBase, lift * 1e-3, dur, camExp, gain, width);
      const gain = rollerAt;
      const lobes = {
        inHi: lobe(p.intakeLift, p.intakeDuration, gain, (vtecIn ? 0.11 : 0.13) * B),
        inLo: lobe(p.lowIntakeLift, Math.min(p.lowIntakeDuration, p.intakeDuration), gain, 0.11 * B),
        exHi: lobe(p.exhaustLift, p.exhaustDuration, gain, (vtecEx ? 0.11 : 0.13) * B),
        exLo: lobe(p.lowExhaustLift, Math.min(p.lowExhaustDuration, p.exhaustDuration), gain, 0.11 * B),
      };
      const banks = new Map<number, number[]>();
      layout.beta.forEach((b, i) => (banks.get(b) ?? banks.set(b, []).get(b)!).push(i));
      let bi = 0;
      for (const [betaDeg, members] of banks) {
        const outer = new THREE.Group();
        outer.rotation.z = -betaDeg * DEG;
        engine.add(outer);
        const lift = new THREE.Group();
        outer.add(lift);
        this.headLifts.push(lift);
        const zc = zNose - 0.14 * B - bi * 0.16 * B;
        const zLast = Math.max(...members.map((i) => z[i]));
        const circles: Circle[] = [{ x: 0, y: 0, r: rs }];
        const cb = Math.cos(betaDeg * DEG), sb = Math.sin(betaDeg * DEG);
        for (const intake of [true, false]) {
          const cp = camPos[members[0]];
          const c = intake ? cp.in : cp.ex, dir = intake ? cp.dirIn : cp.dirEx;
          const centre = intake ? ev.intakeCentre : ev.exhaustCentre;
          const cam = new THREE.Group();
          cam.position.set(c.x, c.y, 0);
          lift.add(cam);
          this.cams.push({ g: cam, intake });
          const part = intake ? 'intakeCam' : 'exhaustCam';
          const z0 = zc - 0.06 * B, z1 = zLast + 0.62 * B;
          const shaft = this.tag(cylZ(0.065 * B, z1 - z0, steel, 16), part);
          shaft.position.z = 0.5 * (z0 + z1);
          cam.add(shaft);
          const vt = intake ? vtecIn : vtecEx;
          const hi = intake ? lobes.inHi : lobes.exHi, lo = intake ? lobes.inLo : lobes.exLo;
          const journalZ = new Set<number>();
          for (const i of members) {
            const rig = this.cyls[i];
            const nose = dir - 0.5 * (layout.fire[i] + centre) * DEG;
            const put = (geo: THREE.BufferGeometry, dz: number, key: string) => {
              const m = this.tag(new THREE.Mesh(geo, dark), key);
              m.position.z = z[i] + dz;
              m.rotation.z = nose;
              cam.add(m);
            };
            for (const v of intake ? rig.valvesIn : rig.valvesEx) put(vt ? lo : hi, v.position.z, vt ? 'camLobeLow' : 'camLobe');
            if (vt) put(hi, 0, 'camLobeHigh');
            journalZ.add(Math.round((z[i] - 0.6 * B) * 1e5) / 1e5);
            journalZ.add(Math.round((z[i] + 0.6 * B) * 1e5) / 1e5);
          }
          for (const zj of journalZ) {
            const j = this.tag(cylZ(0.1 * B, 0.12 * B, steel, 20), part);
            j.position.z = zj;
            cam.add(j);
            const cap = this.tag(new THREE.Mesh(new THREE.BoxGeometry(0.34 * B, 0.17 * B, 0.12 * B), alu), 'camCap');
            cap.position.set(c.x, c.y + 0.085 * B, zj);
            lift.add(cap);
          }
          const sprocket = this.tag(new THREE.Mesh(gearCam, dark), 'camSprocket');
          if (intake && p.vtc > 0.5) {
            // Phaser: the housing turns with the chain, the vaned rotor with the cam.
            const drive = new THREE.Group();
            drive.position.set(c.x, c.y, zc);
            lift.add(drive);
            this.camDrives.push(drive);
            const housing = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(0.33 * B, 0.33 * B, 0.16 * B, 36, 1, true), aluD), 'vtcActuator');
            housing.rotation.x = Math.PI / 2;
            housing.position.z = -0.1 * B;
            drive.add(sprocket, housing);
            const hub = this.tag(cylZ(0.13 * B, 0.15 * B, steel, 20), 'vtcActuator');
            hub.position.z = zc - 0.1 * B;
            cam.add(hub);
            for (let k = 0; k < 4; k++) {
              const lug = this.tag(new THREE.Mesh(new THREE.BoxGeometry(0.16 * B, 0.07 * B, 0.15 * B), alu), 'vtcActuator');
              lug.position.set(0.25 * B * Math.cos(k * Math.PI / 2), 0.25 * B * Math.sin(k * Math.PI / 2), -0.1 * B);
              lug.rotation.z = k * Math.PI / 2;
              drive.add(lug);
              const a = k * Math.PI / 2 + 0.38;
              const vane = this.tag(new THREE.Mesh(new THREE.BoxGeometry(0.2 * B, 0.045 * B, 0.14 * B), brass), 'vtcActuator');
              vane.position.set(0.2 * B * Math.cos(a), 0.2 * B * Math.sin(a), zc - 0.1 * B);
              vane.rotation.z = a;
              cam.add(vane);
            }
          } else {
            sprocket.position.z = zc;
            cam.add(sprocket);
          }
          circles.push({ x: c.x * cb + c.y * sb, y: -c.x * sb + c.y * cb, r: 2 * rs });
        }
        addChain(circles, zc, pitchLen, teeth, true);
        const cs = this.tag(new THREE.Mesh(gearCrank, dark), 'crankSprocket');
        cs.position.z = zc;
        crank.add(cs);
        bi++;
      }
      const zFrontMost = zNose - 0.14 * B - bi * 0.16 * B;
      const snout = this.tag(cylZ(0.13 * B, zNose - zFrontMost + 0.3 * B, steel, 20), 'journal');
      snout.position.z = 0.5 * (zNose + zFrontMost - 0.3 * B);
      crank.add(snout);
      const pulley = this.tag(cylZ(0.55 * B, 0.16 * B, dark, 48), 'crankPulley');
      pulley.position.z = zFrontMost - 0.22 * B;
      crank.add(pulley);

      const sump = this.sump;
      engine.add(sump);
      const sweep = r + pr + 0.1 * B;
      if (kind === 'inline' && n === 4) {
        // Twin counter-rotating balance shafts in the oil pump housing, chain-driven at twice crank speed.
        const yb = -(sweep + 0.36 * B), xb = 0.27 * B, rb = 0.24 * B;
        const zb0 = zFrontMost, zb1 = z[1] + 0.3 * B;
        const halfShape = new THREE.Shape();
        halfShape.absarc(0, 0, 0.2 * B, Math.PI, 2 * Math.PI, false);
        halfShape.closePath();
        const half = new THREE.ExtrudeGeometry(halfShape, { depth: 0.34 * B, bevelEnabled: false });
        const meshGear = sprocketGeometry(xb, 28, 0.08 * B, 0.025 * B);
        for (const dir of [1, -1]) {
          const g = new THREE.Group();
          g.position.set(-dir * xb, yb, 0);
          sump.add(g);
          this.balancers.push({ g, dir });
          const shaft = this.tag(cylZ(0.07 * B, zb1 - zb0, steel, 14), 'balanceShaft');
          shaft.position.z = 0.5 * (zb0 + zb1);
          g.add(shaft);
          for (const zw of [z[0] - 0.1 * B, z[1] - 0.1 * B]) {
            const w = this.tag(new THREE.Mesh(half, dark), 'balanceShaft');
            w.position.z = zw;
            g.add(w);
          }
          const gear = this.tag(new THREE.Mesh(meshGear, steel), 'balanceShaft');
          gear.position.z = z[0] + 0.55 * B;
          gear.rotation.z = dir > 0 ? 0 : Math.PI / 28;
          g.add(gear);
          if (dir > 0) {
            const sp = this.tag(new THREE.Mesh(sprocketGeometry(rb / 2, 12, 0.05 * B, 0.025 * B), dark), 'balanceShaft');
            sp.position.z = zFrontMost;
            g.add(sp);
          }
        }
        const cs2 = this.tag(new THREE.Mesh(sprocketGeometry(rb, 24, 0.05 * B, 0.025 * B), dark), 'crankSprocket');
        cs2.position.z = zFrontMost;
        crank.add(cs2);
        addChain([{ x: 0, y: 0, r: rb }, { x: -xb, y: yb, r: rb / 2 }], zFrontMost, (2 * Math.PI * rb) / 24, 24, false);
        const pump = this.tag(new THREE.Mesh(new THREE.BoxGeometry(1.25 * B, 0.56 * B, zb1 - zb0 - 0.2 * B), shellMat()), 'oilPump');
        pump.position.set(0, yb, 0.5 * (zb0 + zb1) + 0.1 * B);
        sump.add(pump);
      }
      if (kind === 'inline' || kind === 'single') {
        const panH = 0.9 * B;
        const pan = this.tag(new THREE.Mesh(new THREE.BoxGeometry(1.5 * B, panH, zMax - zMin + 1.3 * B), shellMat()), 'oilPan');
        pan.position.set(0, -(sweep + 0.05 * B) - panH / 2, zMid);
        sump.add(pan);
      }
    }

    this.buildManifolds(engine, p, layout, portW, z, zMin, zMax);
    this.applyShellStyle();

    this.frameSig = `${layout.def.kind}${n}`;
    if (this.frameSig !== this.lastFrameSig) {
      this.lastFrameSig = this.frameSig;
      this.fit();
    }
  }

  /** Frame the whole assembly. */
  fit(): void {
    // Frame the engine itself with room for the manifolds; the exhaust runs off behind.
    const box = new THREE.Box3();
    this.root.updateMatrixWorld(true);
    for (const c of this.cyls) box.expandByObject(c.group);
    box.expandByObject(this.crank);
    const centre = box.getCenter(new THREE.Vector3());
    const radius = 0.5 * box.getSize(new THREE.Vector3()).length();
    const dist = (radius / Math.tan((this.camera.fov * DEG) / 2)) * 1.05;
    this.controls.target.copy(centre).add(new THREE.Vector3(0, 0.02, radius * 0.25));
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(this.layout?.def.kind === 'inline' || this.layout?.def.kind === 'single' ? -0.6 : 0.6, 0.34, -0.72).normalize().multiplyScalar(dist));
  }

  private buildManifolds(
    engine: THREE.Group, p: Params, layout: ResolvedLayout,
    ports: PortFrame[],
    z: number[], zMin: number, zMax: number,
  ): void {
    const topo = buildTopology(p, layout, 1 / 48000);
    const B = this.bore;
    const V = (x: number, y: number, zz: number) => new THREE.Vector3(x, y, zz);
    const pipeMat = () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.25, side: THREE.DoubleSide });
    const addPipe = (index: number, pts: THREE.Vector3[], side: 'intake' | 'exhaust', part: string) => {
      const q = topo.pipes[index];
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
      const rings = Math.max(10, q.cells * 3);
      const radial = 12;
      const geo = new THREE.TubeGeometry(curve, rings, q.diameter / 2, radial, false);
      if (q.profile) {
        // Tapered pipe: scale each ring about its centre to the local diameter.
        const pos = geo.attributes.position as THREE.BufferAttribute;
        const c = new THREE.Vector3(), v = new THREE.Vector3();
        for (let ring = 0; ring <= rings; ring++) {
          const u = ring / rings;
          const f = u * q.cells, i0 = Math.min(q.cells - 1, Math.floor(f));
          const d = q.profile[i0] + (q.profile[i0 + 1] - q.profile[i0]) * (f - i0);
          curve.getPointAt(u, c);
          for (let k = 0; k <= radial; k++) {
            const idx = ring * (radial + 1) + k;
            v.fromBufferAttribute(pos, idx).sub(c).multiplyScalar(d / q.diameter).add(c);
            pos.setXYZ(idx, v.x, v.y, v.z);
          }
        }
        geo.computeVertexNormals();
      }
      const col = new Float32Array(geo.attributes.position.count * 3).fill(0.75);
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const mesh = this.tag(new THREE.Mesh(geo, pipeMat()), part);
      engine.add(mesh);
      this.pipes.push({ mesh, rings, radial, index, home: mesh.position.clone(), side });
    };
    const addVol = (vol: number, mesh: THREE.Mesh, side: 'intake' | 'exhaust', part: string) => {
      this.tag(mesh, part);
      engine.add(mesh);
      this.vols.push({ mesh, mat: mesh.material as THREE.MeshStandardMaterial, vol, home: mesh.position.clone(), side });
    };
    const volMat = () => new THREE.MeshStandardMaterial({ color: 0xbfc6cc, roughness: 0.5, metalness: 0.3 });

    if (topo.twoStroke) {
      // One carburettor, reed block, transfer passage and expansion chamber per cylinder.
      const Li = clamp(p.intakeLength * 1e-3, 0.08, 0.5), Lr = clamp(p.runnerLength * 1e-3, 0.06, 0.3);
      const Lc = clamp(topo.pipes[topo.headerPipe[0]].length, 0.4, 2) * 0.62;
      ports.forEach((q, i) => {
        const up = V(0, 1, 0);
        const reed = q.intake.clone().addScaledVector(q.out, Lr);
        addPipe(topo.runnerPipe[i], [reed, q.intake.clone().addScaledVector(q.out, Lr * 0.5), q.intake], 'intake', 'reedPassage');
        const man = new THREE.Mesh(new THREE.SphereGeometry(clamp(Math.cbrt(topo.volumes[topo.pipes[topo.runnerPipe[i]].volL].volume) * 0.6, 0.02, 0.05), 16, 12), volMat());
        man.position.copy(reed);
        addVol(topo.pipes[topo.runnerPipe[i]].volL, man, 'intake', 'reedBlock');
        const mouth = reed.clone().addScaledVector(q.out, Li).addScaledVector(up, 0.25 * Li);
        addPipe(topo.intakePipes[i], [mouth, reed.clone().addScaledVector(q.out, Li * 0.5).addScaledVector(up, 0.08 * Li), reed], 'intake', 'intakePipe');
        addPipe(topo.transferPipe[i], [q.xferLow, q.xferLow.clone().lerp(q.xferHigh, 0.5).addScaledVector(q.out, 0.12 * B), q.xferHigh], 'intake', 'transfer');
        const ex = q.out.clone().multiplyScalar(-1);
        const p1 = q.exhaust.clone().addScaledVector(ex, 0.09);
        const p2 = p1.clone().addScaledVector(ex, 0.07).add(V(0, -0.05, 0.1));
        const end = p2.clone().add(V(0, -0.04 - 0.03 * (i % 2), Lc));
        addPipe(topo.headerPipe[i], [q.exhaust, p1, p2, p2.clone().lerp(end, 0.5), end], 'exhaust', 'chamber');
        const hp = topo.pipes[topo.headerPipe[i]];
        if (topo.volumes[hp.volR].kind === 'muffler') {
          const len = clamp(topo.volumes[hp.volR].volume / (Math.PI * 0.035 * 0.035), 0.08, 0.3);
          const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, len, 6, 16), volMat());
          m.rotation.x = Math.PI / 2;
          m.position.copy(end).add(V(0, 0, len / 2 + 0.03));
          addVol(hp.volR, m, 'exhaust', 'muffler');
          const tk = topo.pipes.findIndex((x) => x.kind === 'tail' && x.volL === hp.volR);
          const a = end.clone().add(V(0, 0, len + 0.06));
          addPipe(tk, [a, a.clone().add(V(0, 0, 0.05)), a.clone().add(V(0, 0, 0.1))], 'exhaust', 'tailpipe');
        }
      });
      return;
    }
    // ---- intake side
    const kind = layout.def.kind;
    const Lr = clamp(p.runnerLength * 1e-3, 0.1, 0.55);
    const topY = Math.max(...ports.map((q) => q.intake.y));
    const plenLen = zMax - zMin + 1.0 * B;
    const plenR = clamp(Math.sqrt((p.plenumVolume * 1e-3) / (Math.PI * plenLen)), 0.03, 0.14);
    const plenC = kind === 'v' || kind === 'flat' ? V(0, topY + 0.55 * Lr + plenR + 0.03, 0) : V(ports[0].intake.x + 0.8 * Lr + plenR, topY + 0.3 * Lr, 0);
    ports.forEach((q, i) => {
      const end = V(plenC.x, plenC.y, z[i]);
      const dir = q.out.clone().multiplyScalar(0.75).addScaledVector(q.up, 0.55).normalize();
      const p1 = q.intake.clone().addScaledVector(dir, 0.35 * Lr);
      const toward = end.clone().sub(p1);
      const stop = end.clone().addScaledVector(toward.normalize(), -plenR * 0.9);
      const p2 = p1.clone().lerp(stop, 0.55).addScaledVector(q.up, 0.12 * Lr);
      // drawn from plenum to port so cell 0 sits at the plenum end
      addPipe(topo.runnerPipe[i], [stop, p2, p1, q.intake], 'intake', 'runner');
    });
    const plen = new THREE.Mesh(new THREE.CapsuleGeometry(plenR, plenLen, 8, 24), volMat());
    plen.rotation.x = Math.PI / 2;
    plen.position.set(plenC.x, plenC.y, 0.5 * (zMin + zMax));
    addVol(1, plen, 'intake', 'plenum');
    const zFront = zMin - 0.5 * B - plenR;
    const Li = clamp(p.intakeLength * 1e-3, 0.1, 0.8) * 0.8;
    addPipe(topo.intakePipe, [V(plenC.x, plenC.y, zFront - Li), V(plenC.x, plenC.y, zFront - Li * 0.5), V(plenC.x, plenC.y, zFront + plenR * 0.5)], 'intake', 'intakePipe');
    const plate = this.tag(new THREE.Mesh(new THREE.CylinderGeometry((p.throttleBody * 1e-3) / 2 * 1.25, (p.throttleBody * 1e-3) / 2 * 1.25, 0.012, 24), new THREE.MeshStandardMaterial({ color: 0xffb000, metalness: 0.6, roughness: 0.4 })), 'throttle');
    plate.rotation.x = Math.PI / 2;
    plate.position.set(plenC.x, plenC.y, zFront + 0.01);
    engine.add(plate);
    this.vols.push({ mesh: plate, mat: plate.material as THREE.MeshStandardMaterial, vol: -1, home: plate.position.clone(), side: 'intake' });

    // ---- exhaust side
    const Lh = clamp(p.headerLength * 1e-3, 0.15, 1.4);
    const zRear = zMax + 0.7 * B;
    const lowY = -Math.max(this.r + 0.35 * B, 0.1);
    const headerEnd = new Map<number, THREE.Vector3>();
    const junctionPos = new Map<number, THREE.Vector3>();
    const mufflers = topo.volumes.map((v, idx) => ({ v, idx })).filter((x) => x.v.kind === 'muffler');
    const muffR = 0.085;
    const muffPos = new Map<number, { c: THREE.Vector3; len: number }>();
    const midLen = clamp(p.midLength * 1e-3, 0.2, 2) * 0.45;
    const collZ = zRear + 0.12 + 0.3 * Lh;
    // room for the merge and the Y-split when one pipe feeds twin mufflers
    const splitDraw = p.rearSplit > 0.5 && (p.collector | 0) < 2 ? 0.45 : 0;
    mufflers.forEach((m, k) => {
      const len = clamp(m.v.volume / (Math.PI * muffR * muffR), 0.1, 0.9);
      const x = mufflers.length > 1 ? (k === 0 ? 0.3 : -0.3) : kind === 'inline' || kind === 'single' ? ports[0].exhaust.x - 0.12 : 0;
      muffPos.set(m.idx, { c: V(x, lowY - 0.06, collZ + midLen + splitDraw + 0.12 + len / 2), len });
    });
    const sideX = (i: number) => (kind === 'inline' || kind === 'single' ? ports[i].exhaust.x - 0.14 : ports[i].exhaust.x + Math.sign(ports[i].exhaust.x || 1) * 0.1);
    ports.forEach((q, i) => {
      const k = topo.headerPipe[i];
      const pipe = topo.pipes[k];
      const out = q.out.clone().multiplyScalar(-1);
      const p1 = q.exhaust.clone().addScaledVector(out, 0.1);
      let end: THREE.Vector3;
      const target = topo.volumes[pipe.volR];
      if (target.kind === 'ambient') {
        end = V(sideX(i), lowY + 0.02 * (i % 3), z[i] + 0.25 + 0.5 * Lh);
      } else if (target.kind === 'junction') {
        if (!junctionPos.has(pipe.volR)) {
          const members = topo.pipes.filter((x) => x.kind === 'header' && x.volR === pipe.volR).map((x) => x.cyl);
          const mx = members.reduce((s, c) => s + sideX(c), 0) / members.length;
          junctionPos.set(pipe.volR, V(mx, lowY, collZ));
        }
        end = junctionPos.get(pipe.volR)!.clone();
      } else {
        const mp = muffPos.get(pipe.volR)!;
        end = V(mp.c.x, mp.c.y, mp.c.z - mp.len / 2 - muffR * 0.6);
      }
      headerEnd.set(i, end);
      const p2 = V(sideX(i), 0.5 * (p1.y + end.y), z[i] + 0.06);
      const p3 = V(0.5 * (sideX(i) + end.x), end.y + 0.03, Math.min(end.z - 0.08, Math.max(z[i] + 0.15, end.z - 0.25)));
      addPipe(k, [q.exhaust, p1, p2, p3, end], 'exhaust', 'header');
    });
    // Junctions with no header: where secondaries merge, and the Y-split ahead of twin mufflers.
    const mids = topo.pipes.filter((x) => x.kind === 'mid');
    topo.volumes.forEach((vol, idx) => {
      if (vol.kind !== 'junction' || junctionPos.has(idx)) return;
      const fed = mids.filter((x) => x.volL === idx && muffPos.has(x.volR)).map((x) => muffPos.get(x.volR)!);
      if (fed.length) return;
      const up = mids.filter((x) => x.volR === idx && junctionPos.has(x.volL)).map((x) => junctionPos.get(x.volL)!);
      if (up.length) junctionPos.set(idx, V(up.reduce((s, q) => s + q.x, 0) / up.length, lowY - 0.01, collZ + 0.17));
    });
    topo.volumes.forEach((vol, idx) => {
      if (vol.kind !== 'junction' || junctionPos.has(idx)) return;
      const fed = mids.filter((x) => x.volL === idx && muffPos.has(x.volR)).map((x) => muffPos.get(x.volR)!);
      if (fed.length) junctionPos.set(idx, V(fed.reduce((s, m) => s + m.c.x, 0) / fed.length, lowY - 0.04, Math.min(...fed.map((m) => m.c.z - m.len / 2)) - 0.3));
    });
    for (const [vol, pos] of junctionPos) {
      const j = new THREE.Mesh(new THREE.SphereGeometry(clamp(Math.cbrt(topo.volumes[vol].volume) * 0.62, 0.03, 0.08), 20, 14), volMat());
      j.position.copy(pos);
      addVol(vol, j, 'exhaust', 'collector');
    }
    // A catalytic converter sits part-way along the collector pipe, splitting it in two.
    const catPos = new Map<number, THREE.Vector3>();
    const catLen = 0.16, catR = 0.062;
    topo.volumes.forEach((vol, idx) => {
      if (vol.kind !== 'catalyst') return;
      const before = topo.pipes.find((x) => x.kind === 'mid' && x.volR === idx)!, after = topo.pipes.find((x) => x.kind === 'mid' && x.volL === idx)!;
      const a = junctionPos.get(before.volL)!, mp = muffPos.get(after.volR);
      const c = a.clone().lerp(mp ? V(mp.c.x, mp.c.y, mp.c.z - mp.len / 2 - muffR * 0.6) : junctionPos.get(after.volR)!, 0.38);
      catPos.set(idx, c);
      const can = new THREE.Mesh(new THREE.CapsuleGeometry(catR, catLen, 6, 20), volMat());
      can.rotation.x = Math.PI / 2;
      can.position.copy(c);
      addVol(idx, can, 'exhaust', 'catalyst');
    });
    const midEnd = (vol: number, inlet: boolean) => {
      const c = catPos.get(vol);
      if (c) return c.clone().add(V(0, 0, (inlet ? -1 : 1) * (catLen / 2 + catR * 0.6)));
      const mp = muffPos.get(vol);
      return mp ? V(mp.c.x, mp.c.y, mp.c.z - mp.len / 2 - muffR * 0.6) : junctionPos.get(vol)!.clone();
    };
    topo.pipes.forEach((q, k) => {
      if (q.kind === 'mid') {
        const a = midEnd(q.volL, false);
        const b = midEnd(q.volR, true);
        addPipe(k, [a, a.clone().lerp(b, 0.5).add(V(0, -0.01, 0)), b], 'exhaust', 'midPipe');
      } else if (q.kind === 'tail') {
        const mp = muffPos.get(q.volL)!;
        const a = V(mp.c.x, mp.c.y, mp.c.z + mp.len / 2 + muffR * 0.5);
        const Lt = clamp(p.tailLength * 1e-3, 0.2, 3) * 0.4;
        addPipe(k, [a, a.clone().add(V(0, 0, Lt * 0.5)), a.clone().add(V(0, 0.02, Lt))], 'exhaust', 'tailpipe');
      }
    });
    for (const [idx, mp] of muffPos) {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(muffR, mp.len, 8, 24), volMat());
      m.rotation.x = Math.PI / 2;
      m.position.copy(mp.c);
      addVol(idx, m, 'exhaust', 'muffler');
    }
  }

  // ----------------------------------------------------------------- update

  /** Pose everything from a snapshot (or a rest pose when there is none) and render. */
  render(snap: SnapshotView | null, dt: number): void {
    const p = this.params;
    if (!p || !this.layout) return;
    const n = this.cyls.length;
    const live = !!snap && snap.nCyl === n;
    const theta = live ? snap!.h(0) : 0;
    const B = this.bore, r = this.r, l = this.l;
    this.explode += (this.explodeTarget - this.explode) * Math.min(1, dt * 6);
    const e = this.explode;
    const ev = valveEvents(p.intakeDuration, p.exhaustDuration, p.lsa, p.camAdvance);
    const vtc = live ? snap!.h(H.vtc) : 0;
    const vtecOn = live && snap!.h(H.vtec) > 0.5;
    const ci = ev.intakeCentre - vtc;
    const camExp = CAM_EXPONENTS[p.camProfile | 0] ?? 2;

    this.crank.rotation.z = theta * DEG;
    this.crank.position.y = -e * 2.2 * B;
    if (this.detail) {
      for (const c of this.cams) c.g.rotation.z = 0.5 * (theta + (c.intake ? vtc : 0)) * DEG;
      for (const d of this.camDrives) d.rotation.z = 0.5 * theta * DEG;
      for (const h of this.headLifts) h.position.y = e * 2.4 * B;
      for (const b of this.balancers) b.g.rotation.z = b.dir * 2 * theta * DEG;
      this.sump.position.y = -e * 3.6 * B;
      this.frontDrive.visible = e < 0.03;
      if (this.frontDrive.visible) {
        for (const ch of this.chains) {
          const step = ch.path.total / ch.links;
          const offset = (theta / 720) * ch.linksPerCycle * step;
          for (let k = 0; k < ch.links; k++) {
            ch.path.at(k * step + offset, tmpPt);
            tmpObj.position.set(tmpPt.x, tmpPt.y, ch.z);
            tmpObj.rotation.set(0, 0, tmpPt.ang);
            tmpObj.scale.set(step * 0.86, 0.045 * B, (k & 1 ? 0.085 : 0.055) * B);
            tmpObj.updateMatrix();
            ch.mesh.setMatrixAt(k, tmpObj.matrix);
          }
          ch.mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }

    for (let i = 0; i < n; i++) {
      const c = this.cyls[i];
      let a = live ? snap!.cyl(i, C.angle) : ((-c.fire % 720) + 720) % 720;
      const ar = a * DEG;
      const s = r * Math.cos(ar) + Math.sqrt(l * l - r * r * Math.sin(ar) ** 2);
      c.piston.position.y = s - e * 0.4 * B;
      c.rod.position.set(-r * Math.sin(ar), r * Math.cos(ar) - e * 1.3 * B, 0);
      c.rod.rotation.z = -Math.asin((r * Math.sin(ar)) / l);
      c.shell.position.y = e * 1.1 * B;
      c.head.position.y = e * 2.4 * B;

      const crownY = s + this.compH;
      const h = Math.max(1e-4, this.deck + this.hc - crownY);
      c.gas.scale.y = h;
      c.gas.position.y = crownY + h / 2 - e * 0.4 * B + e * 0.0;
      c.gas.visible = e < 0.4;
      const pC = live ? snap!.cyl(i, C.p) : P_ATM, tC = live ? snap!.cyl(i, C.T) : T_ATM, yC = live ? snap!.cyl(i, C.Y) : 0;
      gasColor(this.colorMode, CYL_SCALE, pC, tC, yC, tmpColor);
      c.gasMat.color.setRGB(tmpColor[0], tmpColor[1], tmpColor[2]);
      const flash = live ? Math.min(1, snap!.cyl(i, C.flash)) : 0;
      c.gasMat.emissive.setRGB(flash * 1.0, flash * 0.72, flash * 0.3);
      c.gasMat.emissiveIntensity = 1 + 3 * flash;
      c.gasMat.opacity = 0.72 + 0.28 * flash;

      const li = (live ? snap!.cyl(i, C.liftIn) : 0) * this.liftScale;
      const le = (live ? snap!.cyl(i, C.liftEx) : 0) * this.liftScale;
      for (let k = 0; k < c.valvesIn.length; k++) {
        c.valvesIn[k].position.x = c.seatIn.x + (c.valvesIn[k].userData.push ?? 0) - c.axisIn.x * li;
        c.valvesIn[k].position.y = c.seatIn.y - c.axisIn.y * li;
        if (c.lobesIn[k]) c.lobesIn[k].rotation.z = c.lobeAngleIn + 0.5 * (a - ci) * DEG;
      }
      for (let k = 0; k < c.valvesEx.length; k++) {
        c.valvesEx[k].position.x = c.seatEx.x - c.axisEx.x * le;
        c.valvesEx[k].position.y = c.seatEx.y - c.axisEx.y * le;
        if (c.lobesEx[k]) c.lobesEx[k].rotation.z = c.lobeAngleEx - 0.5 * (a - ev.exhaustCentre) * DEG;
      }
      if (c.gearIn && c.gearEx) {
        this.poseGear(c.gearIn, li, camLift(a, ci, p.intakeDuration, p.intakeLift * 1e-3, camExp), vtecOn);
        this.poseGear(c.gearEx, le, camLift(a, ev.exhaustCentre, p.exhaustDuration, p.exhaustLift * 1e-3, camExp), vtecOn);
      }
      const mi = live ? snap!.cyl(i, C.mdotIn) / this.mdotRef : 0;
      const me = live ? snap!.cyl(i, C.mdotEx) / this.mdotRef : 0;
      this.poseArrow(c.arrowIn, mi, true);
      this.poseArrow(c.arrowEx, me, false);
    }

    // Pipes and volumes: colour by gas state.
    const topo = this.topo;
    const mode = this.colorMode;
    for (const pr of this.pipes) {
      pr.mesh.position.copy(pr.home);
      if (pr.side === 'intake') pr.mesh.position.y += e * 3.4 * B;
      else pr.mesh.position.y -= e * 1.2 * B;
      const info = live && topo ? topo.pipes[pr.index] : null;
      const col = pr.mesh.geometry.attributes.color as THREE.BufferAttribute;
      const arr = col.array as Float32Array;
      const per = pr.radial + 1;
      for (let ring = 0; ring <= pr.rings; ring++) {
        if (info) {
          const j = info.offset + Math.min(info.cells - 1, Math.floor((ring / pr.rings) * info.cells));
          gasColor(mode, PIPE_SCALE, snap!.cellP(j), snap!.cellT(j), snap!.cellY(j), tmpColor);
        } else gasColor(mode, PIPE_SCALE, P_ATM, T_ATM, 0, tmpColor);
        for (let k = 0; k < per; k++) {
          const o = (ring * per + k) * 3;
          arr[o] = tmpColor[0];
          arr[o + 1] = tmpColor[1];
          arr[o + 2] = tmpColor[2];
        }
      }
      col.needsUpdate = true;
    }
    for (const v of this.vols) {
      v.mesh.position.copy(v.home);
      if (v.side === 'intake') v.mesh.position.y += e * 3.4 * B;
      else v.mesh.position.y -= e * 1.2 * B;
      if (v.vol < 0) {
        // throttle plate: swing with the effective opening
        v.mesh.rotation.x = Math.PI / 2 - (live ? Math.min(1, snap!.h(6)) : 0) * (Math.PI / 2) * 0.95;
        continue;
      }
      if (live && v.vol < snap!.nVol) gasColor(mode, PIPE_SCALE, snap!.volP(v.vol), snap!.volT(v.vol), snap!.volY(v.vol), tmpColor);
      else gasColor(mode, PIPE_SCALE, P_ATM, T_ATM, 0, tmpColor);
      v.mat.color.setRGB(tmpColor[0], tmpColor[1], tmpColor[2]);
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    if (this.picked) {
      const w = this.picked.object.localToWorld(this.picked.local.clone()).project(this.camera);
      const rect = this.container.getBoundingClientRect();
      this.labelPos = w.z < 1 ? { x: (w.x * 0.5 + 0.5) * rect.width, y: (-w.y * 0.5 + 0.5) * rect.height } : null;
    } else this.labelPos = null;
  }

  /** Rockers follow the valves; the VTEC mid rocker always follows the high lobe. */
  private poseGear(g: ValveGear, lift: number, highLift: number, locked: boolean): void {
    const a = g.rest + lift * g.perLift;
    for (const r of g.rockers) r.rotation.z = a;
    for (const s of g.springs) s.scale.y = Math.max(0.3, (g.springLen - lift) / g.springLen);
    if (g.mid) {
      g.mid.rotation.z = g.rest + Math.max(lift, highLift) * g.perLift;
      g.pinMat!.emissive.setRGB(locked ? 1 : 0, locked ? 0.55 : 0, 0);
      g.pinMat!.color.setHex(locked ? 0xffb000 : 0x30363c);
    }
  }

  private poseArrow(arrow: THREE.Mesh, m: number, intake: boolean): void {
    const mag = Math.min(1.6, Math.abs(m));
    arrow.visible = mag > 0.03;
    if (!arrow.visible) return;
    arrow.scale.setScalar(0.45 + mag);
    // The cone points along +Y at rotation 0; `fwd` aims it along forward flow.
    void intake;
    arrow.rotation.z = (arrow.userData.fwd as number) + (m > 0 ? 0 : Math.PI);
  }

  private pick(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.root.children, true);
    // In ghost mode the shell is see-through, so prefer what is inside it.
    const isShell = (o: THREE.Object3D) => ['block', 'liner', 'head', 'crankcase', 'valveCover', 'oilPan', 'oilPump'].includes(o.userData.part);
    const visible = hits.filter((h) => h.object.visible && h.object.userData.part && (!this.cutaway || !isShell(h.object) || this.cutPlane.distanceToPoint(h.point) >= 0));
    const hit = (this.cutaway ? visible[0] : visible.find((h) => !isShell(h.object)) ?? visible[0]) ?? null;
    if (!hit) {
      this.picked = null;
      this.onPick(null);
      return;
    }
    const key = hit.object.userData.part as string;
    this.picked = { object: hit.object, local: hit.object.worldToLocal(hit.point.clone()), key };
    this.onPick(PART_INFO[key] ?? { title: key, text: '' });
  }

  frontView(): void {
    const d = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.set(this.controls.target.x + d * 0.25, this.controls.target.y + d * 0.2, this.controls.target.z - d * 0.95);
  }
}
