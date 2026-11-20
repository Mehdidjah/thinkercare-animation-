# ThinkerCare Terrain — développement

Application terrain interne (marques TOUCHÉ, BELNCO et NOOM). La présentation générale est dans [`00_LIRE_EN_PREMIER.md`](../00_LIRE_EN_PREMIER.md), la production dans [`docs/DEPLOY.md`](../docs/DEPLOY.md) et le fonctionnel dans [`docs/TERRAIN_GUIDE.md`](docs/TERRAIN_GUIDE.md).

## Pile

| Partie | Technologies | Hébergement |
| --- | --- | --- |
| `app/` (ce dossier) | React 19, Vite 7, TypeScript, CSS écrit à la main. SPA statique, sans SSR. | Vercel, avec proxy `/api/*` vers Railway (`vercel.json`) |
| `api/` | NestJS 11 (Express 5), Drizzle ORM + `pg`, PostgreSQL, Zod | Railway (`Dockerfile`, `railway.json`), qui sert aussi la SPA construite |

Bun sert à installer les dépendances, lancer les scripts et exécuter les tests. Le front appelle toujours `/api/...` en relatif, sur la même origine. `VITE_API_URL` n’est plus prise en charge.

## Arborescence

```text
app/src/
├─ main.tsx                  monte <Terrain/> dans #root
├─ styles.css
└─ terrain/
   ├─ domain/                règles pures, sans I/O (copie identique de api/src/domain)
   │   core.ts               rôles, droits, dates d’Alger, centimes, contrôles de rapport, alertes de présence
   │   operations.ts         réclamations, retours terrain, primes
   │   response-checks.ts    vérification de la forme des réponses GET
   └─ ui/
       App.tsx               coque et écrans par rôle
       QuickTools.tsx        catalogue, vente rapide, relevé de stock, pointage photo, alertes
       ServiceDesk.tsx       réclamations et demandes
       FieldNotebook.tsx     retours terrain
       Performance.tsx       primes et statistiques
       Passwords.tsx         mots de passe (compte personnel et administration)
       OperationsUI.tsx      utilitaires d’écran (actualisation, dates, export CSV)
       client.ts             appels à /api/terrain via request-cache.ts
       field-photo-client.ts, photo-file.ts   sélection, compression et envoi des photos

api/src/
├─ main.ts                   amorçage Express : cookies, corps brut, fichiers statiques, fallback SPA
├─ auth/                     session, connexion, origine (CSRF), mots de passe
├─ common/                   erreurs, filtre d’exceptions, en-têtes de sécurité, crypto, coffre des mots de passe
├─ db/                       schema.ts, client.ts (pool), tx.ts (SERIALIZABLE + reprise),
│                            migrate.ts, triggers.sql, seed.ts, catalogue.json
├─ domain/                   copie identique de app/src/terrain/domain
├─ storage/                  photos : volume (STORAGE_DIR) ou S3
└─ terrain/                  /api/terrain (dispatch par « action »), /api/photos, /api/field-photos
```

**Règle des couches** : `ui` et `api` dépendent de `domain`, et `domain` ne dépend de rien. Les deux copies de `domain` doivent rester identiques octet pour octet :

```sh
for f in core operations response-checks; do diff -q api/src/domain/$f.ts app/src/terrain/domain/$f.ts; done
```

## Points clés de l’API

- **`/api/terrain`**
  - `GET ?action=…` lit les données ; sans action, il renvoie le bootstrap.
  - `POST {action: …}` écrit les données. Il exige `Content-Type: application/json` et un en-tête `Origin` autorisé (l’origine du service ou une origine listée dans `APP_ORIGIN`).
- **Photos** : `/api/photos` et `/api/field-photos` reçoivent du multipart. Le navigateur compresse les photos en JPEG ; le serveur vérifie le type réel et accepte 20 Mo au maximum.
- **Erreurs** : toujours du JSON `{"error": "message en français"}` avec le statut HTTP.
  - Un `401` signifie « plus de session valide » : l’application revient à l’écran de connexion.
  - Un `409` signale un conflit de modification : actualiser puis réessayer.
