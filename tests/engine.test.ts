import { describe, expect, it } from 'vitest';
import { EngineSim } from '../src/sim/engine';
import { PARAM_DEFS, PRESETS, Params, presetParams } from '../src/sim/params';
import { bandPower, record, spectrum } from './util';

const SR = 48000;
const N = 65536;
const BIN = SR / N;

describe('whole-engine behaviour', () => {
  it('every preset starts, settles near its idle target and stays numerically clean', () => {
    for (const preset of PRESETS) {
      const p = presetParams(preset.id);
      const sim = new EngineSim(SR, p);
      sim.run(7);
      let lo = Infinity, hi = 0;
      for (let k = 0; k < 20; k++) { sim.run(0.1); lo = Math.min(lo, sim.rpm); hi = Math.max(hi, sim.rpm); }
      expect(sim.resets, preset.id).toBe(0);
      expect(lo, `${preset.id} idle low`).toBeGreaterThan(0.6 * p.idleRpm);
      expect(hi, `${preset.id} idle high`).toBeLessThan(1.45 * p.idleRpm);
      expect(sim.map, `${preset.id} idle vacuum`).toBeLessThan(70e3);
    }
  });

  it('inline-4: plausible full-load torque, and the limiter holds redline', () => {
    const p = presetParams('i4');
    const sim = new EngineSim(SR, p);
    sim.run(3);
    sim.setParams({ throttle: 100, load: 60 });
    sim.run(5);
    const perLitre = sim.brakeTorque / 2.0;
    expect(perLitre).toBeGreaterThan(70);
    expect(perLitre).toBeLessThan(120);
    expect(sim.ve).toBeGreaterThan(0.8);
    expect(sim.ve).toBeLessThan(1.25);
    expect(sim.map).toBeGreaterThan(95e3);
    sim.setParams({ load: 0 });
    sim.run(4);
    let hi = 0, lo = Infinity;
    for (let k = 0; k < 20; k++) { sim.run(0.05); hi = Math.max(hi, sim.rpm); lo = Math.min(lo, sim.rpm); }
    expect(hi).toBeLessThan(p.revLimit * 1.04);
    expect(lo).toBeGreaterThan(p.revLimit * 0.93);
    expect(sim.resets).toBe(0);
  });

  it('cutting the ignition stops the engine; no spark, no torque', () => {
    const sim = new EngineSim(SR, presetParams('i4'));
    sim.run(4);
    expect(sim.rpm).toBeGreaterThan(500);
    sim.setParams({ ignition: 0 });
    sim.run(4);
    expect(sim.rpm).toBeLessThan(50);
  });

  it('the dominant exhaust line sits at rpm x cylinders / 120', () => {
    for (const id of ['i4', 'flat6']) {
      const sim = new EngineSim(SR, presetParams(id));
      sim.run(3);
      sim.setParams({ throttle: 100, load: 100 });
      sim.run(4);
      const { x, rpm } = record(sim, N, (s) => s.lastEx);
      const mag = spectrum(x);
      const fire = (rpm * sim.n) / 120;
      let best = 1;
      for (let i = Math.round(20 / BIN); i < 1500 / BIN; i++) if (mag[i] > mag[best]) best = i;
      expect(Math.abs((best * BIN) / fire - 1), id).toBeLessThan(0.02);
      // half the firing frequency is not a harmonic of an even-firing engine
      expect(bandPower(mag, fire, BIN) / bandPower(mag, 1.5 * fire, BIN), id).toBeGreaterThan(100);
    }
  });

  it('lengthening the exhaust lowers its resonant peak', () => {
    const peakBand = (L: number) => {
      const sim = new EngineSim(SR, { ...presetParams('thumper'), collector: 3, headerLength: L, throttle: 35, load: 100 });
      sim.run(6);
      const mag = spectrum(record(sim, N, (s) => s.lastEx).x);
      let best = 0, bestF = 0;
      for (let f = 60; f < 600; f += 25) {
        let s = 0;
        for (let i = Math.round(f / BIN); i < (f + 25) / BIN; i++) s += mag[i] * mag[i];
        if (s > best) { best = s; bestF = f + 12.5; }
      }
      return bestF;
    };
    const short = peakBand(500), long = peakBand(1000);
    expect(long).toBeLessThan(short);
    expect(long / short).toBeGreaterThan(0.3);
    expect(long / short).toBeLessThan(0.75);
  });

  it('cross-plane and flat-plane V8s sound different: only the cross-plane has quarter-order content', () => {
    const quarterOrders = (crank: number) => {
      const sim = new EngineSim(SR, { ...presetParams('v8cross'), crank, throttle: 100, load: 100 });
      sim.run(6);
      const { x, rpm } = record(sim, N, (s) => s.lastEx);
      const mag = spectrum(x);
      const fire = (rpm * 8) / 120;
      return (bandPower(mag, 0.25 * fire, BIN, 3) + bandPower(mag, 0.75 * fire, BIN, 3)) / bandPower(mag, fire, BIN, 3);
    };
    const cross = quarterOrders(0), flat = quarterOrders(1);
    expect(cross).toBeGreaterThan(0.1);
    expect(flat).toBeLessThan(1e-3);
  });
});

