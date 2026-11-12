import type { Asset } from './types';

const num = (name: string, def: number): number => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const bool = (name: string, def = false): boolean => {
  const v = process.env[name];
  return v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

export const SYMBOL: Record<Asset, string> = { btc: 'BTCUSDT', eth: 'ETHUSDT' };
export const WINDOW = 300;

export const config = () => ({
  port: num('PORT', 8080),
  adminToken: process.env.ADMIN_TOKEN || '',
  dbPath: process.env.DB_PATH || 'data/v2.db',
  // --- simulated desks
  mmAssets: (process.env.MM_ASSETS || 'btc').split(',').map((x) => x.trim()).filter((x): x is Asset => x === 'btc' || x === 'eth'),
  mmSize: num('MM_SIZE', 10),
  mmSeconds: Math.max(2, num('MM_CANDLE_SECONDS', 5)),
  mmRebate: num('MM_REBATE', 0.2),
  mmRefill: bool('MM_REFILL', true),
  mmEvolveEvery: num('MM_EVOLVE_EVERY_WINDOWS', 12),
  ewDecay: 0.99,
  // --- production (real money): off unless MM_LIVE=true, then armed from the dashboard
  mmLive: bool('MM_LIVE', false),
  mmLiveSize: num('MM_LIVE_SIZE', 5),
  mmLiveMaxStock: num('MM_LIVE_MAX_STOCK', 10),
  mmLiveMaxExposure: num('MM_LIVE_MAX_EXPOSURE', 10),
  mmLiveMaxDailyLoss: num('MM_LIVE_MAX_DAILY_LOSS', 20),
  mmLiveMinMarkets: num('MM_LIVE_MIN_MARKETS', 300),
  mmLiveMinTstat: num('MM_LIVE_MIN_TSTAT', 2),
  mmLiveDesk: process.env.MM_LIVE_DESK || '',
  /** How long an order may live on its own if the engine goes silent (Polymarket: at least ~2 minutes). */
  orderLifetime: Math.max(120, num('ORDER_LIFETIME_SECONDS', 120)),
  privateKey: process.env.POLYMARKET_PRIVATE_KEY || '',
  funder: process.env.POLYMARKET_FUNDER_ADDRESS || '',
  signatureType: num('POLYMARKET_SIGNATURE_TYPE', 1),
  apiKey: process.env.POLYMARKET_API_KEY || '',
  apiSecret: process.env.POLYMARKET_API_SECRET || '',
  apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE || '',
  // --- alerts
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChat: process.env.TELEGRAM_CHAT_ID || '',
});

export type Config = ReturnType<typeof config>;
