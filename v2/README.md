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
