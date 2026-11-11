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

## La stratégie : le retard d'ETH sur BTC

Le système ne trade **que l'ETH**, et seulement quand deux conditions sont réunies au même instant :

1. **Le BTC vient de pousser** : sa probabilité de finir en hausse a bougé d'au moins quelques points en 10 à 20 secondes.
2. **L'ETH est en retard** : son prix sur Polymarket est inférieur à sa propre juste valeur, dans le sens de la poussée, d'au moins quelques cents après frais.

Les 24 stratégies en compétition sont 24 réglages de cette idée : ampleur du retard exigé × force de la poussée × règle de sortie.

### Seconde idée : le départ en avance

Le prix à battre d'un marché est la moyenne des 60 secondes **avant** son ouverture. Si le prix a bougé pendant cette minute, ETH démarre déjà au-dessus ou en dessous du prix à battre, alors que le carnet est encore proche de 50 ¢. Six réglages achètent ce « départ en avance » sur ETH dans les 12 premières secondes, puis revendent vite.

Sur 4 jours d'historique (prix du dernier échange vu, revente rapide) : +2,9 ¢ par part pour une avance de plus de 3 ¢, +4,6 ¢ au-delà de 6 ¢, +8,3 ¢ au-delà de 10 ¢ ; encore +0,5 à +3,7 ¢ avec 2,5 secondes de retard. Sur BTC l'effet disparaît dès 2,5 secondes : il n'y est pas tradé.

### Tenue de marché (simulation)

En parallèle, un bureau de tenue de marché fictif cote en permanence les deux côtés du carnet « Hausse » de BTC et d'ETH, aux meilleurs prix, et renouvelle ses ordres toutes les 5 secondes. Après une bougie verte de 5 secondes (prix spot), il achète 20 parts et en vend 10 ; après une bougie rouge, l'inverse (`MM_SIZE`, `MM_CANDLE_SECONDS`).

Un ordre n'est compté exécuté que si une transaction réelle le traverse, ou l'atteint après les ordres qui étaient devant lui dans la file. Le teneur de marché ne paie aucun frais ; 20 % des frais payés par la contrepartie sont crédités sur un compte de récompenses en pUSD (`MM_REBATE`). Le stock restant est valorisé au résultat du marché.

Sur 4 jours d'historique BTC, cette règle donne entre −7 $ et +0,75 $ par marché selon l'hypothèse de file d'attente, récompenses comprises ; elle bat la version symétrique et la version inversée dans tous les cas. Le risque principal est le stock accumulé, qui n'est pas plafonné. Simulation uniquement : aucun ordre réel n'est envoyé par ce bureau.

### Quand la position est-elle fermée ?

Chaque réglage a sa règle de sortie, vérifiée cinq fois par seconde :

- **Objectif de gain** (par défaut +10 %) : vendre dès que la position peut être revendue avec ce gain, *frais de sortie déduits*.
- **Stop** (par défaut 10 %) : vendre si le prix a reculé de 10 % de la mise depuis l'entrée. Il est mesuré sur le mouvement du prix, pas sur la valeur de revente : à cause de l'écart achat/vente et des frais à l'entrée et à la sortie, une position vaut déjà ~10 % de moins à la seconde où elle est achetée, et un stop sur la valeur de revente se déclencherait immédiatement.
- **Durée maximale** (30 ou 60 s) : si le rattrapage attendu n'a pas eu lieu, vendre.
- Un quart des réglages **garde jusqu'au règlement** du marché, pour comparer.

Sur 4 jours d'historique (exécution prudente) : garder jusqu'à la fin rapporte environ +1 ¢ par part avec ±45 ¢ d'écart par trade, autant dire du hasard ; sortir à +10 % / stop 10 % rapporte +2,5 à +4,4 ¢ avec ±13 ¢ d'écart, pour une détention d'environ 15 secondes. L'avantage est donc le rattrapage d'ETH dans les secondes qui suivent, pas l'issue du marché. Attention : quand le prix décroche brutalement, un stop se fait exécuter bien plus bas que prévu.

### Ce que montrent les données

Tests sur 1 152 marchés ETH réels (4 jours, toutes les transactions, prix spot à la seconde) :

| Règle testée | Gain par part, exécution optimiste | Exécution prudente |
|---|---|---|
| ETH en retard **et** BTC vient de pousser dans ce sens | +8 à +17 ¢ (t ≈ 6) | +1 à +13 ¢ (peu de trades, t < 2) |
| ETH en retard, sans regarder le BTC | +3 à +10 ¢ | +1 à +8 ¢ |
| Parier qu'ETH rattrape BTC, sans regarder le prix d'ETH | −2 à +1 ¢ | −6 à +1 ¢ |
| Couverture « delta » : acheter ETH et le sens inverse sur BTC | −2 à −1 ¢ | −5 à +3 ¢ |

- **La condition BTC améliore le signal à tous les seuils**, sur les deux moitiés de la période, et il tient encore avec 1,5 s de retard.
- **La couverture delta ne marche pas** : la jambe BTC paie des frais et l'écart achat/vente sans rien rapporter.
- **Sur les prix spot, le BTC n'entraîne pas l'ETH à l'échelle de la seconde** (corrélation décalée ≈ 0,11 dans les deux sens). Le retard exploitable est celui du *marché Polymarket d'ETH*, bien moins liquide que celui du BTC.
- **Les volumes sont petits** : sur les carnets réels, une quarantaine de parts sont offertes au prix visé, pendant 1 à 6 secondes. C'est une stratégie de petites mises répétées.

« Optimiste » suppose qu'on obtient le dernier prix vu ; « prudente » exige que ce prix se soit encore traité juste après. La vérité est entre les deux, et 4 jours ne font pas une preuve : c'est le mode Démo, qui s'exécute contre le vrai carnet une demi-seconde après la décision, qui tranchera.

## Fonctionnement

Le moteur (`/api/cron/tick`) travaille en **temps réel** par sessions de ~5 minutes qui s'enchaînent :

1. **Flux en continu (WebSocket)** — prix Binance transaction par transaction, et carnet d'ordres Polymarket complet tenu à jour en mémoire (plusieurs centaines de mises à jour par seconde). Une décision toutes les 200 ms. Si les flux sont indisponibles, repli automatique sur une interrogation toutes les 10 s.
2. **Juste valeur** — le marché paie « Hausse » si la moyenne des 60 dernières secondes dépasse la moyenne des 60 secondes précédant l'ouverture (vérifié à 98 % sur l'historique). Le modèle en déduit une probabilité, calibrée sur 43 776 mesures.
3. **24 réglages du « retard d'ETH »**. Chacun « parie » fictivement 10 $, au plus une fois par marché. Aucune décision si les flux ont du retard, si l'écart achat/vente est large, ou dans la dernière minute. Le BTC est observé en permanence mais jamais tradé.
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
