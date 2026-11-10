import { SYMBOL } from './config';
import type { Level } from './polymarket';
import type { Asset } from './types';

/**
 * Live market data over WebSocket. Reacting within a second is the only regime in which the
 * replayed strategies made money, so the real-time engine never polls: it keeps the spot price
 * and the full Polymarket order book in memory and reads them at decision time.
 */

const BINANCE_WS = 'wss://data-stream.binance.vision/stream';
const POLY_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

function connect(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(e as Error);
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error(`websocket timeout ${new URL(url).host}`));
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`websocket error ${new URL(url).host}`));
    };
  });
}

/** Trade-by-trade spot prices from Binance. */
export class SpotFeed {
  private ws: WebSocket | null = null;
  readonly last: Partial<Record<Asset, number>> = {};
  /** Volume and taker-buy volume since the last call to `drain`. */
  private acc: Record<Asset, { v: number; tb: number }> = { btc: { v: 0, tb: 0 }, eth: { v: 0, tb: 0 } };
  lastMsg = 0;
  closed = false;

  async start(assets: Asset[], timeoutMs = 5000): Promise<void> {
    const bySymbol = new Map(assets.map((a) => [SYMBOL[a], a]));
    const streams = assets.map((a) => `${SYMBOL[a].toLowerCase()}@trade`).join('/');
    const ws = (this.ws = await connect(`${BINANCE_WS}?streams=${streams}`, timeoutMs));
    ws.onmessage = (m) => {
      this.lastMsg = Date.now();
      try {
        const d = JSON.parse(String(m.data)).data;
        const asset = bySymbol.get(d?.s);
        if (!asset) return;
        const price = Number(d.p);
        const qty = Number(d.q);
        if (!(price > 0)) return;
        this.last[asset] = price;
        this.acc[asset].v += qty;
        if (d.m === false) this.acc[asset].tb += qty; // buyer was the taker
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => (this.closed = true);
    ws.onerror = () => (this.closed = true);
  }

  drain(asset: Asset): { v: number; tb: number } {
    const a = this.acc[asset];
    this.acc[asset] = { v: 0, tb: 0 };
    return a;
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {}
  }
}

interface LocalBook {
  bids: Map<string, number>;
  asks: Map<string, number>;
  ready: boolean;
}

/** Full order books for a set of Polymarket tokens, kept current from snapshots and level updates. */
export class BookFeed {
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private books = new Map<string, LocalBook>();
  lastMsg = 0;
  closed = false;

  constructor(readonly tokens: string[]) {
    for (const t of tokens) this.books.set(t, { bids: new Map(), asks: new Map(), ready: false });
  }

  async start(timeoutMs = 5000): Promise<void> {
    const ws = (this.ws = await connect(POLY_WS, timeoutMs));
    ws.onmessage = (m) => {
      this.lastMsg = Date.now();
      const text = String(m.data);
      if (text[0] !== '{' && text[0] !== '[') return; // PONG
      try {
        const parsed = JSON.parse(text);
        for (const ev of Array.isArray(parsed) ? parsed : [parsed]) this.apply(ev);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => (this.closed = true);
    ws.onerror = () => (this.closed = true);
    ws.send(JSON.stringify({ assets_ids: this.tokens, type: 'market' }));
    this.ping = setInterval(() => {
      try {
        ws.send('PING');
      } catch {}
    }, 8000);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private apply(ev: any) {
    if (Array.isArray(ev?.bids) && Array.isArray(ev?.asks)) {
      const b = this.books.get(ev.asset_id);
      if (!b) return;
      b.bids = new Map(ev.bids.map((l: { price: string; size: string }) => [l.price, Number(l.size)]));
      b.asks = new Map(ev.asks.map((l: { price: string; size: string }) => [l.price, Number(l.size)]));
      b.ready = true;
      return;
    }
    if (Array.isArray(ev?.price_changes)) {
      for (const c of ev.price_changes) {
        const b = this.books.get(c.asset_id);
        if (!b) continue;
        const side = c.side === 'BUY' ? b.bids : b.asks;
        const size = Number(c.size);
        if (size > 0) side.set(c.price, size);
        else side.delete(c.price);
      }
    }
  }

  ready(): boolean {
    return !this.closed && this.tokens.every((t) => this.books.get(t)?.ready);
  }

  /** Ask levels, best (lowest) first. */
  asks(token: string): Level[] {
    const b = this.books.get(token);
    if (!b) return [];
    const out: Level[] = [];
    for (const [p, size] of b.asks) {
      const price = Number(p);
      if (size > 0 && price > 0 && price < 1) out.push({ price, size });
    }
    return out.sort((x, y) => x.price - y.price);
  }

  best(token: string): { ask: number | null; bid: number | null } {
    const b = this.books.get(token);
    if (!b) return { ask: null, bid: null };
    let ask = Infinity;
    let bid = -Infinity;
    for (const [p, size] of b.asks) if (size > 0 && Number(p) < ask) ask = Number(p);
    for (const [p, size] of b.bids) if (size > 0 && Number(p) > bid) bid = Number(p);
    return { ask: Number.isFinite(ask) ? ask : null, bid: Number.isFinite(bid) ? bid : null };
  }

  close() {
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    try {
      this.ws?.close();
    } catch {}
  }
}
