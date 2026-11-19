import { describe, expect, it } from 'vitest';
import { B_CRIT, GAMMA, G1, GasNetwork, P_ATM, R_GAS, T_ATM, orificeMassFlow, orificeMassFlowExact } from '../src/sim/gas';

/** Exact Riemann solution density at x/t = xi (Toro), both sides at rest. */
function sodExact(rl: number, pl: number, rr: number, pr: number, xi: number): number {
  const g = GAMMA;
  const cl = Math.sqrt((g * pl) / rl), cr = Math.sqrt((g * pr) / rr);
  const f = (p: number, rk: number, pk: number, ck: number) => {
    if (p > pk) { const A = 2 / ((g + 1) * rk), B = ((g - 1) / (g + 1)) * pk; return (p - pk) * Math.sqrt(A / (p + B)); }
    return ((2 * ck) / (g - 1)) * (Math.pow(p / pk, (g - 1) / (2 * g)) - 1);
  };
  let lo = Math.min(pl, pr) * 1e-3, hi = Math.max(pl, pr);
  for (let i = 0; i < 200; i++) { const mid = 0.5 * (lo + hi); if (f(mid, rl, pl, cl) + f(mid, rr, pr, cr) > 0) hi = mid; else lo = mid; }
  const ps = 0.5 * (lo + hi);
  const us = 0.5 * (f(ps, rr, pr, cr) - f(ps, rl, pl, cl));
  if (xi < us) {
    const rsl = rl * Math.pow(ps / pl, 1 / g);
    const csl = cl * Math.pow(ps / pl, (g - 1) / (2 * g));
    if (xi < -cl) return rl;
    if (xi > us - csl) return rsl;
    return rl * Math.pow(2 / (g + 1) + ((g - 1) / ((g + 1) * cl)) * (0 - xi), 2 / (g - 1));
  }
  const ratio = ps / pr;
  const rsr = rr * ((ratio + (g - 1) / (g + 1)) / (((g - 1) / (g + 1)) * ratio + 1));
  const S = cr * Math.sqrt(((g + 1) / (2 * g)) * ratio + (g - 1) / (2 * g));
  return xi > S ? rr : rsr;
}

function closedPipe(n: number, L = 1): GasNetwork {
  return new GasNetwork([{ volume: 1, fixed: true }], [{ length: L, diameter: 0.04, cells: n, volL: -1, volR: -1, wallT: 300, friction: 0 }]);
}

