import './style.css';
import { EngineAudio } from './audio/engine-audio';
import { LAYOUT_KINDS, cylinderOptions, findLayout } from './sim/layouts';
import { PARAM_DEFS, PRESETS, Params, presetParams } from './sim/params';
import { FLAG_IGNITION, FLAG_LIMITER, FLAG_STARTER, H } from './sim/snapshot';
import { CIRCUIT } from './sim/track';
import { DriveView } from './view3d/driveView';
import { Controls } from './ui/controls';
import { Instruments, cylColor } from './ui/instruments';
import { MODEL_NOTES_HTML } from './ui/modelNotes';
import { CYL_SCALE, ColorMode, legend } from './view3d/colors';
import { makeDraggable } from './ui/drag';
import { Dyno } from './ui/dyno';
import { ViewOptions } from './ui/viewOptions';
import { EngineView } from './view3d/engineView';
import { PART_PARAMS } from './view3d/parts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let presetId = 'i4';
let params: Params = presetParams(presetId);

// Audio, car body and model fidelity settings belong to the listening setup, not the engine: they are kept between visits.
const SETTINGS_GROUPS = ['Audio', 'Car body', 'Model fidelity', 'Mechanical noise'];
const SETTINGS_DEFS = PARAM_DEFS.filter((d) => SETTINGS_GROUPS.includes(d.group));
const SETTINGS_STORE = 'engine-sim.settings.v1';
const BUDGET_DEFAULT = 140;
let setBudgetWidget: (cells: number) => void = () => {};
function loadSettings(): Params {
  const out: Params = {};
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_STORE) ?? '{}') as Record<string, unknown>;
    // only known keys, snapped into range, so a stale or edited entry cannot break the page
    for (const d of SETTINGS_DEFS) {
      const v = saved[d.key];
      if (typeof v === 'number' && Number.isFinite(v)) out[d.key] = Math.min(d.max, Math.max(d.min, d.kind === 'slider' ? v : Math.round(v)));
    }
    const cells = saved.cellBudget;
    if (typeof cells === 'number' && Number.isFinite(cells)) out.cellBudget = Math.min(1200, Math.max(60, Math.round(cells)));
  } catch {
    // storage blocked or corrupt: run on defaults
  }
  return out;
}
function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_STORE, JSON.stringify({ ...Object.fromEntries(SETTINGS_DEFS.map((d) => [d.key, params[d.key]])), cellBudget: params.cellBudget }));
  } catch {
    // private window or storage full: the settings still apply for this visit
  }
}
Object.assign(params, loadSettings());
const audio = new EngineAudio();
const view = new EngineView($('view3d'));
const instruments = new Instruments({
  scope: $('c-scope'), spec: $('c-spec'), pv: $('c-pv'), ptheta: $('c-ptheta'), tract: $('c-tract'), valves: $('c-valves'),
});

// ------------------------------------------------------------- parameters

const KEEP_ON_PRESET = ['drive', 'autoShift', 'autoClutch', 'abs', 'tc', 'mixCar', 'volume', 'mixExhaust', 'mixIntake', 'mixMech', 'micX', 'micY', 'micZ', 'carBody', 'bonnetOpen', 'windowsOpen', 'undertray', 'bayLining', 'firewallMass', 'cabinMass', 'cabinAbsorb', 'timeScale', 'paused', 'cellBudget', ...PARAM_DEFS.filter((d) => d.tiers).map((d) => d.key)];
const RESTART_KEYS = new Set(['airbox', 'boost', 'rearSplit', 'catalyst', 'mufflerType', 'strokes', 'chamberSilencer', 'induction', 'layout', 'cylinders', 'crank', 'firingOrder', 'collector']);

