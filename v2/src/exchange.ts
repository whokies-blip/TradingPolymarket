import type { Config } from './config';
import { metrics } from './metrics';
import { CLOB } from './polymarket';
import type { Exchange } from './prodesk';

/**
 * Real-money connection to Polymarket for the production desk.
 *
 * Reliability measures, from Polymarket's documentation:
 *  - post-only GTD orders: never pay the taker fee, and expire on their own;
 *  - the order heartbeat (dead-man switch): sent every 5 s; if the engine goes silent for 10 s,
 *    Polymarket itself cancels every open order of this API key. Use a wallet/API key dedicated to
 *    this engine: the switch also cancels any order you place by hand with the same key;
 *  - our own executions pushed in real time on the private "user" channel, with REST polling kept as
 *    a fallback (the channel does not replay what was missed during a disconnection).
 */

export const keyConfigured = (cfg: Config) => /^(0x)?[0-9a-fA-F]{64}$/.test(cfg.privateKey);
export const liveConfigured = (cfg: Config) => cfg.mmLive && keyConfigured(cfg);

interface Creds {
  key: string;
  secret: string;
  passphrase: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cached: Promise<{ client: any; creds: Creds }> | null = null;

async function connect(cfg: Config) {
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
      const creds: Creds =
        cfg.apiKey && cfg.apiSecret && cfg.apiPassphrase
          ? { key: cfg.apiKey, secret: cfg.apiSecret, passphrase: cfg.apiPassphrase }
          : await new ClobClient(CLOB, 137, wallet).createOrDeriveApiKey();
      return { client: new ClobClient(CLOB, 137, wallet, creds, sigType, funder), creds };
    })();
    cached.catch(() => (cached = null));
  }
  return cached;
}

/** The exchange interface used by the production desk. */
export function liveExchange(cfg: Config): Exchange {
  return {
    async place(o) {
      try {
        const { client } = await connect(cfg);
        const { Side, OrderType } = await import('@polymarket/clob-client');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = await metrics.time('order_place_ms', () =>
          client.createAndPostOrder(
            { tokenID: o.tokenId, price: o.price, size: o.size, side: o.side === 'BUY' ? Side.BUY : Side.SELL, expiration: Math.floor(o.expiresAt) },
            { tickSize: String(o.tickSize), negRisk: o.negRisk },
            OrderType.GTD,
            false,
            true, // post-only
          ),
        );
        if (!res || res.success === false || res.error || !res.orderID) {
          metrics.count('order_rejected');
          return { ok: false, error: String(res?.errorMsg || res?.error || 'ordre refusé').slice(0, 200) };
        }
        metrics.count('order_placed');
        return { ok: true, id: res.orderID };
      } catch (e) {
        metrics.count('order_error');
        return { ok: false, error: String((e as Error)?.message || e).slice(0, 200) };
      }
    },
    async status(id) {
      try {
        const { client } = await connect(cfg);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const o: any = await metrics.time('order_status_ms', () => client.getOrder(id));
        if (!o || !o.id) return null;
        return { matched: Number(o.size_matched) || 0, open: String(o.status).toLowerCase() === 'live' };
      } catch {
        return null;
      }
    },
    async cancel(ids) {
      if (!ids.length) return;
      const { client } = await connect(cfg);
      await metrics.time('order_cancel_ms', () => client.cancelOrders(ids));
      metrics.count('order_cancelled', ids.length);
    },
  };
}

/** Open orders of this API key on one market (used to reconcile after a restart). */
export async function openOrders(cfg: Config, conditionId: string): Promise<{ id: string; asset_id: string; side: string; price: number; size: number; matched: number }[]> {
  const { client } = await connect(cfg);
  const list = (await client.getOpenOrders({ market: conditionId })) as { id: string; asset_id: string; side: string; price: string; original_size: string; size_matched: string }[];
  return (list || []).map((o) => ({ id: o.id, asset_id: o.asset_id, side: o.side, price: Number(o.price), size: Number(o.original_size), matched: Number(o.size_matched) || 0 }));
}

/**
 * Order heartbeat (dead-man switch). Once started it must keep running: Polymarket cancels every open
 * order of the key 10 s after the last accepted heartbeat. There is no way to switch it off; stopping
 * the loop simply lets that cancellation happen, which is the point.
 */
export class Heartbeat {
  private id: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  lastOk = 0;
  failures = 0;

  constructor(private cfg: Config, private onFailure: (msg: string) => void) {}

  start() {
    this.stopped = false;
    if (!this.timer) this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.stopped) return;
    try {
      const { client } = await connect(this.cfg);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await metrics.time('heartbeat_ms', () => client.postHeartbeat(this.id ?? undefined));
      if (res?.heartbeat_id) {
        this.id = res.heartbeat_id;
        this.lastOk = Date.now();
        this.failures = 0;
      } else if (res?.error_msg && res?.heartbeat_id === undefined) {
        throw new Error(String(res.error_msg));
      }
    } catch (e) {
      // A wrong id comes back with the expected one: adopt it and retry at once.
      const expected = (e as { response?: { data?: { heartbeat_id?: string } } })?.response?.data?.heartbeat_id;
      if (expected) this.id = expected;
      this.failures++;
      if (this.failures >= 2) this.onFailure(`heartbeat refusé ${this.failures} fois : ${String((e as Error)?.message || e).slice(0, 120)}`);
    }
    if (!this.stopped) this.timer = setTimeout(() => this.tick(), 5000);
  }
}

export interface UserOrderEvent {
  id: string;
  matched: number;
  status: string;
  /** Exchange time of the event, ms. */
  t: number;
}

/**
 * Private channel: updates of our own orders as they happen (placement, partial fill, cancellation).
 * Reconnects by itself; after a reconnect the engine re-reads order statuses over REST.
 */
export class UserFeed {
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  lastMsg = 0;
  connected = false;

  constructor(private cfg: Config, private onOrder: (e: UserOrderEvent) => void, private onReconnect: () => void) {}

  async start(markets: string[] = []) {
    this.stopped = false;
    const { creds } = await connect(this.cfg);
    const open = () => {
      if (this.stopped) return;
      const ws = (this.ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/user'));
      ws.onopen = () => {
        this.connected = true;
        ws.send(JSON.stringify({ auth: { apiKey: creds.key, secret: creds.secret, passphrase: creds.passphrase }, type: 'user', ...(markets.length ? { markets } : {}) }));
        this.ping = setInterval(() => {
          try {
            ws.send('PING');
          } catch {}
        }, 10000);
        this.onReconnect();
      };
      ws.onmessage = (m) => {
        this.lastMsg = Date.now();
        const text = String(m.data);
        if (text[0] !== '{' && text[0] !== '[') return;
        try {
          const parsed = JSON.parse(text);
          for (const ev of Array.isArray(parsed) ? parsed : [parsed]) {
            if (ev?.event_type === 'order' && ev.id) {
              const t = Number(ev.timestamp) || Date.now();
              metrics.add('user_feed_ms', Date.now() - t);
              this.onOrder({ id: ev.id, matched: Number(ev.size_matched) || 0, status: String(ev.status || ''), t });
            }
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      const retry = () => {
        this.connected = false;
        if (this.ping) clearInterval(this.ping);
        if (!this.stopped) setTimeout(open, 2000);
      };
      ws.onclose = retry;
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    };
    open();
  }

  stop() {
    this.stopped = true;
    if (this.ping) clearInterval(this.ping);
    try {
      this.ws?.close();
    } catch {}
  }
}
