# Déploiement et exploitation — ThinkerCare Terrain

Runbook de production : topologie, variables, démarrage, volume photos, sauvegardes, région et contrôles après déploiement. Le développement local est décrit dans [`app/README.md`](../app/README.md).

## 1. Topologie

```text
Navigateur ──HTTPS──▶ Vercel (edge Paris)
                        ├─ /, /assets/*         SPA statique (app/dist)
                        └─ /api/*  ── proxy ──▶ Railway, service « app » (NestJS, Dockerfile)
                                                  ├─ Postgres (service Railway, réseau privé)
                                                  └─ volume /data (photos, STORAGE_DIR)
```

| Élément | Où | Détail |
| --- | --- | --- |
| Front end | Vercel, projet avec le dossier racine `app/` | `app/vercel.json` : build `vite build`, sortie `dist`, réécriture de `/api/*` vers Railway, toute autre route vers `/index.html`. Adresse donnée aux utilisateurs : `https://thinkercare-animation.vercel.app`. |
| API | Railway, service « app » | Ce dépôt, `Dockerfile` + `railway.json` à la racine. URL publique : `https://thinkercare-animation-production.up.railway.app`. |
| Base | Railway, service Postgres | Joint par le réseau privé (`*.railway.internal`). |
| Photos | Volume Railway du service « app » | 50 Go montés sur `/data` (`STORAGE_DIR=/data`). |

Les deux déploiements partent automatiquement de la branche `main`.

Le navigateur ne parle qu’au domaine Vercel : l’API est donc servie à la même origine que la page. C’est ce qui permet le cookie de session `__Host-terrain-session` (HttpOnly, Secure, SameSite=Strict), y compris sur iPhone. `VITE_API_URL` n’est plus prise en charge : l’application appelle toujours `/api/...` en relatif. Ne pas la définir sur Vercel.

L’URL Railway sert aussi une copie complète de l’application (le build Vite est embarqué dans l’image). Elle fonctionne, mais elle est plus lente depuis l’Europe : ne pas la diffuser. Avec `PUBLIC_APP_URL=https://thinkercare-animation.vercel.app`, une page ouverte sur l’URL Railway est redirigée (308) vers Vercel ; `/api`, `/healthz` et les fichiers statiques restent servis tels quels.

**Deux réglages à garder alignés.** Tout changement de domaine (domaine personnalisé sur Vercel, renommage du service Railway) doit mettre à jour les deux :

1. `app/vercel.json` : la `destination` du proxy `/api/:path*` doit être l’URL publique Railway actuelle. Sinon, l’interface s’affiche mais chaque appel `/api` échoue (404/502).
2. Railway, variable `APP_ORIGIN` : elle liste toutes les adresses Vercel utilisées (production et alias). Sinon, chaque POST venant de Vercel, connexion comprise, répond `403 Origine non autorisée.`

## 2. Variables d’environnement

Service « app » sur Railway (`Variables`). Le modèle commenté est `api/.env.example`. Aucune variable n’est nécessaire côté Vercel.

