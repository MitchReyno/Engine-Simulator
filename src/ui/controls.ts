// Collapsible slider panels generated from the parameter schema.

import { valveEvents } from '../sim/kinematics';
import { LAYOUT_KINDS, cylinderOptions, findLayout, resolveLayout } from '../sim/layouts';
import { GROUPS, PARAM_DEFS, ParamDef, Params } from '../sim/params';

type Updater = (value: number) => void;

const FOUR_ONLY = [
  'valvesPerCyl', 'intakeValveSize', 'exhaustValveSize', 'camProfile', 'intakeLift', 'exhaustLift', 'intakeDuration', 'exhaustDuration',
  'lsa', 'camAdvance', 'firingOrder', 'collector', 'plenumVolume', 'mechDetail',
  'vtec', 'vtecRpm', 'lowIntakeLift', 'lowExhaustLift', 'lowIntakeDuration', 'lowExhaustDuration', 'vtc', 'vtcRange',
];
const VTEC_ROWS = ['vtecRpm', 'lowIntakeLift', 'lowExhaustLift', 'lowIntakeDuration', 'lowExhaustDuration'];
const TWO_ONLY = [
  'exhaustPortOpen', 'transferPortOpen', 'crankcaseCR', 'exhaustPortWidth', 'transferPortWidth', 'powerValve', 'induction',
  'reedStiffness', 'inductionDuration', 'inductionClose', 'chamberDiameter', 'chamberSilencer',
];

