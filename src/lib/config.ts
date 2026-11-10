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
  championMinTrades: num('CHAMPION_MIN_TRADES', 15),
  // --- self-improvement
  population: 24,
  evolveEvery: num('EVOLVE_EVERY_WINDOWS', 48),
  ewDecay: 0.99,
  learningRate: num('MODEL_LEARNING_RATE', 0.03),
  // --- tick loop
  loopSeconds: num('TICK_LOOP_SECONDS', 50),
  intervalSeconds: Math.max(3, num('TICK_INTERVAL_SECONDS', 10)),
  // --- production (real money)
  liveTrading: bool('LIVE_TRADING'),
  privateKey: process.env.POLYMARKET_PRIVATE_KEY || '',
  funder: process.env.POLYMARKET_FUNDER_ADDRESS || '',
  signatureType: num('POLYMARKET_SIGNATURE_TYPE', 1),
  liveStakeUsd: num('LIVE_STAKE_USD', 5),
  liveMaxDailyLoss: num('LIVE_MAX_DAILY_LOSS', 25),
  liveMinTrades: num('LIVE_MIN_TRADES', 100),
  liveMinTstat: num('LIVE_MIN_TSTAT', 2),
  liveMaxSlippage: num('LIVE_MAX_SLIPPAGE', 0.02),
  // --- auth
  cronSecret: process.env.CRON_SECRET || '',
  adminToken: process.env.ADMIN_TOKEN || '',
});

export type Config = ReturnType<typeof config>;
