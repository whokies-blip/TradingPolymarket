import { isAdmin } from '@/lib/auth';
import { config } from '@/lib/config';
import { initState, liveBalance, log, migrate } from '@/lib/engine';
import { liveConfigured } from '@/lib/live';
import { ConflictError, getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

const ACTIONS = ['kill', 'resume', 'arm', 'disarm', 'resetDemo', 'resetAll', 'check', 'balance'] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(req: Request) {
  if (!isAdmin(req)) return Response.json({ error: 'Jeton administrateur invalide.' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { action?: Action };
  const action = body.action;
  if (!action || !ACTIONS.includes(action)) return Response.json({ error: 'Action inconnue.' }, { status: 400 });
  const cfg = config();
  if (action === 'check') return Response.json({ ok: true });
  if (action === 'balance') return Response.json({ ok: true, balance: liveConfigured(cfg) ? await liveBalance(cfg) : null });
  if (action === 'arm' && !liveConfigured(cfg)) {
    return Response.json({ error: 'Trading réel non configuré (LIVE_TRADING et POLYMARKET_PRIVATE_KEY).' }, { status: 400 });
  }
  const store = getStore();
  for (let attempt = 0; attempt < 4; attempt++) {
    const { state: read, etag } = await store.read();
    const state = migrate(read, cfg);
    if (action === 'kill') state.control = { ...state.control, killSwitch: true, liveArmed: false };
    if (action === 'resume') state.control.killSwitch = false;
    if (action === 'arm') state.control.liveArmed = true;
    if (action === 'disarm') state.control.liveArmed = false;
    if (action === 'resetDemo') state.control.resetDemo = true;
    if (action === 'resetAll') {
      // Reset what is stored now, and flag it so a session already running resets its own copy too.
      Object.assign(state, initState(cfg), { control: { ...state.control, resetAll: true }, lock: state.lock, geo: state.geo });
      log(state, 'info', 'Toutes les statistiques ont été remises à zéro.');
    }
    const label: Record<string, string> = { kill: "Arrêt d'urgence activé.", resume: 'Reprise après arrêt.', arm: 'Trading réel ARMÉ.', disarm: 'Trading réel désarmé.' };
    if (label[action]) log(state, action === 'resume' || action === 'disarm' ? 'info' : 'warn', label[action]);
    try {
      await store.write(state, etag);
      return Response.json({ ok: true, control: state.control });
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  return Response.json({ error: 'État occupé, réessayez.' }, { status: 409 });
}