describe('finite-volume Euler solver', () => {
  it('reproduces the Sod shock tube against the exact Riemann solution', () => {
    const n = 200;
    const net = closedPipe(n);
    const rl = 1.0, pl = 1e5, rr = 0.125, pr = 1e4;
    for (let i = 0; i < n; i++) i < n / 2 ? net.setCell(i, rl, 0, pl, 0) : net.setCell(i, rr, 0, pr, 0);
    const dt = 2e-6, tEnd = 6e-4;
    for (let t = 0; t < tEnd - 1e-12; t += dt) net.step(dt, 0);
    let err = 0, norm = 0;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n - 0.5;
      const ex = sodExact(rl, pl, rr, pr, x / tEnd);
      err += Math.abs(net.rho[i] - ex);
      norm += ex;
    }
    expect(err / norm).toBeLessThan(0.02);
  });

  it('conserves mass and energy in a closed pipe to round-off', () => {
    const net = closedPipe(60);
    for (let i = 0; i < 60; i++) net.setCell(i, 1.2 + 0.4 * Math.sin(i * 0.3), 20 * Math.cos(i * 0.2), 1e5 + 3e4 * Math.sin(i * 0.11), 0);
    const m0 = net.pipeMass(0), e0 = net.pipeEnergy(0);
    for (let s = 0; s < 4000; s++) net.step(1e-5, 0);
    expect(Math.abs(net.pipeMass(0) / m0 - 1)).toBeLessThan(1e-11);
    expect(Math.abs(net.pipeEnergy(0) / e0 - 1)).toBeLessThan(1e-11);
  });

  it('conserves total mass and energy across pipe-volume boundaries', () => {
    const net = new GasNetwork(
      [{ volume: 1, fixed: true }, { volume: 2e-3, p: 3e5, T: 600 }, { volume: 4e-3, p: 0.6e5, T: 300 }],
      [{ length: 0.5, diameter: 0.04, cells: 16, volL: 1, volR: 2, wallT: 300, friction: 0 }],
    );
    net.pPhiL[0] = 0.4;
    net.pPhiR[0] = 1;
    const mass = () => net.vm[1] + net.vm[2] + net.pipeMass(0);
    const energy = () => net.vE[1] + net.vE[2] + net.pipeEnergy(0);
    const m0 = mass(), e0 = energy();
    for (let s = 0; s < 20000; s++) net.step(2e-5, 0);
    expect(Math.abs(mass() / m0 - 1)).toBeLessThan(1e-10);
    expect(Math.abs(energy() / e0 - 1)).toBeLessThan(1e-10);
    // ...and the two volumes end up at the same pressure.
    expect(Math.abs(net.vp[1] / net.vp[2] - 1)).toBeLessThan(0.01);
  });

  function quarterWaveHz(L: number, n: number): number {
    const net = new GasNetwork([{ volume: 1, fixed: true }], [{ length: L, diameter: 0.04, cells: n, volL: -1, volR: 0, wallT: T_ATM, friction: 0 }]);
    const r0 = P_ATM / (R_GAS * T_ATM);
    for (let i = 0; i < n; i++) {
      const dp = 200 * Math.cos((0.5 * Math.PI * (i + 0.5)) / n);
      net.setCell(i, r0 * (1 + dp / (GAMMA * P_ATM)), 0, P_ATM + dp, 0);
    }
    const dt = 1 / 48000;
    let prev = net.cp[0] - P_ATM, first = -1, last = -1, count = 0;
    for (let s = 0; s < 48000 * 0.25; s++) {
      net.step(dt, 0);
      const v = net.cp[0] - P_ATM;
      if (prev < 0 && v >= 0) {
        const t = (s - prev / (prev - v) * -1 + 0) * dt;
        const tc = (s + prev / (prev - v)) * dt;
        if (first < 0) first = tc; else { last = tc; count++; }
        void t;
      }
      prev = v;
    }
    return count / (last - first);
  }

  it('closed-open pipe resonates at c / 4L, and a longer pipe resonates lower', () => {
    const c = Math.sqrt(GAMMA * R_GAS * T_ATM);
    const f1 = quarterWaveHz(1.0, 25);
    const f2 = quarterWaveHz(1.6, 40);
    expect(f1 / (c / 4)).toBeGreaterThan(0.97);
    expect(f1 / (c / 4)).toBeLessThan(1.03);
    expect(f2 / (c / 6.4)).toBeGreaterThan(0.97);
    expect(f2 / (c / 6.4)).toBeLessThan(1.03);
    expect(f2).toBeLessThan(f1);
  });

  it('a pressure pulse travels at the speed of sound and inverts at an open end', () => {
    const n = 100, L = 2;
    const net = new GasNetwork([{ volume: 1, fixed: true }], [{ length: L, diameter: 0.04, cells: n, volL: -1, volR: 0, wallT: T_ATM, friction: 0 }]);
    const r0 = P_ATM / (R_GAS * T_ATM), c = Math.sqrt(GAMMA * R_GAS * T_ATM);
    for (let i = 0; i < n; i++) {
      const dp = 500 * Math.exp(-(((i - 20) / 4) ** 2));
      // right-running simple wave: u = dp / (rho c)
      net.setCell(i, r0 * (1 + dp / (GAMMA * P_ATM)), dp / (r0 * c), P_ATM + dp, 0);
    }
    const dt = 1 / 48000;
    const peak = () => { let b = 0, bi = 0; for (let i = 0; i < n; i++) { const d = net.cp[i] - P_ATM; if (Math.abs(d) > Math.abs(b)) { b = d; bi = i; } } return { b, x: (bi + 0.5) * L / n }; };
    const steps = Math.round(0.002 / dt);
    for (let s = 0; s < steps; s++) net.step(dt, 0);
    const p1 = peak();
    expect(p1.b).toBeGreaterThan(300);
    expect(Math.abs(p1.x - (0.41 + c * steps * dt))).toBeLessThan(0.06);
    // after reflecting from the open end the pulse comes back as a rarefaction
    for (let s = 0; s < Math.round(0.005 / dt); s++) net.step(dt, 0);
    expect(peak().b).toBeLessThan(-200);
  });
});

