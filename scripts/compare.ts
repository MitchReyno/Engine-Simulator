// Compare the simulator with a recording: engine-order levels and broadband floor against rpm, at full throttle.
// usage: PRESET=k24 vite-node scripts/compare-run.ts '{"param":value}' ...
import { EngineSim, TUNE } from '../src/sim/engine';
import { presetParams } from '../src/sim/params';
import { ORDERS, OrderFrame, trackOrders } from './orders';
import { readWav } from './wav';

const SHOW = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12];
const BINS = [4000, 5750, 6250, 6750, 7250, 7650];
const TUNE0 = { ...TUNE };
const db = (v: number) => 20 * Math.log10(v + 1e-12);

export interface Row { rpm: number; n: number; orders: number[]; floor: number }

/** Average steady frames into rpm bins; levels in dB relative to the firing order. */
export function binFrames(frames: OrderFrame[]): Row[] {
  return BINS.map((c) => {
    const sel = frames.filter((f, i) => Math.abs(f.rpm - c) < 250 && i > 0 && i < frames.length - 1 && Math.abs(frames[i + 1].rpm - frames[i - 1].rpm) < 260 && frames[i + 1].rpm >= frames[i - 1].rpm - 20);
    const avg = (pick: (f: OrderFrame) => number) => sel.reduce((s, f) => s + pick(f), 0) / Math.max(1, sel.length);
    return { rpm: c, n: sel.length, orders: SHOW.map((o) => avg((f) => db(f.orders[ORDERS.indexOf(o)]) - db(f.orders[3]))), floor: avg((f) => db(f.floor) - db(f.orders[3])) };
  });
}

export function recording(): Row[] {
  const { sr, ch } = readWav(new URL('../samples/K24-External-Near-Exhaust.wav', import.meta.url).pathname);
  const x = new Float64Array(ch[0].length);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * (ch[0][i] + ch[ch.length - 1][i]);
  return binFrames(trackOrders(x, sr, { rpmLo: 700, rpmHi: 8200 }));
}

export function simulated(id: string, extra: Record<string, number>): Row[] {
  const sr = 44100;
  // keys starting with "tune." set model constants instead of parameters
  extra = { ...extra };
  Object.assign(TUNE, TUNE0);
  for (const k in extra) if (k.startsWith('tune.')) { (TUNE as Record<string, number>)[k.slice(5)] = extra[k]; delete extra[k]; }
  const sim = new EngineSim(sr, { ...presetParams(id), revLimit: 8300, listenerPos: 3.5, listenerDist: 1, ...extra });
  sim.run(3);
  sim.setParams({ throttle: 100 });
  const frames: OrderFrame[] = [];
  // a speed controller on the dyno load holds each target rpm
  for (const target of BINS) {
    let load = 20;
    for (let k = 0; k < 40; k++) {
      load = Math.min(100, Math.max(0.5, load * (1 + 1.5 * (sim.rpmAvg - target) / target)));
      sim.setParams({ load });
      sim.run(0.1);
    }
    const n = sr * 2, x = new Float64Array(n);
    let rpm = 0;
    for (let i = 0; i < n; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); x[i] = sim.lastEx + sim.lastIn; rpm += sim.rpm / n; }
    frames.push(...trackOrders(x, sr, { rpmHint: () => rpm }));
  }
  return binFrames(frames);
}

export function printRows(title: string, rows: Row[]): void {
  console.log(title);
  console.log('   rpm  n | ' + SHOW.map((o) => String(o).padStart(4)).join(' ') + ' | floor');
  for (const r of rows) if (r.n) console.log(String(r.rpm).padStart(6), String(r.n).padStart(2), '| ' + r.orders.map((v) => v.toFixed(0).padStart(4)).join(' ') + ' | ' + r.floor.toFixed(0));
}

/** Mean absolute error in dB over the orders that carry the sound, plus the floor. */
export function score(real: Row[], sim: Row[]): number {
  let e = 0, n = 0;
  real.forEach((r, i) => {
    const s = sim[i];
    if (!r.n || !s.n) return;
    SHOW.forEach((o, k) => { if (o !== 2 && Number.isInteger(o) && o <= 8) { e += Math.abs(Math.max(-45, r.orders[k]) - Math.max(-45, s.orders[k])); n++; } });
    e += Math.abs(Math.max(-70, r.floor) - Math.max(-70, s.floor));
    n++;
  });
  return e / Math.max(1, n);
}
