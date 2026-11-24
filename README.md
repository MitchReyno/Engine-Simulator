# Engine Simulator

A piston engine you can see and hear in the browser. The sound is not sampled: it is the unsteady gas flow at the
intake mouth and exhaust outlets of a physics simulation that runs once per audio sample. Changing a physical
parameter (header length, cam timing, crank layout) changes the motion and the sound through the same equations.

```bash
npm install
npm run dev        # open the printed URL, press "Start engine"
npm test           # kinematics, gas-dynamics and whole-engine tests (about 4 minutes)
npm run build      # type-check and build to dist/
npm run probe      # idle / full-load numbers for every preset, in Node
npm run spectra    # firing frequency, pipe-length and V8 crank spectra, in Node
npx vite-node scripts/sweep.ts 2t250   # full-throttle torque curve of a preset
```

Controls: hold `Space` or `W` (or drag the pedal) for throttle, hold `S` to crank, `I` toggles ignition, `P` pauses.
Chrome or Edge is the tested browser. The app needs `AudioWorklet` and WebGL 2.

## Architecture

```
main thread                                   audio thread (AudioWorklet)
-----------                                   ---------------------------
controls  -- params (postMessage) ----------> EngineSim.beginBlock()   slew parameters, rebuild network if needed
3D view   <-- state snapshot, ~190 Hz ------- EngineSim.step() x128    one simulation step per output sample
instruments   (recycled transferable buffers) -> output samples
AnalyserNode <- GainNode <- worklet output
```

- `src/sim/` is plain TypeScript with no DOM or Web Audio dependency. The worklet and the Node tests run the same
  `EngineSim` class.
- The 3D view and the instruments never integrate anything themselves. They pose parts and draw plots from the
  latest snapshot (crank angle, per-cylinder state, every pipe cell), so sound and picture cannot drift apart.
- Continuous sliders are slewed inside the audio thread (45 ms time constant). The throttle is also smoothed per
  sample: moving it in block-sized steps rings the intake tract at the block rate (375 Hz at 48 kHz), which is
  audible as a honk.
Pipe lengths, diameters and volumes
  are changed in place; if a pipe's cell count has to change its state is resampled. Changing layout, cylinder
  count or collector type rebuilds the gas network behind a 20 ms fade and re-engages the starter.
- Slow motion scales the simulation time step, so audio drops in pitch with it and is faded out below about
  0.25×. Paused, the `+1°` / `+10°` buttons advance the crank by that angle.

## Solver choice: finite-volume Euler, not a digital waveguide

A digital waveguide would be roughly twenty times cheaper and has no numerical damping, but it is linear acoustics
with one fixed sound speed per pipe. It cannot carry a slug of hot exhaust down a cold pipe, steepen a blowdown
pulse, choke, or move fresh and burned gas around, so volumetric efficiency, reversion and scavenging would have
to be added as separate tuned models. Solving the 1D Euler equations gets all of that from the same conservation
laws that make the sound, which is the point of this project. The price is CPU time, managed by pipe resolution
(see "Performance").

## The model and its equations

One ideal gas, R = 287 J/kg·K. Pipes use constant γ = 1.35. Cylinders use either the same constant γ or a
specific heat that rises with temperature (see "Model fidelity options").

### Kinematics

Crank radius r = stroke/2, rod length l, crank angle θ from firing TDC:

- wrist-pin height s(θ) = r cos θ + √(l² − r² sin² θ)
- V(θ) = V_c + A_p (r + l − s(θ)), with V_c = V_d / (CR − 1)
- dV/dθ = A_p r sin θ (1 + r cos θ / √(l² − r² sin² θ))

Each cylinder has a crank-pin angle α and a bank angle β. Its TDC falls at crank angle α − β (mod 360°); the firing
order decides which of the two TDCs per cycle is the firing one. Firing intervals therefore come out of the crank
geometry (90° for both V8s, 315°/405° for the 45° V-twin, 270-180-90-180 for a cross-plane four). If a crank has no
listed firing order the most even one is found by brute force.

Valve lift is L·(1 − x²)^e over the seat-to-seat duration, with lobe centres from lobe separation and cam advance.
The lobe profile option sets e to 3 (pointed), 2 (standard) or 1.3 (fat, fast ramps).

### Cylinder (one zone)

State: mass m, internal energy E = m c_v T, burned mass. Per step:

- compression/expansion work, integrated with a trapezoid rule that is exact to second order:
  E ← E (1 − k/V₀)/(1 + k/V₁), k = (γ − 1)(V₁ − V₀)/2
- heat release dQ = Q_tot dx_b with the Wiebe function x_b = 1 − exp(−5 ((θ − θ_spark)/Δθ)³), where
  Q_tot = 0.75 · LHV · m_fresh-air / 14.7 · min(1, 1/λ)
- wall heat loss with the Hohenberg coefficient h = 130 V^−0.06 p_bar^0.8 T^−0.4 (S̄_p + 1.4)^0.8 to a 450 K wall
- mass and enthalpy flow through the valves (below)

### Valve and orifice flow

Effective area combines curtain area (0.7·n·πd·lift) and port area. Valves per cylinder (2, 4 or 5) and intake and
exhaust valve diameters are sliders, clamped to what fits in the bore. Mass flow follows the ISO 6358 elliptic form of the compressible orifice equation,

ṁ = A_eff p₀ ψ\* / √(R T₀) · √(1 − ((p_d/p₀ − b)/(1 − b))²), choked (constant) below the critical ratio b,

which stays within 4 % of the isentropic nozzle (tested) and needs no `pow`. At a pipe end this law is solved in
closed form together with the pipe's outgoing characteristic p_face = p* + c·ṁ/A. That coupling is what keeps a
barely open valve and a fully open pipe end both stable with one explicit step per sample; with area ratio 1 it
reduces to the ideal open-end condition p_face = p_volume.

### Variable valvetrain (VTEC and VTC)

Two options in the Valves & ports panel, usable on any four-stroke:

- **Variable lift (VTEC).** Each valve has a low-speed and a high-speed lobe. The existing lift and duration
  sliders are the high-speed lobes; four extra sliders set the low-speed ones. Above the engagement speed the
  rockers lock to the high lobe and release 300 rpm below it. As on the real mechanism, a cylinder's lock pin
  only moves while that cylinder's high lobe is on its base circle, so lift never jumps mid-event. It can act
  on both cams or the intake only.