function push(values: Params): void {
  audio.setParams(values);
  view.setParams(params);
  driveView?.setParams(params);
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
  if (key in { airbox: 1, boost: 1, fxMech: 1, vtec: 1, vtc: 1, vtcRange: 1, vtecRpm: 1, strokes: 1, induction: 1, exhaustPortOpen: 1, transferPortOpen: 1, layout: 1, cylinders: 1, crank: 1, firingOrder: 1, bankAngle: 1, bore: 1, stroke: 1, rodLength: 1, intakeDuration: 1, exhaustDuration: 1, lsa: 1, camAdvance: 1 }) controls.refreshDynamic();
  push(changed);
  if (SETTINGS_DEFS.some((d) => d.key in changed)) saveSettings();
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
  n2.innerHTML = 'Exhaust and intake are the simulated flow at the pipe mouths. Mechanical is the block ringing under simulated forces: gas load, piston slap, valve seating, injectors, the timing drive and surface roughness. See Model notes.';
  audioPanel.appendChild(n2);
  const recRow = document.createElement('div');
  recRow.className = 'btn-row';
  recRow.innerHTML = `<button id="record" title="Saves the next 10 seconds of sound as a WAV file, with the settings in use">Record 10 s</button><span class="note">saves a WAV of exactly what is playing</span>`;
  audioPanel.appendChild(recRow);
  $('record').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('record');
    if (!audio.ctx || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Recording…';
    const x = await audio.record(10);
    const sr = audio.ctx.sampleRate;
    const wav = new DataView(new ArrayBuffer(44 + x.length * 2));
    const text = (o: number, t: string) => [...t].forEach((ch, i) => wav.setUint8(o + i, ch.charCodeAt(0)));
    text(0, 'RIFF'); wav.setUint32(4, 36 + x.length * 2, true); text(8, 'WAVEfmt '); wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true); wav.setUint16(22, 1, true); wav.setUint32(24, sr, true); wav.setUint32(28, sr * 2, true);
    wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); text(36, 'data'); wav.setUint32(40, x.length * 2, true);
    for (let i = 0; i < x.length; i++) wav.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), true);
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    const save = (blob: Blob, name: string) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    save(new Blob([wav.buffer], { type: 'audio/wav' }), `engine-sim-${presetId}-${stamp}.wav`);
    // the settings that produced it, so the sound can be reproduced
    save(new Blob([JSON.stringify(params, null, 1)], { type: 'application/json' }), `engine-sim-${presetId}-${stamp}.json`);
    btn.disabled = false;
    btn.textContent = 'Record 10 s';
  });

  const sim = document.createElement('div');
  sim.innerHTML = `<div class="panel-body" style="padding:0">
    <div class="note">Each row is one aspect of the engine. The badge says what the current choice is: <b style="color:#6fd08c">modelled</b> from physics, <b>approximated</b>, <b style="color:var(--danger)">faked</b>, or left out.</div>
    <label class="row row-slider"><div class="row-head"><span class="row-label">Pipe resolution</span><span class="row-value" id="budget-value"></span></div>
      <input id="budget" type="range" min="60" max="1200" step="10" /></label>
    <div class="note" id="budget-live"></div>
    <div class="note" id="sim-note">Upper limit on finite-volume cells across all pipes; the status line under the gauges shows how many are in use. Up to 600 this is a ceiling: a pipe is never divided finer than one time step allows (about 2 cm for intake pipes and 4 cm for exhaust at 48 kHz), so a short system stops gaining before the ceiling. Above 600 the slider asks for cells finer than that, up to about twice as many at 1200, and the solver then takes two or more steps per sample, which costs several times as much. If the audio thread runs out of time the limit is lowered automatically; the physics is never dropped.</div></div>`;
  controls.panels.get('Model fidelity')!.prepend(sim);
  const budget = $<HTMLInputElement>('budget');
  const showBudget = (cells: number) => {
    budget.value = String(cells);
    $('budget-value').textContent = `${cells} cells`;
    budget.style.setProperty('--fill', `${((cells - 60) / 1140) * 100}%`);
  };
  showBudget(params.cellBudget);
  budget.addEventListener('input', () => showBudget(Number(budget.value)));
  // changing it rebuilds the pipe network, so apply on release, not on every step of the drag
  budget.addEventListener('change', () => {
    params.cellBudget = Number(budget.value);
    push({ cellBudget: params.cellBudget });
    saveSettings();
  });
  setBudgetWidget = showBudget;
  audio.onQuality = (cells, load) => {
    params.cellBudget = cells;
    view.setParams(params);
    showBudget(cells);
    // remember what this machine can sustain, so the next visit does not start by overloading
    saveSettings();
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
  const target = pedalHeld ? pedalValue : keyHeld ? 100 : padThrottle > 0 ? padThrottle : driving ? 0 : throttleBase;
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
  } else if (driving && driveKey(k, true, e.repeat)) e.preventDefault();
  else if (k === 's') setStarter(true);
  else if (k === 'i' && !e.repeat) setParam('ignition', params.ignition > 0.5 ? 0 : 1);
  else if (k === 'p' && !e.repeat) togglePause();
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'w' || k === 'arrowup') keyHeld = false;
  else if (driving && driveKey(k, false, false)) return;
  else if (k === 's') setStarter(false);
});
window.addEventListener('blur', () => {
  keyHeld = false;
  held.left = held.right = held.brake = held.clutch = false;
  setStarter(false);
});

