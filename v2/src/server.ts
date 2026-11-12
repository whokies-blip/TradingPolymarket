import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config';
import type { Engine } from './engine';

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

/**
 * HTTP API and dashboard, served by the engine itself.
 *   GET  /health            liveness for the process manager (no token)
 *   GET  /                  dashboard (asks for the admin token)
 *   GET  /api/view?token=   full state
 *   GET  /api/stream?token= server-sent events: a frame 5×/s, the full view every 5 s
 *   POST /api/control       {"action": "arm" | "disarm" | "reset"} or {"action": "desk", "desk": id, "on": bool} with Authorization: Bearer <token>
 */
export function startServer(cfg: Config, engine: Engine) {
  const same = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const authorised = (req: IncomingMessage, url: URL) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return same(bearer || url.searchParams.get('token') || '', cfg.adminToken);
  };
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (url.pathname === '/health') return json(res, engine.health().ok ? 200 : 503, engine.health());
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(page);
      }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'introuvable' });
      if (!authorised(req, url)) return json(res, 401, { error: 'Jeton administrateur invalide.' });
      if (url.pathname === '/api/view') return json(res, 200, engine.view());
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        send('view', engine.view());
        const listener = (type: 'frame' | 'view', data: unknown) => send(type, data);
        engine.listeners.add(listener);
        const full = setInterval(() => send('view', engine.view()), 5000);
        req.on('close', () => {
          engine.listeners.delete(listener);
          clearInterval(full);
        });
        return;
      }
      if (url.pathname === '/api/control' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { action, desk, on } = JSON.parse(body || '{}') as { action?: string; desk?: string; on?: boolean };
        if (action === 'arm') {
          if (!cfg.mmLive) return json(res, 400, { error: 'Production non activée (MM_LIVE=true).' });
          engine.setArmed(true);
        } else if (action === 'disarm') engine.setArmed(false);
        else if (action === 'reset') engine.resetSimulation();
        else if (action === 'desk') {
          if (!engine.setDeskEnabled(String(desk), on !== false)) return json(res, 404, { error: 'Bureau inconnu.' });
        }
        else return json(res, 400, { error: 'Action inconnue.' });
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'introuvable' });
    } catch (e) {
      return json(res, 500, { error: String((e as Error)?.message || e) });
    }
  });
  server.listen(cfg.port, () => console.log(`Tableau de bord : http://localhost:${cfg.port}`));
  return server;
}
