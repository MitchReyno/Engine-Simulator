import { describe, expect, it } from 'vitest';
import { EngineSim } from '../src/sim/engine';
import { LAYOUT_KINDS, resolveLayout } from '../src/sim/layouts';
import { PARAM_BY_KEY, Params, presetParams } from '../src/sim/params';
import { buildTopology } from '../src/sim/topology';
import { BLADES, Boost } from '../src/sim/boost';
import { aimMic, spectrum } from './util';

const SR = 48000;
const topo = (extra: Params, id = 'k24') => {
  const p = { ...presetParams(id), ...extra };
  return buildTopology(p, resolveLayout(LAYOUT_KINDS[p.layout | 0], p.cylinders | 0, p.bankAngle, p.crank | 0, p.firingOrder | 0, false), 1 / SR);
};

/** Full throttle, held at a speed by the dyno; returns what the engine settles to. */
function hold(extra: Params, rpm: number, id = 'k24') {
  const sim = new EngineSim(SR, { ...presetParams(id), ...extra });
  aimMic(sim, 'engine', 2);
  sim.run(2.5);
  sim.setParams({ throttle: 100 });
  let load = 40;
  for (let k = 0; k < 45; k++) { load = Math.min(100, Math.max(0.5, load * (1 + 1.5 * (sim.rpmAvg - rpm) / rpm))); sim.setParams({ load }); sim.run(0.1); }
  let ex = 0, inn = 0;
  const n = 24000;
  for (let i = 0; i < n; i++) { if (i % 128 === 0) sim.beginBlock(); const y = sim.step(); expect(Number.isFinite(y)).toBe(true); ex += sim.lastEx ** 2 / n; inn += sim.lastIn ** 2 / n; }
  expect(sim.resets).toBe(0);
  return { sim, torque: sim.brakeTorque, exDb: 10 * Math.log10(ex), inDb: 10 * Math.log10(inn), boost: sim.boost.boostPa / 1e3, turboRpm: sim.boost.omega * 9.549 };
}

describe('intake network', () => {
  it('by default it is one pipe from the air to the plenum, as before', () => {
    const t = topo({});
    expect(t.pipes[0]).toMatchObject({ kind: 'intake', volL: 0, volR: 1 });
    expect(t.intakePipes).toEqual([0]);
    expect(t.throttlePipes).toEqual([0]);
    expect(t.boost.compIn).toBe(-1);
    expect(t.volumes.some((v) => v.kind === 'airbox')).toBe(false);
  });

  it('an airbox puts a snorkel and a box ahead of the intake pipe; the snorkel is then the mouth', () => {
    const t = topo({ airbox: 1, airboxVolume: 8 });
    const box = t.volumes.findIndex((v) => v.kind === 'airbox');
    expect(t.volumes[box].volume).toBeCloseTo(8e-3, 6);
    expect(t.pipes[0].volL).toBe(box);
    const mouth = t.pipes[t.intakePipes[0]];
    expect(mouth).toMatchObject({ kind: 'snorkel', volL: 0, volR: box });
    expect(t.filterPipes).toEqual([0]);
  });

  it('forced induction splits the intake at the compressor and moves the throttle to the charge pipe', () => {
    const t = topo({ boost: 1 });
    expect(t.pipes[0].volR).toBe(t.boost.compIn);
    const thr = t.pipes[t.throttlePipes[0]];
    expect(thr).toMatchObject({ kind: 'charge', volL: t.boost.charge, volR: 1 });
    // the turbine sits between the collector and the main pipe
    expect(t.volumes[t.boost.turbOut].kind).toBe('turbine');
    expect(t.pipes.some((q) => q.kind === 'mid' && q.volL === t.boost.turbOut)).toBe(true);
    expect(t.pipes.some((q) => q.kind === 'mid' && q.volL === t.boost.turbIn)).toBe(false);
    expect(t.pipes.filter((q) => q.kind === 'header').every((q) => q.volR === t.boost.turbIn || t.pipes.some((m) => m.volL === q.volR && m.volR === t.boost.turbIn))).toBe(true);
    // a supercharger has no turbine
    expect(topo({ boost: 2 }).boost.turbIn).toBe(-1);
    // separate banks and open headers are brought into one collector for a turbo
    for (const collector of [2, 3]) expect(topo({ boost: 1, collector }, 'v8cross').boost.turbIn).toBeGreaterThan(0);
  });

  it('tapered runners are wider at the plenum; a muffler delete leaves a joint the size of the pipe', () => {
    const t = topo({ runnerTaper: 30 });
    const r = t.pipes[t.runnerPipe[0]];
    expect(r.profile![0]).toBeCloseTo(1.3 * r.diameter, 6);
    expect(r.profile![r.profile!.length - 1]).toBeCloseTo(r.diameter, 6);
    const vol = (extra: Params) => { const x = topo(extra); return x.volumes.filter((v) => v.kind === 'muffler').reduce((s, v) => s + v.volume, 0); };
    expect(vol({ mufflerType: 3 })).toBeLessThan(0.2 * vol({}));
  });
});

