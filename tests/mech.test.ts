import { describe, expect, it } from 'vitest';
import { EngineSim } from '../src/sim/engine';
import { DRIVE_TEETH, MECH_TUNE, MechConfig, MechNoise } from '../src/sim/mech';
import { presetParams } from '../src/sim/params';
import { aimMic, spectrum } from './util';

const SR = 48000, dt = 1 / SR;
const base: MechConfig = { cylinders: 1, bore: 0.086, displacement: 5e-4, clearance: 40e-6, pistonMass: 0.31, lash: 0.2, valveMassIn: 0.1, valveMassEx: 0.09, drive: -1, injectors: false };
const make = (extra: Partial<MechConfig> = {}) => { const m = new MechNoise(); m.configure({ ...base, ...extra }); return m; };

describe('mechanical noise sources', () => {
  it('piston slap: one landing per reversal of side thrust, and the block rings afterwards', () => {
    const m = make();
    let loud = 0;
    const run = (force: number, seconds: number) => { for (let i = 0; i < seconds * SR; i++) { m.cylinder(0, 0, force, dt); m.step(dt); loud = Math.max(loud, Math.abs(m.out)); } };
    run(800, 0.02);
    const settled = m.stats.slapHits;
    loud = 0;
    run(800, 0.02);
    // resting on the wall under steady thrust: no new landings, and the ringing has died away
    expect(m.stats.slapHits).toBe(settled);
    const quiet = loud;
    loud = 0;
    run(-800, 0.02);
    expect(m.stats.slapHits).toBe(settled + 1);
    expect(loud).toBeGreaterThan(20 * quiet);
  });

  it('a larger clearance lets the piston build more speed, so it lands harder', () => {
    const peak = (clearance: number) => {
      const m = make({ clearance });
      let loud = 0;
      for (let i = 0; i < 0.02 * SR; i++) { m.cylinder(0, 0, 800, dt); m.step(dt); }
      for (let i = 0; i < 0.01 * SR; i++) { m.cylinder(0, 0, -800, dt); m.step(dt); loud = Math.max(loud, Math.abs(m.out)); }
      return loud;
    };
    expect(peak(120e-6)).toBeGreaterThan(1.3 * peak(30e-6));
  });

  it('valve seating: gentle on the cam ramp and proportional to speed, hard once the lash exceeds the ramp', () => {
    // a closing flank passing through the lash height at 2 m/s
    const seat = (lash: number, camDegPerSec: number) => {
      const m = make({ lash });
      const h = lash * 1e-3;
      m.valve(0, false, h + 1e-5, h - 2 * dt + 1e-5, dt, camDegPerSec);
      return m.stats.valve;
    };
    const slow = seat(0.2, 3000), fast = seat(0.2, 9000);
    expect(fast / slow).toBeCloseTo(3, 5);
    // 0.02 mm per cam degree at 3000 deg/s is 0.06 m/s; landing mass 0.1 kg with restitution 0.3
    expect(slow).toBeCloseTo(0.1 * 0.06 * 1.3, 6);
    expect(seat(0.5, 3000)).toBeGreaterThan(10 * slow);
    expect(seat(0, 3000)).toBeLessThan(0.5 * slow);
  });

  it('a steady force makes no sound: only changing forces radiate', () => {
    const m = make();
    let late = 0;
    for (let i = 0; i < SR; i++) { m.cylinder(0, 20000, 0, dt); m.step(dt); if (i > 0.9 * SR) late = Math.max(late, Math.abs(m.out)); }
    expect(late).toBeLessThan(1e-9);
  });

  it('an injector clicks once on opening and once on closing', () => {
    const m = make({ injectors: true });
    m.injector(0, 0.003);
    const opened = m.stats.injector;
    expect(opened).toBeGreaterThan(0);
    for (let i = 0; i < 0.002 * SR; i++) m.step(dt);
    expect(m.stats.injector).toBe(opened);
    for (let i = 0; i < 0.002 * SR; i++) m.step(dt);
    expect(m.stats.injector).toBeGreaterThan(opened);
    const carb = make();
    carb.injector(0, 0.003);
    expect(carb.stats.injector).toBe(0);
  });

  it('rubbing surfaces make a steady noise that grows 6 dB per doubling of speed', () => {
    const level = (omega: number) => {
      const m = make();
      let ms = 0;
      for (let i = 0; i < SR / 2; i++) { m.drive(0, omega); m.step(dt); ms += m.out * m.out; }
      return 10 * Math.log10(ms);
    };
    expect(level(0)).toBe(-Infinity);
    expect(level(400) - level(200)).toBeCloseTo(6, 0);
  });

  it('each kind of source has its own volume, and the tone controls do what they say', () => {
    const ring = (extra: Partial<MechConfig>) => {
      const m = make({ lash: 0.5, ...extra });
      const x = new Float64Array(4096);
      m.valve(0, false, 1e-3, 0, dt, 3000);
      for (let i = 0; i < x.length; i++) { m.step(dt); x[i] = m.out; }
      return x;
    };
    const energy = (x: Float64Array, from = 0) => { let e = 0; for (let i = from; i < x.length; i++) e += x[i] * x[i]; return e; };
    const gains = { gas: 1, slap: 1, valve: 1, injector: 1, drive: 1, rough: 1 };
    const base = ring({});
    expect(energy(ring({ gains: { ...gains, valve: 0 } }))).toBe(0);
    expect(energy(ring({ gains: { ...gains, valve: 2 } })) / energy(base)).toBeCloseTo(4, 6);
    expect(energy(ring({ gains: { ...gains, slap: 0, gas: 0 } }))).toBeCloseTo(energy(base), 12);
    // a lightly damped block is still ringing when a heavily damped one has stopped
    const late = Math.round(0.01 * SR);
    expect(energy(ring({ damping: 0.01 }), late)).toBeGreaterThan(100 * energy(ring({ damping: 0.08 }), late));
    // tilt moves energy between treble and bass
    const treble = (x: Float64Array) => { const mag = spectrum(x), bin = SR / x.length; let hi = 0, lo = 0; mag.forEach((v, i) => (i * bin > 3200 ? (hi += v * v) : (lo += v * v))); return hi / lo; };
    expect(treble(ring({ tilt: 6 }))).toBeGreaterThan(4 * treble(ring({ tilt: -6 })));
    // a gentler cam ramp sets the valve down more softly
    const seat = (rampRate: number) => { const m = make({ lash: 0.2, rampRate }); m.valve(0, false, 0.2e-3 + 1e-5, 0.2e-3 - 2 * dt + 1e-5, dt, 3000); return m.stats.valve; };
    expect(seat(0.01) / seat(0.02)).toBeCloseTo(0.5, 6);
  });

  it('modes are integrated exactly: a struck mode rings at its own frequency even near the sample rate limit', () => {
    const m = make({ bore: 0.086, cylinders: 4, displacement: 2.4e-3, lash: 0.5 });
    const x = new Float64Array(8192);
    m.valve(0, false, 1e-3, 0, dt, 3000);
    for (let i = 0; i < x.length; i++) { m.step(dt); x[i] = m.out; }
    const mag = spectrum(x), bin = SR / x.length;
    // the top mode is 12.8 kHz; a naive explicit step at 48 kHz would shift it by over a kilohertz
    let pk = Math.round(11000 / bin);
    for (let i = pk; i * bin < 15000; i++) if (mag[i] > mag[pk]) pk = i;
    expect(Math.abs(pk * bin - 12800)).toBeLessThan(250);
  });
});

