import { ASSETS, WINDOW, config, type Config } from './config';
import { liveBalance, liveConfigured, placeLiveBuy, placeLiveSell } from './live';
import { mulberry32, round } from './math';
import { newMm, onTrade, quoteSizes, settleMm, type Quotes } from './mm';
import { computeFeatures, fairProb, featureVector, leadOf, learn, newModel, predict, type Features } from './model';
import { feePerShare, fetchBook, fetchGeoblock, fetchOutcome, fetchWindows, simulateBuy, simulateSell, type Book, type Level } from './polymarket';
import { BookFeed, SpotFeed } from './feeds';
import { blendSigma, getSeries, priceAt, strikeOf, windowStartOf, type Series } from './prices';
import { ConflictError, getStore, type Store } from './store';
import { FAMILY_LABEL, LEAD_WINDOWS, emptyStats, evaluate, evolve, exitsEarly, openGenomes, pickChampion, record, score, seedGenomes, type Quote, type Signal } from './strategies';
import type { Account, Asset, ExitReason, GateCheck, LiveFrame, LogEntry, ShadowTrade, Side, State, Strategy, Trade, WindowRec } from './types';

const nowSec = () => Date.now() / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const newAccount = (bankroll: number): Account => ({ startBankroll: bankroll, bankroll, trades: [], equity: [], nSettled: 0, nWins: 0, fees: 0, staked: 0, pnl: 0 });

export function initState(cfg: Config, now = nowSec()): State {
  const strategies: Strategy[] = [...seedGenomes(), ...openGenomes()].map((genes, i) => ({ id: `g0-${i}`, gen: 0, genes, stats: emptyStats(), bornAt: now, bornWindow: 0 }));
  return {
    version: 6,
    createdAt: now,
    updatedAt: now,
    tickCount: 0,
    generation: 0,
    settledWindows: 0,
    lastEvolveAt: 0,
    strategies,
    championId: null,
    windows: {},
    demo: newAccount(cfg.demoBankroll),
    live: newAccount(0),
    models: { btc: newModel(), eth: newModel() },
    control: { killSwitch: false, liveArmed: false },
    snapshots: {},
    gate: [],
    log: [{ t: now, level: 'info', msg: `Système initialisé : ${strategies.length} stratégies en observation.` }],
    mm: newMm(),
    tape: [],
    recent: [],
  };
}

/** A state written by an older version of the scoring rules is not comparable: start clean, keep the controls. */
export function migrate(state: State | null, cfg: Config): State {
  if (state && state.version === 6) return state;
  if (state && (state.version as number) === 5) {
    state.mm = newMm(); // the market-making desk starts empty; everything else is kept
    state.version = 6;
    return state;
  }
  if (state && (state.version as number) === 4) {
    // Add the "head start" strategies next to the existing ones, keeping everything learned so far.
    const now = nowSec();
    openGenomes().forEach((genes, i) => state.strategies.push({ id: `o-${i}`, gen: state.generation, genes, stats: emptyStats(), bornAt: now, bornWindow: state.settledWindows }));
    state.mm = newMm();
    state.version = 6;
    log(state, 'evolve', 'Nouvelle famille ajoutée : « départ en avance d’ETH » (6 réglages).', now);
    return state;
  }
  const fresh = initState(cfg);
  if (state?.control) fresh.control = { killSwitch: !!state.control.killSwitch, liveArmed: false };
  return fresh;
}

export function log(state: State, level: LogEntry['level'], msg: string, now = nowSec()) {
  // Do not repeat a message already shown in the last 10 minutes (errors tend to come in bursts).
  if (state.log.slice(0, 8).some((l) => l.msg === msg && now - l.t < 600)) return;
  state.log.unshift({ t: now, level, msg });
  if (state.log.length > 120) state.log.length = 120;
}

// ------------------------------------------------------------------ safety gate

const dayStart = (now: number) => Math.floor(now / 86400) * 86400;

export function recentDemoRoi(state: State, n = 50): { roi: number; count: number } {
  const done = state.demo.trades.filter((t) => t.status === 'won' || t.status === 'lost' || t.status === 'sold').slice(0, n);
  const cost = done.reduce((s, t) => s + t.cost, 0);
  return { roi: cost > 0 ? done.reduce((s, t) => s + (t.pnl ?? 0), 0) / cost : 0, count: done.length };
}

/** Every condition that must hold before a single real dollar is risked. */
export function computeGate(state: State, cfg: Config, now = nowSec()): GateCheck[] {
  const champ = state.strategies.find((s) => s.id === state.championId);
  const sc = champ ? score(champ.stats) : null;
  const demo = recentDemoRoi(state);
  const lossToday = -state.live.trades.filter((t) => (t.settledAt ?? 0) >= dayStart(now)).reduce((s, t) => s + (t.pnl ?? 0), 0);
  return [
    { id: 'env', label: 'Trading réel activé (LIVE_TRADING)', ok: cfg.liveTrading, detail: cfg.liveTrading ? 'activé' : 'désactivé' },
    { id: 'keys', label: 'Portefeuille Polymarket configuré', ok: liveConfigured(cfg), detail: liveConfigured(cfg) ? 'clé présente' : 'clé absente' },
    { id: 'geo', label: 'Région autorisée par Polymarket', ok: !!state.geo && !state.geo.blocked, detail: state.geo ? `${state.geo.country}${state.geo.blocked ? ' — bloqué' : ''}` : 'non vérifié' },
    { id: 'armed', label: 'Armé depuis le tableau de bord', ok: state.control.liveArmed, detail: state.control.liveArmed ? 'armé' : 'désarmé' },
    { id: 'kill', label: "Arrêt d'urgence inactif", ok: !state.control.killSwitch, detail: state.control.killSwitch ? 'arrêt actif' : 'ok' },
    {
      id: 'champion',
      label: `Champion prouvé (≥ ${cfg.liveMinTrades} trades, t ≥ ${cfg.liveMinTstat})`,
      ok: !!champ && !!sc && champ.stats.n >= cfg.liveMinTrades && sc.tstat >= cfg.liveMinTstat,
      detail: champ && sc ? `${champ.stats.n} trades, t = ${sc.tstat.toFixed(2)}` : 'aucun champion',
    },
    { id: 'demo', label: 'Compte démo rentable (50 derniers trades, ≥ 30)', ok: demo.count >= 30 && demo.roi > 0, detail: `${demo.count} trades, ROI ${(demo.roi * 100).toFixed(1)} %` },
    { id: 'loss', label: `Perte du jour < ${cfg.liveMaxDailyLoss} $`, ok: lossToday < cfg.liveMaxDailyLoss, detail: `${lossToday.toFixed(2)} $ perdus aujourd'hui` },
  ];
}

