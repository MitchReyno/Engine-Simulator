import { describe, expect, it } from 'vitest';
import { EngineSim } from '../src/sim/engine';
import { presetParams } from '../src/sim/params';
import { DynoPoint, DynoRun, nice, peak, runsToCsv, sampleRun, smooth } from '../src/ui/dyno';

const pt = (rpm: number, torque: number): DynoPoint => ({ rpm, torque, power: (torque * rpm * Math.PI) / 30 / 1000, ve: 100, map: 100, boost: 0, turbo: 0, spl: 90, air: 50, bsfc: 250, bmep: 12 });
const run = (points: DynoPoint[]): DynoRun => ({ id: 1, name: 'Test "A"', color: '#fff', visible: true, kind: 'sweep', throttle: 100, points });

describe('dyno brake in the simulation', () => {
  const sim = new EngineSim(48000, presetParams('k24'));
  sim.run(2.5);
  sim.setParams({ throttle: 100, dynoRpm: 3000 });

  it('holds the engine at the set speed at full throttle, absorbing what the engine makes', () => {
    for (const rpm of [3000, 5000, 6500]) {
      sim.setParams({ dynoRpm: rpm });
      sim.run(1.5);
      expect(Math.abs(sim.rpmAvg - rpm)).toBeLessThan(0.005 * rpm);
      let absorbed = 0;
      const n = 24000;
      for (let i = 0; i < n; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); absorbed += sim.dynoTorque / n; }
      // at steady speed the brake takes the brake torque
      expect(absorbed).toBeGreaterThan(0.93 * sim.brakeTorque);
      expect(absorbed).toBeLessThan(1.07 * sim.brakeTorque);
      expect(sim.brakeTorque).toBeGreaterThan(200);
    }
    expect(sim.resets).toBe(0);
  });

  it('follows a sweep, and the torque it reads on the way up matches the held value', () => {
    sim.setParams({ dynoRpm: 5000 });
    sim.run(1.5);
    const held = sim.brakeTorque;
    sim.setParams({ dynoRpm: 4000 });
    sim.run(1.5);
    let swept = 0;
    for (let r = 4000; r <= 6000; r += 25) {
      sim.setParams({ dynoRpm: r });
      sim.run(0.05);
      expect(Math.abs(sim.rpmAvg - r)).toBeLessThan(60);
      if (r === 5000) swept = sim.brakeTorque;
    }
    expect(Math.abs(swept / held - 1)).toBeLessThan(0.06);
  });

  it('only brakes: an engine on a closed throttle below the set speed is left alone, and switching it off hands back', () => {
    sim.setParams({ throttle: 0, dynoRpm: 6000 });
    sim.run(2.5);
    expect(sim.dynoTorque).toBe(0);
    expect(sim.rpmAvg).toBeLessThan(2500);
    sim.setParams({ dynoRpm: 0 });
    sim.run(1.5);
    expect(sim.dynoTorque).toBe(0);
    expect(sim.rpmAvg).toBeGreaterThan(500);
    expect(sim.resets).toBe(0);
  });
});

describe('dyno results', () => {
  const r = run([pt(2000, 200), pt(3000, 250), pt(4000, 240), pt(5000, 220)]);

  it('finds the peaks and reads between points', () => {
    expect(peak(r, 'torque')!.rpm).toBe(3000);
    expect(peak(r, 'power')!.rpm).toBe(5000);
    expect(sampleRun(r, 2500, 'torque')).toBeCloseTo(225, 9);
    expect(sampleRun(r, 5000, 'torque')).toBeCloseTo(220, 9);
    expect(sampleRun(r, 1500, 'torque')).toBeNull();
    expect(sampleRun(r, 5500, 'torque')).toBeNull();
  });

  it('smoothing averages neighbours and leaves the speeds alone', () => {
    const s = smooth(r.points, 1);
    expect(s.map((p) => p.rpm)).toEqual([2000, 3000, 4000, 5000]);
    expect(s[1].torque).toBeCloseTo((200 + 250 + 240) / 3, 9);
    expect(s[0].torque).toBeCloseTo(225, 9);
    expect(smooth(r.points, 0)).toBe(r.points);
  });

  it('exports one line per point with the run name quoted', () => {
    const lines = runsToCsv([r]).split('\n');
    expect(lines.length).toBe(5);
    expect(lines[0].split(',').length).toBe(12);
    expect(lines[1].startsWith('"Test ""A""",2000,200.00,')).toBe(true);
  });

  it('axis maxima divide into clean quarters', () => {
    expect(nice(276)).toBe(320);
    expect(nice(180)).toBe(200);
    expect(nice(95)).toBe(100);
    expect(nice(101)).toBe(120);
  });
});
