import { clamp, round } from './math';
import { fairProb, type Features } from './model';
import { feePerShare } from './polymarket';
import type { Family, Genes, Side, Stats, Strategy } from './types';

export const FAMILIES: Family[] = ['fair', 'learned', 'momentum', 'reversion', 'follow'];

export const FAMILY_LABEL: Record<Family, string> = {
  fair: 'Juste valeur',
  learned: 'Modèle appris',
  momentum: 'Momentum',
  reversion: 'Retour à la moyenne',
  follow: 'Suivi du favori',
};

const BOUNDS: Record<Exclude<keyof Genes, 'family'>, [number, number]> = {
  minEdge: [0.01, 0.2],
  minElapsed: [0, 240],
  maxElapsed: [30, 285],
  volMult: [0.6, 1.8],
  minPrice: [0.03, 0.9],
  maxPrice: [0.5, 0.97],
  k: [0.01, 0.15],
  lookback: [30, 900],
};

export const emptyStats = (): Stats => ({ n: 0, wins: 0, sumRoi: 0, sumSq: 0, ewN: 0, ewRoi: 0, ewSq: 0 });

function normalise(g: Genes): Genes {
  const out = { ...g };
  for (const key of Object.keys(BOUNDS) as (keyof typeof BOUNDS)[]) {
    out[key] = round(clamp(out[key], BOUNDS[key][0], BOUNDS[key][1]), 3);
  }
  out.minElapsed = Math.round(out.minElapsed);
  out.maxElapsed = Math.round(Math.max(out.maxElapsed, out.minElapsed + 30));
  out.lookback = Math.round(out.lookback);
  out.maxPrice = Math.max(out.maxPrice, Math.min(0.97, out.minPrice + 0.05));
  return out;
}

const base = (family: Family, over: Partial<Genes> = {}): Genes =>
  normalise({ family, minEdge: 0.05, minElapsed: 20, maxElapsed: 240, volMult: 1, minPrice: 0.08, maxPrice: 0.92, k: 0.05, lookback: 300, ...over });

/** The starting line-up: a spread of sensible settings in each family. */
export function seedGenomes(): Genes[] {
  const out: Genes[] = [];
  for (const minEdge of [0.03, 0.06, 0.1, 0.15]) {
    out.push(base('fair', { minEdge, minElapsed: 20, maxElapsed: 150 }));
    out.push(base('fair', { minEdge, minElapsed: 120, maxElapsed: 270, volMult: 1.15 }));
  }
  for (const minEdge of [0.03, 0.05, 0.08, 0.12]) out.push(base('learned', { minEdge, maxElapsed: 270 }));
  for (const [k, lookback] of [[0.04, 60], [0.06, 300], [0.08, 900], [0.1, 300]]) {
    out.push(base('momentum', { k, lookback, minEdge: 0.02, minElapsed: 0, maxElapsed: 90, minPrice: 0.3, maxPrice: 0.7 }));
    out.push(base('reversion', { k, lookback, minEdge: 0.02, minElapsed: 0, maxElapsed: 90, minPrice: 0.3, maxPrice: 0.7 }));
  }
  for (const [k, minPrice] of [[0.04, 0.6], [0.06, 0.75], [0.05, 0.85], [0.08, 0.7]]) {
    out.push(base('follow', { k, minPrice, maxPrice: 0.97, minEdge: 0.01, minElapsed: 120, maxElapsed: 280 }));
  }
  return out;
}

export function randomGenome(rand: () => number): Genes {
  const family = FAMILIES[Math.floor(rand() * FAMILIES.length)];
  const g = base(family);
  for (const key of Object.keys(BOUNDS) as (keyof typeof BOUNDS)[]) {
    const [lo, hi] = BOUNDS[key];
    g[key] = lo + rand() * (hi - lo);
  }
  return normalise(g);
}

/** Small random changes to a winner's settings. */
export function mutate(g: Genes, rand: () => number): Genes {
  const out = { ...g };
  for (const key of Object.keys(BOUNDS) as (keyof typeof BOUNDS)[]) {
    if (rand() < 0.5) {
      const [lo, hi] = BOUNDS[key];
      out[key] += (rand() - 0.5) * 0.3 * (hi - lo);
    }
  }
  return normalise(out);
}

export interface Quote {
  askUp: number | null;
  askDown: number | null;
  /** The market's own probability of Up. */
  mid: number;
  feeRate: number;
  feeExp: number;
}

export interface Signal {
  side: Side;
  /** Strategy's probability that `side` wins. */
  q: number;
  ask: number;
  /** q − (ask + fee): expected profit per share. */
  edge: number;
}

/** A strategy's probability that the window ends Up. */
export function probUp(g: Genes, f: Features, mid: number, qModel: number | null): number | null {
  switch (g.family) {
    case 'fair':
      return fairProb(f.z, g.volMult);
    case 'learned':
      return qModel;
    case 'momentum':
    case 'reversion': {
      const m = g.lookback <= 120 ? f.mom60 : g.lookback <= 600 ? f.mom300 : f.mom900;
      const tilt = g.k * Math.tanh(m) * (g.family === 'momentum' ? 1 : -1);
      return clamp(mid + tilt, 0.01, 0.99);
    }
    case 'follow':
      // Bets that favourites are under-priced (favourite/long-shot bias).
      return clamp(mid + g.k * Math.sign(mid - 0.5), 0.01, 0.99);
  }
}