- **Intake cam phaser (VTC).** The cam timing sliders give the fully retarded position. An ECU map advances the
  intake cam from there: none at idle, full range from 2200 to 3800 rpm at high manifold pressure, tapering to
  60 % of range above 5500 rpm, scaled down at light load. The phaser slews at 150 crank degrees per second.

Neither changes the sound by a rule. The change in note at the VTEC crossover comes from the different valve
events feeding the same pipe solver. Oil pressure is not simulated; the map and the switching speed stand in
for the ECU.

### Driving mode

The "Drive" button puts the configured engine in a car on a 2.1 km circuit. Every engine slider stays live.

The car is stepped inside the audio thread, once per sample, next to the engine (`src/sim/vehicle.ts`):

- **Clutch:** a friction clutch, T = clamp(k·(ω_engine − ω_gearbox), ±capacity·engagement). That torque replaces the
  dyno brake in the crank equation, so engine speed is set by the car, not by a rule.
- **Gearbox and wheels:** six ratios plus reverse and a final drive; one lumped wheel per axle with its own inertia;
  front, rear or all-wheel drive.
- **Tyres:** slip ratio and slip angle normalised by their peak values and combined, with force
  μ·F_z·sin(1.35·atan(2.318·s)): a peak at s = 1 falling to 85 % when fully sliding. Grass has 55 % of the grip
  and more rolling resistance.
- **Chassis:** planar single-track model (forward speed, side speed, yaw) with longitudinal weight transfer,
  aerodynamic drag and rolling resistance.
- **Aids** (each can be switched off): automatic clutch, automatic gear changes, ABS and traction control.
- **Lap timing** in simulation time, with three sector gates so a lap cannot be shortcut.

Controls: W/S or the arrow keys for throttle and brake, A/D to steer, E/Q to change gear, C for the clutch
pedal, R to return to the track, G for the grid, V to change camera, Enter for the starter. A gamepad works
too (left stick, triggers, shoulder buttons). Key steering is limited to what the tyres can use at the
current speed, because a key is all-or-nothing.

Each preset carries a car: the K24 gets a 1500 kg front-drive saloon with the TSX six-speed ratios, the V8s
and sixes get rear-drive cars, and the small engines get very light ones.

Simplifications: one tyre per axle, no suspension or lateral weight transfer, no downforce, an ideal
differential, a flat track with no walls, and a 3 % to 5 % rear grip bias that stands in for chassis tuning so
the car pushes wide before it spins. Tyre squeal, wind and grass rumble are shaped noise, labelled as faked.

### Honda K24 preset and the detailed 3D model

The K24 preset (2004 Accord Euro CL9; the same engine as the Acura TSX's K24A2) uses published dimensions where I could find them and estimates elsewhere:

| Value | Used | Source |
| --- | --- | --- |
| Bore × stroke, rod | 87 × 99 mm, 152 mm | Widely published |
| Compression ratio | 10.5:1 | Published |
| Valves | 35 mm intake, 30 mm exhaust, 4 per cylinder | Published; clamped to 40 % and 34 % of bore |
| High-lobe lift | 11.5 mm intake and exhaust | Forum figures quoting 11.45 / 11.50 mm |
| High-lobe duration | 268° / 262° seat to seat | Estimate |
| Low-lobe lift and duration | 8.0 / 7.2 mm, 226° / 222° | Estimate |
| VTEC engagement, limiter | 6000 rpm, 7100 rpm | Published |
| VTC range | 50° | Published |
| Throttle body | 60 mm | Published (2004–2005) |
| Runners, plenum | see preset | Estimates |
| Exhaust | 4-2-1, catalyst, Y-split to twin mufflers | Layout as on the car; lengths and volumes fitted to a recording (see Calibration) |

"3D mechanical detail" (Engine panel) switches the view from schematic parts to a DOHC roller-rocker engine:
toothed sprockets and a moving timing chain with guides and tensioner, the VTC phaser with its vanes visibly
advancing, camshafts with lobes drawn from the simulation's own lift curves (three per valve pair with VTEC),
roller rockers on rocker shafts, the VTEC mid rocker and a lock pin that lights when engaged, valve springs
that compress, retainers and guides, coil-on-plug ignition, injectors and fuel rail, slipper pistons with
three rings and valve reliefs, I-beam rods with cap bolts, crank pulley, starter ring gear, and on an
inline-4 the twin balance shafts and their chain. It is parametric: it follows bore, stroke, rod length,
valve count and size, lift, duration, cam timing and cylinder count, and works on V and flat layouts with one
chain per bank. It is a K-series-style layout, not a CAD copy: proportions scale with the bore.

The detail is visual. Valve springs, chain dynamics, balance shafts and oil pressure are drawn but not simulated.

### Pipes: 1D unsteady gas dynamics

Conservation of mass, momentum and energy, plus a burned-gas fraction Y:

∂/∂t (ρ, ρu, E, ρY)·A + ∂/∂x [(ρu, ρu² + p, u(E + p), ρuY)·A] = (0, p dA/dx, 0, 0) + sources, p = (γ − 1)(E − ½ρu²)

A(x) is the pipe cross-section. Most pipes have constant area; two-stroke expansion chambers are tapered.

Scheme: MUSCL-Hancock (second order in space and time, monotonised-central limiter on ρ, u, p) with a Rusanov
flux; Y is advected first-order upwind. Wall friction (f = 0.02) and heat transfer (Reynolds analogy, fixed wall
temperatures, or the wall thermal model) are applied every step. The scheme is conservative: tests check mass and energy to round-off,
the Sod shock tube against the exact solution, and a closed-open pipe resonating at c/4L.

Four-stroke network: ambient → (air filter) → intake pipe → throttle → plenum → runners → valves → cylinders → valves → headers → collector
→ collector pipe → muffler → tailpipe → ambient. Plenum, collectors and mufflers are 0D volumes. Collector types:
all-into-one, paired/per-bank into one muffler, true dual (two mufflers and tailpipes), open headers.

### Intake system and forced induction

Four-strokes only; the defaults leave the intake as one pipe from the air to the plenum.

- **Air filter:** none, paper, cotton gauze, oiled foam or clogged paper. Each is a flow resistance at the
  start of the intake pipe (0, 22, 9, 14 and 70 Pa per kg/m²s). On the K24 at 6500 rpm a clogged element costs
  about 4 % of torque.
- **Airbox:** a volume fed by a snorkel pipe, ahead of the intake pipe. Box and snorkel form a Helmholtz
  resonator, f = c/2π·√(A/(V·L)), which passes steady flow and blocks pulsation above it. With the default
  7 L box and 250 mm × 65 mm snorkel the K24's intake noise falls 11 dB at 4500 rpm and 18 dB at 6500 rpm, and
  rises 3 dB near 3000 rpm where the firing frequency meets the resonance.
- **Pipe dimensions:** the intake pipe's diameter is set relative to the throttle body (the throttle plate is
  then the restriction); runners can taper from wide at the plenum to the port diameter (a per-cell diameter
  profile in the solver); runner entries are bellmouths by default, or sharp-edged holes that flow 82 % of
  their area (about 5 % of top-end torque on the K24).
