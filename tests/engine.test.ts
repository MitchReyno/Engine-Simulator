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
      // cycle-averaged speed, so a single's swing between firing strokes does not count as hunting
      for (let k = 0; k < 40; k++) { sim.run(0.1); lo = Math.min(lo, sim.rpmAvg); hi = Math.max(hi, sim.rpmAvg); }
      expect(sim.resets, preset.id).toBe(0);
      // two-strokes idle roughly (misfiring on residuals) and their reed box sits near atmospheric
      const tol = p.strokes ? 0.2 : 0.1;
      expect(lo, `${preset.id} idle low`).toBeGreaterThan((1 - tol) * p.idleRpm);
      expect(hi, `${preset.id} idle high`).toBeLessThan((1 + tol) * p.idleRpm);
      if (!p.strokes) expect(sim.map, `${preset.id} idle vacuum`).toBeLessThan(70e3);
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
    expect(perLitre).toBeLessThan(115);
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

  it('K24: the cam phaser lifts mid-range torque and VTEC lifts the top end', () => {
    const settle = (extra: Params, load: number) => {
      const sim = new EngineSim(SR, { ...presetParams('k24'), ...extra });
      sim.run(3);
      sim.setParams({ throttle: 100, load });
      sim.run(5);
      expect(sim.resets).toBe(0);
      return sim;
    };
    const mid = settle({}, 60), midFixed = settle({ vtc: 0 }, 60);
    expect(mid.rpmAvg).toBeGreaterThan(3200);
    expect(mid.rpmAvg).toBeLessThan(4800);
    expect(mid.vtecOn).toBe(false);
    expect(mid.vtcAdv).toBeGreaterThan(35);
    expect(midFixed.vtcAdv).toBe(0);
    expect(mid.brakeTorque).toBeGreaterThan(midFixed.brakeTorque * 1.08);
    const top = settle({}, 20), topLow = settle({ vtecRpm: 9000 }, 20);
    expect(top.vtecOn).toBe(true);
    expect(topLow.vtecOn).toBe(false);
    expect(top.rpmAvg).toBeGreaterThan(6300);
    expect(top.power).toBeGreaterThan(topLow.power * 1.15);
    // 2.35 L: the real engine makes 222 N·m; the model runs about 10 % rich in torque
    expect(mid.brakeTorque).toBeGreaterThan(200);
    expect(mid.brakeTorque).toBeLessThan(265);
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

describe('throttle transients', () => {
  it('opening the throttle adds no tones at the audio block rate', () => {
    const sim = new EngineSim(SR, presetParams('i4'));
    sim.run(5);
    const n = 16384, x = new Float64Array(n);
    let thr = 0;
    for (let i = 0; i < n; i++) {
      if (i % 128 === 0) sim.beginBlock();
      if (i % 800 === 0) { thr = Math.min(100, thr + 500 / 60); sim.setParams({ throttle: thr }); }
      sim.step();
      x[i] = sim.lastIn;
    }
    const mag = spectrum(x), bin = SR / n;
    // Block rate is 375 Hz. Compare its harmonics with the bands halfway between them.
    let onGrid = 0, offGrid = 0;
    for (const k of [2, 3, 4, 5, 6]) {
      onGrid += bandPower(mag, 375 * k, bin, 3);
      offGrid += 0.5 * (bandPower(mag, 375 * k + 187, bin, 3) + bandPower(mag, 375 * k - 187, bin, 3));
    }
    // stepping the throttle per block gives a ratio in the hundreds
    expect(onGrid / offGrid).toBeLessThan(4);
  });
});

describe('model fidelity options', () => {
  const fxKeys = PARAM_DEFS.filter((d) => d.tiers).map((d) => d.key);

  it('every option runs cleanly in every position, alone and all at the lower setting', () => {
    const cases: Params[] = [Object.fromEntries(fxKeys.map((k) => [k, 0])), Object.fromEntries(fxKeys.map((k) => [k, 1]))];
    for (const k of fxKeys) cases.push({ [k]: presetParams('i4')[k] > 0.5 ? 0 : 1 });
    for (const c of cases) {
      const sim = new EngineSim(SR, { ...presetParams('i4'), ...c });
      sim.run(6);
      const tag = JSON.stringify(c);
      expect(sim.rpmAvg, tag).toBeGreaterThan(780);
      expect(sim.rpmAvg, tag).toBeLessThan(1020);
      sim.setParams({ throttle: 100, load: 60 });
      sim.run(3);
      expect(sim.brakeTorque / 2, tag).toBeGreaterThan(65);
      expect(sim.brakeTorque / 2, tag).toBeLessThan(115);
      sim.setParams({ load: 0 });
      sim.run(2.5);
      expect(sim.rpm, tag).toBeGreaterThan(6400);
      expect(sim.resets, tag).toBe(0);
    }
  });

  it('temperature-dependent gas lowers the temperature rise for the same heat', () => {
    const peakT = (fxGas: number) => {
      // same fuel energy in both: compare by scaling out the different heat factors
      const sim = new EngineSim(SR, { ...presetParams('i4'), fxGas, throttle: 100, load: 100 });
      sim.run(5);
      let pk = 0;
      for (let i = 0; i < 9600; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); pk = Math.max(pk, sim.gas.vT[2]); }
      return pk;
    };
    // 20 % more heat is released (0.9 vs 0.75) yet the peak is under 10 % hotter.
    expect(peakT(1) / peakT(0)).toBeLessThan(1.1);
  });

  it('blow-by loses charge during slow cranking; a perfect seal does not', () => {
    const trapped = (fxBlowby: number) => {
      const sim = new EngineSim(SR, { ...presetParams('thumper'), fxBlowby, ignition: 0, starter: 1 });
      sim.autoStart = false;
      sim.run(2.5);
      // sample the cylinder mass just after intake valve closing vs just before exhaust opening
      let atIvc = 0, atEvo = 0, prev = 0;
      for (let i = 0; i < SR; i++) {
        if (i % 128 === 0) sim.beginBlock();
        sim.step();
        const a = (sim.theta + 720) % 720;
        if (prev < 640 && a >= 640) atIvc = sim.gas.vm[2];
        if (prev < 100 && a >= 100) atEvo = sim.gas.vm[2];
        prev = a;
      }
      return atEvo / atIvc;
    };
    expect(trapped(0)).toBeGreaterThan(0.999);
    expect(trapped(1)).toBeLessThan(0.99);
    expect(trapped(1)).toBeGreaterThan(0.8);
  });

  it('reciprocating inertia changes crank speed ripple but not the mean torque balance', () => {
    const ripple = (fxInertia: number) => {
      const sim = new EngineSim(SR, { ...presetParams('thumper'), fxInertia, throttle: 100, load: 30 });
      sim.run(5);
      let lo = Infinity, hi = 0;
      for (let i = 0; i < 9600; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); lo = Math.min(lo, sim.rpm); hi = Math.max(hi, sim.rpm); }
      return { swing: hi - lo, rpm: sim.rpmAvg };
    };
    const off = ripple(0), on = ripple(1);
    expect(Math.abs(on.swing - off.swing)).toBeGreaterThan(1);
    expect(Math.abs(on.rpm / off.rpm - 1)).toBeLessThan(0.05);
  });

  it('end corrections lengthen pipes, and the wall model heats headers under load', () => {
    const a = new EngineSim(SR, { ...presetParams('i4'), fxEnds: 0 });
    const b = new EngineSim(SR, { ...presetParams('i4'), fxEnds: 1 });
    const tail = (s: EngineSim) => s.topo.pipes.find((q) => q.kind === 'tail')!.length;
    expect(tail(b) - tail(a)).toBeCloseTo((0.61 + 0.85) * 0.025, 6);
    b.run(3);
    const idleWall = b.headerWallT;
    b.setParams({ throttle: 100, load: 40 });
    b.run(8);
    expect(b.headerWallT).toBeGreaterThan(idleWall + 15);
  });

  it('afterfire burns unburned charge in the exhaust when the spark is cut at speed', () => {
    const hottest = (fxAfterfire: number) => {
      const sim = new EngineSim(SR, { ...presetParams('i4'), fxAfterfire, throttle: 100 });
      sim.run(5);
      let t = 0;
      for (let i = 0; i < SR; i++) {
        if (i % 128 === 0) sim.beginBlock();
        sim.step();
        if (i % 16 === 0) for (const k of sim.topo.headerPipe) { const j = sim.gas.pOff[k] + 3; t = Math.max(t, sim.gas.cp[j] / (sim.gas.rho[j] * 287)); }
      }
      expect(sim.resets).toBe(0);
      return t;
    };
    expect(hottest(1)).toBeGreaterThan(hottest(0) + 100);
  });
});

