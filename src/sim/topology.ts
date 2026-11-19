// Builds the pipe / volume network description from the parameters.

import { ResolvedLayout } from './layouts';
import { Params } from './params';

export type PipeKind = 'intake' | 'runner' | 'header' | 'mid' | 'tail';
export type VolumeKind = 'ambient' | 'plenum' | 'cylinder' | 'junction' | 'muffler';

export interface TopoPipe {
  kind: PipeKind;
  cyl: number;
  group: number;
  length: number;
  diameter: number;
  volL: number;
  volR: number;
  wallT: number;
  cells: number;
  /** Right end opens to ambient and radiates sound. */
  radiates: boolean;
}

export interface TopoVolume {
  kind: VolumeKind;
  group: number;
  volume: number;
}

export interface Topology {
  signature: string;
  volumes: TopoVolume[];
  pipes: TopoPipe[];
  nCyl: number;
  cylVol0: number;
  intakePipe: number;
  runnerPipe: number[];
  headerPipe: number[];
  totalCells: number;
}

export const VOL_AMBIENT = 0;
export const VOL_PLENUM = 1;
export const VOL_CYL0 = 2;

const MM = 1e-3;
const area = (d: number) => 0.25 * Math.PI * d * d;

export function buildTopology(p: Params, layout: ResolvedLayout, dt: number): Topology {
  const n = layout.n;
  const collector = n === 1 && p.collector === 1 ? 0 : p.collector | 0;
  const volumes: TopoVolume[] = [
    { kind: 'ambient', group: 0, volume: 1 },
    { kind: 'plenum', group: 0, volume: p.plenumVolume * 1e-3 },
  ];
  for (let i = 0; i < n; i++) volumes.push({ kind: 'cylinder', group: i, volume: 1e-4 });
  const pipes: TopoPipe[] = [];

  const dRun = p.runnerDiameter * MM;
  const dHead = p.headerDiameter * MM;
  const dTail = p.tailDiameter * MM;

  pipes.push({ kind: 'intake', cyl: -1, group: 0, length: p.intakeLength * MM, diameter: p.throttleBody * MM, volL: VOL_AMBIENT, volR: VOL_PLENUM, wallT: 300, cells: 0, radiates: false });
  const runnerPipe: number[] = [];
  for (let i = 0; i < n; i++) {
    runnerPipe.push(pipes.length);
    pipes.push({ kind: 'runner', cyl: i, group: 0, length: p.runnerLength * MM, diameter: dRun, volL: VOL_PLENUM, volR: VOL_CYL0 + i, wallT: 320, cells: 0, radiates: false });
  }

  const group = collector === 0 ? new Array(n).fill(0) : layout.group;
  const nGroups = collector === 3 ? 0 : Math.max(...group) + 1;
  const headerPipe: number[] = [];

  if (collector === 3) {
    for (let i = 0; i < n; i++) {
      headerPipe.push(pipes.length);
      pipes.push({ kind: 'header', cyl: i, group: i, length: p.headerLength * MM, diameter: dHead, volL: VOL_CYL0 + i, volR: VOL_AMBIENT, wallT: 650, cells: 0, radiates: true });
    }
  } else {
    const nMuff = collector === 2 ? nGroups : 1;
    const muffler0 = volumes.length;
    for (let m = 0; m < nMuff; m++) volumes.push({ kind: 'muffler', group: m, volume: (p.mufflerVolume * 1e-3) / nMuff });
    const dMid = collector === 1 && nGroups > 1 ? dTail * 0.8 : dTail;
    const members: number[][] = Array.from({ length: nGroups }, () => []);
    group.forEach((g, i) => members[g].push(i));
    const pending: { i: number; g: number; to: number; extra: number }[] = [];
    for (let g = 0; g < nGroups; g++) {
      const muff = muffler0 + (collector === 2 ? g : 0);
      if (members[g].length === 1) {
        // One cylinder in the group: no merge, the header runs straight to the muffler.
        pending.push({ i: members[g][0], g, to: muff, extra: p.midLength * MM });
      } else {
        const j = volumes.length;
        volumes.push({ kind: 'junction', group: g, volume: (members[g].length * area(dHead) + area(dMid)) * 0.08 });
        for (const i of members[g]) pending.push({ i, g, to: j, extra: 0 });
      }
    }
    pending.sort((a, b) => a.i - b.i);
    for (const h of pending) {
      headerPipe.push(pipes.length);
      pipes.push({ kind: 'header', cyl: h.i, group: h.g, length: p.headerLength * MM + h.extra, diameter: dHead, volL: VOL_CYL0 + h.i, volR: h.to, wallT: 650, cells: 0, radiates: false });
    }
    for (let v = 0; v < volumes.length; v++) {
      if (volumes[v].kind !== 'junction') continue;
      const g = volumes[v].group;
      pipes.push({ kind: 'mid', cyl: -1, group: g, length: p.midLength * MM, diameter: dMid, volL: v, volR: muffler0 + (collector === 2 ? g : 0), wallT: 550, cells: 0, radiates: false });
    }
    for (let m = 0; m < nMuff; m++) {
      pipes.push({ kind: 'tail', cyl: -1, group: m, length: p.tailLength * MM, diameter: dTail, volL: muffler0 + m, volR: VOL_AMBIENT, wallT: 450, cells: 0, radiates: true });
    }
  }

  // Explicit volume coupling is stable only if V > ~c * sum(A) * dt; pad small volumes.
  for (let v = 1; v < volumes.length; v++) {
    if (volumes[v].kind === 'cylinder') continue;
    let sumA = 0;
    for (const q of pipes) if (q.volL === v || q.volR === v) sumA += area(q.diameter);
    const c = volumes[v].kind === 'plenum' ? 420 : 750;
    volumes[v].volume = Math.max(volumes[v].volume, 3 * c * sumA * dt);
  }

  assignCells(pipes, dt, p.cellBudget || 200);
  const signature = [layout.def.kind, n, collector, group.join(''), volumes.length, pipes.length].join('|');
  let totalCells = 0;
  for (const q of pipes) totalCells += q.cells;
  return { signature, volumes, pipes, nCyl: n, cylVol0: VOL_CYL0, intakePipe: 0, runnerPipe, headerPipe, totalCells };
}

/** Cells per pipe: finest spacing the budget allows, never finer than the CFL limit at this dt. */
export function assignCells(pipes: TopoPipe[], dt: number, budget: number): void {
  let totalLength = 0;
  for (const q of pipes) totalLength += q.length;
  // Sized so one step per sample holds even during hot, near-sonic blowdown.
  const dxCold = (700 * dt) / 0.78;
  const dxHot = (1350 * dt) / 0.78;
  let dxTarget = Math.max(0.025, totalLength / budget);
  for (let pass = 0; pass < 6; pass++) {
    let total = 0;
    for (const q of pipes) {
      const dxMin = q.kind === 'intake' || q.kind === 'runner' ? dxCold : dxHot;
      const nMax = Math.max(2, Math.floor(q.length / dxMin));
      q.cells = Math.max(Math.min(3, nMax), Math.min(nMax, Math.round(q.length / dxTarget)));
      total += q.cells;
    }
    if (total <= budget) break;
    dxTarget *= Math.max(1.05, total / budget);
  }
}