| Variable | Requise | Rôle |
| --- | --- | --- |
| `DATABASE_URL` | oui | Référence `${{Postgres.DATABASE_URL}}` (réseau privé, sans TLS). Une URL publique passe en TLS sans vérification de chaîne ; `DATABASE_SSL=true/false` force le choix. |
| `ADMIN_INITIAL_PASSWORD` | oui | Lue à chaque démarrage par le seed, uniquement pour créer le compte `direction` s’il n’existe pas. La modifier ensuite ne change pas le mot de passe existant. Si elle manque, le seed échoue : sur une base neuve, le compte `direction` n’est pas créé et le catalogue peut ne pas être chargé. |
| `ACCOUNT_PASSWORD_KEY` | oui | 32 octets aléatoires en 64 caractères hexadécimaux (`openssl rand -hex 32`). Elle chiffre la copie des mots de passe non-admin que la direction peut afficher. **La sauvegarder à part**, hors des sauvegardes de la base, par exemple dans le gestionnaire de mots de passe de la direction. **Ne jamais la changer sans rechiffrer les copies existantes** : aucun outil de rechiffrement n’existe aujourd’hui. Elle signe aussi le cookie `__Host-terrain-device` posé à la connexion : un navigateur déjà utilisé par un compte garde sa propre limite de tentatives, si bien que des essais lancés ailleurs ne bloquent pas l’utilisateur sur son téléphone habituel. Si elle manque ou est invalide, la création et la réinitialisation des comptes non-admin et leurs changements de mot de passe répondent 503 ; la connexion fonctionne toujours, sans cette exemption. Voir [`api/test/README.md`](../api/test/README.md). |
| `APP_ORIGIN` | oui avec Vercel | Origines autorisées pour les POST, séparées par des virgules, au format exact `https://hôte` sans `/` final. Exemple : `https://thinkercare-animation.vercel.app,https://<alias>.vercel.app`. L’origine du service lui-même est toujours acceptée. |
| `STORAGE_DIR` | oui (ou S3) | `/data`, le point de montage du volume. Les fichiers sont rangés sous `/data/terrain/<uuid>` (photos d’animation) et `/data/terrain-notes/<uuid>` (photos des retours terrain), avec `<uuid>.thumb` pour la miniature des grilles (photos envoyées depuis novembre 2026). |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION` | non | Stockage S3 compatible (R2, S3, MinIO), à la place du volume. Il n’est actif que si les trois premières variables sont présentes, et il passe alors avant `STORAGE_DIR`. Non utilisé en production. **Sans aucun stockage, les photos répondent 503 et aucun pointage n’est possible, car l’arrivée exige une photo.** |
| `SEED_MANAGER_PASSWORD`, `SEED_FIELD_PASSWORD`, `SEED_DOCTOR_PASSWORD` | non | Comptes de test `gestion`, `animatrice` et `medecin`. Chacun n’est créé que si sa variable est définie et qu’il n’existe pas encore. Un compte existant n’est jamais réinitialisé. En production, les laisser vides et créer les comptes réels depuis l’application. |
| `SEED_DEMO_DATA` | non | `1` crée les deux points de vente de démonstration « Pharmacie Centrale (démo) » et « Parapharmacie du Parc (démo) ». Les lignes existantes ne sont jamais modifiées ni supprimées. **Laisser vide sur Railway.** En production, elles existent déjà : les désactiver dans l’application si elles gênent. |
| `NODE_ENV` | — | `production`, fixé par le `Dockerfile`. |
| `PORT` | — | Injecté par Railway (3000 par défaut). |
| `PUBLIC_APP_URL` | non, recommandée | Origine publique de l’application, par exemple `https://thinkercare-animation.vercel.app` (https, sans `/` final). Les pages demandées à l’URL Railway y sont redirigées. Vide : pas de redirection. |
| `PG_STATEMENT_TIMEOUT_MS` | non | Durée maximale d’une requête SQL de l’application, en millisecondes (30000 par défaut, `0` désactive). La migration au démarrage s’exécute toujours sans limite. |
| `PG_POOL_MAX`, `STATIC_DIR`, `DATABASE_SSL`, `PGSSLMODE=disable` | non | Réglages avancés : taille du pool (10 par défaut), dossier du build Vite et TLS Postgres. |

Ne jamais committer de valeur réelle : `.env` et `.env.*` sont ignorés par Git, sauf les `.env.example`.

## 3. Build et démarrage

Railway construit le `Dockerfile` en trois étapes :

1. build de la SPA avec Bun ;
2. build de l’API avec Bun ;
3. image d’exécution `node:22-slim`.

Ensuite, Railway lance la `startCommand` de `railway.json`, identique au `CMD` du Dockerfile :

1. **`node dist/db/migrate.js`** attend la base jusqu’à une minute (Postgres qui redémarre en même temps), applique les migrations Drizzle de `api/drizzle/` (journal dans le schéma Postgres `drizzle`), puis rejoue `api/src/db/triggers.sql`. Ce fichier est idempotent et ne crée que les triggers manquants : un démarrage sans changement ne verrouille aucune table. En cas d’échec, le conteneur s’arrête et Railway le relance selon la politique de redémarrage de `railway.json`.
2. **`node dist/db/seed.js`** réalise, dans l’ordre :
   - création du compte `direction` s’il manque ;
   - création des comptes de test si les variables `SEED_*_PASSWORD` sont définies ;
   - ajout des produits du catalogue de référence (`api/src/db/catalogue.json`, 86 références) absents de la base ;
   - création des points de vente de démonstration si `SEED_DEMO_DATA=1`.

   Le seed ne modifie jamais les comptes existants. Sur les produits déjà en base, il ne rafraîchit que les colonnes issues de l’import (image, URL et identifiant source, vrac, date du catalogue). Les modifications faites par les gestionnaires (prix indicatif, activation, nom, SKU, unité) survivent donc aux déploiements. Pour corriger un produit, passer par l’application, pas par `catalogue.json`. Une erreur du seed est journalisée sans bloquer le démarrage.