- **Compressor** (`src/sim/boost.ts`): a centrifugal wheel between two volumes. Its tip speed U sets the
  highest pressure ratio it can support, PR₀ = (1 + η·σ·U²/(c_p·T₁))^(γ/(γ−1)) (σ = 0.7, η = 0.72). The pressure
  rise it actually supports depends on the flow through it, as in Greitzer's surge model: highest at the surge
  flow (flow coefficient 0.07), falling as flow² above that (the working range), sagging to 40 % of the peak
  at no flow, where the blades are stalled, and rising steeply for flow forced backwards. The air in the wheel
  and pipes has inertia: L·dṁ/dt = p₁ + Δp(ṁ) − p₂ with a 0.6 m column. Outlet temperature follows the
  efficiency; the intercooler removes a set share of the rise.
- **Surge flutter** follows from that characteristic with no extra rule. With the throttle shut and no
  blow-off valve the flow falls below the surge point, where the supported pressure drops as flow drops, so
  the flow collapses and reverses; the charge pipe empties backwards through the wheel until its pressure
  is down to the stalled value; the flow re-attaches and refills the pipe; and it repeats. A stalled wheel also
  wastes power churning the air (4 % of ρ·A·U³), which slows it, and below a pressure ratio of 1.15 there is
  no sag at all, so the flutter dies away. Each burst of backflow also makes broadband noise from the blades
  cutting through it (the jet-noise scaling law with the flow's speed relative to the blades), muffled by the
  filter and airbox. On the K24 lifting off from 90 kPa: 24 bursts a second for about 0.7 s with the default
  4 L charge volume, 15 a second with 8 L, speeding up slightly as it fades.
- **Turbine and wastegate:** compressible orifice flow between a volume at the collector and one downstream,
  doing work η·ṁ·c_p·T·(1 − (p₂/p₁)^((γ−1)/γ)) with η = 0.65. The wastegate is a parallel orifice that a PI
  controller opens on charge pressure above target, or to keep the rim under 540 m/s.
- **Shaft:** I·ω·dω/dt = P_turbine − P_compressor − bearing loss, with inertia growing as the fourth power of
  wheel diameter. Lag, and a big wheel making its boost late, come from this, not from a script.
- **Supercharger:** the same compressor geared to the crank, with its power taken from the crank.
- **Blow-off valve:** vents the charge volume to the air (heard as an extra source beside the intake, with jet
  noise) or back to the compressor inlet when manifold pressure falls well below charge pressure. With none
  the compressor surges (above). A fourth option is a small stiff valve that
  passes a fifth of the flow, which hisses and flutters together.
- **Idle:** with the sag switched off at low pressure ratios the idling compressor is stable. Before that limit
  it surged against the intake pipe and whistled at the pipe's quarter-wave resonance.
- **Blow-off valve** has two fidelity levels: an instant open and shut, or a sprung piston (30 g, 2.5 kN/m,
  cracking at 85 kPa across it so it stays shut against idle vacuum) with charge pressure under it and manifold
  pressure above. Its hiss is jet-mixing noise from the same scaling law as the exhaust jets, using the jet
  speed and density from an isentropic expansion of the charge to atmospheric pressure (sonic at most).
- **Compressor whistle** has three levels. Faked: a tone at six times shaft speed worth 0.1 % of the mass flow.
  Approximated (default): each blade carries its share of the wheel's torque, ṁ·σ·U, and an uneven inflow
  modulates it, giving a plane wave of amplitude p̂ = ε·ṁ·σ·U/A at the blade-passing frequency. That wave
  loses 0 to 10 dB in the filter element, crosses the airbox as an expansion chamber
  (TL = 10·log(1 + ¼(m − 1/m)²·sin²kL)) and drives the air at the mouth with volume flow p̂·A/(ρc). The
  unevenness ε = 0.2 % is assumed. The rotor's own pressure field is left out because it cannot travel up the
  duct: a six-lobed pattern only propagates when the inducer tip is well past Mach 1, which the speed limit
  never allows.
- **Shaft imbalance:** the rotor's residual imbalance (ISO grade 2.5 scaled with wheel size, times a
  multiplier in the mechanical noise detail) gives a force U·ω² turning at shaft speed, fed into the block's
  modal model. At the factory tolerance it is inaudible; a worn turbo at ten or more times that whistles at
  1.5 to 3 kHz. How strongly the turbo couples into the radiating structure is a guess.
- Volume sliders for the whistle and the blow-off valve are in Settings under Audio. Surge flutter with no
  valve is intake sound and has no slider of its own.

Measured on the K24 preset: a 56 mm turbo at 70 kPa holds 67–73 kPa from 3900 to 6500 rpm at 114–130 thousand
rpm and raises torque from 240 to about 390 N·m; a 75 mm wheel at 120 kPa makes 28 kPa at 3500 rpm and 118 kPa
at 6500 rpm; a supercharger set to 50 kPa makes 14, 17 and 31 kPa at 3200, 4500 and 6500 rpm.
`npx vite-node scripts/intake-check.ts` prints this for any preset.

Limits: there is no compressor or turbine map, so efficiency does not vary with operating point; knock,
charge-temperature effects on combustion, exhaust back-pressure on residual gas beyond what the gas solver
gives, and turbine pulse energy recovery beyond a quasi-steady orifice are not modelled; a turbo forces all the
exhaust into one collector. None of it has been compared with a measured turbo engine or a recording.

A **muffler delete** (Exhaust panel) replaces the muffler volume with a joint the size of the pipe: about
9–13 dB more exhaust at the tailpipe on the K24 from 4500 rpm up.

### Dynamometer

