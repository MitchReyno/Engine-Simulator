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
  /** Per-option honesty tier, shown as a badge on fidelity selects. */
  tiers?: Tier[];
}

export type Tier = 'modelled' | 'approximated' | 'faked' | 'off';

const s = (key: string, label: string, unit: string, group: string, min: number, max: number, step: number, def: number, hint?: string, smooth = true): ParamDef => ({
  key, label, unit, group, kind: 'slider', min, max, step, def, smooth, hint,
});
const sel = (key: string, label: string, group: string, options: string[], def: number, hint?: string): ParamDef => ({
  key, label, unit: '', group, kind: 'select', min: 0, max: Math.max(0, options.length - 1), step: 1, def, options, hint,
});
const fx = (key: string, label: string, options: string[], tiers: Tier[], def: number, hint: string): ParamDef => ({
  ...sel(key, label, 'Model fidelity', options, def, hint), tiers,
});
const tog = (key: string, label: string, group: string, def: number, hint?: string): ParamDef => ({
  key, label, unit: '', group, kind: 'toggle', min: 0, max: 1, step: 1, def, hint,
});

export const COLLECTOR_LABELS = ['All into one', 'Paired / per-bank into one', 'True dual', 'Open headers'];

export const GROUPS = ['Engine', 'Valves & ports', 'Intake', 'Exhaust', 'Combustion', 'Running', 'Car', 'Audio', 'Model fidelity'];

