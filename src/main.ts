import './style.css';
import { EngineAudio } from './audio/engine-audio';
import { LAYOUT_KINDS, cylinderOptions, findLayout } from './sim/layouts';
import { PARAM_DEFS, PRESETS, Params, presetParams } from './sim/params';
import { FLAG_IGNITION, FLAG_LIMITER, FLAG_STARTER, H } from './sim/snapshot';
import { Controls } from './ui/controls';
import { Instruments, cylColor } from './ui/instruments';
import { MODEL_NOTES_HTML } from './ui/modelNotes';
import { CYL_SCALE, ColorMode, legend } from './view3d/colors';
import { EngineView } from './view3d/engineView';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let presetId = 'i4';
let params: Params = presetParams(presetId);
const audio = new EngineAudio();
const view = new EngineView($('view3d'));
const instruments = new Instruments({
  scope: $('c-scope'), spec: $('c-spec'), pv: $('c-pv'), ptheta: $('c-ptheta'), tract: $('c-tract'), valves: $('c-valves'),
});

// ------------------------------------------------------------- parameters

const KEEP_ON_PRESET = ['volume', 'mixExhaust', 'mixIntake', 'mixMech', 'listenerPos', 'listenerDist', 'timeScale', 'paused', 'cellBudget', ...PARAM_DEFS.filter((d) => d.tiers).map((d) => d.key)];
const RESTART_KEYS = new Set(['strokes', 'chamberSilencer', 'induction', 'layout', 'cylinders', 'crank', 'firingOrder', 'collector']);

function push(values: Params): void {
  audio.setParams(values);
  view.setParams(params);
}

function setParam(key: string, value: number): void {
  const changed: Params = { [key]: value };
  if (key === 'layout') {
    const kind = LAYOUT_KINDS[value | 0];
    const options = cylinderOptions(kind);
    const cylinders = options.includes(params.cylinders) ? params.cylinders : options[Math.min(options.length - 1, 1)];
    Object.assign(changed, { cylinders, crank: 0, firingOrder: 0, bankAngle: findLayout(kind, cylinders).defaultBankAngle || params.bankAngle });
    if (cylinders === 1 && params.collector === 1) changed.collector = 0;
  } else if (key === 'cylinders') {
    Object.assign(changed, { crank: 0, firingOrder: 0, bankAngle: findLayout(LAYOUT_KINDS[params.layout | 0], value).defaultBankAngle || params.bankAngle });
  } else if (key === 'crank') {
    changed.firingOrder = 0;
  }
  Object.assign(params, changed);
  for (const k in changed) controls.set(k, changed[k]);
  if (key in { vtec: 1, vtc: 1, vtcRange: 1, vtecRpm: 1, strokes: 1, induction: 1, exhaustPortOpen: 1, transferPortOpen: 1, layout: 1, cylinders: 1, crank: 1, firingOrder: 1, bankAngle: 1, bore: 1, stroke: 1, rodLength: 1, intakeDuration: 1, exhaustDuration: 1, lsa: 1, camAdvance: 1 }) controls.refreshDynamic();
  push(changed);
  if (RESTART_KEYS.has(key)) audio.autoStart();
  if (key === 'layout' || key === 'cylinders') buildCylChips();
}

const controls = new Controls($('controls'), params, setParam);

function applyPreset(id: string): void {
  presetId = id;
  const next = presetParams(id);
  for (const k of KEEP_ON_PRESET) next[k] = params[k];
  params = next;
  controls.setAll(params);
  push(params);
  audio.autoStart();
  buildCylChips();
  $('preset-blurb').textContent = PRESETS.find((p) => p.id === id)?.blurb ?? '';
}

const presetSelect = $<HTMLSelectElement>('preset');
for (const p of PRESETS) presetSelect.appendChild(new Option(p.name, p.id));
presetSelect.addEventListener('change', () => applyPreset(presetSelect.value));
$('reset').addEventListener('click', () => applyPreset(presetId));
$('preset-blurb').textContent = PRESETS[0].blurb;

