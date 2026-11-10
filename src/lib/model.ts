import { TWAP, WINDOW } from './config';
import { clamp, logit, logLoss, phi, sigmoid } from './math';
import { flowImbalance, priceAt, twap, type Series } from './prices';
import type { ModelState, Obs } from './types';

export interface Features {
  elapsed: number;
  spot: number;
  strike: number;
  sigma: number;
  /** Standardised distance to the strike, accounting for the TWAP settlement. */
  z: number;
  mom60: number;
  mom300: number;
  mom900: number;
  flow: number;
}

/**
 * Fair-value core. The market pays "Up" when the TWAP of the last 60s is at or
 * above the strike. With τ seconds left and price following a driftless random walk:
 *  - τ > 60: the final TWAP is spot plus noise of variance σ²(τ − 60 + 60/3)
 *  - τ ≤ 60: part of the average is already known; only the rest is uncertain.
 */
export function computeFeatures(s: Series, windowStart: number, strike: number, now: number): Features | null {
  const spot = s.last.c;
  const sigma = s.sigma;
  if (!(sigma > 0) || !(spot > 0) || !(strike > 0)) return null;
  const elapsed = now - windowStart;
  const tau = clamp(WINDOW - elapsed, 0.5, WINDOW);
  let expected = spot;
  let effT: number;
  if (tau > TWAP) {
    effT = tau - TWAP + TWAP / 3;
  } else {
    const done = TWAP - tau;
    const known = done > 0 ? (twap(s, windowStart + WINDOW - TWAP, now) ?? spot) : spot;
    expected = (done * known + tau * spot) / TWAP;
    effT = Math.pow(tau / TWAP, 2) * (tau / 3);
  }
  const z = Math.log(expected / strike) / (sigma * Math.sqrt(Math.max(effT, 0.05)));
  const mom = (sec: number) => {
    const p = priceAt(s, now - sec);
    return p ? clamp(Math.log(spot / p) / (sigma * Math.sqrt(sec)), -4, 4) : 0;
  };
  return { elapsed, spot, strike, sigma, z, mom60: mom(60), mom300: mom(300), mom900: mom(900), flow: flowImbalance(s, now, 60) };
}

/**
 * Probability of Up. Calibrated on 43,776 samples: the plain normal curve is right on average
 * but over-confident in the tails (says 99.8%, happens 98.7%), hence the 1% floor on each side.
 */
export const fairProb = (z: number, volMult = 1) => 0.01 + 0.98 * phi(z / volMult);

export const N_FEATURES = 8;

/** Feature vector of the online model. `mid` is the market's own Up probability. */
export function featureVector(f: Features, mid: number): number[] {
  const z = clamp(f.z, -4, 4);
  const frac = clamp(f.elapsed / WINDOW, 0, 1);
  return [1, clamp(logit(mid), -4, 4), z, z * frac, f.mom60, f.mom300, f.flow * 2, frac - 0.5];
}

/** Starts as a copy of the market (weight 1 on the market's logit): no edge until it learns one. */
export const newModel = (): ModelState => ({ w: [0, 1, 0, 0, 0, 0, 0, 0], n: 0, llModel: Math.LN2, llMarket: Math.LN2, llFair: Math.LN2 });

export function predict(m: ModelState, x: number[]): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (m.w[i] ?? 0) * x[i];
  return sigmoid(clamp(s, -8, 8));
}

/** One online gradient step per observation, once the real outcome is known. */
export function learn(m: ModelState, obs: Obs[], up: 0 | 1, lr: number): void {
  const a = 0.002; // slow smoothing (~500 samples): a short window would just show noise
  for (const o of obs) {
    const p = predict(m, o.x);
    m.llModel += a * (logLoss(p, up) - m.llModel);
    m.llMarket += a * (logLoss(o.mid, up) - m.llMarket);
    m.llFair += a * (logLoss(o.qFair, up) - m.llFair);
    const g = p - up;
    const step = lr / Math.sqrt(1 + m.n / 2000);
    for (let i = 0; i < o.x.length; i++) {
      // Weight decay pulls toward "just trust the market" (w[1] = 1, others 0).
      const anchor = i === 1 ? 1 : 0;
      m.w[i] = clamp(m.w[i] - step * (g * o.x[i] + 0.001 * (m.w[i] - anchor)), -5, 5);
    }
    m.n++;
  }
}
