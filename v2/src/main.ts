import { randomBytes } from 'node:crypto';
import { makeAlerts } from './alerts';
import { config } from './config';
import { Engine } from './engine';
import { startServer } from './server';
import { Store } from './store';

/**
 * Entry point. Meant to run as a permanent process restarted by its supervisor (Docker or systemd).
 * On SIGTERM/SIGINT every real order is cancelled and the state saved before exiting.
 */
const cfg = config();
if (!cfg.adminToken) {
  cfg.adminToken = randomBytes(18).toString('base64url');
  console.log(`ADMIN_TOKEN absent : jeton temporaire pour cette exécution → ${cfg.adminToken}`);
}
const alert = makeAlerts(cfg);
const store = new Store(cfg.dbPath);
const engine = new Engine(cfg, store, alert);
const lock = store.acquireLock(engine.owner);
if (!lock.ok) {
  console.error(`Un autre moteur utilise déjà ${cfg.dbPath} (${lock.holder}, actif il y a ${lock.age} s). Arrêt : deux moteurs placeraient des ordres en double.`);
  process.exit(2);
}

let stopping = false;
async function shutdown(code: number, why: string) {
  if (stopping) return;
  stopping = true;
  console.log(`Arrêt (${why}) : annulation des ordres réels et sauvegarde…`);
  const force = setTimeout(() => process.exit(code), 15000);
  try {
    await engine.stop();
    store.close();
  } finally {
    clearTimeout(force);
    process.exit(code);
  }
}
process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'));
process.on('SIGINT', () => void shutdown(0, 'SIGINT'));
process.on('uncaughtException', (e) => {
  void alert(`plantage : ${String(e?.message || e).slice(0, 200)}`);
  void shutdown(1, 'erreur inattendue');
});
process.on('unhandledRejection', (e) => console.error('promesse rejetée :', e));

// Port first: if it is taken, nothing else has started yet.
const server = startServer(cfg, engine);
await new Promise<void>((resolve, reject) => {
  server.once('listening', () => resolve());
  server.once('error', reject);
}).catch((e) => {
  console.error(`Port ${cfg.port} indisponible : ${String(e?.message || e)}`);
  store.releaseLock(engine.owner);
  process.exit(2);
});
await engine.start();
void alert('moteur démarré');