// ------------------------------------------------------------ driving mode

let driving = false;
let driveView: DriveView | null = null;
let padThrottle = 0;
const held = { left: false, right: false, brake: false, clutch: false };
const driveIn = { steer: 0, brake: 0, clutch: 0 };
const padPrev = { up: false, down: false, reset: false, cam: false };

function driveKey(k: string, down: boolean, repeat: boolean): boolean {
  if (k === 'a' || k === 'arrowleft') held.left = down;
  else if (k === 'd' || k === 'arrowright') held.right = down;
  else if (k === 's' || k === 'arrowdown') held.brake = down;
  else if (k === 'c') held.clutch = down;
  else if (k === 'enter') setStarter(down);
  else if (k.length === 1 && 'eqrgv'.includes(k)) {
    if (!down || repeat) return true;
    if (k === 'e') audio.shift(1);
    else if (k === 'q') audio.shift(-1);
    else if (k === 'r') audio.resetCar(false);
    else if (k === 'g') audio.resetCar(true);
    else driveView?.nextCamera();
  } else return false;
  return true;
}

function setDriving(on: boolean): void {
  driving = on;
  $('drive').classList.toggle('on', on);
  $('stage').classList.toggle('driving', on);
  $('viewdrive').hidden = !on;
  $('hud').hidden = !on;
  if (on && !driveView) {
    driveView = new DriveView($('viewdrive'));
    driveView.setParams(params);
    drawMapBase();
  }
  params.drive = on ? 1 : 0;
  if (on && params.paused) togglePause();
  if (on && params.timeScale < 0.999) {
    speed.value = '0';
    speed.dispatchEvent(new Event('input'));
  }
  audio.setParams({ drive: params.drive, steer: 0, brake: 0, clutch: 0 });
  (document.activeElement as HTMLElement | null)?.blur();
}
$('drive').addEventListener('click', () => setDriving(!driving));

/** Keyboard and gamepad to steering, brake and clutch; throttle goes through the pedal logic. */
function tickDrive(dt: number): void {
  const s = audio.snap;
  const v = s ? Math.hypot(s.h(H.carVx), s.h(H.carVy)) : 0;
  // Keys are all-or-nothing, so limit lock to roughly what the tyres can use at this speed.
  const usable = Math.min(1, Math.max(0.06, (2.2 * 2.67 * 9.81 * params.tyreGrip) / Math.max(1, v * v) / 0.58 + 0.035));
  let steer = driveIn.steer, brake = driveIn.brake;
  const pad = navigator.getGamepads?.().find((g) => g && g.connected && g.axes.length >= 2) ?? null;
  const dir = (held.left ? 1 : 0) - (held.right ? 1 : 0);
  if (pad && Math.abs(pad.axes[0]) > 0.06 && dir === 0) {
    const ax = -pad.axes[0];
    steer = Math.sign(ax) * Math.pow(Math.abs(ax), 1.5) * (0.3 + 0.7 * usable) * 100;
  } else {
    const target = dir * usable * 100;
    const rate = (dir === 0 || Math.sign(target) !== Math.sign(steer) ? 320 : 170) * dt * Math.max(usable, 0.25);
    steer = Math.abs(target - steer) <= rate ? target : steer + Math.sign(target - steer) * rate;
  }
  const padBrake = pad ? pad.buttons[6]?.value ?? 0 : 0;
  padThrottle = pad ? (pad.buttons[7]?.value ?? 0) * 100 : 0;
  const brakeTarget = held.brake ? 100 : padBrake * 100;
  const br = (brakeTarget > brake ? 450 : 900) * dt;
  brake = Math.abs(brakeTarget - brake) <= br ? brakeTarget : brake + Math.sign(brakeTarget - brake) * br;
  const clutch = held.clutch ? 100 : 0;
  if (pad) {
    const b = (i: number) => !!pad.buttons[i]?.pressed;
    if (b(5) && !padPrev.up) audio.shift(1);
    if (b(4) && !padPrev.down) audio.shift(-1);
    if (b(3) && !padPrev.reset) audio.resetCar(false);
    if (b(2) && !padPrev.cam) driveView?.nextCamera();
    padPrev.up = b(5); padPrev.down = b(4); padPrev.reset = b(3); padPrev.cam = b(2);
  }
  if (steer !== driveIn.steer || brake !== driveIn.brake || clutch !== driveIn.clutch) {
    driveIn.steer = steer; driveIn.brake = brake; driveIn.clutch = clutch;
    audio.setParams({ steer, brake, clutch });
  }
  if (driveView) driveView.brake = brake / 100;
}

