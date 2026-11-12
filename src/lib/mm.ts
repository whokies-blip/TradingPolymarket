import type { Config } from './config';
import { feePerShare } from './polymarket';
import { clamp, round } from './math';
import { emptyStats, score } from './strategies';
import type { Asset, MmDesk, MmFill, MmGenes, MmState, Side, WindowRec } from './types';

export const newMm = (): MmState => ({ pnl: 0, rewards: 0, fills: 0, volume: 0, markets: 0, books: {}, recent: [], equity: [] });

/** One resting order of the desk. `queue` is how many shares were already waiting at that price before us. */
export interface Resting {
  price: number;
  left: number;
  queue: number;
}

export interface Quotes {
  key: string;
  asset: Asset;
  candle: MmFill['candle'];
  bid: Resting | null;
  ask: Resting | null;
  /** Sizes decided at the last candle close, reused when an order is re-posted before the next one. */
  sizes: { bid: number; ask: number };
}

/**
 * Sizes from the last 5-second candle of the spot price: after a green candle the desk bids for twice
 * what it offers, after a red one it offers twice what it bids.
 */
export function quoteSizes(open: number, close: number, base: number): { candle: MmFill['candle']; bid: number; ask: number } {
  if (close > open) return { candle: 'green', bid: 2 * base, ask: base };
  if (close < open) return { candle: 'red', bid: base, ask: 2 * base };
  return { candle: 'flat', bid: base, ask: base };
}

/**
 * Inventory cap: never quote more than what would take the stock past `cap` on that side. At the
 * cap the desk stops bidding for that side altogether and only quotes the side that reduces it.
 * (On 4 days of history a 20-share cap cut the swings from ±28 $ to ±6 $ per market.)
 */
export function capSizes(size: { bid: number; ask: number }, net: number, cap: number): { bid: number; ask: number } {
  return { bid: Math.max(0, Math.min(size.bid, cap - net)), ask: Math.max(0, Math.min(size.ask, cap + net)) };
}

export interface DeskPrices {
  bid: number;
  ask: number;
  /** May we add Up stock at `bid`? May we add Down stock (sell Up) at `ask`? */
  bidAllowed: boolean;
  askAllowed: boolean;
}

/**
 * Prices a desk quotes, given the best bid and ask and the recent 5-second move of the price (`vol`):
 *  - both quotes are moved away from the best prices by `widen` × vol (rounded up to the cent): wider when
 *    the market is agitated, at the best prices when it is calm;
 *  - stock we hold is only sold at least `minGain` above its average cost;
 *  - new stock is only bought when the bet costs between `minPrice` and `maxPrice`;
 *  - reducing a position is never blocked by the price band.
 */
export function deskPrices(top: { bid: number; ask: number }, book: { net: number; avg?: number } | undefined, g: MmGenes, vol = 0): DeskPrices {
  const net = book?.net ?? 0;
  const avg = book?.avg ?? 0;
  const w = Math.ceil(g.widen * vol * 100 - 1e-9) / 100;
  let bid = round(top.bid - w, 2);
  let ask = round(top.ask + w, 2);
  if (g.minGain > 0 && avg > 0) {
    if (net > 0) ask = Math.max(ask, Math.ceil(avg * (1 + g.minGain) * 100 - 1e-9) / 100);
    if (net < 0) bid = Math.min(bid, Math.floor((1 - avg * (1 + g.minGain)) * 100 + 1e-9) / 100);
  }
  const inBand = (p: number) => p >= g.minPrice && p <= g.maxPrice;
  return {
    bid,
    ask,
    bidAllowed: bid > 0.01 && (net < 0 || inBand(bid)),
    askAllowed: ask < 0.99 && (net > 0 || inBand(1 - ask)),
  };
}

// ---------------------------------------------------------------- self-improving desks

const GENE_BOUNDS: Record<keyof MmGenes, [number, number]> = { minPrice: [0.2, 0.5], maxPrice: [0.7, 0.95], minGain: [0, 0.3], widen: [0, 3] };

function normaliseGenes(g: MmGenes): MmGenes {
  const out = { ...g };
  for (const k of Object.keys(GENE_BOUNDS) as (keyof MmGenes)[]) out[k] = round(clamp(out[k], GENE_BOUNDS[k][0], GENE_BOUNDS[k][1]), 2);
  out.maxPrice = Math.max(out.maxPrice, round(out.minPrice + 0.2, 2));
  return out;
}

/**
 * Starting line-up, from a search over 360 settings on 4 days of history (tuned on the first half,
 * checked on the second). The best BTC settings broke even (≈ 0 $ per market): buy only between
 * 40¢ and 80–85¢, sell stock only 20% above cost, quote 2× the recent move away from the best prices.
 * d0 is the user's own setting (35–90¢, +5%, at the best prices): −2 $ per market on the same data.
 */
export function seedDesks(now: number): MmDesk[] {
  const seeds: MmGenes[] = [
    { minPrice: 0.35, maxPrice: 0.9, minGain: 0.05, widen: 0 },
    { minPrice: 0.4, maxPrice: 0.8, minGain: 0.2, widen: 2 },
    { minPrice: 0.4, maxPrice: 0.85, minGain: 0.2, widen: 2 },
    { minPrice: 0.4, maxPrice: 0.9, minGain: 0.2, widen: 0 },
    { minPrice: 0.45, maxPrice: 0.85, minGain: 0.08, widen: 2 },
    { minPrice: 0.3, maxPrice: 0.85, minGain: 0.12, widen: 1 },
    { minPrice: 0.4, maxPrice: 0.85, minGain: 0.12, widen: 1 },
    { minPrice: 0.35, maxPrice: 0.9, minGain: 0.2, widen: 1 },
  ];
  return seeds.map((genes, i) => ({ id: `d${i}`, gen: 0, genes: normaliseGenes(genes), mm: newMm(), stats: emptyStats(), bornAt: now }));
}