The Dyno button opens a panel that runs a pull on the live engine. The simulation has a speed-holding brake
(`dynoRpm`): a PI controller on crank speed that can only absorb torque. The panel sets the speed, reads the
simulation's cycle-averaged brake torque back, and plots it.

- **Sweep:** throttle to the set value, settle at the start speed, then raise the brake's speed at a set rate
  (default 500 rpm/s) and average the readings in 100 rpm bins. Brake torque is gas torque minus friction
  averaged over each cycle, so the engine's own acceleration does not bias it: on the K24 a sweep through
  5000 rpm reads within 6 % of the value held at 5000 rpm.
- **Steps:** hold each speed for 1.1 s, then average for 0.6 s.
- **Charts:** torque and power against speed with peak markers and a hover readout, and a second chart of
  volumetric efficiency, manifold pressure, BMEP, air flow, BSFC, sound level at the microphone, boost or
  compressor speed. Air flow is trapped air per cycle times cycle rate; fuel is air flow over the mixture
  ratio, so BSFC assumes every cycle is fuelled.
- **Runs** are kept (ten at most, saved in the browser), coloured, renameable and overlaid for comparison,
  with CSV export and metric or imperial units.

There is no correction to a standard atmosphere (the simulation's air is always 298 K and 101.3 kPa) and no
drivetrain loss: these are flywheel figures.

### Presets and the newer options

Presets use the newer options only where the real engine would: hydraulic lifters (no valve lash) on the
pushrod V8, the V-twin, the flat-6 and the inline-6; an airbox on the V8 and inline-6 road cars; an oiled-foam
filter on the single and the two-strokes; an open gauze filter and wider piston clearance on the air-cooled
V-twin. The K24 keeps an open intake because its exhaust was fitted to a recording with one (an airbox
moves that match from 5.7 to 10.9 dB), and the flat-plane V8 and flat-6 keep theirs because an airbox removes
20 dB of the intake sound that characterises them. `npx vite-node scripts/preset-check.ts` prints idle and
full-throttle torque for every preset.

### Still gas

Wall friction in the pipes goes as flow speed squared, which leaves small oscillations in still gas undamped.
A floor of 6 m/s on the speed used in the friction term adds the linear loss a real pipe has in its boundary
layer (about 1.5 per second in a 40 mm pipe), so a stopped engine is silent. Extra-fine cells are held to at
least two solver steps per sample for the same reason: at one step, pipes of short systems kept ringing at
rest.

### Two-stroke

Selecting the two-stroke cycle changes the engine, not just a label:

- The cycle is 360°, so every cylinder fires at each TDC and firing intervals follow from the crank alone.
- Ports replace valves. The exhaust and transfer ports are windows in the liner whose open height is how far the
  piston crown is below the port's top edge, so timing is symmetric about BDC. Port widths are sliders. An optional
  power valve lowers the exhaust port's top edge by 8° of timing below about 6500 rpm.
- Each cylinder has its own crankcase volume, compressed by the underside of the piston
  (V_cc = V_min + A_p·(stroke − x), V_min from the crankcase compression ratio). Net torque uses
  (p_cylinder − p_crankcase)·dV/dθ.
- Induction into the crankcase is a reed valve (a sprung petal: second-order system with a chosen natural
  frequency, damping 0.35, driven by the pressure across it), a piston port (symmetric about TDC) or a rotary
  disc (asymmetric window).
- Per-cylinder network: air → carburettor pipe → throttle → reed box → reed passage → crankcase → transfer passage →
  transfer ports → cylinder → exhaust port → expansion chamber → (stinger silencer) → air.
- The expansion chamber is one tapered pipe: header, diverging cone, belly, converging cone, stinger. Nothing about
  the power band is scripted. The diffuser's suction wave and the baffle cone's returning pressure wave come out of
  the 1D solver, and the 250 single's torque falls from about 20 to 15 N·m through the mid-range, then jumps to
  about 22 N·m when it comes on the pipe near 8500 rpm. Lengthening the tuned length moves that peak down.
- Scavenging uses the single-zone cylinder, so incoming charge mixes perfectly with burned gas. That is the
  pessimistic textbook limit; real engines scavenge better, so torque here is lower than a real engine's.

### Crank dynamics

I dω/dt = Σ (p_cyl − p_atm) dV/dθ − T_friction − T_load + T_starter

Friction is a mean-effective-pressure correlation, FMEP = 0.45 + 0.06 S̄_p + 0.0015 S̄_p² bar. Load is a brake with
torque ∝ rpm². RPM is an output. With the pedal released, an idle air valve (integral controller with a stall
catch) and idle spark control (up to ±12° around a retarded base, latched per cylinder at BDC) hold the idle
target. Both fade out smoothly over the first 5 % of pedal travel.

### Sound

Each open pipe end is a monopole: p(r, t) = (dṁ_out/dt)(t − r/c) / (4πr). The intake mouth, and every tailpipe or
open header, has its own position, distance and delay to the listener. That is why a cross-plane V8 with true
duals burbles from the side: the two uneven banks no longer sum to an even pulse train. Output is scaled
(10 Pa = full scale), high-passed at 12 Hz and soft-clipped with tanh.

### Microphone and car body

`src/sim/placement.ts` puts everything in one frame shared by the sound model and the 3D view: origin at the
middle of the crankshaft, x to the left, y up, z towards the rear, with the road 0.44 m below the crank. It
gives the position of the engine block, the intake mouth and every exhaust outlet from the engine's dimensions
and the true pipe lengths, so the 3D view draws the exhaust at full length and each outlet where it is heard.

The microphone is a point in that frame (Settings popup, or click it in the 3D view and drag an arrow: red is left
and right, green is height, blue is front to back; the Microphone button brings it into view). Every source
reaches it by a direct path and, with the ground reflection on, by an image path, each with its own 1/r gain
and delay. While the microphone is selected its label offers places to move it to: behind the exhaust, beside
or over the engine, in the engine bay, the driver's seat, in front of the car, and the 7.5 m roadside position
of a drive-by noise test.

`src/sim/acoustics.ts` adds a car body (Sim Settings, Car body section, off by default). It is sized round the engine and
exhaust: an engine bay ahead of the firewall, a cabin behind it, and the tailpipes just clear of the rear.

- **Outside the car**, the body is two solid boxes. A path they block bends round them and loses level and
  treble by Maekawa's barrier formula (5 dB at the shadow edge, then 3 dB per doubling of detour or
  frequency), approximated by a shelving low-pass.
