import { describe, expect, it } from 'vitest';
import { camLift, clearanceVolume, cylinderVolume, displacement, dVolumeDTheta, valveEvents, wristPinHeight } from '../src/sim/kinematics';
import { LAYOUTS, resolveLayout } from '../src/sim/layouts';

const g = { bore: 0.086, stroke: 0.086, rod: 0.143, compression: 10.5 };

describe('crank-slider kinematics', () => {
  it('piston is at r + l at TDC and l - r at BDC', () => {
    expect(wristPinHeight(0, 0.043, 0.143)).toBeCloseTo(0.186, 12);
    expect(wristPinHeight(Math.PI, 0.043, 0.143)).toBeCloseTo(0.1, 12);
  });
  it('volume spans clearance to clearance + displacement, giving the compression ratio', () => {
    const vc = clearanceVolume(g);
    expect(cylinderVolume(0, g)).toBeCloseTo(vc, 12);
    expect(cylinderVolume(Math.PI, g)).toBeCloseTo(vc + displacement(g), 12);
    expect(cylinderVolume(Math.PI, g) / cylinderVolume(0, g)).toBeCloseTo(10.5, 9);
    expect(displacement(g) * 1e6).toBeCloseTo(499.6, 0);
  });
  it('analytic dV/dtheta matches a finite difference', () => {
    for (const t of [0.1, 0.9, 1.7, 2.8, 4.0, 5.5]) {
      const h = 1e-6;
      const fd = (cylinderVolume(t + h, g) - cylinderVolume(t - h, g)) / (2 * h);
      expect(dVolumeDTheta(t, g)).toBeCloseTo(fd, 9);
    }
  });
  it('piston is past mid-stroke at 90 degrees (finite rod length)', () => {
    const half = clearanceVolume(g) + displacement(g) / 2;
    expect(cylinderVolume(Math.PI / 2, g)).toBeGreaterThan(half);
  });
});

describe('cam profile', () => {
  it('peaks at the centre, is zero outside the duration and wraps the cycle', () => {
    expect(camLift(468, 468, 250, 9.5)).toBeCloseTo(9.5, 12);
    expect(camLift(468 + 125, 468, 250, 9.5)).toBe(0);
    expect(camLift(468 - 126, 468, 250, 9.5)).toBe(0);
    expect(camLift(10, 700, 100, 8)).toBeCloseTo(camLift(730, 700, 100, 8), 12);
    expect(camLift(10, 700, 100, 8)).toBeGreaterThan(0);
  });
  it('valve events follow lobe separation and advance', () => {
    const e = valveEvents(250, 250, 110, 0);
    expect(e.ivo).toBeCloseTo(345);
    expect(e.evc).toBeCloseTo(375);
    expect(e.overlap).toBeCloseTo(30);
    expect(valveEvents(250, 250, 110, 4).intakeCentre).toBeCloseTo(466);
  });
});

describe('layouts and firing orders', () => {
  const r = (kind: any, n: number, crank = 0, order = 0, bank = 90) => resolveLayout(kind, n, bank, crank, order);

  it('every listed firing order is valid for its crank and intervals sum to 720', () => {
    for (const def of LAYOUTS) {
      def.cranks.forEach((crank, ci) => {
        const res = resolveLayout(def.kind, def.cylinders, def.defaultBankAngle, ci, 0);
        expect(res.orderLabels.length, `${def.kind}${def.cylinders} ${crank.name}`).toBe(Math.max(1, crank.orders.length));
        for (let oi = 0; oi < res.orderLabels.length; oi++) {
          const x = resolveLayout(def.kind, def.cylinders, def.defaultBankAngle, ci, oi);
          expect(x.intervals.reduce((a, b) => a + b, 0)).toBeCloseTo(720, 9);
          x.fire.forEach((f, i) => {
            const tdc = x.pins[i] - x.beta[i];
            expect((((f - tdc) % 360) + 360) % 360 < 1e-6 || (((f - tdc) % 360) + 360) % 360 > 360 - 1e-6).toBe(true);
          });
        }
      });
    }
  });
  it('inline-4 fires every 180 degrees in 1-3-4-2', () => {
    const x = r('inline', 4);
    expect(x.orderLabels[0]).toBe('1-3-4-2');
    x.intervals.forEach((d) => expect(d).toBeCloseTo(180));
  });
  it('even-firing engines: I3 240, I5 144, I6 120, V6 120, V8 90, V12 60, F4 180, F6 120', () => {
    const cases: [any, number, number, number][] = [
      ['inline', 3, 60, 240], ['inline', 5, 60, 144], ['inline', 6, 60, 120], ['v', 6, 60, 120],
      ['v', 8, 90, 90], ['v', 12, 60, 60], ['flat', 4, 180, 180], ['flat', 6, 180, 120],
    ];
    for (const [k, n, bank, iv] of cases) r(k, n, 0, 0, bank).intervals.forEach((d) => expect(d, `${k}${n}`).toBeCloseTo(iv));
  });
  it('cross-plane V8 is even overall but uneven per bank; flat-plane alternates banks', () => {
    const cross = r('v', 8, 0);
    expect(cross.orderLabels[0]).toBe('1-8-4-3-6-5-7-2');
    cross.intervals.forEach((d) => expect(d).toBeCloseTo(90));
    const bankSeq = (x: typeof cross) => x.order.map((c) => x.def.bank[c]);
    const cs = bankSeq(cross);
    expect(cs.some((b, i) => b === cs[(i + 1) % 8])).toBe(true);
    const flat = r('v', 8, 1);
    flat.intervals.forEach((d) => expect(d).toBeCloseTo(90));
    const fs = bankSeq(flat);
    expect(fs.every((b, i) => b !== fs[(i + 1) % 8])).toBe(true);
  });
  it('45-degree V-twin fires at 315 / 405, cross-plane I4 at 270-180-90-180', () => {
    expect(r('v', 2, 0, 0, 45).intervals.map(Math.round)).toEqual([315, 405]);
    expect(r('inline', 4, 1).intervals.map(Math.round)).toEqual([270, 180, 90, 180]);
  });
  it('shared-pin 90-degree V6 cannot fire evenly', () => {
    const iv = r('v', 6, 1, 0, 90).intervals.map(Math.round);
    expect(iv.reduce((a, b) => a + b, 0)).toBe(720);
    expect(Math.max(...iv) - Math.min(...iv)).toBeGreaterThanOrEqual(60);
  });
});
