# Engine Simulator

A piston engine you can see and hear in the browser. The sound is not sampled: it is the unsteady gas flow at the
intake mouth and exhaust outlets of a physics simulation that runs once per audio sample. Changing a physical
parameter (header length, cam timing, crank layout) changes the motion and the sound through the same equations.

```bash
npm install
npm run dev        # open the printed URL, press "Start engine"
npm test           # kinematics, gas-dynamics and whole-engine tests (about 2 minutes)
npm run build      # type-check and build to dist/
npm run probe      # idle / full-load numbers for every preset, in Node
npm run spectra    # firing frequency, pipe-length and V8 crank spectra, in Node
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
- Continuous sliders are slewed inside the audio thread (45 ms time constant). Pipe lengths, diameters and volumes
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

One gas everywhere: ideal, constant γ = 1.35, R = 287 J/kg·K.

### Kinematics

Crank radius r = stroke/2, rod length l, crank angle θ from firing TDC:

- wrist-pin height s(θ) = r cos θ + √(l² − r² sin² θ)
- V(θ) = V_c + A_p (r + l − s(θ)), with V_c = V_d / (CR − 1)
- dV/dθ = A_p r sin θ (1 + r cos θ / √(l² − r² sin² θ))

Each cylinder has a crank-pin angle α and a bank angle β. Its TDC falls at crank angle α − β (mod 360°); the firing
order decides which of the two TDCs per cycle is the firing one. Firing intervals therefore come out of the crank
geometry (90° for both V8s, 315°/405° for the 45° V-twin, 270-180-90-180 for a cross-plane four). If a crank has no
listed firing order the most even one is found by brute force.

Valve lift is L·(1 − x²)² over the seat-to-seat duration, with lobe centres from lobe separation and cam advance.

### Cylinder (one zone)

State: mass m, internal energy E = m c_v T, burned mass. Per step:

- compression/expansion work, integrated with a trapezoid rule that is exact to second order:
  E ← E (1 − k/V₀)/(1 + k/V₁), k = (γ − 1)(V₁ − V₀)/2
- heat release dQ = Q_tot dx_b with the Wiebe function x_b = 1 − exp(−5 ((θ − θ_spark)/Δθ)³), where
  Q_tot = 0.75 · LHV · m_fresh-air / 14.7 · min(1, 1/λ)
- wall heat loss with the Hohenberg coefficient h = 130 V^−0.06 p_bar^0.8 T^−0.4 (S̄_p + 1.4)^0.8 to a 450 K wall
- mass and enthalpy flow through the valves (below)

### Valve and orifice flow

Effective area combines curtain area (0.7·2πd·lift) and port area; two intake valves of 0.36 bore and two exhaust
valves of 0.31 bore. Mass flow follows the ISO 6358 elliptic form of the compressible orifice equation,

ṁ = A_eff p₀ ψ\* / √(R T₀) · √(1 − ((p_d/p₀ − b)/(1 − b))²), choked (constant) below the critical ratio b,

which stays within 4 % of the isentropic nozzle (tested) and needs no `pow`. At a pipe end this law is solved in
closed form together with the pipe's outgoing characteristic p_face = p* + c·ṁ/A. That coupling is what keeps a
barely open valve and a fully open pipe end both stable with one explicit step per sample; with area ratio 1 it
reduces to the ideal open-end condition p_face = p_volume.

### Pipes: 1D unsteady gas dynamics

Conservation of mass, momentum and energy, plus a burned-gas fraction Y:

∂/∂t (ρ, ρu, E, ρY) + ∂/∂x (ρu, ρu² + p, u(E + p), ρuY) = sources, p = (γ − 1)(E − ½ρu²)

Scheme: MUSCL-Hancock (second order in space and time, monotonised-central limiter on ρ, u, p) with a Rusanov
flux; Y is advected first-order upwind. Wall friction (f = 0.02) and heat transfer (Reynolds analogy, fixed wall
temperatures) are applied every step. The scheme is conservative: tests check mass and energy to round-off,
the Sod shock tube against the exact solution, and a closed-open pipe resonating at c/4L.

Network: ambient → intake pipe → throttle → plenum → runners → valves → cylinders → valves → headers → collector
→ collector pipe → muffler → tailpipe → ambient. Plenum, collectors and mufflers are 0D volumes. Collector types:
all-into-one, paired/per-bank into one muffler, true dual (two mufflers and tailpipes), open headers.

### Crank dynamics

I dω/dt = Σ (p_cyl − p_atm) dV/dθ − T_friction − T_load + T_starter

Friction is a mean-effective-pressure correlation, FMEP = 0.45 + 0.06 S̄_p + 0.0015 S̄_p² bar. Load is a brake with
torque ∝ rpm². RPM is an output. With the pedal released an idle air valve (integral controller with a stall
catch) bleeds air past the throttle to hold the idle target.

### Sound

Each open pipe end is a monopole: p(r, t) = (dṁ_out/dt)(t − r/c) / (4πr). The intake mouth, and every tailpipe or
open header, has its own position, distance and delay to the listener. That is why a cross-plane V8 with true
duals burbles from the side: the two uneven banks no longer sum to an even pulse train. Output is scaled
(10 Pa = full scale), high-passed at 12 Hz and soft-clipped with tanh.

## Modelled, approximated, faked

The same list is in the app under "Model notes".

**Physically modelled:** kinematics and firing order; single-zone cylinder thermodynamics with Wiebe heat release
and wall heat loss; choked compressible valve flow; 1D unsteady flow with wave travel, reflection, temperature and
burned-gas transport in every pipe; volumes for plenum, collectors and muffler; crank dynamics; monopole sound
radiation from the pipe mouths.

**Approximated:** one constant-γ gas, with combustion heat scaled by 0.75 to stand in for dissociation and
incomplete burning; elliptic orifice law with fixed discharge coefficients; ideal pressure-release open ends (no
end correction or radiation loss); collectors as small volumes (they lose the dynamic head and ignore merge
angles); the muffler as a single expansion chamber; textbook correlations for wall heat, pipe friction and engine
friction; empirical burn-duration and misfire curves versus mixture and residual gas; fuel mass not added to the
gas; idealised idle valve and rev limiter; a polynomial cam profile.

**Faked:** mechanical noise. It is band-passed cylinder pressure plus filtered noise bursts at valve closing, with
its own mix slider labelled as faked. There is no structure-borne sound, no room or ground reflection, no exhaust
afterfire, and no reciprocating-inertia torque, balance or blow-by. The 3D pipe routing is schematic: colours map
to real solver cells but drawn lengths are compressed.

## Verification

`npm test` runs 32 tests. Beyond the unit tests of kinematics, firing orders and the gas solver, the whole-engine
tests check the points the model has to get right:

| Check | Result |
| --- | --- |
| Firing frequency | Dominant exhaust line at 95.2 Hz for the inline-4 at 2852 rpm (rpm × 4 / 120 = 95.1) and 140.6 Hz for the flat-6 at 2819 rpm (140.9) |
| Longer exhaust lowers the resonance | Single with open header: strongest band moves from about 225 Hz at 500 mm to about 100 Hz at 1000 mm |
| Cross-plane vs flat-plane V8 | Same engine, same pipes: quarter-order content is within a few dB of the firing line for the cross-plane and about −78 dB for the flat-plane |
| Idle | All seven presets start and settle near their idle target with manifold vacuum |
| Redline | Limiter holds the inline-4 within a few percent of 7000 rpm |
| Full load | Inline-4: about 187 N·m at 4600 rpm (93 N·m/L), VE about 1.0, peak pressure about 60 bar; torque peaks near 22–28° advance |
| Extremes | Every slider at each end of its range, and all at once, with no solver reset |
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

- Peak temperatures and pressures follow a constant-γ gas, so they are indicative, not predictive.
- Mufflers pass more low-frequency pulse energy than real ones, and open headers are far too clean, because there
  is no flow noise, no wall radiation and no absorptive loss.
- High-frequency rasp is limited by pipe resolution (see above).
- A collector here cannot model tuned merge collectors or anti-reversion steps.
- The idle controller can hunt with very large valve overlap, much as a real engine lopes.
- Throttle is a single body feeding one plenum; there are no individual throttle bodies, turbochargers or
  variable valve timing.
- Tested in Chrome only. Sample rates of 44.1 and 48 kHz are covered by tests; others should work but are untried.
