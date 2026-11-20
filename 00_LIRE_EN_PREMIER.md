# ThinkerCare Terrain — à lire en premier

Application interne de suivi terrain des marques TOUCHÉ, BELNCO et NOOM, en français, à l’heure d’Alger et en dinars algériens. Elle sert quatre rôles :

- **Gestionnaires** : programment les animations en pharmacie et valident les rapports.
- **Animatrices** : pointent l’arrivée, le milieu et le départ avec une photo, relèvent les stocks et saisissent les ventes, les réclamations et les retours terrain.
- **Médecins** : traitent les réclamations.
- **Direction** : gère les comptes et la traçabilité.

## Architecture

```text
Navigateur ─▶ Vercel (SPA React/Vite, app/) ── /api/* ──▶ Railway : API NestJS (api/) ─▶ Postgres
                                                                        └─▶ volume /data (photos)
```

- **Front end** : SPA statique React 19 + Vite 7, hébergée sur Vercel. `app/vercel.json` renvoie `/api/*` vers Railway : pour le navigateur, tout est servi par une seule origine.
- **API** : NestJS 11 (Express 5) + Drizzle + Postgres, sur Railway (`Dockerfile`, `railway.json`). Elle sert aussi le build de la SPA.
- **Photos** : stockées sur le volume Railway monté sur `/data` (`STORAGE_DIR`), jamais exposées publiquement.
- **Session** : cookie `__Host-terrain-session` (HttpOnly, Secure, SameSite=Strict) sur la même origine. `VITE_API_URL` n’est plus prise en charge.

## Où trouver quoi

| Chemin | Contenu |
| --- | --- |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Exploitation : topologie, variables d’environnement, démarrage, volume, sauvegardes, région, contrôles après déploiement. |
| [`app/README.md`](app/README.md) | Développement : pile, arborescence, lancement en local avec Bun, tests. |
| [`app/docs/TERRAIN_GUIDE.md`](app/docs/TERRAIN_GUIDE.md) | Guide fonctionnel : rôles, planning, pointage, stocks, ventes, rapports, réclamations, primes. |
| [`api/test/README.md`](api/test/README.md) | Tests de l’API et gestion des mots de passe (clé `ACCOUNT_PASSWORD_KEY`). |
| `api/` | API NestJS, schéma et migrations Drizzle (`api/drizzle/`), triggers, seed, catalogue de référence. |
| `app/` | SPA React, configuration Vercel. |
| `docs/superpowers/` | Dossier de conception de la migration vers NestJS/Postgres (14 novembre 2026), conservé pour l’historique. |

## Historique

Le code a été repris le 14 novembre 2026 depuis un export Higgsfield : TanStack Start sur Cloudflare Workers, avec D1 (SQLite) et R2. Il a ensuite été migré vers l’architecture actuelle. Les anciennes migrations SQLite (`app/migrations/`) et les scripts de test de cette époque ont été retirés de l’arborescence. Ils restent consultables dans l’historique Git, par exemple avec `git show 710d9ea:app/migrations/0002_terrain.sql`.

Le dossier de reprise (export des données, médias, audit, historique, avec `verifier_dossier.py`) n’est pas dans ce dépôt : `.gitignore` l’exclut. Il contient des données internes, des empreintes de mots de passe et des métadonnées de sessions. Ne le transmettre que par un canal privé, et ne jamais committer de secret ni de fichier `.env`.
