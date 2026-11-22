import { describe, expect, it } from 'vitest';
import { EngineSim } from '../src/sim/engine';
import { Params, presetParams } from '../src/sim/params';
import { CIRCUIT, buildTrack, locate } from '../src/sim/track';
import { Vehicle } from '../src/sim/vehicle';
import { driveFor } from './util-driver';

const SR = 48000;

describe('circuit', () => {
  const t = CIRCUIT;
  it('is a closed, evenly sampled loop about 2 km long with no impossible corners', () => {
    expect(t.length).toBeGreaterThan(1800);
    expect(t.length).toBeLessThan(2600);
    for (let i = 0; i < t.n; i++) {
      const j = (i + 1) % t.n;
      expect(Math.hypot(t.x[j] - t.x[i], t.y[j] - t.y[i])).toBeCloseTo(t.ds, 1);
      expect(Math.abs(t.curv[i])).toBeLessThan(1 / 25);
    }
  });

  it('never runs alongside or across itself', () => {
    const gap = Math.round(60 / t.ds);
    for (let i = 0; i < t.n; i += 3) {
      for (let j = i + gap; j < t.n; j += 3) {
        if (t.n - j + i < gap) continue;
        expect(Math.hypot(t.x[j] - t.x[i], t.y[j] - t.y[i])).toBeGreaterThan(2 * t.halfWidth + 10);
      }
    }
  });

  it('locates a point by distance along the lap and offset from the centreline', () => {
    const i = 400, out = { index: 0, s: 0, d: 0 };
    locate(t, t.x[i] - t.ty[i] * 3, t.y[i] + t.tx[i] * 3, -1, out);
    expect(out.index).toBe(i);
    expect(out.d).toBeCloseTo(3, 3);
    expect(out.s).toBeCloseTo(i * t.ds, 3);
    locate(t, t.x[i + 5] + t.ty[i + 5] * 2, t.y[i + 5] - t.tx[i + 5] * 2, i, out);
    expect(out.index).toBe(i + 5);
    expect(out.d).toBeCloseTo(-2, 3);
  });
});

describe('vehicle', () => {
  const pad = buildTrack([[0, 0], [1000, 0], [1000, 1000], [0, 1000]], 5000);

  it('corners at the tyre grip limit and pushes wide rather than spinning', () => {
    for (const drivetrain of [0, 1, 2]) {
      const p: Params = { ...presetParams('k24'), drivetrain, steer: 0, brake: 0, clutch: 0 };
      const car = new Vehicle(pad);
      car.shift(-1, false);
      expect(car.gear).toBe(0);
      car.vx = 30;
      car.wF = car.wR = 30 / (p.tyreDiameter * 0.5e-3);
      let peak = 0, slide = 0;
      for (let k = 0; k < SR * 5; k++) {
        p.steer = Math.min(60, (k / SR) * 12);
        car.step(1 / SR, 100, p, 0, 400);
        expect(car.clutchTorque).toBe(0);
        peak = Math.max(peak, Math.abs(car.ay) / 9.81);
        slide = Math.max(slide, Math.abs(Math.atan2(car.vy, car.vx)));
      }
      expect(peak).toBeGreaterThan(0.93 * p.tyreGrip);
      expect(peak).toBeLessThan(1.08 * p.tyreGrip);
      expect(slide).toBeLessThan(0.3);
      expect(car.slipF).toBeGreaterThan(car.slipR);
    }
  });

  it('K24 car: idles in gear without creeping or stalling, then accelerates and brakes plausibly', () => {
    const sim = new EngineSim(SR, { ...presetParams('k24'), drive: 1 });
    const car = sim.car;
    sim.run(4);
    expect(car.speed).toBeLessThan(0.3);
    expect(sim.rpm).toBeGreaterThan(600);
    sim.setParams({ throttle: 100 });
    let t100 = 0, time = 0;
    while (time < 14 && car.speed < 31) {
      sim.run(0.1);
      time += 0.1;
      if (!t100 && car.speed * 3.6 >= 100) t100 = time;
    }
    // the real car: about 7.5 s
    expect(t100).toBeGreaterThan(6);
    expect(t100).toBeLessThan(9.5);
    expect(car.gear).toBeGreaterThanOrEqual(3);
    sim.setParams({ throttle: 0, brake: 100 });
    const x0 = car.x, v0 = car.speed;
    time = 0;
    while (car.speed > 0.3 && time < 8) { sim.run(0.05); time += 0.05; }
    const decel = (v0 * v0) / (2 * (car.x - x0)) / 9.81;
    expect(decel).toBeGreaterThan(0.75);
    expect(decel).toBeLessThan(1.15);
    sim.run(2);
    expect(sim.rpm).toBeGreaterThan(500);
    expect(sim.resets).toBe(0);
  });

  it('a robot driver completes a timed lap without leaving the track', () => {
    const sim = new EngineSim(SR, { ...presetParams('k24'), drive: 1 });
    sim.run(2.5);
    let maxOff = 0;
    for (let k = 0; k < 24 && sim.car.laps < 1; k++) maxOff = Math.max(maxOff, driveFor(sim, 5).maxOff);
    expect(sim.car.laps).toBe(1);
    expect(sim.car.lastLap).toBeGreaterThan(65);
    expect(sim.car.lastLap).toBeLessThan(100);
    expect(maxOff).toBeLessThan(CIRCUIT.halfWidth);
    expect(sim.resets).toBe(0);
  });
});
