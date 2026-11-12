import type { Config } from './config';
import { round } from './math';
import { deskLeader, deskPrices } from './mm';
import { score } from './strategies';
import type { GateCheck, MmDesk, MmGenes, MmLiveBook, MmLiveOrder, MmLiveState, Side, State, WindowRec } from './types';

/**
 * Production market making: the settings of one simulated desk, applied with real limit orders.
 *
 * Every order is post-only (it can never pay the taker fee) and expires on its own two minutes after it
 * was placed, so a crashed or stopped engine never leaves orders behind for long. Sizes are small and
 * hard limits apply: worst-case loss per market, loss per day, kill switch, manual arming, and a record
 * the desk must first have earned in simulation.
 */

/** What the engine needs from the exchange. The real one is in live.ts; tests use a fake. */
export interface Exchange {
  place(o: { tokenId: string; side: 'BUY' | 'SELL'; price: number; size: number; tickSize: number; negRisk: boolean; expiresAt: number }): Promise<{ ok: boolean; id?: string; error?: string }>;
  /** Shares filled so far and whether the order still rests in the book; null if unknown. */
  status(id: string): Promise<{ matched: number; open: boolean } | null>;
  cancel(ids: string[]): Promise<void>;
}

export const newMmLive = (): MmLiveState => ({ orders: [], books: {}, pnl: 0, day: 0, dayPnl: 0, markets: 0, fills: [], equity: [], lastPollAt: 0, lastCandle: 0, dirty: false });

const emptyBook = (): MmLiveBook => ({ up: 0, down: 0, cost: 0, avgUp: 0, avgDown: 0 });
const dayOf = (t: number) => Math.floor(t / 86400);

/** What the market could still cost us at settlement: cash spent minus what the side that loses pays. */
export function worstLoss(b: MmLiveBook): number {
  return b.cost - Math.min(b.up, b.down);
}

/** Value of the shares at the market mid, minus what they cost. */
export function unrealized(b: MmLiveBook, upMid: number): number {
  return b.up * upMid + b.down * (1 - upMid) - b.cost;
}

export function liveDesk(state: State, cfg: Config): MmDesk | null {
  return (cfg.mmLiveDesk && state.desks.find((d) => d.id === cfg.mmLiveDesk)) || deskLeader(state.desks);
}

/** Every condition that must hold before a real order is placed. */
export function mmLiveGate(state: State, cfg: Config, keyOk: boolean, now: number, upMid: number | null): GateCheck[] {
  const L = state.mmLive;
  const desk = liveDesk(state, cfg);
  const sc = desk ? score(desk.stats) : null;
  const today = L.day === dayOf(now) ? L.dayPnl : 0;
  const open = upMid === null ? 0 : Object.values(L.books).reduce((s, b) => s + unrealized(b, upMid), 0);
  const loss = -(today + open);
  return [
    { id: 'env', label: 'Tenue de marché réelle activée (MM_LIVE)', ok: cfg.mmLive, detail: cfg.mmLive ? 'activée' : 'désactivée' },
    { id: 'keys', label: 'Portefeuille Polymarket configuré', ok: keyOk, detail: keyOk ? 'clé présente' : 'clé absente' },
    { id: 'geo', label: 'Région autorisée par Polymarket', ok: !!state.geo && !state.geo.blocked, detail: state.geo ? `${state.geo.country}${state.geo.blocked ? ' — bloqué' : ''}` : 'non vérifié' },
    { id: 'armed', label: 'Armé depuis le tableau de bord', ok: state.control.liveArmed, detail: state.control.liveArmed ? 'armé' : 'désarmé' },
    { id: 'kill', label: "Arrêt d'urgence inactif", ok: !state.control.killSwitch, detail: state.control.killSwitch ? 'arrêt actif' : 'ok' },
    {
      id: 'proof',
      label: `Bureau prouvé en simulation (≥ ${cfg.mmLiveMinMarkets} marchés, t ≥ ${cfg.mmLiveMinTstat})`,
      ok: !!desk && !!sc && desk.stats.n >= cfg.mmLiveMinMarkets && sc.tstat >= cfg.mmLiveMinTstat,
      detail: desk && sc ? `${desk.id} : ${desk.stats.n} marchés, t = ${Number.isFinite(sc.tstat) ? sc.tstat.toFixed(2) : '—'}` : 'aucun bureau',
    },
    { id: 'loss', label: `Perte du jour < ${cfg.mmLiveMaxDailyLoss} $`, ok: loss < cfg.mmLiveMaxDailyLoss, detail: `${Math.max(0, loss).toFixed(2)} $ perdus aujourd’hui` },
  ];
}

