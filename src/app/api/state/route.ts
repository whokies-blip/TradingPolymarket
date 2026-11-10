import { config } from '@/lib/config';
import { migrate } from '@/lib/engine';
import { getStore } from '@/lib/store';
import { publicView, type View } from '@/lib/view';

export const dynamic = 'force-dynamic';

// On Vercel Blob every read counts against a small monthly quota, so the saved state is re-read
// at most every 20 seconds per server instance. (Live data comes from /api/live, not from here.)
let memo: { at: number; view: View } | null = null;

export async function GET() {
  try {
    const store = getStore();
    if (store.kind === 'blob' && memo && Date.now() - memo.at < 20000) {
      return Response.json({ ...memo.view, now: Date.now() / 1000 }, { headers: { 'cache-control': 'no-store' } });
    }
    const { state } = await store.read();
    const view = publicView(migrate(state, config()), store);
    memo = { at: Date.now(), view };
    return Response.json(view, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
