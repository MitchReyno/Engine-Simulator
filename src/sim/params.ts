// Parameter schema shared by the UI, the worklet and the tests.
// Values are stored in display units (mm, litres, degrees, percent).

export type Params = Record<string, number>;

export type ParamKind = 'slider' | 'select' | 'toggle';

export interface ParamDef {
  key: string;
  label: string;
  unit: string;
  group: string;
  kind: ParamKind;
  min: number;
  max: number;
  step: number;
  def: number;
  options?: string[];
  /** Slewed inside the audio thread so a drag never steps the physics. */
  smooth?: boolean;
  hint?: string;
}

const s = (key: string, label: string, unit: string, group: string, min: number, max: number, step: number, def: number, hint?: string, smooth = true): ParamDef => ({
  key, label, unit, group, kind: 'slider', min, max, step, def, smooth, hint,
});
const sel = (key: string, label: string, group: string, options: string[], def: number, hint?: string): ParamDef => ({
  key, label, unit: '', group, kind: 'select', min: 0, max: Math.max(0, options.length - 1), step: 1, def, options, hint,
});
const tog = (key: string, label: string, group: string, def: number, hint?: string): ParamDef => ({
  key, label, unit: '', group, kind: 'toggle', min: 0, max: 1, step: 1, def, hint,
});

export const COLLECTOR_LABELS = ['All into one', 'Paired / per-bank into one', 'True dual', 'Open headers'];

export const GROUPS = ['Engine', 'Valvetrain', 'Intake', 'Exhaust', 'Combustion', 'Running', 'Audio'];

export const PARAM_DEFS: ParamDef[] = [
  // Engine. layout / cylinders / crank / firingOrder options are filled in by the UI.
  sel('layout', 'Layout', 'Engine', ['Single', 'Inline', 'V', 'Flat (boxer)'], 1),
  sel('cylinders', 'Cylinders', 'Engine', [], 4),
  s('bankAngle', 'Bank angle', '°', 'Engine', 30, 120, 1, 90, 'V engines only. Changes firing intervals for a given crank.', false),
  sel('crank', 'Crankshaft', 'Engine', [], 0),
  sel('firingOrder', 'Firing order', 'Engine', [], 0),
  s('bore', 'Bore', 'mm', 'Engine', 50, 110, 0.5, 86),
  s('stroke', 'Stroke', 'mm', 'Engine', 40, 110, 0.5, 86),
  s('rodLength', 'Rod length', 'mm', 'Engine', 90, 200, 1, 143),
  s('compression', 'Compression ratio', ':1', 'Engine', 6, 15, 0.1, 10.5),
  s('flywheel', 'Flywheel inertia', 'kg·m²', 'Engine', 0.02, 1, 0.01, 0.16),

  s('intakeLift', 'Intake lift', 'mm', 'Valvetrain', 3, 15, 0.1, 9.5),
  s('exhaustLift', 'Exhaust lift', 'mm', 'Valvetrain', 3, 15, 0.1, 9),
  s('intakeDuration', 'Intake duration', '°', 'Valvetrain', 180, 330, 1, 250, 'Seat to seat, crank degrees.'),
  s('exhaustDuration', 'Exhaust duration', '°', 'Valvetrain', 180, 330, 1, 250, 'Seat to seat, crank degrees.'),
  s('lsa', 'Lobe separation', '°', 'Valvetrain', 95, 125, 0.5, 110, 'Smaller separation means more overlap.'),
  s('camAdvance', 'Cam timing (advance)', '°', 'Valvetrain', -15, 15, 0.5, 2),

  s('throttleBody', 'Throttle body Ø', 'mm', 'Intake', 25, 100, 1, 60),
  s('intakeLength', 'Intake pipe length', 'mm', 'Intake', 100, 800, 5, 300, 'Ambient to throttle.'),
  s('runnerLength', 'Runner length', 'mm', 'Intake', 100, 700, 5, 320),
  s('runnerDiameter', 'Runner Ø', 'mm', 'Intake', 22, 65, 0.5, 40),
  s('plenumVolume', 'Plenum volume', 'L', 'Intake', 0.5, 12, 0.1, 3),

  s('headerLength', 'Header length', 'mm', 'Exhaust', 150, 1500, 5, 500),
  s('headerDiameter', 'Header Ø', 'mm', 'Exhaust', 22, 65, 0.5, 38),
  sel('collector', 'Collector type', 'Exhaust', COLLECTOR_LABELS, 0),
  s('midLength', 'Collector pipe length', 'mm', 'Exhaust', 200, 2000, 10, 700, 'Collector to muffler.'),
  s('mufflerVolume', 'Muffler volume', 'L', 'Exhaust', 0.5, 40, 0.5, 12),
  s('tailLength', 'Tailpipe length', 'mm', 'Exhaust', 200, 3000, 10, 900),
  s('tailDiameter', 'Tailpipe Ø', 'mm', 'Exhaust', 25, 100, 1, 50),

  s('afr', 'Air-fuel ratio', ':1', 'Combustion', 9, 20, 0.1, 13.2),
  s('ignitionAdvance', 'Ignition advance', '° BTDC', 'Combustion', -10, 55, 0.5, 18),
  s('burnDuration', 'Burn duration', '°', 'Combustion', 20, 100, 1, 54, 'Crank angle for the Wiebe burn, 0–99 %.'),

  s('throttle', 'Throttle', '%', 'Running', 0, 100, 1, 0, 'Hold Space or W, or drag the pedal.'),
  s('load', 'Load', '%', 'Running', 0, 100, 1, 0, 'Brake torque rising with rpm² (propeller law).'),
  s('idleRpm', 'Idle target', 'rpm', 'Running', 500, 2000, 10, 900, 'Idle air valve setpoint when the throttle is closed.', false),
  s('revLimit', 'Rev limiter', 'rpm', 'Running', 2000, 13000, 100, 7000, 'Hard spark cut.', false),
  tog('ignition', 'Ignition', 'Running', 1),

  s('volume', 'Master volume', '%', 'Audio', 0, 100, 1, 70),
  s('mixExhaust', 'Exhaust', '%', 'Audio', 0, 100, 1, 100),
  s('mixIntake', 'Intake', '%', 'Audio', 0, 100, 1, 100),
  s('mixMech', 'Mechanical (faked)', '%', 'Audio', 0, 100, 1, 35),
  s('listenerPos', 'Listener position', 'm', 'Audio', -1, 5, 0.1, 3, '0 = intake mouth at the front, 3.5 = tailpipe exit.'),
  s('listenerDist', 'Listener distance', 'm', 'Audio', 0.5, 10, 0.1, 1.5, 'Sideways distance from the car centreline.'),
];

