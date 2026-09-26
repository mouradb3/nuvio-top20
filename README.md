# Nuvio France Catalogs v2

Addon Nuvio/Stremio personnalisé avec 12 catalogues et affiches **Posters+** selon la configuration fournie.

## Catalogues
- 🇫🇷 Top 20 films du jour — France
- 🇫🇷 Top 20 séries du jour — France
- 🇫🇷 Sorties films France — streaming/Blu-ray
- 🇫🇷 Sorties séries France
- ⭐ IMDb Top 100 films
- ⭐ IMDb Top 100 séries
- 🤖 Recommandations IA — films
- 🤖 Recommandations IA — séries
- 👤 Selon ce que j'ai regardé — films
- 👤 Selon ce que j'ai regardé — séries
- 🏆 IMDb Top 250 films
- 🏆 IMDb Top 250 séries

## Posters+
Chaque meta de catalogue utilise directement l'URL Posters+ fournie : logos FR, pondérations films/séries, fallback IMDb, fond photoréaliste, sash/notch, badge en haut à gauche, etc.

## Configuration
Copier `.env.example` vers `.env` puis renseigner au minimum `TMDB_API_KEY`.
Pour historique/recommandations : `TRAKT_CLIENT_ID`, `TRAKT_ACCESS_TOKEN`, `TRAKT_USERNAME`.
Pour recommandations IA : `OPENAI_API_KEY` et éventuellement `OPENAI_BASE_URL` / `OPENAI_MODEL`.

## Lancement local
```bash
npm install
npm start
```
Le manifest sera disponible sur `/manifest.json`.

## Déploiement
Nuvio doit pouvoir atteindre publiquement l'URL du manifest en HTTPS. Le projet peut être déployé sur un hébergeur Node compatible.

## Important
- TMDB `region=FR` et `with_release_type=4|5` servent à travailler avec les dates Digital/Physical françaises. Le serveur revérifie les dates FR via `/movie/{id}/release_dates`.
- Le catalogue ne fournit pas de streams : il fournit uniquement les métadonnées/catalogues à Nuvio.
- L'historique et les recommandations personnalisées nécessitent une source utilisateur telle que Trakt ; Nuvio ne transmet pas automatiquement ton historique personnel à cet addon.
- Les Top IMDb sont construits à partir des données publiques IMDb ; ils ne doivent pas être considérés comme une reproduction garantie à l'identique du classement éditorial IMDb Top 250.
