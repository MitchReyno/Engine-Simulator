// 2D instrumentation: oscilloscope, spectrogram, P-V, p-theta, tract pressure,
// valve timing. All data comes from the audio thread (snapshot / analyser).

import type { EngineAudio } from '../audio/engine-audio';
import type { TopologyInfo } from '../sim/engine';
import { P_ATM } from '../sim/gas';
import { CAM_EXPONENTS, DEG, camLift, valveEvents } from '../sim/kinematics';
import { LAYOUT_KINDS, resolveLayout } from '../sim/layouts';
import { Params } from '../sim/params';
import { C, H, SnapshotView, TRACE_BINS } from '../sim/snapshot';
import { SCOPE_CYCLES, SPEC_TOPS, VIZ_DEFS } from './viewOptions';

const INK = '#d6dde4';
const MUTED = '#7d8a96';
const GRID = '#222a32';
const AMBER = '#ffb000';
const INTAKE = '#4cc2ff';
const EXHAUST = '#ff7a3c';
const FONT = '10px ui-monospace, SFMono-Regular, Menlo, monospace';

class Plot {
  ctx: CanvasRenderingContext2D;
  w = 1;
  h = 1;
  constructor(public canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }
  /** Match the backing store to the CSS size; returns true if it changed. */
  fit(): boolean {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    const changed = this.canvas.width !== w || this.canvas.height !== h;
    if (changed) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.w = w / dpr;
    this.h = h / dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.font = FONT;
    this.ctx.lineWidth = 1;
    return changed;
  }
  clear(): void {
    this.ctx.clearRect(0, 0, this.w, this.h);
  }
  hline(y: number, color = GRID): void {
    const c = this.ctx;
    c.strokeStyle = color;
    c.beginPath();
    c.moveTo(0, Math.round(y) + 0.5);
    c.lineTo(this.w, Math.round(y) + 0.5);
    c.stroke();
  }
  vline(x: number, color = GRID, y0 = 0, y1 = this.h): void {
    const c = this.ctx;
    c.strokeStyle = color;
    c.beginPath();
    c.moveTo(Math.round(x) + 0.5, y0);
    c.lineTo(Math.round(x) + 0.5, y1);
    c.stroke();
  }
  text(s: string, x: number, y: number, color = MUTED, align: CanvasTextAlign = 'left'): void {
    this.ctx.fillStyle = color;
    this.ctx.textAlign = align;
    this.ctx.fillText(s, x, y);
  }
}

const CYL_HUES = [38, 200, 340, 150, 275, 20, 95, 230, 310, 60, 175, 0];
export const cylColor = (i: number, alpha = 1) => `hsla(${CYL_HUES[i % 12]}, 85%, 62%, ${alpha})`;

function niceMax(v: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / e;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e;
}

export class Instruments {
  private scope: Plot;
  private spec: Plot;
  private pv: Plot;
  private ptheta: Plot;
  private tract: Plot;
  private valves: Plot;
  private time = new Float32Array(16384);
  private freq = new Uint8Array(8192);
  private specImage: HTMLCanvasElement = document.createElement('canvas');
  private palettes: string[][] = [[], [], []];
  private tractLo = 0.6;
  private tractHi = 1.6;
  private tractSig = '';
  private envLo = new Float32Array(0);
  private envHi = new Float32Array(0);
  // slow motion: output folded into one min/max pair per engine-time sample
  private histMin = new Float32Array(65536);
  private histMax = new Float32Array(65536);
  private histPos = 0; private histFill = 0; private histDec = 1;
  private accMin = 0; private accMax = 0; private accN = 0; private lastT = 0;
  private specSig = '';
  selected = 0;
  /** Display options (see viewOptions.ts); the owner may swap in a live object. */
  opt: Record<string, number> = Object.fromEntries(VIZ_DEFS.map((d) => [d.key, d.def]));

