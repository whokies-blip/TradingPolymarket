/** Rolling latency measurements (last 500 samples per series) with percentiles, for the dashboard and /health. */
class Metrics {
  private series = new Map<string, number[]>();
  private counters = new Map<string, number>();

  add(name: string, ms: number): void {
    if (!Number.isFinite(ms)) return;
    let s = this.series.get(name);
    if (!s) this.series.set(name, (s = []));
    s.push(ms);
    if (s.length > 500) s.splice(0, s.length - 500);
  }

  count(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  /** Time an async call and record its duration. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async time<T = any>(name: string, fn: () => Promise<T>): Promise<T> {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      this.add(name, performance.now() - t);
    }
  }

  snapshot(): { latency: Record<string, { n: number; p50: number; p95: number; max: number }>; counters: Record<string, number> } {
    const latency: Record<string, { n: number; p50: number; p95: number; max: number }> = {};
    for (const [name, s] of this.series) {
      if (!s.length) continue;
      const v = [...s].sort((a, b) => a - b);
      const q = (p: number) => Math.round(v[Math.min(v.length - 1, Math.floor(p * v.length))] * 10) / 10;
      latency[name] = { n: v.length, p50: q(0.5), p95: q(0.95), max: Math.round(v[v.length - 1] * 10) / 10 };
    }
    return { latency, counters: Object.fromEntries(this.counters) };
  }
}

export const metrics = new Metrics();
