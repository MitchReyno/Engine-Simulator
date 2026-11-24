// Display options for the plots and the 3D view: what to draw, not what to simulate.
// Each section has a button that opens a small panel; choices are kept in the browser.

import { makeDraggable } from './drag';

export interface VizDef {
  key: string;
  section: string;
  label: string;
  kind: 'toggle' | 'select' | 'slider';
  def: number;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
}

const tog = (section: string, key: string, label: string, def: number, hint?: string): VizDef => ({ key, section, label, kind: 'toggle', def, hint });
const sel = (section: string, key: string, label: string, options: string[], def: number, hint?: string): VizDef => ({ key, section, label, kind: 'select', def, options, hint });
const sld = (section: string, key: string, label: string, min: number, max: number, step: number, def: number, unit = '', hint?: string): VizDef => ({ key, section, label, kind: 'slider', def, min, max, step, unit, hint });

export const VIZ_TITLES: Record<string, string> = {
  scope: 'Output waveform', spec: 'Spectrogram', pv: 'P–V diagram', ptheta: 'Cylinder pressure', tract: 'Tract', valves: 'Valve lift and timing', view3d: '3D view',
};

export const SCOPE_CYCLES = [1, 2, 4, 8];
export const SPEC_TOPS = [2000, 4000, 8000, 16000];

export const VIZ_DEFS: VizDef[] = [
  sel('scope', 'scopeCycles', 'Engine cycles shown', ['1', '2', '4', '8'], 1, 'The time axis follows engine speed and simulation speed, so this many cycles always fill the plot.'),
  sel('scope', 'scopeScale', 'Vertical scale', ['Fit the waveform', 'Full scale (clipping at the edges)'], 0),
  tog('scope', 'scopeTrigger', 'Hold steady on a rising edge', 1, 'At real-time speed. In slow motion the trace scrolls instead.'),
  tog('scope', 'scopeGrid', 'Mark firing intervals', 0, 'A vertical line every firing interval, to count pulses against.'),
  tog('scope', 'scopeFill', 'Fill under the trace', 0),

  sel('spec', 'specMode', 'Display', ['Scrolling spectrogram', 'Live spectrum'], 0),
  sel('spec', 'specTop', 'Highest frequency', ['2 kHz', '4 kHz', '8 kHz', '16 kHz'], 1),
  sel('spec', 'specAxis', 'Frequency axis', ['Logarithmic', 'Linear'], 0, 'Linear spaces the firing harmonics evenly.'),
  tog('spec', 'specMarks', 'Mark firing harmonics', 1),
  sel('spec', 'specSpeed', 'Scroll speed', ['Slow', 'Normal', 'Fast'], 1),
  sel('spec', 'specPalette', 'Colours', ['Fire', 'Ice', 'Grey'], 0),
  sld('spec', 'specGain', 'Brightness', 0.5, 2.5, 0.05, 1, '×', 'Lifts quiet detail without changing the sound.'),

  sel('pv', 'pvAxes', 'Axes', ['Linear', 'Log–log'], 0, 'On log axes compression and expansion are straight lines whose slope is the polytropic exponent.'),
  tog('pv', 'pvAll', 'Show every cylinder', 0),
  tog('pv', 'pvRef', 'Reference compression curve', 0, 'pV^1.35 from atmospheric pressure at bottom dead centre: what compressing a full charge without combustion would give.'),
  tog('pv', 'pvFill', 'Shade the loop', 0, 'The enclosed area is the work done per cycle.'),

  sel('ptheta', 'ptView', 'Arrangement', ['Firing order along the crank angle', 'Overlaid, each from its own firing TDC', 'Combustion close-up (±90°)'], 0),
  sel('ptheta', 'ptWhich', 'Cylinders', ['All', 'Selected only'], 0),
  tog('ptheta', 'ptLog', 'Logarithmic pressure axis', 0, 'Shows the low-pressure pumping strokes as well as the combustion peak.'),
  tog('ptheta', 'ptPeak', 'Label the peak', 0, 'Peak pressure of the selected cylinder and where it falls after TDC.'),

  sel('tract', 'trQuantity', 'Quantity', ['Pressure', 'Temperature', 'Flow velocity'], 0),
  sel('tract', 'trScale', 'Pressure range', ['Follow the waves', 'Fixed 0–2.5 bar'], 0),
  tog('tract', 'trCells', 'Mark each solver cell', 0, 'One dot per finite-volume cell, so the resolution of each pipe is visible.'),
  tog('tract', 'trEnvelope', 'Hold recent highs and lows', 0, 'A slowly fading envelope of the extremes at each point, which shows the standing-wave pattern.'),
  tog('tract', 'trGas', 'Burned-gas strip', 1),

  tog('valves', 'vlLabels', 'Label opening and closing angles', 1),
  tog('valves', 'vlPiston', 'Piston position curve', 1),
  tog('valves', 'vlOverlap', 'Shade valve overlap', 1),
  tog('valves', 'vlSpark', 'Spark mark', 1),

  tog('view3d', 'v3Cells', 'Mark individual pipe cells', 0, 'A dark band at each boundary between solver cells.'),
  tog('view3d', 'v3Arrows', 'Flow arrows at the ports', 1),
  tog('view3d', 'v3Flash', 'Combustion flashes', 1, 'A glow in each cylinder while its charge burns, and along the exhaust wherever unburned charge is alight (afterfire). Both come from the simulation; each flash lingers a moment so it can be seen.'),
  sld('view3d', 'v3FlashGain', 'Flash brightness', 20, 200, 5, 100, '%'),
  tog('view3d', 'v3Paths', 'Sound paths to the microphone', 0, 'A line from every sound source to the microphone, brighter for the louder paths.'),
  tog('view3d', 'v3Sources', 'Mark sound sources', 0, 'Exhaust outlets, the intake mouth and the engine block, as the sound model places them.'),
  tog('view3d', 'v3Spaces', 'Show the car body\'s air spaces', 0, 'The engine bay and cabin volumes the sound model uses. Needs Car body on.'),
  sel('view3d', 'v3Body', 'Car body style', ['Glass', 'Outline only', 'Hidden'], 0, 'How the body is drawn. Does not change the sound.'),
  sld('view3d', 'v3Shell', 'Block and head opacity', 0, 60, 1, 13, '%', 'When Cutaway is off.'),
  tog('view3d', 'v3Grid', 'Ground grid', 1),
  tog('view3d', 'v3Spin', 'Turntable', 0, 'Slowly orbit the camera.'),
  sld('view3d', 'v3Fov', 'Lens', 15, 75, 1, 36, '°', 'Field of view: low is a flat telephoto look, high is wide-angle.'),
  sld('view3d', 'v3Exposure', 'Exposure', 0.5, 2, 0.05, 1.05, ''),
];

