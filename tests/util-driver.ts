// A simple robot driver for tests: pure-pursuit steering and a curvature-based speed target.
import { EngineSim } from '../src/sim/engine';

export function driveFor(sim: EngineSim, seconds: number, pace = 0.8): { maxOff: number; maxSpeed: number } {
  const car = sim.car, t = car.track;
  let maxOff = 0, maxSpeed = 0;
  const steps = Math.round(seconds / 0.01);
  for (let k = 0; k < steps; k++) {
    const v = car.speed;
    const i0 = car.pos.index;
    const ahead = Math.round((7 + 0.35 * v) / t.ds);
    const j = (i0 + ahead) % t.n;
    const dx = t.x[j] - car.x, dy = t.y[j] - car.y;
    const alpha = Math.atan2(dy, dx) - car.psi;
    const steer = Math.atan2(2 * 2.67 * Math.sin(alpha), Math.hypot(dx, dy)) / 0.58;
    // Slowest corner within braking distance sets the target speed.
    const look = Math.round((10 + (v * v) / (2 * 7)) / t.ds);
    let target = 90;
    for (let q = 0; q <= look; q++) {
      const c = Math.abs(t.curv[(i0 + q) % t.n]);
      const vc = Math.sqrt((pace * sim.cur.tyreGrip * 9.81) / Math.max(c, 1e-4));
      const allowed = Math.sqrt(vc * vc + 2 * 6 * q * t.ds);
      if (allowed < target) target = allowed;
    }
    const err = target - v;
    sim.setParams({
      steer: Math.max(-100, Math.min(100, steer * 100)),
      throttle: err > 0 ? Math.min(100, err * 40) : 0,
      brake: err < -0.5 ? Math.min(100, -err * 30) : 0,
    });
    sim.run(0.01);
    maxOff = Math.max(maxOff, Math.abs(car.pos.d));
    maxSpeed = Math.max(maxSpeed, v);
  }
  return { maxOff, maxSpeed };
}