// ------------------------------------------------------------------ market catalogue

const AHEAD = 12; // one hour of 5-minute markets

/**
 * The market for `start`, from the local catalogue when possible. The catalogue is topped up an hour
 * ahead in a single request, so the engine keeps trading through a short refusal or outage.
 */
async function ensureWindow(state: State, asset: Asset, start: number): Promise<WindowRec | null> {
  const have = (s: number) => !!state.windows[`${asset}-${s}`];
  const current = state.windows[`${asset}-${start}`];
  const future = Array.from({ length: AHEAD }, (_, i) => start + (i + 1) * WINDOW);
  if (current && future.filter(have).length >= AHEAD / 2) return current;
  try {
    const wanted = [start, ...future].filter((s) => !have(s));
    for (const w of await fetchWindows(asset, wanted)) state.windows[w.key] = w;
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    log(state, 'warn', msg.includes('HTTP 403')
      ? 'Polymarket refuse les requêtes de cette connexion (HTTP 403). Causes habituelles : pays où Polymarket est restreint, VPN ou réseau filtré. Lancez « npm run check » pour le détail.'
      : `Catalogue Polymarket : ${msg.slice(0, 120)}`);
    if (!current) throw e;
  }
  return state.windows[`${asset}-${start}`] ?? null;
}

// ------------------------------------------------------------------ one asset

const best = (b: Book) => ({ ask: b.asks[0]?.price ?? null, bid: b.bids[0]?.price ?? null });

function openTrade(acct: Account, t: Trade) {
  acct.trades.unshift(t);
  if (acct.trades.length > 300) acct.trades.length = 300;
  if (t.status === 'open') {
    acct.bankroll -= t.cost;
    acct.staked += t.cost;
    acct.fees += t.fee;
  }
}

export interface Pending {
  strat: Strategy;
  sig: Signal;
}

/** Which strategies want to trade right now (each at most once per market). */
export function decide(state: State, cfg: Config, win: WindowRec, f: Features, quote: Quote, qModel: number | null, skip?: (id: string) => boolean): Pending[] {
  if (f.elapsed > cfg.lastEntry) return [];
  const traded = new Set(win.shadows.map((s) => s.sid));
  const out: Pending[] = [];
  for (const strat of state.strategies) {
    if (traded.has(strat.id) || skip?.(strat.id)) continue;
    const sig = evaluate(strat.genes, f, quote, qModel);
    if (!sig) continue;
    strat.stats.signals = (strat.stats.signals ?? 0) + 1;
    out.push({ strat, sig });
  }
  return out;
}

/**
 * Turn signals into paper trades against a book fetched AFTER the decision, the way a real order
 * arrives a moment later. If the price is gone (beyond one tick of slippage), there is no fill.
 * This matters: counting fills at the price we merely saw made losing strategies look profitable.
 */
export function applyFills(state: State, cfg: Config, win: WindowRec, pending: Pending[], asksUp: Level[], asksDown: Level[], now: number, bidUp: number | null = null, bidDown: number | null = null) {
  for (const { strat, sig } of pending) {
    const asks = sig.side === 'up' ? asksUp : asksDown;
    const cap = Math.min(0.99, sig.ask + cfg.slippage);
    const fill = simulateBuy(asks, cfg.shadowStake, win.feeRate, win.feeExp, cap);
    if (!fill) continue;
    const cost = round(fill.cost / fill.shares);
    win.shadows.push({ sid: strat.id, side: sig.side, cost, q: round(sig.q), elapsed: Math.round(now - win.start), t: now, shares: round(fill.shares, 2), bid0: sig.side === 'up' ? bidUp : bidDown });
    state.tape.unshift({ t: now, key: win.key, sid: strat.id, asset: win.asset, side: sig.side, cost, q: round(sig.q), lead: sig.lead === undefined ? null : round(sig.lead) });
    if (state.tape.length > 240) state.tape.length = 240;
    if (strat.id === state.championId && !state.control.killSwitch && !win.demoTradeId) openDemo(state, cfg, win, strat, sig, asks, cap, now);
  }
}

const EXIT_LABEL: Record<ExitReason, string> = { tp: 'objectif de gain atteint', stop: 'stop', time: 'durée maximale' };

/**
 * Should this position be closed now? Three independent rules, set per strategy:
 *  - take profit: it can be sold for the stake plus the target, AFTER the exit fee;
 *  - stop: the price has fallen by the set share of the stake since entry. It is measured on the
 *    price move, not on resale value: spread and two fees already make any position worth roughly
 *    10% less the instant it is bought, so a stop on resale value would fire immediately;
 *  - timer: the catch-up we bet on has not happened within the allotted time.
 */
export function exitReason(g: Strategy['genes'], sh: ShadowTrade, bid: number, win: WindowRec, now: number): ExitReason | null {
  if (!exitsEarly(g) || sh.t === undefined || !sh.shares) return null;
  const net = bid - feePerShare(bid, win.feeRate, win.feeExp);
  if (g.takeProfit > 0 && net >= sh.cost * (1 + g.takeProfit)) return 'tp';
  if (g.stopMove > 0 && sh.bid0 != null && bid <= sh.bid0 - g.stopMove * sh.cost) return 'stop';
  if (g.maxHold > 0 && now - sh.t >= g.maxHold) return 'time';
  return null;
}

