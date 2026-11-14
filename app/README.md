# ThinkerCare Terrain

Internal field-operations app for a skincare distributor (brands **TOUCHÉ · BELNCO · NOOM**).
Managers schedule in-store promotion visits ("animations"); field agents clock in/out with
photos, record stock counts and sales, raise complaints/requests, and log field observations;
managers review reports and track bonuses and performance. French UI, Algiers timezone,
Algerian Dinar.

## Stack

- **React 19** + **TanStack Start / Router** (SSR), **Vite 7**, **TypeScript**
- Runtime: **Cloudflare Workers** (server-rendered) — **D1** (SQLite) + **R2** (private photos)
- Validation: **Zod**. Package manager / runtime: **Bun**.

## Architecture

The app is a single SSR page (`/`) plus JSON API routes. Business logic lives in
`src/terrain/`, split into three layers:

```
src/
├─ routes/              TanStack file-based routes (do not reorganize)
│  ├─ __root.tsx        HTML shell + providers
│  ├─ index.tsx         mounts terrain/ui/App
│  └─ api/              terrain | photos | field-photos  (GET/POST handlers)
├─ terrain/
│  ├─ domain/           pure, shared logic — no I/O
│  │   core.ts          roles, permissions, money/date math, report checks
│  │   operations.ts    service-desk / field-note rules, bonus calc
│  │   response-checks.ts  client-side response-shape guards
│  ├─ api/              server handlers (run in the Worker)
│  │   api.server.ts    auth + missions/stock/sales/reports/users
│  │   operations.server.ts  cases (service desk), field notes, performance
│  │   body.server.ts   streamed multipart (photo) body parser
│  └─ ui/               React client
│      App.tsx          shell + all screens
│      *.tsx            screens (planning, service desk, performance, …)
│      client.ts        fetch wrapper for /api/terrain
│      field-photo-client.ts  client-side photo selection/compression
├─ lib/                 server infra: bindings (D1/R2), error capture, security headers
├─ server.ts start.ts   SSR entry / client entry
├─ router.tsx           router + query client
└─ styles.css           hand-written CSS (no Tailwind directives in use)
```

**Layer rule:** `ui` and `api` depend on `domain`; `domain` depends on nothing.
`routes/*` is driven by TanStack's file-based routing and the generated
`routeTree.gen.ts` — don't move files there by hand.

## Develop

Prerequisite: [Bun](https://bun.sh).

```sh
bun install          # install deps (regenerates bun.lock)
bun run dev          # local dev server (vite)
bun run typecheck    # tsc --noEmit
bun run lint         # eslint
bun run build        # typecheck + Workers SSR build -> dist/
bun run preview      # preview the production build
```

## Data & infrastructure

- `app.manifest.json` opts into **D1** (`env.DB`) and **R2** (`env.STORAGE`); accessed via
  `src/lib/bindings.server.ts`.
- Schema is in `migrations/0001…0005_*.sql` — **additive only** (one DB is shared by
  preview + prod). `0005_service_primes_terrain.sql` (cases / field notes / bonuses) was
  **not yet applied** in the original data snapshot; test it on a copy first.
- `wrangler.jsonc` is a **dev/build placeholder** — the real deploy config (resource IDs,
  secrets, domain) is injected by the host at deploy time. A non-Workers target would need
  the server data/storage access adapted.
- Auth: session cookie `__Host-terrain-session`, PBKDF2-SHA256 password hashes, four roles
  (admin / manager / field / doctor). Serve over HTTPS.

## Tests

`tests/` covers the risky logic — permissions, date/money math, concurrency races,
the photo-body limit, and a real SQLite run of the migrations:

```sh
node tests/terrain.mjs
node tests/workflow.mjs
node tests/body-and-responses.cjs
node tests/remote-state.cjs
node tests/operations.cjs      # needs python3 for the SQLite bridge
```

> Note: these were authored for the original CI sandbox and still hard-code a couple of
> environment paths (a Babel transform bundle, `/home/user/...`) plus the `src/terrain/`
> layout. After `bun install`, expect to adjust those paths before they run locally. CI
> (`.github/workflows/ci.yml`) currently runs install → typecheck → build.

## Backup / archive

The handover snapshot (DB export in JSON/SQLite/SQL, catalogue + private media, audit,
git-history bundle, docs) lives on disk alongside this folder (`../02_historique` …
`../07_documentation`, `SHA256SUMS.txt`, `verifier_dossier.py`) and is **git-ignored** — it
doesn't affect how the app builds or runs. See `../00_LIRE_EN_PREMIER.md`.
