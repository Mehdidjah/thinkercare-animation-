# ThinkerCare Terrain — Backend migration to NestJS + Postgres (Drizzle) on Railway

**Status:** Draft for approval · **Date:** 2026-11-14

## 1. Intent & why

The app currently runs entirely on **Cloudflare** (Workers runtime + D1 SQLite + R2
storage) as a TanStack Start full-stack app. The goal is to get **off Cloudflare and
onto Railway**, with the database in **Railway Postgres**, and the backend rebuilt as a
standalone **NestJS** API using **Drizzle ORM**. End state: a repo that deploys to
Railway and runs with no Cloudflare dependency.

This is a **rebuild of the server**, not a port of config — the whole data layer (131
queries), photo storage, auth/crypto, and the SSR runtime are Cloudflare-specific.

## 2. Goals / non-goals / anti-goals

**Goals**
- NestJS backend, Postgres (Railway), Drizzle ORM/Kit, S3-compatible photo storage.
- Preserve the app's behavior and its **data-integrity guarantees** (schedule-overlap
  prevention, overselling prevention, report-locking, photo caps, optimistic
  concurrency, role-based access, clinical-note privacy).
- Keep the existing React UI and its exact API contract so the frontend barely changes.
- One Railway service that serves both the API and the built UI (same origin → cookies
  and `fetch` keep working unchanged).

**Non-goals (v1)**
- Migrating the *existing* D1 data. v1 ships a fresh DB + seeded admin. Importing the
  backup snapshot (`thinkercare-backup/03_donnees`) is a separate, later task.
- Changing features, UI, or business rules.
- SSR / SEO (the app is auth-gated and `noindex`; a client-rendered SPA is correct here).

**Anti-goals (would make this a failure even if it "works")**
- Silently dropping a data-integrity rule that the SQL triggers enforce today.
- Weakening auth (password hashing, session handling, CSRF/origin checks, throttling).
- Leaking clinical/"tolerance" notes to non-doctor roles.

## 3. Constraints

- **I cannot build, run, or deploy in this environment** (no network / Railway /
  Postgres). Deliverable is a complete, deployable codebase + Railway runbook; the
  human runs install/migrate/deploy and is the one to confirm it works.
- Railway has **no managed blob store** → photos go to **S3-compatible** object storage
  (Cloudflare R2 / AWS S3 / Backblaze / MinIO), configured by env. (Railway volume +
  local FS is a documented fallback for the simplest single-instance setup.)
- Postgres differs from SQLite: triggers (PL/pgSQL), `jsonb` vs JSON-in-TEXT,
  `ON CONFLICT` nuances, real transactions (which *replace* the D1 `tf_guards` hack).

## 4. Approaches considered

- **A — Keep TanStack Start, swap D1→Postgres, host on Railway (Node).** Smallest lift,
  keeps tested logic. *Rejected by the user* — they want a NestJS architecture.
- **B — Rebuild backend in NestJS + Postgres + Drizzle (CHOSEN).** Matches the target
  stack; clean API/UI split; larger, higher-risk rewrite of security/integrity code.
- **C — NestJS wrapping the existing D1 logic.** Incoherent (still Cloudflare-bound).
  Rejected.

## 5. Target architecture

Single Railway service (Node) = **NestJS API** that also serves the **built Vite SPA**
as static files, plus a **Railway Postgres** plugin and an **S3 bucket**.

```
repo/
├─ api/                         NestJS backend
│  ├─ src/
│  │  ├─ main.ts                bootstrap: cookies, security headers, serve web/dist, listen($PORT)
│  │  ├─ app.module.ts
│  │  ├─ db/
│  │  │  ├─ schema.ts           Drizzle schema (tf_* tables, jsonb, indexes)
│  │  │  ├─ client.ts           pg Pool + drizzle()
│  │  │  └─ triggers.sql        PL/pgSQL triggers (overlap, oversell, report-lock, photo-cap)
│  │  ├─ auth/                  AuthGuard, session service, pbkdf2, throttle, origin/CSRF
│  │  ├─ terrain/               controllers + services (one per endpoint group)
│  │  ├─ storage/               S3 service (put/get/delete) + streamed multipart limit
│  │  ├─ domain/                pure logic copied from src/terrain/domain/* (core, operations, checks)
│  │  └─ common/                ZodValidationPipe, HttpExceptionFilter (error mapping)
│  ├─ drizzle/                  generated SQL migrations
│  ├─ drizzle.config.ts
│  ├─ scripts/seed.ts           initial admin (+ optional product catalogue)
│  └─ package.json
├─ web/                         the existing React UI, de-TanStack-Start-ified (Vite SPA)
│  ├─ src/                      terrain/ui/* components + styles.css (unchanged) + main.tsx entry
│  ├─ index.html
│  └─ package.json
├─ Dockerfile                   multi-stage: build web → build api → run (migrate + start)
├─ railway.json                 Railway build/deploy config
└─ docs/
```

