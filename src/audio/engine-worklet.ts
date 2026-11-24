// Audio thread: owns the simulation, renders one sim step per output sample,
// and posts state snapshots in recycled transferable buffers.

import { FINE_ABOVE } from '../sim/topology';
import { EngineSim } from '../sim/engine';
import { Params } from '../sim/params';
import { SNAP_MAX_FLOATS } from '../sim/snapshot';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: unknown): void;

const now: () => number =
  typeof (globalThis as any).performance?.now === 'function' ? () => (globalThis as any).performance.now() : () => Date.now();

const SNAPSHOT_EVERY = 2;
const TRACES_EVERY = 16;
const MIN_BUDGET = 60;

class EngineProcessor extends AudioWorkletProcessor {
  private sim: EngineSim;
  private pool: ArrayBuffer[] = [];
  private block = 0;
  private sentTopo = -1;
  private load = 0;
  private overloadBlocks = 0;
  private busyMs = 0;
  private busyBlocks = 0;
  private rec: Float32Array | null = null;
  private recPos = 0;

  constructor(options: { processorOptions: { params: Params } }) {
    super();
    this.sim = new EngineSim(sampleRate, options.processorOptions.params);
    for (let i = 0; i < 6; i++) this.pool.push(new ArrayBuffer(SNAP_MAX_FLOATS * 4));
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'params') this.sim.setParams(m.values);
      else if (m.type === 'recycle') this.pool.push(m.buffer);
      else if (m.type === 'step') this.sim.requestStepDegrees(m.degrees);
      else if (m.type === 'autostart') this.sim.autoStart = true;
      else if (m.type === 'shift') this.sim.car.shift(m.dir, this.sim.cur.autoClutch > 0.5);
      else if (m.type === 'carReset') this.sim.car.reset(!!m.grid);
      else if (m.type === 'record') { this.rec = new Float32Array(Math.round(m.seconds * sampleRate)); this.recPos = 0; }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const ch0 = out[0];
    const n = ch0.length;
    const sim = this.sim;
    const t0 = now();
    sim.beginBlock(n);
    // a second, silent output carries the waveform for the display, which must not fade in slow motion
    const mon = outputs[1]?.[0];
    for (let i = 0; i < n; i++) {
      ch0[i] = sim.step();
      if (mon) mon[i] = sim.cur.paused ? 0 : sim.lastMonitor;
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    if (this.rec) {
      // capture exactly what is played, for diagnosing a sound outside the browser
      const take = Math.min(n, this.rec.length - this.recPos);
      this.rec.set(ch0.subarray(0, take), this.recPos);
      this.recPos += take;
      if (this.recPos >= this.rec.length) {
        this.port.postMessage({ type: 'recording', buffer: this.rec.buffer }, [this.rec.buffer]);
        this.rec = null;
      }
    }
    this.busyMs += now() - t0;

    // CPU load, averaged over ~0.25 s so a coarse clock still resolves it.
    if (++this.busyBlocks >= 96) {
      const frac = this.busyMs / ((this.busyBlocks * n * 1000) / sampleRate);
      this.load += 0.5 * (frac - this.load);
      sim.cpuLoad = this.load;
      this.busyMs = 0;
      this.busyBlocks = 0;
      // Too heavy for this machine: coarsen the pipes rather than drop physics.
      if (this.load > 0.7) this.overloadBlocks++;
      else this.overloadBlocks = 0;
      const budget = sim.target.cellBudget;
      if (this.overloadBlocks >= 4 && budget > MIN_BUDGET) {
        // Extra-fine cells (more than one solver step per sample) are trimmed a fifth at a time down to the most
        // a single step can carry, so a machine that can afford some of them keeps those; then by quarters.
        // above FINE_ABOVE the slider asks for extra-fine cells: back those off first, then trim what one step can carry
        const next = budget > FINE_ABOVE ? Math.max(FINE_ABOVE, Math.round(budget * 0.85)) : Math.max(MIN_BUDGET, Math.round(Math.min(budget, sim.topo.singleStepCells) * 0.75));
        sim.setParams({ cellBudget: next });
        this.port.postMessage({ type: 'quality', cellBudget: next, load: this.load });
        this.overloadBlocks = 0;
      }
    }

    if (sim.topoId !== this.sentTopo) {
      this.sentTopo = sim.topoId;
      this.port.postMessage({ type: 'topology', info: sim.topologyInfo() });
    }
    this.block++;
    if (this.block % SNAPSHOT_EVERY === 0 && this.pool.length > 0) {
      const buffer = this.pool.pop()!;
      const view = new Float32Array(buffer);
      if (sim.snapshotFloats() <= view.length) {
        sim.writeSnapshot(view, this.block % TRACES_EVERY === 0);
        this.port.postMessage({ type: 'snapshot', buffer }, [buffer]);
      } else {
        this.pool.push(buffer);
      }
    }
    return true;
  }
}

registerProcessor('engine-processor', EngineProcessor);
