export type Asset = 'btc' | 'eth';
export type Side = 'up' | 'down';
export type Family = 'lag' | 'fair' | 'learned';
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
  /** "Lag" strategies: how hard BTC must have pushed (change of its win probability)… */
  lead: number;
  /** …and over how many seconds. */
  leadWindow: number;
  /** Sell once the position can be closed at this net gain (share of the stake; 0 = no target). */
  takeProfit: number;
  /** Sell once the price has fallen this far below where it was at entry (share of the stake; 0 = no stop). */
  stopMove: number;
  /** Sell after this many seconds at the latest (0 = hold until the market settles). */
  maxHold: number;
}

export interface Stats {
  /** Filled trades, and how many of them won. */
  n: number;
  wins: number;
  /** Times the strategy wanted to trade; signals − n = orders that would not have filled. */
  signals: number;
  /** Profit per share (payout − all-in cost): sum and sum of squares, all time. */
  sum: number;
  sumSq: number;
  sumCost: number;
  /** Exponentially-weighted versions: recent trades count more (used to revoke a champion). */
  ewN: number;
  ew: number;
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
  /** When it filled, how many shares, and the best bid for those shares at that moment. */
  t?: number;
  shares?: number;
  bid0?: number | null;
  /** Set when the position was sold before the market settled: net proceeds per share and why. */
  exit?: { t: number; net: number; why: ExitReason };
}

export type ExitReason = 'tp' | 'stop' | 'time';

/** One paper order that filled, shown on the dashboard as it happens. */
export interface TapeEntry {
  t: number;
  key: string;
  sid: string;
  asset: Asset;
  side: Side;
  cost: number;
  q: number;
  lead: number | null;
  result?: 'won' | 'lost' | 'void' | ExitReason;
  /** Profit per share once known. */
  pnl?: number;
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
  status: 'open' | 'won' | 'lost' | 'void' | 'failed' | 'sold';
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
  conditionId?: string;
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
  /** Milliseconds between asking for data and being able to act on it. */
  latencyMs: number;
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
  version: 4;
  createdAt: number;
  updatedAt: number;
  tickCount: number;
  /** Held by the running engine session; `ttl` seconds after `at` it is considered dead. */
  lock?: { at: number; id: string; ttl?: number };
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
  /** Latest filled paper orders of all strategies, newest first. */
  tape: TapeEntry[];
  recent: { key: string; asset: Asset; start: number; outcome: Side | 'void'; shadows: number }[];
}

/** What the real-time engine sees right now, sent to the dashboard several times a second. */
export interface LiveAsset {
  spot: number | null;
  strike: number | null;
  /** Market's probability of Up (mid of the Up book), and the model's. */
  mid: number | null;
  qFair: number | null;
  qModel: number | null;
  /** Order book of the "Up" outcome, best prices first: [price, shares]. */
  asks: [number, number][];
  bids: [number, number][];
  /** Milliseconds since the last order-book update was received. */
  bookAgeMs: number | null;
  /** ETH only: BTC's push over the last 10 seconds, in probability points (the trading trigger). */
  lead?: number | null;
}

export interface LiveFrame {
  t: number;
  windowStart: number;
  assets: Record<Asset, LiveAsset>;
  /** Only in the first frame of a session: the last two minutes of spot prices, [time, price]. */
  history?: Record<Asset, [number, number][]>;
}
