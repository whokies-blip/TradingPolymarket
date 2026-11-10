# TradingPolymarket

Système de trading automatisé pour les marchés **« Bitcoin / Ethereum Up or Down – 5 minutes »** de Polymarket, déployé sur Vercel, avec un mode **Démo** (argent fictif, prix réels) et un mode **Production** (argent réel, verrouillé par défaut).

> **Avertissement.** Rien ne garantit un gain. Ces marchés sont très efficients et Polymarket prélève des frais d'environ 3,5 % de la mise à 50 ¢. Un backtest sur 4 jours (1 152 marchés par actif) montre un avantage apparent qui **disparaît dès que l'information a 10 secondes de retard**. Le mode Démo sert précisément à mesurer, aux prix réels, si un avantage existe. N'activez la Production qu'avec de l'argent que vous pouvez perdre, et seulement si Polymarket est autorisé là où vous vivez.

## Fonctionnement

Chaque minute, Vercel Cron appelle `/api/cron/tick`, qui surveille les marchés pendant ~50 s (un passage toutes les 10 s) :

1. **Données** — prix spot à la seconde (Binance, repli Coinbase en lecture seule), marché et carnet d'ordres Polymarket.
2. **Juste valeur** — le marché paie « Hausse » si la moyenne des 60 dernières secondes dépasse la moyenne des 60 secondes précédant l'ouverture (vérifié à 98 % sur l'historique). Le modèle calcule la probabilité correspondante à partir de l'écart au prix de départ, de la volatilité et du temps restant.
3. **24 stratégies en compétition** (5 familles : juste valeur, modèle appris, momentum, retour à la moyenne, suivi du favori). Chacune « parie » fictivement 10 $ aux prix réels du carnet, frais inclus.
4. **Règlement** sur le résultat officiel publié par Polymarket.

### Auto-amélioration

- **Modèle en ligne** : une régression logistique part d'une copie du marché et apprend, après chaque marché réglé, à corriger la probabilité. Le tableau de bord compare son erreur à celle du marché.
- **Champion** : la stratégie au meilleur rendement prudent (moyenne − 1 erreur-type, les trades récents pesant plus) pilote le compte. Sans stratégie prouvée et rentable, le système **ne trade pas**.
- **Évolution** : tous les 48 marchés réglés, les stratégies perdantes sont remplacées par des variantes mutées des meilleures.

### Démo et Production

| | Démo | Production |
|---|---|---|
| Argent | fictif (1 000 $ par défaut) | réel (USDC sur Polymarket) |
| Prix | carnet d'ordres réel, frais réels | ordres réels « fill-or-kill » |
| Mise | Kelly fractionné (¼), max 3 % du capital | fixe (`LIVE_STAKE_USD`, 5 $ par défaut) |
| Déclenchement | dès qu'un champion existe | copie le champion **seulement si toutes les conditions sont remplies** |

Conditions de la Production : `LIVE_TRADING=true`, portefeuille configuré, région non bloquée par Polymarket, armement manuel depuis le tableau de bord, arrêt d'urgence inactif, champion avec ≥ 100 trades et t ≥ 2, compte démo rentable sur ses 50 derniers trades, perte du jour sous la limite.

**Le chemin d'ordres réels n'a jamais été exécuté avec de vrais fonds** : commencez avec la mise minimale. Les gains des marchés gagnés doivent être encaissés (« Claim ») dans l'interface Polymarket.

## Déploiement Vercel

1. Importer le dépôt dans Vercel (Next.js détecté automatiquement).
2. Connecter un stockage au projet : **Vercel Blob** (privé) ou **Upstash Redis**. Sans stockage, l'historique n'est pas conservé.
3. Définir `CRON_SECRET` et `ADMIN_TOKEN` (voir `.env.example` pour toutes les variables).
4. **Déclenchement du moteur** — le moteur doit être appelé en continu :
   - **Vercel Pro** : remplacer le `schedule` de `vercel.json` par `* * * * *` (cron à la minute, chaque appel surveille ~50 s).
   - **Vercel Hobby** (un seul cron par jour autorisé) : le workflow `.github/workflows/tick.yml` appelle le moteur toutes les 15 s. Il s'active une fois présent sur la branche par défaut, avec la variable de dépôt `TICK_URL` (ex. `https://tradingpolymarket.vercel.app`) et le secret `CRON_SECRET`. Les crons GitHub peuvent prendre du retard ; pour de l'argent réel, préférez Vercel Pro.
5. **Quotas** — le moteur écrit son état à chaque appel. Le quota gratuit de Vercel Blob (Hobby) est trop faible pour un usage continu : utilisez Upstash Redis (offre gratuite suffisante) ou Vercel Pro.

Pour la Production, ajouter `LIVE_TRADING=true`, `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER_ADDRESS` et `POLYMARKET_SIGNATURE_TYPE`, puis armer depuis l'onglet Production.

## Développement

```bash
npm install
npm run dev          # tableau de bord sur http://localhost:3000
curl "localhost:3000/api/cron/tick?once=1"   # un passage du moteur
npm test
```

En local, l'état est stocké dans `.data/state.json`.
