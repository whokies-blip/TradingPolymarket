/**
 * Replays the engine's decision + learning logic over historical markets.
 * Usage: npx tsx scripts/replay.ts <grid.json>
 * Each market holds a 10-second grid of tradable quotes and model inputs.
 */
import { readFileSync } from 'fs';
import { config } from '../src/lib/config';
import { applyFills, decide, initState, improve, settleWindow } from '../src/lib/engine';
import { fairProb, featureVector, predict, type Features } from '../src/lib/model';
import { score } from '../src/lib/strategies';
import type { WindowRec } from '../src/lib/types';

interface Point { el: number; ask: number; bid: number; ask2: number | null; bid2: number | null; z: number; m60: number; m300: number; m900: number; flow: number; sigma: number; spot: number; strike: number }
interface Market { start: number; up: 0 | 1; g: Point[] }

const markets: Market[] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const cfg = config();
const state = initState(cfg, markets[0].start);
let champWindows = 0;
let champChanges = 0;
let lastChamp: string | null = null;
let minBank = cfg.demoBankroll;
const FEE = 0.07;
let signals = 0;
let fills = 0;
let shadowN = 0;
let shadowPnl = 0;

for (const m of markets) {
  const win: WindowRec = { key: `btc-${m.start}`, asset: 'btc', start: m.start, slug: '', upToken: 'u', downToken: 'd', feeRate: FEE, feeExp: 1, tickSize: 0.01, minSize: 5, negRisk: false, strike: m.g[0]?.strike, shadows: [], obs: [] };
  state.windows[win.key] = win;
  if (state.championId) champWindows++;
  const model = state.models.btc;
  for (const p of m.g) {
    const f: Features = { elapsed: p.el, spot: p.spot, strike: p.strike, sigma: p.sigma, z: p.z, mom60: p.m60, mom300: p.m300, mom900: p.m900, flow: p.flow };
    const mid = (p.ask + p.bid) / 2;
    const askDown = 1 - p.bid;
    const x = featureVector(f, mid);
    const qModel = model.n >= 200 ? predict(model, x) : null;
    const last = win.obs[win.obs.length - 1];
    if (p.el >= 5 && p.el <= 290 && win.obs.length < 9 && (!last || p.el - last.elapsed >= 28)) win.obs.push({ elapsed: p.el, x, mid, qFair: fairProb(f.z) });
    if (p.ask + askDown < 0.97 || p.ask + askDown > 1 + cfg.maxSpread + 0.02) continue;
    const pending = decide(state, cfg, win, f, { askUp: p.ask, askDown, mid, feeRate: FEE, feeExp: 1 }, qModel);
    if (pending.length === 0) continue;
    signals += pending.length;
    // The order arrives ~2 seconds later: fill only at the price that was tradable then.
    const before = win.shadows.length;
    applyFills(state, cfg, win, pending, p.ask2 === null ? [] : [{ price: p.ask2, size: 1e6 }], p.bid2 === null ? [] : [{ price: 1 - p.bid2, size: 1e6 }], m.start + p.el + 2);
    fills += win.shadows.length - before;
  }
  for (const sh of win.shadows) { shadowN++; shadowPnl += (sh.side === (m.up ? 'up' : 'down') ? 1 : 0) - sh.cost; }
  settleWindow(state, cfg, win, m.up ? 'up' : 'down', m.start + 400);
  improve(state, cfg, m.start + 400);
  if (state.championId !== lastChamp) { champChanges++; lastChamp = state.championId; }
  minBank = Math.min(minBank, state.demo.bankroll);
}

const d = state.demo;
console.log(`markets ${markets.length} | generations ${state.generation}`);
console.log(`paper orders: ${signals} attempted, ${fills} filled (${((fills / Math.max(signals, 1)) * 100).toFixed(0)}%) | all strategies together: ${(shadowPnl / Math.max(shadowN, 1) * 100).toFixed(2)}¢ per share over ${shadowN} trades`);
console.log(`champion active in ${((champWindows / markets.length) * 100).toFixed(0)}% of markets, ${champChanges} champion changes`);
console.log(`DEMO: ${d.nSettled} trades, win ${(d.nSettled ? (d.nWins / d.nSettled) * 100 : 0).toFixed(0)}%, staked ${d.staked.toFixed(0)} $, P&L ${d.pnl.toFixed(2)} $ (${d.staked ? ((d.pnl / d.staked) * 100).toFixed(1) : '0'}% of stakes), final ${d.bankroll.toFixed(2)} $, lowest ${minBank.toFixed(2)} $`);
console.log(`model: n=${state.models.btc.n} log-loss market ${state.models.btc.llMarket.toFixed(3)} fair ${state.models.btc.llFair.toFixed(3)} learned ${state.models.btc.llModel.toFixed(3)}`);
const all = state.strategies.filter((s) => s.stats.n > 0).sort((a, b) => b.stats.n - a.stats.n).slice(0, 8);
for (const s of all) { const sc = score(s.stats); console.log(`  ${s.id.padEnd(8)} ${s.genes.family.padEnd(10)} n=${String(s.stats.n).padStart(4)} edge=${(sc.mean * 100).toFixed(1)}¢/share t=${sc.tstat.toFixed(2)}`); }