/**
 * Sell a paper position against the bids as they are when the order lands. Returns false, leaving
 * the position open, if the whole position cannot be sold at `minPrice` or better.
 */
export function executeExit(state: State, cfg: Config, win: WindowRec, sh: ShadowTrade, why: ExitReason, bids: Level[], minPrice: number, now: number): boolean {
  if (sh.exit || !sh.shares) return false;
  const sale = simulateSell(bids, sh.shares, win.feeRate, win.feeExp, minPrice);
  if (!sale || sale.shares < sh.shares - 0.01) return false;
  const net = sale.proceeds / sale.shares;
  sh.exit = { t: now, net: round(net), why };
  const strat = state.strategies.find((s) => s.id === sh.sid);
  if (strat) record(strat.stats, net - sh.cost, sh.cost, cfg.ewDecay);
  const entry = state.tape.find((e) => e.key === win.key && e.sid === sh.sid && !e.result);
  if (entry) {
    entry.result = why;
    entry.pnl = round(net - sh.cost);
  }
  // The demo account holds the champion's position: close it the same way, for its own size.
  const trade = state.demo.trades.find((t) => t.id === win.demoTradeId && t.status === 'open' && t.strategyId === sh.sid);
  const own = trade ? simulateSell(bids, trade.shares, win.feeRate, win.feeExp, minPrice) : null;
  if (trade && own && own.shares >= trade.shares - 0.01) {
    trade.status = 'sold';
    trade.pnl = round(own.proceeds - trade.cost);
    trade.settledAt = now;
    state.demo.bankroll += own.proceeds;
    state.demo.pnl += trade.pnl;
    state.demo.fees += own.fee;
    state.demo.nSettled++;
    if (trade.pnl > 0) state.demo.nWins++;
    state.demo.equity.push([Math.round(now), round(state.demo.bankroll, 2)]);
    log(state, 'trade', `DÉMO ${win.asset.toUpperCase()} : vente (${EXIT_LABEL[why]}) à ${(own.price * 100).toFixed(1)}¢, ${trade.pnl >= 0 ? '+' : '−'}${Math.abs(trade.pnl).toFixed(2)} $.`, now);
  }
  return true;
}

/** Sell a real position (fill-or-kill). If the sale fails the position simply stays open until settlement. */
async function closeLive(state: State, cfg: Config, win: WindowRec, trade: Trade, tokenId: string, minPrice: number, persist: () => Promise<void>) {
  const res = await placeLiveSell(cfg, { tokenId, shares: trade.shares, minPrice, tickSize: win.tickSize, negRisk: win.negRisk });
  if (!res.ok) return log(state, 'error', `RÉEL ${win.asset.toUpperCase()} : vente échouée — ${res.error}. La position reste ouverte jusqu’au règlement.`);
  const now = nowSec();
  trade.status = 'sold';
  trade.pnl = round(res.cost! - trade.cost);
  trade.settledAt = now;
  state.live.bankroll += res.cost!;
  state.live.pnl += trade.pnl;
  state.live.nSettled++;
  if (trade.pnl > 0) state.live.nWins++;
  state.live.equity.push([Math.round(now), round(state.live.bankroll, 2)]);
  log(state, 'trade', `RÉEL ${win.asset.toUpperCase()} : vente pour ${res.cost!.toFixed(2)} $, ${trade.pnl >= 0 ? '+' : '−'}${Math.abs(trade.pnl).toFixed(2)} $.`, now);
  await persist();
}

function openDemo(state: State, cfg: Config, win: WindowRec, strat: Strategy, sig: Signal, asks: Level[], cap: number, now: number) {
  const c = sig.ask + feePerShare(sig.ask, win.feeRate, win.feeExp);
  // Size on the edge the champion has actually delivered (pessimistically: average − 1 standard
  // error), never on the edge it claims. Then a quarter of Kelly, capped.
  const sc = score(strat.stats);
  const proven = Math.min(sig.edge, Math.max(0, sc.mean - sc.se));
  const kelly = proven / (1 - c);
  // BTC and ETH resolve the same way 83% of the time: a second bet in the same 5 minutes is mostly
  // the same bet, so it shares the risk budget.
  const sameWindow = state.demo.trades.filter((t) => t.status === 'open' && t.windowStart === win.start).length;
  const stake = (state.demo.bankroll * Math.min(cfg.maxStakePct, cfg.kellyFraction * kelly)) / (1 + sameWindow);
  if (stake < 1) return;
  const fill = simulateBuy(asks, stake, win.feeRate, win.feeExp, cap);
  if (!fill || fill.shares < win.minSize) return;
  const id = `d-${win.key}`;
  win.demoTradeId = id;
  openTrade(state.demo, {
    id, mode: 'demo', asset: win.asset, windowStart: win.start, slug: win.slug, side: sig.side, shares: round(fill.shares, 2), price: round(fill.price),
    fee: round(fill.fee), cost: round(fill.cost), q: round(sig.q), edge: round(sig.edge), strategyId: strat.id, openedAt: now, status: 'open',
  });
  log(state, 'trade', `DÉMO ${win.asset.toUpperCase()} : achat ${sig.side === 'up' ? 'Hausse' : 'Baisse'} ${fill.shares.toFixed(1)} parts à ${(fill.price * 100).toFixed(1)}¢ (avantage estimé ${(sig.edge * 100).toFixed(1)}¢).`, now);
}

