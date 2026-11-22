import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recording, score, simulated } from '../scripts/compare';

const sample = new URL('../samples/K24-External-Near-Exhaust.wav', import.meta.url).pathname;

describe('against a recording', () => {
  // the recordings are not part of the repository; the check runs only where they exist
  it.skipIf(!existsSync(sample))('K24 at full throttle: engine orders and noise floor within 7 dB of the recording on average', () => {
    const real = recording();
    expect(real.filter((r) => r.n > 10).length).toBeGreaterThanOrEqual(5);
    expect(score(real, simulated('k24', {}))).toBeLessThan(7);
    // the fitted pieces matter: identical cylinders, no catalyst and a bare muffler is clearly worse
    expect(score(real, simulated('k24', { fxVar: 0, fxTurb: 0, catalyst: 0, mufflerType: 0, headerSpread: 0 }))).toBeGreaterThan(9);
  });
});