  constructor(el: Record<'scope' | 'spec' | 'pv' | 'ptheta' | 'tract' | 'valves', HTMLCanvasElement>) {
    this.scope = new Plot(el.scope);
    this.spec = new Plot(el.spec);
    this.pv = new Plot(el.pv);
    this.ptheta = new Plot(el.ptheta);
    this.tract = new Plot(el.tract);
    this.valves = new Plot(el.valves);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const r = Math.round(255 * Math.min(1, Math.max(0, 1.6 * t - 0.15)));
      const g = Math.round(255 * Math.min(1, Math.max(0, 1.9 * t - 0.75)));
      const b = Math.round(255 * Math.min(1, Math.max(0, t < 0.45 ? 1.3 * t : 0.58 - 1.4 * (t - 0.45) + Math.max(0, 4 * (t - 0.85)))));
      this.palettes[0].push(`rgb(${r},${g},${b})`);
      const ice = Math.round(255 * Math.min(1, t * 1.4)), deep = Math.round(255 * Math.max(0, 2 * t - 1));
      this.palettes[1].push(`rgb(${deep},${Math.round(255 * Math.min(1, Math.max(0, 1.6 * t - 0.3)))},${ice})`);
      const grey = Math.round(255 * t);
      this.palettes[2].push(`rgb(${grey},${grey},${grey})`);
    }
  }

  draw(audio: EngineAudio, p: Params): void {
    const snap = audio.snap;
    this.drawScope(audio, snap, p);
    this.drawSpectrogram(audio, snap);
    this.drawPV(audio, snap, p);
    this.drawPTheta(audio, snap, p);
    this.drawTract(snap, audio.topology);
    this.drawValves(snap, p);
  }

  // ------------------------------------------------------------- oscilloscope
  private drawScope(audio: EngineAudio, snap: SnapshotView | null, p: Params): void {
    const pl = this.scope, o = this.opt;
    pl.fit();
    pl.clear();
    const c = pl.ctx;
    pl.hline(pl.h / 2);
    const feed = audio.scope ?? audio.analyser;
    if (!feed || !snap) return pl.text('output waveform', 6, 12);
    feed.getFloatTimeDomainData(this.time);
    const sr = audio.ctx!.sampleRate, len = this.time.length;
    const rpm = Math.max(200, snap.h(H.rpm));
    const two = snap.h(H.strokes) === 2;
    const cycles = SCOPE_CYCLES[o.scopeCycles | 0] ?? 2;
    // Engine time on the axis: whole cycles fill the plot at any engine speed and any simulation speed.
    const engineSpan = (cycles * (two ? 60 : 120)) / rpm;
    const ts = Math.min(1, Math.max(1e-4, p.timeScale || 1));
    const slow = ts < 0.999;
    const paused = !!(snap.h(H.flags) & 8) || !audio.running;
    // In slow motion one plotted point is one sample of engine time: `dec` output samples folded into a min/max pair.
    const dec = slow ? Math.max(1, Math.round(1 / ts)) : 1;
    if (dec !== this.histDec) {
      this.histDec = dec;
      this.histPos = this.histFill = this.accN = 0;
    }
    const now = audio.ctx!.currentTime;
    let fresh = Math.min(len, Math.max(0, Math.round((now - this.lastT) * sr)));
    this.lastT = now;
    if (!slow || paused) fresh = 0;
    for (let i = len - fresh; i < len; i++) {
      const v = this.time[i];
      if (this.accN === 0) this.accMin = this.accMax = v;
      else if (v < this.accMin) this.accMin = v;
      else if (v > this.accMax) this.accMax = v;
      if (++this.accN >= dec) {
        this.histMin[this.histPos] = this.accMin;
        this.histMax[this.histPos] = this.accMax;
        this.histPos = (this.histPos + 1) & 65535;
        if (this.histFill < 65536) this.histFill++;
        this.accN = 0;
      }
    }
    const want = Math.max(16, Math.round(engineSpan * sr));
    const span = slow ? Math.min(65536, want) : Math.min(len - 2048, want);
    let start = len - span - 1;
    if (!slow && o.scopeTrigger > 0.5) {
      for (let i = start; i > start - 2000 && i > 1; i--) {
        if (this.time[i - 1] < 0 && this.time[i] >= 0) {
          start = i;
          break;
        }
      }
    }
    // sample k of the window, as a low and a high value
    const have = slow ? Math.min(span, this.histFill) : span;
    const lo = (k: number) => (slow ? this.histMin[(this.histPos - have + k) & 65535] : this.time[start + k]);
    const hi = (k: number) => (slow ? this.histMax[(this.histPos - have + k) & 65535] : this.time[start + k]);
    let peak = 0.02;
    for (let k = 0; k < have; k++) peak = Math.max(peak, Math.abs(lo(k)), Math.abs(hi(k)));
    const gain = (pl.h * 0.45) / (o.scopeScale > 0.5 ? 1 : peak);
    const mid = pl.h / 2;
    if (o.scopeGrid > 0.5) {
      const every = pl.w / (cycles * snap.nCyl);
      if (every > 3) for (let x = every; x < pl.w - 1; x += every) pl.vline(x, '#2c3640');
    }
    // the window's right edge is now; a part-filled slow-motion history grows in from the right
    const x0 = pl.w * (1 - have / span);
    const cols = Math.max(1, Math.floor(pl.w - x0));
    c.strokeStyle = AMBER;
    c.fillStyle = 'rgba(255,176,0,0.16)';
    c.lineWidth = 1.2;
    c.beginPath();
    const tops: number[] = [], bots: number[] = [];
    for (let col = 0; col <= cols && have > 1; col++) {
      const k0 = Math.floor((col / cols) * (have - 1)), k1 = Math.max(k0 + 1, Math.floor(((col + 1) / cols) * (have - 1)));
      let a = Infinity, b = -Infinity;
      for (let k = k0; k < k1 && k < have; k++) { const l = lo(k), h = hi(k); if (l < a) a = l; if (h > b) b = h; }
      tops.push(mid - b * gain);
      bots.push(mid - a * gain);
    }
    tops.forEach((y, col) => (col === 0 ? c.moveTo(x0 + col, y) : c.lineTo(x0 + col, y)));
    for (let col = bots.length - 1; col >= 0; col--) c.lineTo(x0 + col, bots[col]);
    if (tops.length) c.closePath();
    c.stroke();
    if (o.scopeFill > 0.5 && tops.length) {
      c.beginPath();
      c.moveTo(x0, mid);
      tops.forEach((y, col) => c.lineTo(x0 + col, 0.5 * (y + bots[col])));
      c.lineTo(x0 + tops.length - 1, mid);
      c.closePath();
      c.fill();
    }
    c.lineWidth = 1;
    const ms = engineSpan * 1000;
    const speed = slow ? ` · ${ts >= 0.1 ? ts.toFixed(2) : ts.toPrecision(1)}× speed, ${(engineSpan / ts) >= 10 ? (engineSpan / ts).toFixed(0) : (engineSpan / ts).toFixed(1)} s to cross` : '';
    pl.text(`${ms >= 100 ? ms.toFixed(0) : ms.toFixed(1)} ms of engine time (${cycles} cycle${cycles > 1 ? 's' : ''})${speed}`, 6, 12);
    pl.text(`peak ${peak.toFixed(2)}`, pl.w - 6, pl.h - 4, MUTED, 'right');
  }

  // -------------------------------------------------------------- spectrogram
  private readonly fLo = 15;
  private get fHi(): number {
    return SPEC_TOPS[this.opt.specTop | 0] ?? 4000;
  }
  private get specLinear(): boolean {
    return this.opt.specAxis > 0.5;
  }
  /** Position of a frequency along the axis, 0 at the bottom to 1 at the top. */
  private fPos(f: number): number {
    return this.specLinear ? f / this.fHi : Math.log(f / this.fLo) / Math.log(this.fHi / this.fLo);
  }
  private posF(u: number): number {
    return this.specLinear ? u * this.fHi : this.fLo * Math.pow(this.fHi / this.fLo, u);
  }
  private fToY(f: number, h: number): number {
    return h - this.fPos(f) * h;
  }
  private specTicks(): number[] {
    const top = this.fHi;
    return this.specLinear ? [0.25, 0.5, 0.75].map((k) => k * top) : [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].filter((f) => f < top * 0.9);
  }
  private drawSpectrum(audio: EngineAudio, snap: SnapshotView | null): void {
    const pl = this.spec, c = pl.ctx, o = this.opt;
    pl.clear();
    const padB = 12, H0 = pl.h - padB;
    for (const f of this.specTicks()) {
      const x = this.fPos(f) * pl.w;
      pl.vline(x, GRID, 0, H0);
      pl.text(f >= 1000 ? `${f / 1000}k` : `${f}`, x, pl.h - 2, MUTED, 'center');
    }
    if (!audio.analyser || !snap) return pl.text('spectrum', 6, 12);
    audio.analyser.getByteFrequencyData(this.freq);
    const binHz = audio.ctx!.sampleRate / audio.analyser.fftSize;
    if (o.specMarks > 0.5) {
      const fire = (snap.h(H.rpm) * snap.nCyl) / (snap.h(H.strokes) === 2 ? 60 : 120);
      for (let k = 1; k <= 12 && fire > 2 && fire * k < this.fHi; k++) pl.vline(this.fPos(fire * k) * pl.w, k === 1 ? AMBER : 'rgba(255,176,0,0.3)', 0, H0);
    }
    c.strokeStyle = INTAKE;
    c.lineWidth = 1.2;
    c.beginPath();
    for (let x = 0; x < pl.w; x++) {
      const b0 = Math.max(1, Math.floor(this.posF(x / pl.w) / binHz)), b1 = Math.max(b0 + 1, Math.ceil(this.posF((x + 1) / pl.w) / binHz));
      let v = 0;
      for (let b = b0; b < b1 && b < this.freq.length; b++) if (this.freq[b] > v) v = this.freq[b];
      const y = H0 - Math.pow(v / 255, 1 / o.specGain) * (H0 - 4);
      x === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    }
    c.stroke();
    c.lineWidth = 1;
  }
  private drawSpectrogram(audio: EngineAudio, snap: SnapshotView | null): void {
    const pl = this.spec, o = this.opt;
    let resized = pl.fit();
    if (pl.w < 60 || pl.h < 8) return;
    if (o.specMode > 0.5) return this.drawSpectrum(audio, snap);
    // a different axis makes the scrolled history meaningless
    const sig = `${o.specTop}|${o.specAxis}`;
    if (sig !== this.specSig) {
      this.specSig = sig;
      resized = true;
    }
    const palette = this.palettes[o.specPalette | 0] ?? this.palettes[0];
    const stepPx = [1, 2, 4][o.specSpeed | 0] ?? 2;
    const c = pl.ctx;
    const gutter = 46;
    const w = Math.max(10, Math.floor(pl.w - gutter)), h = Math.floor(pl.h);
    const img = this.specImage;
    if (resized || img.width !== w || img.height !== h) {
      img.width = w;
      img.height = h;
    }
    const ic = img.getContext('2d')!;
    if (audio.analyser && snap && audio.running && !(snap.h(H.flags) & 8)) {
      audio.analyser.getByteFrequencyData(this.freq);
      const binHz = audio.ctx!.sampleRate / audio.analyser.fftSize;
      ic.drawImage(img, -stepPx, 0);
      for (let y = 0; y < h; y++) {
        const f0 = this.posF((h - y - 1) / h), f1 = this.posF((h - y) / h);
        const b0 = Math.max(1, Math.floor(f0 / binHz)), b1 = Math.max(b0 + 1, Math.ceil(f1 / binHz));
        let v = 0;
        for (let b = b0; b < b1 && b < this.freq.length; b++) if (this.freq[b] > v) v = this.freq[b];
        ic.fillStyle = palette[Math.round(255 * Math.pow(v / 255, 1 / o.specGain))];
        ic.fillRect(w - stepPx, y, stepPx, 1);
      }
    }
    pl.clear();
    c.fillStyle = '#05070a';
    c.fillRect(0, 0, w, h);
    c.drawImage(img, 0, 0, w, h);
    for (const f of this.specTicks()) {
      const y = this.fToY(f, h);
      c.fillStyle = 'rgba(255,255,255,0.10)';
      c.fillRect(0, Math.round(y), w, 1);
      pl.text(f >= 1000 ? `${f / 1000}k` : `${f}`, 3, y - 2, 'rgba(214,221,228,0.55)');
    }
    if (!snap) return pl.text('spectrogram', 6, 12);
    // Firing-frequency harmonics from rpm: k * rpm * cylinders / 120.
    const rpm = snap.h(H.rpm);
    const two = snap.h(H.strokes) === 2;
    const fire = (rpm * snap.nCyl) / (two ? 60 : 120);
    if (fire > 2 && o.specMarks > 0.5) {
      for (let k = 1; k <= 8; k++) {
        const f = fire * k;
        if (f > this.fHi) break;
        const y = this.fToY(f, h);
        c.fillStyle = k === 1 ? AMBER : 'rgba(255,176,0,0.55)';
        c.fillRect(w - 10, Math.round(y), 10 + 8, 1);
        if (k <= 4 || k === 8) pl.text(k === 1 ? `f₁ ${f.toFixed(0)}` : `${k}f`, w + 10, y + 3, k === 1 ? AMBER : MUTED);
      }
      const cyc = rpm / (two ? 60 : 120);
      if (cyc > this.fLo && snap.nCyl > 1) {
        const y = this.fToY(cyc, h);
        c.fillStyle = INTAKE;
        c.fillRect(w - 10, Math.round(y), 18, 1);
        pl.text('cycle', w + 10, y + 3, INTAKE);
      }
    }
  }

  // ----------------------------------------------------------------- P-V
  private geom(p: Params) {
    const bore = p.bore * 1e-3, stroke = p.stroke * 1e-3;
    const r = stroke / 2, l = Math.max(p.rodLength * 1e-3, 0.66 * stroke);
    const ap = 0.25 * Math.PI * bore * bore;
    const vc = (ap * stroke) / (p.compression - 1);
    return { r, l, ap, vc, vd: ap * stroke };
  }
  private drawPV(audio: EngineAudio, snap: SnapshotView | null, p: Params): void {
    const pl = this.pv;
    pl.fit();
    pl.clear();
    const c = pl.ctx;
    const g = this.geom(p);
    const padL = 30, padB = 14, padT = 6, padR = 6;
    const W = pl.w - padL - padR, Hh = pl.h - padT - padB;
    const i = Math.min(this.selected, (snap?.nCyl ?? 1) - 1);
    const tr = audio.traces;
    let pMax = 2e5;
    const bins = snap && snap.h(H.strokes) === 2 ? 360 : TRACE_BINS;
    for (let b = 0; b < bins; b++) pMax = Math.max(pMax, tr[i * TRACE_BINS + b] || 0);
    pMax = niceMax((pMax / 1e5) * 1.05) * 1e5;
    const o = this.opt;
    const log = o.pvAxes > 0.5;
    const vMin = g.vc, vMax = g.vc + g.vd;
    const pMin = 0.2e5;
    const X = (v: number) => padL + (log ? Math.log(v / vMin) / Math.log(vMax / vMin) : (v - (log ? vMin : 0)) / vMax) * W;
    const Y = (pp: number) => padT + Hh - (log ? Math.log(Math.max(pMin, pp) / pMin) / Math.log(pMax / pMin) : pp / pMax) * Hh;
    pl.hline(Y(P_ATM), '#2c3640');
    pl.text('1 atm', padL + 2, Y(P_ATM) - 2);
    pl.vline(X(vMin), GRID, padT, padT + Hh);
    pl.vline(X(vMax), GRID, padT, padT + Hh);
    pl.text('TDC', X(vMin) + 2, pl.h - 3);
    pl.text('BDC', X(vMax) - 2, pl.h - 3, MUTED, 'right');
    pl.text(`${(pMax / 1e5).toFixed(0)} bar`, 2, padT + 9);
    if (!snap) return;
    const vol = (deg: number) => {
      const a = deg * DEG, s = Math.sin(a);
      return g.vc + g.ap * (g.r + g.l - (g.r * Math.cos(a) + Math.sqrt(g.l * g.l - g.r * g.r * s * s)));
    };
    if (o.pvRef > 0.5) {
      c.strokeStyle = '#5b6875';
      c.setLineDash([4, 3]);
      c.beginPath();
      for (let k = 0; k <= 60; k++) {
        const v = vMax - ((vMax - vMin) * k) / 60;
        const x = X(v), y = Y(P_ATM * Math.pow(vMax / v, 1.35));
        k === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.stroke();
      c.setLineDash([]);
    }
    const loop = (cyl: number) => {
      c.beginPath();
      for (let b = 0; b <= bins; b++) {
        const bb = b % bins;
        const x = X(vol(bb + 0.5)), y = Y(tr[cyl * TRACE_BINS + bb] || P_ATM);
        b === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
    };
    if (o.pvAll > 0.5) for (let k = 0; k < snap.nCyl; k++) {
      if (k === i) continue;
      c.strokeStyle = cylColor(k, 0.4);
      loop(k);
      c.stroke();
    }
    c.strokeStyle = cylColor(i);
    c.lineWidth = 1.3;
    loop(i);
    if (o.pvFill > 0.5) {
      c.fillStyle = cylColor(i, 0.14);
      c.fill();
    }
    c.stroke();
    c.lineWidth = 1;
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(X(snap.cyl(i, C.V)), Y(snap.cyl(i, C.p)), 2.5, 0, 7);
    c.fill();
    pl.text(`cyl ${i + 1}  ${log ? 'log-log' : 'linear'}`, pl.w - padR, padT + 9, MUTED, 'right');
  }

  // ------------------------------------------------------------- p vs angle
  private drawPTheta(audio: EngineAudio, snap: SnapshotView | null, p: Params): void {
    const pl = this.ptheta;
    pl.fit();
    pl.clear();
    const c = pl.ctx;
    const padL = 30, padB = 14, padT = 6;
    const W = pl.w - padL - 6, Hh = pl.h - padT - padB;
    const cyc = snap && snap.h(H.strokes) === 2 ? 360 : 720;
    const closeUp = (this.opt.ptView | 0) === 2;
    for (let k = 0; k <= 4; k++) {
      const x = padL + (k / 4) * W;
      pl.vline(x, GRID, padT, padT + Hh);
      const label = closeUp ? (k === 2 ? 'TDC' : `${k * 45 - 90}°`) : `${(k * cyc) / 4}°`;
      pl.text(label, x, pl.h - 3, MUTED, k === 4 ? 'right' : k === 0 ? 'left' : 'center');
    }
    if (!snap) return pl.text('cylinder pressure vs crank angle', padL + 4, padT + 10);
    const n = snap.nCyl;
    const layout = resolveLayout(LAYOUT_KINDS[p.layout | 0] ?? 'inline', p.cylinders | 0, p.bankAngle, p.crank | 0, p.firingOrder | 0, cyc === 360);
    const tr = audio.traces;
    let pMax = 2e5;
    for (let i = 0; i < n; i++) for (let b = 0; b < cyc; b++) pMax = Math.max(pMax, tr[i * TRACE_BINS + b] || 0);
    pMax = niceMax((pMax / 1e5) * 1.05) * 1e5;
    pl.text(`${(pMax / 1e5).toFixed(0)} bar`, 2, padT + 9);
    const sel = Math.min(this.selected, n - 1);
    const o = this.opt;
    const view = o.ptView | 0, logP = o.ptLog > 0.5;
    const pMin = 0.2e5;
    const Y = (pp: number) => padT + Hh - (logP ? Math.log(Math.max(pMin, pp) / pMin) / Math.log(pMax / pMin) : pp / pMax) * Hh;
    // where a cylinder's own angle b (0 = its firing TDC) lands on the axis, 0..1, or -1 when outside the view
    const place = (b: number, fire: number) => {
      if (view === 0) return ((b + fire) % cyc) / cyc;
      if (view === 1) return b / cyc;
      const rel = b > cyc / 2 ? b - cyc : b;
      return rel < -90 || rel > 90 ? -1 : (rel + 90) / 180;
    };
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        if ((pass === 1) !== (i === sel)) continue;
        if (o.ptWhich > 0.5 && i !== sel) continue;
        const fire = layout.n === n ? layout.fire[i] : 0;
        c.strokeStyle = cylColor(i, i === sel ? 1 : 0.5);
        c.lineWidth = i === sel ? 1.5 : 1;
        c.beginPath();
        let prevX = -1, pen = false;
        // the close-up runs from before TDC to after it, so start half a cycle round
        const b0 = view === 2 ? cyc / 2 : 0;
        for (let k = 0; k < cyc; k++) {
          const b = (b0 + k) % cyc;
          const u = place(b, fire);
          if (u < 0) { pen = false; continue; }
          const x = padL + u * W, y = Y(tr[i * TRACE_BINS + b] || 0);
          if (!pen || x < prevX) c.moveTo(x, y);
          else c.lineTo(x, y);
          pen = true;
          prevX = x;
        }
        c.stroke();
      }
    }
    c.lineWidth = 1;
    const selFire = layout.n === n ? layout.fire[sel] : 0;
    if (o.ptPeak > 0.5) {
      let pb = 0;
      for (let b = 0; b < cyc; b++) if ((tr[sel * TRACE_BINS + b] || 0) > (tr[sel * TRACE_BINS + pb] || 0)) pb = b;
      const u = place(pb, selFire), pk = tr[sel * TRACE_BINS + pb] || 0;
      if (u >= 0 && pk > 0) {
        const x = padL + u * W, after = pb > cyc / 2 ? pb - cyc : pb;
        c.fillStyle = '#fff';
        c.beginPath();
        c.arc(x, Y(pk), 2.5, 0, 7);
        c.fill();
        pl.text(`${(pk / 1e5).toFixed(1)} bar at ${after}° after TDC`, x + (u > 0.6 ? -6 : 6), Y(pk) + 10, INK, u > 0.6 ? 'right' : 'left');
      }
    }
    // the crank now: on the shared axis, or on the selected cylinder's own cycle
    const cursor = view === 0 ? (snap.h(H.theta) % cyc) / cyc : place((((snap.h(H.theta) - selFire) % cyc) + cyc) % cyc, 0);
    if (cursor >= 0) pl.vline(padL + cursor * W, 'rgba(255,255,255,0.7)', padT, padT + Hh);
  }

  // ------------------------------------------------------- tract pressure
  private drawTract(snap: SnapshotView | null, topo: TopologyInfo | null): void {
    const pl = this.tract;
    pl.fit();
    pl.clear();
    const c = pl.ctx;
    if (!snap || !topo || topo.nCyl !== snap.nCyl) return pl.text('pressure along intake → cylinder → exhaust', 6, 12);
    const cyl = Math.min(this.selected, topo.nCyl - 1);
    type Seg = { kind: 'pipe' | 'vol'; label: string; width: number; pipe?: number; vol?: number; color: string };
    const segs: Seg[] = [];
    const find = (pred: (q: TopologyInfo['pipes'][number]) => boolean) => topo.pipes.findIndex(pred);
    const pipeSeg = (k: number, label: string, color: string) => segs.push({ kind: 'pipe', label, width: topo.pipes[k].length, pipe: k, color });
    const volSeg = (v: number, label: string, color: string) => segs.push({ kind: 'vol', label, width: 0.09, vol: v, color });
    // Walk the network from this cylinder's intake mouth to the open air at the far end.
    const names: Record<string, string> = { intake: 'intake', snorkel: 'snorkel', charge: 'charge pipe', runner: topo.pipes.some((q) => q.kind === 'transfer') ? 'reed' : 'runner', transfer: 'transfer', header: topo.pipes.some((q) => q.kind === 'transfer') ? 'chamber' : 'header', mid: 'pipe', tail: 'tail' };
    const volNames: Record<string, string> = { airbox: 'airbox', compressor: 'comp.', catalyst: 'cat',  plenum: topo.pipes.some((q) => q.kind === 'transfer') ? 'box' : 'plenum', crankcase: 'crankcase', junction: 'coll.', muffler: 'muffler' };
    // start at the mouth: the snorkel when there is an airbox
    let k = find((q) => q.kind === 'snorkel');
    if (k < 0) k = find((q) => q.kind === 'intake' && (q.cyl === cyl || q.cyl < 0));
    let hot = false;
    for (let guard = 0; guard < 14 && k >= 0; guard++) {
      const q = topo.pipes[k];
      if (q.kind === 'header') hot = true;
      pipeSeg(k, names[q.kind] ?? q.kind, hot ? EXHAUST : INTAKE);
      const v = q.volR;
      if (v <= 0) break;
      const kind = topo.volumes[v].kind;
      if (kind === 'cylinder') volSeg(v, `cyl ${cyl + 1}`, AMBER);
      else volSeg(v, volNames[kind] ?? kind, hot ? EXHAUST : INTAKE);
      if (kind === 'compressor') {
        // no pipe joins the two sides of the compressor: carry on from the charge volume
        const ch = topo.volumes.findIndex((x) => x.kind === 'charge');
        volSeg(ch, 'charge', INTAKE);
        k = find((x) => x.volL === ch);
        continue;
      }
      if (kind === 'turbine') {
        k = find((x) => x.volL === v);
        continue;
      }
      // the turbine wheel sits between the collector and the volume downstream of it
      const tOut = topo.volumes.findIndex((x) => x.kind === 'turbine');
      const next = find((x) => x.volL === v && (x.cyl < 0 || x.cyl === cyl) && (x.kind !== 'intake' || kind === 'airbox') && x.kind !== 'snorkel');
      if (next < 0 && tOut >= 0 && hot && kind === 'junction') {
        volSeg(tOut, 'turbine', EXHAUST);
        k = find((x) => x.volL === tOut);
      } else k = next;
    }
    const total = segs.reduce((s, g) => s + g.width, 0);
    const padL = 30, padB = 22, padT = 6;
    const W = pl.w - padL - 6, Hh = pl.h - padT - padB;

    const o = this.opt;
    const qty = o.trQuantity | 0;
    // pressure in bar, temperature in K, velocity in m/s
    const cellV = (j: number) => (qty === 0 ? snap.cellP(j) / 1e5 : qty === 1 ? snap.cellT(j) : snap.cellU(j));
    const volV = (v: number) => (qty === 0 ? snap.volP(v) / 1e5 : qty === 1 ? snap.volT(v) : 0);
    const pad = qty === 0 ? 0.05 : qty === 1 ? 20 : 5;
    // Auto-range on the pipes only, eased so the axis does not jitter.
    let lo = qty === 0 ? 0.9 : qty === 1 ? 280 : -20, hi = qty === 0 ? 1.1 : qty === 1 ? 400 : 20;
    for (const s of segs) {
      if (s.kind !== 'pipe') continue;
      const q = topo.pipes[s.pipe!];
      for (let j = 0; j < q.cells; j++) {
        const v = cellV(q.offset + j);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    // a different quantity, cylinder or network starts the range and the held extremes afresh
    const sig = `${qty}|${cyl}|${snap.nCells}|${segs.length}`;
    const fresh = sig !== this.tractSig;
    if (fresh) {
      this.tractSig = sig;
      this.tractLo = lo - pad;
      this.tractHi = hi + pad;
    }
    // widen at once, narrow slowly
    this.tractLo = lo - pad < this.tractLo ? lo - pad : this.tractLo + (lo - pad - this.tractLo) * 0.01;
    this.tractHi = hi + pad > this.tractHi ? hi + pad : this.tractHi + (hi + pad - this.tractHi) * 0.01;
    const fixed = qty === 0 && o.trScale > 0.5;
    const yLo = fixed ? 0 : qty === 0 ? Math.max(0, this.tractLo) : this.tractLo, yHi = fixed ? 2.5 : qty === 0 ? Math.min(8, this.tractHi) : this.tractHi;
    const Y = (v: number) => padT + Hh - ((Math.min(yHi, Math.max(yLo, v)) - yLo) / (yHi - yLo)) * Hh;
    const ref = qty === 0 ? P_ATM / 1e5 : qty === 1 ? 293 : 0;
    pl.hline(Y(ref), '#2c3640');
    pl.text(yHi.toFixed(qty === 0 ? 1 : 0), 2, padT + 9);
    pl.text(yLo.toFixed(qty === 0 ? 1 : 0), 2, padT + Hh);
    pl.text(['bar', 'K', 'm/s'][qty], 2, Y(ref) + 3);
    if (this.envLo.length !== snap.nCells || fresh) {
      this.envLo = new Float32Array(snap.nCells).fill(Infinity);
      this.envHi = new Float32Array(snap.nCells).fill(-Infinity);
    }
    const hold = o.trEnvelope > 0.5;

    let x = padL;
    for (const s of segs) {
      const w = (s.width / total) * W;
      if (s.kind === 'vol') {
        const pb = volV(s.vol!);
        c.fillStyle = 'rgba(255,255,255,0.05)';
        c.fillRect(x, padT, w, Hh);
        const y = Y(pb);
        c.fillStyle = s.color;
        c.globalAlpha = 0.35;
        c.fillRect(x, y, w, padT + Hh - y);
        c.globalAlpha = 1;
        c.fillRect(x, y - 1, w, 2);
        if (pb > yHi) pl.text(`${pb.toFixed(0)}`, x + w / 2, padT + 9, s.color, 'center');
        if (o.trGas > 0.5) {
          c.fillStyle = `rgba(138,90,54,${0.9 * snap.volY(s.vol!)})`;
          c.fillRect(x, padT + Hh + 2, w, 4);
        }
      } else {
        const q = topo.pipes[s.pipe!];
        if (hold) {
          // extremes fade back towards the present value over a few seconds
          c.fillStyle = s.color;
          c.globalAlpha = 0.16;
          c.beginPath();
          for (let j = 0; j < q.cells; j++) {
            const k = q.offset + j, v = cellV(k);
            this.envHi[k] = v > this.envHi[k] ? v : this.envHi[k] + (v - this.envHi[k]) * 0.004;
            this.envLo[k] = v < this.envLo[k] ? v : this.envLo[k] + (v - this.envLo[k]) * 0.004;
            const px = x + ((j + 0.5) / q.cells) * w;
            j === 0 ? c.moveTo(px, Y(this.envHi[k])) : c.lineTo(px, Y(this.envHi[k]));
          }
          for (let j = q.cells - 1; j >= 0; j--) c.lineTo(x + ((j + 0.5) / q.cells) * w, Y(this.envLo[q.offset + j]));
          c.closePath();
          c.fill();
          c.globalAlpha = 1;
        }
        c.strokeStyle = s.color;
        c.lineWidth = 1.5;
        c.beginPath();
        for (let j = 0; j < q.cells; j++) {
          const px = x + ((j + 0.5) / q.cells) * w, py = Y(cellV(q.offset + j));
          j === 0 ? c.moveTo(x, py) : 0;
          c.lineTo(px, py);
          if (j === q.cells - 1) c.lineTo(x + w, py);
        }
        c.stroke();
        c.lineWidth = 1;
        if (o.trCells > 0.5) {
          c.fillStyle = s.color;
          for (let j = 0; j < q.cells; j++) c.fillRect(x + ((j + 0.5) / q.cells) * w - 1, Y(cellV(q.offset + j)) - 1, 2.5, 2.5);
        }
        // burned-gas strip: shows reversion into the intake and scavenging
        for (let j = 0; o.trGas > 0.5 && j < q.cells; j++) {
          c.fillStyle = `rgba(138,90,54,${0.9 * snap.cellY(q.offset + j)})`;
          c.fillRect(x + (j / q.cells) * w, padT + Hh + 2, w / q.cells + 0.5, 4);
        }
      }
      if (c.measureText(s.label).width < w - 2) pl.text(s.label, x + w / 2, pl.h - 3, MUTED, 'center');
      x += w;
      pl.vline(x, GRID, padT, padT + Hh);
    }
  }

  // --------------------------------------------------------- valve timing
  private drawValves(snap: SnapshotView | null, p: Params): void {
    const pl = this.valves;
    pl.fit();
    pl.clear();
    const c = pl.ctx;
    const padL = 6, padB = 14, padT = 16;
    const W = pl.w - padL - 6, Hh = pl.h - padT - padB;
    if (p.strokes > 0.5) return this.drawPorts(snap, p, padL, padB, padT, W, Hh);
    const ev = valveEvents(p.intakeDuration, p.exhaustDuration, p.lsa, p.camAdvance);
    // Live variable valvetrain state: phaser advance and which lobes are locked in.
    const vtc = snap ? snap.h(H.vtc) : 0;
    const vt = p.vtec | 0, high = !!snap && snap.h(H.vtec) > 0.5;
    const inHigh = vt === 0 || high, exHigh = vt !== 1 || high;
    const iDur = inHigh ? p.intakeDuration : Math.min(p.lowIntakeDuration, p.intakeDuration), eDur = exHigh ? p.exhaustDuration : Math.min(p.lowExhaustDuration, p.exhaustDuration);
    const iLift = inHigh ? p.intakeLift : p.lowIntakeLift, eLift = exHigh ? p.exhaustLift : p.lowExhaustLift;
    ev.intakeCentre -= vtc;
    ev.ivo = ev.intakeCentre - iDur / 2;
    ev.ivc = ev.intakeCentre + iDur / 2;
    ev.evo = ev.exhaustCentre - eDur / 2;
    ev.evc = ev.exhaustCentre + eDur / 2;
    ev.overlap = Math.max(0, ev.evc - ev.ivo);
    const X = (d: number) => padL + (d / 720) * W;
    const maxLift = Math.max(p.intakeLift, p.exhaustLift, 1);
    const Y = (mm: number) => padT + Hh - (mm / maxLift) * Hh * 0.92;
    const names = ['TDC', 'BDC', 'TDC', 'BDC', 'TDC'];
    const strokes = ['power', 'exhaust', 'intake', 'compression'];
    for (let k = 0; k <= 4; k++) {
      pl.vline(X(k * 180), GRID, padT, padT + Hh);
      pl.text(names[k], X(k * 180), pl.h - 3, MUTED, k === 0 ? 'left' : k === 4 ? 'right' : 'center');
      if (k < 4) pl.text(strokes[k], X(k * 180 + 90), padT - 5, '#55616c', 'center');
    }
    const o = this.opt;
    if (ev.overlap > 0 && o.vlOverlap > 0.5) {
      c.fillStyle = 'rgba(255,255,255,0.07)';
      c.fillRect(X(ev.ivo), padT, X(ev.evc) - X(ev.ivo), Hh);
    }
    // piston position, faint
    const g = this.geom(p);
    c.strokeStyle = '#2f3943';
    c.beginPath();
    for (let d = 0; o.vlPiston > 0.5 && d <= 720; d += 4) {
      const a = d * DEG, s = Math.sin(a);
      const xp = (g.r + g.l - (g.r * Math.cos(a) + Math.sqrt(g.l * g.l - g.r * g.r * s * s))) / (2 * g.r);
      const y = padT + xp * Hh * 0.92 + Hh * 0.04;
      d === 0 ? c.moveTo(X(d), y) : c.lineTo(X(d), y);
    }
    c.stroke();
    const curve = (centre: number, dur: number, lift: number, color: string, idle = false) => {
      c.strokeStyle = color;
      c.fillStyle = color;
      c.lineWidth = idle ? 1 : 1.6;
      c.globalAlpha = idle ? 0.35 : 1;
      c.setLineDash(idle ? [3, 3] : []);
      c.beginPath();
      for (let d = 0; d <= 720; d += 2) {
        const y = Y(camLift(d, centre, dur, lift, CAM_EXPONENTS[p.camProfile | 0] ?? 2));
        d === 0 ? c.moveTo(X(d), y) : c.lineTo(X(d), y);
      }
      c.stroke();
      c.lineWidth = 1;
      c.globalAlpha = 1;
      c.setLineDash([]);
    };
    // The lobes not in use are drawn dashed.
    if (vt > 0) curve(ev.intakeCentre, inHigh ? Math.min(p.lowIntakeDuration, p.intakeDuration) : p.intakeDuration, inHigh ? p.lowIntakeLift : p.intakeLift, INTAKE, true);
    if (vt === 1) curve(ev.exhaustCentre, exHigh ? Math.min(p.lowExhaustDuration, p.exhaustDuration) : p.exhaustDuration, exHigh ? p.lowExhaustLift : p.exhaustLift, EXHAUST, true);
    curve(ev.exhaustCentre, eDur, eLift, EXHAUST);
    curve(ev.intakeCentre, iDur, iLift, INTAKE);
    // spark
    const spark = (((720 - p.ignitionAdvance) % 720) + 720) % 720;
    if (o.vlSpark > 0.5) {
      pl.vline(X(spark), AMBER, padT + Hh * 0.55, padT + Hh);
      pl.text('spark', X(spark) - 3, padT + Hh - 3, AMBER, 'right');
    }
    const f = (v: number) => `${Math.round(v)}°`;
    const tall = Hh > 70;
    if (o.vlLabels > 0.5) {
    pl.text(tall ? `EVO ${f(180 - ev.evo)} BBDC` : `EVO ${f(180 - ev.evo)}`, X(ev.evo) - 4, padT + Hh * 0.72, EXHAUST, 'right');
    pl.text(tall ? `EVC ${f(ev.evc - 360)} ATDC` : '', X(ev.exhaustCentre), Y(eLift) - 4, EXHAUST, 'right');
    pl.text(tall ? `IVO ${f(360 - ev.ivo)} BTDC` : '', X(ev.intakeCentre), Y(iLift) - 4, INTAKE, 'left');
    pl.text(tall ? `IVC ${f(ev.ivc - 540)} ABDC` : `IVC ${f(ev.ivc - 540)}`, X(ev.ivc) + 4, padT + Hh * 0.72, INTAKE, 'left');
    }
    if (snap) {
      const i = Math.min(this.selected, snap.nCyl - 1);
      const a = snap.cyl(i, C.angle);
      pl.vline(X(a), 'rgba(255,255,255,0.8)', padT, padT + Hh);
      c.fillStyle = INTAKE;
      c.beginPath();
      c.arc(X(a), Y(snap.cyl(i, C.liftIn) * 1e3), 3, 0, 7);
      c.fill();
      c.fillStyle = EXHAUST;
      c.beginPath();
      c.arc(X(a), Y(snap.cyl(i, C.liftEx) * 1e3), 3, 0, 7);
      c.fill();
    }
  }

  /** Two-stroke: port open heights against crank angle over one revolution. */
  private drawPorts(snap: SnapshotView | null, p: Params, padL: number, padB: number, padT: number, W: number, Hh: number): void {
    const pl = this.valves;
    const c = pl.ctx;
    const g = this.geom(p);
    const travel = (deg: number) => {
      const a = deg * DEG, s = Math.sin(a);
      return g.r + g.l - (g.r * Math.cos(a) + Math.sqrt(g.l * g.l - g.r * g.r * s * s));
    };
    const epo = p.exhaustPortOpen, tpo = Math.max(p.transferPortOpen, epo + 2);
    const xE = travel(epo), xT = travel(tpo), stroke = 2 * g.r;
    const X = (d: number) => padL + (d / 360) * W;
    const Y = (h: number) => padT + Hh - (h / (stroke - xE)) * Hh * 0.9;
    for (const [d, name] of [[0, 'TDC'], [180, 'BDC'], [360, 'TDC']] as [number, string][]) {
      pl.vline(X(d), GRID, padT, padT + Hh);
      pl.text(name, X(d), pl.h - 3, MUTED, d === 0 ? 'left' : d === 360 ? 'right' : 'center');
    }
    pl.text('power', X(45), padT - 5, '#55616c', 'center');
    pl.text('scavenge', X(180), padT - 5, '#55616c', 'center');
    pl.text('compression', X(315), padT - 5, '#55616c', 'center');
    // blowdown: exhaust open, transfers still shut
    c.fillStyle = 'rgba(255,122,60,0.10)';
    c.fillRect(X(epo), padT, X(tpo) - X(epo), Hh);
    const curve = (edge: number, color: string) => {
      c.strokeStyle = color;
      c.lineWidth = 1.6;
      c.beginPath();
      for (let d = 0; d <= 360; d += 2) {
        const y = Y(Math.max(0, travel(d) - edge));
        d === 0 ? c.moveTo(X(d), y) : c.lineTo(X(d), y);
      }
      c.stroke();
      c.lineWidth = 1;
    };
    curve(xE, EXHAUST);
    curve(xT, INTAKE);
    // induction window (piston port or rotary disc)
    const ind = p.induction | 0;
    if (ind > 0) {
      const close = ind === 1 ? p.inductionDuration / 2 : p.inductionClose, open = close - p.inductionDuration;
      c.fillStyle = 'rgba(76,194,255,0.18)';
      c.fillRect(X(0), padT + Hh - 6, X(close) - X(0), 6);
      c.fillRect(X(360 + open), padT + Hh - 6, X(360) - X(360 + open), 6);
      pl.text('induction', X(360 + open) + 2, padT + Hh - 9, INTAKE);
    }
    const spark = 360 - p.ignitionAdvance;
    pl.vline(X(spark), AMBER, padT + Hh * 0.55, padT + Hh);
    pl.text('spark', X(spark) - 3, padT + Hh * 0.55 + 9, AMBER, 'right');
    pl.text(`exhaust opens ${Math.round(epo)}° ATDC`, X(180), Y(stroke - xE) - 3, EXHAUST, 'center');
    pl.text(`transfer ${Math.round(tpo)}°`, X(180), Y(stroke - xT) + 11, INTAKE, 'center');
    if (snap) {
      const i = Math.min(this.selected, snap.nCyl - 1);
      const a = snap.cyl(i, C.angle);
      pl.vline(X(a), 'rgba(255,255,255,0.8)', padT, padT + Hh);
      c.fillStyle = EXHAUST;
      c.beginPath(); c.arc(X(a), Y(snap.cyl(i, C.liftEx)), 3, 0, 7); c.fill();
      c.fillStyle = INTAKE;
      c.beginPath(); c.arc(X(a), Y(snap.cyl(i, C.liftIn)), 3, 0, 7); c.fill();
    }
    void padB;
  }
}
