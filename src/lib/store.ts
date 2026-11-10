import { promises as fs } from 'fs';
import path from 'path';
import type { State } from './types';

/** Raised when another tick wrote the state first (optimistic concurrency). */
export class ConflictError extends Error {}

export interface Store {
  kind: 'upstash' | 'blob' | 'file' | 'tmp';
  /** False when data can vanish between invocations. */
  durable: boolean;
  read(): Promise<{ state: State | null; etag: string | null }>;
  /** Writes only if the stored version still matches `etag`. Returns the new etag. */
  write(state: State, etag: string | null): Promise<string>;
}

const KEY = process.env.STATE_KEY || 'pm5m/state.json';

// ------------------------------------------------------------ Upstash Redis (REST)

function upstash(url: string, token: string): Store {
  const call = async (cmd: unknown[]) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(cmd),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json()) as { result?: unknown; error?: string };
    if (!res.ok || body.error) throw new Error(`upstash: ${body.error || res.status}`);
    return body.result;
  };
  const CAS = `local v = redis.call('GET', KEYS[2]) if (v == false and ARGV[1] == '') or v == ARGV[1] then redis.call('SET', KEYS[1], ARGV[3]) redis.call('SET', KEYS[2], ARGV[2]) return 1 end return 0`;
  return {
    kind: 'upstash',
    durable: true,
    async read() {
      const [data, ver] = (await call(['MGET', KEY, `${KEY}:v`])) as [string | null, string | null];
      return { state: data ? (JSON.parse(data) as State) : null, etag: ver };
    },
    async write(state, etag) {
      const next = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ok = await call(['EVAL', CAS, '2', KEY, `${KEY}:v`, etag ?? '', next, JSON.stringify(state)]);
      if (ok !== 1) throw new ConflictError('state changed');
      return next;
    },
  };
}

// ------------------------------------------------------------ Vercel Blob

function blob(): Store {
  return {
    kind: 'blob',
    durable: true,
    async read() {
      const { get } = await import('@vercel/blob');
      const res = await get(KEY, { access: 'private', useCache: false });
      if (!res || res.statusCode !== 200) return { state: null, etag: null };
      const text = await new Response(res.stream).text();
      return { state: JSON.parse(text) as State, etag: res.blob.etag };
    },
    async write(state, etag) {
      const { put, BlobPreconditionFailedError } = await import('@vercel/blob');
      try {
        const res = await put(KEY, JSON.stringify(state), {
          access: 'private',
          contentType: 'application/json',
          addRandomSuffix: false,
          allowOverwrite: true,
          cacheControlMaxAge: 60,
          ...(etag ? { ifMatch: etag } : {}),
        });
        return res.etag;
      } catch (e) {
        if (e instanceof BlobPreconditionFailedError) throw new ConflictError('state changed');
        throw e;
      }
    },
  };
}

// ------------------------------------------------------------ Local file

function file(dir: string, kind: 'file' | 'tmp'): Store {
  const p = path.join(dir, 'state.json');
  return {
    kind,
    durable: kind === 'file',
    async read() {
      try {
        const state = JSON.parse(await fs.readFile(p, 'utf8')) as State;
        return { state, etag: String(state.updatedAt) + ':' + state.tickCount + ':' + (state.lock?.id ?? '') };
      } catch {
        return { state: null, etag: null };
      }
    },
    async write(state, etag) {
      const cur = await this.read();
      if (cur.etag !== etag) throw new ConflictError('state changed');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(p + '.tmp', JSON.stringify(state));
      await fs.rename(p + '.tmp', p);
      return String(state.updatedAt) + ':' + state.tickCount + ':' + (state.lock?.id ?? '');
    },
  };
}

export function getStore(): Store {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return upstash(url, token);
  if (process.env.BLOB_READ_WRITE_TOKEN) return blob();
  if (process.env.VERCEL) return file('/tmp/pm5m', 'tmp');
  return file(path.join(process.cwd(), '.data'), 'file');
}
