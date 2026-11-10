import { ASSETS, WINDOW, config, type Config } from './config';
import { liveBalance, liveConfigured, placeLiveBuy } from './live';
import { mulberry32, round } from './math';
import { computeFeatures, fairProb, featureVector, learn, newModel, predict } from './model';
import { feePerShare, fetchBook, fetchGeoblock, fetchOutcome, fetchWindow, simulateBuy, type Book } from './polymarket';
import { getSeries, strikeOf, windowStartOf } from './prices';
import { ConflictError, getStore, type Store } from './store';
import { FAMILY_LABEL, emptyStats, evaluate, evolve, pickChampion, record, score, seedGenomes, type Signal } from './strategies';
import type { Account, Asset, GateCheck, LogEntry, Side, State, Strategy, Trade, WindowRec } from './types';

const nowSec = () => Date.now() / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const newAccount = (bankroll: number): Account => ({ startBankroll: bankroll, bankroll, trades: [], equity: [], nSettled: 0, nWins: 0, fees: 0, staked: 0, pnl: 0 });

export function initState(cfg: Config, now = nowSec()): State {
  const strategies: Strategy[] = seedGenomes().map((genes, i) => ({ id: `g0-${i}`, gen: 0, genes, stats: emptyStats(), bornAt: now, bornWindow: 0 }));
  return {
    version: 1,
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
    log: [{ t: now, level: 'info', msg: 'Système initialisé : 24 stratégies en observation.' }],
    recent: [],
  };
}

export function log(state: State, level: LogEntry['level'], msg: string, now = nowSec()) {
  const last = state.log[0];
  if (last && last.msg === msg && now - last.t < 600) return;
  state.log.unshift({ t: now, level, msg });
  if (state.log.length > 120) state.log.length = 120;
}

// ------------------------------------------------------------------ safety gate

const dayStart = (now: number) => Math.floor(now / 86400) * 86400;

export function recentDemoRoi(state: State, n = 50): { roi: number; count: number } {
  const done = state.demo.trades.filter((t) => t.status === 'won' || t.status === 'lost').slice(0, n);
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

async function processAsset(state: State, cfg: Config, asset: Asset, persist: () => Promise<void>): Promise<void> {
  const t0 = nowSec();
  const start = windowStartOf(t0);
  const key = `${asset}-${start}`;
  let win: WindowRec | undefined = state.windows[key];
  if (!win) {
    const fetched = await fetchWindow(asset, start);
    if (!fetched) {
      log(state, 'warn', `Marché ${asset.toUpperCase()} introuvable pour la fenêtre en cours.`);
      return;
    }
    win = state.windows[key] = fetched;
  }

  const [series, bookUp, bookDown] = await Promise.all([getSeries(asset), fetchBook(win.upToken), fetchBook(win.downToken)]);
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
    sigma: f.sigma, source: series.source, askUp: up.ask, askDown: down.ask, bidUp: up.bid, mid, qFair: round(qFair), qModel: qModel === null ? null : round(qModel),
  };
  if (mid === null || !x) return;

  // Training sample for the online model (labelled when the window settles).
  const lastObs = win.obs[win.obs.length - 1];
  if (f.elapsed >= 5 && f.elapsed <= 290 && win.obs.length < 9 && (!lastObs || f.elapsed - lastObs.elapsed >= 28)) {
    win.obs.push({ elapsed: Math.round(f.elapsed), x: x.map((v) => round(v)), mid: round(mid), qFair: round(qFair) });
  }

  // Never act on a stale or degraded price feed, or on a broken book.
  const fresh = series.source === 'binance' && now - series.last.t < 6;
  const sane = up.ask !== null && down.ask !== null && up.ask + down.ask >= 0.97 && up.ask + down.ask <= 1.12;
  if (!fresh || !sane || f.elapsed > 292) return;

  const quote = { askUp: up.ask, askDown: down.ask, mid, feeRate: win.feeRate, feeExp: win.feeExp };
  const traded = new Set(win.shadows.map((s) => s.sid));
  for (const strat of state.strategies) {
    if (traded.has(strat.id)) continue;
    const sig = evaluate(strat.genes, f, quote, qModel);
    if (!sig) continue;
    const asks = sig.side === 'up' ? bookUp.asks : bookDown.asks;
    const cap = Math.min(0.99, sig.ask + 0.02);
    const fill = simulateBuy(asks, cfg.shadowStake, win.feeRate, win.feeExp, cap);
    if (!fill) continue;
    win.shadows.push({ sid: strat.id, side: sig.side, cost: round(fill.cost / fill.shares), q: round(sig.q), elapsed: Math.round(f.elapsed) });

    if (strat.id !== state.championId || state.control.killSwitch) continue;
    if (!win.demoTradeId) openDemo(state, cfg, win, strat, sig, asks, cap, now);
    if (!win.liveTradeId && computeGate(state, cfg, now).every((g) => g.ok)) {
      await openLive(state, cfg, win, strat, sig, cap, now, persist);
    }
  }
}

