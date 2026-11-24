import { describe, expect, it } from 'vitest';
import { BAY, CABIN, OUTSIDE, buildScene, detour, tapLevel } from '../src/sim/acoustics';
import { EngineSim } from '../src/sim/engine';
import { LAYOUT_KINDS, resolveLayout } from '../src/sim/layouts';
import { PARAM_BY_KEY, Params, presetParams } from '../src/sim/params';
import { GROUND_Y, micPresets, place } from '../src/sim/placement';
import { buildTopology } from '../src/sim/topology';

const p0 = presetParams('k24');
const layout = resolveLayout(LAYOUT_KINDS[p0.layout | 0], p0.cylinders | 0, p0.bankAngle, p0.crank | 0, p0.firingOrder | 0, false);
const pl = place(p0, layout, buildTopology(p0, layout, 1 / 48000));
const b = pl.body;
const scene = (mic: number[], extra: Params = {}) => buildScene({ ...p0, micX: mic[0], micY: mic[1], micZ: mic[2], carBody: 1, ...extra }, pl);
const BESIDE = [2, 1.2, 0], DRIVER = [0.35, 1.1, b.firewallZ + 0.9], IN_BAY = [0.5, 0.8, -0.2];

describe('placement', () => {
  it('the K24 is laid out like a car: intake ahead of the engine, twin tailpipes about 3.4 m behind, 0.3 m off the ground', () => {
    expect(pl.mouth[2]).toBeLessThan(-pl.half);
    expect(pl.outlets.length).toBe(2);
    for (const o of pl.outlets) {
      expect(o[2]).toBeGreaterThan(3);
      expect(o[2]).toBeLessThan(4);
      expect(o[1] - GROUND_Y).toBeCloseTo(0.3, 1);
    }
    expect(pl.outlets[0][0]).toBeCloseTo(-pl.outlets[1][0], 6);
    // the body encloses engine and intake and leaves the tailpipes poking out
    expect(b.frontZ).toBeLessThan(pl.mouth[2]);
    expect(b.rearZ).toBeLessThan(pl.outlets[0][2]);
  });
});

describe('microphone presets', () => {
  it('each lands where its name says, inside the slider ranges', () => {
    const by = Object.fromEntries(micPresets(pl).map((m) => [m.name, m.at]));
    expect(Object.keys(by).length).toBe(7);
    for (const at of Object.values(by)) {
      for (const [k, v] of [['micX', at[0]], ['micY', at[1]], ['micZ', at[2]]] as const) {
        expect(v).toBeGreaterThanOrEqual(PARAM_BY_KEY[k].min);
        expect(v).toBeLessThanOrEqual(PARAM_BY_KEY[k].max);
      }
    }
    expect(scene(by["Driver's seat"]).zone).toBe(CABIN);
    expect(scene(by['In the engine bay']).zone).toBe(BAY);
    for (const name of ['Behind the exhaust', 'Beside the engine', 'Over the engine', 'In front of the car', 'Roadside, 7.5 m']) expect(scene(by[name]).zone, name).toBe(OUTSIDE);
    expect(by['Behind the exhaust'][2]).toBeCloseTo(pl.outlets[0][2] + 1, 1);
  });
});

describe('listening without a body', () => {
  it('each source is a monopole at its own distance, with an image below the ground', () => {
    const sc = buildScene({ ...p0, micX: 3, micY: 1.2, micZ: 0, carBody: 0 }, pl);
    const r = Math.hypot(3 - pl.engine[0], GROUND_Y + 1.2 - pl.engine[1]);
    const r2 = Math.hypot(3 - pl.engine[0], GROUND_Y + 1.2 - (2 * GROUND_Y - pl.engine[1]));
    expect(sc.engine.length).toBe(2);
    expect(sc.engine[0].gain).toBeCloseTo(1 / (4 * Math.PI * r), 9);
    expect(sc.engine[0].delay).toBeCloseTo(r / 343, 9);
    expect(sc.engine[1].gain).toBeCloseTo(0.85 / (4 * Math.PI * r2), 9);
    expect(buildScene({ ...p0, micX: 3, micY: 1.2, micZ: 0, carBody: 0, fxGround: 0 }, pl).engine.length).toBe(1);
  });

  it('moving the microphone in any direction changes what it hears', () => {
    const at = (x: number, y: number, z: number) => tapLevel(buildScene({ ...p0, micX: x, micY: y, micZ: z, carBody: 0, fxGround: 0 }, pl).outlets.flat(), 1000);
    const tail = pl.outlets[0][2];
    expect(at(1, 1.2, tail)).toBeGreaterThan(at(3, 1.2, tail) + 6);
    expect(at(1, 0.3, tail)).toBeGreaterThan(at(1, 2.5, tail) + 3);
    expect(at(1, 1.2, tail)).toBeGreaterThan(at(1, 1.2, tail - 3) + 6);
  });
});

