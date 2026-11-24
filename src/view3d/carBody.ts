// A see-through car body round the engine: the shapes the sound model uses, drawn to scale.

import * as THREE from 'three';
import { BodyGeom, GROUND_Y } from '../sim/placement';

export interface CarBodyRig {
  group: THREE.Group;
  /** Hinged at the firewall; rotate about x to open. */
  bonnet: THREE.Group;
  windows: THREE.Mesh[];
}

export function buildCarBody(b: BodyGeom): CarBodyRig {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x6f8fb3, metalness: 0.3, roughness: 0.5, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide });
  const glass = new THREE.MeshStandardMaterial({ color: 0xaad4ee, metalness: 0.2, roughness: 0.2, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });
  const lid = new THREE.MeshStandardMaterial({ color: 0xffb000, metalness: 0.3, roughness: 0.5, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide });
  const line = new THREE.LineBasicMaterial({ color: 0x9fb6cf, transparent: true, opacity: 0.55 });
  const lidLine = new THREE.LineBasicMaterial({ color: 0xffc94a, transparent: true, opacity: 0.9 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.9, transparent: true, opacity: 0.55, depthWrite: false });

  const panel = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, edge: THREE.LineBasicMaterial, parent: THREE.Object3D = group) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edge));
    parent.add(m);
    return m;
  };
  const W = 2 * b.halfWidth, t = 0.02;
  const bayLen = b.firewallZ - b.frontZ, bayH = b.bonnetY - b.floorY;
  // engine bay: wings, nose and firewall, open underneath
  for (const side of [-1, 1]) panel(t, bayH, bayLen, side * b.halfWidth, b.floorY + bayH / 2, b.frontZ + bayLen / 2, skin, line);
  panel(W, bayH, t, 0, b.floorY + bayH / 2, b.frontZ, skin, line);
  panel(W, bayH, t, 0, b.floorY + bayH / 2, b.firewallZ, skin, line);
  // everything behind the firewall up to the waistline, then the glasshouse
  panel(W, bayH, b.rearZ - b.firewallZ, 0, b.floorY + bayH / 2, 0.5 * (b.rearZ + b.firewallZ), skin, line);
  const g = b.greenhouse;
  panel(g[3] - g[0], g[4] - g[1], g[5] - g[2], 0, 0.5 * (g[1] + g[4]), 0.5 * (g[2] + g[5]), glass, line);
  const windows = [-1, 1].map((side) => panel(0.012, 0.36, 0.75, side * (g[3] + 0.005), g[1] + 0.22, 0.5 * (b.firewallZ + b.cabinRearZ) - 0.1, glass, line));

  const bonnet = new THREE.Group();
  bonnet.position.set(0, b.bonnetY, b.firewallZ);
  panel(W, t, bayLen, 0, 0, -bayLen / 2, lid, lidLine, bonnet);
  group.add(bonnet);

  const wheelGeo = new THREE.CylinderGeometry(0.31, 0.31, 0.2, 28);
  for (const z of [b.frontZ + 0.62 * bayLen, b.rearZ - 0.8]) for (const side of [-1, 1]) {
    const w = new THREE.Mesh(wheelGeo, tyre);
    w.rotation.z = Math.PI / 2;
    w.position.set(side * (b.halfWidth - 0.06), GROUND_Y + 0.31, z);
    group.add(w);
  }
  group.traverse((o) => (o.renderOrder = 5));
  return { group, bonnet, windows };
}
