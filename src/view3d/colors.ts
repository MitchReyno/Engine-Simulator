// Colour maps shared by the 3D view, the legend and the tract plot.

import { P_ATM } from '../sim/gas';

export type ColorMode = 'pressure' | 'temperature' | 'gas';

type RGB = [number, number, number];

const lerp3 = (a: RGB, b: RGB, t: number, out: RGB): RGB => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
};

function ramp(stops: RGB[], t: number, out: RGB): RGB {
  const x = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x);
  return lerp3(stops[i], stops[i + 1], x - i, out);
}

const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

const VACUUM: RGB[] = [hex(0xc9d2da), hex(0x58b6ff), hex(0x1f5fd0), hex(0x16257a)];
const BOOST: RGB[] = [hex(0xc9d2da), hex(0xffc24a), hex(0xff6a2b), hex(0xd21f3c), hex(0xffffff)];
const HEAT: RGB[] = [hex(0x1d3f8f), hex(0x6a3aa8), hex(0xc93a56), hex(0xf58a1f), hex(0xffe27a), hex(0xffffff)];
const FRESH: RGB = hex(0x49b6ff);
const BURNED: RGB = hex(0x8a5a36);

export interface Scale {
  /** Pressure limits in Pa (low, high) and temperature limits in K. */
  pLow: number;
  pHigh: number;
  tLow: number;
  tHigh: number;
}

export const PIPE_SCALE: Scale = { pLow: 0.55 * P_ATM, pHigh: 1.8 * P_ATM, tLow: 290, tHigh: 1500 };
export const CYL_SCALE: Scale = { pLow: 0.25 * P_ATM, pHigh: 70 * P_ATM, tLow: 290, tHigh: 2900 };

export function gasColor(mode: ColorMode, scale: Scale, p: number, T: number, Y: number, out: RGB): RGB {
  if (mode === 'pressure') {
    if (p < P_ATM) return ramp(VACUUM, Math.log(p / P_ATM) / Math.log(scale.pLow / P_ATM), out);
    return ramp(BOOST, Math.log(p / P_ATM) / Math.log(scale.pHigh / P_ATM), out);
  }
  if (mode === 'temperature') return ramp(HEAT, (T - scale.tLow) / (scale.tHigh - scale.tLow), out);
  return lerp3(FRESH, BURNED, Math.min(1, Math.max(0, Y)), out);
}

export function cssColor(c: RGB): string {
  return `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
}

/** CSS gradient + end labels for the legend. */
export function legend(mode: ColorMode, scale: Scale): { gradient: string; low: string; mid: string; high: string } {
  const n = 12;
  const stops: string[] = [];
  const tmp: RGB = [0, 0, 0];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let c: RGB;
    if (mode === 'pressure') {
      const lp = Math.log(scale.pLow / P_ATM) + t * (Math.log(scale.pHigh / P_ATM) - Math.log(scale.pLow / P_ATM));
      c = gasColor(mode, scale, P_ATM * Math.exp(lp), 0, 0, tmp);
    } else if (mode === 'temperature') c = gasColor(mode, scale, 0, scale.tLow + t * (scale.tHigh - scale.tLow), 0, tmp);
    else c = gasColor(mode, scale, 0, 0, t, tmp);
    stops.push(`${cssColor(c)} ${(t * 100).toFixed(0)}%`);
  }
  const bar = (p: number) => `${(p / 1e5).toFixed(p < 2e5 ? 2 : 0)} bar`;
  if (mode === 'pressure') return { gradient: `linear-gradient(90deg, ${stops.join(',')})`, low: bar(scale.pLow), mid: '1 atm', high: bar(scale.pHigh) };
  if (mode === 'temperature') return { gradient: `linear-gradient(90deg, ${stops.join(',')})`, low: `${scale.tLow} K`, mid: '', high: `${scale.tHigh} K` };
  return { gradient: `linear-gradient(90deg, ${stops.join(',')})`, low: 'fresh charge', mid: '', high: 'burned gas' };
}
