// Audio thread: owns the simulation, renders one sim step per output sample,
// and posts state snapshots in recycled transferable buffers.

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
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const ch0 = out[0];
    const n = ch0.length;
    const sim = this.sim;
    const t0 = now();
    sim.beginBlock(n);
    for (let i = 0; i < n; i++) ch0[i] = sim.step();
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
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
        const next = Math.max(MIN_BUDGET, Math.round(budget * 0.75));
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