// Extra widgets inside the generated panels.
{
  const running = controls.panels.get('Running')!;
  const row = document.createElement('div');
  row.className = 'btn-row';
  row.innerHTML = `<button id="starter" title="Hold to crank (S)">Starter</button><span class="note">hold <kbd>S</kbd> to crank · <kbd>Space</kbd>/<kbd>W</kbd> throttle · <kbd>I</kbd> ignition · <kbd>P</kbd> pause</span>`;
  running.appendChild(row);
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = 'RPM is an output: the engine speeds up when gas torque exceeds friction plus load. The load is a brake whose torque rises with rpm².';
  running.appendChild(note);

  const audioPanel = controls.panels.get('Audio')!;
  const n2 = document.createElement('div');
  n2.className = 'note';
  n2.innerHTML = 'Exhaust and intake are the simulated flow at the pipe mouths. <b>Mechanical is faked</b>: filtered cylinder pressure and valve ticks. See Model notes.';
  audioPanel.appendChild(n2);

  const sim = document.createElement('div');
  sim.innerHTML = `<div class="panel-body" style="padding:0">
    <div class="note">Each row is one aspect of the engine. The badge says what the current choice is: <b style="color:#6fd08c">modelled</b> from physics, <b>approximated</b>, <b style="color:var(--danger)">faked</b>, or left out.</div>
    <label class="row"><div class="row-head"><span class="row-label">Pipe resolution</span>
      <select id="budget"><option value="60">Coarse (60 cells)</option><option value="100">Low (100)</option><option value="140">Medium (140)</option><option value="200">High (200)</option><option value="300">Very high (300)</option></select></div></label>
    <div class="note" id="sim-note">Total finite-volume cells across all pipes. If the audio thread runs out of time this is lowered automatically; the physics is never dropped.</div></div>`;
  controls.panels.get('Model fidelity')!.prepend(sim);
  const budget = $<HTMLSelectElement>('budget');
  budget.value = String(params.cellBudget);
  budget.addEventListener('change', () => {
    params.cellBudget = Number(budget.value);
    push({ cellBudget: params.cellBudget });
  });
  audio.onQuality = (cells, load) => {
    params.cellBudget = cells;
    view.setParams(params);
    if (![...budget.options].some((o) => Number(o.value) === cells)) budget.appendChild(new Option(`Auto-reduced (${cells})`, String(cells)));
    budget.value = String(cells);
    $('sim-note').innerHTML = `<b>Pipe resolution was reduced to ${cells} cells</b> because the audio thread was at ${(load * 100).toFixed(0)} % load. All physics is still running.`;
  };
}

// ---------------------------------------------------------------- running

const startOverlay = $('start');
$('start-btn').addEventListener('click', async () => {
  $('start-btn').textContent = 'Starting…';
  try {
    await audio.start(params);
    startOverlay.style.display = 'none';
  } catch (err) {
    $('start-btn').textContent = 'Start engine';
    startOverlay.querySelector('p')!.textContent = `Audio could not start: ${(err as Error).message}`;
  }
});
audio.onTopology = (t) => view.setTopology(t);

const starterBtn = $('starter');
const setStarter = (on: boolean) => {
  if ((params.starter > 0.5) === on) return;
  params.starter = on ? 1 : 0;
  starterBtn.classList.toggle('on', on);
  audio.setParams({ starter: params.starter });
};
starterBtn.addEventListener('pointerdown', () => setStarter(true));
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) starterBtn.addEventListener(ev, () => setStarter(false));