export function evaluate(g: Genes, f: Features, quote: Quote, qModel: number | null): Signal | null {
  if (f.elapsed < g.minElapsed || f.elapsed > g.maxElapsed) return null;
  const p = probUp(g, f, quote.mid, qModel);
  if (p === null) return null;
  let best: Signal | null = null;
  for (const side of ['up', 'down'] as Side[]) {
    const ask = side === 'up' ? quote.askUp : quote.askDown;
    if (ask === null || ask < g.minPrice || ask > g.maxPrice) continue;
    const q = side === 'up' ? p : 1 - p;
    const edge = q - ask - feePerShare(ask, quote.feeRate, quote.feeExp);
    if (edge >= g.minEdge && (!best || edge > best.edge)) best = { side, q, ask, edge };
  }
  return best;
}

// ---------------------------------------------------------------- scoring

export function record(stats: Stats, roi: number, decay: number): void {
  stats.n++;
  if (roi > 0) stats.wins++;
  stats.sumRoi += roi;
  stats.sumSq += roi * roi;
  stats.ewN = stats.ewN * decay + 1;
  stats.ewRoi = stats.ewRoi * decay + roi;
  stats.ewSq = stats.ewSq * decay + roi * roi;
}

export interface Score {
  mean: number;
  se: number;
  /** Pessimistic estimate: mean − 1 standard error. */
  lcb: number;
  tstat: number;
}

export function score(s: Stats): Score {
  if (s.ewN < 2) return { mean: 0, se: Infinity, lcb: -Infinity, tstat: 0 };
  const mean = s.ewRoi / s.ewN;
  const variance = Math.max(s.ewSq / s.ewN - mean * mean, 1e-6);
  const se = Math.sqrt(variance / Math.min(s.ewN, s.n));
  return { mean, se, lcb: mean - se, tstat: mean / se };
}

/** Best strategy with enough evidence and a positive record; null means "stay flat". */
export function pickChampion(pop: Strategy[], current: string | null, minTrades: number): string | null {
  const ok = pop.filter((s) => s.stats.n >= minTrades && score(s.stats).mean > 0);
  if (ok.length === 0) return null;
  ok.sort((a, b) => score(b.stats).lcb - score(a.stats).lcb);
  const cur = ok.find((s) => s.id === current);
  // Hysteresis: only dethrone the champion for a clearly better challenger.
  if (cur && score(ok[0].stats).lcb < score(cur.stats).lcb + 0.02) return cur.id;
  return ok[0].id;
}

export interface EvolveResult {
  population: Strategy[];
  removed: Strategy[];
  added: Strategy[];
}

/**
 * One generation: retire proven losers and strategies that never trade,
 * replace them with mutated copies of the best performers (plus some fresh blood).
 */
export function evolve(pop: Strategy[], generation: number, windowCount: number, championId: string | null, rand: () => number, now: number): EvolveResult {
  const maxReplace = Math.max(1, Math.floor(pop.length / 4));
  const scored = pop.map((s) => ({ s, sc: score(s.stats) }));
  const losers = scored
    .filter(({ s, sc }) => s.id !== championId && ((s.stats.n >= 25 && sc.mean < 0) || (s.stats.n < 3 && windowCount - s.bornWindow > 400)))
    .sort((a, b) => (a.s.stats.n < 3 ? -1 : a.sc.mean) - (b.s.stats.n < 3 ? -1 : b.sc.mean))
    .slice(0, maxReplace)
    .map((x) => x.s);
  if (losers.length === 0) return { population: pop, removed: [], added: [] };
  const parents = scored
    .filter(({ s }) => s.stats.n >= 10 && !losers.includes(s))
    .sort((a, b) => b.sc.lcb - a.sc.lcb)
    .slice(0, 5)
    .map((x) => x.s);
  const added: Strategy[] = losers.map((_, i) => {
    const fresh = parents.length === 0 || rand() < 0.25;
    const parent = fresh ? undefined : parents[Math.floor(rand() * rand() * parents.length)];
    return {
      id: `g${generation}-${i}`,
      gen: generation,
      parent: parent?.id,
      genes: parent ? mutate(parent.genes, rand) : randomGenome(rand),
      stats: emptyStats(),
      bornAt: now,
      bornWindow: windowCount,
    };
  });
  return { population: pop.filter((s) => !losers.includes(s)).concat(added), removed: losers, added };
}

export function describe(g: Genes): string {
  const t = `${g.minElapsed}–${g.maxElapsed}s`;
  const e = `avantage ≥ ${(g.minEdge * 100).toFixed(1)}¢`;
  switch (g.family) {
    case 'fair':
      return `${e}, ${t}, vol ×${g.volMult}`;
    case 'learned':
      return `${e}, ${t}`;
    case 'momentum':
    case 'reversion':
      return `${e}, ${t}, biais ${(g.k * 100).toFixed(0)}¢ sur ${g.lookback}s`;
    case 'follow':
      return `${e}, ${t}, favori ≥ ${(g.minPrice * 100).toFixed(0)}¢, biais ${(g.k * 100).toFixed(0)}¢`;
  }
}
