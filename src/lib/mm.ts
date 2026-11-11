import type { Config } from './config';
import { feePerShare } from './polymarket';
import type { Asset, MmFill, MmState, Side, WindowRec } from './types';

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
  book.net += takerSells ? filled : -filled;
  book.cash += takerSells ? -filled * order.price : filled * order.price;
  // The taker paid the fee; a fifth of it comes back to the maker as a reward.
  const rebate = cfg.mmRebate * feePerShare(order.price, win.feeRate, win.feeExp) * filled;
  mm.rewards += rebate;
  mm.fills++;
  mm.volume += filled * order.price;
  mm.recent.unshift({ t: now, asset: q.asset, side: takerSells ? 'buy' : 'sell', price: order.price, shares: Math.round(filled * 100) / 100, candle: q.candle, rebate });
  if (mm.recent.length > 40) mm.recent.length = 40;
}

/** The market is over: whatever inventory is left pays 1 per Up share if Up won, 0 otherwise. */
export function settleMm(mm: MmState, key: string, outcome: Side | 'void', now: number): void {
  const book = mm.books[key];
  if (!book) return;
  delete mm.books[key];
  mm.pnl += book.cash + book.net * (outcome === 'up' ? 1 : outcome === 'down' ? 0 : 0.5);
  mm.markets++;
  mm.equity.push([Math.round(now), Math.round((mm.pnl + mm.rewards) * 100) / 100]);
  if (mm.equity.length > 1500) mm.equity.splice(0, mm.equity.length - 1500);
}
