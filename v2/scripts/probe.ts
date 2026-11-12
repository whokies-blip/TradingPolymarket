/**
 * Region probe: run it on a candidate server to see how close it is to the services the engine uses.
 *   npm run probe
 * Measures, 7 times each: TCP+TLS connection, an HTTP round trip, and the time to first message on the
 * WebSocket feeds. Also says whether Polymarket allows trading from this machine's address.
 */
import { connect } from 'node:tls';

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

function tlsConnect(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const t = performance.now();
    const s = connect({ host, port: 443, servername: host }, () => {
      resolve(performance.now() - t);
      s.end();
    });
    s.setTimeout(5000, () => {
      s.destroy();
      reject(new Error('timeout'));
    });
    s.on('error', reject);
  });
}

async function httpRtt(url: string): Promise<number> {
  await fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.arrayBuffer()); // warm the connection
  const t = performance.now();
  await fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.arrayBuffer());
  return performance.now() - t;
}

function wsFirst(url: string, subscribe?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const t = performance.now();
    const ws = new WebSocket(url);
    const timer = setTimeout(() => (ws.close(), reject(new Error('timeout'))), 8000);
    ws.onopen = () => subscribe && ws.send(subscribe);
    ws.onmessage = () => {
      clearTimeout(timer);
      resolve(performance.now() - t);
      ws.close();
    };
    ws.onerror = () => (clearTimeout(timer), reject(new Error('erreur')));
  });
}

async function measure(label: string, fn: () => Promise<number>, n = 7) {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    try {
      xs.push(await fn());
    } catch {}
  }
  console.log(`${label.padEnd(46)} ${xs.length ? `${median(xs).toFixed(0).padStart(5)} ms (médiane de ${xs.length})` : 'injoignable'}`);
}

const W = Math.floor(Date.now() / 1000 / 300) * 300;
const ev = (await fetch(`https://gamma-api.polymarket.com/events?slug=btc-updown-5m-${W}`).then((r) => r.json()).catch(() => [])) as { markets?: { clobTokenIds?: string }[] }[];
const tokens: string[] = ev?.[0]?.markets?.[0]?.clobTokenIds ? JSON.parse(ev[0].markets[0].clobTokenIds) : [];

console.log('Proximité de ce serveur avec les services utilisés par le moteur :\n');
await measure('Connexion TLS clob.polymarket.com', () => tlsConnect('clob.polymarket.com'));
await measure('Aller-retour HTTP clob.polymarket.com/time', () => httpRtt('https://clob.polymarket.com/time'));
await measure('Connexion TLS ws-subscriptions-clob.polymarket.com', () => tlsConnect('ws-subscriptions-clob.polymarket.com'));
if (tokens.length) await measure('1er message carnet Polymarket (WebSocket)', () => wsFirst('wss://ws-subscriptions-clob.polymarket.com/ws/market', JSON.stringify({ assets_ids: tokens, type: 'market' })), 3);
await measure('Connexion TLS data-stream.binance.vision', () => tlsConnect('data-stream.binance.vision'));
await measure('1er message prix Binance (WebSocket)', () => wsFirst('wss://data-stream.binance.vision/stream?streams=btcusdt@trade'), 3);
await measure('Aller-retour HTTP gamma-api.polymarket.com', () => httpRtt(`https://gamma-api.polymarket.com/events?slug=btc-updown-5m-${W}`));
try {
  const g = (await fetch('https://polymarket.com/api/geoblock').then((r) => r.json())) as { blocked?: boolean; country?: string };
  console.log(`\nPays vu par Polymarket : ${g.country ?? '?'} — ${g.blocked ? 'BLOQUÉ : aucun ordre réel possible depuis ce serveur' : 'trading autorisé'}`);
} catch {
  console.log('\nPays vu par Polymarket : vérification impossible');
}
