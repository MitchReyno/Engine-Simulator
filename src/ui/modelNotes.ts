// What is physics, what is approximation and what is faked. Shown in the UI.

export const MODEL_NOTES_HTML = `
<h2>What is actually simulated</h2>
<p class="muted">Everything you hear comes from one simulation stepped once per audio sample in the audio thread. The 3D view and the instruments read that same state.</p>
<div class="notes">
  <section class="modelled">
    <h3>Physically modelled</h3>
    <ul>
      <li>Crank-slider kinematics, crank-pin layout, bank angle and firing order for each configuration.</li>
      <li>Each cylinder as one gas zone: ideal gas, compression and expansion work, wall heat loss.</li>
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
      <li>One gas with constant γ = 1.35 everywhere; combustion heat is scaled by 0.75 to stand in for dissociation and incomplete burning.</li>
      <li>Orifice law is the ISO 6358 ellipse (within 4 % of the isentropic nozzle); fixed discharge coefficients.</li>
      <li>Open pipe ends are ideal pressure-release ends: no end correction, no radiation loss.</li>
      <li>Collectors are small volumes, so they lose the flow's dynamic head and do not model merge angles.</li>
      <li>Muffler is a single expansion chamber: no baffles, perforations or packing.</li>
      <li>Wall heat transfer (Hohenberg), pipe friction and friction mean pressure are textbook correlations with fixed wall temperatures.</li>
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
      <li>No room, ground reflection or car body: the listener is in free field. Output passes through a soft clipper.</li>
      <li>No exhaust afterfire: unburned charge from spark cuts does not ignite in the pipe.</li>
      <li>3D pipe routing is schematic. Pipe colours map to the real solver cells, but drawn lengths are compressed.</li>
      <li>Reciprocating inertia torque, balance, torsional vibration and blow-by are not modelled.</li>
    </ul>
  </section>
</div>`;
