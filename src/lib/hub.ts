import { runTick, type TickResult } from './engine';
import { getStore } from './store';
import type { LiveFrame } from './types';
import { publicView, type View } from './view';

/**
 * One engine session per server instance, shared by everyone watching.
 *
 * A page that opens, reloads or reconnects never starts a second session: it attaches to the one
 * already running here. (Starting a new 5-minute session on every reconnect piled sessions up until
 * the server choked and the live view froze after a few seconds.)
 */
interface Hub {
  sid: string | null;
  done: Promise<TickResult> | null;
  /** The last few seconds of live frames, for viewers that poll. */
  frames: LiveFrame[];
  view: View | null;
  viewAt: number;
  listeners: Set<(frame: LiveFrame) => void>;
}

const g = globalThis as unknown as { __pm5mHub?: Hub };
export const hub: Hub = (g.__pm5mHub ??= { sid: null, done: null, frames: [], view: null, viewAt: 0, listeners: new Set() });

/** Starts a session, or returns the one already running on this instance. */
export function joinSession(): { sid: string; attached: boolean; done: Promise<TickResult> } {
  if (hub.done && hub.sid) return { sid: hub.sid, attached: true, done: hub.done };
  const sid = Math.random().toString(36).slice(2, 8);
  const store = getStore();
  let n = 0;
  hub.sid = sid;
  hub.frames = [];
  const done = runTick({
    onLive: (frame) => {
      hub.frames.push(frame);
      if (hub.frames.length > 25) hub.frames.splice(0, hub.frames.length - 25);
      for (const listener of hub.listeners) listener(frame);
    },
    onFrame: (state) => {
      if (n++ % 5 !== 0) return; // the full dashboard every five seconds
      hub.view = publicView(state, store);
      hub.viewAt = Date.now();
    },
  }).finally(() => {
    if (hub.sid === sid) {
      hub.sid = null;
      hub.done = null;
    }
  });
  hub.done = done;
  return { sid, attached: false, done };
}
