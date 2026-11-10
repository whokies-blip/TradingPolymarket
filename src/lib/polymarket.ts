import { getJson } from './http';
import type { Asset, Side, WindowRec } from './types';

const GAMMA = 'https://gamma-api.polymarket.com';
export const CLOB = 'https://clob.polymarket.com';

export const slugOf = (asset: Asset, start: number) => `${asset}-updown-5m-${start}`;

interface GammaMarket {
  closed?: boolean;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  negRisk?: boolean;
  acceptingOrders?: boolean;
  feesEnabled?: boolean;
  feeSchedule?: { rate?: number; exponent?: number };
}

async function gammaMarket(slug: string): Promise<GammaMarket | null> {
  const events = await getJson<{ markets?: GammaMarket[] }[]>(`${GAMMA}/events?slug=${slug}`);
  return events?.[0]?.markets?.[0] ?? null;
}

/** Static description of one 5-minute market (tokens, fees, tick size). */
export async function fetchWindow(asset: Asset, start: number): Promise<WindowRec | null> {
  const slug = slugOf(asset, start);
  const m = await gammaMarket(slug);
  if (!m?.clobTokenIds || !m.outcomes) return null;
  const tokens: string[] = JSON.parse(m.clobTokenIds);
  const outcomes: string[] = JSON.parse(m.outcomes);
  const up = outcomes.findIndex((o) => o.toLowerCase() === 'up');
  if (up < 0 || tokens.length !== 2) return null;
  return {
    key: `${asset}-${start}`,
    asset,
    start,
    slug,
    upToken: tokens[up],
    downToken: tokens[1 - up],
    feeRate: m.feesEnabled === false ? 0 : (m.feeSchedule?.rate ?? 0.07),
    feeExp: m.feeSchedule?.exponent ?? 1,
    tickSize: m.orderPriceMinTickSize ?? 0.01,
    minSize: m.orderMinSize ?? 5,
    negRisk: !!m.negRisk,
    shadows: [],
    obs: [],
  };
}

/** Final outcome as published by Polymarket, or null while unresolved. */
export async function fetchOutcome(asset: Asset, start: number): Promise<Side | null> {
  const m = await gammaMarket(slugOf(asset, start));
  if (!m?.closed || !m.outcomePrices || !m.outcomes) return null;
  const prices: string[] = JSON.parse(m.outcomePrices);
  const outcomes: string[] = JSON.parse(m.outcomes);
  const winner = prices.findIndex((p) => Number(p) === 1);
  if (winner < 0) return null;
  return outcomes[winner].toLowerCase() === 'up' ? 'up' : 'down';
}

export interface Level {
  price: number;
  size: number;
}
export interface Book {
  /** Ascending by price: asks[0] is the best ask. */
  asks: Level[];
  /** Descending by price: bids[0] is the best bid. */
  bids: Level[];
  t: number;
}

export async function fetchBook(tokenId: string): Promise<Book> {
  const raw = await getJson<{ asks?: { price: string; size: string }[]; bids?: { price: string; size: string }[]; timestamp?: string }>(
    `${CLOB}/book?token_id=${tokenId}`,
  );
  const parse = (xs?: { price: string; size: string }[]) =>
    (xs || []).map((x) => ({ price: +x.price, size: +x.size })).filter((x) => x.size > 0 && x.price > 0 && x.price < 1);
  return {
    asks: parse(raw.asks).sort((a, b) => a.price - b.price),
    bids: parse(raw.bids).sort((a, b) => b.price - a.price),
    t: raw.timestamp ? Number(raw.timestamp) / 1000 : Date.now() / 1000,
  };
}

/** Taker fee per share at price p: rate × (p(1−p))^exponent. Peaks at 50¢. */
export const feePerShare = (p: number, rate: number, exp: number) => rate * Math.pow(p * (1 - p), exp);

export interface Fill {
  shares: number;
  /** Average price paid per share, before fees. */
  price: number;
  fee: number;
  cost: number;
  worst: number;
}

/**
 * Simulate a market buy of `usd` dollars by walking the ask side of the book,
 * paying the taker fee at each level. Never pays above `maxPrice`.
 */
export function simulateBuy(asks: Level[], usd: number, rate: number, exp: number, maxPrice = 0.99): Fill | null {
  let left = usd;
  let shares = 0;
  let paid = 0;
  let fee = 0;
  let worst = 0;
  for (const lvl of asks) {
    if (lvl.price > maxPrice || left <= 1e-9) break;
    const f = feePerShare(lvl.price, rate, exp);
    const take = Math.min(lvl.size, left / (lvl.price + f));
    if (take <= 0) continue;
    shares += take;
    paid += take * lvl.price;
    fee += take * f;
    left -= take * (lvl.price + f);
    worst = lvl.price;
  }
  if (shares <= 0) return null;
  return { shares, price: paid / shares, fee, cost: paid + fee, worst };
}

export async function fetchGeoblock(): Promise<{ blocked: boolean; country: string }> {
  const r = await getJson<{ blocked?: boolean; country?: string }>('https://polymarket.com/api/geoblock', 4000);
  return { blocked: !!r.blocked, country: r.country || '?' };
}