- **The engine bay and the cabin** are small reverberant rooms. A source of strength q inside one fills it
  with a diffuse field p = q/√(πA), where A is the room's absorption area: lining and trim plus every opening.
  The share of the sound power leaving through an opening of area S is S/A, re-radiated from the opening's
  position. Sound entering a room from a level p outside gives p·√(S·τ/A) inside.
- **Openings of the bay:** underneath (0.5 m², or 0.06 m² with an undertray), the grille (0.1 m²) and the gap
  round the bonnet, which grows with its angle up to 60° at 100 %.
- **Panels** (bonnet skin, firewall, cabin glass and steel) follow the mass law, TL = 20·log(m·f) − 47 dB,
  which is a first-order low-pass at 224/m Hz for a surface density m in kg/m².
- **Inside a room** the microphone hears the direct sound of sources in the same room plus the diffuse field,
  which passes through three feedback echoes spaced by the room's size and decaying in its Sabine time
  T60 = 0.161·V/A (about 50 ms for the bay, 140 ms for the cabin).
- Tyre and wind noise in driving mode pass through the cabin's glass the same way.

For the K24, relative to no body, at 125 Hz / 1 kHz / 4 kHz:

| Microphone | Engine, bonnet closed | Engine, bonnet open | Exhaust |
| --- | --- | --- | --- |
| 2 m beside the engine | −9 / −13 / −18 dB | −3 / −3 / −3 dB | −3 / −4 / −6 dB (rear corner in the way) |
| In the engine bay | +8 / +8 / +8 dB | +6 / +6 / +6 dB | −12 / −13 / −14 dB |
| Driver's seat | −5 / −23 / −35 dB | −8 / −26 / −38 dB | −6 / −24 / −36 dB |
| 1 m behind the tailpipes | −10 / −14 / −20 dB | −8 / −9 / −10 dB | 0 dB |

`npx vite-node scripts/body-check.ts` prints this table for any preset (`PRESET=v8`).

What this leaves out: sound carried through the structure (engine mounts, exhaust hangers), which in a real
car dominates the cabin below about 200 Hz; cabin and bay standing waves (the "boom" at particular speeds);
radiation from the exhaust pipe walls under the floor; the boot; and door and window seals. The rooms are
statistical, so moving the microphone within one changes only the direct sound. The dimensions and areas are
typical values, not measurements of a car, and none of it has been compared with a recording.

### Mechanical noise

`src/sim/mech.ts`. Forces the simulation already computes shake a model of the block and head, and the
vibrating surfaces radiate sound from the engine's position.

Sources:

- **Gas load:** (p − p_atm)·A_piston on the head and, through the crank, the bearings. Only its rate of
  change radiates; a steady load is silent.
- **Piston slap:** the rod's angle turns gas force and piston inertia into side thrust,
  F_s = (p·A + m·s″·ω²)·tan φ. The piston is a mass free to move sideways across the bore clearance, resisted
  by an oil film (weaker in a wider gap). When the thrust reverses it flies across and lands on the liner,
  which is a stiff, damped contact. The contact force drives the block.
- **Valve seating:** when cam lift falls through the valve lash the valve lands. Up to 0.25 mm of lash it
  is set down on the cam's closing ramp at 0.02 mm per cam degree, so the impact grows with speed; beyond
  that it lands on the flank and is far harder (loose tappets). Zero lash means hydraulic adjusters. The
  rocker taking up the lash at opening is a smaller impact.
- **Timing drive:** an impact per tooth engagement of about (moving mass per pitch)·ω·pitch, varying ±30 %
  from link to link, so a chain whines at teeth × rpm / 60 over a rougher background. Belt, chain or gears.
- **Injectors** (four-strokes): a click as the needle hits its stop and another as it reseats, once per cycle
  per cylinder late in the exhaust stroke. The gap between them is the pulse width, which follows manifold
  pressure. The impulse does not depend on speed, so injectors are heard at idle and buried higher up.
- **Roughness:** rings, skirts, bearings, cam followers, chain guides and the belt drive slide and roll over
  rough surfaces. This is a steady random force whose strength is proportional to crank speed (6 dB per
  doubling). It is the one source that is random rather than computed from the engine's state.

Structure: sixteen modes, one per third octave from 400 Hz to 12.8 kHz for an 86 mm four, scaled with bore
and cylinder count, 3 % damping, each integrated exactly over the time step. Each source drives each mode
through a fixed pseudo-random mode shape value, weighted by where that kind of source puts its energy. Sound
pressure is ρ₀·Σ(Aₖ·q̈ₖ)/(4πr).

This is not a model of any particular block. Three things are calibrated:

- **How well each mode radiates** is fitted so that the K24 at idle has the spectrum of an engine-bay
  recording, within 1 dB per third octave from 400 Hz to 12.8 kHz (see Calibration against a recording).
- **The balance of sources** (how strongly valves, injectors, slap and roughness couple into the structure)
  is set from how steady that recording is. See below.
- **The overall scale** puts a 2.4 litre four at 3000 rpm and full load at 87 dB at 1 m, as the published
  correlation for petrol engines predicts (50·log N + 60·log B − 203 dB(A)). The speed dependence then comes
  from the forces: the K24 gives 58 dB at idle, 87 dB at 3000 rpm, 97 dB at 5000 rpm and 101 dB at 7000 rpm
  against 57, 87, 98 and 105 from the correlation.

The Settings popup has a collapsed "Mechanical noise: per-source detail" section, shown while the simulated
version is selected. It gives each source its own volume (gas load, piston slap, valve train, injectors, timing
drive, roughness; 100 % is the fitted balance) and exposes the oil film on the bore, the cam's closing-ramp
velocity, the timing drive's link-to-link irregularity, the block's damping and a spectral tilt.

Not included: main and rod bearing knock, individual accessories (alternator whine, pumps, fan), gear
rattle, reflections inside the engine bay, and any sound path through the car body. The older
filtered-noise version is still selectable and is labelled as faked.

## Model fidelity options

Audio, car body and model fidelity settings live in the Sim Settings popup (toolbar) and are saved in the browser's local
storage, with the pipe resolution, so they survive a reload and a change of preset. Engine parameters are not saved. "Restore defaults"
in the popup clears them.

The "Model fidelity" section of the Settings popup has one row per aspect, each with a badge saying whether the current choice is
modelled, approximated, faked or left out. Defaults are the higher setting except afterfire.