describe('car body', () => {
  it('a straight line through the body is found, and its detour grows with how deep it cuts', () => {
    expect(detour([3, 0.5, 0], [3, 0.5, 2], b.lower)).toBe(0);
    const graze = detour([-2, b.bonnetY - 0.05, 1], [2, b.bonnetY - 0.05, 1], b.lower);
    const deep = detour([-2, GROUND_Y + 0.5, 1], [2, GROUND_Y + 0.5, 1], b.lower);
    expect(graze).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(5 * graze);
  });

  it('knows which space the microphone is in', () => {
    expect(scene(BESIDE).zone).toBe(OUTSIDE);
    expect(scene(IN_BAY).zone).toBe(BAY);
    expect(scene(DRIVER).zone).toBe(CABIN);
    expect(scene(DRIVER, { carBody: 0 }).zone).toBe(OUTSIDE);
  });

  it('a closed bonnet muffles the engine and takes more off the treble; opening it lets the sound out', () => {
    const off = scene(BESIDE, { carBody: 0 }), closed = scene(BESIDE), open = scene(BESIDE, { bonnetOpen: 100 });
    const cut = (hz: number) => tapLevel(off.engine, hz) - tapLevel(closed.engine, hz);
    expect(cut(1000)).toBeGreaterThan(8);
    expect(cut(4000)).toBeGreaterThan(cut(125) + 4);
    expect(tapLevel(open.engine, 1000)).toBeGreaterThan(tapLevel(closed.engine, 1000) + 6);
    expect(tapLevel(off.engine, 1000) - tapLevel(open.engine, 1000)).toBeLessThan(5);
    // half open is in between
    const half = tapLevel(scene(BESIDE, { bonnetOpen: 30 }).engine, 1000);
    expect(half).toBeGreaterThan(tapLevel(closed.engine, 1000));
    expect(half).toBeLessThan(tapLevel(open.engine, 1000) + 0.01);
  });

  it('an undertray and more lining each make the engine quieter outside', () => {
    const base = tapLevel(scene(BESIDE).engine, 1000);
    expect(tapLevel(scene(BESIDE, { undertray: 1 }).engine, 1000)).toBeLessThan(base - 2);
    expect(tapLevel(scene(BESIDE, { bayLining: 100 }).engine, 1000)).toBeLessThan(base - 1);
  });

  it('the cabin follows the mass law: little loss in the bass, 6 dB more per octave above', () => {
    const off = scene(DRIVER, { carBody: 0 }), cab = scene(DRIVER);
    const cut = (taps: 'engine' | 'intake', hz: number) => tapLevel(off[taps], hz) - tapLevel(cab[taps], hz);
    expect(cut('engine', 125)).toBeLessThan(12);
    expect(cut('engine', 1000)).toBeGreaterThan(18);
    expect(cut('engine', 4000) - cut('engine', 2000)).toBeCloseTo(6, 0);
    const ex = (sc: ReturnType<typeof scene>, hz: number) => tapLevel(sc.outlets.flat(), hz);
    expect(ex(off, 1000) - ex(cab, 1000)).toBeGreaterThan(18);
    // everything arrives as the cabin's own diffuse field
    expect(cab.engine.every((t) => t.diffuse)).toBe(true);
    expect(cab.t60).toBeGreaterThan(0.08);
    expect(cab.t60).toBeLessThan(0.3);
  });

  it('cabin parameters do what they say', () => {
    const lvl = (extra: Params, hz = 1000) => tapLevel(scene(DRIVER, extra).outlets.flat(), hz);
    expect(lvl({ windowsOpen: 100 })).toBeGreaterThan(lvl({}) + 5);
    expect(lvl({ cabinMass: 16 })).toBeCloseTo(lvl({ cabinMass: 8 }) - 6, 0);
    expect(lvl({ cabinAbsorb: 6 })).toBeCloseTo(lvl({ cabinAbsorb: 3 }) - 3, 0);
    const eng = (extra: Params) => tapLevel(scene(DRIVER, extra).engine, 1000);
    expect(eng({ firewallMass: 36 })).toBeLessThan(eng({ firewallMass: 9 }) - 3);
    // road noise is heard through the same glass
    expect(scene(DRIVER).road.fc).toBeGreaterThan(0);
    expect(scene(DRIVER, { windowsOpen: 100 }).road.floor).toBeGreaterThan(scene(DRIVER).road.floor);
    expect(scene(BESIDE).road).toEqual({ gain: 1, fc: 0, floor: 0 });
  });

  it('inside the bay the engine is louder than in the open, and the bay rings for a few hundredths of a second', () => {
    const bay = scene(IN_BAY), off = scene(IN_BAY, { carBody: 0, fxGround: 0 });
    expect(tapLevel(bay.engine, 1000)).toBeGreaterThan(tapLevel(off.engine, 1000) + 3);
    expect(bay.t60).toBeGreaterThan(0.02);
    expect(bay.t60).toBeLessThan(0.1);
    expect(scene(IN_BAY, { bonnetOpen: 100 }).t60).toBeLessThan(bay.t60);
    // the tailpipes are heard only through the bay's openings
    expect(tapLevel(bay.outlets.flat(), 1000)).toBeLessThan(tapLevel(off.outlets.flat(), 1000) - 6);
  });

  it('behind the car the exhaust is untouched', () => {
    const mic = [0, 1.2, b.rearZ + 1];
    expect(tapLevel(scene(mic).outlets.flat(), 1000)).toBeCloseTo(tapLevel(scene(mic, { carBody: 0 }).outlets.flat(), 1000), 6);
  });
});

