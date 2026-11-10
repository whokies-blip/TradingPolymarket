import { canTick } from '@/lib/auth';
import { hub, joinSession } from '@/lib/hub';
import type { LiveFrame } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The dashboard's window onto the real-time engine.
 *
 *  GET /api/live           joins the engine session running on this server (starting one if there is
 *                          none) and streams it, one JSON object per line: prices and order books
 *                          five times a second. The request stays open until the session ends, which
 *                          is also what keeps the session alive.
 *  GET /api/live?poll=1    returns at once the frames produced since `since` and, every five seconds,
 *                          the full dashboard. Works even where long-lived responses are buffered or cut.
 *
 * The dashboard uses both at once and shows whichever data arrives.
 */
export async function GET(req: Request) {
  if (!canTick(req)) return Response.json({ error: 'Jeton administrateur requis.' }, { status: 401 });
  const params = new URL(req.url).searchParams;

  if (params.has('poll')) {
    const since = Number(params.get('since')) || 0;
    const viewAt = Number(params.get('v')) || 0;
    return Response.json(
      { running: !!hub.done, sid: hub.sid, now: Date.now() / 1000, frames: hub.frames.filter((f) => f.t > since).slice(-12), viewAt: hub.viewAt, view: hub.view && hub.viewAt > viewAt ? hub.view : undefined },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  const { sid, attached, done } = joinSession();
  const encoder = new TextEncoder();
  let listener: ((frame: LiveFrame) => void) | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  const leave = () => {
    if (listener) hub.listeners.delete(listener);
    if (beat) clearInterval(beat);
    listener = null;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (frame: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(frame) + '\n'));
        } catch {
          open = false;
          leave(); // this viewer left; the session carries on for the others and ends by itself
        }
      };
      send({ type: 'hello', sid, attached });
      listener = (frame) => send({ type: 'live', ...frame });
      hub.listeners.add(listener);
      beat = setInterval(() => send({ type: 'beat' }), 10000);
      void done
        .then((result) => send({ type: 'end', ...result }))
        .catch((e) => send({ type: 'end', ok: false, error: String((e as Error)?.message || e) }))
        .finally(() => {
          open = false;
          leave();
          try {
            controller.close();
          } catch {}
        });
    },
    cancel() {
      leave();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } });
}