describe('intake parts on the running engine', () => {
  const base = hold({}, 6500);

  it('a clogged filter and sharp-edged runner entries each cost top-end torque', () => {
    expect(hold({ airFilter: 4 }, 6500).torque).toBeLessThan(0.98 * base.torque);
    // taking the filter out changes the pipe's ringing as well as its resistance, so it is not always a gain
    expect(Math.abs(hold({ airFilter: 0 }, 6500).torque / base.torque - 1)).toBeLessThan(0.05);
    expect(hold({ bellmouth: 0 }, 6500).torque).toBeLessThan(0.98 * base.torque);
  });

  it('an airbox takes most of the intake roar away without strangling the engine', () => {
    const box = hold({ airbox: 1 }, 6500);
    expect(box.inDb).toBeLessThan(base.inDb - 8);
    expect(box.torque).toBeGreaterThan(0.9 * base.torque);
  });

  it('a muffler delete is much louder at the tailpipe', () => {
    expect(hold({ mufflerType: 3 }, 6500).exDb).toBeGreaterThan(base.exDb + 5);
  });

  it('an intake pipe wider than the throttle body, and tapered runners, run cleanly', () => {
    expect(hold({ intakePipeRatio: 150 }, 6500).torque).toBeGreaterThan(0.95 * base.torque);
    expect(hold({ runnerTaper: 30 }, 6500).torque).toBeGreaterThan(0.8 * base.torque);
  });
});