/** Not shown as sliders; driven by dedicated controls. */
export const HIDDEN_DEFAULTS: Params = { starter: 0, timeScale: 1, paused: 0, cellBudget: 140 };

export const PARAM_BY_KEY: Record<string, ParamDef> = Object.fromEntries(PARAM_DEFS.map((d) => [d.key, d]));

export function defaultParams(): Params {
  const p: Params = { ...HIDDEN_DEFAULTS };
  for (const d of PARAM_DEFS) p[d.key] = d.def;
  return p;
}

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  values: Params;
}

export const PRESETS: Preset[] = [
  {
    id: 'i4', name: 'Inline-4 2.0 L', blurb: 'Even 180° firing through a 4-into-1 collector.',
    values: {},
  },
  {
    id: 'thumper', name: 'Single-cylinder thumper', blurb: '600 cc single, short megaphone exhaust.',
    values: {
      layout: 0, cylinders: 1, bore: 100, stroke: 76, rodLength: 130, compression: 10, flywheel: 0.05,
      intakeLift: 10, exhaustLift: 9, intakeDuration: 258, exhaustDuration: 256, lsa: 108,
      throttleBody: 42, intakeLength: 180, runnerLength: 220, runnerDiameter: 40, plenumVolume: 1.5,
      headerLength: 650, headerDiameter: 40, collector: 0, midLength: 300, mufflerVolume: 3, tailLength: 300, tailDiameter: 38,
      idleRpm: 1300, revLimit: 7500, ignitionAdvance: 18,
    },
  },
  {
    id: 'v8cross', name: 'Cross-plane V8 5.7 L', blurb: 'Uneven pulses per bank: the classic burble.',
    values: {
      layout: 2, cylinders: 8, bankAngle: 90, crank: 0, firingOrder: 0, bore: 99, stroke: 92, rodLength: 155, compression: 10, flywheel: 0.3,
      intakeLift: 12, exhaustLift: 12, intakeDuration: 258, exhaustDuration: 264, lsa: 114, camAdvance: 2,
      throttleBody: 85, intakeLength: 350, runnerLength: 280, runnerDiameter: 46, plenumVolume: 7,
      headerLength: 650, headerDiameter: 44, collector: 2, midLength: 900, mufflerVolume: 14, tailLength: 1000, tailDiameter: 60,
      idleRpm: 800, revLimit: 6400, ignitionAdvance: 19, burnDuration: 56,
    },
  },
  {
    id: 'v8flat', name: 'Flat-plane V8 4.5 L', blurb: 'Each bank fires evenly, like two inline-4s.',
    values: {
      layout: 2, cylinders: 8, bankAngle: 90, crank: 1, firingOrder: 0, bore: 94, stroke: 81, rodLength: 146, compression: 12.5, flywheel: 0.12,
      intakeLift: 12.5, exhaustLift: 11.5, intakeDuration: 274, exhaustDuration: 270, lsa: 110, camAdvance: 0,
      throttleBody: 85, intakeLength: 250, runnerLength: 240, runnerDiameter: 46, plenumVolume: 8,
      headerLength: 480, headerDiameter: 42, collector: 2, midLength: 600, mufflerVolume: 8, tailLength: 600, tailDiameter: 63,
      idleRpm: 1200, revLimit: 9000, ignitionAdvance: 16, burnDuration: 48,
    },
  },
  {
    id: 'flat6', name: 'Flat-6 3.6 L', blurb: 'Boxer six with per-bank collectors.',
    values: {
      layout: 3, cylinders: 6, crank: 0, firingOrder: 0, bore: 100, stroke: 76.4, rodLength: 127, compression: 11.3, flywheel: 0.14,
      intakeLift: 11.5, exhaustLift: 10.5, intakeDuration: 262, exhaustDuration: 256, lsa: 110, camAdvance: 2,
      throttleBody: 76, intakeLength: 300, runnerLength: 300, runnerDiameter: 44, plenumVolume: 6,
      headerLength: 520, headerDiameter: 42, collector: 1, midLength: 500, mufflerVolume: 14, tailLength: 500, tailDiameter: 60,
      idleRpm: 850, revLimit: 7800, ignitionAdvance: 18,
    },
  },
  {
    id: 'vtwin', name: '45° V-twin 1.45 L', blurb: 'Shared crank pin: 315° / 405° firing.',
    values: {
      layout: 2, cylinders: 2, bankAngle: 45, crank: 0, firingOrder: 0, bore: 95.3, stroke: 101.6, rodLength: 190, compression: 9, flywheel: 0.35,
      intakeLift: 12, exhaustLift: 12, intakeDuration: 250, exhaustDuration: 256, lsa: 104, camAdvance: 2,
      throttleBody: 46, intakeLength: 150, runnerLength: 160, runnerDiameter: 44, plenumVolume: 1,
      headerLength: 800, headerDiameter: 44, collector: 2, midLength: 300, mufflerVolume: 3, tailLength: 400, tailDiameter: 44,
      idleRpm: 950, revLimit: 5800, ignitionAdvance: 21, burnDuration: 60,
    },
  },
  {
    id: 'i6', name: 'Inline-6 3.0 L', blurb: 'Even 120° firing, split 3-into-1 pairs.',
    values: {
      layout: 1, cylinders: 6, crank: 0, firingOrder: 0, bore: 84, stroke: 89.6, rodLength: 138, compression: 10.2, flywheel: 0.2,
      throttleBody: 70, runnerLength: 360, runnerDiameter: 38, plenumVolume: 5,
      headerLength: 450, headerDiameter: 38, collector: 1, midLength: 800, mufflerVolume: 16, tailLength: 900, tailDiameter: 57,
      idleRpm: 750, revLimit: 7000,
    },
  },
];

export function presetParams(id: string): Params {
  const p = defaultParams();
  const preset = PRESETS.find((x) => x.id === id) ?? PRESETS[0];
  Object.assign(p, preset.values);
  return p;
}

export function clampParam(key: string, value: number): number {
  const d = PARAM_BY_KEY[key];
  if (!d || d.kind !== 'slider') return value;
  return Math.min(d.max, Math.max(d.min, value));
}
