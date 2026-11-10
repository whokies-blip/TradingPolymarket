import { config } from '@/lib/config';
import { migrate } from '@/lib/engine';
import { getStore } from '@/lib/store';
import { publicView } from '@/lib/view';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const store = getStore();
    const { state } = await store.read();
    return Response.json(publicView(migrate(state, config()), store), { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
