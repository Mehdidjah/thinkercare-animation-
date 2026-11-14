import type {Config} from 'drizzle-kit';

// Drizzle Kit config. `bun run db:generate` reads ./src/db/schema.ts and emits
// SQL migrations into ./drizzle (no running database required for generate).
// `bun run db:migrate` (dist/db/migrate.js) applies them + triggers.sql.
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgres://localhost:5432/thinkercare',
  },
  strict: true,
  verbose: true,
} satisfies Config;