| Aspect | Lower setting | Higher setting |
| --- | --- | --- |
| Cylinder gas properties | Constant γ = 1.35, combustion heat × 0.75 (approximated) | c_v = 650 + 0.2 T J/kg·K, giving γ from 1.40 cold to about 1.25 at 2500 K; heat × 0.9 (modelled) |
| Reciprocating inertia | Ignored | (I + Σ m s′²) ω̇ = T − Σ m s′ s″ ω², with piston and rod mass from the bore (modelled) |
| Ring blow-by | Perfect seal | Choked/unchoked orifice of about 0.2 mm² to the crankcase (modelled) |
| Pipe open ends | Ideal pressure release, or fixed length corrections of 0.61 radius in free air and 0.85 radius into a volume (approximated) | Radiation impedance at ends open to the air: an inertance 0.61 radius long in parallel with a resistance of 1.5 ρc, solved implicitly with the pipe's outgoing wave. About (ka)² of the incident energy radiates instead of reflecting (modelled) |
| Flow turbulence | Off | Valve flow area flickers by 2 % rms (band-limited noise), which travels down the pipes; jet noise at each outlet from Lighthill's U⁸ law at 0.3 of the free-jet pressure. Both levels are set against a recording (approximated) |
| Cylinder and cycle variation | Identical cylinders and cycles | Random heat release and burn duration each cycle, fixed offset per cylinder (approximated) |
| Pipe wall temperature | Fixed per pipe (approximated) | Lumped thermal mass per pipe, heated by the gas, cooled by convection and radiation (modelled) |
| Listening space | Free field (approximated) | Hard-ground reflection as an image source per source (modelled). The car body is a separate switch in the Car body panel (approximated) |
| Exhaust afterfire | Off | A cell with more than 60 % unburned charge ignites at random at a rate 10⁶·exp(−12000/T) per second, T being the hottest gas touching it; the flame spreads to neighbouring cells at 25 m/s and each burns over 2 ms, releasing 40 % of the charge's heating value (approximated) |
| Mechanical noise | Off, or filtered cylinder pressure and valve-tick noise (faked) | Simulated forces on a modal model of the block (approximated; see Mechanical noise) |

With temperature-dependent gas, compression, combustion and expansion use c_v(T); flow through the valves still
uses the pipes' constant-γ enthalpy, so the two models meet at equal temperature and pressure, not equal energy.

Afterfire gives separate pops: on the inline-4 held on the limiter, about 7 per second, each a few dB above
the engine note, and none in normal running, at idle or on a two-stroke's short-circuited charge (which is too
diluted to light). The earlier version burned any fresh gas above 800 K at once, which made a continuous roar.

Overrun fuel cut (Running panel, on by default for four-strokes) stops fuel with the throttle closed more
than 700 rpm above idle and restores it 350 rpm above idle, as an injection ECU does. Without it a closed
throttle leaves a small, heavily diluted charge that ignites on some cycles and not others, which sounds like
a Geiger counter.

Two details of the pipe ends matter at light throttle, where flow at the tailpipe reverses every pulse:
the mouth re-ingests the gas it has just expelled (a "puff" that disperses over 30 ms) before drawing in
outside air, and orifice flow at valves and the throttle is made linear below 150 Pa instead of following a
square root through zero. Without them every reversal put a corner in the sound wave, heard as clicks.

The header material (Exhaust panel) is steel tube or cast iron. Cast iron has a friction factor of 0.045
against 0.02 and a thick wall, so it damps pipe waves more, takes more heat from the gas and warms up slowly.

The status line shows the sound pressure level of exhaust plus intake at the listener in dB re 20 µPa. It is
unweighted, so low-frequency boom counts in full.

The intake mouth can be an open trumpet or carry a paper air filter, modelled as a linear flow resistance
(Δp = 22 Pa per kg/m²s). The filter is what damps intake-pipe ringing when the throttle snaps shut.

## Overrun settings (crackle and pop tunes)

There is no "crackle" switch; the Running panel has the settings an ECU tune changes, and they do nothing at
their defaults:

- **Overrun fuel cut** off, so fuel keeps flowing with the throttle closed.
- **Overrun spark cut** (% of sparks skipped): a skipped spark sends a whole unburned charge into the exhaust.
- **Overrun spark retard** (° later): the cylinders that still fire burn late and keep the exhaust hot.
- **Overrun air** (% throttle held open): at a closed throttle the charge is mostly leftover exhaust gas and
  will not light; this lets in enough fresh air for it to.
- **Overrun settings above** (rpm) and **last** (seconds after lift-off) bound when the three act.

Unburned charge only burns in the pipes with **Exhaust afterfire** on (Sim Settings). Measured on the K24
preset with a heavy flywheel holding the revs, lifting off from 6300 rpm, pops in 3 s: defaults 0; fuel on
only 0; cut 50 %, retard 30°, air 8 %: 1; cut 30 %, retard 50°, air 15 %: 13; cut 50 %, retard 30°, air 20 %:
43; cut 70 %, retard 40°, air 12 %: 53; cut 100 %, air 8 %: 111. With no overrun air: 0
(`scripts/crackle-check.ts`). Free-revving with no load the revs fall through the threshold in a fraction of
a second, so use Drive mode in gear or raise Flywheel inertia. Four-stroke only.

## Display options

None of these change the simulation or the sound.

- **Plots:** each has a ⚙ button. Output waveform: cycles shown, fit or full-scale, trigger, firing-interval
  marks, fill. Spectrogram: scrolling or live spectrum, top frequency (2 to 16 kHz), log or linear axis,
  harmonic marks, scroll speed, colours, brightness. P–V: linear or log–log, all cylinders, a reference
  compression curve (pV^1.35), shaded loop. Cylinder pressure: firing order, overlaid, or a ±90° combustion
  close-up; selected cylinder only; log axis; peak label. Tract: pressure, temperature or flow velocity; fixed
  range; a dot per solver cell; a fading envelope of recent extremes (the standing-wave pattern); burned-gas
  strip. Valve timing: labels, piston curve, overlap shading, spark mark.
- **Output waveform time axis:** always a whole number of engine cycles, in engine time, so it reads the same
  at any engine speed and any simulation speed. It is fed by a second, silent output of the audio worklet
  taken before the volume control and before the slow-motion fade, because the speakers are muted below 0.08×
  speed. In slow motion each plotted point is the low and high of the output samples that fall in one sample of
  engine time, and the trace scrolls in from the right.
