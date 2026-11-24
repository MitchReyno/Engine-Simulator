// Render a full-throttle pull to a WAV file, for listening against a recording.
// usage: vite-node scripts/render.ts   (PRESET=k24 FROM=4000 TO=7650 SECONDS=7 OUT=samples/sim.wav)
import { EngineSim } from '../src/sim/engine';
import { presetParams } from '../src/sim/params';
import { aimMic } from '../tests/util';
import { spectrogramPng, stft, writeWav } from './wav';

const id = process.env.PRESET ?? 'k24';
const from = Number(process.env.FROM ?? 4000), to = Number(process.env.TO ?? 7650), secs = Number(process.env.SECONDS ?? 7);
const out = process.env.OUT ?? `samples/Simulated-${id}-Near-Exhaust.wav`;
const sr = 44100;
const sim = new EngineSim(sr, { ...presetParams(id), revLimit: Math.max(presetParams(id).revLimit, to + 500) });
aimMic(sim, 'tail', 0.4, 0.6);
sim.run(3);
sim.setParams({ throttle: 100 });
let load = 30;
const hold = (target: number, seconds: number, sink?: Float64Array, at = 0) => {
  const n = Math.round(seconds * sr);
  for (let i = 0; i < n; i++) {
    if (i % 128 === 0) sim.beginBlock();
    // the dyno load follows a speed ramp, like a car accelerating in one gear
    if (i % 2048 === 0) { load = Math.min(100, Math.max(0.5, load * (1 + 0.6 * (sim.rpm - target) / target))); sim.setParams({ load }); }
    sim.step();
    if (sink) sink[at + i] = sim.lastEx + sim.lastIn;
  }
};
hold(from, 4);
const x = new Float64Array(Math.round(secs * sr));
const chunk = 0.25;
for (let t = 0; t < secs; t += chunk) hold(from + ((to - from) * t) / secs, chunk, x, Math.round(t * sr));
let peak = 0;
for (const v of x) peak = Math.max(peak, Math.abs(v));
for (let i = 0; i < x.length; i++) x[i] *= 0.9 / peak;
writeWav(out, x, sr);
spectrogramPng(out.replace(/\.wav$/, '.png'), stft(x, 8192, 1024), sr / 8192, 20, 8000);
console.log(`wrote ${out}: ${secs} s, ${from} to ${to} rpm (ended at ${sim.rpm.toFixed(0)}), peak ${peak.toFixed(1)} Pa before normalising`);
