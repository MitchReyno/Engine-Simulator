// Engine configurations: bank layout, crank-pin angles and firing orders.
//
// Convention: crank angle theta increases with rotation; a pin with angle
// alpha points along the cylinder axis of bank angle beta (both measured from
// vertical) when theta = alpha - beta. That is the cylinder's TDC, which
// recurs every 360 degrees; the firing order decides which TDC of the 720
// degree cycle is the firing one.

export type LayoutKind = 'single' | 'inline' | 'v' | 'flat';
export const LAYOUT_KINDS: LayoutKind[] = ['single', 'inline', 'v', 'flat'];
export const LAYOUT_LABELS = ['Single', 'Inline', 'V', 'Flat (boxer)'];

export interface CrankDef {
  name: string;
  /** Crank-pin angle per cylinder, degrees. */
  pins: number[];
  /** Named firing orders (1-based cylinder numbers). Empty: most-even order is derived. */
  orders: number[][];
}

export interface LayoutDef {
  kind: LayoutKind;
  cylinders: number;
  defaultBankAngle: number;
  /** -1 left, 0 upright, +1 right, per cylinder. */
  bank: number[];
  /** Axial position index per cylinder. */
  slot: number[];
  cranks: CrankDef[];
}

const alt = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? 1 : -1));
const pairSlots = (n: number) => Array.from({ length: n }, (_, i) => i >> 1);
const seq = (n: number) => Array.from({ length: n }, (_, i) => i);
const zeros = (n: number) => new Array(n).fill(0);

export const LAYOUTS: LayoutDef[] = [
  { kind: 'single', cylinders: 1, defaultBankAngle: 0, bank: [0], slot: [0], cranks: [{ name: 'Single throw', pins: [0], orders: [[1]] }] },
  {
    kind: 'inline', cylinders: 2, defaultBankAngle: 0, bank: zeros(2), slot: seq(2),
    cranks: [
      { name: '360° (parallel twin)', pins: [0, 0], orders: [[1, 2]] },
      { name: '180°', pins: [0, 180], orders: [[1, 2]] },
      { name: '270° (cross-plane)', pins: [0, 270], orders: [[1, 2]] },
    ],
  },
  { kind: 'inline', cylinders: 3, defaultBankAngle: 0, bank: zeros(3), slot: seq(3), cranks: [{ name: '120°', pins: [0, 240, 120], orders: [[1, 2, 3], [1, 3, 2]] }] },
  {
    kind: 'inline', cylinders: 4, defaultBankAngle: 0, bank: zeros(4), slot: seq(4),
    cranks: [
      { name: 'Flat (180°)', pins: [0, 180, 180, 0], orders: [[1, 3, 4, 2], [1, 2, 4, 3]] },
      { name: 'Cross-plane (90°)', pins: [0, 90, 270, 180], orders: [[1, 3, 2, 4]] },
    ],
  },
  { kind: 'inline', cylinders: 5, defaultBankAngle: 0, bank: zeros(5), slot: seq(5), cranks: [{ name: '72°', pins: [0, 144, 216, 288, 72], orders: [[1, 2, 4, 5, 3]] }] },
  { kind: 'inline', cylinders: 6, defaultBankAngle: 0, bank: zeros(6), slot: seq(6), cranks: [{ name: '120°', pins: [0, 120, 240, 240, 120, 0], orders: [[1, 5, 3, 6, 2, 4], [1, 2, 4, 6, 5, 3]] }] },
  { kind: 'v', cylinders: 2, defaultBankAngle: 45, bank: alt(2), slot: pairSlots(2), cranks: [{ name: 'Shared pin', pins: [0, 0], orders: [[1, 2]] }] },
  {
    kind: 'v', cylinders: 6, defaultBankAngle: 60, bank: alt(6), slot: pairSlots(6),
    cranks: [
      { name: 'Split-pin (even-fire at 60°)', pins: [0, 300, 120, 60, 240, 180], orders: [[1, 6, 5, 4, 3, 2]] },
      { name: 'Shared pins (odd-fire)', pins: [0, 0, 120, 120, 240, 240], orders: [] },
    ],
  },
  {
    kind: 'v', cylinders: 8, defaultBankAngle: 90, bank: alt(8), slot: pairSlots(8),
    cranks: [
      { name: 'Cross-plane', pins: [0, 0, 270, 270, 90, 90, 180, 180], orders: [[1, 8, 4, 3, 6, 5, 7, 2], [1, 8, 7, 2, 6, 5, 4, 3]] },
      { name: 'Flat-plane', pins: [0, 0, 180, 180, 180, 180, 0, 0], orders: [[1, 4, 5, 8, 7, 6, 3, 2], [1, 6, 3, 8, 7, 4, 5, 2]] },
    ],
  },
  { kind: 'v', cylinders: 12, defaultBankAngle: 60, bank: alt(12), slot: pairSlots(12), cranks: [{ name: '120° six-throw', pins: [0, 0, 120, 120, 240, 240, 240, 240, 120, 120, 0, 0], orders: [] }] },
  { kind: 'flat', cylinders: 2, defaultBankAngle: 180, bank: [-1, 1], slot: [0, 0], cranks: [{ name: 'Boxer', pins: [0, 180], orders: [[1, 2]] }] },
  { kind: 'flat', cylinders: 4, defaultBankAngle: 180, bank: [-1, 1, -1, 1], slot: [0, 0, 1, 1], cranks: [{ name: 'Boxer', pins: [0, 180, 180, 0], orders: [[1, 3, 2, 4], [1, 4, 2, 3]] }] },
  { kind: 'flat', cylinders: 6, defaultBankAngle: 180, bank: [-1, -1, -1, 1, 1, 1], slot: [0, 1, 2, 0, 1, 2], cranks: [{ name: 'Boxer', pins: [0, 240, 120, 180, 60, 300], orders: [[1, 6, 2, 4, 3, 5]] }] },
];

