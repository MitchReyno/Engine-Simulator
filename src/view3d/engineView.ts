// 3D engine view. Every moving part is posed from the audio-thread snapshot;
// nothing here integrates its own motion.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { TopologyInfo } from '../sim/engine';
import { P_ATM, T_ATM } from '../sim/gas';
import { DEG, valveEvents } from '../sim/kinematics';
import { LAYOUT_KINDS, ResolvedLayout, resolveLayout } from '../sim/layouts';
import { Params } from '../sim/params';
import { C, SnapshotView } from '../sim/snapshot';
import { buildTopology } from '../sim/topology';
import { CYL_SCALE, ColorMode, PIPE_SCALE, gasColor } from './colors';
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
  'collector', 'midLength', 'mufflerVolume', 'tailLength', 'tailDiameter', 'cellBudget',
];

const tmpColor: [number, number, number] = [0, 0, 0];
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
    const sig = GEOMETRY_KEYS.map((k) => p[k]).join(',');
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
    this.picked = null;
    this.onPick(null);
  }

  private build(): void {
    const p = this.params!;
    this.dispose();
    const layout = (this.layout = resolveLayout(LAYOUT_KINDS[p.layout | 0] ?? 'inline', p.cylinders | 0, p.bankAngle, p.crank | 0, p.firingOrder | 0));
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
    const fly = this.tag(cylZ(Math.max(1.5 * r, 0.9 * B) + 0.4 * B * Math.min(1, p.flywheel), 0.18 * B, dark, 48), 'flywheel');
    fly.position.z = prevEnd + 0.35 * B + 0.09 * B;
    crank.add(fly);

    // ---- per-cylinder assemblies
    const ev = valveEvents(p.intakeDuration, p.exhaustDuration, p.lsa, p.camAdvance);
    this.liftScale = 1;
    const tilt = 14 * DEG;
    const rIn = 0.18 * B, rEx = 0.155 * B;
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
    const stemLen = 0.62 * B;
    const portW: { intake: THREE.Vector3; exhaust: THREE.Vector3; out: THREE.Vector3; up: THREE.Vector3 }[] = [];

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
      const headBox = this.tag(new THREE.Mesh(new THREE.BoxGeometry(B * 1.3, B * 0.62, B * 1.19), shellMat()), 'head');
      headBox.position.y = deck + hc + B * 0.31;
      head.add(headBox);

      const piston = new THREE.Group();
      const crown = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(B * 0.49, B * 0.49, B * 0.62, 40), alu), 'piston');
      crown.position.y = compH - B * 0.31;
      const wp = this.tag(cylZ(0.11 * B, 0.8 * B, steel, 16), 'wristpin');
      for (const ry of [compH - 0.08 * B, compH - 0.17 * B]) {
        const ring = this.tag(new THREE.Mesh(new THREE.TorusGeometry(B * 0.492, B * 0.012, 6, 40), dark), 'rings');
        ring.rotation.x = Math.PI / 2;
        ring.position.y = ry;
        piston.add(ring);
      }
      piston.add(crown, wp);
      g.add(piston);

      const rod = new THREE.Group();
      const shank = this.tag(new THREE.Mesh(new THREE.BoxGeometry(0.2 * B, l - 0.36 * B, 0.1 * B), steel), 'rod');
      shank.position.y = l / 2 + 0.07 * B;
      const big = this.tag(cylZ(pr + 0.07 * B, 0.24 * B, steel), 'rod');
      const small = this.tag(cylZ(0.17 * B, 0.22 * B, steel, 16), 'rod');
      small.position.y = l;
      rod.add(shank, big, small);
      g.add(rod);

      const gasMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.78, roughness: 0.9, metalness: 0, emissive: 0x000000, depthWrite: false });
      const gas = this.tag(new THREE.Mesh(new THREE.CylinderGeometry(B * 0.485, B * 0.485, 1, 32), gasMat), 'gas');
      gas.renderOrder = 2;
      g.add(gas);

      // Valves: two intake on the +sgn side, two exhaust on the other.
      const axisIn = new THREE.Vector3(sgn * Math.sin(tilt), Math.cos(tilt), 0);
      const axisEx = new THREE.Vector3(-sgn * Math.sin(tilt), Math.cos(tilt), 0);
      const seatIn = new THREE.Vector3(sgn * 0.22 * B, deck + hc, 0);
      const seatEx = new THREE.Vector3(-sgn * 0.23 * B, deck + hc, 0);
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
      for (const dz of [-0.23 * B, 0.23 * B]) {
        const vi = mkValve(rIn, axisIn, 'intakeValve', steel);
        vi.position.set(seatIn.x, seatIn.y, dz);
        valvesIn.push(vi);
        const ve = mkValve(rEx, axisEx, 'exhaustValve', brass);
        ve.position.set(seatEx.x, seatEx.y, dz);
        valvesEx.push(ve);
        const li = this.tag(new THREE.Mesh(lobeGeo, dark), 'camLobe');
        li.position.set(camIn.x, camIn.y, dz);
        const le = this.tag(new THREE.Mesh(lobeGeo, dark), 'camLobe');
        le.position.set(camEx.x, camEx.y, dz);
        head.add(li, le);
        lobesIn.push(li);
        lobesEx.push(le);
      }
      for (const [pos, part] of [[camIn, 'intakeCam'], [camEx, 'exhaustCam']] as const) {
        const shaft = this.tag(cylZ(0.05 * B, pitch * 1.02, steel, 14), part);
        shaft.position.set(pos.x, pos.y, 0);
        head.add(shaft);
      }
      const arrowGeo = new THREE.ConeGeometry(0.07 * B, 0.22 * B, 14);
      const arrowIn = this.tag(new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0x4cc2ff })), 'flowArrow');
      arrowIn.position.set(sgn * 0.5 * B, deck + hc + 0.3 * B, 0);
      const arrowEx = this.tag(new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0xff7a3c })), 'flowArrow');
      arrowEx.position.set(-sgn * 0.5 * B, deck + hc + 0.3 * B, 0);
      head.add(arrowIn, arrowEx);
      arrowIn.userData.dir = Math.atan2(sgn * 0.75, 0.66);
      arrowEx.userData.dir = Math.atan2(-sgn * 0.75, 0.66);

      this.cyls.push({
        group: g, piston, rod, gas, gasMat, head, shell, valvesIn, valvesEx, lobesIn, lobesEx, seatIn, seatEx, axisIn, axisEx,
        lobeAngleIn: Math.atan2(-axisIn.y, -axisIn.x), lobeAngleEx: Math.atan2(-axisEx.y, -axisEx.x), arrowIn, arrowEx, fire: layout.fire[i],
      });

      // World-space port positions for the manifolds.
      g.updateMatrixWorld(true);
      const toEngine = (v: THREE.Vector3) => v.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), -beta).add(new THREE.Vector3(0, 0, z[i]));
      const portY = deck + hc + 0.36 * B;
      portW.push({
        intake: toEngine(new THREE.Vector3(sgn * 0.66 * B, portY, 0)),
        exhaust: toEngine(new THREE.Vector3(-sgn * 0.66 * B, portY, 0)),
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
    ports: { intake: THREE.Vector3; exhaust: THREE.Vector3; out: THREE.Vector3; up: THREE.Vector3 }[],
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
    mufflers.forEach((m, k) => {
      const len = clamp(m.v.volume / (Math.PI * muffR * muffR), 0.1, 0.9);
      const x = mufflers.length > 1 ? (k === 0 ? 0.3 : -0.3) : kind === 'inline' || kind === 'single' ? ports[0].exhaust.x - 0.12 : 0;
      muffPos.set(m.idx, { c: V(x, lowY - 0.06, collZ + midLen + 0.12 + len / 2), len });
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
    for (const [vol, pos] of junctionPos) {
      const j = new THREE.Mesh(new THREE.SphereGeometry(clamp(Math.cbrt(topo.volumes[vol].volume) * 0.62, 0.03, 0.08), 20, 14), volMat());
      j.position.copy(pos);
      addVol(vol, j, 'exhaust', 'collector');
    }
    topo.pipes.forEach((q, k) => {
      if (q.kind === 'mid') {
        const a = junctionPos.get(q.volL)!;
        const mp = muffPos.get(q.volR)!;
        const b = V(mp.c.x, mp.c.y, mp.c.z - mp.len / 2 - muffR * 0.6);
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

    this.crank.rotation.z = theta * DEG;
    this.crank.position.y = -e * 2.2 * B;

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
      for (let k = 0; k < 2; k++) {
        c.valvesIn[k].position.x = c.seatIn.x - c.axisIn.x * li;
        c.valvesIn[k].position.y = c.seatIn.y - c.axisIn.y * li;
        c.valvesEx[k].position.x = c.seatEx.x - c.axisEx.x * le;
        c.valvesEx[k].position.y = c.seatEx.y - c.axisEx.y * le;
        c.lobesIn[k].rotation.z = c.lobeAngleIn + 0.5 * (a - ev.intakeCentre) * DEG;
        c.lobesEx[k].rotation.z = c.lobeAngleEx - 0.5 * (a - ev.exhaustCentre) * DEG;
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

  private poseArrow(arrow: THREE.Mesh, m: number, intake: boolean): void {
    const mag = Math.min(1.6, Math.abs(m));
    arrow.visible = mag > 0.03;
    if (!arrow.visible) return;
    arrow.scale.setScalar(0.45 + mag);
    // Cone points along +Y. Intake flow (m > 0) heads down into the cylinder;
    // exhaust flow (m > 0) heads up and out through its port.
    const outward = arrow.userData.dir as number;
    const forward = intake ? m > 0 : m < 0;
    arrow.rotation.z = forward ? Math.PI - outward : -outward;
  }

  private pick(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.root.children, true);
    // In ghost mode the shell is see-through, so prefer what is inside it.
    const isShell = (o: THREE.Object3D) => ['block', 'liner', 'head', 'crankcase'].includes(o.userData.part);
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
