import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/lib/config';
import { capSizes, deskLeader, deskPrices, evolveDesks, newMm, recentMove, seedDesks, onTrade, quoteSizes, settleMm, type Quotes } from '../src/lib/mm';
import { mulberry32 } from '../src/lib/math';
import { record } from '../src/lib/strategies';
import type { MmGenes, WindowRec } from '../src/lib/types';

const yours: MmGenes = { minPrice: 0.35, maxPrice: 0.9, minGain: 0.05, widen: 0 };

const win: WindowRec = { key: 'btc-300', asset: 'btc', start: 300, slug: 's', upToken: 'u', downToken: 'd', feeRate: 0.07, feeExp: 1, tickSize: 0.01, minSize: 5, negRisk: false, shadows: [], obs: [] };
const quotes = (): Quotes => ({ key: win.key, asset: 'btc', candle: 'green', sizes: { bid: 20, ask: 10 }, bid: { price: 0.5, left: 20, queue: 100 }, ask: { price: 0.51, left: 10, queue: 0 } });

test('candle colour sets the sizes: green buys double, red sells double', () => {
  assert.deepEqual(quoteSizes(100, 101, 10), { candle: 'green', bid: 20, ask: 10 });
  assert.deepEqual(quoteSizes(100, 99, 10), { candle: 'red', bid: 10, ask: 20 });
  assert.deepEqual(quoteSizes(100, 100, 10), { candle: 'flat', bid: 10, ask: 10 });
});

test('inventory cap: at the cap the desk only quotes the side that reduces its stock', () => {
  const green = { bid: 20, ask: 10 };
  assert.deepEqual(capSizes(green, 0, 20), { bid: 20, ask: 10 });
  assert.deepEqual(capSizes(green, 15, 20), { bid: 5, ask: 10 }); // room for 5 more Up only
  assert.deepEqual(capSizes(green, 20, 20), { bid: 0, ask: 10 }); // full of Up: only Down is asked for
  assert.deepEqual(capSizes({ bid: 10, ask: 20 }, -20, 20), { bid: 10, ask: 0 }); // full of Down
});

test('price band, minimum gain and volatility widening', () => {
  const top = { bid: 0.5, ask: 0.51 };
  assert.deepEqual(deskPrices(top, undefined, yours), { bid: 0.5, ask: 0.51, bidAllowed: true, askAllowed: true });
  // Out of the 35–90¢ band: no new stock (Up at 95¢, or Down at 5¢)
  const hi = deskPrices({ bid: 0.94, ask: 0.95 }, undefined, yours);
  assert.equal(hi.bidAllowed, false);
  assert.equal(hi.askAllowed, false);
  assert.equal(deskPrices({ bid: 0.2, ask: 0.21 }, undefined, yours).bidAllowed, false);
  // Holding Up bought at 50¢: only sell at 52.5¢ or more (rounded up), and closing is allowed even outside the band
  const held = deskPrices(top, { net: 10, avg: 0.5 }, yours);
  assert.equal(held.ask, 0.53);
  assert.equal(held.askAllowed, true);
  assert.equal(deskPrices({ bid: 0.95, ask: 0.96 }, { net: 10, avg: 0.5 }, yours).askAllowed, true);
  // Holding Down bought at 50¢: only buy Up back at 47.5¢ or less
  assert.equal(deskPrices(top, { net: -10, avg: 0.5 }, yours).bid, 0.47);
  // Agitated market (price moves 1.5¢ per 5 s): quotes 2 × 1.5 = 3¢ away from the best prices
  const wide = deskPrices(top, undefined, { ...yours, widen: 2 }, 0.015);
  assert.equal(wide.bid, 0.47);
  assert.equal(wide.ask, 0.54);
  assert.ok(Math.abs(recentMove([0.5, 0.51, 0.5, 0.51, 0.5, 0.51, 0.5, 0.51, 0.5, 0.51, 0.5], 5) - 0.01 * Math.sqrt(5)) < 1e-3);
});

test('desks: the leader is the best proven one, and the worst is replaced by a variant of it', () => {
  const desks = seedDesks(0);
  assert.equal(desks.length, 8);
  for (let i = 0; i < 30; i++) {
    record(desks[1].stats, 1 + (i % 3) * 0.1, 1, 0.99); // steady winner
    record(desks[0].stats, -2 + (i % 2), 1, 0.99); // steady loser
    for (const d of desks.slice(2)) record(d.stats, (i % 2) - 0.5, 1, 0.99);
  }
  assert.equal(deskLeader(desks)!.id, 'd1');
  const res = evolveDesks(desks, 1, mulberry32(3), 0)!;
  assert.equal(res.removed.id, 'd0');
  assert.equal(res.added.parent, 'd1');
  assert.equal(desks.length, 8);
  assert.ok(desks.every((d) => d.genes.maxPrice >= d.genes.minPrice + 0.2 - 1e-9));
});

test('the average cost follows what is held', () => {
  const cfg = config();
  const mm = newMm();
  const q = quotes();
  q.bid = { price: 0.5, left: 10, queue: 0 };
  onTrade(mm, cfg, q, win, 0.49, 5, true, 1); // bought 10 Up at 50¢
  assert.ok(Math.abs((mm.books[win.key].avg ?? 0) - 0.5) < 1e-9);
  q.bid = { price: 0.4, left: 10, queue: 0 };
  onTrade(mm, cfg, q, win, 0.39, 5, true, 2); // 10 more at 40¢
  assert.ok(Math.abs((mm.books[win.key].avg ?? 0) - 0.45) < 1e-9);
});

test('a resting order fills only when trades go through it or exhaust the queue ahead of it', () => {
  const cfg = config();
  const mm = newMm();
  const q = quotes();
  onTrade(mm, cfg, q, win, 0.5, 60, true, 1); // 60 sold at our bid: all absorbed by the 100 queued before us
  assert.equal(mm.fills, 0);
  onTrade(mm, cfg, q, win, 0.5, 50, true, 2); // 50 more: 40 finish the queue, 10 reach us
  assert.equal(mm.books[win.key].net, 10);
  onTrade(mm, cfg, q, win, 0.49, 5, true, 3); // a trade BELOW our bid: we were hit for everything left
  assert.equal(mm.books[win.key].net, 20);
  onTrade(mm, cfg, q, win, 0.51, 4, false, 4); // a buyer lifts our ask (nobody ahead of us)
  assert.equal(mm.books[win.key].net, 16);
  assert.ok(Math.abs(mm.books[win.key].cash - (-20 * 0.5 + 4 * 0.51)) < 1e-9);
  // No fee for the maker; 20% of the taker's fee (7% × p(1−p) per share) is credited as a reward.
  const expected = 0.2 * 0.07 * (0.25 * 20 + 0.51 * 0.49 * 4);
  assert.ok(Math.abs(mm.rewards - expected) < 1e-9);
  settleMm(mm, win.key, 'up', 700); // 16 Up shares left pay 1 each
  assert.ok(Math.abs(mm.pnl - (-10 + 2.04 + 16)) < 1e-9);
  assert.equal(mm.books[win.key], undefined);
});
