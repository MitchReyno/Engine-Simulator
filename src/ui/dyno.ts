// Dynamometer: runs a full-throttle (or part-throttle) pull on the live engine and plots the results.
// The engine is held by the simulation's speed-controlled brake; this file sets the speed, reads the
// cycle-averaged torque back, and draws the curves. Nothing here is computed apart from the engine.

import type { EngineAudio } from '../audio/engine-audio';
import { RHO_ATM } from '../sim/gas';
import { Params } from '../sim/params';
import { H } from '../sim/snapshot';

export interface DynoPoint { rpm: number; torque: number; power: number; ve: number; map: number; boost: number; turbo: number; spl: number; air: number; bsfc: number; bmep: number }
export interface DynoRun { id: number; name: string; color: string; visible: boolean; kind: 'sweep' | 'steps'; throttle: number; points: DynoPoint[] }

export interface DynoHost {
  audio: EngineAudio;
  params(): Params;
  setParam(key: string, value: number): void;
  /** Send values straight to the simulation (for the brake, which has no slider). */
  push(values: Params): void;
  presetName(): string;
}

type Channel = keyof Omit<DynoPoint, 'rpm' | 'torque' | 'power'>;
const CHANNELS: { key: Channel; label: string; unit: string; digits: number }[] = [
  { key: 've', label: 'Volumetric efficiency', unit: '%', digits: 0 },
  { key: 'map', label: 'Manifold pressure', unit: 'kPa', digits: 0 },
  { key: 'bmep', label: 'Brake mean effective pressure', unit: 'bar', digits: 1 },
  { key: 'air', label: 'Air flow', unit: 'g/s', digits: 0 },
  { key: 'bsfc', label: 'Fuel used per unit of work (BSFC)', unit: 'g/kWh', digits: 0 },
  { key: 'spl', label: 'Sound level at the microphone', unit: 'dB', digits: 0 },
  { key: 'boost', label: 'Boost pressure', unit: 'kPa', digits: 0 },
  { key: 'turbo', label: 'Compressor speed', unit: 'k rpm', digits: 0 },
];
const COLORS = ['#ffb000', '#4cc2ff', '#ff5a7a', '#7ddc7a', '#c59bff', '#ff8f3c', '#5fe0d0', '#e0e06a'];
const STORE = 'engine-sim.dyno.v1';
const BIN = 100;
const MUTED = '#7d8a96', GRID = '#222a32', INK = '#d6dde4';
const FONT = '10px ui-monospace, SFMono-Regular, Menlo, monospace';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
/** Round an axis maximum up to a value whose quarters read cleanly. */
export const nice = (v: number) => { const e = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, v)))); const m = v / e; return (m <= 1 ? 1 : m <= 1.2 ? 1.2 : m <= 1.6 ? 1.6 : m <= 2 ? 2 : m <= 2.4 ? 2.4 : m <= 3.2 ? 3.2 : m <= 4 ? 4 : m <= 6 ? 6 : m <= 8 ? 8 : 10) * e; };

/** Value of a channel at an engine speed, by straight-line interpolation; null outside the run. */
export function sampleRun(run: DynoRun, rpm: number, key: keyof DynoPoint): number | null {
  const p = run.points;
  if (!p.length || rpm < p[0].rpm || rpm > p[p.length - 1].rpm) return null;
  let i = 1;
  while (i < p.length - 1 && p[i].rpm < rpm) i++;
  const a = p[i - 1] ?? p[0], b = p[i] ?? p[0];
  const t = b.rpm > a.rpm ? (rpm - a.rpm) / (b.rpm - a.rpm) : 0;
  return a[key] + (b[key] - a[key]) * t;
}

export function peak(run: DynoRun, key: 'torque' | 'power'): DynoPoint | null {
  let best: DynoPoint | null = null;
  for (const p of run.points) if (!best || p[key] > best[key]) best = p;
  return best;
}

/** Moving average over 2k+1 points; the ends use what neighbours they have. */
export function smooth(points: DynoPoint[], k: number): DynoPoint[] {
  if (k <= 0) return points;
  return points.map((p, i) => {
    const out = { ...p };
    for (const key of Object.keys(p) as (keyof DynoPoint)[]) {
      if (key === 'rpm') continue;
      let s = 0, n = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(points.length - 1, i + k); j++) { s += points[j][key]; n++; }
      out[key] = s / n;
    }
    return out;
  });
}