export const PARAM_DEFS: ParamDef[] = [
  // Engine. layout / cylinders / crank / firingOrder options are filled in by the UI.
  sel('strokes', 'Cycle', 'Engine', ['Four-stroke', 'Two-stroke'], 0, 'Two-stroke: piston-controlled ports, crankcase scavenging through a reed valve, and an expansion chamber per cylinder.'),
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
  sel('mechDetail', '3D mechanical detail', 'Engine', ['Schematic', 'Detailed (DOHC, roller rockers, chain drive)'], 0,
    'Four-stroke only. Draws the valvetrain, timing drive, pistons and rods as real parts. Does not change the physics.'),

  sel('valvesPerCyl', 'Valves per cylinder', 'Valves & ports', ['2 (1 intake, 1 exhaust)', '4 (2 intake, 2 exhaust)', '5 (3 intake, 2 exhaust)'], 1),
  s('intakeValveSize', 'Intake valve Ø', '% bore', 'Valves & ports', 24, 52, 0.5, 36, 'Per valve. Limited to what fits: about 52 % with one intake valve, 40 % with two, 33 % with three.'),
  s('exhaustValveSize', 'Exhaust valve Ø', '% bore', 'Valves & ports', 20, 45, 0.5, 31, 'Per valve. Limited to about 45 % with one exhaust valve and 34 % with two.'),
  sel('camProfile', 'Cam lobe profile', 'Valves & ports', ['Gentle (pointed lobe)', 'Standard', 'Fast ramps (roller, fat lobe)'], 1, 'How quickly the valve reaches full lift within the same duration.'),
  s('intakeLift', 'Intake lift', 'mm', 'Valves & ports', 3, 15, 0.1, 9.5),
  s('exhaustLift', 'Exhaust lift', 'mm', 'Valves & ports', 3, 15, 0.1, 9),
  s('intakeDuration', 'Intake duration', '°', 'Valves & ports', 180, 330, 1, 250, 'Seat to seat, crank degrees.'),
  s('exhaustDuration', 'Exhaust duration', '°', 'Valves & ports', 180, 330, 1, 250, 'Seat to seat, crank degrees.'),
  s('lsa', 'Lobe separation', '°', 'Valves & ports', 95, 125, 0.5, 110, 'Smaller separation means more overlap.'),
  s('camAdvance', 'Cam timing (advance)', '°', 'Valves & ports', -15, 15, 0.5, 2),
  sel('vtec', 'Variable lift (VTEC)', 'Valves & ports', ['Off: one cam profile', 'Intake and exhaust', 'Intake only'], 0,
    'Two lobes per valve. The lift and duration sliders above are the high-speed lobes; the low-speed lobes below run until the engagement speed.'),
  s('vtecRpm', 'VTEC engagement', 'rpm', 'Valves & ports', 2000, 9000, 100, 6000, 'Rockers lock to the high lobe above this speed and release 300 rpm below it.', false),
  s('lowIntakeLift', 'Low-cam intake lift', 'mm', 'Valves & ports', 2, 12, 0.1, 8),
  s('lowExhaustLift', 'Low-cam exhaust lift', 'mm', 'Valves & ports', 2, 12, 0.1, 7.2),
  s('lowIntakeDuration', 'Low-cam intake duration', '°', 'Valves & ports', 160, 300, 1, 226),
  s('lowExhaustDuration', 'Low-cam exhaust duration', '°', 'Valves & ports', 160, 300, 1, 222),
  sel('vtc', 'Intake cam phaser (VTC)', 'Valves & ports', ['Fixed', 'ECU-controlled'], 0,
    'A vane actuator on the intake cam. The cam timing sliders set the fully retarded position; the ECU advances from there with speed and load.'),
  s('vtcRange', 'Phaser range', '°', 'Valves & ports', 0, 60, 1, 50, 'Maximum intake advance in crank degrees.'),

  sel('airFilter', 'Intake mouth', 'Intake', ['Open trumpet', 'Paper air filter'], 1, 'A filter element is a flow resistance: it costs a little pressure and damps intake-pipe ringing.'),
  s('exhaustPortOpen', 'Exhaust port opens', '° ATDC', 'Valves & ports', 70, 115, 0.5, 90, 'Two-stroke. The port closes at the same angle before TDC.'),
  s('transferPortOpen', 'Transfer ports open', '° ATDC', 'Valves & ports', 100, 140, 0.5, 118, 'Two-stroke. Must open after the exhaust port so the cylinder blows down first.'),
  s('crankcaseCR', 'Crankcase compression', ':1', 'Valves & ports', 1.2, 1.8, 0.01, 1.45, 'Two-stroke. Ratio of crankcase volume at TDC to BDC: the pump that drives scavenging.'),
  s('exhaustPortWidth', 'Exhaust port width', '% bore', 'Valves & ports', 35, 75, 1, 62, 'Two-stroke. Wider flows more; real ports are limited to about 70 % by ring life.'),
  s('transferPortWidth', 'Transfer port width', '% bore', 'Valves & ports', 50, 150, 1, 110, 'Two-stroke. Total width of all transfer ports around the bore.'),
  tog('powerValve', 'Exhaust power valve', 'Valves & ports', 0, 'Two-stroke. Lowers the top of the exhaust port by 8° below about 6500 rpm, trading peak power for mid-range.'),
  sel('induction', 'Induction', 'Valves & ports', ['Reed valve', 'Piston port', 'Rotary disc valve'], 0, 'Two-stroke: how the crankcase is filled.'),
  s('reedStiffness', 'Reed stiffness', 'Hz', 'Valves & ports', 80, 320, 5, 180, 'Natural frequency of the reed petal. Stiff reeds follow high rpm but resist opening.'),
  s('inductionDuration', 'Induction duration', '°', 'Valves & ports', 110, 220, 1, 160, 'Piston port: centred on TDC. Rotary disc: the angle before it closes.'),
  s('inductionClose', 'Induction closes', '° ATDC', 'Valves & ports', 30, 90, 1, 60, 'Rotary disc valve only: its timing need not be symmetric.'),

  s('throttleBody', 'Throttle body Ø', 'mm', 'Intake', 25, 100, 1, 60),
  s('intakeLength', 'Intake pipe length', 'mm', 'Intake', 100, 800, 5, 300, 'Ambient to throttle.'),
  s('runnerLength', 'Runner length', 'mm', 'Intake', 100, 700, 5, 320),
  s('runnerDiameter', 'Runner Ø', 'mm', 'Intake', 22, 65, 0.5, 40),
  s('plenumVolume', 'Plenum volume', 'L', 'Intake', 0.5, 12, 0.1, 3),

  s('headerLength', 'Header length', 'mm', 'Exhaust', 150, 1500, 5, 500),
  s('headerSpread', 'Header length spread', '%', 'Exhaust', 0, 40, 1, 0, 'Makes the outer cylinders\' pipes longer than the inner ones, as in a compact or cast manifold. Unequal pipes give a rougher note with more low orders.'),
  s('headerDiameter', 'Header Ø', 'mm', 'Exhaust', 22, 65, 0.5, 38),
  s('chamberDiameter', 'Chamber belly Ø', 'mm', 'Exhaust', 50, 160, 1, 110, 'Two-stroke expansion chamber: widest diameter.'),
  tog('chamberSilencer', 'Stinger silencer', 'Exhaust', 1, 'Two-stroke: a small silencer volume after the stinger.'),
  sel('manifold', 'Header material', 'Exhaust', ['Steel tube', 'Cast iron'], 0, 'Cast iron is rough inside (more friction and heat transfer) and thick, so it heats up slowly.'),
  sel('collector', 'Collector type', 'Exhaust', COLLECTOR_LABELS, 0),
  s('midLength', 'Collector pipe length', 'mm', 'Exhaust', 200, 3000, 10, 700, 'Collector to muffler.'),
  sel('rearSplit', 'Rear section', 'Exhaust', ['Single muffler and tailpipe', 'Y-split to twin mufflers and tailpipes'], 0,
    'With "All into one" or "Paired" collectors: one pipe runs back and splits to a muffler and tailpipe on each side. Muffler volume is the total of both; tailpipe diameter is per pipe.'),
  sel('catalyst', 'Catalytic converter', 'Exhaust', ['None', 'Fitted'], 0, 'A honeycomb brick in a can, a third of the way to the muffler. It resists flow and takes the edge off the pressure pulses.'),
  sel('mufflerType', 'Muffler type', 'Exhaust', ['Empty chamber', 'Straight-through (perforated core)', 'Baffled'], 0, 'How hard it is for gas to leave the muffler. More resistance quietens the upper harmonics and costs some power.'),
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
  tog('fuelCut', 'Overrun fuel cut', 'Running', 1, 'Four-stroke. Fuel injection shuts off with the throttle closed above idle, so the engine coasts down silently and picks up cleanly. Off behaves like a carburettor: a starved, diluted charge that fires irregularly.'),

  s('carMass', 'Car mass', 'kg', 'Car', 150, 2500, 10, 1500, 'With driver and fuel.'),
  sel('drivetrain', 'Driven wheels', 'Car', ['Front', 'Rear', 'All four'], 0, 'Also sets weight distribution: 60 % front for front-drive, 50 % for rear-drive, 56 % for all-wheel drive.'),
  s('finalDrive', 'Final drive', ':1', 'Car', 2, 7, 0.01, 4.76),
  s('gear1', '1st gear', ':1', 'Car', 1.5, 4.5, 0.01, 3.27),
  s('gear2', '2nd gear', ':1', 'Car', 1, 3, 0.01, 1.88),
  s('gear3', '3rd gear', ':1', 'Car', 0.8, 2.2, 0.01, 1.36),
  s('gear4', '4th gear', ':1', 'Car', 0.6, 1.8, 0.01, 1.03),
  s('gear5', '5th gear', ':1', 'Car', 0.5, 1.5, 0.01, 0.83),
  s('gear6', '6th gear', ':1', 'Car', 0.4, 1.3, 0.01, 0.66),
  s('tyreDiameter', 'Tyre diameter', 'mm', 'Car', 450, 750, 5, 640),
  s('tyreGrip', 'Tyre grip', 'μ', 'Car', 0.6, 1.8, 0.01, 1.05, 'Peak friction coefficient on asphalt. Road tyres are about 1.0, slicks 1.5.'),
  s('dragArea', 'Drag area (Cd·A)', 'm²', 'Car', 0.25, 1.2, 0.01, 0.62),
  s('brakeForce', 'Brake strength', 'g', 'Car', 0.5, 2, 0.05, 1.3, 'Deceleration the brakes could give at full pedal if the tyres held.'),
  tog('autoShift', 'Automatic gear changes', 'Car', 1),
  tog('autoClutch', 'Automatic clutch', 'Car', 1, 'Slips the clutch to pull away, opens it before a stall and during shifts. Off: hold C for the clutch pedal.'),
  tog('abs', 'Anti-lock brakes', 'Car', 1),
  tog('tc', 'Traction control', 'Car', 1),

  s('volume', 'Master volume', '%', 'Audio', 0, 100, 1, 70),
  s('mixExhaust', 'Exhaust', '%', 'Audio', 0, 100, 1, 100),
  s('mixIntake', 'Intake', '%', 'Audio', 0, 100, 1, 100),
  s('mixMech', 'Mechanical (faked)', '%', 'Audio', 0, 100, 1, 35),
  s('mixCar', 'Tyres and wind (faked)', '%', 'Audio', 0, 100, 1, 60, 'Driving mode only.'),
  s('listenerPos', 'Listener position', 'm', 'Audio', -1, 5, 0.1, 3, '0 = intake mouth at the front, 3.5 = tailpipe exit.'),
  s('listenerDist', 'Listener distance', 'm', 'Audio', 0.5, 10, 0.1, 1.5, 'Sideways distance from the car centreline.'),

  fx('fxGas', 'Cylinder gas properties', ['Constant γ = 1.35', 'Temperature-dependent'], ['approximated', 'modelled'], 1,
    'Specific heat rising with temperature lowers peak temperature and pressure, so no heat-release fudge factor is needed.'),
  fx('fxInertia', 'Reciprocating inertia', ['Ignored', 'Piston and rod mass'], ['off', 'modelled'], 1,
    'The mass of pistons and rods exchanges energy with the crank every stroke and reshapes the torque at high rpm.'),
  fx('fxBlowby', 'Ring blow-by', ['Perfect seal', 'Ring-gap leak'], ['off', 'modelled'], 1,
    'A small orifice from each cylinder to the crankcase. It matters most at cranking and idle speeds.'),
  fx('fxEnds', 'Pipe open ends', ['Ideal open end', 'End-corrected', 'Radiation impedance'], ['approximated', 'approximated', 'modelled'], 2,
    'The air just outside an open end moves with the wave, making the pipe acoustically longer. The radiation model also lets high frequencies leave instead of reflecting, so upper pipe resonances ring less.'),
  fx('fxTurb', 'Flow turbulence', ['Off', 'Turbulence model'], ['off', 'approximated'], 1,
    'Random fluctuation of the flow through the valves, which travels down the pipes as broadband noise, plus jet noise at the pipe exits. Amplitudes come from scaling laws; the waveform is noise.'),
  fx('fxWalls', 'Pipe wall temperature', ['Fixed', 'Thermal model'], ['approximated', 'modelled'], 1,
    'Walls have heat capacity: headers heat up under load and cool at idle, which shifts the sound speed and the tuning.'),
  fx('fxGround', 'Listening space', ['Free field', 'Ground reflection'], ['approximated', 'modelled'], 1,
    'Adds the reflection from hard ground as an image source, which comb-filters the sound with distance.'),
  fx('fxVar', 'Cylinder and cycle variation', ['Identical', 'Varying'], ['off', 'approximated'], 1,
    'No two cylinders or cycles burn alike. Each cycle gets a slightly different burn rate and heat release, and each cylinder a small fixed offset. This is what gives a real engine sound between its firing harmonics.'),
  fx('fxAfterfire', 'Exhaust afterfire', ['Off', 'Ignition model'], ['off', 'approximated'], 0,
    'A pocket of unburned charge in the exhaust can ignite where it meets hot gas, then burns as a flame travelling along the pipe: separate pops on the limiter and after a spark cut, not a continuous burn.'),
  fx('fxMech', 'Mechanical noise', ['Off', 'Filtered noise'], ['off', 'faked'], 1,
    'Not simulated: band-passed cylinder pressure and noise bursts at valve closing.'),
];