export interface Wanted {
  token: Side;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

/**
 * The orders the desk wants right now, from the same rules as the simulation:
 *  - the "Up side" is a purchase of Up, or, when holding Down, a sale of Down;
 *  - the "Down side" is a purchase of Down, or, when holding Up, a sale of Up;
 *  - purchases respect the stock cap and the worst-case loss per market.
 */
export function wantedOrders(book: MmLiveBook | undefined, g: MmGenes, top: { bid: number; ask: number }, vol: number, sizes: { bid: number; ask: number }, cfg: Config, minSize: number): Wanted[] {
  const b = book ?? emptyBook();
  const net = b.up - b.down;
  const px = deskPrices(top, { net, avg: net > 0 ? b.avgUp : net < 0 ? b.avgDown : 0 }, g, vol);
  const out: Wanted[] = [];
  const room = (price: number, size: number, more: (b: MmLiveBook, s: number) => MmLiveBook) => {
    // Shrink a purchase until the market's worst case stays within the limit.
    let s = size;
    while (s >= minSize && worstLoss(more(b, s)) > cfg.mmLiveMaxExposure) s -= 1;
    return s >= minSize && price > 0.01 && price < 0.99 ? s : 0;
  };
  // Up side
  if (net < 0) {
    const s = Math.min(sizes.bid, b.down);
    if (s >= minSize) out.push({ token: 'down', side: 'SELL', price: round(1 - px.bid, 2), size: round(s, 2) });
  } else if (px.bidAllowed) {
    const want = Math.min(sizes.bid, cfg.mmLiveMaxStock - net);
    const s = room(px.bid, want, (x, n) => ({ ...x, up: x.up + n, cost: x.cost + n * px.bid }));
    if (s > 0) out.push({ token: 'up', side: 'BUY', price: px.bid, size: s });
  }
  // Down side
  if (net > 0) {
    const s = Math.min(sizes.ask, b.up);
    if (s >= minSize) out.push({ token: 'up', side: 'SELL', price: px.ask, size: round(s, 2) });
  } else if (px.askAllowed) {
    const price = round(1 - px.ask, 2);
    const want = Math.min(sizes.ask, cfg.mmLiveMaxStock + net);
    const s = room(price, want, (x, n) => ({ ...x, down: x.down + n, cost: x.cost + n * price }));
    if (s > 0) out.push({ token: 'down', side: 'BUY', price, size: s });
  }
  return out;
}

/** Book a fill reported by the exchange. */
export function recordFill(L: MmLiveState, o: MmLiveOrder, shares: number, now: number): void {
  if (shares <= 0) return;
  const b = (L.books[o.key] ??= emptyBook());
  if (o.side === 'BUY') {
    if (o.token === 'up') {
      b.avgUp = (b.avgUp * b.up + o.price * shares) / (b.up + shares);
      b.up += shares;
    } else {
      b.avgDown = (b.avgDown * b.down + o.price * shares) / (b.down + shares);
      b.down += shares;
    }
    b.cost += shares * o.price;
  } else {
    if (o.token === 'up') b.up = Math.max(0, b.up - shares);
    else b.down = Math.max(0, b.down - shares);
    b.cost -= shares * o.price; // makers pay no fee on Polymarket
  }
  L.fills.unshift({ t: now, asset: o.asset, token: o.token, side: o.side, price: o.price, shares: round(shares, 2) });
  if (L.fills.length > 40) L.fills.length = 40;
}

/** The market settled: each share of the winning side pays 1, the other side 0 (to be claimed on Polymarket). */
export function settleLive(L: MmLiveState, key: string, outcome: Side | 'void', now: number): void {
  const b = L.books[key];
  if (!b) return;
  delete L.books[key];
  const payout = outcome === 'up' ? b.up : outcome === 'down' ? b.down : (b.up + b.down) / 2;
  const result = payout - b.cost;
  if (L.day !== dayOf(now)) {
    L.day = dayOf(now);
    L.dayPnl = 0;
  }
  L.pnl += result;
  L.dayPnl += result;
  L.markets++;
  L.equity.push([Math.round(now), round(L.pnl, 2)]);
  if (L.equity.length > 1500) L.equity.splice(0, L.equity.length - 1500);
}

/** Poll the exchange for fills on our resting orders; forget orders that are no longer in the book. */
async function poll(L: MmLiveState, ex: Exchange, now: number): Promise<void> {
  for (const o of [...L.orders]) {
    const st = await ex.status(o.id);
    if (!st) continue;
    if (st.matched > o.matched + 1e-9) {
      recordFill(L, o, st.matched - o.matched, now);
      o.matched = st.matched;
    }
    if (!st.open) {
      L.orders = L.orders.filter((x) => x !== o);
      L.dirty = true;
    }
  }
}

/** Cancel orders, then read their final fills so a fill landing just before the cancel is not lost. */
export async function cancelOrders(L: MmLiveState, ex: Exchange, orders: MmLiveOrder[], now: number): Promise<void> {
  if (!orders.length) return;
  await ex.cancel(orders.map((o) => o.id));
  for (const o of orders) {
    const st = await ex.status(o.id);
    if (st && st.matched > o.matched + 1e-9) recordFill(L, o, st.matched - o.matched, now);
  }
  L.orders = L.orders.filter((o) => !orders.includes(o));
}

export interface StepInput {
  state: State;
  cfg: Config;
  ex: Exchange;
  now: number;
  gateOpen: boolean;
  win: WindowRec | null;
  genes: MmGenes | null;
  top: { bid: number; ask: number } | null;
  vol: number;
  sizes: { bid: number; ask: number } | null;
}

/** One pass of the production desk. Called a few times a second; does nothing most of the time. */
export async function mmLiveStep(x: StepInput): Promise<void> {
  const { state, cfg, ex, now } = x;
  const L = state.mmLive;
  try {
    if (L.orders.length && now - L.lastPollAt >= 1.5) {
      L.lastPollAt = now;
      await poll(L, ex, now);
    }
    const el = x.win ? now - x.win.start : -1;
    const quoting = x.gateOpen && !!x.win && !!x.genes && !!x.top && !!x.sizes && el >= x.genes.startAt && el <= x.genes.stopAt;
    // Anything resting outside the current market, or when quoting must stop, is cancelled at once.
    const stale = L.orders.filter((o) => !quoting || o.key !== x.win!.key);
    if (stale.length) await cancelOrders(L, ex, stale, now);
    if (!quoting) return;
    const candle = Math.floor(now / cfg.mmSeconds);
    if (candle === L.lastCandle && !L.dirty) return;
    L.lastCandle = candle;
    L.dirty = false;
    const win = x.win!;
    const sizes = { bid: Math.max(win.minSize, (x.sizes!.bid / cfg.mmSize) * cfg.mmLiveSize), ask: Math.max(win.minSize, (x.sizes!.ask / cfg.mmSize) * cfg.mmLiveSize) };
    const wanted = wantedOrders(L.books[win.key], x.genes!, x.top!, x.vol, sizes, cfg, win.minSize);
    // Keep orders that already match what is wanted; replace the others.
    const keep = new Set<MmLiveOrder>();
    const todo: Wanted[] = [];
    for (const w of wanted) {
      const same = L.orders.find((o) => o.token === w.token && o.side === w.side && Math.abs(o.price - w.price) < 1e-9 && Math.abs(o.size - o.matched - w.size) < 0.01);
      if (same) keep.add(same);
      else todo.push(w);
    }
    const replace = L.orders.filter((o) => !keep.has(o));
    if (replace.length) await cancelOrders(L, ex, replace, now);
    for (const w of todo) {
      const res = await ex.place({ tokenId: w.token === 'up' ? win.upToken : win.downToken, side: w.side, price: w.price, size: w.size, tickSize: win.tickSize, negRisk: win.negRisk, expiresAt: now + 120 });
      if (res.ok && res.id) L.orders.push({ id: res.id, key: win.key, asset: win.asset, token: w.token, side: w.side, price: w.price, size: w.size, matched: 0, placedAt: now });
      else L.lastError = { t: now, msg: String(res.error || 'ordre refusé').slice(0, 160) };
    }
  } catch (e) {
    L.lastError = { t: now, msg: String((e as Error)?.message || e).slice(0, 160) };
  }
}