async function processAsset(state: State, cfg: Config, asset: Asset, persist: () => Promise<void>): Promise<void> {
  const t0 = nowSec();
  const start = windowStartOf(t0);
  const win = await ensureWindow(state, asset, start);
  if (!win) {
    log(state, 'warn', `Marché ${asset.toUpperCase()} introuvable pour la fenêtre en cours.`);
    return;
  }

  const asked = Date.now();
  const [series, bookUp, bookDown] = await Promise.all([getSeries(asset), fetchBook(win.upToken), fetchBook(win.downToken)]);
  const latencyMs = Date.now() - asked;
  const now = nowSec();
  if (windowStartOf(now) !== start) return; // the window rolled over while fetching
  if (win.strike === undefined) {
    const k = strikeOf(series, start);
    if (k === null) return;
    win.strike = k;
  }
  const f = computeFeatures(series, start, win.strike, now);
  if (!f) return;

  const up = best(bookUp);
  const down = best(bookDown);
  const mid = up.ask !== null && up.bid !== null ? (up.ask + up.bid) / 2 : up.ask !== null && down.ask !== null ? (up.ask + 1 - down.ask) / 2 : null;
  const qFair = fairProb(f.z);
  const model = state.models[asset];
  const x = mid !== null ? featureVector(f, mid) : null;
  // The learned model only gets a vote once it has seen enough outcomes.
  const qModel = x && model.n >= 200 ? predict(model, x) : null;

  state.snapshots[asset] = {
    t: now, asset, slug: win.slug, windowStart: start, elapsed: round(f.elapsed, 1), spot: f.spot, strike: round(win.strike, 2),
    sigma: f.sigma, source: series.source, askUp: up.ask, askDown: down.ask, bidUp: up.bid, mid, qFair: round(qFair), qModel: qModel === null ? null : round(qModel), latencyMs,
  };
  if (mid === null || !x) return;

  // Training sample for the online model (labelled when the window settles).
  const lastObs = win.obs[win.obs.length - 1];
  if (f.elapsed >= 5 && f.elapsed <= 290 && win.obs.length < 9 && (!lastObs || f.elapsed - lastObs.elapsed >= 28)) {
    win.obs.push({ elapsed: Math.round(f.elapsed), x: x.map((v) => round(v)), mid: round(mid), qFair: round(qFair) });
  }

  // Speed is the whole game here: with prices even 2 seconds old, every strategy tested lost.
  // So never act on slow, stale or degraded data, on a wide spread, or on a broken book.
  const fresh = series.source === 'binance' && now - series.last.t < 3 && latencyMs < 2500;
  const sane = up.ask !== null && down.ask !== null && up.ask + down.ask >= 0.97 && up.ask + down.ask <= 1 + cfg.maxSpread + 0.02;
  if (!fresh || !sane) return;

  const pending = decide(state, cfg, win, f, { askUp: up.ask, askDown: down.ask, mid, feeRate: win.feeRate, feeExp: win.feeExp }, qModel);
  if (pending.length === 0) return;

  // Real money goes first: the exchange itself decides whether the price is still there.
  const champ = pending.find((p) => p.strat.id === state.championId);
  const liveThisWindow = state.live.trades.some((t) => t.windowStart === start && t.status !== 'failed');
  if (champ && !win.liveTradeId && !liveThisWindow && computeGate(state, cfg, now).every((g) => g.ok)) {
    await openLive(state, cfg, win, champ.strat, champ.sig, Math.min(0.99, champ.sig.ask + cfg.liveMaxSlippage), now, persist);
  }

  // Paper trades are confirmed against a fresh book, as if the order had travelled.
  const wait = cfg.confirmMs - (Date.now() - asked - latencyMs);
  if (wait > 0) await sleep(wait);
  const [confirmUp, confirmDown] = await Promise.all([fetchBook(win.upToken), fetchBook(win.downToken)]);
  const later = nowSec();
  if (windowStartOf(later) !== start) return;
  applyFills(state, cfg, win, pending, confirmUp.asks, confirmDown.asks, later, confirmUp.bids[0]?.price ?? null, confirmDown.bids[0]?.price ?? null);
}

async function openLive(state: State, cfg: Config, win: WindowRec, strat: Strategy, sig: Signal, cap: number, now: number, persist: () => Promise<void>, fast = false) {
  const id = `l-${win.key}`;
  win.liveTradeId = id;
  if (fast) {
    // Real-time mode: every 100 ms counts, so the reservation is saved while the order travels.
    // (Worst case after a crash in that instant: one duplicate order of the fixed stake.)
    void persist().catch(() => {});
  } else {
    // Reserve the slot and save BEFORE sending, so a crash can never cause a double order.
    await persist();
    // Saving also picks up the latest dashboard controls: re-check before sending.
    if (state.control.killSwitch || !state.control.liveArmed) return;
  }
  const res = await placeLiveBuy(cfg, { tokenId: sig.side === 'up' ? win.upToken : win.downToken, usd: cfg.liveStakeUsd, maxPrice: cap, tickSize: win.tickSize, negRisk: win.negRisk });
  const trade: Trade = {
    id, mode: 'live', asset: win.asset, windowStart: win.start, slug: win.slug, side: sig.side, shares: round(res.shares ?? 0, 2), price: res.ok ? round(res.cost! / res.shares!) : sig.ask,
    fee: 0, cost: round(res.cost ?? 0), q: round(sig.q), edge: round(sig.edge), strategyId: strat.id, openedAt: now, status: res.ok ? 'open' : 'failed', orderId: res.orderId, error: res.error,
  };
  openTrade(state.live, trade);
  log(state, res.ok ? 'trade' : 'error', res.ok
    ? `RÉEL ${win.asset.toUpperCase()} : achat ${sig.side === 'up' ? 'Hausse' : 'Baisse'} ${trade.shares} parts pour ${trade.cost.toFixed(2)} $.`
    : `RÉEL ${win.asset.toUpperCase()} : ordre échoué — ${res.error}`, now);
  await persist();
}

// ------------------------------------------------------------------ settlement & learning

function settleTrade(acct: Account, t: Trade, outcome: Side | 'void', now: number) {
  if (t.status !== 'open') return;
  const payout = outcome === 'void' ? t.cost : outcome === t.side ? t.shares : 0;
  t.status = outcome === 'void' ? 'void' : outcome === t.side ? 'won' : 'lost';
  t.pnl = round(payout - t.cost);
  t.settledAt = now;
  acct.bankroll += payout;
  acct.pnl += t.pnl;
  if (t.status !== 'void') {
    acct.nSettled++;
    if (t.status === 'won') acct.nWins++;
  }
  acct.equity.push([Math.round(now), round(acct.bankroll, 2)]);
  if (acct.equity.length > 1500) acct.equity.splice(0, acct.equity.length - 1500);
}

