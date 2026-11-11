import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/lib/config';
import { capSizes, newMm, onTrade, quoteSizes, settleMm, type Quotes } from '../src/lib/mm';
import type { WindowRec } from '../src/lib/types';

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
