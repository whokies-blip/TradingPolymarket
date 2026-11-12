import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/lib/config';
import { initState } from '../src/lib/engine';
import { mmLiveGate, mmLiveStep, recordFill, settleLive, wantedOrders, worstLoss, type Exchange } from '../src/lib/mmlive';
import type { MmGenes, WindowRec } from '../src/lib/types';

const g: MmGenes = { minPrice: 0.35, maxPrice: 0.95, minGain: 0.05, widen: 0, maxStock: 80, startAt: 10, stopAt: 270, stopLoss: 0 };
const win: WindowRec = { key: 'btc-300', asset: 'btc', start: 300, slug: 's', upToken: 'U', downToken: 'D', feeRate: 0.07, feeExp: 1, tickSize: 0.01, minSize: 5, negRisk: false, shadows: [], obs: [] };

function fakeExchange() {
  const book = new Map<string, { matched: number; open: boolean; o: Parameters<Exchange['place']>[0] }>();
  let n = 0;
  const ex: Exchange & { book: typeof book; cancelled: string[] } = {
    book,
    cancelled: [],
    async place(o) { const id = `o${++n}`; book.set(id, { matched: 0, open: true, o }); return { ok: true, id }; },
    async status(id) { const x = book.get(id); return x ? { matched: x.matched, open: x.open } : null; },
    async cancel(ids) { for (const id of ids) { const x = book.get(id); if (x) x.open = false; ex.cancelled.push(id); } },
  };
  return ex;
}

test('production desk: limits on purchases', () => {
  const cfg = { ...config(), mmLiveMaxStock: 10, mmLiveMaxExposure: 10 };
  const top = { bid: 0.5, ask: 0.51 };
  const w = wantedOrders(undefined, g, top, 0, { bid: 10, ask: 5 }, cfg, 5);
  assert.deepEqual(w.map((x) => [x.token, x.side, x.price, x.size]), [['up', 'BUY', 0.5, 10], ['down', 'BUY', 0.49, 5]]);
  // Already holding 8 Up: only 2 more allowed, below the 5-share minimum → no Up purchase; the Down side becomes a sale of Up
  const w2 = wantedOrders({ up: 8, down: 0, cost: 4, avgUp: 0.5, avgDown: 0 }, g, top, 0, { bid: 10, ask: 5 }, cfg, 5);
  assert.deepEqual(w2.map((x) => [x.token, x.side, x.size]), [['up', 'SELL', 5]]);
  assert.ok(w2[0].price >= 0.53); // at least +5% over the 50¢ paid
  // Worst case per market: 10 $ max. 18 Up bought at 55¢ = 9.9 $ at risk → no further purchase of Up
  const w3 = wantedOrders({ up: 0, down: 0, cost: 9.9, avgUp: 0, avgDown: 0 }, g, { bid: 0.55, ask: 0.56 }, 0, { bid: 10, ask: 10 }, cfg, 5);
  assert.equal(w3.filter((x) => x.side === 'BUY').length, 0);
  assert.ok(Math.abs(worstLoss({ up: 10, down: 10, cost: 9.8, avgUp: 0.5, avgDown: 0.48 }) + 0.2) < 1e-9); // both sides held: 1 $ per pair is certain
});

test('production desk: places, books fills, cancels when the gate closes, settles', async () => {
  const cfg = { ...config(), mmLive: true, mmLiveSize: 5 };
  const state = initState(cfg, 0);
  state.windows[win.key] = win;
  const ex = fakeExchange();
  const base = { state, cfg, ex, win, genes: g, top: { bid: 0.5, ask: 0.51 }, vol: 0, sizes: { bid: 20, ask: 10 } };
  await mmLiveStep({ ...base, now: 320, gateOpen: true });
  assert.equal(state.mmLive.orders.length, 2); // green candle: 10 Up and 5 Down at live size 5
  assert.deepEqual(state.mmLive.orders.map((o) => [o.token, o.side, o.size]), [['up', 'BUY', 10], ['down', 'BUY', 5]]);
  // The exchange fills 4 shares of the Up bid
  const upId = state.mmLive.orders.find((o) => o.token === 'up')!.id;
  ex.book.get(upId)!.matched = 4;
  await mmLiveStep({ ...base, now: 322, gateOpen: true });
  assert.equal(state.mmLive.books[win.key].up, 4);
  assert.ok(Math.abs(state.mmLive.books[win.key].cost - 2) < 1e-9);
  // Kill switch / disarm: the gate closes and everything is cancelled at once
  await mmLiveStep({ ...base, now: 323, gateOpen: false });
  assert.equal(state.mmLive.orders.length, 0);
  assert.equal(ex.cancelled.length, 2);
  // Up wins: 4 shares pay 4 $, they cost 2 $
  settleLive(state.mmLive, win.key, 'up', 700);
  assert.ok(Math.abs(state.mmLive.pnl - 2) < 1e-9);
});

test('production gate stays closed until every condition holds', () => {
  const cfg = { ...config(), mmLive: true, mmLiveMinMarkets: 300, mmLiveMinTstat: 2 };
  const state = initState(cfg, 0);
  const gate = mmLiveGate(state, cfg, true, 0, 0.5);
  assert.ok(gate.some((x) => !x.ok));
  assert.equal(gate.find((x) => x.id === 'armed')!.ok, false);
  assert.equal(gate.find((x) => x.id === 'proof')!.ok, false); // no simulated record yet
  // A day that already lost 20 $ closes the gate
  state.mmLive.day = 0;
  recordFill(state.mmLive, { id: 'x', key: 'k', asset: 'btc', token: 'up', side: 'BUY', price: 0.9, size: 25, matched: 0, placedAt: 0 }, 25, 0);
  settleLive(state.mmLive, 'k', 'down', 10);
  assert.equal(mmLiveGate(state, cfg, true, 10, 0.5).find((x) => x.id === 'loss')!.ok, false);
});