export function settleWindow(state: State, cfg: Config, win: WindowRec, outcome: Side | 'void', now: number) {
  win.outcome = outcome;
  win.settledAt = now;
  if (outcome !== 'void') {
    for (const sh of win.shadows) {
      if (sh.exit) continue; // sold before the end: already counted
      const strat = state.strategies.find((s) => s.id === sh.sid);
      if (strat) record(strat.stats, (sh.side === outcome ? 1 : 0) - sh.cost, sh.cost, cfg.ewDecay);
    }
    learn(state.models[win.asset], win.obs, outcome === 'up' ? 1 : 0, cfg.learningRate);
  }
  for (const acct of [state.demo, state.live]) {
    for (const t of acct.trades) if (t.windowStart === win.start && t.asset === win.asset) settleTrade(acct, t, outcome, now);
  }
  settleMm(state.mm, win.key, outcome, now);
  for (const entry of state.tape) {
    if (entry.key !== win.key || entry.result) continue;
    entry.result = outcome === 'void' ? 'void' : entry.side === outcome ? 'won' : 'lost';
    entry.pnl = outcome === 'void' ? 0 : round((entry.side === outcome ? 1 : 0) - entry.cost);
  }
  state.recent.unshift({ key: win.key, asset: win.asset, start: win.start, outcome, shadows: win.shadows.length });
  if (state.recent.length > 60) state.recent.length = 60;
  state.settledWindows++;
  delete state.windows[win.key];
}

async function settle(state: State, cfg: Config) {
  const now = nowSec();
  const due = Object.values(state.windows).filter((w) => now > w.start + WINDOW + 45 && now - (w.lastResolveCheck ?? 0) >= 15);
  await Promise.all(
    due.map(async (w) => {
      w.lastResolveCheck = now;
      let outcome: Side | 'void' | null = null;
      try {
        outcome = await fetchOutcome(w.asset, w.start, w.conditionId);
      } catch {
        /* retry on the next pass */
      }
      if (!outcome && now > w.start + WINDOW + 3600) outcome = 'void';
      if (outcome) settleWindow(state, cfg, w, outcome, now);
    }),
  );
}

export function improve(state: State, cfg: Config, now = nowSec()) {
  const prev = state.championId;
  state.championId = pickChampion(state.strategies, prev, cfg.championMinTrades, cfg.championZ);
  if (state.championId !== prev) {
    const c = state.strategies.find((s) => s.id === state.championId);
    log(state, 'evolve', c ? `Nouveau champion : ${c.id} (${FAMILY_LABEL[c.genes.family]}), ${(score(c.stats).mean * 100).toFixed(1)}¢ gagnés par part sur ${c.stats.n} trades (t = ${score(c.stats).tstat.toFixed(1)}).` : 'Plus aucun champion : aucune stratégie n’a un avantage prouvé, le système reste à l’écart.', now);
  }
  if (state.settledWindows - state.lastEvolveAt >= cfg.evolveEvery) {
    state.lastEvolveAt = state.settledWindows;
    state.generation++;
    const res = evolve(state.strategies, state.generation, state.settledWindows, state.championId, mulberry32(Math.floor(now)), now);
    state.strategies = res.population;
    if (res.added.length) log(state, 'evolve', `Génération ${state.generation} : ${res.removed.length} stratégie(s) retirée(s) (${res.removed.map((s) => s.id).join(', ')}), remplacée(s) par des variantes des meilleures.`, now);
  }
}

// ------------------------------------------------------------------ real-time session

/**
 * Trades from live WebSocket feeds until `deadlineMs`: spot price trade by trade, the full order
 * book in memory, a decision every 200 ms. Paper orders are checked against the book half a second
 * later (the time a real order needs to arrive); real orders are sent immediately.
 */
