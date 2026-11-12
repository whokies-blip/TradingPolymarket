import type { Config } from './config';
import type { Exchange } from './mmlive';
import { CLOB } from './polymarket';

/**
 * Real-money execution on Polymarket's order book.
 * Loaded lazily: nothing here runs unless production trading is configured,
 * armed, and the safety gate is open.
 */

export const keyConfigured = (cfg: Config) => /^(0x)?[0-9a-fA-F]{64}$/.test(cfg.privateKey);
export const liveConfigured = (cfg: Config) => cfg.liveTrading && keyConfigured(cfg);
/** Production market making is configured (it has its own switch, MM_LIVE). */
export const mmLiveConfigured = (cfg: Config) => cfg.mmLive && keyConfigured(cfg);

export interface LiveOrder {
  ok: boolean;
  orderId?: string;
  shares?: number;
  /** Cash paid (buy) or received (sell). */
  cost?: number;
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cached: Promise<any> | null = null;

async function client(cfg: Config) {
  if (!cached) {
    cached = (async () => {
      const { ClobClient } = await import('@polymarket/clob-client');
      const { createWalletClient, http } = await import('viem');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { polygon } = await import('viem/chains');
      const pk = (cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`) as `0x${string}`;
      const account = privateKeyToAccount(pk);
      const wallet = createWalletClient({ account, chain: polygon, transport: http() });
      const funder = cfg.funder || account.address;
      const sigType = cfg.funder ? cfg.signatureType : 0;
      const envCreds =
        process.env.POLYMARKET_API_KEY && process.env.POLYMARKET_API_SECRET && process.env.POLYMARKET_API_PASSPHRASE
          ? { key: process.env.POLYMARKET_API_KEY, secret: process.env.POLYMARKET_API_SECRET, passphrase: process.env.POLYMARKET_API_PASSPHRASE }
          : null;
      const creds = envCreds ?? (await new ClobClient(CLOB, 137, wallet).createOrDeriveApiKey());
      return new ClobClient(CLOB, 137, wallet, creds, sigType, funder);
    })();
    cached.catch(() => (cached = null));
  }
  return cached;
}

/** USDC available to trade, or null if it cannot be read. */
export async function liveBalance(cfg: Config): Promise<number | null> {
  try {
    const c = await client(cfg);
    const { AssetType } = await import('@polymarket/clob-client');
    const r = await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    return Number(r.balance) / 1e6;
  } catch {
    return null;
  }
}

/**
 * Sell `shares` of one outcome, fill-or-kill, never below `minPrice`. Returns the cash received.
 */
export async function placeLiveSell(
  cfg: Config,
  o: { tokenId: string; shares: number; minPrice: number; tickSize: number; negRisk: boolean },
): Promise<LiveOrder> {
  try {
    const c = await client(cfg);
    const { Side, OrderType } = await import('@polymarket/clob-client');
    const res = await c.createAndPostMarketOrder(
      { tokenID: o.tokenId, amount: Math.floor(o.shares * 100) / 100, side: Side.SELL, price: Math.max(0.01, o.minPrice) },
      { tickSize: String(o.tickSize), negRisk: o.negRisk },
      OrderType.FOK,
    );
    if (!res || res.success === false || res.error || !res.orderID) {
      return { ok: false, error: String(res?.errorMsg || res?.error || 'ordre refusé').slice(0, 200) };
    }
    // For a sale the order "makes" shares and "takes" cash.
    const shares = Number(res.makingAmount);
    const cost = Number(res.takingAmount);
    if (!(cost > 0) || !(shares > 0)) return { ok: false, orderId: res.orderID, error: `ordre non exécuté (${res.status ?? 'statut inconnu'})` };
    return { ok: true, orderId: res.orderID, cost, shares };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e).slice(0, 200) };
  }
}

/**
 * Buy `usd` dollars of one outcome, fill-or-kill, never paying above `maxPrice`.
 * Either the whole order fills immediately or nothing happens.
 */
export async function placeLiveBuy(
  cfg: Config,
  o: { tokenId: string; usd: number; maxPrice: number; tickSize: number; negRisk: boolean },
): Promise<LiveOrder> {
  try {
    const c = await client(cfg);
    const { Side, OrderType } = await import('@polymarket/clob-client');
    const res = await c.createAndPostMarketOrder(
      { tokenID: o.tokenId, amount: Math.floor(o.usd * 100) / 100, side: Side.BUY, price: o.maxPrice },
      { tickSize: String(o.tickSize), negRisk: o.negRisk },
      OrderType.FOK,
    );
    if (!res || res.success === false || res.error || !res.orderID) {
      return { ok: false, error: String(res?.errorMsg || res?.error || 'ordre refusé').slice(0, 200) };
    }
    const cost = Number(res.makingAmount);
    const shares = Number(res.takingAmount);
    if (!(cost > 0) || !(shares > 0)) return { ok: false, orderId: res.orderID, error: `ordre non exécuté (${res.status ?? 'statut inconnu'})` };
    return { ok: true, orderId: res.orderID, cost, shares };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e).slice(0, 200) };
  }
}

/**
 * The real exchange for production market making: post-only limit orders that expire on their own
 * (GTD), order status, and cancellation by id (never "cancel all", which would touch other orders).
 */
export function liveExchange(cfg: Config): Exchange {
  return {
    async place(o) {
      try {
        const c = await client(cfg);
        const { Side, OrderType } = await import('@polymarket/clob-client');
        const res = await c.createAndPostOrder(
          { tokenID: o.tokenId, price: o.price, size: o.size, side: o.side === 'BUY' ? Side.BUY : Side.SELL, expiration: Math.floor(o.expiresAt) },
          { tickSize: String(o.tickSize), negRisk: o.negRisk },
          OrderType.GTD,
          false,
          true, // post-only: rejected rather than executed as a taker
        );
        if (!res || res.success === false || res.error || !res.orderID) return { ok: false, error: String(res?.errorMsg || res?.error || 'ordre refusé').slice(0, 200) };
        return { ok: true, id: res.orderID };
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message || e).slice(0, 200) };
      }
    },
    async status(id) {
      try {
        const c = await client(cfg);
        const o = await c.getOrder(id);
        if (!o || !o.id) return null;
        return { matched: Number(o.size_matched) || 0, open: String(o.status).toLowerCase() === 'live' };
      } catch {
        return null;
      }
    },
    async cancel(ids) {
      if (!ids.length) return;
      const c = await client(cfg);
      await c.cancelOrders(ids);
    },
  };
}