describe('mechanical noise in the running engine', () => {
  const run = (extra: Record<string, number>, target: number) => {
    const sim = new EngineSim(SR, { ...presetParams('k24'), fxGround: 0, revLimit: 8000, ...extra });
    aimMic(sim, 'engine', 1);
    sim.run(3);
    sim.setParams({ throttle: target ? 100 : 0 });
    let load = 40;
    for (let k = 0; k < 40; k++) {
      if (target) { load = Math.min(100, Math.max(0.5, load * (1 + 1.5 * (sim.rpmAvg - target) / target))); sim.setParams({ load }); }
      sim.run(0.1);
    }
    const x = new Float64Array(65536);
    let ms = 0, rpm = 0;
    for (let i = 0; i < x.length; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); x[i] = sim.lastMech; ms += x[i] ** 2; rpm += sim.rpm / x.length; }
    expect(sim.resets).toBe(0);
    return { db: 10 * Math.log10(ms / x.length / 4e-10), rpm, x, bore: sim.cur.bore };
  };

  it('level at 1 m follows the published speed law for petrol engines within 8 dB, and idle is far quieter', () => {
    const idle = run({}, 0);
    expect(idle.db).toBeGreaterThan(50);
    expect(idle.db).toBeLessThan(75);
    for (const target of [3000, 7000]) {
      const r = run({}, target);
      const published = 50 * Math.log10(r.rpm) + 60 * Math.log10(r.bore) - 203.4;
      expect(Math.abs(r.db - published), `${target} rpm: ${r.db.toFixed(0)} vs ${published.toFixed(0)}`).toBeLessThan(8);
      expect(r.db).toBeGreaterThan(idle.db + 12);
    }
  });

  it('a chain whines at teeth x rpm / 60 and is louder than a belt', () => {
    // the drive on its own: tooth meshing lands on an engine order, where other sources also have lines
    const saved = { ...MECH_TUNE };
    Object.assign(MECH_TUNE, { gas: 0, slap: 0, valve: 0, injector: 0, rough: 0 });
    try {
      const chain = run({ timingDrive: 1 }, 3000), belt = run({ timingDrive: 0 }, 3000);
      const mag = spectrum(chain.x), bin = SR / chain.x.length;
      const c = Math.round((DRIVE_TEETH[1] * chain.rpm) / 60 / bin);
      let peak = 0, around = 0, n = 0;
      for (let i = c - 40; i <= c + 40; i++) { if (Math.abs(i - c) <= 3) peak = Math.max(peak, mag[i]); else { around += mag[i]; n++; } }
      expect(peak / (around / n)).toBeGreaterThan(8);
      expect(chain.db).toBeGreaterThan(belt.db + 10);
    } finally {
      Object.assign(MECH_TUNE, saved);
    }
  });

  it('loose tappets are louder than correctly set ones, and hydraulic adjusters are quietest at idle', () => {
    const loose = run({ valveLash: 0.6, pistonClearance: 10, timingDrive: 0 }, 0);
    const set = run({ valveLash: 0.2, pistonClearance: 10, timingDrive: 0 }, 0);
    const hydraulic = run({ valveLash: 0, pistonClearance: 10, timingDrive: 0 }, 0);
    expect(loose.db).toBeGreaterThan(set.db + 6);
    expect(hydraulic.db).toBeLessThanOrEqual(set.db + 0.5);
  });
});