async function runStream(state: State, cfg: Config, persist: () => Promise<void>, deadlineMs: number, saveEvery: number, signal?: AbortSignal, onFrame?: (state: State) => void, onLive?: (frame: LiveFrame) => void): Promise<number> {
  const series = Object.fromEntries(await Promise.all(ASSETS.map(async (a) => [a, await getSeries(a)] as const))) as Record<Asset, Series>;
  if (ASSETS.some((a) => series[a].source !== 'binance')) throw new Error('flux de prix principal indisponible');
  const spot = new SpotFeed();
  await spot.start(ASSETS);

  let book: BookFeed | null = null;
  let bookStart = -1;
  let rolling = false;
  let rollAfter = 0;
  let rollDelay = 2000;
  const roll = async (start: number) => {
    const wins = await Promise.all(ASSETS.map((a) => ensureWindow(state, a, start)));
    const tokens: string[] = [];
    wins.forEach((w, i) => {
      if (!w) return log(state, 'warn', `Marché ${ASSETS[i].toUpperCase()} introuvable pour la fenêtre en cours.`);
      tokens.push(w.upToken, w.downToken);
    });
    if (tokens.length === 0) throw new Error('aucun marché disponible');
    const next = new BookFeed(tokens);
    await next.start();
    book?.close();
    book = next;
    bookStart = start;
    rollDelay = 2000;
  };

  const retryAt = new Map<string, number>();
  const confirms: { due: number; win: WindowRec; p: Pending }[] = [];
  const exits: { due: number; win: WindowRec; sh: ShadowTrade; why: ExitReason; minPrice: number }[] = [];
  const exiting = new Set<ShadowTrade>();
  const background = new Set<Promise<unknown>>();
  const run = (p: Promise<unknown>) => {
    background.add(p);
    void p.catch((e) => log(state, 'warn', String((e as Error)?.message || e).slice(0, 140))).finally(() => background.delete(p));
  };
  let settling = false;
  let saving = false;
  let liveBusy = false;
  let lastSecond = Math.floor(nowSec());
  let lastSettle = 0;
  let lastSave = Date.now();
  let evals = 0;
  let sentHistory = false;

  // Market-making desk: its resting quotes per asset, renewed at each candle close.
  const desk: Partial<Record<Asset, Quotes>> = {};
  let lastCandle = 0;
  let lead10: number | null = null;
  const evalAsset = (asset: Asset, now: number, start: number, feed: BookFeed) => {
    const win = state.windows[`${asset}-${start}`];
    const price = spot.last[asset];
    if (!win || price === undefined) return;
    const s = series[asset];
    s.last = { t: now, c: price, v: 0, tb: 0 };
    if (win.strike === undefined) {
      const k = strikeOf(s, start);
      if (k === null) return;
      win.strike = k;
    }
    const f = computeFeatures(s, start, win.strike, now);
    if (!f) return;
    f.asset = asset;
    // ETH is judged against BTC: how hard has BTC just pushed, and which way?
    if (asset === 'eth') {
      const btc = state.windows[`btc-${start}`];
      if (btc?.strike !== undefined) f.lead = leadOf(series.btc, start, btc.strike, now, LEAD_WINDOWS);
      lead10 = f.lead?.[10] ?? null;
    }
    const up = feed.best(win.upToken);
    const down = feed.best(win.downToken);
    const mid = up.ask !== null && up.bid !== null ? (up.ask + up.bid) / 2 : up.ask !== null && down.ask !== null ? (up.ask + 1 - down.ask) / 2 : null;
    const qFair = fairProb(f.z);
    const model = state.models[asset];
    const x = mid !== null ? featureVector(f, mid) : null;
    const qModel = x && model.n >= 200 ? predict(model, x) : null;
    // Feed health: the book stream is busy (hundreds of updates per second); spot trades can pause briefly.
    const bookAge = Date.now() - feed.lastMsg;
    const age = Date.now() - spot.lastMsg > 5000 ? 9999 : Math.round(bookAge);
    state.snapshots[asset] = {
      t: now, asset, slug: win.slug, windowStart: start, elapsed: round(f.elapsed, 1), spot: f.spot, strike: round(win.strike, 2),
      sigma: f.sigma, source: 'binance (temps réel)', askUp: up.ask, askDown: down.ask, bidUp: up.bid, mid, qFair: round(qFair), qModel: qModel === null ? null : round(qModel), latencyMs: age,
    };
    if (mid === null || !x) return;
    const lastObs = win.obs[win.obs.length - 1];
    if (f.elapsed >= 5 && f.elapsed <= 290 && win.obs.length < 9 && (!lastObs || f.elapsed - lastObs.elapsed >= 28)) {
      win.obs.push({ elapsed: Math.round(f.elapsed), x: x.map((v) => round(v)), mid: round(mid), qFair: round(qFair) });
    }
    const sane = up.ask !== null && down.ask !== null && up.ask + down.ask >= 0.97 && up.ask + down.ask <= 1 + cfg.maxSpread + 0.02;
    if (age > 3000 || !sane) return;

    const pending = decide(state, cfg, win, f, { askUp: up.ask, askDown: down.ask, mid, feeRate: win.feeRate, feeExp: win.feeExp }, qModel, (id) => (retryAt.get(`${id}|${win.key}`) ?? 0) > now);
    for (const p of pending) {
      retryAt.set(`${p.strat.id}|${win.key}`, now + 5); // a missed order may be retried after 5 s
      confirms.push({ due: Date.now() + cfg.streamConfirmMs, win, p });
    }
    const champ = pending.find((p) => p.strat.id === state.championId);
    if (champ && !liveBusy && !win.liveTradeId && !state.live.trades.some((t) => t.windowStart === start && t.status !== 'failed') && computeGate(state, cfg, now).every((g) => g.ok)) {
      liveBusy = true;
      run(openLive(state, cfg, win, champ.strat, champ.sig, Math.min(0.99, champ.sig.ask + cfg.liveMaxSlippage), now, persist, true).finally(() => (liveBusy = false)));
    }
  };

  try {
    while (Date.now() < deadlineMs && !signal?.aborted) {
      const now = nowSec();
      const start = windowStartOf(now);
      if (spot.closed) throw new Error('flux de prix interrompu');

      // Once per second: extend the price history the model works from.
      const sec = Math.floor(now);
      if (sec !== lastSecond) {
        lastSecond = sec;
        for (const a of ASSETS) {
          const price = spot.last[a];
          if (price === undefined) continue;
          const vol = spot.drain(a);
          const s = series[a];
          s.ticks.push({ t: sec, c: price, v: vol.v, tb: vol.tb });
          if (s.ticks.length > 1300) s.ticks.splice(0, s.ticks.length - 1200);
          if (sec % 10 === 0) s.sigma = blendSigma(s.ticks, s.slow);
        }
        onFrame?.(state); // live view for whoever is watching
      }

      // New 5-minute market: switch the order-book subscription.
      const feed = book as BookFeed | null;
      if ((bookStart !== start || !feed || feed.closed) && !rolling && Date.now() >= rollAfter) {
        rolling = true;
        // If it fails, wait before trying again — longer each time, so a refusal is not hammered.
        rollAfter = Date.now() + rollDelay;
        rollDelay = Math.min(rollDelay * 2, 60000);
        run(roll(start).finally(() => (rolling = false)));
      }
      if (feed && bookStart === start && feed.ready()) {
        for (const a of ASSETS) evalAsset(a, now, start, feed);
        evals++;
        // Paper orders whose travel time has elapsed: fill them against the book as it is NOW.
        while (confirms.length && confirms[0].due <= Date.now()) {
          const c = confirms.shift()!;
          if (c.win.start !== start || c.win.outcome) continue;
          applyFills(state, cfg, c.win, [c.p], feed.asks(c.win.upToken), feed.asks(c.win.downToken), nowSec(), feed.best(c.win.upToken).bid, feed.best(c.win.downToken).bid);
        }
        // Market making: first let the trades that just happened fill our resting quotes…
        if (cfg.mmEnabled) {
          for (const tr of feed.drainTrades()) {
            for (const a of ASSETS) {
              const q = desk[a];
              const w = q ? state.windows[q.key] : undefined;
              if (!q || !w || w.start !== start) continue;
              if (tr.token === w.upToken) onTrade(state.mm, cfg, q, w, tr.price, tr.size, !tr.takerBuy, now);
              // Buying Down from a taker is the same trade as selling Up at the complementary price.
              else if (tr.token === w.downToken) onTrade(state.mm, cfg, q, w, 1 - tr.price, tr.size, tr.takerBuy, now);
            }
          }
          // …then, at each candle close, cancel and re-quote both sides at the best prices.
          const candle = Math.floor(now / cfg.mmSeconds);
          if (candle !== lastCandle) {
            lastCandle = candle;
            for (const a of ASSETS) {
              const w = state.windows[`${a}-${start}`];
              const el = now - start;
              const open = priceAt(series[a], now - cfg.mmSeconds);
              const close = spot.last[a];
              const top = w ? feed.best(w.upToken) : null;
              desk[a] = undefined;
              if (!w || !top || top.ask === null || top.bid === null || !open || !close || el < 10 || el > cfg.lastEntry) continue;
              if (top.ask - top.bid > 0.05 || top.bid < 0.05 || top.ask > 0.95) continue;
              const size = quoteSizes(open, close, cfg.mmSize);
              desk[a] = {
                key: w.key, asset: a, candle: size.candle,
                bid: { price: top.bid, left: size.bid, queue: feed.sizeAt(w.upToken, 'bid', top.bid) },
                ask: { price: top.ask, left: size.ask, queue: feed.sizeAt(w.upToken, 'ask', top.ask) },
              };
            }
          }
        }
        // Open positions: is it time to take the gain, cut the loss, or give up waiting?
        for (const a of ASSETS) {
          const win = state.windows[`${a}-${start}`];
          if (!win) continue;
          for (const sh of win.shadows) {
            if (sh.exit || exiting.has(sh)) continue;
            const strat = state.strategies.find((s) => s.id === sh.sid);
            const bid = feed.best(sh.side === 'up' ? win.upToken : win.downToken).bid;
            const why = strat && bid !== null ? exitReason(strat.genes, sh, bid, win, now) : null;
            if (!why) continue;
            exiting.add(sh);
            // A profit is only taken at the price seen (minus one tick); a stop or a timer sells at market.
            exits.push({ due: Date.now() + cfg.streamConfirmMs, win, sh, why, minPrice: why === 'tp' ? bid! - cfg.slippage : 0 });
          }
        }
        while (exits.length && exits[0].due <= Date.now()) {
          const x = exits.shift()!;
          exiting.delete(x.sh);
          if (x.win.start !== start || x.win.outcome) continue;
          const token = x.sh.side === 'up' ? x.win.upToken : x.win.downToken;
          const sold = executeExit(state, cfg, x.win, x.sh, x.why, feed.bids(token), x.minPrice, nowSec());
          const live = sold ? state.live.trades.find((t) => t.id === x.win.liveTradeId && t.status === 'open' && t.strategyId === x.sh.sid) : undefined;
          if (live) run(closeLive(state, cfg, x.win, live, token, x.why === 'tp' ? x.minPrice : 0.01, persist));
        }
      }

      // Several times a second: what the engine sees right now (prices and order book), for the dashboard.
      if (onLive) {
        const shown = feed && bookStart === start && feed.ready() ? feed : null;
        const assets = {} as LiveFrame['assets'];
        for (const a of ASSETS) {
          const w = state.windows[`${a}-${start}`];
          const snap = state.snapshots[a]?.windowStart === start ? state.snapshots[a] : undefined;
          const depth = (levels: Level[]) => levels.slice(0, 6).map((l) => [l.price, Math.round(l.size)] as [number, number]);
          assets[a] = {
            spot: spot.last[a] ?? null, strike: w?.strike ?? null, mid: snap?.mid ?? null, qFair: snap?.qFair ?? null, qModel: snap?.qModel ?? null,
            asks: shown && w ? depth(shown.asks(w.upToken)) : [], bids: shown && w ? depth(shown.bids(w.upToken)) : [],
            asksDown: shown && w ? depth(shown.asks(w.downToken)) : [], bidsDown: shown && w ? depth(shown.bids(w.downToken)) : [], bookAgeMs: shown ? Date.now() - shown.lastMsg : null, lead: a === 'eth' ? lead10 : undefined,
          };
        }
        const frame: LiveFrame = { t: now, windowStart: start, assets };
        if (!sentHistory) {
          sentHistory = true;
          frame.history = Object.fromEntries(ASSETS.map((a) => [a, series[a].ticks.slice(-120).map((k) => [k.t, k.c] as [number, number])])) as LiveFrame['history'];
        }
        onLive(frame);
      }

      if (now - lastSettle >= 10 && !settling) {
        lastSettle = now;
        settling = true;
        const before = state.settledWindows;
        run(settle(state, cfg).then(() => {
          if (state.settledWindows !== before) improve(state, cfg);
          for (const w of Object.values(state.windows)) if (w.strike === undefined && nowSec() > w.start + WINDOW) delete state.windows[w.key];
        }).finally(() => (settling = false)));
      }
      // Regular saves keep the dashboard current and pick up its controls (kill switch, arming).
      const every = (state.control.liveArmed ? Math.min(10, saveEvery) : saveEvery) * 1000;
      if (Date.now() - lastSave >= every && !saving) {
        lastSave = Date.now();
        saving = true;
        state.gate = computeGate(state, cfg);
        run(persist().finally(() => (saving = false)));
      }
      await sleep(cfg.evalMs);
    }
  } finally {
    spot.close();
    (book as BookFeed | null)?.close();
    await Promise.allSettled([...background]);
  }
  return evals;
}

