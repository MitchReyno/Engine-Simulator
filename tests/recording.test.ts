import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BANDS, recordingIdle, simulatedIdle, THIRDS } from '../scripts/bay';
import { recording, score, simulated } from '../scripts/compare';

const bay = new URL('../samples/K24-Engine-Bay.wav', import.meta.url).pathname;
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

  it.skipIf(!existsSync(bay))('K24 at idle beside the engine: spectrum within 3 dB per third octave, and mostly steady rather than knocking', () => {
    const real = recordingIdle().f, sim = simulatedIdle({}, 8, true).mech;
    THIRDS.forEach((hz, i) => { if (hz > 390) expect(Math.abs(sim.thirds[i] - real.thirds[i]), `${hz.toFixed(0)} Hz`).toBeLessThan(3); });
    BANDS.forEach((_, b) => {
      // envelope ripple at the firing rate within 8 dB of the recording's, well short of a train of knocks
      expect(Math.abs(sim.bands[b].mod[2] - real.bands[b].mod[2])).toBeLessThan(9);
      expect(sim.bands[b].mod[2]).toBeLessThan(-10);
    });
  });
});
