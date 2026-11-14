# ThinkerCare Terrain — single Railway service: NestJS API + built Vite SPA.
# Multi-stage: build the frontend, build the API, then a slim Node runtime that
# runs migrations + seed + the server.

# ---------------------------------------------------------------------------
# 1) Build the frontend (app/ -> app/dist)
FROM oven/bun:1.3 AS web
WORKDIR /src/app
COPY app/package.json ./
COPY app/bun.lock* ./
# --ignore-scripts: bun resolves esbuild/vite platform binaries as optional deps
# natively, so the build never needs `node` to run a postinstall script.
RUN bun install --ignore-scripts
COPY app/ ./
RUN bun run build

# ---------------------------------------------------------------------------
# 2) Build the API (api/ -> api/dist, including copied triggers.sql + catalogue.json)
FROM oven/bun:1.3 AS api
WORKDIR /src/api
COPY api/package.json ./
COPY api/bun.lock* ./
# --ignore-scripts: avoid esbuild's `node`-based postinstall; the API runtime is
# pure JS (nest/drizzle-orm/pg/aws-sdk) and migrations are pre-generated.
RUN bun install --ignore-scripts
COPY api/ ./
RUN bun run build

# ---------------------------------------------------------------------------
# 3) Runtime (Node 22 — the Dockerfile CMD runs node)
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/api

# API deps + build output + generated migrations
COPY --from=api /src/api/node_modules ./node_modules
COPY --from=api /src/api/package.json ./package.json
COPY --from=api /src/api/dist ./dist
COPY --from=api /src/api/drizzle ./drizzle

# Built frontend served statically at /app/app/dist (main.ts resolves ../../app/dist)
COPY --from=web /src/app/dist /app/app/dist

EXPOSE 3000
# Apply schema migrations + triggers, seed the baseline, then start the server.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/db/seed.js && node dist/main.js"]