// Throttle: slider value is the resting position; pedal / key overrides while held.
let pedalHeld = false;
let keyHeld = false;
let pedalValue = 0;
let throttleBase = params.throttle;
let throttleLive = params.throttle;
const pedal = $('pedal');
const pedalFromEvent = (e: PointerEvent) => {
  const r = pedal.getBoundingClientRect();
  pedalValue = Math.min(100, Math.max(0, ((r.bottom - e.clientY) / r.height) * 100));
};
pedal.addEventListener('pointerdown', (e) => {
  pedal.setPointerCapture(e.pointerId);
  pedalHeld = true;
  pedalFromEvent(e);
});
pedal.addEventListener('pointermove', (e) => pedalHeld && pedalFromEvent(e));
for (const ev of ['pointerup', 'pointercancel']) pedal.addEventListener(ev, () => (pedalHeld = false));

function tickThrottle(dt: number): void {
  const target = pedalHeld ? pedalValue : keyHeld ? 100 : throttleBase;
  const rate = (target > throttleLive ? 500 : 700) * dt;
  const next = Math.abs(target - throttleLive) <= rate ? target : throttleLive + Math.sign(target - throttleLive) * rate;
  if (next !== throttleLive) {
    throttleLive = next;
    params.throttle = next;
    controls.set('throttle', next);
    audio.setParams({ throttle: next });
  }
  $('pedal-fill').style.height = `${throttleLive}%`;
}
// A slider drag sets the resting throttle.
function onSliderThrottle(): void {
  if (!pedalHeld && !keyHeld) {
    throttleBase = params.throttle;
    throttleLive = params.throttle;
  }
}

const isTyping = (e: KeyboardEvent) => ['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName) && (e.target as HTMLInputElement).type !== 'range';
window.addEventListener('keydown', (e) => {
  if (isTyping(e) || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'w' || k === 'arrowup') {
    keyHeld = true;
    e.preventDefault();
  } else if (k === 's') setStarter(true);
  else if (k === 'i' && !e.repeat) setParam('ignition', params.ignition > 0.5 ? 0 : 1);
  else if (k === 'p' && !e.repeat) togglePause();
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'w' || k === 'arrowup') keyHeld = false;
  else if (k === 's') setStarter(false);
});
window.addEventListener('blur', () => {
  keyHeld = false;
  setStarter(false);
});

// ------------------------------------------------------------ time control

const speed = $<HTMLInputElement>('speed');
function togglePause(): void {
  params.paused = params.paused ? 0 : 1;
  $('pause').classList.toggle('on', !!params.paused);
  $('pause').textContent = params.paused ? '▶' : '❚❚';
  audio.setParams({ paused: params.paused });
  updateSpeedLabel();
}
function updateSpeedLabel(): void {
  const ts = params.timeScale;
  const rpm = audio.snap?.h(H.rpm) ?? 0;
  const txt = ts >= 0.999 ? '1× real time' : `${ts >= 0.1 ? ts.toFixed(2) : ts.toFixed(4)}× · ${(rpm * 6 * ts).toFixed(rpm * 6 * ts < 100 ? 1 : 0)}°/s`;
  $('speed-label').textContent = params.paused ? 'paused · audio muted' : ts >= 0.999 ? txt : `${txt} · ${ts < 0.28 ? 'audio muted' : 'audio pitched down'}`;
}
$('pause').addEventListener('click', togglePause);
speed.addEventListener('input', () => {
  const v = Number(speed.value);
  params.timeScale = v > -0.02 ? 1 : Math.pow(10, v);
  audio.setParams({ timeScale: params.timeScale });
  updateSpeedLabel();
});
speed.addEventListener('dblclick', () => {
  speed.value = '0';
  speed.dispatchEvent(new Event('input'));
});
const stepBy = (deg: number) => {
  if (!params.paused) togglePause();
  audio.stepDegrees(deg);
};
$('step1').addEventListener('click', () => stepBy(1));
$('step10').addEventListener('click', () => stepBy(10));

// -------------------------------------------------------------- view modes

