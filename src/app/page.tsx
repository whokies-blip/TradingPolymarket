'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { View } from '@/lib/view';
import type { Trade } from '@/lib/types';

const usd = (x: number, d = 2) => `${x < 0 ? '−' : ''}${Math.abs(x).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d })} $`;
const signed = (x: number) => `${x > 0 ? '+' : ''}${usd(x)}`;
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d)} %`);
const centsSigned = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(1)}¢`);
const cents = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(0)}¢`);
const time = (t: number) => new Date(t * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = (t: number) => new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const cls = (x: number) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const SIDE = { up: 'Hausse', down: 'Baisse' } as const;

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
  const status = { open: ['En cours', 'info'], won: ['Gagné', 'good'], lost: ['Perdu', 'bad'], void: ['Annulé', ''], failed: ['Échec', 'warn'] } as const;
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
    try { setToken(localStorage.getItem('adminToken') || ''); setRunning(localStorage.getItem('engineOn') === '1'); } catch {}
    load();
    // While the live stream is connected it carries everything; otherwise poll the saved state.
    // Poll gently: often while something is running elsewhere, rarely when nothing is happening.
    let lastLoad = Date.now();
    const a = setInterval(() => {
      if (engineRef.current === 'live') return;
      const idle = Date.now() / 1000 - (updatedRef.current || 0) > 600;
      if (Date.now() - lastLoad < (idle ? 60000 : 5000)) return;
      lastLoad = Date.now();
      load();
    }, 5000), b = setInterval(() => setClock(Date.now() / 1000), 1000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [load]);

  // The engine runs on the server for as long as this page keeps a live session open:
  // each session lasts about five minutes, and we reconnect as soon as one ends.
  useEffect(() => {
    if (!running) { setEngine('off'); return; }
    const abort = new AbortController();
    let wake: { release: () => Promise<void> } | null = null;
    (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen').then((w) => { wake = w; }).catch(() => {});
    const wait = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); abort.signal.addEventListener('abort', () => { clearTimeout(t); r(); }); });
    (async () => {
      while (!abort.signal.aborted) {
        let pause = 1000;
        try {
          setEngine((e) => (e === 'live' ? e : 'connecting'));
          const res = await fetch('/api/live', { headers: { authorization: `Bearer ${token}` }, signal: abort.signal, cache: 'no-store' });
          if (res.status === 401) { setEngine('denied'); setRunning(false); try { localStorage.setItem('engineOn', '0'); } catch {} return; }
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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
              const f = JSON.parse(line);
              if (f.type === 'view') { setV(f.view); setErr(''); setEngine('live'); }
              else if (f.type === 'tick') { setV((prev) => (prev ? { ...prev, now: f.now, snapshots: f.snapshots } : prev)); setEngine('live'); }
              else if (f.type === 'end') {
                if (f.busy) { setEngine('busy'); pause = 15000; }
                else if (f.mode !== 'realtime') { setEngine('error'); pause = 5000; }
              }
            }
          }
        } catch {
          if (abort.signal.aborted) break;
          setEngine('error'); pause = 5000;
        }
        await wait(pause);
      }
    })();
    return () => { abort.abort(); wake?.release().catch(() => {}); setTimeout(load, 1500); };
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
  const bestCandidate = useMemo(() => v?.strategies.filter((s) => s.n >= 5 && s.tstat !== null).sort((x, y) => (y.tstat ?? 0) - (x.tstat ?? 0))[0] ?? null, [v]);
  if (!v || !acct) return <main><h1>Polymarket 5 min</h1><p className="sub">{err || 'Chargement…'}</p></main>;

  const stale = engine !== 'live' && clock - v.updatedAt > 150;
  const engineLabel: Record<Engine, string> = {
    off: 'Moteur à l’arrêt', connecting: 'Connexion au moteur…', live: 'Moteur actif · temps réel', busy: 'Une session est déjà en cours sur le serveur : reprise automatique à sa fin (5 minutes au plus)',
    error: 'Flux interrompu, nouvelle tentative…', denied: 'Jeton administrateur refusé',
  };
  const gateOpen = v.gate.every((g) => g.ok);
  const roi = acct.staked > 0 ? acct.pnl / acct.staked : null;
  const winRate = acct.nSettled ? acct.nWins / acct.nSettled : null;

  return (
    <main>
      <div className="row between">
        <div>
          <h1>Polymarket 5 min — BTC &amp; ETH</h1>
          <div className="sub">Trading automatisé auto-améliorant · génération {v.generation} · {v.settledWindows} marchés analysés</div>
        </div>
        <div className="row">
          <span className={`badge ${engine === 'live' ? 'good' : stale ? 'bad' : 'good'}`}>{engine === 'live' ? 'Moteur actif · temps réel' : stale ? `Moteur inactif depuis ${Math.round((clock - v.updatedAt) / 60)} min` : `Moteur actif · ${time(v.updatedAt)}`}</span>
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
              <div className="sub">Le moteur tourne sur le serveur tant que cette page reste ouverte : il suit le carnet d’ordres en continu et vous envoie ce qu’il voit, seconde par seconde. Quand vous fermez la page ou cliquez sur Arrêter, la session en cours va à son terme (5 minutes au plus), se sauvegarde, puis le moteur s’arrête.</div>
            </div>
            <div className="row">
              {v.settings.adminRequired && (
                <input className="field" type="password" placeholder="Jeton administrateur" value={token} aria-label="Jeton administrateur"
                  onChange={(e) => { setToken(e.target.value); try { localStorage.setItem('adminToken', e.target.value); } catch {} }} />
              )}
              <button className={`btn ${running ? '' : 'primary'}`} disabled={!running && v.settings.adminRequired && !token} onClick={toggleEngine}>{running ? 'Arrêter le moteur' : 'Démarrer le moteur'}</button>
            </div>
          </div>
          {(running || engine === 'denied') && <div className="sub" style={{ marginTop: 8 }}><span className={`badge ${engine === 'live' ? 'good' : engine === 'denied' || engine === 'error' ? 'bad' : 'warn'}`}>{engineLabel[engine]}</span></div>}
        </section>
      )}
      {err && <div className="banner">Connexion au serveur perdue : {err}</div>}
      {!v.settings.durable && <div className="banner">Stockage non persistant : l’historique sera perdu entre deux exécutions. Connectez un stockage Vercel Blob ou Upstash Redis au projet.</div>}
      {v.control.killSwitch && <div className="banner">Arrêt d’urgence actif : aucun nouveau trade (démo ou réel) n’est ouvert.</div>}

      <section className="grid g2">
        {(['btc', 'eth'] as const).map((a) => {
          const s = v.snapshots[a];
          if (!s) return <div className="card" key={a}><h2>{a.toUpperCase()}</h2><p className="muted">En attente du premier passage du moteur.</p></div>;
          const left = Math.max(0, s.windowStart + 300 - clock);
          const diff = s.spot / s.strike - 1;
          return (
            <div className="card" key={a}>
              <div className="row between"><h2>{a.toUpperCase()} · fenêtre de {time(s.windowStart).slice(0, 5)}</h2><span className="badge">{left > 0 ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')} restantes` : 'clôture…'}</span></div>
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
      </section>

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

      <section className="card">
        <div className="row between"><h2>Stratégies en compétition</h2><span className="sub">prochaine sélection dans {v.nextEvolveIn} marchés</span></div>
        <div className="banner" style={{ marginTop: 0, marginBottom: 10, background: champion ? 'var(--good-bg)' : 'var(--accent-bg)', color: 'var(--text)' }}>
          {champion
            ? <>Avantage prouvé : <b>{champion.id}</b> gagne {centsSigned(champion.edge)} par part sur {champion.n} trades (t = {champion.tstat?.toFixed(1)}).</>
            : bestCandidate
              ? <>Aucun avantage prouvé pour l’instant. Meilleur candidat : <b>{bestCandidate.id}</b>, {centsSigned(bestCandidate.edge)} ± {((bestCandidate.se ?? 0) * 100).toFixed(1)}¢ par part sur {bestCandidate.n} trades (t = {bestCandidate.tstat?.toFixed(1)}). Il faut t ≥ {v.settings.championZ} sur au moins {v.settings.championMinTrades} trades.</>
              : <>Aucun trade simulé pour l’instant. Une stratégie devient champion avec t ≥ {v.settings.championZ} sur au moins {v.settings.championMinTrades} trades.</>}
        </div>
        <p className="sub">Chaque stratégie parie fictivement 10 $. L’ordre n’est compté que si le prix est encore disponible une demi-seconde plus tard dans le carnet, le temps qu’un vrai ordre arrive. « Gain par part » : ce que rapporte en moyenne une part achetée, frais déduits ; il faut qu’il soit positif de façon fiable (t élevé) pour gagner de l’argent.</p>
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
