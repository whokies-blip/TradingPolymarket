import { clamp, round } from './math';
import { fairProb, type Features } from './model';
import { feePerShare } from './polymarket';
import type { Family, Genes, Side, Stats, Strategy } from './types';

export const FAMILY_LABEL: Record<Family, string> = {
  lag: 'Retard d’ETH sur BTC',
  fair: 'Juste valeur',
  learned: 'Modèle appris',
};

/** How far back (seconds) the engine measures BTC's push. A strategy uses the nearest one. */
export const LEAD_WINDOWS = [5, 10, 20, 40];

const BOUNDS: Record<Exclude<keyof Genes, 'family'>, [number, number]> = {
  minEdge: [0.02, 0.25],
  minElapsed: [0, 200],
  maxElapsed: [30, 240],
  volMult: [0.7, 1.6],
  minPrice: [0.03, 0.5],
  maxPrice: [0.5, 0.97],
  lead: [0.01, 0.15],
  leadWindow: [5, 40],
  takeProfit: [0, 0.4],
  stopMove: [0, 0.4],
  maxHold: [0, 180],
};

export const emptyStats = (): Stats => ({ n: 0, wins: 0, signals: 0, sum: 0, sumSq: 0, sumCost: 0, ewN: 0, ew: 0 });

function normalise(g: Genes): Genes {
  const out = { ...g };
  for (const key of Object.keys(BOUNDS) as (keyof typeof BOUNDS)[]) {
    out[key] = round(clamp(out[key], BOUNDS[key][0], BOUNDS[key][1]), 3);
  }
  out.minElapsed = Math.round(out.minElapsed);
  out.maxElapsed = Math.round(Math.max(out.maxElapsed, out.minElapsed + 30));
  // Snap to a window the engine actually measures.
  // Tiny targets or stops are pure noise next to the cost of a round trip: treat them as "off".
  if (out.takeProfit < 0.03) out.takeProfit = 0;
  if (out.stopMove < 0.03) out.stopMove = 0;
  out.maxHold = out.maxHold < 5 ? 0 : Math.round(out.maxHold);
  out.leadWindow = LEAD_WINDOWS.reduce((best, w) => (Math.abs(w - out.leadWindow) < Math.abs(best - out.leadWindow) ? w : best));
  return out;
}

export const genome = (family: Family, over: Partial<Genes> = {}): Genes =>
  normalise({ family, minEdge: 0.07, minElapsed: 10, maxElapsed: 235, volMult: 1, minPrice: 0.05, maxPrice: 0.95, lead: 0.03, leadWindow: 10, takeProfit: 0.1, stopMove: 0.1, maxHold: 60, ...over });

/**
 * The starting line-up: 24 variants of one idea, "ETH is late on BTC".
 *
 * Measured on 1,152 real ETH markets: buying ETH when its Polymarket price is below its own fair
 * value AND BTC has just pushed the same way earned +8¢ to +17¢ per share at prices last seen
 * (+1¢ to +13¢ assuming the price must survive a moment), and beat "ETH alone" at every threshold.
 * What did NOT work: hedging with the opposite bet on BTC (−1¢ to −5¢, the hedge only costs fees),
 * and betting on ETH catching up with BTC regardless of ETH's own price (no edge).
 */
export function seedGenomes(): Genes[] {
  const out: Genes[] = [];
  // How to get out. On the same 4 days, holding to the end earned about +1¢ per share with ±45¢
  // swings (indistinguishable from luck), while taking +10% and cutting when the price falls 10%
  // earned +2.5¢ to +4.4¢ with ±13¢ swings, held ~15 s. The last one is the control.
  const exits: Partial<Genes>[] = [
    { takeProfit: 0.1, stopMove: 0.1, maxHold: 60 },
    { takeProfit: 0.1, stopMove: 0, maxHold: 60 },
    { takeProfit: 0.05, stopMove: 0.1, maxHold: 30 },
    { takeProfit: 0, stopMove: 0, maxHold: 0 },
  ];
  for (const minEdge of [0.04, 0.07, 0.1]) {
    for (const lead of [0.03, 0.05]) {
      for (const exit of exits) out.push(genome('lag', { minEdge, lead, leadWindow: 10, ...exit }));
    }
  }
  return out;
}

export function randomGenome(rand: () => number): Genes {
  const g = genome('lag');
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
  /** BTC's push that triggered the trade, in probability points (lag strategies only). */
  lead?: number;
}

/** A strategy's probability that the window ends Up. */
export function probUp(g: Genes, f: Features, qModel: number | null): number | null {
  return g.family === 'learned' ? qModel : fairProb(f.z, g.volMult);
}

export function evaluate(g: Genes, f: Features, quote: Quote, qModel: number | null): Signal | null {
  if (f.elapsed < g.minElapsed || f.elapsed > g.maxElapsed) return null;
  // "ETH is late": only on ETH, only when BTC has just pushed, and only in the direction of the push.
  const lead = g.family === 'lag' ? f.lead?.[g.leadWindow] : undefined;
  if (g.family === 'lag' && (lead === undefined || Math.abs(lead) < g.lead)) return null;
  const p = probUp(g, f, qModel);
  if (p === null) return null;
  let best: Signal | null = null;
  for (const side of ['up', 'down'] as Side[]) {
    if (lead !== undefined && (side === 'up') !== lead > 0) continue;
    const ask = side === 'up' ? quote.askUp : quote.askDown;
    if (ask === null || ask < g.minPrice || ask > g.maxPrice) continue;
    const q = side === 'up' ? p : 1 - p;
    const edge = q - ask - feePerShare(ask, quote.feeRate, quote.feeExp);
    if (edge >= g.minEdge && (!best || edge > best.edge)) best = { side, q, ask, edge, lead };
  }
  return best;
}

