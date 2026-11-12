import type { Stats } from './types';

export const emptyStats = (): Stats => ({ n: 0, wins: 0, signals: 0, sum: 0, sumSq: 0, sumCost: 0, ewN: 0, ew: 0 });

export function record(stats: Stats, pnl: number, cost: number, decay: number): void {
  stats.n++;
  if (pnl > 0) stats.wins++;
  stats.sum += pnl;
  stats.sumSq += pnl * pnl;
  stats.sumCost += cost;
  stats.ewN = stats.ewN * decay + 1;
  stats.ew = stats.ew * decay + pnl;
}

export interface Score {
  mean: number;
  se: number;
  tstat: number;
  recent: number;
}

export function score(s: Stats): Score {
  if (s.n < 2) return { mean: 0, se: Infinity, tstat: 0, recent: 0 };
  const mean = s.sum / s.n;
  const variance = Math.max(s.sumSq / s.n - mean * mean, 1e-4);
  const se = Math.sqrt(variance / s.n);
  return { mean, se, tstat: mean / se, recent: s.ewN > 0 ? s.ew / s.ewN : 0 };
}
