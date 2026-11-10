import { canTick } from '@/lib/auth';
import { runTick } from '@/lib/engine';
import { getStore } from '@/lib/store';
import { publicView } from '@/lib/view';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Runs one real-time engine session on the server and streams what it sees, one JSON object per
 * line, to the dashboard that requested it: a light frame every second (prices, probabilities) and
 * the full view every five. The dashboard reconnects when the session ends, so the engine keeps
 * running for as long as the page stays open — no scheduler needed.
 */
export async function GET(req: Request) {
  if (!canTick(req)) return Response.json({ error: 'Jeton administrateur requis.' }, { status: 401 });
  const store = getStore();
  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener('abort', () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (frame: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(frame) + '\n'));
        } catch {
          open = false;
          abort.abort(); // the viewer left: end the session cleanly
        }
      };
      let n = 0;
      send({ type: 'hello' });
      runTick({
        signal: abort.signal,
        onFrame: (state) => send(n++ % 5 === 0 ? { type: 'view', view: publicView(state, store) } : { type: 'tick', now: Date.now() / 1000, snapshots: state.snapshots }),
      })
        .then((result) => send({ type: 'end', ...result }))
        .catch((e) => send({ type: 'end', ok: false, error: String((e as Error)?.message || e) }))
        .finally(() => {
          open = false;
          try {
            controller.close();
          } catch {}
        });
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } });
}