const mapBase = document.createElement('canvas');
const MAP = { scale: 1, ox: 0, oy: 0 };
function drawMapBase(): void {
  const c = $<HTMLCanvasElement>('hud-map');
  mapBase.width = c.width; mapBase.height = c.height;
  const t = CIRCUIT;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < t.n; i++) { x0 = Math.min(x0, t.x[i]); x1 = Math.max(x1, t.x[i]); y0 = Math.min(y0, t.y[i]); y1 = Math.max(y1, t.y[i]); }
  MAP.scale = Math.min((c.width - 20) / (x1 - x0), (c.height - 20) / (y1 - y0));
  MAP.ox = 10 - x0 * MAP.scale + 0.5 * (c.width - 20 - (x1 - x0) * MAP.scale);
  MAP.oy = c.height - 10 + y0 * MAP.scale - 0.5 * (c.height - 20 - (y1 - y0) * MAP.scale);
  const g = mapBase.getContext('2d')!;
  g.strokeStyle = '#e8edf2';
  g.lineWidth = 3;
  g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i <= t.n; i += 2) {
    const k = i % t.n;
    const px = MAP.ox + t.x[k] * MAP.scale, py = MAP.oy - t.y[k] * MAP.scale;
    i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
  }
  g.closePath();
  g.stroke();
  g.fillStyle = '#ffb000';
  g.fillRect(MAP.ox + t.x[0] * MAP.scale - 1.5, MAP.oy - t.y[0] * MAP.scale - 6, 3, 12);
}

const lapText = (sec: number) => (sec > 0 ? `${Math.floor(sec / 60)}:${(sec % 60).toFixed(sec < 600 ? 2 : 1).padStart(5, '0')}` : '–');
function updateHud(): void {
  const s = audio.snap;
  if (!s) return;
  const v = Math.hypot(s.h(H.carVx), s.h(H.carVy));
  $('hud-speed').firstElementChild!.textContent = String(Math.round(v * 3.6));
  const gear = s.h(H.carGear);
  $('hud-gear').textContent = gear < 0 ? 'R' : gear === 0 ? 'N' : String(gear);
  const frac = Math.min(1, s.h(H.rpm) / params.revLimit);
  const fill = $('hud-rev-fill');
  fill.style.width = `${frac * 100}%`;
  fill.className = frac > 0.93 ? 'shift' : frac > 0.8 ? 'high' : '';
  $('hud-lap').textContent = lapText(s.h(H.lapTime)).replace('–', '0:00.00');
  $('hud-last').textContent = lapText(s.h(H.lastLap));
  $('hud-best').textContent = lapText(s.h(H.bestLap));
  const aids = s.h(H.carAids);
  $('hud-abs').classList.toggle('on', !!(aids & 1));
  $('hud-tc').classList.toggle('on', !!(aids & 2));
  $('hud-off').classList.toggle('on', s.h(H.carGrass) > 0.4);
  const c = $<HTMLCanvasElement>('hud-map');
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.drawImage(mapBase, 0, 0);
  g.fillStyle = '#ff4d5e';
  g.beginPath();
  g.arc(MAP.ox + s.h(H.carX) * MAP.scale, MAP.oy - s.h(H.carY) * MAP.scale, 4, 0, 7);
  g.fill();
}

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
// Display options: a gear on every plot and one button for the 3D view.
const viewOptions = new ViewOptions();
instruments.opt = viewOptions.values;
for (const b of document.querySelectorAll<HTMLElement>('[data-viz]')) viewOptions.attach(b, b.dataset.viz!);
viewOptions.onChange = () => view.setViewOptions(viewOptions.values);
view.setViewOptions(viewOptions.values);

