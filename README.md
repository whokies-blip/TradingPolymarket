# TradingPolymarket

Système de trading automatisé pour les marchés **« Bitcoin / Ethereum Up or Down – 5 minutes »** de Polymarket, déployé sur Vercel, avec un mode **Démo** (argent fictif, prix réels) et un mode **Production** (argent réel, verrouillé par défaut).

> **Avertissement.** Rien ne garantit un gain, et les données disponibles disent plutôt le contraire : voir « Ce que montrent les données ». N'activez la Production qu'avec de l'argent que vous pouvez perdre, et seulement si Polymarket est autorisé là où vous vivez.

## Lancer sur votre Mac (recommandé)

Un ordinateur allumé fait tourner le moteur temps réel en continu, sans les limites de Vercel.

1. Installer [Node.js](https://nodejs.org) (version 22 ou plus récente).
2. Récupérer le code, puis double-cliquer sur **`start-mac.command`** dans le dossier (ou lancer `npm install` puis `npm run local` dans un terminal).
3. Le tableau de bord s'ouvre sur http://localhost:3000. Le terminal affiche l'état toutes les 30 secondes et chaque événement (trade, nouveau champion, problème).
4. `Ctrl+C` arrête proprement. Tout l'historique est conservé dans `.data/state.json` et repris au prochain lancement.

En cas de message d'erreur de connexion (par exemple « HTTP 403 » ou « injoignable »), lancez `npm run check` : il teste depuis votre ordinateur chaque service utilisé et indique lequel est bloqué. Polymarket restreint l'accès depuis certains pays et refuse souvent les VPN ; ce système ne contourne pas ces restrictions.

`start-mac.command` empêche la mise en veille tant que le moteur tourne ; gardez le Mac branché et le capot ouvert. Options : `PORT=4000 npm run local` (autre port), `npm run local -- --no-dashboard` (moteur seul).

Pour la Production en local, créer un fichier `.env.local` (jamais envoyé sur GitHub) avec `LIVE_TRADING=true`, `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER_ADDRESS` et `POLYMARKET_SIGNATURE_TYPE`, relancer, puis armer depuis l'onglet Production.

## Ce que montrent les données

Tests menés sur 1 152 marchés BTC réels (4 jours, ~1 500 transactions par marché, prix spot à la seconde) :

- **La vitesse décide de tout.** En réagissant en ~0,5 s aux gros écarts entre la juste valeur et le prix du marché (≥ 10 ¢ après frais), la simulation donne **+3,6 ¢ par part** avec une hypothèse d'exécution prudente (t = 2,1) et +6,9 ¢ avec une hypothèse optimiste (t = 4,6). À 1,5 s de retard il ne reste presque rien ; à 2,5 s et au-delà, on perd.
- **Les petits écarts perdent toujours** : en dessous de ~7 ¢, les frais (7 % × p(1−p)) et les robots plus rapides mangent tout. Un achat « au hasard » coûte environ 3 ¢ par part.
- **Rien d'autre ne marche** : sur ~80 règles testées à 2-3 s de retard (favori, outsider, momentum, retour à la moyenne, flux d'ordres, modèle appris, ordres passifs), aucune n'a d'avantage positif fiable.
- **Le marché prévoit mieux que notre modèle dans la dernière minute** (il voit directement le flux Chainlink qui sert au règlement) : le moteur n'ouvre plus de position à ce moment-là.
- La première version de ce système (un passage toutes les 10 s, champion désigné après 15 trades), rejouée sur ces 4 jours, couronnait une stratégie « chanceuse » 89 % du temps et perdait 45 % du capital démo.

Ces chiffres viennent de 4 jours seulement et d'une exécution simulée : c'est une piste sérieuse, pas une preuve. Le mode Démo temps réel sert à la confirmer ou à l'infirmer, en quelques jours de fonctionnement continu.

Pour rejouer le moteur (mode périodique) sur un historique : `npx tsx scripts/replay.ts <grille.json>` (une grille par marché : cotations exécutables toutes les 10 s et entrées du modèle).

## Fonctionnement

Le moteur (`/api/cron/tick`) travaille en **temps réel** par sessions de ~5 minutes qui s'enchaînent :

1. **Flux en continu (WebSocket)** — prix Binance transaction par transaction, et carnet d'ordres Polymarket complet tenu à jour en mémoire (plusieurs centaines de mises à jour par seconde). Une décision toutes les 200 ms. Si les flux sont indisponibles, repli automatique sur une interrogation toutes les 10 s.
2. **Juste valeur** — le marché paie « Hausse » si la moyenne des 60 dernières secondes dépasse la moyenne des 60 secondes précédant l'ouverture (vérifié à 98 % sur l'historique). Le modèle en déduit une probabilité, calibrée sur 43 776 mesures.
3. **24 stratégies en compétition** (5 familles). Chacune « parie » fictivement 10 $, au plus une fois par marché. Aucune décision si les flux ont du retard, si l'écart achat/vente est large, ou dans la dernière minute.
4. **Exécution réaliste** — un ordre fictif n'est compté que si le prix est encore dans le carnet une demi-seconde plus tard, le temps qu'un vrai ordre arrive. Sans cela, des stratégies perdantes paraissent rentables.
5. **Règlement** sur le résultat officiel publié par Polymarket.

