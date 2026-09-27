# Nuvio France Catalogs — Dynamic v3

Addon Nuvio/Stremio avec 12 catalogues dynamiques. Les catalogues sont alimentés par TMDB/Trakt/IMDb selon la catégorie, avec pagination Nuvio (`skip=20`, `skip=40`, etc.) et un cache de 3 heures minimum.

## Catalogues

1. 🇫🇷 Top 20 films du jour — France
2. 🇫🇷 Top 20 séries du jour — France
3. 🇫🇷 Sorties films France — streaming/Blu-ray
4. 🇫🇷 Sorties séries France
5. ⭐ IMDb Top 100 films
6. ⭐ IMDb Top 100 séries
7. 🤖 Recommandations IA — films
8. 🤖 Recommandations IA — séries
9. 👤 Selon ce que j'ai regardé — films
10. 👤 Selon ce que j'ai regardé — séries
11. 🏆 IMDb Top 250 films
12. 🏆 IMDb Top 250 séries

## Posters+

Chaque Meta Preview utilise automatiquement la configuration Posters+ fournie par l'utilisateur, avec `primary_client=stremio_tv_nuvio`, logos FR, pondérations films/séries, badges, sash/notch, fallback IMDb et fond photoréaliste.

## Rafraîchissement et défilement

- Cache serveur : 180 minutes par défaut (`CACHE_MINUTES=180`).
- Les catalogues sont recalculés après expiration du cache.
- Nuvio/Stremio peut demander les pages suivantes avec `skip=20`, `skip=40`, etc.
- Les sorties France parcourent plusieurs pages TMDB au lieu d'être limitées à une dizaine de titres.
- Les Top 20 restent volontairement limités à 20 par définition du catalogue.
- IMDb Top 100/250 restent respectivement 100/250 titres, mais sont paginés par 20 dans Nuvio.

## France / TMDB

Pour les films, `region=FR` et `with_release_type=4|5` utilisent les dates régionales TMDB pour Digital et Physical. Le filtre Inde est configurable avec `EXCLUDE_INDIA=true`.

Pour les séries, le catalogue utilise les dates d'air et la disponibilité de visionnage France quand TMDB les fournit.

## Variables

Copier `.env.example` vers `.env` pour un déploiement local. Sur Render/Railway, utiliser directement les variables d'environnement.

Obligatoire :
- `TMDB_API_KEY`

Pour historique/recommandations Trakt :
- `TRAKT_CLIENT_ID`
- `TRAKT_ACCESS_TOKEN`
- `TRAKT_USERNAME`

Pour recommandations IA :
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

## Lancer

```bash
npm install
npm start
```

Puis :

`https://votre-domaine/manifest.json`

À ajouter dans Nuvio.

## Important sur IMDb Top 250

Cette version exploite les jeux de données publics IMDb et les résout via TMDB. Le classement produit est une approximation basée sur note/votes et **ne prétend pas reproduire l'algorithme propriétaire exact du Top 250 IMDb**.

## Attribution

Si vous utilisez l'API TMDB, respectez les conditions et exigences d'attribution TMDB. Les données de disponibilité provenant de TMDB/JustWatch doivent également respecter leurs exigences d'attribution.