- **Sessions** : cookie `__Host-terrain-session` (HttpOnly, Secure, SameSite=Strict). Le jeton est stocké haché dans `tf_sessions`. La session est prolongée tant qu’elle sert.
- **Mots de passe** : hachage salé. Les anciens hachages PBKDF2-SHA256 sont convertis au nouveau format à la connexion suivante. La direction peut aussi afficher une copie chiffrée des mots de passe non-admin (clé `ACCOUNT_PASSWORD_KEY`, voir [`api/test/README.md`](../api/test/README.md)). Il n’y a volontairement pas de longueur minimale.
- **Écritures** : en transaction `SERIALIZABLE`, avec reprise automatique en cas de conflit de sérialisation. Les règles d’intégrité (rapport verrouillé, survente, 5 photos par retour terrain) sont des triggers de `api/src/db/triggers.sql`.

## Lancer en local

Prérequis : [Bun](https://bun.sh) 1.3 ou plus récent, et PostgreSQL (`initdb`, `pg_ctl` ; par exemple `brew install postgresql@17`). L’option `--bun` force le runtime Bun pour les outils dont le script commence par `#!/usr/bin/env node`.

1. Démarrer une base jetable, hors du dépôt :

   ```sh
   initdb -D ~/.terrain-dev/pg --auth=trust -U terrain --no-locale --encoding=UTF8
   pg_ctl -D ~/.terrain-dev/pg -l ~/.terrain-dev/pg.log -o "-h 127.0.0.1 -p 54329 -c unix_socket_directories=" -w start
   ```

2. Construire la SPA, que l’API sert depuis `app/dist` :

   ```sh
   cd app && bun install && bun run --bun vite build && cd ..
   ```

3. Lancer l’API depuis les sources :

   ```sh
   cd api && bun install
   export DATABASE_URL=postgres://terrain@127.0.0.1:54329/postgres DATABASE_SSL=false \
     ADMIN_INITIAL_PASSWORD='mot-de-passe-local' \
     ACCOUNT_PASSWORD_KEY=$(openssl rand -hex 32) STORAGE_DIR=$HOME/.terrain-dev/photos
   bun src/db/migrate.ts && bun src/db/seed.ts && bun src/main.ts
   ```

4. Ouvrir <http://localhost:3000> et se connecter avec `direction` et la valeur d’`ADMIN_INITIAL_PASSWORD`.

   Le cookie `__Host-` est `Secure`. En HTTP, Chrome et Firefox ne l’acceptent que sur `localhost`, et Safari peut le refuser.

   Garder la même `ACCOUNT_PASSWORD_KEY` d’une session à l’autre : sinon, les copies chiffrées déjà créées deviennent illisibles.

   Les variables `SEED_*_PASSWORD` créent des comptes de test, et `SEED_DEMO_DATA=1` deux points de vente de démonstration (voir `docs/DEPLOY.md`).

Pour voir les changements du front, lancer `bun run --bun vite build --watch` dans `app/`, puis recharger la page : aucun proxy `/api` n’est configuré pour le serveur de développement Vite.

Arrêter la base : `pg_ctl -D ~/.terrain-dev/pg stop`.

**Changer le schéma** : modifier `api/src/db/schema.ts`, puis lancer `bun run db:generate` dans `api/`, ce qui produit une nouvelle migration dans `api/drizzle/`. Elle est appliquée par `migrate` au prochain démarrage.

## Vérifications et tests

```sh
cd app && bun run --bun tsc --noEmit && bun test ./tests    # client HTTP, cache de requêtes, photos, règles métier
cd api && bun run --bun tsc --noEmit -p tsconfig.json && bun test   # Postgres jetable, voir api/test/README.md
cd app && bun run --bun vite build                          # build de production
```

La CI GitHub (`.github/workflows/ci.yml`) lance les mêmes commandes, plus `docker build`, sur chaque pull request et chaque push sur `main`.

`bun run lint` (ESLint + Prettier) signale encore de nombreux écarts de formatage dans le code existant : ce n’est pas un critère bloquant. Ne pas reformater les fichiers en masse.

## Déploiement

Pousser sur `main` déploie automatiquement Vercel (dossier `app/`) et Railway (racine du dépôt). Les variables, le volume, les sauvegardes et les contrôles sont décrits dans [`docs/DEPLOY.md`](../docs/DEPLOY.md).