export function runsToCsv(runs: DynoRun[]): string {
  const cols: (keyof DynoPoint)[] = ['rpm', 'torque', 'power', 've', 'map', 'bmep', 'air', 'bsfc', 'spl', 'boost', 'turbo'];
  const head = ['run', 'rpm', 'torque_Nm', 'power_kW', 've_pct', 'map_kPa', 'bmep_bar', 'air_g_s', 'bsfc_g_kWh', 'spl_dB', 'boost_kPa', 'compressor_krpm'];
  const lines = [head.join(',')];
  for (const r of runs) for (const p of r.points) lines.push([`"${r.name.replace(/"/g, '""')}"`, ...cols.map((c) => p[c].toFixed(c === 'rpm' ? 0 : 2))].join(','));
  return lines.join('\n');
}

export class Dyno {
  runs: DynoRun[] = [];
  private state: 'idle' | 'settle' | 'sweep' | 'steps' = 'idle';
  private live: DynoRun | null = null;
  private target = 0; private from = 2000; private to = 7000; private rate = 500; private step = 500;
  private timer = 0; private held = 0;
  private bins = new Map<number, { n: number; sum: DynoPoint }>();
  private acc: { n: number; sum: DynoPoint } | null = null;
  private before: { throttle: number } | null = null;
  private nextId = 1;
  private hover: number | null = null;
  private imperial = false;
  private smoothing = 1;
  private channel: Channel = 've';
  private kind: 'sweep' | 'steps' = 'sweep';

  private main: HTMLCanvasElement; private lower: HTMLCanvasElement;
  private status: HTMLElement; private list: HTMLElement; private runBtn: HTMLButtonElement; private readout: HTMLElement;
  private inputs: Record<'from' | 'to' | 'rate' | 'step' | 'throttle', HTMLInputElement>;

