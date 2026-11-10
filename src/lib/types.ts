export type Asset = 'btc' | 'eth';
export type Side = 'up' | 'down';
export type Family = 'fair' | 'learned' | 'momentum' | 'reversion' | 'follow';
export type Mode = 'demo' | 'live';

/** Tunable parameters of one strategy. Evolution mutates these. */
export interface Genes {
  family: Family;
  /** Minimum expected edge per share (after fees) required to trade. */
  minEdge: number;
  /** Only trade between these two moments of the 5-minute window (seconds). */
  minElapsed: number;
  maxElapsed: number;
  /** Volatility multiplier applied to the fair-value model (>1 = less confident). */
  volMult: number;
  /** Only buy a side whose ask is inside this band. */
  minPrice: number;
  maxPrice: number;
  /** Strength of the directional tilt (momentum / reversion / follow). */
  k: number;
  /** Lookback in seconds for momentum / reversion. */
  lookback: number;
}

export interface Stats {
  n: number;
  wins: number;
  /** Sum of per-trade ROI and ROI² (all time). */
  sumRoi: number;
  sumSq: number;
  /** Exponentially-weighted versions: recent trades count more. */
  ewN: number;
  ewRoi: number;
  ewSq: number;
}

export interface Strategy {
  id: string;
  gen: number;
  parent?: string;
  genes: Genes;
  stats: Stats;
  bornAt: number;
  bornWindow: number;
}

export interface ShadowTrade {
  sid: string;
  side: Side;
  /** All-in cost per share (price + fee). */
  cost: number;
  q: number;
  elapsed: number;
}

export interface Trade {
  id: string;
  mode: Mode;
  asset: Asset;
  windowStart: number;
  slug: string;
  side: Side;
  shares: number;
  price: number;
  fee: number;
  /** Total paid: shares × price + fee. */
  cost: number;
  q: number;
  edge: number;
  strategyId: string;
  openedAt: number;
  status: 'open' | 'won' | 'lost' | 'void' | 'failed';
  pnl?: number;
  settledAt?: number;
  orderId?: string;
  error?: string;
}

export interface Obs {
  elapsed: number;
  x: number[];
  mid: number;
  qFair: number;
}

export interface WindowRec {
  key: string;
  asset: Asset;
  start: number;
  slug: string;
  upToken: string;
  downToken: string;
  feeRate: number;
  feeExp: number;
  tickSize: number;
  minSize: number;
  negRisk: boolean;
  strike?: number;
  shadows: ShadowTrade[];
  obs: Obs[];
  demoTradeId?: string;
  liveTradeId?: string;
  outcome?: Side | 'void';
  settledAt?: number;
  lastResolveCheck?: number;
}

export interface Account {
  startBankroll: number;
  bankroll: number;
  trades: Trade[];
  /** [timestamp, bankroll] after each settlement. */
  equity: [number, number][];
  nSettled: number;
  nWins: number;
  fees: number;
  staked: number;
  pnl: number;
}

export interface ModelState {
  w: number[];
  n: number;
  /** Exponentially-weighted log-loss of each forecaster (lower is better). */
  llModel: number;
  llMarket: number;
  llFair: number;
}

export interface Snapshot {
  t: number;
  asset: Asset;
  slug: string;
  windowStart: number;
  elapsed: number;
  spot: number;
  strike: number;
  sigma: number;
  source: string;
  askUp: number | null;
  askDown: number | null;
  bidUp: number | null;
  mid: number | null;
  qFair: number;
  qModel: number | null;
}

export interface LogEntry {
  t: number;
  level: 'info' | 'trade' | 'evolve' | 'warn' | 'error';
  msg: string;
}

export interface GateCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface State {
  version: 1;
  createdAt: number;
  updatedAt: number;
  tickCount: number;
  lock?: { at: number; id: string };
  generation: number;
  settledWindows: number;
  lastEvolveAt: number;
  strategies: Strategy[];
  championId: string | null;
  windows: Record<string, WindowRec>;
  demo: Account;
  live: Account;
  models: Record<Asset, ModelState>;
  control: { killSwitch: boolean; liveArmed: boolean; resetDemo?: boolean };
  snapshots: Partial<Record<Asset, Snapshot>>;
  gate: GateCheck[];
  geo?: { t: number; blocked: boolean; country: string };
  log: LogEntry[];
  recent: { key: string; asset: Asset; start: number; outcome: Side | 'void'; shadows: number }[];
}