/** Desk currently doing best: highest average per market minus one standard error, after 10 markets. */
export function deskLeader(desks: MmDesk[]): MmDesk | null {
  const ok = desks.filter((d) => d.stats.n >= 10);
  if (!ok.length) return desks.length ? [...desks].sort((a, b) => b.stats.n - a.stats.n || (score(b.stats).mean - score(a.stats).mean))[0] : null;
  const lcb = (d: MmDesk) => score(d.stats).mean - (Number.isFinite(score(d.stats).se) ? score(d.stats).se : 0);
  return [...ok].sort((a, b) => lcb(b) - lcb(a))[0];
}

/**
 * One generation: the desk with the worst average (after enough markets) is replaced by a slightly
 * changed copy of the leader. Called about once an hour.
 */
export function evolveDesks(desks: MmDesk[], generation: number, rand: () => number, now: number, minMarkets = 20): { removed: MmDesk; added: MmDesk } | null {
  const ripe = desks.filter((d) => d.stats.n >= minMarkets);
  if (ripe.length < 2) return null;
  const leader = deskLeader(desks)!;
  const worst = [...ripe].sort((a, b) => score(a.stats).mean - score(b.stats).mean)[0];
  if (worst.id === leader.id || score(worst.stats).mean >= score(leader.stats).mean) return null;
  const genes = { ...leader.genes };
  for (const k of Object.keys(GENE_BOUNDS) as (keyof MmGenes)[]) {
    if (rand() < 0.6) genes[k] += (rand() - 0.5) * 0.3 * (GENE_BOUNDS[k][1] - GENE_BOUNDS[k][0]);
  }
  const added: MmDesk = { id: `d${generation}-${Math.floor(rand() * 1000)}`, gen: generation, parent: leader.id, genes: normaliseGenes(genes), mm: newMm(), stats: emptyStats(), bornAt: now };
  desks.splice(desks.indexOf(worst), 1, added);
  return { removed: worst, added };
}

/** Standard deviation of 1-second changes of the price over the last samples, scaled to `seconds`. */
export function recentMove(mids: number[], seconds: number): number {
  if (mids.length < 10) return 0;
  const d: number[] = [];
  for (let i = 1; i < mids.length; i++) d.push(mids[i] - mids[i - 1]);
  const m = d.reduce((s, x) => s + x, 0) / d.length;
  const v = d.reduce((s, x) => s + (x - m) ** 2, 0) / d.length;
  return Math.sqrt(v * seconds);
}

/**
 * A trade happened in the market. `upPrice` is its price in "Up" terms and `takerSells` says whether
 * the aggressor sold Up (hitting bids) or bought Up (lifting asks). Our order fills if the trade goes
 * through our price, or reaches us after the shares that were queued ahead of us at the same price.
 */
export function onTrade(mm: MmState, cfg: Config, q: Quotes, win: WindowRec, upPrice: number, size: number, takerSells: boolean, now: number): void {
  const order = takerSells ? q.bid : q.ask;
  if (!order || order.left <= 0) return;
  const through = takerSells ? upPrice < order.price - 1e-9 : upPrice > order.price + 1e-9;
  const at = Math.abs(upPrice - order.price) < 1e-9;
  let filled = 0;
  if (through) filled = order.left;
  else if (at) {
    const reachesUs = size - order.queue;
    order.queue = Math.max(0, order.queue - size);
    if (reachesUs > 0) filled = Math.min(order.left, reachesUs);
  }
  if (filled <= 0) return;
  order.left -= filled;
  const book = (mm.books[q.key] ??= { net: 0, cash: 0 });
  // Average price paid for the side we hold (Up shares at their price, Down shares at 1 − price).
  const before = book.net;
  const own = takerSells ? order.price : 1 - order.price;
  const added = takerSells ? filled : -filled;
  if (before * added >= 0) book.avg = ((Math.abs(before) * (book.avg ?? own)) + filled * own) / (Math.abs(before) + filled);
  else if ((before + added) * added > 0) book.avg = own;
  book.net += takerSells ? filled : -filled;
  book.cash += takerSells ? -filled * order.price : filled * order.price;
  // The taker paid the fee; a fifth of it comes back to the maker as a reward.
  const rebate = cfg.mmRebate * feePerShare(order.price, win.feeRate, win.feeExp) * filled;
  mm.rewards += rebate;
  book.rew = (book.rew ?? 0) + rebate;
  mm.fills++;
  mm.volume += filled * order.price;
  mm.recent.unshift({ t: now, asset: q.asset, side: takerSells ? 'buy' : 'sell', price: order.price, shares: Math.round(filled * 100) / 100, candle: q.candle, rebate });
  if (mm.recent.length > 40) mm.recent.length = 40;
}

/** The market is over: whatever inventory is left pays 1 per Up share if Up won, 0 otherwise. */
export function settleMm(mm: MmState, key: string, outcome: Side | 'void', now: number): number {
  const book = mm.books[key];
  if (!book) return 0;
  delete mm.books[key];
  const trading = book.cash + book.net * (outcome === 'up' ? 1 : outcome === 'down' ? 0 : 0.5);
  mm.pnl += trading;
  mm.markets++;
  mm.equity.push([Math.round(now), Math.round((mm.pnl + mm.rewards) * 100) / 100]);
  if (mm.equity.length > 1500) mm.equity.splice(0, mm.equity.length - 1500);
  return trading + (book.rew ?? 0);
}