export function cylinderOptions(kind: LayoutKind): number[] {
  return LAYOUTS.filter((l) => l.kind === kind).map((l) => l.cylinders);
}

export function findLayout(kind: LayoutKind, cylinders: number): LayoutDef {
  const same = LAYOUTS.filter((l) => l.kind === kind);
  return same.find((l) => l.cylinders === cylinders) ?? same[0];
}

export interface ResolvedLayout {
  def: LayoutDef;
  crank: CrankDef;
  n: number;
  bankAngle: number;
  /** Cylinder axis angle from vertical, degrees. */
  beta: number[];
  pins: number[];
  /** Firing TDC of each cylinder on the 720-degree cycle. */
  fire: number[];
  /** Cylinder indices (0-based) in firing sequence. */
  order: number[];
  /** Crank degrees between successive firings (sums to 720). */
  intervals: number[];
  orderLabels: string[];
  orderIndex: number;
  crankIndex: number;
  /** Exhaust grouping: by bank, or alternate firing positions for inline engines. */
  group: number[];
}

const mod = (a: number, m: number) => ((a % m) + m) % m;

/** Firing angles for an explicit order, or null if it does not fit in one cycle. */
export function fireAnglesForOrder(tdc: number[], order: number[]): number[] | null {
  const fire = new Array<number>(tdc.length).fill(0);
  let prev = mod(tdc[order[0]], 360);
  fire[order[0]] = prev;
  const start = prev;
  for (let k = 1; k < order.length; k++) {
    const c = order[k];
    let a = mod(tdc[c], 360);
    while (a < prev - 1e-9) a += 360;
    fire[c] = a;
    prev = a;
  }
  if (prev - start >= 720 - 1e-9) return null;
  return fire;
}

/** Most even assignment of firing TDCs, by brute force over the 2^(n-1) choices. */
export function mostEvenFireAngles(tdc: number[]): number[] {
  const n = tdc.length;
  const base = tdc.map((t) => mod(t, 360));
  let best: number[] = base.slice();
  let bestCost = Infinity;
  const combos = 1 << Math.max(0, n - 1);
  const ideal = 720 / n;
  for (let bits = 0; bits < combos; bits++) {
    const f = base.map((t, i) => (i > 0 && (bits >> (i - 1)) & 1 ? t + 360 : t));
    const sorted = f.slice().sort((a, b) => a - b);
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const gap = (i + 1 < n ? sorted[i + 1] : sorted[0] + 720) - sorted[i];
      cost += (gap - ideal) * (gap - ideal);
    }
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = f;
    }
  }
  return best;
}

export function resolveLayout(kind: LayoutKind, cylinders: number, bankAngle: number, crankIndex: number, orderIndex: number, twoStroke = false): ResolvedLayout {
  const def = findLayout(kind, cylinders);
  const n = def.cylinders;
  const ci = Math.min(Math.max(0, crankIndex | 0), def.cranks.length - 1);
  const crank = def.cranks[ci];
  const ba = def.kind === 'flat' ? 180 : def.kind === 'v' ? bankAngle : 0;
  const beta = def.bank.map((b) => (b * ba) / 2);
  const tdc = crank.pins.map((a, i) => a - beta[i]);

  if (twoStroke) {
    // Every cylinder fires at each of its TDCs: the order follows from the crank alone.
    const t0 = mod(tdc[0], 360);
    const rel = tdc.map((t) => mod(t - t0, 360));
    const ord = seq(n).sort((a, b) => rel[a] - rel[b] || a - b);
    const intervals = ord.map((c, i) => (i + 1 < n ? rel[ord[i + 1]] : 360) - rel[c]);
    return {
      def, crank, n, bankAngle: ba, beta, pins: crank.pins.slice(), fire: rel.map((a) => mod(a + t0, 360)), order: ord, intervals,
      orderLabels: [ord.map((c) => c + 1).join('-')], orderIndex: 0, crankIndex: ci, group: seq(n),
    };
  }

  const candidates: number[][] = [];
  for (const o of crank.orders) {
    const f = fireAnglesForOrder(tdc, o.map((c) => c - 1));
    if (f) candidates.push(f);
  }
  if (candidates.length === 0) candidates.push(mostEvenFireAngles(tdc));
  const oi = Math.min(Math.max(0, orderIndex | 0), candidates.length - 1);

  const describe = (f: number[]) => {
    const t0 = f[0];
    const rel = f.map((a) => mod(a - t0, 720));
    const ord = seq(n).sort((a, b) => rel[a] - rel[b] || a - b);
    return { rel, ord };
  };
  const { rel, ord } = describe(candidates[oi]);
  const intervals = ord.map((c, i) => (i + 1 < n ? rel[ord[i + 1]] : 720) - rel[c]);
  // Shift so cylinder 1 fires at its own geometric TDC angle on the global crank.
  const fire = rel.map((a) => mod(a + mod(tdc[0], 360), 720));

  let group: number[];
  if (def.kind === 'v' || def.kind === 'flat') {
    group = def.bank.map((b) => (b > 0 ? 1 : 0));
  } else {
    group = new Array(n).fill(0);
    ord.forEach((c, i) => (group[c] = i % 2));
  }

  return {
    def, crank, n, bankAngle: ba, beta, pins: crank.pins.slice(), fire, order: ord, intervals,
    orderLabels: candidates.map((f) => describe(f).ord.map((c) => c + 1).join('-')),
    orderIndex: oi, crankIndex: ci, group,
  };
}
