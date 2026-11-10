import { canTick } from '@/lib/auth';
import { runTick } from '@/lib/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!canTick(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const once = new URL(req.url).searchParams.get('once') === '1';
    return Response.json(await runTick(once ? { loopSeconds: 0 } : {}));
  } catch (e) {
    return Response.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