function setColorMode(mode: ColorMode): void {
  view.colorMode = mode;
  document.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === mode));
  const lg = legend(mode, CYL_SCALE);
  $('legend-bar').style.background = lg.gradient;
  const spans = $('legend-labels').children;
  spans[0].textContent = lg.low;
  spans[1].textContent = mode === 'pressure' ? 'cylinders (pipes: 0.55–1.8 bar)' : mode === 'temperature' ? 'cylinders (pipes: to 1500 K)' : '';
  spans[2].textContent = lg.high;
}
document.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((b) => b.addEventListener('click', () => setColorMode(b.dataset.color as ColorMode)));
setColorMode('pressure');
$('cutaway').addEventListener('click', (e) => {
  const on = (e.currentTarget as HTMLElement).classList.toggle('on');
  view.setCutaway(on);
});
$('exploded').addEventListener('click', (e) => view.setExploded((e.currentTarget as HTMLElement).classList.toggle('on')));
$('pv-log').addEventListener('click', (e) => {
  instruments.pvLog = !instruments.pvLog;
  (e.currentTarget as HTMLElement).textContent = instruments.pvLog ? 'linear' : 'log';
});

const aboutDialog = $<HTMLDialogElement>('about-dialog');
$('about-body').innerHTML = MODEL_NOTES_HTML;
$('about').addEventListener('click', () => aboutDialog.showModal());

const partLabel = $('partlabel');
view.onPick = (info) => {
  partLabel.hidden = !info;
  if (info) {
    partLabel.querySelector('b')!.textContent = info.title;
    partLabel.querySelector('p')!.textContent = info.text;
  }
};

function buildCylChips(): void {
  const n = findLayout(LAYOUT_KINDS[params.layout | 0], params.cylinders | 0).cylinders;
  instruments.selected = Math.min(instruments.selected, n - 1);
  const host = $('cyl-chips');
  host.replaceChildren();
  for (let i = 0; i < n; i++) {
    const b = document.createElement('button');
    b.textContent = String(i + 1);
    b.style.borderLeftColor = cylColor(i);
    b.classList.toggle('on', i === instruments.selected);
    b.addEventListener('click', () => {
      instruments.selected = i;
      buildCylChips();
    });
    host.appendChild(b);
  }
}
buildCylChips();

// ----------------------------------------------------------------- gauges

const tach = $<HTMLCanvasElement>('tach');
const smooth = { rpm: 0, torque: 0, power: 0, ve: 0, map: 101, air: 0 };
function drawTach(rpm: number): void {
  const c = tach.getContext('2d')!;
  const w = tach.width, h = tach.height;
  c.clearRect(0, 0, w, h);
  const max = Math.ceil((params.revLimit * 1.12) / 1000) * 1000;
  const cx = w / 2, cy = h - 16, R = h - 30;
  const ang = (v: number) => Math.PI + (Math.min(max, Math.max(0, v)) / max) * Math.PI;
  c.lineWidth = 8;
  c.strokeStyle = '#232b33';
  c.beginPath(); c.arc(cx, cy, R, Math.PI, 2 * Math.PI); c.stroke();
  c.strokeStyle = '#ff4d5e';
  c.beginPath(); c.arc(cx, cy, R, ang(params.revLimit), 2 * Math.PI); c.stroke();
  c.strokeStyle = '#ffb000';
  c.beginPath(); c.arc(cx, cy, R, Math.PI, ang(rpm)); c.stroke();
  c.fillStyle = '#7d8a96';
  c.font = '16px ui-monospace, Menlo, monospace';
  c.textAlign = 'center';
  for (let k = 0; k <= max; k += max > 9000 ? 2000 : 1000) {
    const a = ang(k);
    c.fillText(String(k / 1000), cx + Math.cos(a) * (R - 22), cy + Math.sin(a) * (R - 22) + 6);
  }
  c.fillStyle = '#d6dde4';
  c.font = '600 34px ui-monospace, Menlo, monospace';
  c.fillText(String(Math.round(rpm / 10) * 10), cx, cy - 8);
  c.fillStyle = '#7d8a96';
  c.font = '14px ui-monospace, Menlo, monospace';
  c.fillText('RPM', cx, cy + 12);
}

