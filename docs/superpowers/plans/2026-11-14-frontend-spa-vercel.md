# Frontend → static Vite SPA on Vercel — Implementation Plan

> **Historical plan (superseded).** `VITE_API_URL` was later removed: the SPA only calls `/api/...` on its own origin (Vercel rewrites `/api/*` to Railway, `bun run dev` proxies it to `localhost:3000`). Current setup: [`app/README.md`](../../../app/README.md) and [`docs/DEPLOY.md`](../../DEPLOY.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Terrain UI (currently a TanStack Start + Cloudflare Workers SSR app) into a standalone **static Vite React SPA** that builds clean and deploys to **Vercel**, with its API calls pointed at a configurable backend base URL (the Railway NestJS API, built later).

**Architecture:** Strip TanStack **Start** (SSR), the Workers build, and the server-side route files; keep the React UI (`src/terrain/ui/*`) and pure logic (`src/terrain/domain/*`) unchanged. Add a plain Vite SPA entry (`index.html` + `src/main.tsx`) that mounts `<Terrain/>` inside the existing `QueryClientProvider`. `client.ts` reads `VITE_API_URL`. Vercel builds `app/` as a Vite project → static `dist/`.

**Tech Stack:** Vite 7, React 19, `@tanstack/react-query`, TypeScript. (Drops `@tanstack/react-start`, `@tanstack/react-router`, `@tailwindcss/vite`, `wrangler`, `cloudflare:workers`.)

**Spec:** `docs/superpowers/specs/2026-11-14-nestjs-postgres-railway-migration-design.md` (§5.5).

## Global Constraints
- No `cloudflare:workers` import and no server/SSR code may remain in the build graph — any such import fails a static Vite build.
- UI components and `styles.css` stay byte-for-byte unchanged; only the shell/entry/build change.
- Output is static (`dist/`), deployable by Vercel's Vite preset with **root directory = `app`**.
- Auth note for later: a Vercel-frontend + Railway-API split is **cross-origin**, so the current `__Host-`/SameSite=Strict cookie won't be sent. This is deferred to the backend plan (resolve with SameSite=None;Secure + CORS credentials, or token auth). The frontend preview shows the login screen; actual login works only once the backend plan wires this.

## Review Focus
- **A server/backend file sneaks into the build graph** → `vite build` pulls `cloudflare:workers` and fails. Task 1's build step is the guard: the build must succeed with all `src/routes/api/*`, `src/server.ts`, `src/start.ts`, `src/lib/*.server.ts` removed.
- **`VITE_API_URL` unset at build** → `client.ts` must fall back to a sane default (same-origin `/api`) and not crash the app shell. Task 2 covers this.
- **Vercel root dir misconfigured** → it builds the repo root instead of `app/`. Task 3 pins `app` as root + the Vite preset.

---

### Task 1: Static SPA scaffold (build green)

**Files:**
- Create: `app/index.html`, `app/src/main.tsx`
- Modify: `app/vite.config.ts` (plain React+Vite, static), `app/package.json` (drop Start/Workers/router deps + scripts), `app/tsconfig.json` (drop `cloudflareworkers`/node-server types if any)
- Delete: `app/src/routes/`, `app/src/router.tsx`, `app/src/routeTree.gen.ts`, `app/src/server.ts`, `app/src/start.ts`, `app/src/cloudflare-workers.d.ts`, `app/src/lib/*.server.ts`, `app/wrangler.jsonc`, `app/app.manifest.json`, `app/bunfig.toml`
- Keep: `app/src/terrain/ui/*`, `app/src/terrain/domain/*`, `app/src/styles.css`, `app/src/app-meta.json`, `app/public/*`, `app/src/svg.d.ts`

**Interfaces:**
- Produces: a Vite entry `app/src/main.tsx` that renders `<QueryClientProvider><Terrain/></QueryClientProvider>` into `#root`; `app/index.html` with `<div id="root">` + `<script type="module" src="/src/main.tsx">`, French `lang`, `noindex` meta and title from `app-meta.json`.

- [ ] **Step 1: Delete the SSR/server/route files and Workers config** listed above.
- [ ] **Step 2: Write `app/index.html`** — root div, module script, `<meta name="robots" content="noindex,nofollow">`, title/description from `app-meta.json`, favicon `/assets/favicon.svg`, stylesheet via the main entry import.
- [ ] **Step 3: Write `app/src/main.tsx`** — `createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><Terrain/></QueryClientProvider>)`; `import './styles.css'`; import `Terrain` from `./terrain/ui/App`.
- [ ] **Step 4: Rewrite `app/vite.config.ts`** — `plugins:[react()]`, `root` default, static `build.outDir:'dist'`; remove all SSR/Workers/tanstackStart/tailwind/svgr(if unused)/tsconfigPaths blocks.
- [ ] **Step 5: Prune `app/package.json`** — drop `@tanstack/react-start`, `@tanstack/react-router`, `@tanstack/router-plugin`, `@tailwindcss/vite`, `tailwindcss`, `vite-tsconfig-paths`, `nitro`, `@cloudflare/workers-types`, `vite-plugin-svgr`; keep `react`, `react-dom`, `@tanstack/react-query`, `zod`, `vite`, `@vitejs/plugin-react`, `typescript`, eslint set. Scripts: `dev`/`build`/`preview`/`typecheck` only.
- [ ] **Step 6: Install + build**
  Run: `cd app && bun install && bun run build`
  Expected: build succeeds, emits `app/dist/index.html` + assets, **no `cloudflare:workers`/"No such module" errors**.
- [ ] **Step 7: Render check**
  Run: `cd app && bun run preview` (or `bun run dev`), load `/`.
  Expected: the ThinkerCare **login screen** renders (wordmark, scene image, fields). Submitting fails (no backend) — expected.
- [ ] **Step 8: Commit** `feat(web): convert frontend to static Vite SPA`.

### Task 2: Configurable API base URL

**Files:**
- Modify: `app/src/terrain/ui/client.ts`; create `app/.env.example`

**Interfaces:**
- Consumes: Task 1's SPA. Produces: `request()` targets `${import.meta.env.VITE_API_URL ?? ''}/api/terrain…` and photo `<img>` src builders use the same base; empty base = same-origin.

- [ ] **Step 1: Edit `client.ts`** — prefix the fetch URL with `const API = import.meta.env.VITE_API_URL ?? ''` so `fetch(API + '/api/terrain' + …, {credentials:'include'})`. (Also update photo URL builders in `ui/App.tsx`/`QuickTools.tsx`/`FieldNotebook.tsx` that hit `/api/photos|/api/field-photos` to prefix `API`.)
- [ ] **Step 2: Add `app/.env.example`** with `VITE_API_URL=` (empty = same origin; set to the Railway API URL once it exists).
- [ ] **Step 3: Build** `cd app && bun run build` → still green.
- [ ] **Step 4: Commit** `feat(web): route API calls through VITE_API_URL`.

### Task 3: Vercel deploy config + deploy

**Files:**
- Create: `app/vercel.json` (or set in dashboard): `{ "framework": "vite", "buildCommand": "bun run build", "outputDirectory": "dist" }` + SPA rewrite `{"source":"/(.*)","destination":"/"}` so client routing/refresh works.

- [ ] **Step 1: Add `app/vercel.json`** with the Vite framework preset + SPA rewrite.
- [ ] **Step 2: Commit + push** to `origin main`.
- [ ] **Step 3: Deploy via the aside browser** — import `github.com/Mehdidjah/thinkercare-animation-` into Vercel, **Root Directory = `app`**, Framework = Vite, deploy. (Driven in the user's browser session; the user is logged into Vercel.)
- [ ] **Step 4: Verify** the deployed URL shows the login screen. Done — frontend is live; backend plan follows.

---

## Backend (separate plan, next)
NestJS + Drizzle + Postgres on Railway, per the design doc §5.1–5.6 + §9. Includes resolving the cross-origin auth note above. Planned and executed after this frontend ships.