const fmt = (d: ParamDef, v: number): string => {
  const decimals = d.step >= 1 ? 0 : d.step >= 0.1 ? 1 : 2;
  return v.toFixed(decimals);
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Controls {
  private updaters = new Map<string, Updater[]>();
  private selects = new Map<string, HTMLSelectElement>();
  private rows = new Map<string, HTMLElement>();
  private readouts: Record<string, HTMLElement> = {};
  readonly panels = new Map<string, HTMLElement>();

  constructor(private root: HTMLElement, private params: Params, private onChange: (key: string, value: number) => void) {
    const open = new Set(['Engine', 'Running']);
    for (const group of GROUPS) {
      const det = el('details', 'panel');
      det.open = open.has(group);
      const sum = el('summary', undefined, group);
      det.appendChild(sum);
      const body = el('div', 'panel-body');
      det.appendChild(body);
      this.panels.set(group, body);
      for (const d of PARAM_DEFS) if (d.group === group) body.appendChild(this.row(d));
      if (group === 'Intake') body.insertBefore(this.row(PARAM_DEFS.find((d) => d.key === 'throttle')!, 'Throttle (same as Running)'), body.firstChild);
      if (group === 'Engine') body.appendChild((this.readouts.engine = el('div', 'readout')));
      if (group === 'Valves & ports') body.appendChild((this.readouts.valves = el('div', 'readout')));
      root.appendChild(det);
    }
    this.refreshDynamic();
  }

  private bind(key: string, fn: Updater): void {
    (this.updaters.get(key) ?? this.updaters.set(key, []).get(key)!).push(fn);
  }

  private row(d: ParamDef, labelOverride?: string): HTMLElement {
    const row = el('label', `row row-${d.kind}`);
    if (!labelOverride) this.rows.set(d.key, row);
    if (d.hint) row.title = d.hint;
    const head = el('div', 'row-head');
    head.appendChild(el('span', 'row-label', labelOverride ?? d.label));
    row.appendChild(head);
    if (d.kind === 'slider') {
      const val = el('span', 'row-value');
      head.appendChild(val);
      const input = el('input');
      input.type = 'range';
      input.min = String(d.min);
      input.max = String(d.max);
      input.step = String(d.step);
      const show: Updater = (v) => {
        input.value = String(v);
        val.textContent = `${fmt(d, v)}${d.unit ? ' ' + d.unit : ''}`;
        input.style.setProperty('--fill', `${((v - d.min) / (d.max - d.min)) * 100}%`);
      };
      input.addEventListener('input', () => this.onChange(d.key, Number(input.value)));
      input.addEventListener('dblclick', () => this.onChange(d.key, d.def));
      this.bind(d.key, show);
      show(this.params[d.key]);
      row.appendChild(input);
    } else if (d.kind === 'select') {
      const select = el('select');
      for (const [i, o] of (d.options ?? []).entries()) select.appendChild(new Option(o, String(i)));
      select.addEventListener('change', () => this.onChange(d.key, Number(select.value)));
      this.selects.set(d.key, select);
      select.value = String(this.params[d.key]);
      if (d.tiers) {
        // Fidelity option: say plainly whether the chosen setting is physics, approximation or fake.
        const badge = el('span', 'tier');
        const hint = el('div', 'row-hint', d.hint ?? '');
        const show = (v: number) => {
          select.value = String(v);
          const tier = d.tiers![v | 0] ?? 'off';
          badge.className = `tier tier-${tier}`;
          badge.textContent = tier === 'off' ? 'not modelled' : tier;
        };
        this.bind(d.key, show);
        show(this.params[d.key]);
        const right = el('span', 'row-right');
        right.append(badge, select);
        head.appendChild(right);
        row.appendChild(hint);
      } else {
        this.bind(d.key, (v) => (select.value = String(v)));
        head.appendChild(select);
      }
    } else {
      const input = el('input');
      input.type = 'checkbox';
      input.className = 'switch';
      input.addEventListener('change', () => this.onChange(d.key, input.checked ? 1 : 0));
      this.bind(d.key, (v) => (input.checked = v > 0.5));
      input.checked = this.params[d.key] > 0.5;
      head.appendChild(input);
    }
    return row;
  }

  /** Push a value into every widget bound to the key. */
  set(key: string, value: number): void {
    for (const fn of this.updaters.get(key) ?? []) fn(value);
  }

  setAll(p: Params): void {
    this.params = p;
    this.refreshDynamic();
    for (const d of PARAM_DEFS) this.set(d.key, p[d.key]);
  }

  /** Layout-dependent option lists and derived read-outs. */
  refreshDynamic(): void {
    const p = this.params;
    const kind = LAYOUT_KINDS[p.layout | 0] ?? 'inline';
    const fill = (key: string, options: [string, number][], value: number) => {
      const s = this.selects.get(key)!;
      s.replaceChildren(...options.map(([label, v]) => new Option(label, String(v))));
      s.value = String(value);
      s.disabled = options.length < 2;
    };
    fill('cylinders', cylinderOptions(kind).map((n) => [String(n), n]), p.cylinders);
    const def = findLayout(kind, p.cylinders | 0);
    fill('crank', def.cranks.map((c, i) => [c.name, i]), p.crank);
    const two = p.strokes > 0.5;
    const res = resolveLayout(kind, p.cylinders | 0, p.bankAngle, p.crank | 0, p.firingOrder | 0, two);
    fill('firingOrder', res.orderLabels.map((l, i) => [l, i]), res.orderIndex);
    this.rows.get('bankAngle')!.style.display = kind === 'v' ? '' : 'none';
    // Show only the rows that exist on this kind of engine.
    for (const k of FOUR_ONLY) this.rows.get(k)!.style.display = two ? 'none' : '';
    for (const k of TWO_ONLY) this.rows.get(k)!.style.display = two ? '' : 'none';
    if (!two) {
      const vt = p.vtec | 0;
      for (const k of VTEC_ROWS) this.rows.get(k)!.style.display = vt === 0 || (vt === 2 && k.includes('Exhaust')) ? 'none' : '';
      this.rows.get('vtcRange')!.style.display = p.vtc > 0.5 ? '' : 'none';
    }
    if (two) {
      const ind = p.induction | 0;
      this.rows.get('reedStiffness')!.style.display = ind === 0 ? '' : 'none';
      this.rows.get('inductionDuration')!.style.display = ind === 0 ? 'none' : '';
      this.rows.get('inductionClose')!.style.display = ind === 2 ? '' : 'none';
    }

    const cc = 0.25 * Math.PI * p.bore * p.bore * p.stroke * 1e-3;
    const even = res.intervals.every((d) => Math.abs(d - res.intervals[0]) < 0.5);
    this.readouts.engine.innerHTML =
      `<b>${((cc * res.n) / 1000).toFixed(2)} L</b> (${cc.toFixed(0)} cc × ${res.n}) · bore/stroke ${(p.bore / p.stroke).toFixed(2)} · rod ratio ${(p.rodLength / p.stroke).toFixed(2)}<br>` +
      `${two ? 'two-stroke, ' : ''}firing intervals ${even ? `<b>${Math.round(res.intervals[0])}°</b> even` : res.intervals.map((d) => Math.round(d)).join('–') + '°'}`;
    if (two) {
      const tpo = Math.max(p.transferPortOpen, p.exhaustPortOpen + 2);
      this.readouts.valves.innerHTML =
        `exhaust port open <b>${Math.round(360 - 2 * p.exhaustPortOpen)}°</b> · transfer <b>${Math.round(360 - 2 * tpo)}°</b> · blowdown ${Math.round(tpo - p.exhaustPortOpen)}°<br>` +
        `tuned length (exhaust slider) sets where the engine comes on the pipe`;
    } else {
      const ev = valveEvents(p.intakeDuration, p.exhaustDuration, p.lsa, p.camAdvance);
      this.readouts.valves.innerHTML =
        `overlap <b>${Math.round(ev.overlap)}°</b>${p.vtc > 0.5 ? ` to <b>${Math.round(Math.max(0, ev.overlap + p.vtcRange))}°</b> with the phaser` : ''} · intake centre ${Math.round(ev.intakeCentre - 360)}° ATDC · exhaust centre ${Math.round(360 - ev.exhaustCentre)}° BTDC` +
        (p.vtec > 0.5 ? `<br>lift and duration sliders are the high-speed lobes; low-speed lobes run below ${Math.round(p.vtecRpm)} rpm` : '');
    }
  }
}