describe('forced induction', () => {
  it('a turbo holds its boost target with the wastegate and makes the torque that much more air should', () => {
    const na = hold({}, 4500), t = hold({ boost: 1, boostTarget: 70 }, 4500);
    expect(Math.abs(t.boost - 70)).toBeLessThan(12);
    expect(t.sim.boost.wastegate).toBeGreaterThan(0.02);
    expect(t.turboRpm).toBeGreaterThan(70e3);
    expect(t.turboRpm).toBeLessThan(170e3);
    // 1.7 times the absolute pressure, less the heat the intercooler leaves in
    expect(t.torque / na.torque).toBeGreaterThan(1.4);
    expect(t.torque / na.torque).toBeLessThan(1.85);
    // the turbine in the way quietens the exhaust
    expect(t.exDb).toBeLessThan(na.exDb + 1);
    // more boost, more torque; no intercooler, less
    expect(hold({ boost: 1, boostTarget: 110 }, 4500).torque).toBeGreaterThan(1.1 * t.torque);
    expect(hold({ boost: 1, boostTarget: 70, intercooler: 0 }, 4500).torque).toBeLessThan(0.97 * t.torque);
  });

  it('boost arrives after a lag, and a bigger wheel takes longer', () => {
    const spool = (turboSize: number) => {
      const sim = new EngineSim(SR, { ...presetParams('k24'), boost: 1, boostTarget: 70, turboSize, load: 55 });
      sim.run(3);
      expect(sim.boost.boostPa).toBeLessThan(8e3);
      sim.setParams({ throttle: 100 });
      let t = 0;
      while (t < 6 && sim.boost.boostPa < 50e3) { sim.run(0.05); t += 0.05; }
      expect(sim.resets).toBe(0);
      return t;
    };
    const small = spool(50), big = spool(72);
    expect(small).toBeGreaterThan(0.15);
    expect(small).toBeLessThan(4);
    expect(big).toBeGreaterThan(1.3 * small);
  });

  it('surge flutter is a train of backflow bursts, slower with a bigger charge volume, that dies away as the wheel slows', () => {
    const flutter = (chargeVolume: number) => {
      const { sim } = hold({ boost: 1, boostTarget: 90, bov: 0, chargeVolume }, 4500);
      sim.setParams({ throttle: 0 });
      const starts: number[] = [];
      let inBurst = false, early = 0, late = 0;
      for (let i = 0; i < 1.5 * SR; i++) {
        if (i % 128 === 0) sim.beginBlock();
        sim.step();
        const m = sim.boost.mdot;
        if (m < -0.01 && !inBurst) { inBurst = true; starts.push(i / SR); } else if (m > 0) inBurst = false;
        if (i < 0.4 * SR) early = Math.min(early, m); else if (i > 1.1 * SR) late = Math.min(late, m);
      }
      expect(sim.resets).toBe(0);
      return { n: starts.length, gap: starts.length > 4 ? (starts[4] - starts[0]) / 4 : 0, early, late };
    };
    const small = flutter(4), big = flutter(9);
    expect(small.n).toBeGreaterThan(5);
    // tens of bursts a second
    expect(1 / small.gap).toBeGreaterThan(15);
    expect(1 / small.gap).toBeLessThan(60);
    expect(big.gap).toBeGreaterThan(1.2 * small.gap);
    expect(small.late).toBeGreaterThan(0.6 * small.early);
  });

  it('shutting the throttle on boost: a blow-off valve vents it; without one the charge blows back through the compressor', () => {
    const lift = (bov: number) => {
      const { sim } = hold({ boost: 1, boostTarget: 90, bov }, 4500);
      sim.setParams({ throttle: 0 });
      let vented = 0, back = 0, bursts = 0, inBurst = false;
      for (let i = 0; i < SR; i++) {
        if (i % 128 === 0) sim.beginBlock();
        sim.step();
        vented += sim.boost.mdotBov / SR;
        const m = sim.boost.mdot;
        if (m < back) back = m;
        if (m < -0.01 && !inBurst) { inBurst = true; bursts++; } else if (m > 0) inBurst = false;
      }
      expect(sim.resets).toBe(0);
      return { vented, back, bursts };
    };
    const open = lift(1), none = lift(0), stiff = lift(3);
    // a small stiff valve lets some out but cannot stop the surge
    expect(stiff.vented).toBeGreaterThan(1e-4);
    expect(stiff.vented).toBeLessThan(open.vented);
    expect(stiff.back).toBeLessThan(-0.005);
    expect(open.vented).toBeGreaterThan(1e-3);
    expect(none.vented).toBe(0);
    expect(none.back).toBeLessThan(-0.005);
    // the valve may let one pulse past before it has lifted; without it the pulses keep coming
    expect(open.bursts).toBeLessThanOrEqual(2);
    expect(none.bursts).toBeGreaterThan(8);
    expect(stiff.bursts).toBeGreaterThan(8);
  });

  it('a supercharger makes boost in step with engine speed and costs crank power to drive', () => {
    const lo = hold({ boost: 2, boostTarget: 60 }, 3500), hi = hold({ boost: 2, boostTarget: 60 }, 6500);
    expect(hi.boost).toBeGreaterThan(lo.boost + 10);
    expect(hi.boost).toBeGreaterThan(20);
    expect(hi.boost).toBeLessThan(75);
    expect(hi.sim.boost.crankPower).toBeGreaterThan(3000);
    expect(hi.turboRpm / lo.turboRpm).toBeCloseTo(hi.sim.rpmAvg / lo.sim.rpmAvg, 1);
  });
});