  constructor(private root: HTMLElement, private host: DynoHost) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? '[]') as DynoRun[];
      if (Array.isArray(saved)) this.runs = saved.filter((r) => r && Array.isArray(r.points) && r.points.length > 1);
      this.nextId = 1 + Math.max(0, ...this.runs.map((r) => r.id));
    } catch {
      // no saved runs
    }
    const bar = el('div', 'dyno-bar');
    const field = (label: string, value: number, min: number, max: number, step: number, unit: string) => {
      const wrap = el('label', 'dyno-field');
      wrap.appendChild(el('span', undefined, label));
      const input = el('input');
      input.type = 'number';
      input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
      wrap.appendChild(input);
      wrap.appendChild(el('span', 'muted', unit));
      bar.appendChild(wrap);
      return input;
    };
    const kindSel = el('select');
    kindSel.append(new Option('Sweep (continuous pull)', 'sweep'), new Option('Steps (held at each speed)', 'steps'));
    kindSel.title = 'A sweep raises the speed steadily, like a roller-dyno pull. Steps hold each speed until the engine settles, which takes longer and removes the effect of acceleration.';
    const kw = el('label', 'dyno-field');
    kw.append(el('span', undefined, 'Test'), kindSel);
    bar.appendChild(kw);
    const p = host.params();
    this.inputs = {
      from: field('From', Math.max(1500, Math.round((p.idleRpm + 600) / 100) * 100), 800, 12000, 100, 'rpm'),
      to: field('To', Math.round((p.revLimit - 150) / 100) * 100, 1500, 14000, 100, 'rpm'),
      rate: field('Rate', 500, 100, 3000, 50, 'rpm/s'),
      step: field('Step', 500, 100, 2000, 50, 'rpm'),
      throttle: field('Throttle', 100, 5, 100, 5, '%'),
    };
    const sync = () => {
      this.kind = kindSel.value as 'sweep' | 'steps';
      this.inputs.rate.parentElement!.style.display = this.kind === 'sweep' ? '' : 'none';
      this.inputs.step.parentElement!.style.display = this.kind === 'steps' ? '' : 'none';
    };
    kindSel.addEventListener('change', sync);
    sync();
    this.runBtn = el('button', 'dyno-run', 'Run test');
    this.runBtn.addEventListener('click', () => (this.state === 'idle' ? this.start() : this.stop('Stopped.')));
    bar.appendChild(this.runBtn);
    root.appendChild(bar);

    this.status = el('div', 'dyno-status muted', 'Start the engine, then run a test. The engine is taken to full throttle and held by the dyno brake.');
    root.appendChild(this.status);
    this.readout = el('div', 'dyno-readout');
    root.appendChild(this.readout);

    this.main = el('canvas', 'dyno-main');
    root.appendChild(this.main);
    const lowBar = el('div', 'dyno-bar');
    const chan = el('select');
    for (const c of CHANNELS) chan.appendChild(new Option(`${c.label} (${c.unit})`, c.key));
    chan.addEventListener('change', () => (this.channel = chan.value as Channel));
    const sm = el('select');
    sm.append(new Option('No smoothing', '0'), new Option('Light smoothing', '1'), new Option('Heavy smoothing', '3'));
    sm.value = '1';
    sm.addEventListener('change', () => (this.smoothing = Number(sm.value)));
    const units = el('select');
    units.append(new Option('N·m and kW', '0'), new Option('lb·ft and hp', '1'));
    units.addEventListener('change', () => { this.imperial = units.value === '1'; this.renderList(); });
    const csv = el('button', undefined, 'Export CSV');
    csv.addEventListener('click', () => this.exportCsv());
    const clear = el('button', undefined, 'Clear all');
    clear.addEventListener('click', () => { this.runs = []; this.save(); this.renderList(); });
    const lf = el('label', 'dyno-field');
    lf.append(el('span', undefined, 'Lower chart'), chan);
    const spacer = el('div', 'spacer');
    lowBar.append(lf, sm, units, spacer, csv, clear);
    root.appendChild(lowBar);
    this.lower = el('canvas', 'dyno-lower');
    root.appendChild(this.lower);
    this.list = el('div', 'dyno-list');
    root.appendChild(this.list);
    this.renderList();

    for (const c of [this.main, this.lower]) {
      c.addEventListener('pointermove', (e) => { const r = c.getBoundingClientRect(); this.hover = (e.clientX - r.left) / r.width; });
      c.addEventListener('pointerleave', () => (this.hover = null));
    }
  }

  get running(): boolean {
    return this.state !== 'idle';
  }

  private say(text: string): void {
    this.status.textContent = text;
  }

  private start(): void {
    const { audio } = this.host, p = this.host.params(), s = audio.snap;
    if (!audio.running || !s || s.h(H.rpm) < 250) return this.say('The engine is not running. Start it first.');
    if (p.drive > 0.5) return this.say('Leave driving mode first: the dyno needs the engine on the test bed.');
    if (p.paused > 0.5 || p.timeScale < 0.999) return this.say('Set the simulation to real time and un-pause it first.');
    const num = (i: HTMLInputElement, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(i.value) || lo));
    this.from = num(this.inputs.from, 600, 13000);
    // the rev limiter cuts sparks, so a pull has to stop short of it
    this.to = Math.min(num(this.inputs.to, this.from + 300, 14000), p.revLimit - 100);
    if (this.to < this.from + 300) return this.say(`The range is too narrow for this engine (rev limit ${p.revLimit.toFixed(0)} rpm).`);
    this.rate = num(this.inputs.rate, 100, 3000);
    this.step = num(this.inputs.step, 100, 2000);
    const throttle = num(this.inputs.throttle, 5, 100);
    this.before = { throttle: p.throttle };
    this.live = {
      id: this.nextId++, name: `${this.host.presetName()} · ${throttle < 100 ? `${throttle}% throttle · ` : ''}${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
      color: COLORS.find((c) => !this.runs.some((r) => r.color === c)) ?? COLORS[this.runs.length % COLORS.length], visible: true, kind: this.kind, throttle, points: [],
    };
    this.bins.clear();
    this.acc = null;
    this.target = this.from;
    this.timer = this.held = 0;
    this.state = 'settle';
    this.host.setParam('throttle', throttle);
    this.host.push({ dynoRpm: this.target });
    this.runBtn.textContent = 'Stop';
    this.runBtn.classList.add('on');
    this.say(`Bringing the engine to ${this.from} rpm…`);
  }

  private stop(message: string): void {
    this.host.push({ dynoRpm: 0 });
    if (this.before) this.host.setParam('throttle', this.before.throttle);
    this.before = null;
    const run = this.live;
    this.live = null;
    this.state = 'idle';
    this.runBtn.textContent = 'Run test';
    this.runBtn.classList.remove('on');
    if (run && run.points.length > 2) {
      this.runs.push(run);
      if (this.runs.length > 10) this.runs.shift();
      this.save();
      this.renderList();
      const pt = peak(run, 'torque')!, pp = peak(run, 'power')!;
      message += ` Peak ${this.fmtTorque(pt.torque)} at ${pt.rpm.toFixed(0)} rpm, ${this.fmtPower(pp.power)} at ${pp.rpm.toFixed(0)} rpm.`;
    }
    this.say(message);
  }

  private save(): void {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.runs));
    } catch {
      // not saved
    }
  }

  /** One measurement from the simulation's cycle averages. */
  private read(): DynoPoint | null {
    const s = this.host.audio.snap;
    if (!s) return null;
    const p = this.host.params();
    const rpm = s.h(H.rpmAvg), torque = s.h(H.torque), power = s.h(H.power) / 1000, ve = s.h(H.ve);
    const two = p.strokes > 0.5;
    const vd = 0.25 * Math.PI * (p.bore * 1e-3) ** 2 * p.stroke * 1e-3 * s.nCyl;
    // air per second from the air trapped per cycle; fuel follows from the mixture strength
    const air = ve * RHO_ATM * vd * (rpm / (two ? 60 : 120));
    const fuel = air / p.afr;
    return {
      rpm, torque, power, ve: ve * 100, map: s.h(H.map) / 1000, boost: s.h(H.boost) / 1000, turbo: s.h(H.turboRpm) / 1000, spl: s.h(H.spl), air: air * 1000,
      bsfc: power > 0.5 ? (fuel * 3.6e6) / power : 0, bmep: ((two ? 2 : 4) * Math.PI * torque) / vd / 1e5,
    };
  }

  private static add(acc: { n: number; sum: DynoPoint } | null, p: DynoPoint): { n: number; sum: DynoPoint } {
    if (!acc) return { n: 1, sum: { ...p } };
    for (const k of Object.keys(p) as (keyof DynoPoint)[]) acc.sum[k] += p[k];
    acc.n++;
    return acc;
  }
  private static mean(acc: { n: number; sum: DynoPoint }): DynoPoint {
    const out = { ...acc.sum };
    for (const k of Object.keys(out) as (keyof DynoPoint)[]) out[k] /= acc.n;
    return out;
  }

  /** Call every frame. */
  tick(dt: number): void {
    if (this.state !== 'idle') this.advance(Math.min(dt, 0.1));
    if (this.root.offsetParent !== null) this.draw();
  }

  private advance(dt: number): void {
    const s = this.host.audio.snap, run = this.live!;
    const now = this.read();
    if (!s || !now || !this.host.audio.running) return this.stop('The engine stopped.');
    if (this.host.params().drive > 0.5) return this.stop('Stopped: driving mode was switched on.');
    this.timer += dt;
    if (now.rpm < 200 && this.timer > 1.5) return this.stop('The engine stalled.');
    if (this.state === 'settle') {
      this.held = Math.abs(now.rpm - this.target) < 0.02 * this.target ? this.held + dt : 0;
      if (this.held > 0.8 || this.timer > 7) {
        if (this.held <= 0.8) return this.stop(`The engine could not hold ${this.from} rpm at this throttle (it reached ${now.rpm.toFixed(0)}).`);
        this.state = this.kind;
        this.timer = this.held = 0;
        this.say(this.kind === 'sweep' ? `Pulling from ${this.from} to ${this.to} rpm at ${this.rate} rpm/s…` : `Stepping from ${this.from} to ${this.to} rpm…`);
      }
      return;
    }
    if (this.state === 'sweep') {
      this.target = Math.min(this.to, this.target + this.rate * dt);
      this.host.push({ dynoRpm: this.target });
      const b = Math.round(now.rpm / BIN) * BIN;
      if (b >= this.from - BIN / 2 && b <= this.to + BIN / 2) this.bins.set(b, Dyno.add(this.bins.get(b) ?? null, now));
      run.points = [...this.bins.keys()].sort((x, y) => x - y).map((k) => Dyno.mean(this.bins.get(k)!));
      if (this.target >= this.to && now.rpm > this.to - 0.6 * BIN) return this.stop('Sweep complete.');
      if (this.timer > (this.to - this.from) / this.rate + 6) return this.stop('Stopped: the engine could not follow the sweep to the end.');
      return;
    }
    // steps: let each speed settle, then average over half a second
    this.held += dt;
    if (this.held > 1.1) this.acc = Dyno.add(this.acc, now);
    if (this.held > 1.7 && this.acc) {
      run.points.push(Dyno.mean(this.acc));
      this.acc = null;
      this.held = 0;
      if (this.target >= this.to - 1) return this.stop('Steps complete.');
      this.target = Math.min(this.to, this.target + this.step);
      this.host.push({ dynoRpm: this.target });
    }
  }

  // ----------------------------------------------------------------- display
  private tq = (v: number) => (this.imperial ? v * 0.7376 : v);
  private pw = (v: number) => (this.imperial ? v * 1.341 : v);
  private fmtTorque = (v: number) => `${this.tq(v).toFixed(0)} ${this.imperial ? 'lb·ft' : 'N·m'}`;
  private fmtPower = (v: number) => `${this.pw(v).toFixed(0)} ${this.imperial ? 'hp' : 'kW'}`;

  private shown(): DynoRun[] {
    const all = this.live ? [...this.runs, this.live] : this.runs;
    return all.filter((r) => r.visible && r.points.length > 0).map((r) => ({ ...r, points: r === this.live ? r.points : smooth(r.points, r.kind === 'sweep' ? this.smoothing : 0) }));
  }

  private fit(c: HTMLCanvasElement): CanvasRenderingContext2D {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
    ctx.font = FONT;
    return ctx;
  }

  private draw(): void {
    const runs = this.shown();
    let lo = this.live ? this.from : Infinity, hi = this.live ? this.to : -Infinity;
    for (const r of runs) { lo = Math.min(lo, r.points[0].rpm); hi = Math.max(hi, r.points[r.points.length - 1].rpm); }
    if (!Number.isFinite(lo)) { lo = Number(this.inputs.from.value) || 2000; hi = Number(this.inputs.to.value) || 7000; }
    lo = Math.floor(lo / 500) * 500;
    hi = Math.max(lo + 1000, Math.ceil(hi / 500) * 500);
    const padL = 44, padR = 44, padT = 14, padB = 18;
    const now = this.read();
    const hoverRpm = (w: number) => (this.hover === null ? null : lo + ((this.hover * w - padL) / (w - padL - padR)) * (hi - lo));

    const axes = (c: HTMLCanvasElement) => {
      const ctx = this.fit(c), w = c.clientWidth, h = c.clientHeight;
      const X = (rpm: number) => padL + ((rpm - lo) / (hi - lo)) * (w - padL - padR);
      ctx.strokeStyle = GRID;
      ctx.fillStyle = MUTED;
      ctx.textAlign = 'center';
      const every = hi - lo > 6000 ? 1000 : 500;
      for (let r = lo; r <= hi; r += every) {
        ctx.beginPath(); ctx.moveTo(X(r) + 0.5, padT); ctx.lineTo(X(r) + 0.5, h - padB); ctx.stroke();
        ctx.fillText(String(r), X(r), h - 5);
      }
      return { ctx, w, h, X };
    };
    const line = (ctx: CanvasRenderingContext2D, pts: DynoPoint[], X: (r: number) => number, Y: (v: number) => number, get: (p: DynoPoint) => number, color: string, dash: number[] = []) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.setLineDash(dash);
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p.rpm), Y(get(p))) : ctx.lineTo(X(p.rpm), Y(get(p)))));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    };

    // ---- torque and power
    {
      const { ctx, w, h, X } = axes(this.main);
      let tMax = 50, pMax = 20;
      for (const r of runs) for (const p of r.points) { tMax = Math.max(tMax, this.tq(p.torque)); pMax = Math.max(pMax, this.pw(p.power)); }
      tMax = nice(tMax * 1.08);
      pMax = nice(pMax * 1.08);
      const Yt = (v: number) => padT + (1 - this.tq(v) / tMax) * (h - padT - padB), Yp = (v: number) => padT + (1 - this.pw(v) / pMax) * (h - padT - padB);
      for (let k = 0; k <= 4; k++) {
        const y = padT + (k / 4) * (h - padT - padB);
        ctx.strokeStyle = GRID;
        ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(w - padR, y + 0.5); ctx.stroke();
        ctx.fillStyle = INK; ctx.textAlign = 'right';
        ctx.fillText((tMax * (1 - k / 4)).toFixed(0), padL - 5, y + 3);
        ctx.fillStyle = MUTED; ctx.textAlign = 'left';
        ctx.fillText((pMax * (1 - k / 4)).toFixed(0), w - padR + 5, y + 3);
      }
      ctx.fillStyle = INK; ctx.textAlign = 'left';
      ctx.fillText(`torque, ${this.imperial ? 'lb·ft' : 'N·m'} (solid)`, padL + 6, padT + 12);
      ctx.fillStyle = MUTED; ctx.textAlign = 'right';
      ctx.fillText(`power, ${this.imperial ? 'hp' : 'kW'} (dashed)`, w - padR - 6, padT + 12);
      for (const r of runs) {
        line(ctx, r.points, X, Yt, (p) => p.torque, r.color);
        line(ctx, r.points, X, Yp, (p) => p.power, r.color, [5, 4]);
        if (r.points.length > 2) {
          const pt = peak(r, 'torque')!, pp = peak(r, 'power')!;
          ctx.fillStyle = r.color;
          for (const [x, y] of [[X(pt.rpm), Yt(pt.torque)], [X(pp.rpm), Yp(pp.power)]]) { ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill(); }
        }
      }
      if (this.live && now) {
        // where the engine is right now
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.beginPath(); ctx.moveTo(X(now.rpm), padT); ctx.lineTo(X(now.rpm), h - padB); ctx.stroke();
      }
      const hr = hoverRpm(w);
      if (hr !== null && hr >= lo && hr <= hi) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath(); ctx.moveTo(X(hr), padT); ctx.lineTo(X(hr), h - padB); ctx.stroke();
        const rows = runs.map((r) => ({ r, t: sampleRun(r, hr, 'torque'), p: sampleRun(r, hr, 'power') })).filter((x) => x.t !== null);
        const bw = 190, bh = 16 + rows.length * 13, bx = X(hr) + 10 + bw > w - padR ? X(hr) - 10 - bw : X(hr) + 10, by = padT + 14;
        ctx.fillStyle = 'rgba(14,18,22,0.94)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = '#3a4652';
        ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
        ctx.textAlign = 'left';
        ctx.fillStyle = INK;
        ctx.fillText(`${(Math.round(hr / 10) * 10).toFixed(0)} rpm`, bx + 6, by + 11);
        rows.forEach((x, i) => {
          ctx.fillStyle = x.r.color;
          ctx.fillRect(bx + 6, by + 17 + i * 13, 8, 8);
          ctx.fillStyle = INK;
          ctx.fillText(`${this.fmtTorque(x.t!)}   ${this.fmtPower(x.p!)}`, bx + 20, by + 25 + i * 13);
        });
      }
      if (!runs.length) { ctx.fillStyle = MUTED; ctx.textAlign = 'center'; ctx.fillText('No runs yet', w / 2, h / 2); }
    }

    // ---- chosen channel
    {
      const { ctx, w, h, X } = axes(this.lower);
      const ch = CHANNELS.find((c) => c.key === this.channel)!;
      let vMin = Infinity, vMax = -Infinity;
      for (const r of runs) for (const p of r.points) { vMin = Math.min(vMin, p[ch.key]); vMax = Math.max(vMax, p[ch.key]); }
      if (!Number.isFinite(vMin)) { vMin = 0; vMax = 1; }
      const span = Math.max(1e-6, vMax - vMin);
      vMin = ch.key === 'spl' || ch.key === 'bsfc' ? vMin - 0.1 * span : Math.min(0, vMin);
      vMax = vMax + 0.1 * span;
      if (vMax - vMin < 1e-6) vMax = vMin + 1;
      const Y = (v: number) => padT + (1 - (v - vMin) / (vMax - vMin)) * (h - padT - padB);
      for (let k = 0; k <= 2; k++) {
        const y = padT + (k / 2) * (h - padT - padB);
        ctx.strokeStyle = GRID;
        ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(w - padR, y + 0.5); ctx.stroke();
        ctx.fillStyle = INK; ctx.textAlign = 'right';
        ctx.fillText((vMax - (k / 2) * (vMax - vMin)).toFixed(ch.digits), padL - 5, y + 3);
      }
      ctx.fillStyle = INK; ctx.textAlign = 'left';
      ctx.fillText(`${ch.label}, ${ch.unit}`, padL + 6, padT + 12);
      for (const r of runs) line(ctx, r.points, X, Y, (p) => p[ch.key], r.color);
      const hr = hoverRpm(w);
      if (hr !== null && hr >= lo && hr <= hi) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath(); ctx.moveTo(X(hr), padT); ctx.lineTo(X(hr), h - padB); ctx.stroke();
        let y = padT + 14;
        for (const r of runs) {
          const v = sampleRun(r, hr, ch.key);
          if (v === null) continue;
          ctx.fillStyle = r.color; ctx.textAlign = X(hr) > w / 2 ? 'right' : 'left';
          ctx.fillText(`${v.toFixed(ch.digits)} ${ch.unit}`, X(hr) + (X(hr) > w / 2 ? -6 : 6), y);
          y += 12;
        }
      }
    }

    this.readout.innerHTML = this.live && now
      ? `<b>${now.rpm.toFixed(0)}</b> rpm<b>${this.tq(now.torque).toFixed(0)}</b> ${this.imperial ? 'lb·ft' : 'N·m'}<b>${this.pw(now.power).toFixed(0)}</b> ${this.imperial ? 'hp' : 'kW'}<span class="muted">brake absorbing ${(this.host.audio.snap?.h(H.dynoTorque) ?? 0).toFixed(0)} N·m</span>`
      : '';
  }

  private renderList(): void {
    this.list.replaceChildren();
    if (!this.runs.length) return;
    const head = el('div', 'dyno-row dyno-head');
    for (const t of ['', 'Run', 'Peak torque', 'Peak power', 'Test', 'Show', '']) head.appendChild(el('span', undefined, t));
    this.list.appendChild(head);
    for (const r of [...this.runs].reverse()) {
      const row = el('div', 'dyno-row');
      const chip = el('span', 'dyno-chip');
      chip.style.background = r.color;
      const name = el('input');
      name.value = r.name;
      name.addEventListener('change', () => { r.name = name.value; this.save(); });
      const pt = peak(r, 'torque')!, pp = peak(r, 'power')!;
      const show = el('input');
      show.type = 'checkbox';
      show.checked = r.visible;
      show.addEventListener('change', () => { r.visible = show.checked; this.save(); });
      const del = el('button', 'mini', '✕');
      del.title = 'Delete this run';
      del.addEventListener('click', () => { this.runs = this.runs.filter((x) => x !== r); this.save(); this.renderList(); });
      row.append(chip, name, el('span', undefined, `${this.fmtTorque(pt.torque)} @ ${pt.rpm.toFixed(0)}`), el('span', undefined, `${this.fmtPower(pp.power)} @ ${pp.rpm.toFixed(0)}`),
        el('span', 'muted', `${r.kind}${r.throttle < 100 ? `, ${r.throttle}%` : ''}`), show, del);
      this.list.appendChild(row);
    }
  }

  private exportCsv(): void {
    const runs = this.runs.filter((r) => r.visible);
    if (!runs.length) return this.say('No visible runs to export.');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([runsToCsv(runs)], { type: 'text/csv' }));
    a.download = 'engine-sim-dyno.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
