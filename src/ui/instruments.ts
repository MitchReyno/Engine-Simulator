// 2D instrumentation: oscilloscope, spectrogram, P-V, p-theta, tract pressure,
// valve timing. All data comes from the audio thread (snapshot / analyser).

import type { EngineAudio } from '../audio/engine-audio';
import type { TopologyInfo } from '../sim/engine';
import { P_ATM } from '../sim/gas';
import { DEG, camLift, valveEvents } from '../sim/kinematics';
import { LAYOUT_KINDS, resolveLayout } from '../sim/layouts';
import { Params } from '../sim/params';
import { C, H, SnapshotView, TRACE_BINS } from '../sim/snapshot';

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
  private palette: string[] = [];
  private tractLo = 0.6;
  private tractHi = 1.6;
  selected = 0;
  pvLog = false;

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
      this.palette.push(`rgb(${r},${g},${b})`);
    }
  }

  draw(audio: EngineAudio, p: Params): void {
    const snap = audio.snap;
    this.drawScope(audio, snap);
    this.drawSpectrogram(audio, snap);
    this.drawPV(audio, snap, p);
    this.drawPTheta(audio, snap, p);
    this.drawTract(snap, audio.topology);
    this.drawValves(snap, p);
  }

  // ------------------------------------------------------------- oscilloscope
  private drawScope(audio: EngineAudio, snap: SnapshotView | null): void {
    const pl = this.scope;
    pl.fit();
    pl.clear();
    const c = pl.ctx;
    pl.hline(pl.h / 2);
    if (!audio.analyser || !snap) return pl.text('output waveform', 6, 12);
    audio.analyser.getFloatTimeDomainData(this.time);
    const sr = audio.ctx!.sampleRate;
    const rpm = Math.max(200, snap.h(H.rpm));
    // Show two engine cycles so the firing pattern is stable on screen.
    const span = Math.min(this.time.length - 2048, Math.round(((2 * 120) / rpm) * sr));
    let start = this.time.length - span - 1;
    for (let i = start; i > start - 2000 && i > 1; i--) {
      if (this.time[i - 1] < 0 && this.time[i] >= 0) {
        start = i;
        break;
      }
    }
    let peak = 0.02;
    for (let i = start; i < start + span; i++) peak = Math.max(peak, Math.abs(this.time[i]));
    const gain = (pl.h * 0.45) / peak;
    c.strokeStyle = AMBER;
    c.lineWidth = 1.2;
    c.beginPath();
    const step = Math.max(1, Math.floor(span / (pl.w * 2)));
    for (let i = 0; i < span; i += step) {
      const x = (i / span) * pl.w, y = pl.h / 2 - this.time[start + i] * gain;
      i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    }
    c.stroke();
    c.lineWidth = 1;
    pl.text(`${((span / sr) * 1000).toFixed(0)} ms (2 cycles)`, 6, 12);
    pl.text(`peak ${peak.toFixed(2)}`, pl.w - 6, 12, MUTED, 'right');
  }

  // -------------------------------------------------------------- spectrogram
  private readonly fLo = 15;
  private readonly fHi = 4000;
  private fToY(f: number, h: number): number {
    return h - (Math.log(f / this.fLo) / Math.log(this.fHi / this.fLo)) * h;
  }
  private drawSpectrogram(audio: EngineAudio, snap: SnapshotView | null): void {
    const pl = this.spec;
    const resized = pl.fit();
    if (pl.w < 60 || pl.h < 8) return;
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
      ic.drawImage(img, -2, 0);
      for (let y = 0; y < h; y++) {
        const f0 = this.fLo * Math.pow(this.fHi / this.fLo, (h - y - 1) / h);
        const f1 = this.fLo * Math.pow(this.fHi / this.fLo, (h - y) / h);
        const b0 = Math.max(1, Math.floor(f0 / binHz)), b1 = Math.max(b0 + 1, Math.ceil(f1 / binHz));
        let v = 0;
        for (let b = b0; b < b1 && b < this.freq.length; b++) if (this.freq[b] > v) v = this.freq[b];
        ic.fillStyle = this.palette[v];
        ic.fillRect(w - 2, y, 2, 1);
      }
    }
    pl.clear();
    c.fillStyle = '#05070a';
    c.fillRect(0, 0, w, h);
    c.drawImage(img, 0, 0, w, h);
    for (const f of [20, 50, 100, 200, 500, 1000, 2000]) {
      const y = this.fToY(f, h);
      c.fillStyle = 'rgba(255,255,255,0.10)';
      c.fillRect(0, Math.round(y), w, 1);
      pl.text(f >= 1000 ? `${f / 1000}k` : `${f}`, 3, y - 2, 'rgba(214,221,228,0.55)');
    }
    if (!snap) return pl.text('spectrogram', 6, 12);
    // Firing-frequency harmonics from rpm: k * rpm * cylinders / 120.
    const rpm = snap.h(H.rpm);
    const fire = (rpm * snap.nCyl) / 120;
    if (fire > 2) {
      for (let k = 1; k <= 8; k++) {
        const f = fire * k;
        if (f > this.fHi) break;
        const y = this.fToY(f, h);
        c.fillStyle = k === 1 ? AMBER : 'rgba(255,176,0,0.55)';
        c.fillRect(w - 10, Math.round(y), 10 + 8, 1);
        if (k <= 4 || k === 8) pl.text(k === 1 ? `f₁ ${f.toFixed(0)}` : `${k}f`, w + 10, y + 3, k === 1 ? AMBER : MUTED);
      }
      const cyc = rpm / 120;
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
    for (let b = 0; b < TRACE_BINS; b++) pMax = Math.max(pMax, tr[i * TRACE_BINS + b] || 0);
    pMax = niceMax((pMax / 1e5) * 1.05) * 1e5;
    const log = this.pvLog;
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
    c.strokeStyle = cylColor(i);
    c.lineWidth = 1.3;
    c.beginPath();
    for (let b = 0; b <= TRACE_BINS; b++) {
      const bb = b % TRACE_BINS;
      const x = X(vol(bb + 0.5)), y = Y(tr[i * TRACE_BINS + bb] || P_ATM);
      b === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
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
    for (let d = 0; d <= 720; d += 180) {
      const x = padL + (d / 720) * W;
      pl.vline(x, GRID, padT, padT + Hh);
      pl.text(`${d}°`, x, pl.h - 3, MUTED, d === 720 ? 'right' : d === 0 ? 'left' : 'center');
    }
    if (!snap) return pl.text('cylinder pressure vs crank angle', padL + 4, padT + 10);
    const n = snap.nCyl;
    const layout = resolveLayout(LAYOUT_KINDS[p.layout | 0] ?? 'inline', p.cylinders | 0, p.bankAngle, p.crank | 0, p.firingOrder | 0);
    const tr = audio.traces;
    let pMax = 2e5;
    for (let b = 0; b < n * TRACE_BINS; b++) pMax = Math.max(pMax, tr[b] || 0);
    pMax = niceMax((pMax / 1e5) * 1.05) * 1e5;
    pl.text(`${(pMax / 1e5).toFixed(0)} bar`, 2, padT + 9);
    const sel = Math.min(this.selected, n - 1);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        if ((pass === 1) !== (i === sel)) continue;
        const fire = layout.n === n ? layout.fire[i] : 0;
        c.strokeStyle = cylColor(i, i === sel ? 1 : 0.5);
        c.lineWidth = i === sel ? 1.5 : 1;
        c.beginPath();
        let prevX = -1;
        for (let b = 0; b < TRACE_BINS; b++) {
          // plot against the global crank angle so the firing order reads left to right
          const g = (b + fire) % 720;
          const x = padL + (g / 720) * W, y = padT + Hh - ((tr[i * TRACE_BINS + b] || 0) / pMax) * Hh;
          if (b === 0 || x < prevX) c.moveTo(x, y);
          else c.lineTo(x, y);
          prevX = x;
        }
        c.stroke();
      }
    }
    c.lineWidth = 1;
    pl.vline(padL + (snap.h(H.theta) / 720) * W, 'rgba(255,255,255,0.7)', padT, padT + Hh);
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
    pipeSeg(find((q) => q.kind === 'intake'), 'intake', INTAKE);
    volSeg(1, 'plenum', INTAKE);
    pipeSeg(find((q) => q.kind === 'runner' && q.cyl === cyl), 'runner', INTAKE);
    volSeg(2 + cyl, `cyl ${cyl + 1}`, AMBER);
    const hk = find((q) => q.kind === 'header' && q.cyl === cyl);
    pipeSeg(hk, 'header', EXHAUST);
    let v = topo.pipes[hk].volR;
    for (let guard = 0; guard < 4 && v > 0; guard++) {
      const kind = topo.volumes[v].kind;
      volSeg(v, kind === 'junction' ? 'coll.' : kind, EXHAUST);
      const next = find((q) => q.volL === v && (q.kind === 'mid' || q.kind === 'tail'));
      if (next < 0) break;
      pipeSeg(next, topo.pipes[next].kind === 'mid' ? 'pipe' : 'tail', EXHAUST);
      v = topo.pipes[next].volR;
    }
    const total = segs.reduce((s, g) => s + g.width, 0);
    const padL = 30, padB = 22, padT = 6;
    const W = pl.w - padL - 6, Hh = pl.h - padT - padB;

    // Auto-range on pipe pressures only, eased so the axis does not jitter.
    let lo = 0.9, hi = 1.1;
    for (const s of segs) {
      if (s.kind !== 'pipe') continue;
      const q = topo.pipes[s.pipe!];
      for (let j = 0; j < q.cells; j++) {
        const pb = snap.cellP(q.offset + j) / 1e5;
        if (pb < lo) lo = pb;
        if (pb > hi) hi = pb;
      }
    }
    // widen at once, narrow slowly
    this.tractLo = lo - 0.05 < this.tractLo ? lo - 0.05 : this.tractLo + (lo - 0.05 - this.tractLo) * 0.01;
    this.tractHi = hi + 0.05 > this.tractHi ? hi + 0.05 : this.tractHi + (hi + 0.05 - this.tractHi) * 0.01;
    const yLo = Math.max(0, this.tractLo), yHi = Math.min(8, this.tractHi);
    const Y = (bar: number) => padT + Hh - ((Math.min(yHi, Math.max(yLo, bar)) - yLo) / (yHi - yLo)) * Hh;
    pl.hline(Y(P_ATM / 1e5), '#2c3640');
    pl.text(yHi.toFixed(1), 2, padT + 9);
    pl.text(yLo.toFixed(1), 2, padT + Hh);
    pl.text('bar', 2, Y(P_ATM / 1e5) + 3);

    let x = padL;
    for (const s of segs) {
      const w = (s.width / total) * W;
      if (s.kind === 'vol') {
        const pb = snap.volP(s.vol!) / 1e5;
        c.fillStyle = 'rgba(255,255,255,0.05)';
        c.fillRect(x, padT, w, Hh);
        const y = Y(pb);
        c.fillStyle = s.color;
        c.globalAlpha = 0.35;
        c.fillRect(x, y, w, padT + Hh - y);
        c.globalAlpha = 1;
        c.fillRect(x, y - 1, w, 2);
        if (pb > yHi) pl.text(`${pb.toFixed(0)}`, x + w / 2, padT + 9, s.color, 'center');
        c.fillStyle = `rgba(138,90,54,${0.9 * snap.volY(s.vol!)})`;
        c.fillRect(x, padT + Hh + 2, w, 4);
      } else {
        const q = topo.pipes[s.pipe!];
        c.strokeStyle = s.color;
        c.lineWidth = 1.5;
        c.beginPath();
        for (let j = 0; j < q.cells; j++) {
          const px = x + ((j + 0.5) / q.cells) * w, py = Y(snap.cellP(q.offset + j) / 1e5);
          j === 0 ? c.moveTo(x, py) : 0;
          c.lineTo(px, py);
          if (j === q.cells - 1) c.lineTo(x + w, py);
        }
        c.stroke();
        c.lineWidth = 1;
        // burned-gas strip: shows reversion into the intake and scavenging
        for (let j = 0; j < q.cells; j++) {
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
    const ev = valveEvents(p.intakeDuration, p.exhaustDuration, p.lsa, p.camAdvance);
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
    if (ev.overlap > 0) {
      c.fillStyle = 'rgba(255,255,255,0.07)';
      c.fillRect(X(ev.ivo), padT, X(ev.evc) - X(ev.ivo), Hh);
    }
    // piston position, faint
    const g = this.geom(p);
    c.strokeStyle = '#2f3943';
    c.beginPath();
    for (let d = 0; d <= 720; d += 4) {
      const a = d * DEG, s = Math.sin(a);
      const xp = (g.r + g.l - (g.r * Math.cos(a) + Math.sqrt(g.l * g.l - g.r * g.r * s * s))) / (2 * g.r);
      const y = padT + xp * Hh * 0.92 + Hh * 0.04;
      d === 0 ? c.moveTo(X(d), y) : c.lineTo(X(d), y);
    }
    c.stroke();
    const curve = (centre: number, dur: number, lift: number, color: string) => {
      c.strokeStyle = color;
      c.fillStyle = color;
      c.lineWidth = 1.6;
      c.beginPath();
      for (let d = 0; d <= 720; d += 2) {
        const y = Y(camLift(d, centre, dur, lift));
        d === 0 ? c.moveTo(X(d), y) : c.lineTo(X(d), y);
      }
      c.stroke();
      c.lineWidth = 1;
    };
    curve(ev.exhaustCentre, p.exhaustDuration, p.exhaustLift, EXHAUST);
    curve(ev.intakeCentre, p.intakeDuration, p.intakeLift, INTAKE);
    // spark
    const spark = (((720 - p.ignitionAdvance) % 720) + 720) % 720;
    pl.vline(X(spark), AMBER, padT + Hh * 0.55, padT + Hh);
    pl.text('spark', X(spark) - 3, padT + Hh - 3, AMBER, 'right');
    const f = (v: number) => `${Math.round(v)}°`;
    const tall = Hh > 70;
    pl.text(tall ? `EVO ${f(180 - ev.evo)} BBDC` : `EVO ${f(180 - ev.evo)}`, X(ev.evo) - 4, padT + Hh * 0.72, EXHAUST, 'right');
    pl.text(tall ? `EVC ${f(ev.evc - 360)} ATDC` : '', X(ev.exhaustCentre), Y(p.exhaustLift) - 4, EXHAUST, 'right');
    pl.text(tall ? `IVO ${f(360 - ev.ivo)} BTDC` : '', X(ev.intakeCentre), Y(p.intakeLift) - 4, INTAKE, 'left');
    pl.text(tall ? `IVC ${f(ev.ivc - 540)} ABDC` : `IVC ${f(ev.ivc - 540)}`, X(ev.ivc) + 4, padT + Hh * 0.72, INTAKE, 'left');
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
}