3. **`node dist/main.js`** écoute sur `$PORT` et sert `/api/*`, `/healthz`, `/robots.txt` et la SPA.

**Changer le schéma** :

1. modifier `api/src/db/schema.ts` ;
2. lancer `bun run db:generate` dans `api/` pour produire le fichier SQL et les métadonnées dans `api/drizzle/` ;
3. committer ; la migration est appliquée au déploiement suivant.

Ne jamais modifier une migration déjà appliquée. Les règles d’intégrité (triggers) vivent dans `api/src/db/triggers.sql`, rejoué à chaque démarrage : il doit rester idempotent. Le corps d’une fonction se modifie directement (`CREATE OR REPLACE FUNCTION`) ; pour changer les événements d’un trigger existant, ajouter un `DROP TRIGGER` explicite avant son bloc de création.

## 4. Healthcheck et interruption au déploiement

`GET /healthz` est le contrôle de santé déclaré à Railway (`healthcheckPath` dans `railway.json`). Il doit répondre `200`, et non la page HTML de l’application.

Le service a un volume attaché. Railway ne fait donc jamais tourner deux déploiements en même temps : l’ancien s’arrête avant que le nouveau démarre. Chaque déploiement provoque ainsi une **courte coupure**, le temps du démarrage, des migrations et du healthcheck. Éviter de déployer aux heures de pointage, en début et en fin d’animation. Les sessions sont en base : un déploiement ne déconnecte personne.

**Interface et API ne changent pas au même instant.** Vercel publie la SPA en une minute environ, Railway reconstruit l’image en plusieurs minutes, et un onglet déjà ouvert garde l’ancienne interface jusqu’à son rechargement : rien ne le recharge seul. Pour un changement qui touche les deux, comme la photo du milieu :

1. déployer hors des heures de pointage ;
2. attendre la fin des deux déploiements (Railway : healthcheck au vert ; Vercel : « Ready ») ;
3. demander aux animatrices de recharger l’application (fermer puis rouvrir l’onglet).

Pendant l’écart, la nouvelle interface face à l’ancienne API garde le pointage arrivée → départ, sans photo du milieu. Une interface ouverte avant le déploiement n’a pas le bouton de la photo du milieu : le refus du départ lui demande de recharger l’application.

Motifs multiples des réclamations et demandes : une interface ouverte avant le déploiement envoie un seul motif, que la nouvelle API accepte. La nouvelle interface face à l’ancienne API ne peut en revanche enregistrer aucun dossier (« Vérifiez les champs ») : attendre la fin du déploiement Railway avant d’en créer.

## 5. Volume photos

- **Taille** : 50 Go montés sur `/data`, dont environ 792 Mo utilisés au 20 novembre 2026.
- **Croissance estimée** : 0,4 à 1,4 Go par mois. Le calcul part de photos d’arrivée et de départ compressées à environ 0,6 Mo par le navigateur (20 Mo maximum acceptés par le serveur), de 15 photos de suivi au maximum par animation et de 5 par retour terrain.
- **Surveillance** : suivre l’usage dans Railway (service « app », onglet du volume et Metrics). Configurer une alerte d’usage si l’offre le permet, sinon faire un contrôle mensuel. Agrandir le volume avant 80 %.
- **Rétention** : aucune suppression automatique. Une photo n’est effacée qu’en cas d’échec d’enregistrement (annulation de l’envoi).

## 6. Sauvegardes et restauration

Trois éléments forment une sauvegarde complète :

1. la base Postgres ;
2. le volume `/data` ;
3. `ACCOUNT_PASSWORD_KEY`, conservée séparément.

Les photos sont référencées en base par leur clé (`tf_photos`, `tf_field_photos`) : restaurer la base et le volume **à la même date**.

### Postgres

- Activer les sauvegardes planifiées Railway du service Postgres (onglet Backups).
- Exporter aussi régulièrement une copie hors Railway. L’URL publique est la variable `DATABASE_PUBLIC_URL` du service Postgres. `pg_dump` doit être de la même version majeure que le serveur, ou plus récent.

  ```sh
  pg_dump --format=custom --no-owner --no-acl --file="terrain-$(date +%F).dump" "$DATABASE_PUBLIC_URL"
  ```

- Tester la restauration dans une base locale vide :

  ```sh
  createdb -h 127.0.0.1 -p 5432 -U "$USER" restore_test
  pg_restore --no-owner --no-acl --exit-on-error -d "postgres://$USER@127.0.0.1:5432/restore_test" terrain-AAAA-MM-JJ.dump
  psql "postgres://$USER@127.0.0.1:5432/restore_test" -c "SELECT count(*) FROM tf_products"   # 86 ou plus
  ```

