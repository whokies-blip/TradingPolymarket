import { canTick } from '@/lib/auth';
import { runTick } from '@/lib/engine';
import { joinSession } from '@/lib/hub';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!canTick(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const once = new URL(req.url).searchParams.get('once') === '1';
    // A full run goes through the shared session, so it can never double up with one a viewer started.
    return Response.json(once ? await runTick({ loopSeconds: 0 }) : await joinSession().done);
  } catch (e) {
    return Response.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