describe('the running engine heard from different places', () => {
  const rms = (extra: Params) => {
    const sim = new EngineSim(48000, { ...presetParams('k24'), throttle: 30, load: 30, ...extra });
    sim.run(2.5);
    const n = 24000;
    const e = [0, 0, 0];
    for (let i = 0; i < n; i++) { if (i % 128 === 0) sim.beginBlock(); const y = sim.step(); expect(Number.isFinite(y)).toBe(true); e[0] += sim.lastEx ** 2 / n; e[1] += sim.lastIn ** 2 / n; e[2] += sim.lastMech ** 2 / n; }
    expect(sim.resets).toBe(0);
    return e.map((v) => 10 * Math.log10(v + 1e-30));
  };
  const driver = { micX: DRIVER[0], micY: DRIVER[1], micZ: DRIVER[2] };

  it('in the cabin the mechanical noise all but disappears and the exhaust is left as a low drone', () => {
    const out = rms({ ...driver, carBody: 0 }), cab = rms({ ...driver, carBody: 1 });
    expect(cab[2]).toBeLessThan(out[2] - 15);
    expect(cab[0]).toBeLessThan(out[0] - 3);
    // exhaust energy is mostly low orders, which the cabin passes; mechanical noise is mostly above 400 Hz
    expect(out[0] - cab[0]).toBeLessThan(out[2] - cab[2] - 5);
  });

  it('beside the car, opening the bonnet brings the mechanical noise back', () => {
    const mic = { micX: BESIDE[0], micY: BESIDE[1], micZ: BESIDE[2] };
    const closed = rms({ ...mic, carBody: 1 }), open = rms({ ...mic, carBody: 1, bonnetOpen: 100 });
    expect(open[2]).toBeGreaterThan(closed[2] + 3);
    expect(Math.abs(open[0] - closed[0])).toBeLessThan(1);
  });
});