- **3D view** (the sliders icon in the top-right corner of the view): mark individual pipe cells, port flow arrows, combustion flashes with a brightness slider (see below), sound paths from every source to
  the microphone, source markers, the car body's air spaces, body style (glass, outline, hidden), block
  opacity, ground grid, turntable, lens and exposure.
- **Floating panels** (Settings, Dyno, plot and view options, and a picked part's sliders) can be dragged by
  their header.
- **Picked parts:** clicking a part in the 3D view shows its description with the sliders that matter for it
  (`PART_PARAMS` in `src/view3d/parts.ts`). They are the same controls as in the side panels and stay in step.

- **Combustion flashes:** a glow in each cylinder while its charge burns and at every exhaust pipe cell where
  the afterfire model has unburned charge alight. Cylinder brightness is the burn rate times the square root of
  the heat released relative to a full atmospheric charge, so idle is dim and boost is brighter. The audio
  thread reports the brightest moment since its last snapshot, and the view holds each flash for about 70 ms,
  because a real burn is over in a millisecond or two. The glows are drawn over the block and pipe walls, not
  inside them. Exhaust flashes need Exhaust afterfire switched on under Model fidelity.

Display options are saved in the browser separately from the audio and fidelity settings.

## Modelled, approximated, faked

The same list is in the app under "Model notes".

**Physically modelled:** kinematics and firing order; single-zone cylinder thermodynamics with Wiebe heat release
and wall heat loss; choked compressible valve flow; 1D unsteady flow with wave travel, reflection, temperature and
burned-gas transport in every pipe; volumes for plenum, collectors and muffler; crank dynamics; monopole sound
radiation from the pipe mouths.

**Approximated:** constant-γ gas in the pipes (and in the cylinders at the lower setting); perfect-mixing
scavenging; idealised idle air and idle spark control; elliptic orifice law with fixed discharge coefficients; open-end radiation as a two-element (resistance and inertance) fit; turbulence as noise scaled by flow; collectors as small volumes (they lose the dynamic head and ignore merge
angles); the muffler as a single expansion chamber; textbook correlations for wall heat, pipe friction and engine
friction; empirical burn-duration and misfire curves versus mixture and residual gas; fuel mass not added to the
gas; idealised idle valve and rev limiter; a polynomial cam profile.

**Faked:** the optional filtered-noise mechanical sound, and tyre, wind and grass noise in driving mode. There is no room beyond the optional ground reflection and the optional car body, and no
engine balance or torsional vibration. The 3D pipe routing is schematic in its bends, but the exhaust is
drawn at its true length and pipe colours map to real solver cells.

## Verification

`npm test` runs 123 tests; two need the recordings and are skipped without them. Beyond the unit tests of kinematics, firing orders and the gas solver, the whole-engine
tests check the points the model has to get right:

| Check | Result |
| --- | --- |
| Firing frequency | Dominant exhaust line at 95.2 Hz for the inline-4 at 2852 rpm (rpm × 4 / 120 = 95.1) and 140.6 Hz for the flat-6 at 2819 rpm (140.9) |
| Longer exhaust lowers the resonance | Single with open header: strongest band moves from about 225 Hz at 500 mm to about 100 Hz at 1000 mm |
| Cross-plane vs flat-plane V8 | Same engine, same pipes: quarter-order content is within a few dB of the firing line for the cross-plane and about −78 dB for the flat-plane |
| K24 variable valvetrain | At full throttle near 4000 rpm the cam phaser adds more than 8 % torque (measured 247 vs 208 N·m); near 6500–6900 rpm the high lobes add more than 15 % power (measured 177 vs 133 kW) |
| Driving: grip | Peak lateral acceleration within 8 % of the tyre grip setting for front, rear and all-wheel drive; the front slides first |
| Driving: K24 car | 0–100 km/h in 7.5 s (the real TSX: about 7.5 s), braking at about 0.9 g, no creep or stall when stopped in gear |
| Driving: lap | A robot driver (pure pursuit, 80 % of grip) laps in about 78–81 s without leaving the track |
| Open-end reflection | A long pulse reflects with over 98.5 % of the energy it has with an ideal end; a short one (content to about 1 kHz, 70 mm pipe) with about 90 %, as theory predicts |
| Louder under load | Inline-4 at the same speed: more than 3 dB louder at full throttle against a load than free-revving |
| Afterfire | No ignitions in normal running; separate pops on the limiter, in fewer than 40 % of 20 ms windows |
| Turbulence | Noise between the engine orders rises more than 30 dB with the model on, more than 20 dB from idle to full load, and stays more than 15 dB under the note |
| Idle | All presets start and settle near their idle target with manifold vacuum |
| Redline | Limiter holds the inline-4 within a few percent of 7000 rpm |
| Full load | Inline-4 with default fidelity: about 195–220 N·m (97–110 N·m/L) between 3000 and 5000 rpm, VE about 1.0–1.1, peak pressure about 63 bar, peak temperature about 2750 K |
| Extremes | Every slider at each end of its range, and all at once, with no solver reset |
| Throttle transients | Opening the throttle adds no tones at the audio block rate (ratio to neighbouring bands 0.7; it was over 500 with a block-stepped throttle) |
| Idle stability | Cycle-averaged idle within ±10 % of target on every four-stroke preset (measured swing 2–6 %), ±20 % on two-strokes |
| Two-stroke | Spectral lines at multiples of rpm/60 with no half-order content; crankcase pressure swings above and below atmospheric; torque on the pipe more than 1.2× the mid-range |
| Tapered pipes | Gas at rest stays at rest; mass and energy conserved to round-off |
| Fidelity options | Every option in every position idles, makes plausible torque and reaches the limiter with no reset |
| No solver tones | Exhaust and intake content above 5 kHz is more than 35 dB below the engine note |

## Calibration against a recording

`scripts/compare.ts` compares the simulator with a recording of a real engine. It tracks engine speed in the
recording from its harmonic comb, reads the level of each engine order (multiples of crank speed) and the noise
floor between them, and does the same to the simulator held at the same speeds at full throttle. Levels are
relative to the firing order, so no microphone calibration is needed.

```
npx vite-node scripts/compare-run.ts '{}' '{"catalyst":0}'   # table per rpm bin and a score for each variant
npx vite-node scripts/render.ts                               # writes a simulated pull to samples/ as WAV and PNG
```

Against a near-exhaust recording of a K24 pulled to 7700 rpm (not in the repository), the mean error over
orders 1 to 8 and the noise floor went from 15 dB to about 5.5 dB. What the recording showed, and what changed:

| Recording | Simulator before | Change |
| --- | --- | --- |
| Noise floor 40–55 dB under the firing order, falling about 8 dB per octave above 2.4 kHz | 20–40 dB under and white: turbulence far too loud and too hissy | Jet noise scaled to 0.3 of the free-jet law with a second low-pass at 2.4 kHz; valve flicker halved to 2 %. The noise between orders now matches within 3 dB per octave from 300 Hz to 19 kHz |
| Orders 1, 1.5, 3, 5 present at −10 to −40 dB | Absent: all cylinders and cycles identical | Cycle-to-cycle scatter of heat release (2 %) and burn duration (3 %), growing slightly with residual gas; a fixed ±5 % spread between cylinders; a header length spread slider |
| Orders 4, 6, 8 at −15 to −25 dB | 10–15 dB stronger, with sharp pipe resonances | Catalytic converter (a volume with a laminar flow resistance) and a muffler type with outlet resistance |

The K24 preset follows the 2004 Accord Euro (CL9) exhaust layout: a 4-2-1 manifold, catalytic converter, one
centre pipe and a Y-split to twin rear mufflers and tailpipes ("Rear section" in the Exhaust panel). Its
dimensions (420 mm primaries with 20 % spread, 1.8 m from collector to mufflers, 12 L of muffler in total,
250 mm tailpipes of 45 mm) come from a coordinate search over plausible values against that recording; with
this layout the error is 5.6 dB. The recorded car's real exhaust is unknown, so those numbers are a fit, not a measurement, and the
remaining 5 dB is within what an unknown microphone position and exhaust could explain. The match is on
spectra at full throttle between 4000 and 7700 rpm only.

### Engine bay

`scripts/bay.ts` does the same for mechanical noise against a recording made beside a running K24 (start,
six throttle blips and about 30 s of idle at 655 rpm; not in the repository). It compares the third-octave
spectrum and, in three bands, how the loudness fluctuates through the engine cycle.

```
npx vite-node scripts/bay-run.ts '{}' '{"mech.slap":0}'   # features of the recording and of each variant
npx vite-node scripts/bay-fit.ts 4                         # refit the per-mode radiation, print the new table
npx vite-node scripts/mech-levels.ts                       # level at 1 m against rpm, beside the correlation
```

| Recording at idle | Simulator before | Change |
| --- | --- | --- |
| Flat within about 4 dB per third octave from 400 Hz to 12.8 kHz, with a hump at 500 Hz | A peak from 2 to 5 kHz, 20 dB short below 800 Hz and above 6 kHz | Sixteen modes up to 12.8 kHz in place of ten up to 4.7 kHz, with per-mode radiation fitted to the recording |
| Mostly steady: loudness ripples at the firing rate by −18 to −11 dB of its mean | Four hard knocks per cycle, ripple −5 dB: piston slap was 8 dB above everything else | Slap coupling halved, valve seating raised, injectors and chain link variation added, and a steady roughness source. Ripple is now −14 to −19 dB |

Limits of this fit: the recording has automatic gain control (its idle level drifts 12 dB after each blip),
so it gives no absolute level and nothing about how level changes with speed; those still come from the
published correlation. The microphone, its position and the room are unknown. Above 5 kHz the recording
shows clearer ticks eight times per cycle than the simulator does. Only the idle section was used.

## Performance and what was reduced

Cost is proportional to the number of pipe cells. The default budget is 140 cells for the whole network, which is
coarser than the 3 cm spacing the CFL limit would allow at 48 kHz. On a V8 that means 3 cells per intake runner
and 8 per header, so pipe resonances above roughly 1 kHz are damped by the scheme rather than by physics. No
physics was dropped to get there. The pipe resolution slider in Sim Settings runs from 60 to 1200. Up to 600 it is a
ceiling: with one solver step per sample a pipe cannot be divided finer than the time step allows, which gives
the K24 at most 204 cells and the cross-plane V8 375, and short systems such as the single stop well short of
the default. Above 600 it asks for cells finer than that, up to about twice as many at 1200, and the solver
takes two steps per sample (three above 900). On the Apple M1 Pro this was developed on, the K24 ran at 30 %
audio-thread load with 140 cells and 44 to 50 % with 204, and every extra-fine setting overloaded and was
trimmed back to 600. The trimmed value is saved, so the next visit starts from what the machine can hold.
Running extra-fine cells in real time would need the gas solver itself to be about three times faster, and the worklet lowers the budget
by itself, and says so in that panel, if the audio thread stays above 70 % load.

Measured in Chrome on an Apple M1 Pro that was heavily loaded by other work, the audio thread sat at 22–41 % for
the inline-4 and V8 at 140 cells. I could not measure it on an idle machine or on other hardware.

If the hottest, fastest gas would break the CFL limit, the step is split into sub-steps for as long as needed (shown in
the status line); cell sizes are chosen so this should not happen in normal running.

## Known limitations

- Peak temperatures and pressures come from a one-zone gas with a simple c_v(T) law, so they are indicative, not
  predictive. Full-load torque per litre is on the high side of real naturally aspirated engines.
- The K24A2 preset makes about 247 N·m and 177 kW against the real engine's 222 N·m and 153 kW. The shape is
  right (flat mid-range, a dip before 6000 rpm, a step at VTEC) but the level shares the bias above.
- Two-stroke torque is low in absolute terms because of the perfect-mixing scavenging assumption, and two-stroke
  idle is rough.
- Applying two-stroke mode to a four-stroke preset works but leaves exhaust and intake dimensions untuned.
- Mufflers pass more low-frequency pulse energy than real ones, and open headers are far too clean, because there
  is no wall radiation and no absorptive loss, and the turbulence model is a scaling law that has not been
  compared with a recording.
- High-frequency rasp is limited by pipe resolution (see above).
- A collector here cannot model tuned merge collectors or anti-reversion steps.
- The idle controller can hunt with very large valve overlap, much as a real engine lopes.
- Four-strokes use a single throttle body feeding one plenum; there are no individual throttle bodies,
  turbochargers or variable valve timing.
- Tested in Chrome only. Sample rates of 44.1 and 48 kHz are covered by tests; others should work but are untried.
