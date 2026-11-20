# Polymarket — tenue de marché v2

Version autonome, pensée pour tourner **en permanence sur un serveur** : rapidité et fiabilité. Elle est indépendante de la version Vercel (dossier racine du dépôt), qu'elle ne modifie pas.

## Ce qui change par rapport à la version Vercel

| | Version Vercel | v2 |
|---|---|---|
| Exécution | sessions de 5 min relancées par une page ouverte | un processus permanent, relancé automatiquement s'il s'arrête |
| Données de marché | WebSocket | WebSocket, avec délais mesurés en continu |
| Exécutions réelles | interrogation toutes les 1,5 s | **canal privé temps réel** de Polymarket, interrogation gardée en secours |
| Sécurité des ordres réels | expiration à 2 min (**refusée par Polymarket : minimum 3 min**) | expiration conforme + **heartbeat** : si le moteur se tait 10 s, Polymarket annule lui-même tous les ordres |
| Stockage | Vercel Blob, une écriture par session | **SQLite** (fichier local), écriture immédiate à chaque événement d'argent réel + journal d'audit non modifiable |
| Démarrage | — | relit et annule les ordres réels restés ouverts, et ceux inconnus sur le marché en cours |
| Arrêt | — | annule tous les ordres réels et sauvegarde avant de s'arrêter |
| Surveillance | — | page de santé `/health`, mesures de latence, alertes Telegram |

La logique de trading est la même : 8 bureaux simulés qui s'améliorent, et un bureau de production (argent réel) verrouillé par défaut.

**Mode « un seul bureau »** (réglages généraux) : une seule stratégie, la vôtre — plage de prix d'achat, stocks max Hausse/Baisse, gain minimum à la revente, take profit (TP) et stop loss (SL) au marché, période de cotation — appliquée au bureau « principal ». Les autres bureaux et l'évolution automatique sont retirés. TP et SL sont simulés ; la production n'envoie pas de ventes au marché.

**Tous les réglages se changent depuis le tableau de bord**, sans redémarrer :
- par bureau (bouton « Modifier », ou « ＋ Nouveau bureau ») : prix d'achat min/max, stock Hausse max et stock Baisse max, gain minimum pour revendre, stop, période de cotation dans le marché, écartement selon l'agitation. Un bureau réglé à la main est marqué « Manuel » et n'est jamais remplacé par l'évolution ; ses résultats repartent de zéro sauf si vous cochez « Garder ses résultats » ;
- réglages généraux : période des bougies, taille de base des ordres, multiplicateur de bougie, recharge immédiate, évolution automatique et sa fréquence, part des frais reversée.

Ces réglages sont enregistrés dans la base et passent avant ceux du fichier `.env`. Les limites de la production (argent réel) restent, elles, dans `.env`.

Chaque bureau peut être **activé ou désactivé** depuis le tableau de bord (colonne « Actif »). Un bureau désactivé retire ses ordres tout de suite, garde son stock jusqu’à l’expiration du marché, n’est jamais remplacé par l’évolution et n’est jamais copié par la production.

## Lancer

Node.js 22.13 ou plus récent.

```bash
cd v2
npm install
cp .env.example .env    # puis remplir ADMIN_TOKEN au minimum
npm start               # tableau de bord sur http://localhost:8080
```

## Choisir l'emplacement du serveur

Sur le serveur candidat :

```bash
npm run probe
```

Il mesure la proximité avec Polymarket et Binance, et indique si Polymarket autorise le trading depuis cette adresse. Choisissez la région la plus rapide **parmi celles où Polymarket autorise le trading et où vous avez le droit de trader**. Le serveur ne doit pas servir à contourner un blocage géographique.

## Déployer

**Docker** (recommandé) :

```bash
cd v2/deploy
docker compose up -d --build
```

Relancé automatiquement, base conservée dans `deploy/data`, port ouvert seulement sur le serveur lui-même : accédez au tableau de bord par un tunnel SSH (`ssh -L 8080:localhost:8080 serveur`) ou derrière un proxy HTTPS.

**systemd** : voir `deploy/polymarket-mm.service`.

## Production (argent réel)

Mêmes conditions et limites que la version Vercel (`MM_LIVE=true`, clé, région autorisée, armement, bureau prouvé en simulation, perte max par marché et par jour). En plus :

- **Utilisez un portefeuille et une clé API dédiés** : le heartbeat annule *tous* les ordres de la clé si le moteur se tait, y compris ceux passés à la main.
- Les parts gagnantes restent à réclamer (« Claim ») sur Polymarket.
- Jamais exécutée avec de vrais fonds : testée contre un faux carnet d'ordres uniquement.

## Tests

```bash
npm test
```