describe('robustness of the intake options', () => {
  it('stays finite with each airbox and boost slider at either extreme, at full throttle', () => {
    for (const key of ['airboxVolume', 'snorkelLength', 'snorkelDiameter', 'boostTarget', 'turboSize', 'intercooler', 'chargeVolume']) {
      const d = PARAM_BY_KEY[key];
      for (const v of [d.min, d.max]) {
        const sim = new EngineSim(SR, { ...presetParams('i4'), airbox: 1, boost: 1, [key]: v });
        sim.run(1.2);
        sim.setParams({ throttle: 100 });
        const out = new Float32Array(SR);
        sim.run(1, out);
        expect(sim.resets, `${key}=${v}`).toBe(0);
        expect(Number.isFinite(sim.rpm), `${key}=${v}`).toBe(true);
        expect(out.every((y) => Number.isFinite(y) && Math.abs(y) <= 1), `${key}=${v}`).toBe(true);
      }
    }
  });

  it('an idling turbo engine does not whistle: the compressor is not surging against the intake pipe', () => {
    const band = (boost: number) => {
      const sim = new EngineSim(SR, { ...presetParams('k24'), boost, fxWhine: 0 });
      sim.run(5);
      const n = 32768, x = new Float64Array(n);
      let lo = 1, hi = -1;
      for (let i = 0; i < n; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); x[i] = sim.lastIn; lo = Math.min(lo, sim.boost.mdot); hi = Math.max(hi, sim.boost.mdot); }
      const mag = spectrum(x), bin = SR / n;
      let e = 0;
      for (let i = Math.round(800 / bin); i < 3000 / bin; i++) e += mag[i] * mag[i];
      return { db: 10 * Math.log10(e + 1e-30), lo, hi };
    };
    const turbo = band(1);
    // the air goes one way through the wheel, and nothing rings between 800 Hz and 3 kHz
    expect(turbo.lo).toBeGreaterThan(0);
    expect(turbo.db).toBeLessThan(0);
  });
});

describe('turbo sounds', () => {
  const SRT = 48000;
  /** Level of the intake sound in a narrow band round a frequency, relative to everything else, at steady boost. */
  const whistle = (extra: Params) => {
    const { sim } = hold({ boost: 1, boostTarget: 70, fxGround: 0, ...extra }, 4500);
    const n = 32768, x = new Float64Array(n);
    let bpf = 0;
    for (let i = 0; i < n; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); x[i] = sim.lastIn; bpf += (BLADES * sim.boost.omega) / (2 * Math.PI) / n; }
    const mag = spectrum(x), bin = SRT / n;
    const c = Math.round(bpf / bin);
    let tone = 0, floor = 0, k = 0;
    // shaft speed wanders a little, so take the energy in a band round the tone, not one bin
    for (let i = c - 90; i <= c + 90; i++) { if (Math.abs(i - c) <= 20) tone += mag[i] * mag[i]; else { floor += mag[i] * mag[i]; k++; } }
    tone = Math.sqrt(tone);
    return { bpf, tone, prominence: tone / Math.sqrt((floor / k) * 41) };
  };

  it('the whistle sits at blades x shaft speed, and each fidelity choice and the volume slider do what they say', () => {
    const full = whistle({ fxWhine: 2 }), off = whistle({ fxWhine: 0 }), faked = whistle({ fxWhine: 1 });
    expect(full.bpf).toBeGreaterThan(5000);
    expect(full.bpf).toBeLessThan(20000);
    expect(full.prominence).toBeGreaterThan(8);
    expect(faked.prominence).toBeGreaterThan(8);
    expect(off.prominence).toBeLessThan(2);
    expect(whistle({ fxWhine: 2, mixWhine: 0 }).prominence).toBeLessThan(2);
    expect(whistle({ fxWhine: 2, mixWhine: 50 }).tone / full.tone).toBeCloseTo(0.5, 1);
    // the duct model: a filter element takes some of it; with none it is louder
    expect(whistle({ fxWhine: 2, airFilter: 0 }).tone).toBeGreaterThan(1.5 * full.tone);
  });

  it('the blade-passing wave follows the load on the blades', () => {
    const b = new Boost();
    b.configure({ kind: 1, wheel: 0.056, target: 70e3, intercooler: 0.7, bov: 1, crankMax: 700 });
    const lo = hold({ boost: 1, boostTarget: 40 }, 4500).sim.boost.toneP, hi = hold({ boost: 1, boostTarget: 110 }, 4500).sim.boost.toneP;
    expect(lo).toBeGreaterThan(5);
    expect(hi).toBeGreaterThan(1.5 * lo);
    expect(b.toneP).toBe(0);
  });

  it('a sprung blow-off valve stays shut on boost, lifts when the throttle shuts and closes again by itself', () => {
    const { sim } = hold({ boost: 1, boostTarget: 90, bov: 1, fxBov: 1 }, 4500);
    expect(sim.boost.bovOpen).toBe(0);
    sim.setParams({ throttle: 0 });
    let peakLift = 0, vented = 0, jet = 0;
    for (let i = 0; i < SRT; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); peakLift = Math.max(peakLift, sim.boost.bovOpen); vented += sim.boost.mdotBov / SRT; jet = Math.max(jet, sim.boost.jetU); }
    expect(peakLift).toBeGreaterThan(0.3);
    expect(vented).toBeGreaterThan(1e-3);
    // the jet leaves at up to the speed of sound, never more
    expect(jet).toBeGreaterThan(150);
    expect(jet).toBeLessThan(345);
    // once the wheel has slowed there is nothing left to vent
    sim.run(3);
    expect(sim.boost.mdotBov).toBeLessThan(0.002);
    expect(sim.resets).toBe(0);
  });

  it('the blow-off volume slider silences the vent without changing what the valve does', () => {
    const burst = (mixBov: number) => {
      const { sim } = hold({ boost: 1, boostTarget: 90, bov: 1, mixBov, fxWhine: 0 }, 4500);
      sim.setParams({ throttle: 0 });
      // the hiss is treble: weigh the sound by its rate of change so the intake's own rumble does not swamp it
      let e = 0, vented = 0, prev = 0;
      for (let i = 0; i < SRT / 4; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); e += (sim.lastIn - prev) ** 2; prev = sim.lastIn; vented += sim.boost.mdotBov / SRT; }
      return { e, vented };
    };
    const loud = burst(100), quiet = burst(0);
    expect(quiet.vented).toBeCloseTo(loud.vented, 4);
    expect(quiet.e).toBeLessThan(0.7 * loud.e);
  });

  it('shaft imbalance whistles through the block at shaft speed, in proportion to how far out it is', () => {
    const tone = (mechTurbo: number) => {
      const { sim } = hold({ boost: 1, boostTarget: 70, mechTurbo }, 4500);
      const n = 32768, x = new Float64Array(n);
      let hz = 0;
      for (let i = 0; i < n; i++) { if (i % 128 === 0) sim.beginBlock(); sim.step(); x[i] = sim.lastMech; hz += sim.boost.omega / (2 * Math.PI) / n; }
      const mag = spectrum(x), c = Math.round(hz / (SRT / n));
      let pk = 0;
      for (let i = c - 12; i <= c + 12; i++) pk = Math.max(pk, mag[i]);
      return { pk, hz };
    };
    const worn = tone(30), none = tone(0);
    expect(worn.hz).toBeGreaterThan(1000);
    expect(worn.hz).toBeLessThan(3500);
    expect(worn.pk).toBeGreaterThan(5 * none.pk);
  });
});