const aboutDialog = $<HTMLDialogElement>('about-dialog');
$('about-body').innerHTML = MODEL_NOTES_HTML;
$('about').addEventListener('click', () => aboutDialog.showModal());

// Audio and model fidelity live in a floating settings panel, not the engine's side panel.
{
  const dialog = $<HTMLDialogElement>('settings-dialog'), button = $('settings');
  for (const g of SETTINGS_GROUPS) {
    const det = controls.panels.get(g)!.parentElement as HTMLDetailsElement;
    // the per-source mechanical controls stay folded away until wanted
    det.open = g !== 'Mechanical noise' && g !== 'Car body';
    $('settings-body').appendChild(det);
  }
  const mechPanel = controls.panels.get('Mechanical noise')!;
  const mechNote = document.createElement('div');
  mechNote.className = 'note';
  mechNote.textContent = 'Each kind of mechanical noise has its own volume. 100 % is the balance fitted to an engine-bay recording. Piston clearance, valve lash and the timing drive type are in the engine panels.';
  mechPanel.insertBefore(mechNote, mechPanel.firstChild);
  mechPanel.parentElement!.querySelector('summary')!.textContent = 'Mechanical noise: per-source detail';
  const show = (on: boolean) => {
    if (on) dialog.show(); else dialog.close();
    button.classList.toggle('on', on);
  };
  button.addEventListener('click', () => show(!dialog.open));
  $('settings-close').addEventListener('click', () => show(false));
  dialog.addEventListener('close', () => button.classList.remove('on'));
  $('settings-defaults').addEventListener('click', () => {
    for (const d of SETTINGS_DEFS) if (params[d.key] !== d.def) setParam(d.key, d.def);
    if (params.cellBudget !== BUDGET_DEFAULT) {
      params.cellBudget = BUDGET_DEFAULT;
      setBudgetWidget(BUDGET_DEFAULT);
      push({ cellBudget: BUDGET_DEFAULT });
    }
    saveSettings();
  });
}

// Dynamometer panel.
const dyno = new Dyno($('dyno-body'), {
  audio,
  params: () => params,
  setParam,
  push: (values) => { Object.assign(params, values); audio.setParams(values); },
  presetName: () => PRESETS.find((p) => p.id === presetId)?.name ?? presetId,
});
{
  const dialog = $<HTMLDialogElement>('dyno-dialog'), button = $('dyno');
  const show = (on: boolean) => {
    if (on) dialog.show(); else dialog.close();
    button.classList.toggle('on', on);
  };
  button.addEventListener('click', () => show(!dialog.open));
  $('dyno-close').addEventListener('click', () => show(false));
}

// Panels that stay open while you work can be dragged out of the way by their header; the part label by
// anywhere that is not a control. The model notes are a modal page of text and stay put.
for (const id of ['settings-dialog', 'dyno-dialog']) {
  const d = $(id);
  makeDraggable(d, d.querySelector<HTMLElement>('.settings-head')!);
}
let labelMoved = false;
makeDraggable($('partlabel'), $('partlabel'), () => (labelMoved = true));