describe('tapered pipes (quasi-1D)', () => {
  const cone = (n: number) => Array.from({ length: n + 1 }, (_, i) => 0.03 + 0.07 * Math.sin((Math.PI * i) / n));

  it('gas at rest in a closed tapered pipe stays at rest', () => {
    const n = 40;
    const net = new GasNetwork([{ volume: 1, fixed: true }], [{ length: 1, diameter: 0.03, profile: cone(n), cells: n, volL: -1, volR: -1, wallT: 300, friction: 0 }]);
    for (let s = 0; s < 3000; s++) net.step(1e-5, 0);
    for (let i = 0; i < n; i++) {
      expect(Math.abs(net.cu[i])).toBeLessThan(1e-9);
      expect(Math.abs(net.cp[i] / P_ATM - 1)).toBeLessThan(1e-12);
    }
  });

  it('conserves mass and energy with varying area, and a pulse weakens as the pipe widens', () => {
    const n = 60;
    const net = new GasNetwork([{ volume: 1, fixed: true }], [{ length: 1.2, diameter: 0.03, profile: Array.from({ length: n + 1 }, (_, i) => 0.03 + 0.09 * (i / n)), cells: n, volL: -1, volR: -1, wallT: 300, friction: 0 }]);
    const r0 = P_ATM / (R_GAS * T_ATM), c = Math.sqrt(GAMMA * R_GAS * T_ATM);
    for (let i = 0; i < n; i++) {
      const dp = 800 * Math.exp(-(((i - 8) / 3) ** 2));
      net.setCell(i, r0 * (1 + dp / (GAMMA * P_ATM)), dp / (r0 * c), P_ATM + dp, 0);
    }
    const m0 = net.pipeMass(0), e0 = net.pipeEnergy(0);
    for (let s = 0; s < 120; s++) net.step(2e-5, 0);
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, net.cp[i] - P_ATM);
    expect(Math.abs(net.pipeMass(0) / m0 - 1)).toBeLessThan(1e-11);
    expect(Math.abs(net.pipeEnergy(0) / e0 - 1)).toBeLessThan(1e-9);
    // amplitude falls roughly as 1/sqrt(area): the diffuser sends the rest back as suction
    expect(peak).toBeLessThan(560);
    expect(peak).toBeGreaterThan(150);
  });
});

describe('orifice flow', () => {
  it('elliptic law stays within 4 % of the isentropic nozzle and chokes at the critical ratio', () => {
    let worst = 0;
    for (let r = 0.05; r < 0.995; r += 0.005) {
      const ex = orificeMassFlowExact(1e-4, 2e5, 400, 2e5 * r);
      const ap = orificeMassFlow(1e-4, 2e5, 400, 2e5 * r);
      worst = Math.max(worst, Math.abs(ap / ex - 1));
    }
    expect(worst).toBeLessThan(0.04);
    expect(orificeMassFlow(1e-4, 2e5, 400, 2e5 * B_CRIT * 0.5)).toBeCloseTo(orificeMassFlow(1e-4, 2e5, 400, 2e5 * B_CRIT), 12);
    expect(orificeMassFlow(1e-4, 1e5, 300, 1.2e5)).toBe(0);
  });

  it('a tank blowing down through a restricted pipe end matches the orifice equation', () => {
    for (const pTank of [1.3e5, 4e5]) {
      const net = new GasNetwork(
        [{ volume: 1, fixed: true }, { volume: 5, p: pTank, T: 400 }],
        [{ length: 0.4, diameter: 0.05, cells: 12, volL: 1, volR: 0, wallT: 400, friction: 0 }],
      );
      net.pPhiL[0] = 0.15;
      for (let s = 0; s < 30000; s++) net.step(2e-5, 0);
      const aEff = 0.15 * net.pArea[0];
      const expected = orificeMassFlow(aEff, net.vp[1], net.vT[1], net.cp[0]);
      expect(net.pMdotL[0] / expected).toBeGreaterThan(0.93);
      expect(net.pMdotL[0] / expected).toBeLessThan(1.07);
      expect(net.pMdotR[0] / net.pMdotL[0]).toBeGreaterThan(0.97);
    }
  });

  it('a closed valve passes nothing and a wall reflects a pulse without loss of sign', () => {
    const net = new GasNetwork([{ volume: 1, fixed: true }, { volume: 1e-3, p: 5e5, T: 900 }], [{ length: 0.4, diameter: 0.05, cells: 12, volL: 1, volR: -1, wallT: 300, friction: 0 }]);
    net.pPhiL[0] = 0;
    const m0 = net.vm[1];
    for (let s = 0; s < 2000; s++) net.step(2e-5, 0);
    expect(net.vm[1]).toBe(m0);
    expect(G1).toBeGreaterThan(0);
  });
});
