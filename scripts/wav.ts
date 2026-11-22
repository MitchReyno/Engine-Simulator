// Minimal WAV reading/writing and a spectrogram PNG, for comparing the simulator with recordings.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { spectrum } from '../tests/util';

export function readWav(path: string): { sr: number; ch: Float64Array[] } {
  const b = readFileSync(path);
  let o = 12, sr = 44100, nch = 2, bits = 16, fmt = 1;
  while (o < b.length - 8) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') { fmt = b.readUInt16LE(o + 8); nch = b.readUInt16LE(o + 10); sr = b.readUInt32LE(o + 12); bits = b.readUInt16LE(o + 22); }
    if (id === 'data') {
      const bytes = bits / 8, n = Math.floor(Math.min(size, b.length - o - 8) / (bytes * nch));
      const ch = Array.from({ length: nch }, () => new Float64Array(n));
      for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
        const p = o + 8 + (i * nch + c) * bytes;
        ch[c][i] = fmt === 3 ? b.readFloatLE(p) : bits === 16 ? b.readInt16LE(p) / 32768 : bits === 24 ? b.readIntLE(p, 3) / 8388608 : b.readInt32LE(p) / 2147483648;
      }
      return { sr, ch };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

export function writeWav(path: string, x: Float64Array | Float32Array, sr: number): void {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  writeFileSync(path, b);
}

/** Magnitude frames, Hann window of n samples every hop samples. */
export function stft(x: Float64Array, n: number, hop: number): Float64Array[] {
  const frames: Float64Array[] = [];
  for (let s = 0; s + n <= x.length; s += hop) frames.push(spectrum(x.subarray(s, s + n)));
  return frames;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}

/** Spectrogram image: time left to right, log frequency fLo..fHi bottom to top, 70 dB range. */
export function spectrogramPng(path: string, frames: Float64Array[], binHz: number, fLo = 20, fHi = 6000, w = 1100, h = 520, overlay?: (t: number) => number[]): void {
  const px = Buffer.alloc((w * 3 + 1) * h);
  let top = 0;
  for (const f of frames) for (let i = 1; i < f.length; i++) if (f[i] > top) top = f[i];
  for (let y = 0; y < h; y++) {
    const hz = fLo * Math.pow(fHi / fLo, 1 - y / (h - 1));
    const bin = hz / binHz;
    for (let x = 0; x < w; x++) {
      const t = (x / (w - 1)) * (frames.length - 1);
      const f = frames[Math.round(t)];
      const i0 = Math.floor(bin), v = f[i0] + (f[i0 + 1] - f[i0]) * (bin - i0);
      let a = (20 * Math.log10(v / top + 1e-12) + 70) / 70;
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      px[o] = 255 * Math.min(1, a * 2.2); px[o + 1] = 255 * Math.max(0, a * 1.8 - 0.6); px[o + 2] = 255 * (a < 0.4 ? a * 1.6 : Math.max(0, 1.4 - a * 1.4) + Math.max(0, a - 0.8) * 4);
      if (overlay) for (const fo of overlay(t)) {
        const yo = Math.round((1 - Math.log(fo / fLo) / Math.log(fHi / fLo)) * (h - 1));
        if (yo === y) { px[o] = 0; px[o + 1] = 255; px[o + 2] = 255; }
      }
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]));
}