// ---------------------------------------------------------------- scoring

/** Record one filled trade: `pnl` is profit per share (payout − all-in cost). */
export function record(stats: Stats, pnl: number, cost: number, decay: number): void {
  stats.n++;
  if (pnl > 0) stats.wins++;
  stats.sum += pnl;
  stats.sumSq += pnl * pnl;
  stats.sumCost += cost;
  stats.ewN = stats.ewN * decay + 1;
  stats.ew = stats.ew * decay + pnl;
}

export interface Score {
  /** Average profit per share since the strategy was born. */
  mean: number;
  se: number;
  /** How many standard errors the average is away from zero. */
  tstat: number;
  /** Average over roughly the last 100 trades. */
  recent: number;
  /** Profit per dollar staked. */
  roi: number;
}

export function score(s: Stats): Score {
  if (s.n < 2) return { mean: 0, se: Infinity, tstat: 0, recent: 0, roi: 0 };
  const mean = s.sum / s.n;
  const variance = Math.max(s.sumSq / s.n - mean * mean, 1e-4);
  const se = Math.sqrt(variance / s.n);
  return { mean, se, tstat: mean / se, recent: s.ewN > 0 ? s.ew / s.ewN : 0, roi: s.sumCost > 0 ? s.sum / s.sumCost : 0 };
}

/**
 * A champion must have a record that is unlikely to be luck (t ≥ z over its whole life)
 * and must not be losing lately. Otherwise null: the system stays flat.
 *
 * Replayed on 1,152 real markets, the previous rule ("15 trades and a positive average")
 * crowned a lucky strategy 89% of the time and lost 45% of the demo bankroll.
 */
export function pickChampion(pop: Strategy[], current: string | null, minTrades: number, z: number): string | null {
  const lcb = (s: Strategy) => {
    const sc = score(s.stats);
    return sc.mean - z * sc.se;
  };
  const ok = pop.filter((s) => {
    const sc = score(s.stats);
    return s.stats.n >= minTrades && sc.tstat >= z && sc.recent > 0;
  });
  if (ok.length === 0) return null;
  ok.sort((a, b) => lcb(b) - lcb(a));
  const cur = ok.find((s) => s.id === current);
  // Hysteresis: only dethrone the champion for a clearly better challenger.
  if (cur && lcb(ok[0]) < lcb(cur) + 0.01) return cur.id;
  return ok[0].id;
}

export interface EvolveResult {
  population: Strategy[];
  removed: Strategy[];
  added: Strategy[];
}

/**
 * One generation: retire strategies that are clearly losing (or never trade) and replace them with
 * mutated copies of the best performers, plus some fresh blood. Deliberately slow: every replacement
 * throws away evidence, and it takes hundreds of trades to tell a few cents of edge from luck.
 */
export function evolve(pop: Strategy[], generation: number, windowCount: number, championId: string | null, rand: () => number, now: number): EvolveResult {
  const maxReplace = Math.max(1, Math.floor(pop.length / 8));
  const scored = pop.map((s) => ({ s, sc: score(s.stats) }));
  const idle = (s: Strategy) => s.stats.n < 3 && windowCount - s.bornWindow > 400;
  const losers = scored
    .filter(({ s, sc }) => s.id !== championId && ((s.stats.n >= 60 && sc.tstat < -1) || idle(s)))
    .sort((a, b) => (idle(a.s) ? -99 : a.sc.tstat) - (idle(b.s) ? -99 : b.sc.tstat))
    .slice(0, maxReplace)
    .map((x) => x.s);
  if (losers.length === 0) return { population: pop, removed: [], added: [] };
  const parents = scored
    .filter(({ s }) => s.stats.n >= 20 && !losers.includes(s))
    .sort((a, b) => b.sc.tstat - a.sc.tstat)
    .slice(0, 5)
    .map((x) => x.s);
  const added: Strategy[] = losers.map((_, i) => {
    const fresh = parents.length === 0 || rand() < 0.34;
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

export const exitsEarly = (g: Genes) => g.takeProfit > 0 || g.stopMove > 0 || g.maxHold > 0;

export function describeExit(g: Genes): string {
  if (!exitsEarly(g)) return 'garde jusqu’à la fin du marché';
  const parts: string[] = [];
  if (g.takeProfit > 0) parts.push(`gain +${Math.round(g.takeProfit * 100)} %`);
  if (g.stopMove > 0) parts.push(`stop si le prix recule de ${Math.round(g.stopMove * 100)} %`);
  if (g.maxHold > 0) parts.push(`${g.maxHold} s max`);
  return `sortie : ${parts.join(' · ')}`;
}

export function describe(g: Genes): string {
  const t = `${g.minElapsed}–${g.maxElapsed}s`;
  const e = `avantage ≥ ${(g.minEdge * 100).toFixed(1)}¢`;
  if (g.family === 'lag') return `ETH sous-évalué d’au moins ${(g.minEdge * 100).toFixed(0)}¢ · BTC a poussé d’au moins ${(g.lead * 100).toFixed(0)} pts en ${g.leadWindow} s · ${describeExit(g)}`;
  return g.family === 'fair' ? `${e}, ${t}, vol ×${g.volMult}` : `${e}, ${t}`;
}