// ------------------------------------------------------------------ tick

function applyControl(state: State, cfg: Config, control: State['control']) {
  state.control = { killSwitch: !!control.killSwitch, liveArmed: !!control.liveArmed };
  if (control.resetDemo) {
    state.demo = newAccount(cfg.demoBankroll);
    for (const w of Object.values(state.windows)) delete w.demoTradeId;
    log(state, 'info', 'Compte démo remis à zéro.');
  }
}

async function pass(state: State, cfg: Config, persist: () => Promise<void>) {
  const results = await Promise.allSettled(ASSETS.map((a) => processAsset(state, cfg, a, persist)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') log(state, 'warn', `${ASSETS[i].toUpperCase()} : ${String(r.reason?.message || r.reason).slice(0, 140)}`);
  });
  const before = state.settledWindows;
  await settle(state, cfg);
  if (state.settledWindows !== before) improve(state, cfg);
  // Forget windows that never got a strike (e.g. the bot started mid-outage).
  for (const w of Object.values(state.windows)) if (w.strike === undefined && nowSec() > w.start + WINDOW) delete state.windows[w.key];
}

export interface TickResult {
  ok: boolean;
  busy?: boolean;
  passes: number;
  mode?: 'realtime' | 'polling';
  ms: number;
  store: Store['kind'];
}