### Auto-amélioration

- **Modèle en ligne** : une régression logistique part d'une copie du prix du marché et apprend, après chaque marché réglé, à le corriger.
- **Champion** : une stratégie ne pilote le compte que si son gain moyen par part est positif avec t ≥ 2 sur au moins 40 trades, et si elle ne perd pas sur ses ~100 derniers trades. Sinon le système **ne trade pas**.
- **Mise** : un quart de Kelly, calculé sur l'avantage réellement obtenu par le champion (moyenne − 1 erreur-type), jamais sur l'avantage qu'il annonce. BTC et ETH évoluant dans le même sens 83 % du temps, deux paris dans la même fenêtre partagent le même budget de risque.
- **Évolution** : tous les 96 marchés réglés, les stratégies clairement perdantes (t < −1 sur ≥ 60 trades) ou inactives sont remplacées par des variantes des meilleures. Volontairement lent : chaque remplacement efface des preuves.

### Démo et Production

| | Démo | Production |
|---|---|---|
| Argent | fictif (1 000 $ par défaut) | réel (USDC sur Polymarket) |
| Prix | carnet d'ordres réel, relu après le temps de trajet, frais réels | ordres réels « fill-or-kill », envoyés immédiatement |
| Mise | Kelly fractionné (¼) sur l'avantage prouvé, max 3 % du capital | fixe (`LIVE_STAKE_USD`, 5 $ par défaut), un seul pari par fenêtre |
| Déclenchement | dès qu'un champion est prouvé | copie le champion **seulement si toutes les conditions sont remplies** |

Conditions de la Production : `LIVE_TRADING=true`, portefeuille configuré, région non bloquée par Polymarket, armement manuel depuis le tableau de bord, arrêt d'urgence inactif, champion avec ≥ 150 trades et t ≥ 3, compte démo rentable sur ses 50 derniers trades, perte du jour sous la limite. L'arrêt d'urgence est pris en compte en 10 secondes au plus.

**Le chemin d'ordres réels n'a jamais été exécuté avec de vrais fonds** : commencez avec la mise minimale. Les gains des marchés gagnés doivent être encaissés (« Claim ») dans l'interface Polymarket.

## Déploiement Vercel

Sur Vercel, le moteur temps réel tourne **sur les serveurs de Vercel** (qui gardent les connexions WebSocket vers Binance et Polymarket) et diffuse ce qu'il voit, seconde par seconde, au tableau de bord.

1. Importer le dépôt dans Vercel (Next.js détecté automatiquement).
2. Connecter un stockage au projet : **Vercel Blob** (privé) ou **Upstash Redis**. Sans stockage, l'historique n'est pas conservé.
3. Définir `CRON_SECRET` et `ADMIN_TOKEN` (voir `.env.example` pour toutes les variables).
4. **Faire tourner le moteur** — deux façons :
   - **Depuis le tableau de bord (tous forfaits)** : saisir le jeton administrateur puis cliquer sur « Démarrer le moteur ». Chaque session dure ~5 minutes et la page se reconnecte aussitôt : le moteur tourne tant que la page reste ouverte sur un appareil allumé, et s'arrête quand on la ferme.
   - **En continu sans page ouverte (Vercel Pro)** : remplacer le `schedule` de `vercel.json` par `* * * * *`. Les appels en trop sont ignorés et une session interrompue est relancée dans la minute.
5. **Budget (forfait Hobby)** — deux quotas limitent la durée de fonctionnement :
   - **Stockage Vercel Blob : 2 000 écritures par mois.** Le moteur n'écrit qu'une fois par session de 5 minutes, soit environ 5 heures de fonctionnement par jour en moyenne. Pour tourner davantage, connectez **Upstash Redis** au projet (Vercel → Storage) : il est utilisé automatiquement à la place de Blob.
   - **Calcul** : une fonction active consomme le quota du compte, partagé avec vos autres projets. Surveillez la page Usage de Vercel.

Pour la Production, ajouter `LIVE_TRADING=true`, `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER_ADDRESS` et `POLYMARKET_SIGNATURE_TYPE`, puis armer depuis l'onglet Production.

## Développement

```bash
npm install
npm run local        # moteur temps réel + tableau de bord
npm run dev          # tableau de bord seul
npm test
```

En local, l'état est stocké dans `.data/state.json`.