/** Not shown as sliders; driven by dedicated controls. */
export const HIDDEN_DEFAULTS: Params = { starter: 0, timeScale: 1, paused: 0, cellBudget: 140, drive: 0, steer: 0, brake: 0, clutch: 0 };

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
    id: 'k24', name: 'Honda K24 2.4 L i-VTEC (Accord Euro CL9)', blurb: 'VTEC on both cams at 6000 rpm, intake cam phaser, 4-2-1 manifold, one pipe splitting to twin mufflers and tailpipes.',
    values: {
      layout: 1, cylinders: 4, crank: 0, firingOrder: 0, bore: 87, stroke: 99, rodLength: 152, compression: 10.5, flywheel: 0.14, mechDetail: 1,
      valvesPerCyl: 1, intakeValveSize: 40, exhaustValveSize: 34, camProfile: 2,
      intakeLift: 11.5, exhaustLift: 11.5, intakeDuration: 268, exhaustDuration: 262, lsa: 118, camAdvance: -10,
      vtec: 1, vtecRpm: 6000, lowIntakeLift: 8, lowExhaustLift: 7.2, lowIntakeDuration: 226, lowExhaustDuration: 222, vtc: 1, vtcRange: 50,
      throttleBody: 60, intakeLength: 350, runnerLength: 330, runnerDiameter: 46, plenumVolume: 3.5,
      // exhaust dimensions fitted to a near-exhaust recording, see scripts/compare.ts
      // layout as on the car: 4-2-1 manifold, catalyst, one centre pipe, Y-split to twin rear mufflers
      headerLength: 420, headerSpread: 20, headerDiameter: 40, collector: 1, catalyst: 1, midLength: 1800, rearSplit: 1, mufflerType: 1, mufflerVolume: 12, tailLength: 250, tailDiameter: 45,
      idleRpm: 750, revLimit: 7100,
    },
  },
  {
    id: 'thumper', name: 'Single-cylinder thumper', blurb: '600 cc single, short megaphone exhaust.',
    values: {
      layout: 0, cylinders: 1, bore: 100, stroke: 76, rodLength: 130, compression: 10, flywheel: 0.08,
      intakeLift: 10, exhaustLift: 9, intakeDuration: 258, exhaustDuration: 256, lsa: 108,
      throttleBody: 42, intakeLength: 180, runnerLength: 220, runnerDiameter: 40, plenumVolume: 1.5,
      headerLength: 650, headerDiameter: 40, collector: 0, midLength: 300, mufflerVolume: 3, tailLength: 300, tailDiameter: 38,
      idleRpm: 1300, revLimit: 7500, ignitionAdvance: 18,
      carMass: 380, drivetrain: 1, dragArea: 0.5, finalDrive: 4.2,
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
      carMass: 1700, drivetrain: 1, finalDrive: 3.42, gear1: 2.66, gear2: 1.78, gear3: 1.3, gear4: 1, gear5: 0.74, gear6: 0.5, tyreDiameter: 680, dragArea: 0.7,
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
      carMass: 1480, drivetrain: 1, finalDrive: 4.4, gear1: 3.08, gear2: 2.19, gear3: 1.63, gear4: 1.29, gear5: 1.03, gear6: 0.84, tyreDiameter: 690, tyreGrip: 1.25,
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
      carMass: 1450, drivetrain: 1, finalDrive: 3.44, gear1: 3.82, gear2: 2.2, gear3: 1.52, gear4: 1.22, gear5: 1.02, gear6: 0.84, tyreDiameter: 680, tyreGrip: 1.2,
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
      carMass: 480, drivetrain: 1, finalDrive: 3.2, dragArea: 0.55,
    },
  },
  {
    id: 'i6', name: 'Inline-6 3.0 L', blurb: 'Even 120° firing, split 3-into-1 pairs.',
    values: {
      layout: 1, cylinders: 6, crank: 0, firingOrder: 0, bore: 84, stroke: 89.6, rodLength: 138, compression: 10.2, flywheel: 0.2,
      throttleBody: 70, runnerLength: 360, runnerDiameter: 38, plenumVolume: 5,
      headerLength: 450, headerDiameter: 38, collector: 1, midLength: 800, mufflerVolume: 16, tailLength: 900, tailDiameter: 57,
      idleRpm: 750, revLimit: 7000,
      carMass: 1550, drivetrain: 1, finalDrive: 3.46, gear1: 4.11, gear2: 2.32, gear3: 1.54, gear4: 1.18, gear5: 1, gear6: 0.85,
    },
  },
  {
    id: '2t250', name: 'Two-stroke single 250 cc', blurb: 'Reed-valve single with an expansion chamber: it comes "on the pipe".',
    values: {
      strokes: 1, layout: 0, cylinders: 1, bore: 66.4, stroke: 72, rodLength: 125, compression: 12.5, flywheel: 0.03,
      exhaustPortOpen: 88, transferPortOpen: 118, crankcaseCR: 1.45,
      throttleBody: 36, intakeLength: 150, runnerLength: 100, runnerDiameter: 36,
      headerLength: 1000, headerDiameter: 40, chamberDiameter: 110, midLength: 600, mufflerVolume: 1, tailLength: 300, tailDiameter: 25,
      afr: 12.5, ignitionAdvance: 18, burnDuration: 44, idleRpm: 1600, revLimit: 10000,
      carMass: 190, drivetrain: 1, dragArea: 0.45, finalDrive: 5.2, tyreDiameter: 480, tyreGrip: 1.3,
    },
  },
  {
    id: '2t350', name: 'Two-stroke twin 350 cc', blurb: '180° parallel twin, one chamber per cylinder.',
    values: {
      strokes: 1, layout: 1, cylinders: 2, crank: 1, bore: 64, stroke: 54, rodLength: 110, compression: 12, flywheel: 0.03,
      exhaustPortOpen: 86, transferPortOpen: 117, crankcaseCR: 1.45,
      throttleBody: 28, intakeLength: 130, runnerLength: 100, runnerDiameter: 30,
      headerLength: 820, headerDiameter: 36, chamberDiameter: 95, midLength: 500, mufflerVolume: 1.6, tailLength: 300, tailDiameter: 25,
      afr: 12.5, ignitionAdvance: 18, burnDuration: 42, idleRpm: 1500, revLimit: 9500,
      carMass: 260, drivetrain: 1, dragArea: 0.45, finalDrive: 5.4, tyreDiameter: 520, tyreGrip: 1.25,
    },
  },
  {
    id: '2t750', name: 'Two-stroke triple 750 cc', blurb: '120° triple firing every 120°.',
    values: {
      strokes: 1, layout: 1, cylinders: 3, crank: 0, bore: 71, stroke: 63, rodLength: 120, compression: 11.5, flywheel: 0.05,
      exhaustPortOpen: 88, transferPortOpen: 118, crankcaseCR: 1.42,
      throttleBody: 30, intakeLength: 140, runnerLength: 100, runnerDiameter: 32,
      headerLength: 880, headerDiameter: 38, chamberDiameter: 100, midLength: 500, mufflerVolume: 2.4, tailLength: 300, tailDiameter: 25,
      afr: 12.5, ignitionAdvance: 18, burnDuration: 44, idleRpm: 1400, revLimit: 8500,
      carMass: 340, drivetrain: 1, dragArea: 0.5, finalDrive: 4.6, tyreDiameter: 560, tyreGrip: 1.25,
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
