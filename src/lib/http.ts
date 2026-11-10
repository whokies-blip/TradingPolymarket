/** fetch JSON with a hard timeout; throws on non-2xx. */
export async function getJson<T = unknown>(url: string, timeoutMs = 4000, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; pm-5m-bot/1.0)', ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).host}`);
  return (await res.json()) as T;
}
