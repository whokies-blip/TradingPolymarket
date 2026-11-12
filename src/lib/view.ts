import { config } from './config';
import { computeGate, recentDemoRoi } from './engine';
import { liveConfigured } from './live';
import type { Store } from './store';
import { deskLeader } from './mm';
import { FAMILY_LABEL, describe, score } from './strategies';
import type { State } from './types';

const fin = (x: number) => (Number.isFinite(x) ? x : null);

/** What the dashboard is allowed to see: no secrets, no bulky training data. */
export function publicView(state: State, store: Store) {
  const cfg = config();
  const now = Date.now() / 1000;
  const strategies = state.strategies
    .map((s) => {
      const sc = score(s.stats);
      return {
        id: s.id, gen: s.gen, parent: s.parent ?? null, family: s.genes.family, familyLabel: FAMILY_LABEL[s.genes.family], summary: describe(s.genes),
        n: s.stats.n, wins: s.stats.wins, signals: s.stats.signals ?? 0, edge: s.stats.n >= 2 ? sc.mean : null, se: s.stats.n >= 2 ? fin(sc.se) : null,
        recent: s.stats.n >= 2 ? sc.recent : null, roi: s.stats.n >= 2 ? sc.roi : null, tstat: s.stats.n >= 2 ? fin(sc.tstat) : null, champion: s.id === state.championId,
      };
    })
    .sort((a, b) => Number(b.champion) - Number(a.champion) || (b.tstat ?? -99) - (a.tstat ?? -99) || b.n - a.n);
  const account = (a: State['demo']) => ({ ...a, trades: a.trades.slice(0, 60), open: a.trades.filter((t) => t.status === 'open').length });
  return {
    now,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    tickCount: state.tickCount,
    generation: state.generation,
    settledWindows: state.settledWindows,
    nextEvolveIn: Math.max(0, cfg.evolveEvery - (state.settledWindows - state.lastEvolveAt)),
    championId: state.championId,
    strategies,
    demo: { ...account(state.demo), recentRoi: recentDemoRoi(state) },
    live: account(state.live),
    models: state.models,
    control: { killSwitch: state.control.killSwitch, liveArmed: state.control.liveArmed },
    snapshots: state.snapshots,
    gate: computeGate(state, cfg, now),
    log: state.log.slice(0, 60),
    tape: (state.tape ?? []).slice(0, 240),
    ...(() => {
      const leader = deskLeader(state.desks) ?? state.desks[0];
      const m = leader.mm;
      return {
        mm: { ...m, recent: m.recent.slice(0, 20), stockUp: Object.values(m.books).reduce((n, b) => n + Math.max(0, b.net), 0), stockDown: Object.values(m.books).reduce((n, b) => n + Math.max(0, -b.net), 0),
          leader: leader.id, genes: leader.genes, enabled: cfg.mmEnabled, refill: cfg.mmRefill, maxStock: cfg.mmMaxStock, size: cfg.mmSize, seconds: cfg.mmSeconds, rebate: cfg.mmRebate },
        desks: state.desks.map((d) => {
          const sc = score(d.stats);
          return { id: d.id, gen: d.gen, parent: d.parent ?? null, genes: d.genes, markets: d.stats.n, perMarket: d.stats.n ? d.stats.sum / d.stats.n : null, tstat: d.stats.n >= 2 ? fin(sc.tstat) : null,
            total: d.mm.pnl + d.mm.rewards, rewards: d.mm.rewards, fills: d.mm.fills, volume: d.mm.volume, leader: d.id === leader.id };
        }).sort((a, b) => Number(b.leader) - Number(a.leader) || (b.perMarket ?? -99) - (a.perMarket ?? -99)),
        nextDeskEvolveIn: Math.max(0, cfg.mmEvolveEvery - (state.settledWindows - state.desksEvolvedAt)),
      };
    })(),
    recent: state.recent.slice(0, 40),
    settings: {
      liveTrading: cfg.liveTrading, liveConfigured: liveConfigured(cfg), liveStakeUsd: cfg.liveStakeUsd, liveMaxDailyLoss: cfg.liveMaxDailyLoss,
      adminRequired: !!cfg.adminToken, managed: !!process.env.LOCAL_RUNNER, store: store.kind, durable: store.durable, kellyFraction: cfg.kellyFraction, maxStakePct: cfg.maxStakePct,
      loopSeconds: cfg.loopSeconds, intervalSeconds: cfg.intervalSeconds, championMinTrades: cfg.championMinTrades, championZ: cfg.championZ,
      liveMinTrades: cfg.liveMinTrades, liveMinTstat: cfg.liveMinTstat,
    },
  };
}

export type View = ReturnType<typeof publicView>;
