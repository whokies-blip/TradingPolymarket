import type { Asset } from './types';

const num = (name: string, def: number): number => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const bool = (name: string, def = false): boolean => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

export const ASSETS: Asset[] = ['btc', 'eth'];
export const SYMBOL: Record<Asset, string> = { btc: 'BTCUSDT', eth: 'ETHUSDT' };
export const COINBASE: Record<Asset, string> = { btc: 'BTC-USD', eth: 'ETH-USD' };
export const WINDOW = 300;
/** The market settles on a 60-second TWAP at both ends of the window. */
export const TWAP = 60;

export const config = () => ({
  // --- demo (paper) account
  demoBankroll: num('DEMO_BANKROLL', 1000),
  kellyFraction: num('KELLY_FRACTION', 0.25),
  maxStakePct: num('MAX_STAKE_PCT', 0.03),
  shadowStake: 10,
  /** A strategy only gets to trade once its record is this unlikely to be luck. */
  championMinTrades: num('CHAMPION_MIN_TRADES', 40),
  championZ: num('CHAMPION_Z', 2),
  /** Paper orders are re-checked against a fresh book after this delay, like a real order in transit. */
  confirmMs: num('FILL_CONFIRM_MS', 1500),
  slippage: num('MAX_SLIPPAGE', 0.01),
  maxSpread: num('MAX_SPREAD', 0.04),
  /** No new trades after this many seconds: the market out-forecasts us in the final minute. */
  lastEntry: num('LAST_ENTRY_SECONDS', 240),
  // --- self-improvement
  population: 24,
  evolveEvery: num('EVOLVE_EVERY_WINDOWS', 96),
  ewDecay: 0.99,
  learningRate: num('MODEL_LEARNING_RATE', 0.03),
  // --- tick loop
  loopSeconds: num('TICK_LOOP_SECONDS', 285),
  intervalSeconds: Math.max(3, num('TICK_INTERVAL_SECONDS', 10)),
  // --- real-time engine (WebSocket feeds); falls back to polling if unavailable
  realtime: bool('REALTIME', true),
  evalMs: Math.max(50, num('STREAM_EVAL_MS', 200)),
  /** Paper orders are checked against the live book this long after the decision (order travel time). */
  streamConfirmMs: num('STREAM_CONFIRM_MS', 500),
  /** Seconds between saves during a session. 0 = automatic: every 30 s, or only at the end of each
   *  session on Vercel Blob, whose free quota of writes is small. */
  persistSeconds: Math.max(0, num('PERSIST_SECONDS', 0)),
  // --- production (real money)
  liveTrading: bool('LIVE_TRADING'),
  privateKey: process.env.POLYMARKET_PRIVATE_KEY || '',
  funder: process.env.POLYMARKET_FUNDER_ADDRESS || '',
  signatureType: num('POLYMARKET_SIGNATURE_TYPE', 1),
  liveStakeUsd: num('LIVE_STAKE_USD', 5),
  liveMaxDailyLoss: num('LIVE_MAX_DAILY_LOSS', 25),
  liveMinTrades: num('LIVE_MIN_TRADES', 150),
  liveMinTstat: num('LIVE_MIN_TSTAT', 3),
  liveMaxSlippage: num('LIVE_MAX_SLIPPAGE', 0.02),
  // --- paper market making
  mmEnabled: bool('MM_ENABLED', true),
  mmSize: num('MM_SIZE', 10),
  /** Most shares the desk may hold on one side of one market; beyond it, it only quotes the other side. */
  mmMaxStock: num('MM_MAX_STOCK', 20),
  /** Re-post an order as soon as it is fully filled instead of waiting for the next candle.
   *  (On 4 days of history this filled more and lost more: −7.5 $ vs −5.8 $ per BTC market.) */
  mmRefill: bool('MM_REFILL', true),
  mmSeconds: Math.max(2, num('MM_CANDLE_SECONDS', 5)),
  mmRebate: num('MM_REBATE', 0.2),
  // --- auth
  cronSecret: process.env.CRON_SECRET || '',
  adminToken: process.env.ADMIN_TOKEN || '',
});

export type Config = ReturnType<typeof config>;
