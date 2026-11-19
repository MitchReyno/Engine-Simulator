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

### Honda K24A2 preset and the detailed 3D model

The K24A2 preset (Acura TSX) uses published dimensions where I could find them and estimates elsewhere:

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
| Runners, plenum, exhaust | see preset | Estimates; the stock 4-2-1 manifold is modelled as 4-into-1 |

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

## Model fidelity options

The "Model fidelity" panel has one row per aspect, each with a badge saying whether the current choice is
modelled, approximated, faked or left out. Defaults are the higher setting except afterfire.

| Aspect | Lower setting | Higher setting |
| --- | --- | --- |
| Cylinder gas properties | Constant γ = 1.35, combustion heat × 0.75 (approximated) | c_v = 650 + 0.2 T J/kg·K, giving γ from 1.40 cold to about 1.25 at 2500 K; heat × 0.9 (modelled) |
| Reciprocating inertia | Ignored | (I + Σ m s′²) ω̇ = T − Σ m s′ s″ ω², with piston and rod mass from the bore (modelled) |
| Ring blow-by | Perfect seal | Choked/unchoked orifice of about 0.2 mm² to the crankcase (modelled) |
| Pipe open ends | Ideal pressure release (approximated) | Length corrections: 0.61 radius in free air, 0.85 radius into a volume (modelled) |
| Pipe wall temperature | Fixed per pipe (approximated) | Lumped thermal mass per pipe, heated by the gas, cooled by convection and radiation (modelled) |
| Listening space | Free field (approximated) | Hard-ground reflection as an image source per outlet (modelled) |
| Exhaust afterfire | Off | Fresh charge above 800 K in an exhaust pipe burns over 1.5 ms (approximated) |
| Mechanical noise | Off | Filtered cylinder pressure and valve-tick noise (faked) |

With temperature-dependent gas, compression, combustion and expansion use c_v(T); flow through the valves still
uses the pipes' constant-γ enthalpy, so the two models meet at equal temperature and pressure, not equal energy.

The intake mouth can be an open trumpet or carry a paper air filter, modelled as a linear flow resistance
(Δp = 22 Pa per kg/m²s). The filter is what damps intake-pipe ringing when the throttle snaps shut.

## Modelled, approximated, faked

The same list is in the app under "Model notes".

**Physically modelled:** kinematics and firing order; single-zone cylinder thermodynamics with Wiebe heat release
and wall heat loss; choked compressible valve flow; 1D unsteady flow with wave travel, reflection, temperature and
burned-gas transport in every pipe; volumes for plenum, collectors and muffler; crank dynamics; monopole sound
radiation from the pipe mouths.

**Approximated:** constant-γ gas in the pipes (and in the cylinders at the lower setting); perfect-mixing
scavenging; idealised idle air and idle spark control; elliptic orifice law with fixed discharge coefficients; open ends without radiation loss; collectors as small volumes (they lose the dynamic head and ignore merge
angles); the muffler as a single expansion chamber; textbook correlations for wall heat, pipe friction and engine
friction; empirical burn-duration and misfire curves versus mixture and residual gas; fuel mass not added to the
gas; idealised idle valve and rev limiter; a polynomial cam profile.

**Faked:** mechanical noise. It is band-passed cylinder pressure plus filtered noise bursts at valve closing, with
its own mix slider labelled as faked. There is no structure-borne sound, no room beyond the optional ground reflection, and no
engine balance or torsional vibration. The 3D pipe routing is schematic: colours map
to real solver cells but drawn lengths are compressed.

## Verification

`npm test` runs 52 tests. Beyond the unit tests of kinematics, firing orders and the gas solver, the whole-engine
tests check the points the model has to get right:

| Check | Result |
| --- | --- |
| Firing frequency | Dominant exhaust line at 95.2 Hz for the inline-4 at 2852 rpm (rpm × 4 / 120 = 95.1) and 140.6 Hz for the flat-6 at 2819 rpm (140.9) |
| Longer exhaust lowers the resonance | Single with open header: strongest band moves from about 225 Hz at 500 mm to about 100 Hz at 1000 mm |
| Cross-plane vs flat-plane V8 | Same engine, same pipes: quarter-order content is within a few dB of the firing line for the cross-plane and about −78 dB for the flat-plane |
| K24 variable valvetrain | At full throttle near 4000 rpm the cam phaser adds more than 8 % torque (measured 247 vs 208 N·m); near 6500–6900 rpm the high lobes add more than 15 % power (measured 177 vs 133 kW) |
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

## Performance and what was reduced

Cost is proportional to the number of pipe cells. The default budget is 140 cells for the whole network, which is
coarser than the 3 cm spacing the CFL limit would allow at 48 kHz. On a V8 that means 3 cells per intake runner
and 8 per header, so pipe resonances above roughly 1 kHz are damped by the scheme rather than by physics. No
physics was dropped to get there. The Simulation panel offers 60 to 300 cells, and the worklet lowers the budget
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
  is no flow noise, no wall radiation and no absorptive loss.
- High-frequency rasp is limited by pipe resolution (see above).
- A collector here cannot model tuned merge collectors or anti-reversion steps.
- The idle controller can hunt with very large valve overlap, much as a real engine lopes.
- Four-strokes use a single throttle body feeding one plenum; there are no individual throttle bodies,
  turbochargers or variable valve timing.
- Tested in Chrome only. Sample rates of 44.1 and 48 kHz are covered by tests; others should work but are untried.
