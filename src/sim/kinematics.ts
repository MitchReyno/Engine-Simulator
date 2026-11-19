// Crank-slider kinematics and cam lift. Angles in radians unless named *Deg.

export interface CrankGeom {
  bore: number;
  stroke: number;
  rod: number;
  compression: number;
}

export const DEG = Math.PI / 180;

export function pistonArea(g: CrankGeom): number {
  return 0.25 * Math.PI * g.bore * g.bore;
}

export function displacement(g: CrankGeom): number {
  return pistonArea(g) * g.stroke;
}

export function clearanceVolume(g: CrankGeom): number {
  return displacement(g) / (g.compression - 1);
}

/** Distance from crank centre to wrist pin; theta = 0 at TDC. */
export function wristPinHeight(theta: number, r: number, l: number): number {
  const s = Math.sin(theta);
  return r * Math.cos(theta) + Math.sqrt(l * l - r * r * s * s);
}

export function cylinderVolume(theta: number, g: CrankGeom): number {
  const r = 0.5 * g.stroke;
  return clearanceVolume(g) + pistonArea(g) * (r + g.rod - wristPinHeight(theta, r, g.rod));
}

export function dVolumeDTheta(theta: number, g: CrankGeom): number {
  const r = 0.5 * g.stroke;
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  return pistonArea(g) * r * s * (1 + (r * c) / Math.sqrt(g.rod * g.rod - r * r * s * s));
}

/** Lobe fullness exponents for the cam profile options: lift = L (1 - x^2)^e. */
export const CAM_EXPONENTS = [3, 2, 1.3];

/**
 * Valve lift for a symmetric lobe. Duration is seat-to-seat; the profile is
 * (1 - x^2)^e, which has zero lift and zero velocity at both seats.
 * All angles in crank degrees on the 720-degree cycle.
 */
export function camLift(angleDeg: number, centreDeg: number, durationDeg: number, maxLift: number, exponent = 2): number {
  let d = angleDeg - centreDeg;
  d -= 720 * Math.floor((d + 360) / 720);
  const x = (2 * d) / durationDeg;
  if (x <= -1 || x >= 1) return 0;
  const q = 1 - x * x;
  return exponent === 2 ? maxLift * q * q : maxLift * Math.pow(q, exponent);
}

export interface ValveEvents {
  /** Lobe centres on the cycle (0 = firing TDC, 360 = overlap TDC). */
  intakeCentre: number;
  exhaustCentre: number;
  ivo: number;
  ivc: number;
  evo: number;
  evc: number;
  overlap: number;
}

export function valveEvents(intakeDur: number, exhaustDur: number, lsa: number, advance: number): ValveEvents {
  const intakeCentre = 360 + (lsa - advance);
  const exhaustCentre = 360 - (lsa + advance);
  const ivo = intakeCentre - intakeDur / 2;
  const ivc = intakeCentre + intakeDur / 2;
  const evo = exhaustCentre - exhaustDur / 2;
  const evc = exhaustCentre + exhaustDur / 2;
  return { intakeCentre, exhaustCentre, ivo, ivc, evo, evc, overlap: Math.max(0, evc - ivo) };
}