let fps = 60;
function updateGauges(dt: number): void {
  const s = audio.snap;
  if (!s) {
    drawTach(0);
    return;
  }
  const k = Math.min(1, dt * 10);
  smooth.rpm += (s.h(H.rpm) - smooth.rpm) * Math.min(1, dt * 25);
  smooth.torque += (s.h(H.torque) - smooth.torque) * k;
  smooth.power += (s.h(H.power) / 1000 - smooth.power) * k;
  smooth.ve += (s.h(H.ve) * 100 - smooth.ve) * k;
  smooth.map += (s.h(H.map) / 1000 - smooth.map) * k;
  smooth.air += (s.h(H.mdotAir) * 1000 - smooth.air) * Math.min(1, dt * 3);
  drawTach(smooth.rpm);
  $('g-torque').textContent = smooth.torque.toFixed(0);
  $('g-power').textContent = smooth.power.toFixed(Math.abs(smooth.power) < 100 ? 1 : 0);
  $('g-ve').textContent = smooth.ve.toFixed(0);
  $('g-map').textContent = smooth.map.toFixed(0);
  $('g-air').textContent = smooth.air.toFixed(Math.abs(smooth.air) < 10 ? 1 : 0);
  const flags = s.h(H.flags);
  $('lamp-ign').classList.toggle('on', !!(flags & FLAG_IGNITION));
  $('lamp-start').classList.toggle('on', !!(flags & FLAG_STARTER));
  $('lamp-limit').classList.toggle('on', !!(flags & FLAG_LIMITER));
  const load = s.h(H.cpuLoad);
  const resets = s.h(H.resets);
  $('status').innerHTML =
    `${audio.ctx!.sampleRate / 1000} kHz · ${s.nCells} pipe cells · ${s.h(H.substeps) > 1 ? `<span class="warn">${s.h(H.substeps)} sub-steps</span> · ` : ''}` +
    `audio thread <span class="${load > 0.6 ? 'warn' : ''}">${(load * 100).toFixed(0)} %</span><br>${fps.toFixed(0)} fps` +
    (params.fxWalls > 0.5 ? ` · header wall ${s.h(H.wallT).toFixed(0)} K` : '') +
    (params.vtc > 0.5 && s.h(H.strokes) === 4 ? ` · VTC ${s.h(H.vtc).toFixed(0)}°` : '') +
    (params.vtec > 0.5 && s.h(H.strokes) === 4 ? (s.h(H.vtec) > 0.5 ? ' · <span class="warn">VTEC high cam</span>' : ' · low cam') : '') +
    (resets ? ` · <span class="warn">${resets} solver reset${resets > 1 ? 's' : ''}</span>` : '') +
    (smooth.rpm < 30 && !(flags & FLAG_STARTER) ? ' · <span class="warn">stalled: hold S to crank</span>' : '');
}

// ------------------------------------------------------------------- loop

let last = performance.now();
let frame = 0;
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(1e-3, dt) - fps) * 0.05;
  tickThrottle(dt);
  view.render(audio.snap, dt);
  if (view.labelPos && !partLabel.hidden) {
    partLabel.style.left = `${view.labelPos.x}px`;
    partLabel.style.top = `${view.labelPos.y}px`;
    partLabel.style.visibility = 'visible';
  } else partLabel.style.visibility = 'hidden';
  instruments.draw(audio, params);
  updateGauges(dt);
  if (frame++ % 20 === 0 && params.timeScale < 0.999) updateSpeedLabel();
  requestAnimationFrame(loop);
}
view.setParams(params);
requestAnimationFrame(loop);

// keep the resting throttle in sync with slider drags
$('controls').addEventListener('input', (e) => {
  if ((e.target as HTMLInputElement).type === 'range') onSliderThrottle();
});

// Debug handle for inspecting the running simulation from the console.
(window as any).engineSim = { audio, view, instruments, get params() { return params; }, setParam, applyPreset };
