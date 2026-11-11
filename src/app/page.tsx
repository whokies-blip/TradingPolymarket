'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { View } from '@/lib/view';
import type { LiveAsset, LiveFrame, Trade } from '@/lib/types';

const usd = (x: number, d = 2) => `${x < 0 ? '−' : ''}${Math.abs(x).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d })} $`;
const signed = (x: number) => `${x > 0 ? '+' : ''}${usd(x)}`;
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d)} %`);
const centsSigned = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(1)}¢`);
/** Order-book prices: whole cents normally, tenths of a cent near 0 and 100 where the market quotes them. */
const tick = (p: number) => { const c = Math.round(p * 1000) / 10; return `${Number.isInteger(c) ? c.toFixed(0) : c.toFixed(1).replace('.', ',')}¢`; };
const cents = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(0)}¢`);
const time = (t: number) => new Date(t * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = (t: number) => new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const cls = (x: number) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const SIDE = { up: 'Hausse', down: 'Baisse' } as const;
const RESULT = { won: 'Gagné à la fin', lost: 'Perdu à la fin', void: 'Annulé', tp: 'Vendu, objectif atteint', stop: 'Vendu, stop', time: 'Vendu, durée max' } as const;

type Engine = 'off' | 'connecting' | 'live' | 'busy' | 'error' | 'denied';

function EquityChart({ points, start }: { points: [number, number][]; start: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000, H = 220, L = 56, R = 12, T = 12, B = 24;
  if (points.length < 2) return <p className="muted">La courbe apparaîtra après les premiers trades réglés.</p>;
  const ys = points.map((p) => p[1]).concat(start);
  const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo || 1) * 0.1;
  const x = (i: number) => L + (i / (points.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - T - B);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const h = hover !== null ? points[hover] : null;
  return (
    <div className="chart" ref={ref}
      onMouseMove={(e) => { const r = ref.current!.getBoundingClientRect(); const fx = ((e.clientX - r.left) / r.width) * W; setHover(Math.max(0, Math.min(points.length - 1, Math.round(((fx - L) / (W - L - R)) * (points.length - 1))))); }}
      onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Évolution du capital, trade par trade">
        {[lo, (lo + hi) / 2, hi].map((v, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{v.toFixed(0)}</text>
          </g>
        ))}
        <line x1={L} x2={W - R} y1={y(start)} y2={y(start)} stroke="var(--muted)" strokeDasharray="4 4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d={path} fill="none" stroke="var(--series)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {h && <line x1={x(hover!)} x2={x(hover!)} y1={T} y2={H - B} stroke="var(--muted)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        <text x={L} y={H - 6} fontSize="11" fill="var(--muted)">{dateTime(points[0][0])}</text>
        <text x={W - R} y={H - 6} fontSize="11" textAnchor="end" fill="var(--muted)">{dateTime(points[points.length - 1][0])}</text>
      </svg>
      {h && <div className="tip" style={{ left: `${Math.min(80, (x(hover!) / W) * 100)}%` }}><b>{usd(h[1])}</b> · {dateTime(h[0])}</div>}
    </div>
  );
}

type Hist = [number, number][];

/** Spot price over the last two minutes, against the price to beat. */
function LiveLine({ points, strike, now }: { points: Hist; strike: number | null; now: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 600, H = 120, L = 6, R = 78, T = 10, B = 10, SPAN = 120;
  if (points.length < 2) return <div className="spark muted">Collecte des premiers prix…</div>;
  const ys = points.map((p) => p[1]).concat(strike ?? []);
  const lo = Math.min(...ys), hi = Math.max(...ys), pad = Math.max((hi - lo) * 0.15, hi * 0.00002);
  const x = (t: number) => L + ((t - (now - SPAN)) / SPAN) * (W - L - R);
  const y = (v: number) => T + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - T - B);
  const vis = points.filter((p) => p[0] >= now - SPAN);
  if (vis.length < 2) return <div className="spark muted">Collecte des premiers prix…</div>;
  const path = vis.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const last = vis[vis.length - 1];
  const h = hover !== null ? vis[Math.min(hover, vis.length - 1)] : null;
  return (
    <div className="spark chart" ref={ref}
      onMouseMove={(e) => { const r = ref.current!.getBoundingClientRect(); const t = now - SPAN + (((e.clientX - r.left) / r.width) * W - L) / (W - L - R) * SPAN; let best = 0; vis.forEach((p, i) => { if (Math.abs(p[0] - t) < Math.abs(vis[best][0] - t)) best = i; }); setHover(best); }}
      onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Prix sur les deux dernières minutes, comparé au prix à battre">
        {strike !== null && <>
          <line x1={L} x2={W - R} y1={y(strike)} y2={y(strike)} stroke="var(--muted)" strokeDasharray="4 4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <text x={W - R + 6} y={y(strike) + 4} fontSize="11" fill="var(--muted)">prix à battre</text>
        </>}
        <path d={path} fill="none" stroke="var(--series)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <circle cx={x(last[0])} cy={y(last[1])} r="4" fill="var(--series)" stroke="var(--surface)" strokeWidth="2" />
        {h && <line x1={x(h[0])} x2={x(h[0])} y1={T} y2={H - B} stroke="var(--muted)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
      {h && <div className="tip" style={{ left: `${Math.min(70, (x(h[0]) / W) * 100)}%` }}><b>{usd(h[1])}</b> · il y a {Math.max(0, Math.round(now - h[0]))} s</div>}
    </div>
  );
}

function Meter({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="meter">
      <span>{label}</span>
      <div className="track" aria-hidden><i style={{ width: `${Math.round((value ?? 0) * 100)}%` }} /></div>
      <b>{value === null ? '—' : `${Math.round(value * 100)} %`}</b>
    </div>
  );
}

/** One outcome's order book: sellers above (what you pay to buy), buyers below (what you get if you sell). */
function Book({ title, asks, bids }: { title: string; asks: [number, number][]; bids: [number, number][] }) {
  const maxSize = Math.max(1, ...asks.map((l) => l[1]), ...bids.map((l) => l[1]));
  const spread = asks[0] && bids[0] ? asks[0][0] - bids[0][0] : null;
  const shares = (n: number) => n.toLocaleString('fr-FR');
  return (
    <div className="book">
      <div className="book-title"><span>{title}</span><span>{asks[0] ? `achat à ${tick(asks[0][0])}` : ''}</span></div>
      {asks.length === 0 && bids.length === 0 ? <div className="muted">Carnet vide (ouverture ou clôture du marché).</div> : <>
        {[...asks].reverse().map(([p, n]) => (
          <div className="book-row ask" key={`a${p}`}><i style={{ width: `${(n / maxSize) * 100}%` }} /><span><b>{tick(p)}</b></span><span className="side">à vendre</span><span>{shares(n)}</span></div>
        ))}
        <div className="book-spread">{spread === null ? 'un seul côté coté' : `écart ${tick(spread)}`}</div>
        {bids.map(([p, n]) => (
          <div className="book-row bid" key={`b${p}`}><i style={{ width: `${(n / maxSize) * 100}%` }} /><span><b>{tick(p)}</b></span><span className="side">à acheter</span><span>{shares(n)}</span></div>
        ))}
      </>}
    </div>
  );
}

/** One market, live: spot price, the price to beat, both probabilities and the Polymarket order book. */
function LiveMarket({ asset, a, start, now, hist, dir }: { asset: 'btc' | 'eth'; a: LiveAsset; start: number; now: number; hist: Hist; dir: number }) {
  const left = Math.max(0, start + 300 - now);
  const diff = a.spot !== null && a.strike !== null ? a.spot - a.strike : null;
  return (
    <div className="card">
      <div className="live-head">
        <h2 style={{ margin: 0 }}><span className="live-dot" aria-hidden />{asset.toUpperCase()} · fenêtre de {time(start).slice(0, 5)}</h2>
        <span className="badge">{left > 0 ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')} restantes` : 'clôture…'}</span>
      </div>
      <div className="bar" aria-hidden style={{ marginTop: 8 }}><i style={{ width: `${Math.min(100, ((300 - left) / 300) * 100)}%` }} /></div>
      <div className="live-head" style={{ marginTop: 10 }}>
        <div className={`live-price ${dir > 0 ? 'pos' : dir < 0 ? 'neg' : ''}`}>{a.spot === null ? '—' : usd(a.spot)} <span style={{ fontSize: 16 }}>{dir > 0 ? '▲' : dir < 0 ? '▼' : ''}</span></div>
        <div className="sub">{diff === null || a.strike === null ? 'prix à battre en attente' : <>prix à battre {usd(a.strike)} · <b className={cls(diff)}>{diff >= 0 ? 'au-dessus de' : 'en dessous de'} {usd(Math.abs(diff))}</b></>}</div>
      </div>
      <LiveLine points={hist} strike={a.strike} now={now} />
      <Meter label="Hausse selon le marché" value={a.mid} />
      <Meter label="Hausse selon le modèle" value={a.qFair} />
      {asset === 'eth' && a.lead !== undefined && (
        <div className="sub" style={{ marginTop: 8 }}>
          Poussée du BTC sur 10 s : <b className={cls(a.lead ?? 0)}>{a.lead === null ? '—' : `${a.lead > 0 ? '+' : a.lead < 0 ? '−' : ''}${Math.abs(a.lead * 100).toFixed(1).replace('.', ',')} pts`}</b>
          {a.lead !== null && Math.abs(a.lead) >= 0.02 && a.mid !== null && a.qFair !== null
            ? <> · ETH {(a.lead > 0 ? a.qFair - a.mid : a.mid - a.qFair) > 0.03 ? <b>en retard de {Math.round(Math.abs(a.qFair - a.mid) * 100)}¢</b> : 'déjà à jour'}</>
            : <> · pas de poussée nette</>}
        </div>
      )}
      <div className="sub" style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between' }}><b>Carnets d’ordres Polymarket</b><span>{a.bookAgeMs === null ? 'connexion…' : `mis à jour il y a ${a.bookAgeMs} ms`}</span></div>
      <div className="books">
        <Book title="Pari « Hausse » ▲" asks={a.asks} bids={a.bids} />
        <Book title="Pari « Baisse » ▼" asks={a.asksDown ?? []} bids={a.bidsDown ?? []} />
      </div>
    </div>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className={`value ${tone || ''}`}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function Trades({ trades }: { trades: Trade[] }) {
  if (!trades.length) return <p className="muted">Aucun trade pour l’instant.</p>;
  const status = { open: ['En cours', 'info'], won: ['Gagné', 'good'], lost: ['Perdu', 'bad'], void: ['Annulé', ''], failed: ['Échec', 'warn'], sold: ['Vendu avant la fin', 'info'] } as const;
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th>Heure</th><th>Marché</th><th>Pari</th><th className="num">Parts</th><th className="num">Prix</th><th className="num">Mise</th><th className="num">Avantage estimé</th><th>Résultat</th><th className="num">Gain / perte</th><th>Stratégie</th></tr></thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id}>
              <td>{dateTime(t.openedAt)}</td><td>{t.asset.toUpperCase()}</td><td>{SIDE[t.side]}</td><td className="num">{t.shares.toFixed(1)}</td>
              <td className="num">{(t.price * 100).toFixed(1)}¢</td><td className="num">{usd(t.cost)}</td><td className="num">{(t.edge * 100).toFixed(1)}¢</td>
              <td><span className={`badge ${status[t.status][1]}`}>{status[t.status][0]}</span>{t.error ? <div className="muted">{t.error}</div> : null}</td>
              <td className={`num ${cls(t.pnl ?? 0)}`}>{t.pnl === undefined ? '—' : signed(t.pnl)}</td><td className="muted">{t.strategyId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Page() {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now() / 1000);
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<LiveFrame | null>(null);
  const [fps, setFps] = useState(0);
  const [link, setLink] = useState<{ stream: boolean; poll: boolean; age: number | null } | null>(null);
  const hist = useRef<{ btc: Hist; eth: Hist; dir: { btc: number; eth: number }; frames: number }>({ btc: [], eth: [], dir: { btc: 0, eth: 0 }, frames: 0 });
  const [engine, setEngine] = useState<Engine>('off');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Erreur');
      setV(j); setErr('');
    } catch (e) { setErr(String((e as Error).message)); }
  }, []);
  const engineRef = useRef<Engine>('off');
  engineRef.current = engine;
  const updatedRef = useRef(0);
  updatedRef.current = v?.updatedAt ?? 0;
  useEffect(() => {
    try {
      // A link ending in #jeton=… signs this browser in and starts the engine (the part after # never leaves the browser).
      const fromLink = window.location.hash.match(/jeton=([^&]+)/)?.[1];
      if (fromLink) {
        localStorage.setItem('adminToken', decodeURIComponent(fromLink));
        localStorage.setItem('engineOn', '1');
        window.history.replaceState(null, '', window.location.pathname);
      }
      setToken(localStorage.getItem('adminToken') || ''); setRunning(localStorage.getItem('engineOn') === '1');
    } catch {}
    load();
    // While the live stream is connected it carries everything; otherwise poll the saved state.
    // Poll gently: often while something is running elsewhere, rarely when nothing is happening.
    let lastLoad = Date.now();
    const c = setInterval(() => { setFps(hist.current.frames); hist.current.frames = 0; }, 1000);
    const a = setInterval(() => {
      if (engineRef.current === 'live') return;
      const idle = Date.now() / 1000 - (updatedRef.current || 0) > 600;
      if (Date.now() - lastLoad < (idle ? 60000 : 5000)) return;
      lastLoad = Date.now();
      load();
    }, 5000), b = setInterval(() => setClock(Date.now() / 1000), 1000);
    return () => { clearInterval(a); clearInterval(b); clearInterval(c); };
  }, [load]);

  // The engine runs on the server; this page keeps it running and shows what it sees.
  // Data arrives by two routes at once, and whichever works is used:
  //  - a long streamed response (also what keeps the server session alive),
  //  - a short request every second (works even where long responses are buffered or cut).
  // Reconnecting never starts a second session: the server attaches us to the one already running.
  useEffect(() => {
    if (!running) { setEngine('off'); setLive(null); setLink(null); return; }
    const abort = new AbortController();
    const headers = { authorization: `Bearer ${token}` };
    const queue: LiveFrame[] = [];
    let since = 0, viewAt = 0, lastFrame = 0, started = Date.now(), streamOpen = false, streamTried = 0, streamOk = 0, pollOk = 0, pause = 0;
    let wake: { release: () => Promise<void> } | null = null;
    (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen').then((w) => { wake = w; }).catch(() => {});
    setEngine('connecting');

    const accept = (f: LiveFrame, via: 'stream' | 'poll') => {
      if (via === 'stream') streamOk = Date.now(); else pollOk = Date.now();
      if (!(f.t > since)) return; // already received by the other route
      since = f.t;
      lastFrame = Date.now();
      queue.push(f);
    };
    const denied = () => { setEngine('denied'); setRunning(false); try { localStorage.setItem('engineOn', '0'); } catch {} };

    const openStream = async () => {
      streamOpen = true; streamTried = Date.now();
      try {
        const res = await fetch('/api/live', { headers, signal: abort.signal, cache: 'no-store' });
        if (res.status === 401) return denied();
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
            if (!line) continue;
            try {
              const f = JSON.parse(line);
              if (f.type === 'live') accept(f, 'stream');
              else if (f.type === 'end' && f.busy) pause = Date.now() + 15000; // another server holds the session
            } catch { /* a damaged line must never stop the stream */ }
          }
        }
      } catch { /* cut or refused: the short requests carry on, and we reopen below */ }
      finally { streamOpen = false; }
    };

    const poll = async () => {
      try {
        const r = await fetch(`/api/live?poll=1&since=${since}&v=${viewAt}`, { headers, signal: abort.signal, cache: 'no-store' });
        if (r.status === 401) return denied();
        if (!r.ok) return;
        const j = await r.json();
        if (j.view) { viewAt = j.viewAt; setV(j.view); setErr(''); }
        if (j.running) pollOk = Date.now(); // this route reaches the running session
        for (const f of j.frames as LiveFrame[]) accept(f, 'poll');
      } catch { /* next second */ }
    };

    // Every second: fetch what is new, and make sure a session is running.
    const tick = setInterval(() => {
      if (abort.signal.aborted) return;
      void poll();
      const quiet = Date.now() - Math.max(lastFrame, started);
      if (!streamOpen && Date.now() > pause && Date.now() - streamTried > 3000) void openStream();
      setEngine(Date.now() - lastFrame < 4000 ? 'live' : Date.now() < pause ? 'busy' : quiet > 12000 ? 'error' : 'connecting');
      setLink({ stream: Date.now() - streamOk < 4000, poll: Date.now() - pollOk < 4000, age: lastFrame ? (Date.now() - lastFrame) / 1000 : null });
    }, 1000);

    // Five times a second: show the next frame (a short buffer keeps the motion smooth).
    const play = setInterval(() => {
      if (queue.length > 8) queue.splice(0, queue.length - 4); // never lag far behind
      const f = queue.shift();
      if (!f) return;
      const hs = hist.current;
      hs.frames++;
      if (f.history) for (const k of ['btc', 'eth'] as const) {
        const known = hs[k].length ? hs[k][hs[k].length - 1][0] : 0;
        if (f.history[k]?.length && f.t - known > 3) hs[k] = f.history[k].filter((p) => p[0] < f.t);
      }
      for (const k of ['btc', 'eth'] as const) {
        const spot = f.assets[k]?.spot;
        if (typeof spot !== 'number') continue;
        const prev = hs[k][hs[k].length - 1];
        if (prev && spot !== prev[1]) hs.dir[k] = spot > prev[1] ? 1 : -1;
        hs[k].push([f.t, spot]);
        if (hs[k].length > 900) hs[k].splice(0, hs[k].length - 800);
      }
      setLive(f);
    }, 200);

    void openStream();
    return () => { abort.abort(); clearInterval(tick); clearInterval(play); wake?.release().catch(() => {}); setTimeout(load, 1500); };
  }, [running, token, load]);

  const toggleEngine = () => {
    const next = !running;
    setRunning(next);
    try { localStorage.setItem('engineOn', next ? '1' : '0'); } catch {}
  };

  const control = async (action: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setMsg('');
    try {
      const r = await fetch('/api/control', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ action }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Erreur');
      if (action === 'balance') setBalance(j.balance);
      setMsg(action === 'check' ? 'Jeton valide.' : 'Fait.');
      load();
    } catch (e) { setMsg(String((e as Error).message)); }
  };

  const acct = v ? v[mode] : null;
  const champion = useMemo(() => v?.strategies.find((s) => s.champion) ?? null, [v]);
  // Group the paper orders into signals: every setting that entered at the same instant, in the same direction.
  const signals = useMemo(() => {
    const groups = new Map<string, { id: string; t: number; side: 'up' | 'down'; lead: number | null; cost: number; n: number; outcomes: Map<string, { label: string; n: number; pnl: number; open: boolean }> }>();
    for (const e of v?.tape ?? []) {
      const id = `${e.key}|${e.side}|${Math.round(e.t)}`;
      let g = groups.get(id);
      if (!g) groups.set(id, (g = { id, t: e.t, side: e.side, lead: e.lead, cost: e.cost, n: 0, outcomes: new Map() }));
      g.n++;
      const label = !e.result ? 'position ouverte' : e.result === 'void' ? 'annulé' : `${RESULT[e.result].toLowerCase()} ${centsSigned(e.pnl)}`;
      const o = g.outcomes.get(label) ?? { label, n: 0, pnl: e.pnl ?? 0, open: !e.result };
      o.n++;
      g.outcomes.set(label, o);
    }
    return [...groups.values()].map((g) => ({ ...g, outcomes: [...g.outcomes.values()] }));
  }, [v]);
  const bestCandidate = useMemo(() => v?.strategies.filter((s) => s.n >= 5 && s.tstat !== null).sort((x, y) => (y.tstat ?? 0) - (x.tstat ?? 0))[0] ?? null, [v]);
  if (!v || !acct) return <main><h1>Polymarket 5 min</h1><p className="sub">{err || 'Chargement…'}</p></main>;

  const stale = engine !== 'live' && clock - v.updatedAt > 150;
  const engineLabel: Record<Engine, string> = {
    off: 'Moteur à l’arrêt', connecting: 'Connexion au moteur…', live: 'Moteur actif · temps réel', busy: 'Une session est déjà en cours sur un autre serveur : reprise automatique à sa fin (5 minutes au plus)',
    error: 'Aucune donnée reçue du serveur, nouvelles tentatives en cours…', denied: 'Jeton administrateur refusé',
  };
  const gateOpen = v.gate.every((g) => g.ok);
  const roi = acct.staked > 0 ? acct.pnl / acct.staked : null;
  const winRate = acct.nSettled ? acct.nWins / acct.nSettled : null;

  return (
    <main>
      <div className="row between">
        <div>
          <h1>Polymarket 5 min — BTC &amp; ETH</h1>
          <div className="sub">Stratégie : retard d’ETH sur BTC · génération {v.generation} · {v.settledWindows} marchés analysés</div>
        </div>
        <div className="row">
          <span className={`badge ${engine === 'live' ? 'good' : stale ? 'bad' : 'good'}`}>{engine === 'live' ? 'Moteur actif · temps réel' : stale ? `Moteur inactif depuis ${Math.round((clock - v.updatedAt) / 60)} min` : `Moteur actif · ${time(v.updatedAt)}`}</span>
          <button className="btn" onClick={() => control('resetAll', 'Remettre toutes les statistiques à zéro (stratégies, signaux, compte démo, tenue de marché) ?')}>Tout remettre à zéro</button>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={mode === 'demo'} onClick={() => setMode('demo')}>Démo</button>
            <button role="tab" aria-selected={mode === 'live'} onClick={() => setMode('live')}>Production</button>
          </div>
        </div>
      </div>
      {!v.settings.managed && (
        <section className="card" style={{ marginTop: 12 }}>
          <div className="row between">
            <div style={{ flex: 1, minWidth: 240 }}>
              <h2 style={{ marginBottom: 4 }}>Moteur temps réel</h2>
              <div className="sub">Le moteur tourne sur le serveur tant que cette page reste ouverte : il suit le carnet d’ordres en continu et vous envoie ce qu’il voit, cinq fois par seconde. Quand vous fermez la page ou cliquez sur Arrêter, la session en cours va à son terme (5 minutes au plus), se sauvegarde, puis le moteur s’arrête.</div>
            </div>
            <div className="row">
              {v.settings.adminRequired && (
                <input className="field" type="password" placeholder="Jeton administrateur" value={token} aria-label="Jeton administrateur"
                  onChange={(e) => { setToken(e.target.value); try { localStorage.setItem('adminToken', e.target.value); } catch {} }} />
              )}
              <button className={`btn ${running ? '' : 'primary'}`} disabled={!running && v.settings.adminRequired && !token} onClick={toggleEngine}>{running ? 'Arrêter le moteur' : 'Démarrer le moteur'}</button>
            </div>
          </div>
          {(running || engine === 'denied') && <div className="sub" style={{ marginTop: 8 }}>
            <span className={`badge ${engine === 'live' ? 'good' : engine === 'denied' || engine === 'error' ? 'bad' : 'warn'}`}>{engineLabel[engine]}</span>
            {link && <span className="muted"> · flux continu : {link.stream ? 'reçu' : 'non reçu'} · requêtes courtes : {link.poll ? 'reçues' : 'non reçues'} · dernière donnée : {link.age === null ? 'aucune' : `il y a ${link.age.toFixed(1).replace('.', ',')} s`}</span>}
          </div>}
        </section>
      )}
      {err && <div className="banner">Connexion au serveur perdue : {err}</div>}
      {!v.settings.durable && <div className="banner">Stockage non persistant : l’historique sera perdu entre deux exécutions. Connectez un stockage Vercel Blob ou Upstash Redis au projet.</div>}
      {v.control.killSwitch && <div className="banner">Arrêt d’urgence actif : aucun nouveau trade (démo ou réel) n’est ouvert.</div>}

      {live && running && (
        <section>
          <div className="sub" style={{ marginBottom: 8 }}><span className="live-dot" aria-hidden />En direct depuis le serveur · {fps} mises à jour par seconde{engine !== 'live' ? ' · en attente de nouvelles données…' : ''}</div>
          <div className="grid g2">
            {(['btc', 'eth'] as const).map((k) => <LiveMarket key={k} asset={k} a={live.assets[k]} start={live.windowStart} now={live.t} hist={hist.current[k]} dir={hist.current.dir[k]} />)}
          </div>
        </section>
      )}
      {!(live && running) && <section className="grid g2">
        {(['btc', 'eth'] as const).map((a) => {
          const s = v.snapshots[a];
          if (!s) return <div className="card" key={a}><h2>{a.toUpperCase()}</h2><p className="muted">En attente du premier passage du moteur.</p></div>;
          const left = Math.max(0, s.windowStart + 300 - clock);
          const diff = s.spot / s.strike - 1;
          return (
            <div className="card" key={a}>
              <div className="row between"><h2>{a.toUpperCase()} · fenêtre de {time(s.windowStart).slice(0, 5)} <span className="badge warn">dernier état enregistré — pas en direct</span></h2><span className="badge">{left > 0 ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')} restantes` : 'clôture…'}</span></div>
              <div className="bar" aria-hidden><i style={{ width: `${Math.min(100, ((300 - left) / 300) * 100)}%` }} /></div>
              <div className="kv" style={{ marginTop: 10 }}>
                <span>Prix actuel</span><span>{usd(s.spot)}</span>
                <span>Prix à battre (départ)</span><span>{usd(s.strike)} <span className={cls(diff)}>({pct(diff, 3)})</span></span>
                <span>Probabilité de hausse — marché</span><span>{cents(s.mid)}</span>
                <span>Probabilité de hausse — juste valeur</span><span>{cents(s.qFair)}</span>
                <span>Probabilité de hausse — modèle appris</span><span>{s.qModel === null ? 'en apprentissage' : cents(s.qModel)}</span>
                <span>Achat Hausse / Baisse</span><span>{cents(s.askUp)} / {cents(s.askDown)}</span>
                <span>Âge des données ({s.source.includes('temps réel') ? 'flux temps réel' : 'interrogation périodique'})</span><span>{s.latencyMs === undefined ? '—' : `${s.latencyMs} ms`}</span>
              </div>
            </div>
          );
        })}
      </section>}

      {mode === 'live' && (
        <section className="grid g2">
          <div className="card">
            <div className="row between"><h2>Conditions avant tout trade réel</h2><span className={`badge ${gateOpen ? 'good' : 'warn'}`}>{gateOpen ? 'Toutes remplies — trading réel actif' : 'Trading réel bloqué'}</span></div>
            {v.gate.map((g) => (
              <div className="check" key={g.id}><span className={`mark ${g.ok ? 'pos' : 'neg'}`}>{g.ok ? '✓' : '✗'}</span><span style={{ flex: 1 }}>{g.label}</span><span className="muted">{g.detail}</span></div>
            ))}
          </div>
          <div className="card">
            <h2>Commandes</h2>
            <p className="sub">Mise par trade : {usd(v.settings.liveStakeUsd)} · perte maximale par jour : {usd(v.settings.liveMaxDailyLoss)}. La production copie les trades du champion de la démo, uniquement quand toutes les conditions sont remplies.</p>
            {v.settings.adminRequired && <p className="sub">Les commandes utilisent le jeton administrateur saisi en haut de page. <button className="btn" onClick={() => control('check')}>Vérifier le jeton</button></p>}
            <div className="row" style={{ marginTop: 10 }}>
              {v.control.liveArmed
                ? <button className="btn" onClick={() => control('disarm')}>Désarmer</button>
                : <button className="btn primary" disabled={!v.settings.liveConfigured} onClick={() => control('arm', 'Armer le trading avec de l’argent réel ?')}>Armer le trading réel</button>}
              {v.control.killSwitch
                ? <button className="btn" onClick={() => control('resume')}>Lever l’arrêt d’urgence</button>
                : <button className="btn danger" onClick={() => control('kill')}>Arrêt d’urgence</button>}
              <button className="btn" disabled={!v.settings.liveConfigured} onClick={() => control('balance')}>Voir le solde</button>
            </div>
            {balance !== null && <p className="sub">Solde USDC disponible : <b>{usd(balance)}</b></p>}
            {msg && <p className="sub">{msg}</p>}
            {!v.settings.liveConfigured && <p className="muted">Le trading réel n’est pas configuré sur ce déploiement (voir le README).</p>}
          </div>
        </section>
      )}

      <section className="grid g4">
        {mode === 'demo'
          ? <Tile label="Capital fictif" value={usd(acct.bankroll)} hint={`départ ${usd(acct.startBankroll, 0)}${acct.open ? ` · ${acct.open} trade(s) en cours` : ''}`} />
          : <Tile label="Argent engagé au total" value={usd(acct.staked)} hint={`${acct.open} trade(s) en cours`} />}
        <Tile label="Gain / perte net" value={signed(acct.pnl)} tone={cls(acct.pnl)} hint={`dont frais payés ${usd(acct.fees)}`} />
        <Tile label="Rendement par dollar misé" value={pct(roi)} tone={cls(roi ?? 0)} hint={`${usd(acct.staked, 0)} misés`} />
        <Tile label="Trades gagnés" value={winRate === null ? '—' : `${(winRate * 100).toFixed(0)} %`} hint={`${acct.nWins} sur ${acct.nSettled} trades réglés`} />
      </section>

      <section className="card">
        <h2>{mode === 'demo' ? 'Capital fictif, trade après trade' : 'Résultat cumulé en argent réel, trade après trade'}</h2>
        <EquityChart points={acct.equity} start={acct.startBankroll} />
        {mode === 'demo' && !champion && <p className="sub">Le compte démo ne trade que lorsqu’une stratégie a un avantage prouvé. Aucune n’y est encore parvenue : il reste à l’écart, ce qui évite de perdre de l’argent sur de la chance.</p>}
      </section>

      <section className="card">
        <div className="row between"><h2>{mode === 'demo' ? 'Trades de la démo' : 'Trades réels'}</h2>
          {mode === 'demo' && <button className="btn" onClick={() => control('resetDemo', 'Remettre le compte démo à zéro ?')}>Remettre à zéro</button>}</div>
        <Trades trades={acct.trades} />
      </section>

      {v.mm?.enabled && (
        <section className="card">
          <h2>Tenue de marché (simulation)</h2>
          <p className="sub">Le système place en permanence deux ordres d’achat, l’un sur « Hausse » et l’autre sur « Baisse », aux meilleurs prix de chaque carnet, sur BTC et ETH, renouvelés toutes les {v.mm.seconds} secondes. Après une bougie verte il demande {2 * v.mm.size} parts de Hausse et {v.mm.size} de Baisse ; après une bougie rouge, {v.mm.size} de Hausse et {2 * v.mm.size} de Baisse. Le stock est plafonné à {v.mm.maxStock} parts par côté et par marché : au plafond, le système ne demande plus que l’autre côté. Un ordre n’est compté exécuté que si une vraie transaction le traverse, ou l’atteint après les ordres qui étaient devant lui. Aucun frais sur ces ordres ; {Math.round(v.mm.rebate * 100)} % des frais payés par la contrepartie alimentent le compte de récompenses.</p>
          <div className="grid g4" style={{ marginTop: 10 }}>
            <Tile label="Résultat du trading" value={signed(v.mm.pnl)} tone={cls(v.mm.pnl)} hint={`${v.mm.markets} marchés réglés`} />
            <Tile label="Compte de récompenses (pUSD)" value={usd(v.mm.rewards)} tone="pos" hint={`${Math.round(v.mm.rebate * 100)} % des frais des contreparties`} />
            <Tile label="Total" value={signed(v.mm.pnl + v.mm.rewards)} tone={cls(v.mm.pnl + v.mm.rewards)} hint="trading + récompenses" />
            <Tile label="Ordres exécutés" value={String(v.mm.fills)} hint={`en stock : ${Math.round(v.mm.stockUp)} Hausse · ${Math.round(v.mm.stockDown)} Baisse`} />
          </div>
          {v.mm.recent.length > 0 && (
            <div className="tablewrap" style={{ marginTop: 10 }}><table>
              <thead><tr><th>Heure</th><th>Marché</th><th>Bougie</th><th>Exécution</th><th className="num">Parts</th><th className="num">Prix</th><th className="num">Récompense</th></tr></thead>
              <tbody>{v.mm.recent.map((f, i) => (
                <tr key={i}><td>{time(f.t)}</td><td>{f.asset.toUpperCase()}</td><td>{f.candle === 'green' ? 'verte' : f.candle === 'red' ? 'rouge' : 'neutre'}</td>
                  <td><b>{f.side === 'buy' ? 'Achat Hausse ▲' : 'Achat Baisse ▼'}</b></td><td className="num">{f.shares}</td><td className="num">{tick(f.side === 'buy' ? f.price : 1 - f.price)}</td><td className="num">{(f.rebate * 100).toFixed(1)}¢</td></tr>))}</tbody>
            </table></div>
          )}
        </section>
      )}

      <section className="card">
        <h2>Derniers signaux</h2>
        {signals.length === 0 ? <p className="muted">Aucun pour l’instant : le moteur attend qu’ETH soit en retard ou parte avec de l’avance.</p> : (<>
          <p className="sub">Sur les {signals.length} derniers signaux : <b>{signals.filter((g) => g.side === 'up').length} à la hausse</b> et <b>{signals.filter((g) => g.side === 'down').length} à la baisse</b>. Le sens suit la poussée du BTC (stratégie « retard ») ou le côté où ETH a pris de l’avance à l’ouverture (stratégie « départ en avance », sans poussée affichée). Plusieurs réglages entrent souvent au même instant ; ils sont regroupés sur une ligne.</p>
          <div className="tablewrap"><table>
            <thead><tr><th>Heure</th><th>Pari</th><th className="num">Poussée du BTC</th><th className="num">Coût par part</th><th className="num">Réglages entrés</th><th>Ce qu’ils sont devenus</th></tr></thead>
            <tbody>{signals.slice(0, 20).map((g) => (
              <tr key={g.id}>
                <td>{time(g.t)}</td>
                <td><b>ETH {SIDE[g.side]} {g.side === 'up' ? '▲' : '▼'}</b></td>
                <td className="num">{g.lead === null ? '—' : `${g.lead > 0 ? '+' : '−'}${Math.abs(g.lead * 100).toFixed(1)} pts`}</td>
                <td className="num">{(g.cost * 100).toFixed(1)}¢</td>
                <td className="num">{g.n}</td>
                <td>{g.outcomes.map((o) => (
                  <span key={o.label} className={`badge ${o.open ? 'info' : o.pnl > 0 ? 'good' : o.pnl < 0 ? 'bad' : ''}`} style={{ marginRight: 6 }}>{o.n} × {o.label}</span>
                ))}</td>
              </tr>))}</tbody>
          </table></div>
        </>)}
      </section>

      <section className="card">
        <div className="row between"><h2>Stratégies en compétition</h2><span className="sub">prochaine sélection dans {v.nextEvolveIn} marchés</span></div>
        <div className="banner" style={{ marginTop: 0, marginBottom: 10, background: champion ? 'var(--good-bg)' : 'var(--accent-bg)', color: 'var(--text)' }}>
          {champion
            ? <>Avantage prouvé : <b>{champion.id}</b> gagne {centsSigned(champion.edge)} par part sur {champion.n} trades (t = {champion.tstat?.toFixed(1)}).</>
            : bestCandidate
              ? <>Aucun avantage prouvé pour l’instant. Meilleur candidat : <b>{bestCandidate.id}</b>, {centsSigned(bestCandidate.edge)} ± {((bestCandidate.se ?? 0) * 100).toFixed(1)}¢ par part sur {bestCandidate.n} trades (t = {bestCandidate.tstat?.toFixed(1)}). Il faut t ≥ {v.settings.championZ} sur au moins {v.settings.championMinTrades} trades.</>
              : <>Aucun trade simulé pour l’instant. Une stratégie devient champion avec t ≥ {v.settings.championZ} sur au moins {v.settings.championMinTrades} trades.</>}
        </div>
        <p className="sub">Deux idées, toutes deux sur ETH. « Retard » (24 réglages) : acheter quand le prix Polymarket d’ETH est en retard sur sa juste valeur <b>et</b> que le BTC vient de pousser dans le même sens. « Départ en avance » (6 réglages) : dans les premières secondes d’un marché, acheter quand ETH est déjà au-dessus ou en dessous du prix à battre alors que le carnet est encore proche de 50¢. Aucun trade sur BTC. Trois quarts des réglages revendent tôt (objectif de gain, stop, durée maximale) ; un quart garde jusqu’à la fin, pour comparer. Chaque stratégie parie fictivement 10 $. L’ordre n’est compté que si le prix est encore disponible une demi-seconde plus tard dans le carnet, le temps qu’un vrai ordre arrive. « Gain par part » : ce que rapporte en moyenne une part achetée, frais déduits ; il faut qu’il soit positif de façon fiable (t élevé) pour gagner de l’argent.</p>
        <div className="tablewrap">
          <table>
            <thead><tr><th>Stratégie</th><th>Type</th><th>Réglages</th><th className="num">Trades</th><th className="num">Ordres exécutés</th><th className="num">Gagnés</th><th className="num">Gain par part</th><th className="num">Récent</th><th className="num">Par dollar misé</th><th className="num">Fiabilité (t)</th></tr></thead>
            <tbody>
              {v.strategies.map((s) => (
                <tr key={s.id}>
                  <td>{s.id} {s.champion && <span className="badge good">Champion</span>}{s.parent && <div className="muted">issue de {s.parent}</div>}</td>
                  <td>{s.familyLabel}</td><td className="muted">{s.summary}</td><td className="num">{s.n}</td>
                  <td className="num">{s.signals ? `${Math.round((s.n / s.signals) * 100)} %` : '—'}</td>
                  <td className="num">{s.n ? `${((s.wins / s.n) * 100).toFixed(0)} %` : '—'}</td>
                  <td className={`num ${cls(s.edge ?? 0)}`}>{centsSigned(s.edge)}</td><td className={`num ${cls(s.recent ?? 0)}`}>{centsSigned(s.recent)}</td>
                  <td className={`num ${cls(s.roi ?? 0)}`}>{pct(s.roi)}</td>
                  <td className="num">{s.tstat === null ? '—' : s.tstat.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid g2">
        <div className="card">
          <h2>Qualité des prévisions</h2>
          <p className="sub">Erreur moyenne de chaque prévision sur les ~500 dernières mesures (plus bas = meilleur ; 0,693 = pile ou face). Pour gagner, il faut faire nettement mieux que le marché, frais compris.</p>
          <div className="tablewrap"><table>
            <thead><tr><th>Actif</th><th className="num">Marché</th><th className="num">Juste valeur</th><th className="num">Modèle appris</th><th className="num">Exemples appris</th></tr></thead>
            <tbody>{(['btc', 'eth'] as const).map((a) => { const m = v.models[a]; return (
              <tr key={a}><td>{a.toUpperCase()}</td><td className="num">{m.llMarket.toFixed(3)}</td><td className="num">{m.llFair.toFixed(3)}</td><td className="num">{m.llModel.toFixed(3)}</td><td className="num">{m.n}</td></tr>); })}</tbody>
          </table></div>
          <h2 style={{ marginTop: 16 }}>Derniers marchés</h2>
          <div className="row" style={{ gap: 6 }}>{v.recent.slice(0, 24).map((r) => (
            <span key={r.key} className={`badge ${r.outcome === 'up' ? 'good' : r.outcome === 'down' ? 'bad' : ''}`} title={`${time(r.start)} · ${r.shadows} stratégie(s) ont parié`}>{r.asset.toUpperCase()} {r.outcome === 'up' ? '▲ hausse' : r.outcome === 'down' ? '▼ baisse' : 'annulé'}</span>))}
            {!v.recent.length && <span className="muted">Aucun marché réglé pour l’instant.</span>}</div>
        </div>
        <div className="card">
          <h2>Journal</h2>
          <div className="log">{v.log.map((l, i) => (<div key={i}><span className="muted">{dateTime(l.t)}</span> · {l.msg}</div>))}</div>
        </div>
      </section>
    </main>
  );
}
