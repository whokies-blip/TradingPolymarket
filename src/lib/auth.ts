import { timingSafeEqual } from 'crypto';
import { config } from './config';

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const bearer = (req: Request) => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. The admin token also works. */
export function canTick(req: Request): boolean {
  const cfg = config();
  if (!cfg.cronSecret && !cfg.adminToken) return !process.env.VERCEL;
  const token = bearer(req);
  return (!!cfg.cronSecret && same(token, cfg.cronSecret)) || (!!cfg.adminToken && same(token, cfg.adminToken));
}

/** Controls (kill switch, arming real trading) always require the admin token once deployed. */
export function isAdmin(req: Request): boolean {
  const cfg = config();
  if (!cfg.adminToken) return !process.env.VERCEL;
  return same(bearer(req), cfg.adminToken);
}