- **Restaurer en production** :
  1. arrêter le service « app » ;
  2. restaurer dans une base vide ;
  3. redéployer.

  Le journal Drizzle fait partie du dump : `migrate` n’applique que les migrations plus récentes.

### Volume `/data`

- Activer les sauvegardes planifiées Railway du service « app » (onglet Backups du volume).
- Railway n’offre pas d’export direct pour une copie hors plateforme. L’organiser, par exemple avec une archive `tar` de `/data` via `railway ssh`, et la tester une fois avant d’en dépendre.

### Avant une opération risquée

Avant un changement de région ou une migration lourde : déclencher une sauvegarde manuelle des deux services et télécharger un `pg_dump`.

## 7. Région (recommandation)

Le service tourne actuellement en **US West**, à confirmer dans Railway → service → Settings → Deploy → Region. Les utilisateurs arrivent par l’edge de Paris (Vercel `cdg1`, edge Railway `cdg1`/`bcn1`), puis la requête traverse l’Atlantique : environ 150 ms s’ajoutent à **chaque** appel d’API, soit environ 300 ms à l’ouverture de l’application et à la connexion.

Déplacer **ensemble** le service « app », le service Postgres et leurs volumes vers **EU West** (Amsterdam) supprimerait l’essentiel de ce délai. Ne jamais en déplacer un seul : chaque requête SQL paierait alors la distance.

Procédure :

1. Choisir une fenêtre de maintenance hors des heures terrain et prévenir les utilisateurs.
2. Faire les sauvegardes du §6, avec un `pg_dump` téléchargé.
3. Changer la région du service Postgres, puis celle du service « app ». Railway déplace les volumes attachés, avec une coupure qui dépend de leur taille.
4. Refaire les contrôles du §8, puis mesurer. Objectif : moins de 80 ms depuis l’Europe, contre environ 200 ms aujourd’hui.

   ```sh
   for i in 1 2 3 4 5; do curl -s -o /dev/null -w '%{time_starttransfer}\n' https://thinkercare-animation.vercel.app/api/terrain; done
   ```

## 8. Vérifier un déploiement

Faire ces contrôles sur l’URL Vercel, puis sur l’URL Railway : les en-têtes doivent être identiques.

```sh
APP=https://thinkercare-animation.vercel.app      # puis https://thinkercare-animation-production.up.railway.app

# Santé (Railway)
curl -s -o /dev/null -w '%{http_code}\n' https://thinkercare-animation-production.up.railway.app/healthz   # 200

# Page : en-têtes de sécurité et cache
curl -s -D - -o /dev/null "$APP/" | grep -iE '^(content-security-policy|x-frame-options|strict-transport-security|x-content-type-options|referrer-policy|permissions-policy|x-xss-protection|cache-control):'

# Fichiers construits (nom haché) et fichiers fixes de app/public
JS=$(curl -s "$APP/" | grep -o '/assets/[^"]*\.js' | head -1)
curl -s -D - -o /dev/null "$APP$JS" | grep -i '^cache-control:'
curl -s -D - -o /dev/null "$APP/assets/favicon.svg" | grep -i '^cache-control:'

# API sans session
curl -s -D - "$APP/api/terrain"
```

Résultats attendus :

| Contrôle | Attendu |
| --- | --- |
| `/healthz` | `200` |
| `Content-Security-Policy` de la page | exactement `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' https:; connect-src 'self' https:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'` |
| Autres en-têtes | `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()`, `X-XSS-Protection: 0` |
| `index.html` et routes de l’application | `Cache-Control: no-cache` |
| `/assets/*.js`, `/assets/*.css` (noms hachés par Vite) | `Cache-Control: public, max-age=31536000, immutable` |
| Autres fichiers de `/assets` (favicon, images de `app/public/assets`) | `Cache-Control: public, max-age=86400` |
| `/api/terrain` sans cookie | `401`, `Cache-Control: no-store`, corps JSON `{"error":"…"}` |
| Réponses JSON de l’API de plus de 1 Ko (avec session) | `Content-Encoding: br` ou `gzip` selon `Accept-Encoding`, `Vary: Accept-Encoding` |
| Photos (`/api/photos?id=…`, `/api/field-photos?…`, avec session ; `&size=thumb` pour la miniature) | `Cache-Control: private, no-cache`, `ETag`, `Content-Length` ; `304` si `If-None-Match` correspond. Le navigateur revalide à chaque affichage : sans session, la photo n’est plus montrée, même déjà vue sur l’appareil. |

