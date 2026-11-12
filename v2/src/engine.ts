import type { makeAlerts } from './alerts';
import { WINDOW, type Config } from './config';
import { capSizes, deskLeader, deskPrices, evolveDesks, onTrade, quoteSizes, recentMove, seedDesks, settleMm, stopHit, stopOut, type Quotes } from './desks';
import { Heartbeat, keyConfigured, liveExchange, openOrders, UserFeed } from './exchange';
import { BookFeed, SpotFeed } from './feeds';
import { mulberry32, round } from './math';
import { metrics } from './metrics';
import { fetchGeoblock, fetchOutcome, fetchWindows } from './polymarket';
import { applyOrderUpdate, cancelOrders, liveDesk, mmLiveGate, mmLiveStep, newMmLive, settleLive, type Exchange } from './prodesk';
import { record, score } from './stats';
import type { Store } from './store';
import type { Asset, LogEntry, MmLiveState, Side, State, WindowRec } from './types';

const nowSec = () => Date.now() / 1000;
const windowStartOf = (t: number) => Math.floor(t / WINDOW) * WINDOW;

export function initState(now = nowSec()): State {
  return {
    version: 2, createdAt: now, desks: seedDesks(now), desksEvolvedAt: 0, settledWindows: 0, mmLive: newMmLive(),
    control: { liveArmed: false }, log: [{ t: now, level: 'info', msg: 'Moteur v2 initialisé : tenue de marché.' }], recent: [],
  };
}

/** A light frame of what the engine sees, sent to dashboards several times a second. */
export interface Frame {
  t: number;
  windowStart: number;
  spot: number | null;
  books: Record<'up' | 'down', { asks: [number, number][]; bids: [number, number][] }> | null;
  inventory: { desk: string; net: number; avg: number | null; unrealized: number | null; buyUp: string | null; buyDown: string | null }[];
  live: { orders: { token: Side; side: string; price: number; left: number }[]; books: { up: number; down: number; cost: number }[] };
}

export class Engine {
  state: State;
  private spot = new SpotFeed();
  private book: BookFeed | null = null;
  private bookStart = -1;
  private rolling = false;
  /** Last reason the Polymarket market data could not be reached; null once it works. */
  private feedError: { t: number; msg: string } | null = null;
  private rollAfter = 0;
  private rollDelay = 2000;
  private windows = new Map<string, WindowRec>();
  private settledKeys = new Set<string>();
  private quotes = new Map<string, Partial<Record<Asset, Quotes>>>();
  private mids: Record<Asset, number[]> = { btc: [], eth: [] };
  private midSecond = 0;
  private lastCandle = 0;
  private lastSettle = 0;
  private lastSave = 0;
  private lastFrame = 0;
  private lastGeo = 0;
  private liveBusy = false;
  private reconciled = false;
  private ex: Exchange;
  private heartbeat: Heartbeat;
  private userFeed: UserFeed | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  readonly startedAt = Date.now();
  readonly listeners = new Set<(type: 'frame' | 'view', data: unknown) => void>();

  constructor(private cfg: Config, private store: Store, private alert: ReturnType<typeof makeAlerts>) {
    this.state = store.loadState() ?? initState();
    this.ex = liveExchange(cfg);
    this.heartbeat = new Heartbeat(cfg, (msg) => {
      this.log('error', msg);
      void this.alert(msg);
    });
  }

  log(level: LogEntry['level'], msg: string) {
    const t = nowSec();
    if (this.state.log.slice(0, 8).some((l) => l.msg === msg && t - l.t < 600)) return;
    this.state.log.unshift({ t, level, msg });
    if (this.state.log.length > 150) this.state.log.length = 150;
    console.log(`[${level}] ${msg}`);
  }

  readonly owner = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  save() {
    const t = performance.now();
    this.store.saveState(this.state);
    this.store.refreshLock(this.owner);
    metrics.add('save_ms', performance.now() - t);
    this.lastSave = Date.now();
  }

