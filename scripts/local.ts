/**
 * Runs the trading system on your own computer: the real-time engine in a loop that never stops,
 * plus the dashboard on http://localhost:3000. State is kept in .data/state.json.
 *
 *   npm run local                 engine + dashboard
 *   npm run local -- --no-dashboard
 *   PORT=4000 npm run local
 *
 * Stop with Ctrl+C (the state is saved before exiting).
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, openSync } from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
process.chdir(root);
for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f);
// Local defaults: saving is free here, so save often; long sessions mean fewer reconnections.
process.env.PERSIST_SECONDS ??= '5';
process.env.TICK_LOOP_SECONDS ??= '900';
process.env.LOCAL_RUNNER = '1'; // tells the dashboard the engine is already taken care of

const args = new Set(process.argv.slice(2));
const port = process.env.PORT || '3000';
const stamp = () => new Date().toLocaleTimeString('fr-FR');
const say = (msg: string) => console.log(`[${stamp()}] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cents = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}¢`);

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22 || typeof WebSocket === 'undefined') {
    console.error(`Node.js 22 ou plus récent est nécessaire (version actuelle : ${process.versions.node}). Installez-le depuis https://nodejs.org puis relancez.`);
    process.exit(1);
  }
  const { runTick } = await import('../src/lib/engine');
  type State = import('../src/lib/types').State;

  let dashboard: ChildProcess | null = null;
  if (!args.has('--no-dashboard')) {
    mkdirSync('.data', { recursive: true });
    const out = openSync(path.join('.data', 'dashboard.log'), 'a');
    dashboard = spawn(process.execPath, [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', port], { cwd: root, stdio: ['ignore', out, out], env: process.env });
    dashboard.on('exit', (code) => {
      if (!stopping) say(`Le tableau de bord s'est arrêté (code ${code}). Détails dans .data/dashboard.log — le moteur continue.`);
    });
    say(`Tableau de bord : http://localhost:${port}`);
    if (process.platform === 'darwin' && !args.has('--no-open')) setTimeout(() => spawn('open', [`http://localhost:${port}`], { stdio: 'ignore' }).on('error', () => {}), 6000);
  }

  const controller = new AbortController();
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1); // second Ctrl+C: leave immediately
    stopping = true;
    say('Arrêt demandé : sauvegarde en cours… (Ctrl+C à nouveau pour forcer)');
    controller.abort();
    dashboard?.kill();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let lastLog = Date.now() / 1000;
  let lastStatus = 0;
  const onSave = (state: State) => {
    // Print what happened since the last save: trades, champion changes, problems.
    for (const entry of state.log.filter((l) => l.t > lastLog).reverse()) say(entry.msg);
    lastLog = Math.max(lastLog, state.log[0]?.t ?? 0);
    if (Date.now() - lastStatus < 30000) return;
    lastStatus = Date.now();
    const market = (a: 'btc' | 'eth') => {
      const s = state.snapshots[a];
      return s ? `${a.toUpperCase()} marché ${cents(s.mid)} / modèle ${cents(s.qFair)}` : `${a.toUpperCase()} en attente`;
    };
    const signals = state.strategies.reduce((n, s) => n + (s.stats.signals ?? 0), 0);
    const fills = state.strategies.reduce((n, s) => n + s.stats.n, 0);
    const open = Object.values(state.windows).reduce((n, w) => n + w.shadows.filter((s) => !s.exit).length, 0);
    say(`${market('btc')} · ${market('eth')} · ${state.settledWindows} marchés réglés · ordres simulés ${signals} (${fills + open} exécutés) · champion : ${state.championId ?? 'aucun'} · démo ${state.demo.bankroll.toFixed(2)} $`);
  };

  say('Moteur temps réel démarré (Ctrl+C pour arrêter).');
  while (!stopping) {
    try {
      const r = await runTick({ signal: controller.signal, noFallback: true, onSave });
      if (stopping) break;
      if (r.busy) {
        say('Une autre session du moteur semble active (ou vient de s’arrêter brutalement) : nouvel essai dans 15 s.');
        await sleep(15000);
      } else if (r.mode !== 'realtime') {
        say('Flux temps réel indisponibles (connexion Internet ?) : nouvel essai dans 5 s.');
        await sleep(5000);
      }
    } catch (e) {
      say(`Erreur : ${String((e as Error)?.message || e).slice(0, 200)} — nouvel essai dans 5 s.`);
      await sleep(5000);
    }
  }
  say('Arrêté proprement. À bientôt.');
  process.exit(0);
}

void main();