### 5.1 Database (Drizzle + Postgres)
- Port every `tf_*` table. Flags that the app treats as 0/1 (`active`, `force_change`,
  `no_sales`, `consent`, `clinical`, `damaged>0` etc.) stay **`integer`** to preserve app
  semantics with minimal churn; money stays **`integer`** centimes; `tickets.lines`,
  `missions.brands`, `audit.detail` become **`jsonb`**; timestamps/dates stay **`text`**
  (ISO/`YYYY-MM-DD`) and `expires` stays epoch-ms **`bigint`** — matching how JS already
  passes them, to avoid behavioral drift.
- **Triggers → PL/pgSQL** (`triggers.sql`, run as a migration): `tf_no_overlap`,
  `tf_counts_editable`, `tf_tickets_editable`, `tf_ticket_stock`, `tf_field_photo_limit`,
  raising `SCHEDULE_CONFLICT` / `REPORT_LOCKED` / `STOCK_INSUFFICIENT` /
  `FIELD_PHOTO_LIMIT` exactly as today. SQLite `json_each(lines)` → `jsonb_array_elements`.
- **Optimistic concurrency**: drop the `tf_guards` table; use real **transactions**
  (`db.transaction`) with `UPDATE … WHERE version = $expected` + rowcount checks.
- **Migrations**: Drizzle Kit. `scripts/seed.ts` seeds the initial `direction` admin
  (force-change) like migration `0003`; optional product-catalogue seed from the existing
  catalogue JSON.

### 5.2 API (NestJS)
- **Preserve the existing HTTP contract** so the frontend is unchanged: same routes
  `GET/POST /api/terrain`, `GET/POST /api/photos`, `GET/POST /api/field-photos`,
  `GET /robots.txt|/sitemap.xml`, same `?action=…` / `{action:…}` dispatch, same JSON
  responses and error strings. Controllers dispatch to services per group:
  auth · missions/scheduling · stock/counts · sales/tickets · reports/review ·
  complaints · cases (service desk) · field-notes · performance/bonuses · photos · audit · users.
- **Reuse the existing Zod schemas and the pure domain logic** (`core.ts`,
  `operations.ts`, `response-checks.ts`) verbatim in the services — this is the safest way
  to preserve validation and permission rules.
- **Error mapping**: a Nest `ExceptionFilter` reproduces `errorResponse` (Zod → 400;
  status-tagged errors; `SCHEDULE_CONFLICT`/`STOCK_INSUFFICIENT`/`REPORT_LOCKED`/unique →
  409; fallback 500), with the same French messages.

### 5.3 Auth & security
- Session cookie **`__Host-terrain-session`** (HttpOnly, Secure, SameSite=Strict, 8h);
  token = 32 random bytes hex; store `SHA-256(token)` in `tf_sessions`. `AuthGuard`
  resolves `req.user`; `force_change` gate preserved.
- Passwords: **PBKDF2-SHA256, 100k iters, per-user salt** via `node:crypto` (same
  algorithm as today). Login **throttle** kept in `tf_throttle`.
- **Origin/CSRF** check on POST, **security headers** middleware (port of
  `security-headers.server.ts`), `no-store`/`noindex` on API responses, constant-time
  compares.

### 5.4 Storage (photos)
- **`@aws-sdk/client-s3`**, env-configured (`S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`); keys `terrain/<uuid>` and
  `terrain-notes/<uuid>` as today; streamed multipart size cap, magic-byte MIME sniffing,
  and R2-write-rollback-on-DB-failure all preserved. Private photos served through the
  authorized Nest endpoint only. *Fallback:* Railway volume + local FS (documented).

### 5.5 Frontend (consequence of dropping Workers/SSR)
- Convert `app/` → `web/`: remove TanStack **Start** (SSR) and the Workers build; keep
  **React + @tanstack/react-query + the `terrain/ui/*` components + `styles.css`
  unchanged**. New minimal `main.tsx` mounts `<Terrain/>` (single page); `client.ts` stays
  (`fetch('/api/terrain', {credentials:'same-origin'})` — works because Nest serves the
  SPA same-origin). Nest serves `robots.txt`/`sitemap.xml`. Meta/`noindex` moves to
  `index.html`.

### 5.6 Deploy (Railway)
- Railway project: **Postgres** plugin + **app service** (this repo). S3 bucket external.
- **Dockerfile** multi-stage: install → build `web` (Vite) → build `api` (Nest), copy
  `web/dist` into the api image → runtime image runs **drizzle migrate** then
  `node dist/main.js` on `$PORT`.
- Env: `DATABASE_URL` (Railway Postgres), `S3_*`, `NODE_ENV=production`, `PORT`,
  `APP_ORIGIN` (for the CSRF origin check). HTTPS via Railway's domain (required for the
  `__Host-` cookie).
- `docs/DEPLOY.md` runbook: create project → add Postgres → set env → deploy → run
  seed → smoke-test each role.

