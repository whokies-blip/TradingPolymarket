export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Standard normal CDF (Abramowitz-Stegun, |error| < 7.5e-8). */
export function phi(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const logit = (p: number) => {
  const c = clamp(p, 1e-4, 1 - 1e-4);
  return Math.log(c / (1 - c));
};
export const logLoss = (p: number, y: number) => {
  const c = clamp(p, 1e-4, 1 - 1e-4);
  return -(y * Math.log(c) + (1 - y) * Math.log(1 - c));
};

/** Deterministic PRNG so evolution is reproducible in tests. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const round = (x: number, d = 4) => {
  const m = 10 ** d;
  return Math.round(x * m) / m;
};