describe('pipe resolution', () => {
  const cells = (cellBudget: number, id = 'k24') => { const t = topo({ cellBudget }, id); return { n: t.totalCells, single: t.singleStepCells }; };

  it('up to 600 the budget is a ceiling: met without undershooting, and never past what one step per sample can carry', () => {
    const { single } = cells(140);
    expect(single).toBeGreaterThan(180);
    expect(cells(140).n).toBe(140);
    for (const b of [100, 160, 190]) {
      expect(cells(b).n).toBeLessThanOrEqual(b);
      expect(cells(b).n).toBeGreaterThan(0.9 * b);
    }
    for (const b of [single, 300, 600]) expect(cells(b).n).toBe(single);
  });

  it('a short system at the default budget is not refined behind your back', () => {
    for (const id of ['thumper', 'vtwin', '2t250', '2t350']) {
      const c = cells(140, id);
      expect(c.n, id).toBeLessThanOrEqual(c.single);
    }
  });

  it('above 600 the slider asks for finer cells: up to about twice as many at 1200', () => {
    const { single } = cells(140);
    expect(cells(700).n).toBeGreaterThan(single);
    expect(cells(900).n).toBeGreaterThan(cells(700).n);
    expect(cells(1200).n).toBeLessThan(2.2 * single);
    expect(cells(1200).n).toBeGreaterThan(1.8 * single);
  });
});

describe('at rest', () => {
  it('a stopped engine is silent: no pipe keeps ringing', () => {
    for (const id of ['thumper', 'vtwin', '2t250', '2t350', 'k24']) {
      const sim = new EngineSim(SR, presetParams(id));
      sim.run(3);
      sim.setParams({ ignition: 0 });
      sim.run(8);
      let e = 0;
      const n = 16384;
      for (let i = 0; i < n; i++) { if (i % 128 === 0) sim.beginBlock(); const y = sim.step(); e += (y * y) / n; }
      expect(sim.rpm, id).toBeLessThan(1);
      // full scale is 1; this is under -70 dB
      expect(Math.sqrt(e), id).toBeLessThan(3e-4);
    }
  });
});
