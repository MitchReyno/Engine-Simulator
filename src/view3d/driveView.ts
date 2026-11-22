// Driving view: the circuit, the car and a chase camera. The car is posed from the
// audio-thread snapshot; nothing here integrates its own motion.

import * as THREE from 'three';
import { Params } from '../sim/params';
import { H, SnapshotView } from '../sim/snapshot';
import { CIRCUIT, Track, locate } from '../sim/track';

const WHEELBASE = 2.67;
const HALF_TRACK = 0.78;
export const CAMERAS = ['Chase', 'Bonnet', 'Overhead'] as const;

function noiseTexture(base: [number, number, number], spread: number, size = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  let seed = 1234567;
  for (let i = 0; i < size * size; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const n = ((seed >>> 8) / 16777216 - 0.5) * spread;
    img.data[i * 4] = base[0] + n;
    img.data[i * 4 + 1] = base[1] + n;
    img.data[i * 4 + 2] = base[2] + n;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A strip following the centreline between two lateral offsets. */
function ribbon(t: Track, d0: number, d1: number, y: number, pick?: (i: number) => THREE.Color | null): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  let count = 0;
  let prev = -1;
  for (let k = 0; k <= t.n; k++) {
    const i = k % t.n;
    const c = pick ? pick(i) : null;
    if (pick && !c) { prev = -1; continue; }
    const nx = -t.ty[i], ny = t.tx[i];
    pos.push(t.x[i] + nx * d0, y, -(t.y[i] + ny * d0), t.x[i] + nx * d1, y, -(t.y[i] + ny * d1));
    uv.push(0, (k * t.ds) / 6, 1, (k * t.ds) / 6);
    const cc = c ?? WHITE;
    col.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
    if (prev >= 0) idx.push(prev, prev + 1, count, prev + 1, count + 1, count);
    prev = count;
    count += 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
const WHITE = new THREE.Color(1, 1, 1);

export class DriveView {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000);
  private car = new THREE.Group();
  private body = new THREE.Group();
  private steerL = new THREE.Group(); private steerR = new THREE.Group();
  private wheels: THREE.Group[] = [];
  private brakeMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff0000, emissiveIntensity: 0 });
  private camYaw = 0;
  private camPos = new THREE.Vector3();
  private first = true;
  private wheelSig = '';
  camMode = 0;
  /** Brake pedal 0..1 from the input layer, for the brake lights. */
  brake = 0;

  constructor(private container: HTMLElement) {
    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(renderer.domElement);
    const sky = 0xa9cbe8;
    this.scene.background = new THREE.Color(sky);
    this.scene.fog = new THREE.Fog(sky, 250, 1500);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556644, 1.5));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(300, 500, 200);
    this.scene.add(sun);
    this.buildWorld(CIRCUIT);
    this.buildCar();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private buildWorld(t: Track): void {
    const grassTex = noiseTexture([70, 118, 58], 34);
    grassTex.repeat.set(700, 700);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(220, -0.03, -190);
    this.scene.add(ground);

    const roadTex = noiseTexture([62, 64, 68], 22);
    roadTex.repeat.set(3, 1);
    const hw = t.halfWidth;
    this.scene.add(new THREE.Mesh(ribbon(t, hw, -hw, 0), new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.95 })));
    const paint = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.8, vertexColors: true });
    this.scene.add(new THREE.Mesh(ribbon(t, hw - 0.25, hw - 0.5, 0.01), paint), new THREE.Mesh(ribbon(t, -hw + 0.5, -hw + 0.25, 0.01), paint));
    // Red and white kerbs on both sides wherever the track bends.
    const red = new THREE.Color(0xc8261c);
    const kerb = (i: number) => (Math.abs(t.curv[i]) > 1 / 140 ? ((i >> 1) & 1 ? red : WHITE) : null);
    this.scene.add(new THREE.Mesh(ribbon(t, hw + 1.3, hw, 0.012, kerb), paint), new THREE.Mesh(ribbon(t, -hw, -hw - 1.3, 0.012, kerb), paint));

    // Start line and gantry.
    const chk = document.createElement('canvas');
    chk.width = 64; chk.height = 8;
    const cx = chk.getContext('2d')!;
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { cx.fillStyle = (i + j) & 1 ? '#111' : '#eee'; cx.fillRect(i * 4, j * 4, 4, 4); }
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2 * hw), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(chk) }));
    line.rotation.x = -Math.PI / 2;
    line.position.set(t.x[0], 0.015, -t.y[0]);
    line.rotation.z = Math.atan2(t.ty[0], t.tx[0]);
    this.scene.add(line);
    const steel = new THREE.MeshStandardMaterial({ color: 0x30363c, roughness: 0.6 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 7, 0.4), steel);
      post.position.set(t.x[0], 3.5, -(t.y[0] + side * (hw + 2)));
      this.scene.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(1, 1.2, 2 * hw + 4.4), new THREE.MeshStandardMaterial({ color: 0xffb000, roughness: 0.6 }));
    beam.position.set(t.x[0], 7, -t.y[0]);
    this.scene.add(beam);
    // Grandstand along the main straight.
    for (let k = 0; k < 4; k++) {
      const stand = new THREE.Mesh(new THREE.BoxGeometry(60, 9, 14), new THREE.MeshStandardMaterial({ color: 0x8e99a6, roughness: 0.8 }));
      stand.position.set(60 + k * 70, 4.5, 34);
      this.scene.add(stand);
    }

    // Trees, kept clear of the track.
    const spots: [number, number, number][] = [];
    let seed = 42;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 8) / 16777216;
    const tp = { index: 0, s: 0, d: 0 };
    while (spots.length < 700) {
      const x = -420 + rnd() * 1300, y = -260 + rnd() * 900;
      locate(t, x, y, -1, tp);
      const dist = Math.hypot(x - t.x[tp.index], y - t.y[tp.index]);
      if (dist > 22 && !(y < -20 && y > -50 && x > 20 && x < 310)) spots.push([x, y, 0.7 + rnd() * 0.9]);
    }
    const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(3.2, 9, 7), new THREE.MeshStandardMaterial({ color: 0x2f5f33, roughness: 1 }), spots.length);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.4, 0.5, 3, 6), new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 }), spots.length);
    const o = new THREE.Object3D();
    spots.forEach(([x, y, sc], i) => {
      o.scale.setScalar(sc);
      o.position.set(x, 7 * sc, -y);
      o.updateMatrix();
      crown.setMatrixAt(i, o.matrix);
      o.position.set(x, 1.5 * sc, -y);
      o.updateMatrix();
      trunk.setMatrixAt(i, o.matrix);
    });
    this.scene.add(crown, trunk);
    // Braking markers: boards 100 and 50 m before each slow corner.
    const board = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    for (let i = 0; i < t.n; i++) {
      const prev = (i + t.n - 1) % t.n;
      if (Math.abs(t.curv[i]) > 1 / 90 && Math.abs(t.curv[prev]) <= 1 / 90) {
        for (const back of [100, 50]) {
          const j = (i - Math.round(back / t.ds) + t.n) % t.n;
          if (Math.abs(t.curv[j]) > 1 / 200) continue;
          const side = t.curv[i] > 0 ? -1 : 1;
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.15, back === 100 ? 1.6 : 1.1, 1.2), board);
          m.position.set(t.x[j] - t.ty[j] * side * (hw + 2.5), 0.9, -(t.y[j] + t.tx[j] * side * (hw + 2.5)));
          m.rotation.y = Math.atan2(t.ty[j], t.tx[j]);
          this.scene.add(m);
        }
      }
    }
  }

  private buildCar(): void {
    const paint = new THREE.MeshStandardMaterial({ color: 0xc0392b, metalness: 0.5, roughness: 0.35 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1a2530, metalness: 0.6, roughness: 0.2 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.8 });
    // Side profile of a small saloon, extruded across the car.
    const side = new THREE.Shape();
    const pts: [number, number][] = [[-2.25, 0.3], [-2.3, 0.75], [-1.75, 0.95], [1.1, 0.9], [2.2, 0.72], [2.3, 0.3]];
    side.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) side.lineTo(x, y);
    side.closePath();
    const shell = new THREE.Mesh(new THREE.ExtrudeGeometry(side, { depth: 1.76, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2 }), paint);
    shell.position.z = -0.88;
    const roof = new THREE.Shape();
    const rp: [number, number][] = [[-1.7, 0.93], [-1.15, 1.38], [0.1, 1.42], [0.95, 0.9]];
    roof.moveTo(rp[0][0], rp[0][1]);
    for (const [x, y] of rp.slice(1)) roof.lineTo(x, y);
    roof.closePath();
    const cabin = new THREE.Mesh(new THREE.ExtrudeGeometry(roof, { depth: 1.5, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 2 }), glass);
    cabin.position.z = -0.75;
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.05, 1.46), paint);
    top.position.set(-0.52, 1.43, 0);
    this.body.add(shell, cabin, top);
    for (const z of [-0.6, 0.6]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.42), this.brakeMat);
      lamp.position.set(-2.32, 0.78, z);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.4), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d0, emissiveIntensity: 0.6 }));
      head.position.set(2.27, 0.66, z);
      this.body.add(lamp, head);
    }
    // The body sits on the wheelbase centre; the car's origin is its centre of gravity.
    this.car.add(this.body);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(4.9, 2.1), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    this.body.add(shadow);
    void dark;
    this.scene.add(this.car);
  }

  /** Wheel size and axle positions follow the car settings. */
  setParams(p: Params): void {
    const sig = `${p.tyreDiameter},${p.drivetrain}`;
    if (sig === this.wheelSig) return;
    this.wheelSig = sig;
    for (const w of this.wheels) w.parent!.remove(w);
    this.car.remove(this.steerL, this.steerR);
    this.wheels = [];
    const R = p.tyreDiameter * 0.5e-3;
    const front = (p.drivetrain | 0) === 0 ? 0.6 : (p.drivetrain | 0) === 1 ? 0.5 : 0.56;
    const a = WHEELBASE * (1 - front), b = WHEELBASE * front;
    this.body.position.x = 0.5 * (a - b);
    const tyre = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.9 });
    const rim = new THREE.MeshStandardMaterial({ color: 0xb8bec4, metalness: 0.8, roughness: 0.35 });
    const mk = () => {
      const g = new THREE.Group();
      const t = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.22, 24), tyre);
      t.rotation.x = Math.PI / 2;
      g.add(t);
      for (let k = 0; k < 5; k++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(R * 1.3, 0.07, 0.24), rim);
        spoke.rotation.z = (k * Math.PI) / 5;
        g.add(spoke);
      }
      return g;
    };
    this.steerL = new THREE.Group();
    this.steerR = new THREE.Group();
    this.steerL.position.set(a, R, -HALF_TRACK);
    this.steerR.position.set(a, R, HALF_TRACK);
    this.car.add(this.steerL, this.steerR);
    for (const parent of [this.steerL, this.steerR]) {
      const w = mk();
      parent.add(w);
      this.wheels.push(w);
    }
    for (const z of [-HALF_TRACK, HALF_TRACK]) {
      const w = mk();
      w.position.set(-b, R, z);
      this.car.add(w);
      this.wheels.push(w);
    }
  }

  render(snap: SnapshotView | null, dt: number): void {
    const x = snap ? snap.h(H.carX) : CIRCUIT.x[CIRCUIT.n - 6], y = snap ? snap.h(H.carY) : 0;
    const psi = snap ? snap.h(H.carPsi) : 0;
    const vx = snap ? snap.h(H.carVx) : 0, vy = snap ? snap.h(H.carVy) : 0;
    const car = this.car;
    car.position.set(x, 0, -y);
    car.rotation.y = psi;
    if (snap) {
      const steer = snap.h(H.carSteer);
      this.steerL.rotation.y = this.steerR.rotation.y = steer;
      this.wheels[0].rotation.z = this.wheels[1].rotation.z = -snap.h(H.carRotF);
      this.wheels[2].rotation.z = this.wheels[3].rotation.z = -snap.h(H.carRotR);
      // Cosmetic body pitch and roll from the accelerations.
      this.body.rotation.z += (snap.h(H.carAx) * 0.004 - this.body.rotation.z) * Math.min(1, dt * 8);
      this.body.rotation.x += (snap.h(H.carAy) * 0.004 - this.body.rotation.x) * Math.min(1, dt * 8);
    }
    this.brakeMat.emissiveIntensity = this.brake > 0.02 ? 2.5 : 0.25;

    const v = Math.hypot(vx, vy);
    const cam = this.camera;
    const fx = Math.cos(psi), fz = -Math.sin(psi);
    if (this.camMode === 0) {
      // Chase: follow the direction of travel with a little lag, so slides are visible.
      const travel = v > 3 ? psi + Math.atan2(vy, vx) * 0.6 : psi;
      let d = travel - this.camYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.camYaw = this.first ? travel : this.camYaw + d * Math.min(1, dt * 5);
      const back = 6.8 + v * 0.03;
      const want = new THREE.Vector3(x - Math.cos(this.camYaw) * back, 2.5, -y + Math.sin(this.camYaw) * back);
      if (this.first) this.camPos.copy(want);
      else this.camPos.lerp(want, Math.min(1, dt * 12));
      cam.position.copy(this.camPos);
      cam.lookAt(x + fx * 8, 0.1, -y + fz * 8);
      cam.fov = 58 + Math.min(18, v * 0.22);
    } else if (this.camMode === 1) {
      cam.position.set(x + fx * 1.5, 1.08, -y + fz * 1.5);
      cam.lookAt(x + fx * 20, 0.85, -y + fz * 20);
      cam.fov = 70;
    } else {
      cam.position.set(x, 95, -y + 0.01);
      cam.up.set(0, 0, -1);
      cam.lookAt(x, 0, -y);
      cam.fov = 60;
    }
    if (this.camMode !== 2) cam.up.set(0, 1, 0);
    this.body.visible = true;
    this.first = false;
    cam.updateProjectionMatrix();
    this.renderer.render(this.scene, cam);
  }

  nextCamera(): string {
    this.camMode = (this.camMode + 1) % CAMERAS.length;
    this.first = true;
    return CAMERAS[this.camMode];
  }
}
