// What is physics, what is approximation and what is faked. Shown in the UI.

export const MODEL_NOTES_HTML = `
<h2>What is actually simulated</h2>
<p class="muted">Everything you hear comes from one simulation stepped once per audio sample in the audio thread. The 3D view and the instruments read that same state. Items marked ⚙ can be switched in the <b>Model fidelity</b> panel; the list below describes the higher setting.</p>
<div class="notes">
  <section class="modelled">
    <h3>Physically modelled</h3>
    <ul>
      <li>Crank-slider kinematics, crank-pin layout, bank angle and firing order for each configuration.</li>
      <li>Each cylinder as one gas zone: ideal gas, compression and expansion work, wall heat loss.</li>
      <li>⚙ Cylinder specific heat rising with temperature (γ from 1.40 cold to about 1.25 in the flame).</li>
      <li>⚙ Reciprocating mass of pistons and rods in the crank equation.</li>
      <li>⚙ Ring blow-by as an orifice to the crankcase.</li>
      <li>⚙ Pipe walls with heat capacity that warm under load and cool by convection and radiation.</li>
      <li>⚙ Open-end length corrections, and the ground reflection at the listener.</li>
      <li>Air filter element as a flow resistance at the intake mouth.</li>
      <li>Two-stroke: piston-controlled ports, crankcase pumping, reed valve as a sprung petal, and the expansion chamber as a tapered 1D pipe. The power band is not scripted.</li>
      <li>Valve count and size set the flow area; the 3D head shows the same valves.</li>
      <li>VTEC: two cam profiles per valve, switched per cylinder while the valve is closed. The change in sound at the crossover is not scripted.</li>
      <li>VTC: the intake cam is phased against the crank, changing overlap and intake closing.</li>
      <li>Combustion as Wiebe heat release sized by the fresh air actually trapped.</li>
      <li>Valve flow: compressible orifice with choking, solved together with the pipe's outgoing wave.</li>
      <li>Intake and exhaust pipes: 1D unsteady Euler equations (finite volume, second order). Waves travel, reflect and carry heat and burned gas.</li>
      <li>Plenum, collectors and muffler as volumes exchanging mass and energy with the pipes.</li>
      <li>Crank speed from gas torque, friction, load and inertia. RPM is an output.</li>
      <li>Sound: rate of change of mass flow at the intake mouth and each exhaust outlet, as point sources at their own distances from the listener.</li>
    </ul>
  </section>
  <section class="approx">
    <h3>Approximated</h3>
    <ul>
      <li>Pipes use one gas with constant γ = 1.35. Cylinders do too when set to constant γ, with combustion heat scaled by 0.75; with temperature-dependent gas the factor is 0.9, and gas exchange through the valves still uses the constant-γ enthalpy.</li>
      <li>⚙ Exhaust afterfire: fresh charge above 800 K in an exhaust pipe burns over 1.5 ms. No flame propagation is modelled.</li>
      <li>Idle spark control and idle air valve are idealised ECU functions.</li>
      <li>The VTC advance map and the VTEC engagement speed stand in for the ECU; oil pressure is not simulated, so the phaser moves at a fixed rate.</li>
      <li>The K24A2 preset uses published bore, stroke, rod, compression, valve sizes and switch speed; cam durations, low-lobe lift and manifold dimensions are estimates. It makes about 10 % more torque than the real engine.</li>
      <li>Two-stroke scavenging assumes fresh charge mixes perfectly with burned gas in the cylinder (one zone), which under-fills compared with a real engine.</li>
      <li>Orifice law is the ISO 6358 ellipse (within 4 % of the isentropic nozzle); fixed discharge coefficients.</li>
      <li>Open pipe ends have no radiation loss; the end correction is a fixed added length.</li>
      <li>Collectors are small volumes, so they lose the flow's dynamic head and do not model merge angles.</li>
      <li>Muffler is a single expansion chamber: no baffles, perforations or packing.</li>
      <li>Wall heat transfer (Hohenberg), pipe friction and friction mean pressure are textbook correlations; the cylinder wall is held at 450 K.</li>
      <li>Burn duration and misfire limits versus mixture and residuals are simple empirical curves. Fuel mass is not added to the gas.</li>
      <li>Idle air valve and rev limiter are controllers, as on a real engine, but idealised.</li>
      <li>Cam lobes are a smooth polynomial bump, not a real lobe profile. Valve head sizes are fixed fractions of the bore.</li>
    </ul>
  </section>
  <section class="faked">
    <h3>Faked</h3>
    <ul>
      <li><b>Mechanical noise</b> is not simulated. It is band-pass filtered cylinder pressure plus filtered noise bursts at valve closing.</li>
      <li>No block or pipe-wall vibration, no gear, chain, injector or accessory noise.</li>
      <li>No room or car body: the listener hears direct sound plus, optionally, one ground reflection. Output passes through a soft clipper.</li>
      <li>Detailed 3D parts are visual only: valve springs, timing chain, tensioner, balance shafts, injectors and coils are drawn and move correctly but have no effect on the simulation. Proportions scale with the bore; it is not a CAD copy of any engine.</li>
      <li>3D pipe routing is schematic. Pipe colours map to the real solver cells, but drawn lengths are compressed.</li>
      <li>Engine balance, torsional vibration and block vibration are not modelled.</li>
    </ul>
  </section>
</div>`;
