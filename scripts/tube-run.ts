import { tubeBench } from './tube';
for (const cells of [8, 16, 27, 60]) for (const radiation of [false, true]) {
  const r = tubeBench({ length: 0.5, diameter: 0.04, cells, radiation });
  console.log(`cells ${String(cells).padStart(3)} radiation ${radiation ? 'on ' : 'off'} | ` + r.modes.map((m) => `${m.hz.toFixed(0)}Hz ${m.peakDb.toFixed(0)}dB Q${m.q.toFixed(0)}`).join(' | '));
}
