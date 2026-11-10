/**
 * Connection check: tests, from THIS computer, every service the engine needs and says plainly
 * what works and what does not.   Usage: npm run check
 */
import { BookFeed, SpotFeed } from '../src/lib/feeds';
import { getJson } from '../src/lib/http';
import { fetchBook, fetchGeoblock, fetchWindows } from '../src/lib/polymarket';
import { getSeries, windowStartOf } from '../src/lib/prices';

const results: { name: string; ok: boolean; detail: string }[] = [];
async function test(name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: `${detail} (${Date.now() - t} ms)` });
  } catch (e) {
    results.push({ name, ok: false, detail: String((e as Error)?.message || e) });
  }
}

async function main() {
  console.log(`Vérification des connexions… (Node ${process.versions.node})\n`);
  const start = windowStartOf(Date.now() / 1000);
  let tokens: string[] = [];

  await test('Prix Binance (historique)', async () => {
    const s = await getSeries('btc');
    if (s.source !== 'binance') throw new Error('Binance injoignable (seul le repli Coinbase répond)');
    return `BTC ${s.last.c.toFixed(2)} $`;
  });
  await test('Prix Binance (flux temps réel)', async () => {
    const feed = new SpotFeed();
    await feed.start(['btc', 'eth']);
    await new Promise((r) => setTimeout(r, 2500));
    feed.close();
    if (feed.last.btc === undefined) throw new Error('connecté, mais aucun prix reçu');
    return `BTC ${feed.last.btc.toFixed(2)} $`;
  });
  await test('Polymarket — catalogue des marchés', async () => {
    const wins = await fetchWindows('btc', [start, start + 300]);
    if (wins.length === 0) throw new Error('aucun marché 5 minutes trouvé');
    tokens = [wins[0].upToken, wins[0].downToken];
    return `${wins.length} marchés`;
  });
  await test('Polymarket — carnet d’ordres (lecture)', async () => {
    if (!tokens.length) throw new Error('non testé (catalogue indisponible)');
    const b = await fetchBook(tokens[0]);
    return `achat ${b.asks[0]?.price ?? '—'} / vente ${b.bids[0]?.price ?? '—'}`;
  });
  await test('Polymarket — carnet d’ordres (flux temps réel)', async () => {
    if (!tokens.length) throw new Error('non testé (catalogue indisponible)');
    const feed = new BookFeed(tokens);
    await feed.start();
    await new Promise((r) => setTimeout(r, 2500));
    const ready = feed.ready();
    feed.close();
    if (!ready) throw new Error('connecté, mais aucun carnet reçu');
    return 'carnet reçu';
  });
  await test('Polymarket — horloge de la bourse', async () => `heure ${await getJson<number>('https://clob.polymarket.com/time')}`);
  let geo: { blocked: boolean; country: string } | null = null;
  await test('Polymarket — autorisation de trader depuis cette connexion', async () => {
    geo = await fetchGeoblock();
    if (geo.blocked) throw new Error(`pays détecté : ${geo.country} — les ordres réels sont bloqués par Polymarket`);
    return `pays détecté : ${geo.country}, non bloqué`;
  });

  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name} — ${r.detail}`);
  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length === 0) {
    console.log('Tout fonctionne : vous pouvez lancer « npm run local ».');
    return;
  }
  const polyData = failed.some((r) => r.name.includes('Polymarket') && !r.name.includes('autorisation'));
  if (failed.some((r) => r.detail.includes('403'))) {
    console.log('Polymarket refuse les requêtes de cette connexion (HTTP 403). Causes habituelles :');
    console.log('  • vous êtes dans un pays où Polymarket restreint l’accès ;');
    console.log('  • un VPN, un proxy ou un réseau d’entreprise/public est actif (essayez sans, sur votre connexion personnelle) ;');
    console.log('  • trop de requêtes ont été envoyées : attendez 15 minutes puis relancez cette vérification.');
  } else if (polyData) {
    console.log('Polymarket est injoignable depuis cette connexion (blocage réseau, DNS ou pare-feu). Essayez un autre réseau ou vérifiez votre VPN.');
  } else if (failed.every((r) => r.name.includes('autorisation'))) {
    console.log('Les données sont accessibles : le mode Démo fonctionne. Seuls les ordres en argent réel sont bloqués depuis ce pays.');
  } else {
    console.log('Certaines connexions échouent : vérifiez votre accès Internet, puis relancez.');
  }
  process.exitCode = 1;
}

void main().then(() => process.exit(process.exitCode ?? 0));
