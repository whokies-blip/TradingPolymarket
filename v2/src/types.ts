export type Asset = 'btc' | 'eth';
export type Side = 'up' | 'down';

export interface Stats {
  n: number;
  wins: number;
  signals: number;
  sum: number;
  sumSq: number;
  sumCost: number;
  ewN: number;
  ew: number;
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
  /** Price to beat; not needed for market making. */
  strike?: number;
  outcome?: Side | 'void';
  lastResolveCheck?: number;
}

export interface GateCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** One passive order of a simulated desk that got filled. */
export interface MmFill {
  t: number;
  asset: Asset;
  /** 'buy' = bought Up on our bid. 'sell' = sold Up on our ask (= bought Down at 1 − price). For a stop: the stock sold. */
  side: 'buy' | 'sell';
  price: number;
  shares: number;
  candle: 'green' | 'red' | 'flat';
  rebate: number;
  stop?: boolean;
}

export interface MmState {
  pnl: number;
  rewards: number;
  fills: number;
  volume: number;
  markets: number;
  books: Record<string, { net: number; cash: number; avg?: number; rew?: number }>;
  recent: MmFill[];
  equity: [number, number][];
}

export interface MmGenes {
  minPrice: number;
  maxPrice: number;
  minGain: number;
  widen: number;
  maxStock: number;
  startAt: number;
  stopAt: number;
  stopLoss: number;
}

export interface MmDesk {
  id: string;
  gen: number;
  parent?: string;
  genes: MmGenes;
  mm: MmState;
  stats: Stats;
  bornAt: number;
}

export interface MmLiveOrder {
  id: string;
  key: string;
  asset: Asset;
  token: Side;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  matched: number;
  placedAt: number;
}

export interface MmLiveBook {
  up: number;
  down: number;
  cost: number;
  avgUp: number;
  avgDown: number;
}

export interface MmLiveFill {
  t: number;
  asset: Asset;
  token: Side;
  side: 'BUY' | 'SELL';
  price: number;
  shares: number;
}

export interface MmLiveState {
  orders: MmLiveOrder[];
  books: Record<string, MmLiveBook>;
  pnl: number;
  day: number;
  dayPnl: number;
  markets: number;
  fills: MmLiveFill[];
  equity: [number, number][];
  lastError?: { t: number; msg: string };
  lastPollAt: number;
  lastCandle: number;
  dirty: boolean;
}

export interface LogEntry {
  t: number;
  level: 'info' | 'warn' | 'error' | 'trade';
  msg: string;
}

/** Everything the engine keeps between restarts. */
export interface State {
  version: 2;
  createdAt: number;
  desks: MmDesk[];
  desksEvolvedAt: number;
  settledWindows: number;
  mmLive: MmLiveState;
  control: { liveArmed: boolean };
  geo?: { t: number; blocked: boolean; country: string };
  log: LogEntry[];
  recent: { key: string; asset: Asset; start: number; outcome: Side | 'void' }[];
}