const STORE = 'engine-sim.view.v1';
const BY_KEY = Object.fromEntries(VIZ_DEFS.map((d) => [d.key, d]));

export class ViewOptions {
  readonly values: Record<string, number> = {};
  onChange: (key: string) => void = () => {};
  private pop: HTMLElement | null = null;
  private owner: HTMLElement | null = null;

  constructor() {
    for (const d of VIZ_DEFS) this.values[d.key] = d.def;
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, unknown>;
      for (const d of VIZ_DEFS) {
        const v = saved[d.key];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        const lo = d.min ?? 0, hi = d.kind === 'toggle' ? 1 : d.kind === 'select' ? d.options!.length - 1 : d.max!;
        this.values[d.key] = Math.min(hi, Math.max(lo, d.kind === 'slider' ? v : Math.round(v)));
      }
    } catch {
      // storage blocked or corrupt: defaults
    }
    document.addEventListener('pointerdown', (e) => {
      if (this.pop && !this.pop.contains(e.target as Node) && !this.owner?.contains(e.target as Node)) this.close();
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.close());
  }

  set(key: string, value: number): void {
    this.values[key] = value;
    try {
      localStorage.setItem(STORE, JSON.stringify(this.values));
    } catch {
      // not saved; still applies now
    }
    this.onChange(key);
  }

  close(): void {
    this.pop?.remove();
    this.owner?.classList.remove('on');
    this.pop = this.owner = null;
  }

  /** Make `button` open the options of one section. */
  attach(button: HTMLElement, section: string): void {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      const again = this.owner === button;
      this.close();
      if (!again) this.open(button, section);
    });
  }

  private open(button: HTMLElement, section: string): void {
    const pop = document.createElement('div');
    pop.className = 'viz-pop';
    const head = document.createElement('div');
    head.className = 'viz-head';
    head.innerHTML = `<b></b><button class="mini" title="Put these options back to their defaults">Reset</button>`;
    head.querySelector('b')!.textContent = `${VIZ_TITLES[section]} options`;
    pop.appendChild(head);
    const build = () => {
      pop.querySelectorAll('.row').forEach((r) => r.remove());
      for (const d of VIZ_DEFS) if (d.section === section) pop.appendChild(this.row(d));
    };
    head.querySelector('button')!.addEventListener('click', () => {
      for (const d of VIZ_DEFS) if (d.section === section && this.values[d.key] !== d.def) this.set(d.key, d.def);
      build();
    });
    build();
    document.body.appendChild(pop);
    makeDraggable(pop, head);
    // below the button, kept inside the window
    const r = button.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    pop.style.top = `${r.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
    this.pop = pop;
    this.owner = button;
    button.classList.add('on');
  }

  private row(d: VizDef): HTMLElement {
    const row = document.createElement('label');
    row.className = `row row-${d.kind}`;
    if (d.hint) row.title = d.hint;
    const head = document.createElement('div');
    head.className = 'row-head';
    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = d.label;
    head.appendChild(label);
    row.appendChild(head);
    const v = this.values[d.key];
    if (d.kind === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = v > 0.5;
      input.addEventListener('change', () => this.set(d.key, input.checked ? 1 : 0));
      head.appendChild(input);
    } else if (d.kind === 'select') {
      const s = document.createElement('select');
      d.options!.forEach((o, i) => s.appendChild(new Option(o, String(i))));
      s.value = String(v);
      s.addEventListener('change', () => this.set(d.key, Number(s.value)));
      head.appendChild(s);
    } else {
      const val = document.createElement('span');
      val.className = 'row-value';
      head.appendChild(val);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(d.min);
      input.max = String(d.max);
      input.step = String(d.step);
      const show = (x: number) => {
        val.textContent = `${x.toFixed(d.step! >= 1 ? 0 : 2)}${d.unit ? ' ' + d.unit : ''}`;
        input.style.setProperty('--fill', `${((x - d.min!) / (d.max! - d.min!)) * 100}%`);
      };
      input.value = String(v);
      show(v);
      input.addEventListener('input', () => { show(Number(input.value)); this.set(d.key, Number(input.value)); });
      row.appendChild(input);
    }
    return row;
  }
}

export const vizDefault = (key: string) => BY_KEY[key].def;