  async start() {
    await this.spot.start(this.cfg.mmAssets);
    // Real orders left from a previous run: read their last fills, then cancel them before anything else.
    if (this.state.mmLive.orders.length) {
      this.log('warn', `${this.state.mmLive.orders.length} ordre(s) réel(s) d’une exécution précédente : lecture et annulation.`);
      await cancelOrders(this.state.mmLive, this.ex, [...this.state.mmLive.orders], nowSec()).catch((e) => this.log('error', `annulation au démarrage : ${String(e?.message || e)}`));
      this.save();
    }
    this.timer = setInterval(() => void this.loop(), 100);
    this.log('info', 'Moteur v2 démarré.');
  }

  /** Graceful stop: cancel every real order, save, close feeds. */
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    try {
      if (this.state.mmLive.orders.length) await cancelOrders(this.state.mmLive, this.ex, [...this.state.mmLive.orders], nowSec());
    } catch (e) {
      this.log('error', `annulation à l’arrêt : ${String((e as Error)?.message || e)}`);
    }
    this.heartbeat.stop();
    this.userFeed?.stop();
    this.spot.close();
    this.book?.close();
    this.save();
    this.store.releaseLock(this.owner);
  }

  setArmed(armed: boolean) {
    this.state.control.liveArmed = armed;
    this.log(armed ? 'warn' : 'info', armed ? 'Production ARMÉE.' : 'Production désarmée.');
    this.save();
  }

  /** Switch one desk on or off. A desk switched off cancels its quotes at once; stock it holds settles at expiry. */
  setDeskEnabled(id: string, on: boolean): boolean {
    const d = this.state.desks.find((x) => x.id === id);
    if (!d) return false;
    d.off = !on;
    if (!on) this.quotes.delete(id);
    this.log('info', `Bureau ${id} ${on ? 'activé' : 'désactivé'}.`);
    this.save();
    return true;
  }

  resetSimulation() {
    // Real-money records are never wiped.
    const live: MmLiveState = this.state.mmLive;
    const fresh = initState();
    this.state = { ...fresh, mmLive: live, control: this.state.control, geo: this.state.geo };
    this.quotes.clear();
    this.log('info', 'Simulation remise à zéro.');
    this.save();
  }

  // ------------------------------------------------------------------ market catalogue

  private async ensureWindows(start: number) {
    const missing = this.cfg.mmAssets.flatMap((a) => Array.from({ length: 13 }, (_, i) => ({ a, s: start + i * WINDOW }))).filter((x) => !this.windows.has(`${x.a}-${x.s}`));
    if (missing.length < 6 && this.cfg.mmAssets.every((a) => this.windows.has(`${a}-${start}`))) return;
    for (const a of this.cfg.mmAssets) {
      const want = missing.filter((x) => x.a === a).map((x) => x.s);
      if (!want.length) continue;
      for (const w of await fetchWindows(a, want)) this.windows.set(w.key, w);
    }
  }

  private async roll(start: number) {
    await this.ensureWindows(start);
    const wins = this.cfg.mmAssets.map((a) => this.windows.get(`${a}-${start}`)).filter((w): w is WindowRec => !!w);
    if (!wins.length) throw new Error('aucun marché disponible');
    const next = new BookFeed(wins.flatMap((w) => [w.upToken, w.downToken]));
    await next.start();
    this.book?.close();
    this.book = next;
    this.bookStart = start;
    this.rollDelay = 2000;
    this.feedError = null;
    if (!this.reconciled) {
      this.reconciled = true;
      void this.reconcileOpenOrders();
    }
    // The private channel follows our markets.
    if (this.cfg.mmLive && keyConfigured(this.cfg) && this.state.control.liveArmed) this.ensureUserFeed(wins);
  }

  private ensureUserFeed(wins: WindowRec[]) {
    if (this.userFeed) return;
    this.userFeed = new UserFeed(
      this.cfg,
      (e) => {
        if (applyOrderUpdate(this.state.mmLive, e, nowSec())) {
          this.store.audit('order_update', e);
          this.save();
        }
      },
      () => {
        // After any (re)connection the channel does not replay missed changes: force a REST poll.
        this.state.mmLive.lastPollAt = 0;
      },
    );
    void this.userFeed.start(wins.map((w) => w.conditionId).filter((x): x is string => !!x)).catch((e) => {
      this.userFeed = null;
      this.log('error', `canal privé : ${String(e?.message || e)}`);
    });
  }

  // ------------------------------------------------------------------ main loop

  private busy = false;

  private async loop() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    const t0 = performance.now();
    try {
      await this.tick();
    } catch (e) {
      this.log('error', `moteur : ${String((e as Error)?.message || e).slice(0, 160)}`);
    } finally {
      metrics.add('loop_ms', performance.now() - t0);
      this.busy = false;
    }
  }

  private async tick() {
    const cfg = this.cfg;
    const now = nowSec();
    const start = windowStartOf(now);
    if (this.spot.closed) {
      this.spot = new SpotFeed();
      await this.spot.start(cfg.mmAssets).catch(() => this.log('warn', 'flux de prix Binance : reconnexion…'));
    }
    const feed = this.book;
    if ((this.bookStart !== start || !feed || feed.closed) && !this.rolling && Date.now() >= this.rollAfter) {
      this.rolling = true;
      this.rollAfter = Date.now() + this.rollDelay;
      this.rollDelay = Math.min(this.rollDelay * 2, 60000);
      void this.roll(start)
        .catch((e) => {
          const msg = String(e?.message || e).slice(0, 160);
          if (this.feedError?.msg !== msg) this.log('warn', `carnet Polymarket : ${msg}`);
          this.feedError = { t: nowSec(), msg };
        })
        .finally(() => (this.rolling = false));
    }
    const ready = feed && this.bookStart === start && feed.ready() ? feed : null;
    if (ready) this.runDesks(ready, now, start);
    if (ready && cfg.mmLive) this.runProduction(ready, now, start);
    if (now - this.lastSettle >= 10) {
      this.lastSettle = now;
      void this.settle(now);
    }
    if (now - this.lastGeo > 600) {
      this.lastGeo = now;
      fetchGeoblock().then((g) => (this.state.geo = { t: nowSec(), ...g })).catch(() => {});
    }
    if (Date.now() - this.lastSave >= 10000) this.save();
    if (Date.now() - this.lastFrame >= 200 && this.listeners.size) {
      this.lastFrame = Date.now();
      const frame = this.frame(now, start);
      for (const l of this.listeners) l('frame', frame);
    }
  }

  private quotesOf(id: string) {
    let q = this.quotes.get(id);
    if (!q) this.quotes.set(id, (q = {}));
    return q;
  }

  /** The simulated desks: same logic as v1, now driven by a permanent loop. */
  private runDesks(feed: BookFeed, now: number, start: number) {
    const cfg = this.cfg;
    const sec = Math.floor(now);
    const newSecond = sec !== this.midSecond;
    if (newSecond) {
      this.midSecond = sec;
      for (const a of cfg.mmAssets) {
        const w = this.windows.get(`${a}-${start}`);
        const top = w ? feed.best(w.upToken) : null;
        if (top?.ask != null && top.bid != null) this.mids[a].push((top.ask + top.bid) / 2);
        if (this.mids[a].length > 31) this.mids[a].splice(0, this.mids[a].length - 31);
      }
    }
    // 1. Trades that just happened fill the desks' resting quotes.
    const trades = feed.drainTrades();
    for (const d of this.state.desks) {
      const dq = this.quotesOf(d.id);
      for (const tr of trades) {
        for (const a of cfg.mmAssets) {
          const q = dq[a];
          const w = q ? this.windows.get(q.key) : undefined;
          if (!q || !w || w.start !== start) continue;
          if (tr.token === w.upToken) onTrade(d.mm, cfg, q, w, tr.price, tr.size, !tr.takerBuy, now);
          else if (tr.token === w.downToken) onTrade(d.mm, cfg, q, w, 1 - tr.price, tr.size, tr.takerBuy, now);
        }
      }
    }
    // 2. Stops, once a second.
    if (newSecond) {
      for (const d of this.state.desks) {
        if (!(d.genes.stopLoss > 0)) continue;
        for (const a of cfg.mmAssets) {
          const w = this.windows.get(`${a}-${start}`);
          const top = w ? feed.best(w.upToken) : null;
          if (!w || top?.ask == null || top.bid == null) continue;
          const book = d.mm.books[w.key];
          if (!stopHit(book, (top.ask + top.bid) / 2, d.genes.stopLoss)) continue;
          const side = book!.net > 0 ? w.upToken : w.downToken;
          if (stopOut(d.mm, w.key, a, feed.bids(side), w, this.quotesOf(d.id)[a]?.candle ?? 'flat', now) !== null) this.quotesOf(d.id)[a] = undefined;
        }
      }
    }
    // 3. Re-post filled orders at once.
    if (cfg.mmRefill) {
      for (const d of this.state.desks) {
        const dq = this.quotesOf(d.id);
        for (const a of cfg.mmAssets) {
          const q = dq[a];
          const w = q ? this.windows.get(q.key) : undefined;
          if (!q || !w || w.start !== start || now - start < d.genes.startAt || now - start > d.genes.stopAt) continue;
          const top = feed.best(w.upToken);
          if (top.ask === null || top.bid === null || top.ask - top.bid > 0.05 || top.bid < 0.05 || top.ask > 0.95) continue;
          const book = d.mm.books[w.key];
          const room = capSizes(q.sizes, book?.net ?? 0, d.genes.maxStock);
          const px = deskPrices({ bid: top.bid, ask: top.ask }, book, d.genes, recentMove(this.mids[a], cfg.mmSeconds));
          if (q.bid && q.bid.left <= 0 && room.bid > 0 && px.bidAllowed) q.bid = { price: px.bid, left: room.bid, queue: feed.sizeAt(w.upToken, 'bid', px.bid) };
          if (q.ask && q.ask.left <= 0 && room.ask > 0 && px.askAllowed) q.ask = { price: px.ask, left: room.ask, queue: feed.sizeAt(w.upToken, 'ask', px.ask) };
        }
      }
    }
    // 4. Candle close: cancel and re-quote everything.
    const candle = Math.floor(now / cfg.mmSeconds);
    if (candle === this.lastCandle) return;
    this.lastCandle = candle;
    for (const a of cfg.mmAssets) {
      const w = this.windows.get(`${a}-${start}`);
      const el = now - start;
      const open = this.spot.priceAt(a, sec - cfg.mmSeconds);
      const close = this.spot.last[a];
      const top = w ? feed.best(w.upToken) : null;
      const usable = !!w && !!top && top.ask !== null && top.bid !== null && !!open && !!close && el >= 10 && el <= 285 && top.ask - top.bid <= 0.05 && top.bid >= 0.05 && top.ask <= 0.95;
      const size = usable ? quoteSizes(open!, close!, cfg.mmSize) : null;
      const vol = recentMove(this.mids[a], cfg.mmSeconds);
      for (const d of this.state.desks) {
        const dq = this.quotesOf(d.id);
        dq[a] = undefined;
        if (d.off || !usable || !size || el < d.genes.startAt || el > d.genes.stopAt) continue;
        const book = d.mm.books[w!.key];
        const capped = capSizes(size, book?.net ?? 0, d.genes.maxStock);
        const px = deskPrices({ bid: top!.bid!, ask: top!.ask! }, book, d.genes, vol);
        dq[a] = {
          key: w!.key, asset: a, candle: size.candle, sizes: { bid: size.bid, ask: size.ask },
          bid: { price: px.bid, left: px.bidAllowed ? capped.bid : 0, queue: feed.sizeAt(w!.upToken, 'bid', px.bid) },
          ask: { price: px.ask, left: px.askAllowed ? capped.ask : 0, queue: feed.sizeAt(w!.upToken, 'ask', px.ask) },
        };
      }
    }
  }

  liveGate(now = nowSec()) {
    const w = this.windows.get(`btc-${windowStartOf(now)}`);
    const top = w && this.book ? this.book.best(w.upToken) : null;
    const upMid = top?.ask != null && top.bid != null ? (top.ask + top.bid) / 2 : null;
    return mmLiveGate(this.state, this.cfg, keyConfigured(this.cfg), now, upMid);
  }

  /** The production desk: real orders, only when every condition holds. */
  private runProduction(feed: BookFeed, now: number, start: number) {
    const cfg = this.cfg;
    const L = this.state.mmLive;
    if (this.liveBusy || (!L.orders.length && !this.state.control.liveArmed)) return;
    const a: Asset = 'btc';
    const w = this.windows.get(`${a}-${start}`) ?? null;
    const top = w ? feed.best(w.upToken) : null;
    const usable = !!top && top.ask !== null && top.bid !== null && top.ask - top.bid <= 0.05 && top.bid >= 0.05 && top.ask <= 0.95;
    const gateOpen = this.liveGate(now).every((g) => g.ok);
    // The dead-man switch runs while the desk may hold orders; when it stops, Polymarket cancels them.
    if (gateOpen) this.heartbeat.start();
    const desk = liveDesk(this.state, cfg);
    const open = this.spot.priceAt(a, Math.floor(now) - cfg.mmSeconds);
    const close = this.spot.last[a];
    const before = { orders: L.orders.length, fills: L.fills.length };
    const t0 = performance.now();
    this.liveBusy = true;
    void mmLiveStep({
      state: this.state, cfg, ex: this.ex, now, gateOpen, win: w, genes: desk?.genes ?? null,
      top: usable ? { bid: top!.bid!, ask: top!.ask! } : null, vol: recentMove(this.mids[a], cfg.mmSeconds),
      sizes: open && close ? quoteSizes(open, close, cfg.mmSize) : null,
    })
      .then(() => {
        // Anything that touched real money is written at once.
        if (L.orders.length !== before.orders || L.fills.length !== before.fills) {
          metrics.add('production_step_ms', performance.now() - t0);
          this.store.audit('live_step', { orders: L.orders.map((o) => ({ id: o.id, token: o.token, side: o.side, price: o.price, size: o.size, matched: o.matched })), fills: L.fills.slice(0, Math.max(0, L.fills.length - before.fills)) });
          this.save();
        }
        if (!gateOpen && !L.orders.length) this.heartbeat.stop();
        if (L.lastError && now - L.lastError.t < 1) void this.alert(`production : ${L.lastError.msg}`);
      })
      .finally(() => (this.liveBusy = false));
  }

  // ------------------------------------------------------------------ settlement & evolution

  private settling = false;

  private async settle(now: number) {
    if (this.settling) return;
    this.settling = true;
    try {
      const keys = new Set<string>();
      for (const w of this.windows.values()) if (now > w.start + WINDOW + 45) keys.add(w.key);
      for (const d of this.state.desks) for (const k of Object.keys(d.mm.books)) keys.add(k);
      for (const k of Object.keys(this.state.mmLive.books)) keys.add(k);
      for (const key of keys) {
        if (this.settledKeys.has(key)) continue;
        const [asset, s] = key.split('-');
        const start = Number(s);
        if (!(now > start + WINDOW + 45)) continue;
        const w = this.windows.get(key);
        let outcome: Side | 'void' | null = null;
        try {
          outcome = await fetchOutcome(asset as Asset, start, w?.conditionId);
        } catch {
          /* retry later */
        }
        if (!outcome && now > start + WINDOW + 3600) outcome = 'void';
        if (!outcome) continue;
        this.settleKey(key, asset as Asset, start, outcome, now);
      }
      // Forget catalogue entries well in the past.
      for (const [k, w] of this.windows) if (now > w.start + WINDOW + 7200) this.windows.delete(k);
    } finally {
      this.settling = false;
    }
  }

  settleKey(key: string, asset: Asset, start: number, outcome: Side | 'void', now: number) {
    this.settledKeys.add(key);
    const hadLive = !!this.state.mmLive.books[key];
    settleLive(this.state.mmLive, key, outcome, now);
    if (hadLive) this.store.audit('settle', { key, outcome, pnl: this.state.mmLive.pnl });
    for (const d of this.state.desks) {
      const r = settleMm(d.mm, key, outcome, now);
      if (outcome !== 'void') record(d.stats, r, 1, this.cfg.ewDecay);
    }
    this.state.settledWindows++;
    this.state.recent.unshift({ key, asset, start, outcome });
    if (this.state.recent.length > 60) this.state.recent.length = 60;
    if (this.state.settledWindows - this.state.desksEvolvedAt >= this.cfg.mmEvolveEvery) {
      this.state.desksEvolvedAt = this.state.settledWindows;
      const res = evolveDesks(this.state.desks, this.state.settledWindows, mulberry32(Math.floor(now)), now);
      if (res) this.log('info', `Évolution : ${res.removed.id} remplacé par ${res.added.id}, variante de ${res.added.parent}.`);
    }
    // Daily loss getting close to the limit: warn.
    const L = this.state.mmLive;
    if (hadLive && L.dayPnl <= -0.8 * this.cfg.mmLiveMaxDailyLoss) void this.alert(`perte du jour ${L.dayPnl.toFixed(2)} $ (limite ${this.cfg.mmLiveMaxDailyLoss} $)`);
    this.save();
  }

  // ------------------------------------------------------------------ views

  frame(now: number, start: number): Frame {
    const w = this.windows.get(`btc-${start}`);
    const feed = this.book && this.bookStart === start ? this.book : null;
    const depth = (token: string) => ({
      asks: feed ? feed.asks(token).slice(0, 6).map((l) => [l.price, Math.round(l.size)] as [number, number]) : [],
      bids: feed ? feed.bids(token).slice(0, 6).map((l) => [l.price, Math.round(l.size)] as [number, number]) : [],
    });
    const top = w && feed ? feed.best(w.upToken) : null;
    const mid = top?.ask != null && top.bid != null ? (top.ask + top.bid) / 2 : null;
    return {
      t: now,
      windowStart: start,
      spot: this.spot.last.btc ?? null,
      books: w && feed ? { up: depth(w.upToken), down: depth(w.downToken) } : null,
      inventory: this.state.desks.map((d) => {
        const b = w ? d.mm.books[w.key] : undefined;
        const q = this.quotes.get(d.id)?.btc;
        return {
          desk: d.id, net: round(b?.net ?? 0, 2), avg: b?.avg && b.net ? round(b.avg, 4) : null,
          unrealized: b && mid !== null ? round(b.cash + b.net * mid + (b.rew ?? 0), 2) : b ? null : 0,
          buyUp: q?.bid && q.bid.left > 0 ? `${q.bid.left}@${q.bid.price.toFixed(2)}` : null,
          buyDown: q?.ask && q.ask.left > 0 ? `${q.ask.left}@${(1 - q.ask.price).toFixed(2)}` : null,
        };
      }),
      live: {
        orders: this.state.mmLive.orders.map((o) => ({ token: o.token, side: o.side, price: o.price, left: round(o.size - o.matched, 2) })),
        books: Object.values(this.state.mmLive.books).map((b) => ({ up: round(b.up, 2), down: round(b.down, 2), cost: round(b.cost, 2) })),
      },
    };
  }

  view() {
    const now = nowSec();
    const leader = deskLeader(this.state.desks);
    const L = this.state.mmLive;
    return {
      now,
      uptime: Math.round((Date.now() - this.startedAt) / 1000),
      feedError: this.feedError, geo: this.state.geo ?? null,
      feeds: { binanceAgeMs: Date.now() - this.spot.lastMsg, polymarketAgeMs: this.book ? Date.now() - this.book.lastMsg : null, userChannel: this.userFeed?.connected ?? false, heartbeatAgeMs: this.heartbeat.lastOk ? Date.now() - this.heartbeat.lastOk : null },
      metrics: metrics.snapshot(),
      settledWindows: this.state.settledWindows,
      nextEvolveIn: Math.max(0, this.cfg.mmEvolveEvery - (this.state.settledWindows - this.state.desksEvolvedAt)),
      desks: this.state.desks.map((d) => {
        const sc = score(d.stats);
        return {
          id: d.id, parent: d.parent ?? null, genes: d.genes, markets: d.stats.n, perMarket: d.stats.n ? d.stats.sum / d.stats.n : null,
          se: Number.isFinite(sc.se) ? sc.se : null, tstat: d.stats.n >= 2 ? sc.tstat : null, total: d.mm.pnl + d.mm.rewards, rewards: d.mm.rewards,
          fills: d.mm.fills, leader: d.id === leader?.id, enabled: !d.off, recent: d.mm.recent.slice(0, 8),
        };
      }),
      live: {
        enabled: this.cfg.mmLive, armed: this.state.control.liveArmed, desk: liveDesk(this.state, this.cfg)?.id ?? null, gate: this.liveGate(now),
        pnl: L.pnl, dayPnl: L.day === Math.floor(now / 86400) ? L.dayPnl : 0, markets: L.markets, fills: L.fills.slice(0, 15), lastError: L.lastError ?? null,
        limits: { size: this.cfg.mmLiveSize, maxStock: this.cfg.mmLiveMaxStock, maxExposure: this.cfg.mmLiveMaxExposure, maxDailyLoss: this.cfg.mmLiveMaxDailyLoss, minMarkets: this.cfg.mmLiveMinMarkets, minTstat: this.cfg.mmLiveMinTstat },
        audit: this.store.recentAudit(10),
      },
      recent: this.state.recent.slice(0, 24),
      log: this.state.log.slice(0, 40),
    };
  }

  health() {
    const spotAge = Date.now() - this.spot.lastMsg;
    const bookAge = this.book ? Date.now() - this.book.lastMsg : null;
    return { ok: spotAge < 15000 && bookAge !== null && bookAge < 15000, uptime: Math.round((Date.now() - this.startedAt) / 1000), spotAgeMs: spotAge, bookAgeMs: bookAge, liveOrders: this.state.mmLive.orders.length, armed: this.state.control.liveArmed };
  }

  /** Startup check for real orders this key may still have on the current market (dedicated key assumed). */
  async reconcileOpenOrders() {
    if (!this.cfg.mmLive || !keyConfigured(this.cfg)) return;
    const w = this.windows.get(`btc-${windowStartOf(nowSec())}`);
    if (!w?.conditionId) return;
    try {
      const open = await openOrders(this.cfg, w.conditionId);
      const ours = new Set(this.state.mmLive.orders.map((o) => o.id));
      const strays = open.filter((o) => !ours.has(o.id)).map((o) => o.id);
      if (strays.length) {
        await this.ex.cancel(strays);
        this.log('warn', `${strays.length} ordre(s) ouvert(s) inconnu(s) sur le marché en cours annulé(s).`);
      }
    } catch (e) {
      this.log('warn', `réconciliation : ${String((e as Error)?.message || e).slice(0, 120)}`);
    }
  }
}