**Connexion de bout en bout.** Le mot de passe est saisi sans écho, donc absent de l’historique du shell. S’il contient `"` ou `\`, tester dans le navigateur.

```sh
read -rs PW
curl -s -c /tmp/terrain.jar -o /dev/null -w 'login %{http_code}\n' "$APP/api/terrain" \
  -H 'Content-Type: application/json' -H "Origin: $APP" \
  --data "{\"action\":\"login\",\"username\":\"direction\",\"password\":\"$PW\"}"
curl -s -b /tmp/terrain.jar -o /dev/null -w 'bootstrap %{http_code}\n' "$APP/api/terrain"
curl -s -b /tmp/terrain.jar -D - "$APP/api/terrain" -H 'Content-Type: application/json' -H "Origin: $APP" \
  --data '{"action":"logout"}' | grep -iE '^(HTTP|set-cookie|clear-site-data)|ok'
rm -f /tmp/terrain.jar; unset PW
```

Résultats attendus :

- **Connexion** : statut `2xx`, avec `Set-Cookie: __Host-terrain-session=…; Path=/; HttpOnly; Secure; SameSite=Strict` (et `__Host-terrain-device`, valable un an). Un `403 Origine non autorisée.` signale qu’`APP_ORIGIN` ne contient pas le domaine.
- **Bootstrap** : `200`.
- **Déconnexion** : `200 {"ok":true}`, cookie vidé et `Clear-Site-Data: "cache"`. La déconnexion répond toujours ainsi, même sans session valide.

**Recette par rôle**, dans le navigateur, avec des données non personnelles :

- **Direction** : se connecter, puis ouvrir Comptes et Traçabilité.
- **Gestionnaire** : programmer une animation.
- **Animatrice** : pointer l’arrivée avec photo (vérifier que la photo s’affiche), enregistrer une vente, prendre la photo du milieu, pointer le départ, soumettre le rapport. La photo du milieu s’ouvre à mi-créneau : pour la recette, programmer un créneau déjà à moitié écoulé.
- **Gestionnaire** : valider le rapport.
- **Médecin** : ouvrir les réclamations.

## 9. Incidents fréquents

| Symptôme | Cause probable |
| --- | --- |
| Connexion depuis Vercel : `403 Origine non autorisée.` | Domaine Vercel absent d’`APP_ORIGIN`. |
| L’interface s’affiche mais tous les appels `/api` sont en 404/502 | `destination` de `app/vercel.json` différente de l’URL Railway. |
| `503 Stockage photo indisponible.` au pointage | `STORAGE_DIR` absent ou volume non monté sur `/data`. |
| `503` à la création ou à la réinitialisation d’un compte | `ACCOUNT_PASSWORD_KEY` absente ou invalide. |
| Retour à l’écran de connexion | Session expirée ou révoquée : toute réponse `401` de `/api` ramène à la connexion. Une déconnexion dans un onglet déconnecte aussi les autres onglets. |
| `429 Trop de tentatives.` pour un utilisateur légitime | Plus de 10 échecs en 15 minutes sur cet identifiant depuis des navigateurs inconnus (ou plus de 20 tentatives depuis la même adresse). Le navigateur habituel de l’utilisateur garde sa propre limite et peut se connecter ; sinon attendre la fin du quart d’heure. |
| Le service redémarre en boucle | Voir les journaux (Railway → Deployments → Logs, préfixes `[config]`, `[migrate]`, `[seed]`, `[main]`). Le plus souvent : `DATABASE_URL` invalide ou base injoignable. |
| « L’opération n’a pas abouti » côté utilisateur | Chercher `[http] 500` dans les journaux : méthode, chemin, action, compte et pile d’appel (jamais le corps de la requête). Les incidents de stockage sont préfixés `[storage]`, les transactions abandonnées après plusieurs conflits `[tx]`. |
| `503 Trop d’envois de photos en cours.` | Plus de 4 envois simultanés et 8 en attente, ou déjà 2 envois en cours pour ce compte. L’application propose de réessayer avec la même photo, sans doublon. Un envoi dont le corps n’avance plus pendant 20 s, ou n’est pas arrivé en 60 s, est coupé pour libérer sa place ; une connexion coupée par le téléphone n’apparaît pas en `[http] 500`. |
| `[db] idle connection lost` dans les journaux | Postgres a fermé une connexion inutilisée (redémarrage, maintenance). Sans conséquence : la requête suivante en ouvre une nouvelle. |
