import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config';
import { initState } from '../src/engine';
import { metrics } from '../src/metrics';
import { applyOrderUpdate, expiryFor, mmLiveStep, settleLive, wantedOrders, type Exchange } from '../src/prodesk';
import { Store } from '../src/store';
import type { MmGenes, WindowRec } from '../src/types';

const g: MmGenes = { minPrice: 0.35, maxPrice: 0.95, minGain: 0.05, widen: 0, maxStock: 80, startAt: 10, stopAt: 270, stopLoss: 0 };
const win: WindowRec = { key: 'btc-300', asset: 'btc', start: 300, slug: 's', upToken: 'U', downToken: 'D', feeRate: 0.07, feeExp: 1, tickSize: 0.01, minSize: 5, negRisk: false };

function fakeExchange() {
  const book = new Map<string, { matched: number; open: boolean; o: Parameters<Exchange['place']>[0] }>();
  let n = 0;
  const ex: Exchange & { book: typeof book } = {
    book,
    async place(o) { const id = `o${++n}`; book.set(id, { matched: 0, open: true, o }); return { ok: true, id }; },
    async status(id) { const x = book.get(id); return x ? { matched: x.matched, open: x.open } : null; },
    async cancel(ids) { for (const id of ids) { const x = book.get(id); if (x) x.open = false; } },
  };
  return ex;
}

test('orders expire at least 3 minutes ahead, as Polymarket requires', () => {
  assert.equal(expiryFor(1000, 120), 1180);
  assert.equal(expiryFor(1000.7, 30), 1180); // lifetime never below 120 s
  assert.ok(expiryFor(1000, 300) - 1000 >= 180);
});

test('production desk: orders placed with a valid expiry, fills pushed by the private channel are booked', async () => {
  const cfg = { ...config(), mmLive: true };
  const state = initState(0);
  const ex = fakeExchange();
  await mmLiveStep({ state, cfg, ex, now: 320, gateOpen: true, win, genes: g, top: { bid: 0.5, ask: 0.51 }, vol: 0, sizes: { bid: 20, ask: 10 } });
  assert.equal(state.mmLive.orders.length, 2);
  for (const x of ex.book.values()) assert.ok(x.o.expiresAt - 320 >= 180);
  const up = state.mmLive.orders.find((o) => o.token === 'up')!;
  // The private channel reports 6 shares filled, then the order fully filled
  assert.equal(applyOrderUpdate(state.mmLive, { id: up.id, matched: 6, status: 'LIVE' }, 321), true);
  assert.equal(state.mmLive.books[win.key].up, 6);
  applyOrderUpdate(state.mmLive, { id: up.id, matched: 10, status: 'MATCHED' }, 322);
  assert.equal(state.mmLive.books[win.key].up, 10);
  assert.equal(state.mmLive.orders.some((o) => o.id === up.id), false); // no longer resting
  assert.equal(state.mmLive.dirty, true); // re-quote at once
  assert.equal(applyOrderUpdate(state.mmLive, { id: 'unknown', matched: 5, status: 'LIVE' }, 323), false);
  settleLive(state.mmLive, win.key, 'down', 700); // 10 Up at 50¢ lost
  assert.ok(Math.abs(state.mmLive.pnl + 5) < 1e-9);
});

test('limits still hold in v2', () => {
  const cfg = { ...config(), mmLiveMaxStock: 10, mmLiveMaxExposure: 10 };
  const w = wantedOrders({ up: 8, down: 0, cost: 4, avgUp: 0.5, avgDown: 0 }, g, { bid: 0.5, ask: 0.51 }, 0, { bid: 10, ask: 5 }, cfg, 5);
  assert.deepEqual(w.map((x) => [x.token, x.side]), [['up', 'SELL']]);
});

test('SQLite store: state survives a restart, the real-money audit trail is kept', () => {
  const s = new Store(':memory:');
  assert.equal(s.loadState(), null);
  const st = initState(5);
  st.mmLive.pnl = 12.5;
  s.saveState(st);
  s.audit('settle', { key: 'btc-300', outcome: 'up' });
  assert.equal(s.loadState()!.mmLive.pnl, 12.5);
  assert.equal(s.recentAudit(5)[0].kind, 'settle');
  s.close();
});

test('single-instance lock: a second engine on the same data is refused', () => {
  const s = new Store(':memory:');
  assert.equal(s.acquireLock('a', 100).ok, true);
  const second = s.acquireLock('b', 110);
  assert.equal(second.ok, false);
  assert.equal(s.acquireLock('b', 140).ok, true); // the first one went silent for 40 s: abandoned
  s.close();
});

test('latency metrics: percentiles', () => {
  for (let i = 1; i <= 100; i++) metrics.add('test_ms', i);
  const m = metrics.snapshot().latency.test_ms;
  assert.equal(m.n, 100);
  assert.ok(m.p50 >= 50 && m.p50 <= 51 && m.p95 >= 95 && m.max === 100);
});

test('a desk switched off is never the leader, never evolved away, never copied by production', async () => {
  const { deskLeader, evolveDesks } = await import('../src/desks');
  const { liveDesk } = await import('../src/prodesk');
  const s = initState();
  s.desks.forEach((d, i) => { d.stats.n = 30; d.stats.sum = 30 * (i - 3); d.stats.sumSq = 30 * (i - 3) ** 2 + 30; });
  const best = s.desks[s.desks.length - 1];
  const worst = s.desks[0];
  assert.equal(deskLeader(s.desks)?.id, best.id);
  best.off = true;
  worst.off = true;
  assert.notEqual(deskLeader(s.desks)?.id, best.id);
  assert.notEqual(liveDesk(s, { ...config(), mmLiveDesk: best.id })?.id, best.id);
  const res = evolveDesks(s.desks, 99, () => 0.5, 0);
  assert.ok(res && res.removed.id !== worst.id && res.removed.id !== best.id);
  assert.ok(s.desks.includes(worst) && s.desks.includes(best));
});