function openDemo(state: State, cfg: Config, win: WindowRec, strat: Strategy, sig: Signal, asks: Book['asks'], cap: number, now: number) {
  const c = sig.ask + feePerShare(sig.ask, win.feeRate, win.feeExp);
  // Fractional Kelly: bet a quarter of what the edge theoretically justifies, capped.
  const kelly = Math.max(0, (sig.q - c) / (1 - c));
  const stake = state.demo.bankroll * Math.min(cfg.maxStakePct, cfg.kellyFraction * kelly);
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

async function openLive(state: State, cfg: Config, win: WindowRec, strat: Strategy, sig: Signal, cap: number, now: number, persist: () => Promise<void>) {
  const id = `l-${win.key}`;
  // Reserve the slot and save BEFORE sending, so a crash can never cause a double order.
  win.liveTradeId = id;
  await persist();
  // Saving also picks up the latest dashboard controls: re-check before sending.
  if (state.control.killSwitch || !state.control.liveArmed) return;
  const maxPrice = Math.min(cap, sig.ask + cfg.liveMaxSlippage);
  const res = await placeLiveBuy(cfg, { tokenId: sig.side === 'up' ? win.upToken : win.downToken, usd: cfg.liveStakeUsd, maxPrice, tickSize: win.tickSize, negRisk: win.negRisk });
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
      const strat = state.strategies.find((s) => s.id === sh.sid);
      if (strat) record(strat.stats, sh.side === outcome ? (1 - sh.cost) / sh.cost : -1, cfg.ewDecay);
    }
    learn(state.models[win.asset], win.obs, outcome === 'up' ? 1 : 0, cfg.learningRate);
  }
  for (const acct of [state.demo, state.live]) {
    for (const t of acct.trades) if (t.windowStart === win.start && t.asset === win.asset) settleTrade(acct, t, outcome, now);
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
        outcome = await fetchOutcome(w.asset, w.start);
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
  state.championId = pickChampion(state.strategies, prev, cfg.championMinTrades);
  if (state.championId !== prev) {
    const c = state.strategies.find((s) => s.id === state.championId);
    log(state, 'evolve', c ? `Nouveau champion : ${c.id} (${FAMILY_LABEL[c.genes.family]}), ROI moyen ${(score(c.stats).mean * 100).toFixed(1)} % sur ${c.stats.n} trades.` : 'Plus aucun champion : aucune stratégie rentable, le système reste à l’écart.', now);
  }
  if (state.settledWindows - state.lastEvolveAt >= cfg.evolveEvery) {
    state.lastEvolveAt = state.settledWindows;
    state.generation++;
    const res = evolve(state.strategies, state.generation, state.settledWindows, state.championId, mulberry32(Math.floor(now)), now);
    state.strategies = res.population;
    if (res.added.length) log(state, 'evolve', `Génération ${state.generation} : ${res.removed.length} stratégie(s) retirée(s) (${res.removed.map((s) => s.id).join(', ')}), remplacée(s) par des variantes des meilleures.`, now);
  }
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
  ms: number;
  store: Store['kind'];
}

export async function runTick(opts: { loopSeconds?: number } = {}): Promise<TickResult> {
  const cfg = config();
  const store = getStore();
  const began = Date.now();
  const id = Math.random().toString(36).slice(2, 10);
  let { state, etag } = await store.read();
  if (!state) state = initState(cfg);
  if (state.lock && nowSec() - state.lock.at < 58) return { ok: true, busy: true, passes: 0, ms: 0, store: store.kind };

  // Saves the state. The dashboard may have changed the controls meanwhile:
  // in that case adopt its controls and save again, as long as we still hold the lock.
  const persist = async () => {
    state!.updatedAt = nowSec();
    try {
      etag = await store.write(state!, etag);
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      const fresh = await store.read();
      if (!locked || !fresh.state || fresh.state.lock?.id !== id) throw e;
      applyControl(state!, cfg, fresh.state.control);
      etag = await store.write(state!, fresh.etag);
    }
  };
  applyControl(state, cfg, state.control);
  const loopMs = Math.max(0, (opts.loopSeconds ?? cfg.loopSeconds) * 1000);
  // A lock is taken (one extra write) whenever the run is long or real money is involved.
  // Short paper-only runs rely on the final compare-and-swap instead: if two overlap, one is dropped.
  const locked = loopMs > 0 || liveConfigured(cfg);
  if (locked) {
    state.lock = { at: nowSec(), id };
    try {
      state.updatedAt = nowSec();
      etag = await store.write(state, etag);
    } catch (e) {
      if (e instanceof ConflictError) return { ok: true, busy: true, passes: 0, ms: Date.now() - began, store: store.kind };
      throw e;
    }
  }
  let passes = 0;
  try {
    if (cfg.liveTrading && (!state.geo || nowSec() - state.geo.t > 600)) {
      try {
        state.geo = { t: nowSec(), ...(await fetchGeoblock()) };
      } catch {
        /* keep the previous answer */
      }
    }
    do {
      const t = Date.now();
      await pass(state, cfg, persist);
      passes++;
      const next = t + cfg.intervalSeconds * 1000;
      if (next - began > loopMs) break;
      await sleep(Math.max(0, next - Date.now()));
    } while (true);
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
  return { ok: true, passes, ms: Date.now() - began, store: store.kind };
}

export { liveBalance };
