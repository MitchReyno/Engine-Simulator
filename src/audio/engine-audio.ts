// Main-thread side of the audio engine: context, worklet node, analyser and
// the latest simulation snapshot for the views.

import type { TopologyInfo } from '../sim/engine';
import { Params } from '../sim/params';
import { H, SNAP_MAX_FLOATS, SnapshotView, TRACE_BINS } from '../sim/snapshot';
import workletUrl from './engine-worklet.ts?worker&url';

export class EngineAudio {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  analyser: AnalyserNode | null = null;
  /** Unfaded, pre-volume waveform for the oscilloscope. */
  scope: AnalyserNode | null = null;
  private gain: GainNode | null = null;

  /** Latest state; null until the first snapshot arrives. */
  snap: SnapshotView | null = null;
  private state = new Float32Array(SNAP_MAX_FLOATS);
  /** Pressure traces, nCyl x 720 bins. */
  traces = new Float32Array(12 * TRACE_BINS);
  topology: TopologyInfo | null = null;
  snapshotCount = 0;

  onTopology: (t: TopologyInfo) => void = () => {};
  onQuality: (cellBudget: number, load: number) => void = () => {};

  get running(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  async start(params: Params): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'engine-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 2,
      outputChannelCount: [2, 1],
      processorOptions: { params },
    });
    node.port.onmessage = (e) => this.onMessage(e.data);
    const gain = ctx.createGain();
    gain.gain.value = (params.volume ?? 70) / 100;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 16384;
    analyser.smoothingTimeConstant = 0.5;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;
    // the waveform display listens to its own feed, kept alive by a silent path to the output
    const scope = ctx.createAnalyser();
    scope.fftSize = 16384;
    const hush = ctx.createGain();
    hush.gain.value = 0;
    node.connect(scope, 1);
    scope.connect(hush);
    hush.connect(ctx.destination);
    this.scope = scope;
    node.connect(gain, 0);
    gain.connect(analyser);
    analyser.connect(ctx.destination);
    this.ctx = ctx;
    this.node = node;
    this.gain = gain;
    this.analyser = analyser;
    await ctx.resume();
  }

  async suspend(): Promise<void> {
    await this.ctx?.suspend();
  }

  private onMessage(m: any): void {
    if (m.type === 'snapshot') {
      const src = new Float32Array(m.buffer);
      const view = new SnapshotView(src);
      const used = view.traceBase;
      this.state.set(src.subarray(0, used));
      if (src[H.hasTraces]) this.traces.set(src.subarray(used, used + view.nCyl * TRACE_BINS));
      if (!this.snap) this.snap = new SnapshotView(this.state);
      this.snapshotCount++;
      this.node!.port.postMessage({ type: 'recycle', buffer: m.buffer }, [m.buffer]);
    } else if (m.type === 'topology') {
      this.topology = m.info;
      this.onTopology(m.info);
    } else if (m.type === 'recording') {
      this.onRecording?.(new Float32Array(m.buffer));
      this.onRecording = null;
    } else if (m.type === 'quality') {
      this.onQuality(m.cellBudget, m.load);
    }
  }

  setParams(values: Params): void {
    this.node?.port.postMessage({ type: 'params', values });
    if (values.volume !== undefined && this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(values.volume / 100, this.ctx.currentTime, 0.03);
    }
  }

  stepDegrees(degrees: number): void {
    this.node?.port.postMessage({ type: 'step', degrees });
  }

  private onRecording: ((x: Float32Array) => void) | null = null;

  /** Capture the next few seconds of output exactly as played (before the volume control). */
  record(seconds: number): Promise<Float32Array> {
    return new Promise((resolve) => {
      this.onRecording = resolve;
      this.node?.port.postMessage({ type: 'record', seconds });
    });
  }

  shift(dir: number): void {
    this.node?.port.postMessage({ type: 'shift', dir });
  }

  resetCar(grid: boolean): void {
    this.node?.port.postMessage({ type: 'carReset', grid });
  }

  autoStart(): void {
    this.node?.port.postMessage({ type: 'autostart' });
  }
}