## 6. What's left to the builder
- Exact Drizzle column types per table (follow §5.1 rules) and the generated migration.
- Faithful PL/pgSQL translations of the 5 triggers (semantics must match the SQLite
  originals, verified against `migrations/0001,0002,0004,0005`).
- Per-endpoint service bodies — mechanical transcriptions of the current handlers in
  `api.server.ts` / `operations.server.ts`, swapping D1 `.prepare().bind().first/all/run`
  and `.batch()` for Drizzle queries + transactions, keeping the same SQL semantics.
- Dockerfile/railway.json specifics and the seed script.

## 7. Phases (for the implementation plan)
1. Scaffold `api/` (NestJS) + `web/` (Vite SPA from existing UI); repo restructure.
2. Drizzle schema + triggers + migrations + seed.
3. Auth module (guard, session, pbkdf2, throttle, origin, security headers, error filter).
4. Terrain controllers/services — port each endpoint group, reusing Zod + domain logic.
5. Storage module (S3) + photo endpoints.
6. Frontend de-Start-ification + served by Nest.
7. Railway config (Dockerfile, railway.json, env) + `DEPLOY.md` runbook.
8. Port the test suite (domain tests directly; the SQLite integration test → Postgres).

## 8. Verification reality
I can't compile/run/deploy here. Each phase is written to be checkable by inspection
(types, imports, SQL parity against the originals). **The human must run**
`npm/bun install`, `drizzle migrate`, `npm run build`, the ported tests, and a Railway
deploy to confirm — nothing is "verified working" until then.

## 9. Resolutions from design review

### 9.1 Decisions (settled, not open)
1. **Concurrency / integrity under Postgres.** SQLite serialized all writes; Postgres
   READ COMMITTED can race the overlap/oversell `BEFORE` triggers (two txns each pass
   their check without seeing the other's uncommitted row). Decision: run every
   **mutating transaction at `SERIALIZABLE`** with a small **retry-on-serialization-
   failure (SQLSTATE 40001) wrapper** (a few retries → else a 409 "data changed, retry").
   The ported PL/pgSQL triggers stay as the checks; SERIALIZABLE closes the race, and real
   concurrency is near-zero (one field agent per device/mission) so retries essentially
   never fire. The `version` guard (`UPDATE … WHERE version=$expected` + rowcount) stays
   for existing-row edits; new-row inserts rely on trigger + SERIALIZABLE. Satisfies the
   "no integrity rule dropped" anti-goal.
2. **Login-throttle client IP.** `CF-Connecting-IP` doesn't exist off Cloudflare —
   bucketing on it would collapse every attempt into one `'unknown'` bucket (lockout +
   no attacker isolation). Decision: enable Express **trust proxy** and key the throttle
   on **`X-Forwarded-For`** (first hop from Railway's edge). Keep the DB `tf_throttle`
   20-per-15-min logic.
3. **Product catalogue is baseline, not optional.** The app is unusable without products
   (scheduling is by brand, sales are of products) and the data already exists in
   `0002`/`0004` / the catalogue JSON. Decision: "fresh database" = **no operational data**
   (missions, sales, tickets, cases, non-admin accounts) — but the **full product
   catalogue + the admin are seeded as baseline**. The ported schema test keeps asserting
   the catalogue count. *(Refines the earlier "fresh DB + admin" default.)*
4. **First admin login.** `scripts/seed.ts` reads a required **`ADMIN_INITIAL_PASSWORD`**
   env var, hashes it (PBKDF2-SHA256), sets `force_change=1`. No secret in source, none
   printed to logs. The seed creates **only the admin**; the admin then creates
   manager/field/doctor accounts in-app. `DEPLOY.md` smoke-test = log in as admin → change
   password → create the other roles → test each role.
5. **Standalone deploy → clickjacking protection.** The Railway app is accessed
   **directly** (not iframe-embedded in the Higgsfield host). The original
   `security-headers.server.ts` omitted `frame-ancestors`/`X-Frame-Options` because the
   host injected them; the port **adds `Content-Security-Policy: frame-ancestors 'none'`
   + `X-Frame-Options: DENY`**. `__Host-`/SameSite=Strict cookie stays (same-origin
   top-level access).

### 9.2 Mechanical translation notes for the builder (flagged in review)
- SQLite-only SQL to translate: `julianday(...)` time math in the performance query →
  Postgres interval/epoch; `json_extract`/`json_each` → `->>'…'` / `jsonb_array_elements`.
- `tickets.lines`, `missions.brands`, `audit.detail` are now **`jsonb`** → the pg driver
  returns already-parsed objects, so **delete the verbatim `JSON.parse(...)` calls**.
- `.batch()` + `INSERT tf_guards … CHECK(ok=1)` → `UPDATE … WHERE version=$expected` +
  rowCount check inside the transaction; drop `tf_guards`.
- Text timestamps are UTC ISO → lexicographic order == chronological, safe to compare
  as-is (no change needed).

