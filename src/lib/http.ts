/** fetch JSON with a hard timeout; throws a short, readable reason on failure. */
export async function getJson<T = unknown>(url: string, timeoutMs = 4000, init?: RequestInit): Promise<T> {
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; pm-5m-bot/1.0)', ...(init?.headers || {}) },
    });
  } catch (e) {
    // Node reports every network failure as "fetch failed"; the useful part is the underlying code.
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const why = err.name === 'TimeoutError' ? 'délai dépassé' : err.cause?.code || err.cause?.message || err.message;
    throw new Error(`${host} injoignable (${why})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${host}`);
  return (await res.json()) as T;
}