view.onMicMove = (x, y, z) => {
  const round = (v: number) => Math.round(v * 100) / 100;
  for (const [k, v] of [['micX', x], ['micY', y], ['micZ', z]] as const) if (round(v) !== params[k]) setParam(k, round(v));
};
$('show-mic').addEventListener('click', () => view.showMic());
// Places to listen from, offered while the microphone is selected.
const micPresetBar = $('mic-presets');
function buildMicPresets(): void {
  micPresetBar.replaceChildren(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Move it to' }));
  view.micPresets().forEach((preset, i) => {
    const b = document.createElement('button');
    b.textContent = preset.name;
    b.title = preset.hint;
    b.addEventListener('click', () => {
      // positions follow the engine and exhaust as they are now, not as they were when the buttons were made
      const [x, y, z] = view.micPresets()[i].at;
      setParam('micX', x);
      setParam('micY', y);
      setParam('micZ', z);
      view.showMic();
    });
    micPresetBar.appendChild(b);
  });
}

const partLabel = $('partlabel');
// A picked part brings its own sliders: the label stops following the part and stays where it was clicked.
let pinPending = false;
view.onPick = (info, key) => {
  partLabel.hidden = !info;
  // a fresh pick puts the label back where it belongs
  labelMoved = false;
  partLabel.style.transform = '';
  const rows = (key ? PART_PARAMS[key] ?? [] : []).filter((k) => controls.applies(k) || k.startsWith('mic')).map((k) => controls.extraRow(k)).filter((r): r is HTMLElement => !!r);
  $('part-params').replaceChildren(...rows);
  const pinned = rows.length > 0 && key !== 'microphone';
  partLabel.classList.toggle('pinned', pinned);
  view.holdPick = pinned;
  pinPending = pinned;
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
    ` · ${Math.max(0, s.h(H.spl)).toFixed(0)} dB SPL` +
    (params.boost > 0.5 && params.strokes < 0.5 ? ` · boost ${(s.h(H.boost) / 1e3).toFixed(0)} kPa, compressor ${(s.h(H.turboRpm) / 1000).toFixed(0)}k rpm${params.boost < 1.5 ? `, wastegate ${(s.h(H.wastegate) * 100).toFixed(0)} %` : ''}` : '') +
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
  if (driving) tickDrive(dt);
  tickThrottle(dt);
  if (driving) {
    driveView!.render(audio.snap, dt);
    updateHud();
  } else view.render(audio.snap, dt);
  if (view.labelDocked && !partLabel.classList.contains('docked')) buildMicPresets();
  partLabel.classList.toggle('docked', view.labelDocked);
  if (labelMoved) {
    // the user has put it somewhere: leave it there
  } else if (view.labelDocked) {
    partLabel.style.left = partLabel.style.top = '';
    partLabel.style.visibility = 'visible';
  } else if (partLabel.classList.contains('pinned')) {
    if (pinPending && view.labelPos) {
      // beside the click, kept inside the view and clear of the throttle pedal
      const stage = partLabel.parentElement!;
      partLabel.style.left = `${Math.max(8, Math.min(stage.clientWidth - partLabel.offsetWidth - 60, view.labelPos.x + 16))}px`;
      partLabel.style.top = `${Math.max(8, Math.min(stage.clientHeight - partLabel.offsetHeight - 8, view.labelPos.y - 40))}px`;
      partLabel.style.visibility = 'visible';
      pinPending = false;
    }
  } else if (view.labelPos && !partLabel.hidden) {
    partLabel.style.left = `${view.labelPos.x}px`;
    partLabel.style.top = `${view.labelPos.y}px`;
    partLabel.style.visibility = 'visible';
  } else partLabel.style.visibility = 'hidden';
  dyno.tick(dt);
  instruments.draw(audio, params);
  updateGauges(dt);
  if (frame % 20 === 0 && audio.snap) {
    const steps = audio.snap.h(H.substeps);
    $('budget-live').textContent = `In use now: ${audio.snap.nCells} cells, ${steps} solver step${steps > 1 ? 's' : ''} per sample, audio thread at ${(audio.snap.h(H.cpuLoad) * 100).toFixed(0)} %.`;
  }
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
(window as any).engineSim = { audio, view, instruments, setDriving, get driveView() { return driveView; }, get params() { return params; }, setParam, applyPreset };