describe('robustness', () => {
  it('stays finite with every slider at either extreme, at full throttle', () => {
    for (const d of PARAM_DEFS) {
      if (d.kind !== 'slider' || d.group === 'Audio' || d.key === 'throttle') continue;
      for (const v of [d.min, d.max]) {
        const sim = new EngineSim(SR, { ...presetParams('i4'), [d.key]: v });
        sim.run(1.2);
        sim.setParams({ throttle: 100 });
        const out = new Float32Array(SR);
        sim.run(1, out);
        expect(sim.resets, `${d.key}=${v}`).toBe(0);
        expect(Number.isFinite(sim.rpm), `${d.key}=${v}`).toBe(true);
        expect(out.every((y) => Number.isFinite(y) && Math.abs(y) <= 1), `${d.key}=${v}`).toBe(true);
      }
    }
  });

  it('survives everything extreme at once, in both directions', () => {
    for (const pick of ['min', 'max'] as const) {
      const p = presetParams('v8flat');
      for (const d of PARAM_DEFS) if (d.kind === 'slider' && d.group !== 'Audio' && d.group !== 'Running') p[d.key] = d[pick];
      const sim = new EngineSim(SR, p);
      sim.run(1);
      sim.setParams({ throttle: 100 });
      sim.run(2);
      expect(sim.resets, pick).toBe(0);
      expect(Number.isFinite(sim.rpm)).toBe(true);
      expect(Number.isFinite(sim.gas.vp[1])).toBe(true);
    }
  });

  it('live geometry and layout changes keep running without a reset', () => {
    const sim = new EngineSim(SR, presetParams('i4'));
    sim.run(2);
    sim.setParams({ throttle: 60, load: 30 });
    const out = new Float32Array(SR * 3);
    let o = 0;
    for (let k = 0; k < 30; k++) {
      sim.setParams({ headerLength: 300 + 35 * k, tailLength: 2000 - 50 * k, runnerLength: 150 + 15 * k, bore: 80 + 0.5 * k, mufflerVolume: 2 + k, compression: 9 + 0.1 * k });
      const chunk = out.subarray(o, o + 4800);
      sim.run(0.1, chunk);
      o += 4800;
    }
    expect(sim.resets).toBe(0);
    let maxJump = 0;
    for (let i = 1; i < o; i++) maxJump = Math.max(maxJump, Math.abs(out[i] - out[i - 1]));
    expect(maxJump).toBeLessThan(0.5);
    for (const change of [{ collector: 3 }, { layout: 2, cylinders: 8 }, { crank: 1 }, { layout: 3, cylinders: 6, crank: 0 }, { collector: 2 }, { layout: 0, cylinders: 1 }] as Params[]) {
      sim.setParams(change);
      sim.run(1);
      expect(sim.resets).toBe(0);
      expect(Number.isFinite(sim.rpm)).toBe(true);
    }
    expect(sim.n).toBe(1);
  });

  it('slow motion scales simulated time, not the physics', () => {
    const a = new EngineSim(SR, presetParams('i4'));
    a.run(3);
    const t0 = a.simTime, th0 = a.rpm;
    a.setParams({ timeScale: 0.1 });
    a.run(1);
    expect(a.simTime - t0).toBeGreaterThan(0.09);
    expect(a.simTime - t0).toBeLessThan(0.11);
    expect(Math.abs(a.rpm - th0)).toBeLessThan(250);
    expect(a.resets).toBe(0);
  });
});

describe('sample rates', () => {
  it('runs at 44.1 kHz with the same behaviour and no sub-stepping at idle', () => {
    const sim = new EngineSim(44100, presetParams('i4'));
    sim.run(6);
    expect(sim.rpm).toBeGreaterThan(700);
    expect(sim.rpm).toBeLessThan(1200);
    expect(sim.nsub).toBe(1);
    sim.setParams({ throttle: 100, load: 60 });
    sim.run(4);
    expect(sim.brakeTorque / 2).toBeGreaterThan(70);
    expect(sim.resets).toBe(0);
  });
});

describe('sound output', () => {
  it('has no solver-rate tones: content above 5 kHz is far below the engine note', () => {
    const sim = new EngineSim(SR, presetParams('i4'));
    sim.run(3);
    sim.setParams({ throttle: 100, load: 60 });
    sim.run(3);
    const N2 = 32768, bin = SR / N2;
    for (const pick of [(s: EngineSim) => s.lastEx, (s: EngineSim) => s.lastIn]) {
      const mag = spectrum(record(sim, N2, pick).x);
      let low = 0, high = 0, peak = 0;
      for (let i = Math.round(20 / bin); i < 1500 / bin; i++) low += mag[i] * mag[i];
      for (let i = Math.round(5000 / bin); i < 23000 / bin; i++) { high += mag[i] * mag[i]; peak = Math.max(peak, mag[i] * mag[i]); }
      expect(10 * Math.log10(high / low)).toBeLessThan(-35);
      expect(10 * Math.log10(peak / low)).toBeLessThan(-45);
    }
  });
});