describe('valve options', () => {
  const wot = (extra: Params) => {
    const sim = new EngineSim(SR, { ...presetParams('i4'), ...extra });
    sim.run(3);
    sim.setParams({ throttle: 100, load: 25 });
    sim.run(5);
    expect(sim.resets).toBe(0);
    return { ve: sim.ve, power: sim.power };
  };
  it('a two-valve head breathes worse at high rpm than four valves, and five valves run cleanly', () => {
    const two = wot({ valvesPerCyl: 0, intakeValveSize: 44, exhaustValveSize: 38 });
    const four = wot({ valvesPerCyl: 1 });
    const five = wot({ valvesPerCyl: 2, intakeValveSize: 30, exhaustValveSize: 31 });
    expect(two.power).toBeLessThan(four.power);
    expect(five.power).toBeGreaterThan(0.85 * four.power);
  });
  it('a fat lobe passes more air than a pointed one at the same lift and duration', () => {
    expect(wot({ camProfile: 2 }).power).toBeGreaterThan(wot({ camProfile: 0 }).power);
  });
});

describe('two-stroke', () => {
  it('fires every revolution: lines at multiples of rpm / 60 and nothing at the four-stroke half order', () => {
    const sim = new EngineSim(SR, presetParams('2t350'));
    sim.run(4);
    sim.setParams({ throttle: 100, load: 40 });
    sim.run(4);
    const { x, rpm } = record(sim, N, (s) => s.lastEx);
    const mag = spectrum(x);
    // Each cylinder has its own pipe and outlet, so the per-cylinder rate rpm / 60 is the base line.
    const rev = rpm / 60;
    let best = 1;
    for (let i = Math.round(20 / BIN); i < 1500 / BIN; i++) if (mag[i] > mag[best]) best = i;
    const ratio = (best * BIN) / rev;
    expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(0.03);
    expect(bandPower(mag, rev, BIN) / bandPower(mag, 0.5 * rev, BIN)).toBeGreaterThan(100);
    expect(bandPower(mag, 2 * rev, BIN) / bandPower(mag, 1.5 * rev, BIN)).toBeGreaterThan(100);
    expect(sim.resets).toBe(0);
  });

  it('the expansion chamber makes a power band: more torque on the pipe than below it', () => {
    const sim = new EngineSim(SR, presetParams('2t250'));
    sim.run(4);
    sim.setParams({ throttle: 100, load: 20 });
    sim.run(5);
    const mid = { rpm: sim.rpmAvg, torque: sim.brakeTorque };
    sim.setParams({ load: 10 });
    sim.run(6);
    const top = { rpm: sim.rpmAvg, torque: sim.brakeTorque };
    expect(mid.rpm).toBeGreaterThan(4000);
    expect(mid.rpm).toBeLessThan(6800);
    expect(top.rpm).toBeGreaterThan(7500);
    expect(top.torque).toBeGreaterThan(1.2 * mid.torque);
    expect(sim.resets).toBe(0);
  });

  it('the crankcase pumps: pressure swings above and below atmospheric each revolution', () => {
    const sim = new EngineSim(SR, { ...presetParams('2t250'), throttle: 100, load: 30 });
    sim.run(5);
    const cc = sim.topo.crankcase[0];
    let lo = Infinity, hi = 0;
    for (let i = 0; i < 4800; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); lo = Math.min(lo, sim.gas.vp[cc]); hi = Math.max(hi, sim.gas.vp[cc]); }
    expect(hi).toBeGreaterThan(1.15e5);
    expect(lo).toBeLessThan(0.97e5);
  });

  it('every induction type, the power valve and the open stinger run cleanly', () => {
    for (const extra of [{ induction: 1 }, { induction: 2 }, { powerValve: 1 }, { chamberSilencer: 0 }, { reedStiffness: 80 }, { reedStiffness: 320 }] as Params[]) {
      const sim = new EngineSim(SR, { ...presetParams('2t250'), ...extra });
      sim.run(4);
      sim.setParams({ throttle: 100, load: 25 });
      sim.run(4);
      const tag = JSON.stringify(extra);
      expect(sim.rpmAvg, tag).toBeGreaterThan(3000);
      expect(sim.brakeTorque, tag).toBeGreaterThan(5);
      expect(sim.resets, tag).toBe(0);
    }
  });

  it('stays finite with the two-stroke sliders at either extreme, and when switching cycle live', () => {
    for (const key of ['exhaustPortOpen', 'transferPortOpen', 'crankcaseCR', 'exhaustPortWidth', 'transferPortWidth', 'chamberDiameter', 'headerLength', 'headerDiameter', 'midLength', 'bore', 'stroke', 'compression', 'runnerDiameter', 'throttleBody']) {
      const d = PARAM_DEFS.find((q) => q.key === key)!;
      for (const v of [d.min, d.max]) {
        const sim = new EngineSim(SR, { ...presetParams('2t250'), [key]: v });
        sim.run(1.5);
        sim.setParams({ throttle: 100 });
        sim.run(1.5);
        expect(sim.resets, `${key}=${v}`).toBe(0);
        expect(Number.isFinite(sim.rpm), `${key}=${v}`).toBe(true);
      }
    }
    const sim = new EngineSim(SR, presetParams('i4'));
    sim.run(2);
    for (const strokes of [1, 0, 1]) {
      sim.setParams({ strokes });
      sim.autoStart = true;
      sim.run(2);
      expect(sim.two).toBe(strokes === 1);
      expect(sim.resets).toBe(0);
    }
  });
});