export interface TickOptions {
  loopSeconds?: number;
  /** Stops the run cleanly (state saved, lock released) as soon as possible. */
  signal?: AbortSignal;
  /** If the live feeds fail, return instead of polling for the rest of the run (the caller retries). */
  noFallback?: boolean;
  /** Called after each save, e.g. to print progress. */
  onSave?: (state: State) => void;
  /** Called about once a second during a real-time session with the live state (do not mutate). */
  onFrame?: (state: State) => void;
  /** Called several times a second during a real-time session with live prices and order books. */
  onLive?: (frame: LiveFrame) => void;
}

export async function runTick(opts: TickOptions = {}): Promise<TickResult> {
  const cfg = config();
  const store = getStore();
  const began = Date.now();
  const id = Math.random().toString(36).slice(2, 10);
  const loopMs = Math.max(0, (opts.loopSeconds ?? cfg.loopSeconds) * 1000);
  const saveEvery = cfg.persistSeconds || (store.kind === 'blob' ? 3600 : 30);
  let { state, etag } = await store.read();
  state = migrate(state, cfg);
  if (state.lock && nowSec() - state.lock.at < (state.lock.ttl ?? 75)) return { ok: true, busy: true, passes: 0, ms: 0, store: store.kind };

  // Saves the state. The dashboard may have changed the controls meanwhile:
  // in that case adopt its controls and save again, as long as we still hold the lock.
  const save = async () => {
    state!.updatedAt = nowSec();
    if (state!.lock) {
      // Heartbeat: the lock is valid until shortly after the next expected save, so a dead run frees it.
      const remaining = Math.max(0, (began + loopMs - Date.now()) / 1000);
      state!.lock = { ...state!.lock, at: state!.updatedAt, ttl: Math.min(saveEvery, remaining) + 45 };
    }
    try {
      etag = await store.write(state!, etag);
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      const fresh = await store.read();
      if (!locked || !fresh.state || fresh.state.lock?.id !== id) throw e;
      applyControl(state!, cfg, fresh.state.control);
      etag = await store.write(state!, fresh.etag);
    }
    opts.onSave?.(state!);
  };
  // Saves never overlap: each waits for the previous one.
  let queue: Promise<void> = Promise.resolve();
  const persist = () => (queue = queue.then(save, save));
  applyControl(state, cfg, state.control);
  // A lock (one extra write) stops two sessions running at once. It is always taken when real money
  // is involved. On Vercel Blob, whose free plan allows only 2,000 writes a month, paper-only
  // sessions skip it: if two overlap, the one that finishes last is simply discarded.
  const locked = liveConfigured(cfg) || (loopMs > 0 && store.kind !== 'blob');
  if (locked) {
    state.lock = { at: nowSec(), id, ttl: Math.min(saveEvery, loopMs / 1000) + 45 };
    try {
      state.updatedAt = nowSec();
      etag = await store.write(state, etag);
    } catch (e) {
      if (e instanceof ConflictError) return { ok: true, busy: true, passes: 0, ms: Date.now() - began, store: store.kind };
      throw e;
    }
  }
  let passes = 0;
  let mode: 'realtime' | 'polling' = 'polling';
  try {
    if (cfg.liveTrading && (!state.geo || nowSec() - state.geo.t > 600)) {
      try {
        state.geo = { t: nowSec(), ...(await fetchGeoblock()) };
      } catch {
        /* keep the previous answer */
      }
    }
    let streamed = false;
    if (cfg.realtime && loopMs >= 20000 && typeof WebSocket !== 'undefined') {
      try {
        passes = await runStream(state, cfg, persist, began + loopMs, saveEvery, opts.signal, opts.onFrame, opts.onLive);
        streamed = true;
        mode = 'realtime';
      } catch (e) {
        log(state, 'warn', `Temps réel indisponible (${String((e as Error)?.message || e).slice(0, 100)})${opts.noFallback ? '' : ' : repli sur l’interrogation périodique'}.`);
        if (opts.noFallback) streamed = true;
      }
    }
    let lastSave = Date.now();
    while (!streamed && !opts.signal?.aborted) {
      const t = Date.now();
      await pass(state, cfg, persist);
      passes++;
      const next = t + cfg.intervalSeconds * 1000;
      if (next - began > loopMs) break;
      if (Date.now() - lastSave >= saveEvery * 1000) {
        lastSave = Date.now();
        await persist(); // keeps the dashboard current and the lock alive on long runs
      }
      await sleep(Math.max(0, next - Date.now()));
    }
    state.tickCount++;
    state.gate = computeGate(state, cfg);
  } catch (e) {
    log(state, 'error', `Erreur du moteur : ${String((e as Error)?.message || e).slice(0, 160)}`);
  }
  state.lock = undefined;
  try {
    await persist();
  } catch (e) {
    if (e instanceof ConflictError) return { ok: true, busy: true, passes, ms: Date.now() - began, store: store.kind };
    throw e;
  }
  return { ok: true, passes, mode, ms: Date.now() - began, store: store.kind };
}

export { liveBalance };
