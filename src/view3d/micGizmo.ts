// The microphone in the 3D view, with an arrow per axis to drag it along.

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const COLORS = [0xff5a5a, 0x5fd35f, 0x5a9bff];

export class MicGizmo {
  readonly group = new THREE.Group();
  /** A thin line from the microphone to the ground, so its height reads at a glance. */
  readonly stand: THREE.Line;
  selected = false;
  /** Called with the new world position while an arrow is dragged. */
  onMove: (x: number, y: number, z: number) => void = () => {};
  /** Lowest and highest allowed position on each axis. */
  min = new THREE.Vector3(-8, 0, -6);
  max = new THREE.Vector3(8, 4, 10);
  dragging = false;

  private body = new THREE.Group();
  private arrows = new THREE.Group();
  private handles: THREE.Mesh[] = [];
  private shafts: THREE.MeshBasicMaterial[] = [];
  private raycaster = new THREE.Raycaster();
  private axis = -1;
  private hover = -1;
  private grab = 0;
  private start = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera, private dom: HTMLElement, private controls: OrbitControls, private groundY: number) {
    const dark = new THREE.MeshStandardMaterial({ color: 0x23272d, metalness: 0.5, roughness: 0.5 });
    const mesh = new THREE.MeshStandardMaterial({ color: 0xd9dee4, metalness: 0.9, roughness: 0.35 });
    const ring = new THREE.MeshStandardMaterial({ color: 0xffb000, metalness: 0.4, roughness: 0.4, emissive: 0x6b4a00 });
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.011, 0.075, 16), dark);
    barrel.position.y = -0.045;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.024, 20, 14), mesh);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.0245, 0.004, 8, 24), ring);
    band.rotation.x = Math.PI / 2;
    this.body.add(barrel, head, band);
    this.body.traverse((o) => (o.userData.mic = true));
    this.group.add(this.body);

    AXES.forEach((dir, k) => {
      const mat = new THREE.MeshBasicMaterial({ color: COLORS[k], depthTest: false, transparent: true, opacity: 0.95 });
      this.shafts.push(mat);
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.15, 10), mat);
      shaft.position.y = 0.115;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.045, 14), mat);
      tip.position.y = 0.21;
      // a fatter invisible cylinder is what the pointer actually has to hit
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.2, 8), new THREE.MeshBasicMaterial({ visible: false }));
      handle.position.y = 0.135;
      handle.userData.axis = k;
      this.handles.push(handle);
      for (const m of [shaft, tip]) m.renderOrder = 10;
      arrow.add(shaft, tip, handle);
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      this.arrows.add(arrow);
    });
    this.arrows.visible = false;
    this.group.add(this.arrows);

    this.stand = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: 0xffb000, dashSize: 0.04, gapSize: 0.03, transparent: true, opacity: 0.6 }),
    );

    // capture phase: an arrow drag must reach us before the orbit controls start turning the camera
    dom.addEventListener('pointerdown', (e) => this.down(e), { capture: true });
    dom.addEventListener('pointermove', (e) => this.move(e));
    dom.addEventListener('pointerup', (e) => this.up(e));
    dom.addEventListener('pointercancel', (e) => this.up(e));
  }

  setPosition(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
    const pos = this.stand.geometry.attributes.position as THREE.BufferAttribute;
    pos.setXYZ(0, x, y, z);
    pos.setXYZ(1, x, this.groundY, z);
    pos.needsUpdate = true;
    this.stand.computeLineDistances();
  }

  select(on: boolean): void {
    this.selected = on;
    this.arrows.visible = on;
    if (!on) this.dom.style.cursor = '';
  }

  /** Keep the microphone a usable size on screen however far the camera is. */
  update(): void {
    const d = this.camera.position.distanceTo(this.group.position);
    this.group.scale.setScalar(Math.max(1, d * 0.5));
    this.shafts.forEach((m, k) => (m.opacity = this.axis === k || this.hover === k ? 1 : 0.8));
  }

  private ray(e: PointerEvent): THREE.Ray {
    const rect = this.dom.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), this.camera);
    return this.raycaster.ray;
  }

  /** True when the pointer is on the microphone itself. */
  hit(e: PointerEvent): boolean {
    this.ray(e);
    return this.raycaster.intersectObject(this.body, true).length > 0;
  }

  private handleAt(e: PointerEvent): number {
    if (!this.selected) return -1;
    this.ray(e);
    const hits = this.raycaster.intersectObjects(this.handles, false);
    return hits.length ? (hits[0].object.userData.axis as number) : -1;
  }

  /** Distance along the axis line (through the drag's start point) nearest to the pointer's ray. */
  private along(e: PointerEvent, k: number): number | null {
    const ray = this.ray(e), a = AXES[k];
    const w = ray.origin.clone().sub(this.start);
    const b = ray.direction.dot(a), denom = 1 - b * b;
    // looking almost straight down the axis: the pointer says nothing about position along it
    if (denom < 0.02) return null;
    return (a.dot(w) - b * ray.direction.dot(w)) / denom;
  }

  private down(e: PointerEvent): void {
    const k = this.handleAt(e);
    if (k < 0) return;
    this.start.copy(this.group.position);
    const t = this.along(e, k);
    if (t === null) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.axis = k;
    this.grab = t;
    this.dragging = true;
    this.controls.enabled = false;
    this.dom.setPointerCapture(e.pointerId);
    this.dom.style.cursor = 'grabbing';
  }

  private move(e: PointerEvent): void {
    if (this.axis < 0) {
      if (this.selected && e.buttons === 0) {
        this.hover = this.handleAt(e);
        this.dom.style.cursor = this.hover >= 0 ? 'grab' : '';
      }
      return;
    }
    const t = this.along(e, this.axis);
    if (t === null) return;
    const p = this.start.clone().addScaledVector(AXES[this.axis], t - this.grab).clamp(this.min, this.max);
    this.onMove(p.x, p.y, p.z);
  }

  private up(e: PointerEvent): void {
    if (this.axis < 0) return;
    this.axis = -1;
    this.controls.enabled = true;
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    this.dom.style.cursor = 'grab';
    // let the click handler that follows see this was a drag, then clear the flag
    setTimeout(() => (this.dragging = false), 0);
  }
}
