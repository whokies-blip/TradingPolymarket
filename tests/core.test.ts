import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/lib/config';
import { computeGate, initState, settleWindow, improve } from '../src/lib/engine';
import { mulberry32, phi } from '../src/lib/math';
import { computeFeatures, fairProb, featureVector, learn, newModel, predict } from '../src/lib/model';
import { feePerShare, simulateBuy } from '../src/lib/polymarket';
import { strikeOf, twap, type Series } from '../src/lib/prices';
import { emptyStats, evaluate, evolve, pickChampion, record, score, seedGenomes } from '../src/lib/strategies';
import type { Strategy, WindowRec } from '../src/lib/types';

const flat = (start: number, n: number, price: (t: number) => number): Series => {
  const ticks = Array.from({ length: n }, (_, i) => ({ t: start + i, c: price(start + i), v: 1, tb: 0.5 }));
  return { source: 'binance', step: 1, ticks, sigma: 0.00006, last: ticks[n - 1] };
};

test('normal CDF', () => {
  assert.ok(Math.abs(phi(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(phi(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(phi(-1) + phi(1) - 1) < 1e-9);
});

test('taker fee peaks at 50¢: 7% × p(1−p)', () => {
  assert.ok(Math.abs(feePerShare(0.5, 0.07, 1) - 0.0175) < 1e-12);
  assert.ok(feePerShare(0.9, 0.07, 1) < feePerShare(0.5, 0.07, 1));
});

test('market buy walks the book, pays fees, respects the price cap', () => {
  const asks = [{ price: 0.5, size: 10 }, { price: 0.6, size: 100 }];
  const fill = simulateBuy(asks, 20, 0.07, 1)!;
  assert.ok(Math.abs(fill.cost - 20) < 1e-9);
  assert.ok(fill.shares > 10 && fill.price > 0.5 && fill.price < 0.6);
  assert.ok(Math.abs(fill.cost - (fill.shares * fill.price + fill.fee)) < 1e-9);
  const capped = simulateBuy(asks, 20, 0.07, 1, 0.55)!;
  assert.equal(capped.shares, 10);
  assert.equal(simulateBuy(asks, 20, 0.07, 1, 0.4), null);
});

test('strike is the 60s TWAP ending at the window open', () => {
  const s = flat(1000, 400, (t) => (t <= 1240 ? 100 : 200));
  assert.equal(strikeOf(s, 1240), 100);
  assert.equal(twap(s, 1240, 1300), 200);
  assert.equal(twap(s, 5000, 5060), null);
});

test('fair value: above strike → Up more likely, more so near the end', () => {
  const s = flat(1000, 600, (t) => (t <= 1300 ? 100 : 100.05));
  const early = computeFeatures(s, 1300, 100, 1330)!;
  const late = computeFeatures({ ...s }, 1300, 100, 1560)!;
  assert.ok(fairProb(early.z) > 0.5);
  assert.ok(fairProb(late.z) > fairProb(early.z));
  assert.ok(fairProb(early.z, 1.5) < fairProb(early.z));
});

test('a strategy only trades when the edge after fees clears its threshold', () => {
  const s = flat(1000, 600, (t) => (t <= 1300 ? 100 : 100.1));
  const f = computeFeatures(s, 1300, 100, 1400)!;
  const g = seedGenomes()[0];
  const q = fairProb(f.z, g.volMult);
  const cheap = evaluate(g, f, { askUp: q - 0.1, askDown: 1 - q + 0.11, mid: q - 0.105, feeRate: 0.07, feeExp: 1 }, null);
  assert.equal(cheap?.side, 'up');
  assert.ok(cheap!.edge > g.minEdge);
  const fairPriced = evaluate(g, f, { askUp: q, askDown: 1 - q + 0.01, mid: q - 0.005, feeRate: 0.07, feeExp: 1 }, null);
  assert.equal(fairPriced, null);
  assert.equal(evaluate(g, { ...f, elapsed: 299 }, { askUp: 0.3, askDown: 0.71, mid: 0.295, feeRate: 0.07, feeExp: 1 }, null), null);
});

const strat = (id: string, rois: number[]): Strategy => {
  const stats = emptyStats();
  rois.forEach((r) => record(stats, r, 0.99));
  return { id, gen: 0, genes: seedGenomes()[0], stats, bornAt: 0, bornWindow: 0 };
};
const alternating = (n: number, win: number) => Array.from({ length: n }, (_, i) => (i % 2 ? win : -1));

test('champion needs evidence and a positive record; otherwise stay flat', () => {
  const winner = strat('w', alternating(40, 1.4));
  const loser = strat('l', alternating(40, 0.6));
  const lucky = strat('lucky', [1, 1, 1]);
  assert.equal(pickChampion([loser, lucky], null, 15), null);
  assert.equal(pickChampion([winner, loser, lucky], null, 15), 'w');
  assert.ok(score(winner.stats).mean > 0 && score(loser.stats).mean < 0);
});

test('evolution retires losers, keeps the champion and the population size', () => {
  const pop = [strat('w', alternating(40, 1.4)), strat('l1', alternating(40, 0.5)), strat('l2', alternating(30, 0.2)), strat('new', [])];
  const res = evolve(pop, 1, 100, 'w', mulberry32(1), 0);
  assert.equal(res.population.length, pop.length);
  assert.ok(res.removed.length >= 1 && res.removed.every((s) => s.id.startsWith('l')));
  assert.ok(res.population.some((s) => s.id === 'w') && res.population.some((s) => s.id === 'new'));
  assert.ok(res.added.every((s) => s.stats.n === 0 && s.gen === 1));
});

test('online model learns a signal the market misses', () => {
  const m = newModel();
  const rand = mulberry32(7);
  for (let i = 0; i < 4000; i++) {
    const z = (rand() - 0.5) * 4;
    const up = rand() < phi(z) ? 1 : 0;
    const f = { elapsed: 150, spot: 1, strike: 1, sigma: 1, z, mom60: 0, mom300: 0, mom900: 0, flow: 0 };
    learn(m, [{ elapsed: 150, x: featureVector(f, 0.5), mid: 0.5, qFair: phi(z) }], up as 0 | 1, 0.05);
  }
  const f = { elapsed: 150, spot: 1, strike: 1, sigma: 1, z: 1.5, mom60: 0, mom300: 0, mom900: 0, flow: 0 };
  assert.ok(predict(m, featureVector(f, 0.5)) > 0.75);
  assert.ok(m.llModel < m.llMarket);
});

test('settlement: accounts, strategy stats and the production gate', () => {
  const cfg = config();
  const state = initState(cfg, 0);
  const win: WindowRec = {
    key: 'btc-300', asset: 'btc', start: 300, slug: 's', upToken: 'u', downToken: 'd', feeRate: 0.07, feeExp: 1, tickSize: 0.01, minSize: 5, negRisk: false, strike: 100,
    shadows: [{ sid: 'g0-0', side: 'up', cost: 0.5, q: 0.6, elapsed: 60 }, { sid: 'g0-1', side: 'down', cost: 0.5, q: 0.6, elapsed: 60 }], obs: [],
  };
  state.windows[win.key] = win;
  state.demo.trades.push({ id: 'd', mode: 'demo', asset: 'btc', windowStart: 300, slug: 's', side: 'up', shares: 20, price: 0.48, fee: 0.4, cost: 10, q: 0.6, edge: 0.1, strategyId: 'g0-0', openedAt: 1, status: 'open' });
  state.demo.bankroll -= 10;
  settleWindow(state, cfg, win, 'up', 700);
  assert.equal(state.demo.bankroll, cfg.demoBankroll + 10);
  assert.equal(state.demo.trades[0].status, 'won');
  assert.equal(state.demo.trades[0].pnl, 10);
  assert.equal(state.strategies[0].stats.wins, 1);
  assert.equal(state.strategies[1].stats.sumRoi, -1);
  assert.equal(state.windows[win.key], undefined);
  improve(state, cfg, 700);
  assert.equal(state.championId, null); // one win is not evidence
  const gate = computeGate(state, cfg, 700);
  assert.ok(gate.some((g) => !g.ok)); // real trading stays locked by default
  assert.equal(gate.find((g) => g.id === 'env')!.ok, false);
});
