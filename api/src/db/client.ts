import {Pool, types} from 'pg';
import {drizzle, type NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';

/**
 * SQLite/D1 returned COUNT/SUM as JS numbers; node-postgres returns BIGINT (OID
 * 20) and NUMERIC (OID 1700) as strings by default. The frontend's checked
 * responses expect numbers, so parse both back to Number. All values here are
 * bounded (money in centimes, counts) and stay well inside 2^53.
 */
types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8 / bigint
types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

let pool: Pool | null = null;
let database: NodePgDatabase<typeof schema> | null = null;

export function getPool(): Pool {
  // A pool ended by a one-off script or a test suite is replaced on next use.
  if (!pool || (pool as any).ending) {
    database = null;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set.');
    pool = new Pool({
      connectionString,
      // Railway Postgres requires TLS; disable strict cert verification which the
      // managed endpoint does not provide a public chain for.
      ssl: sslConfig(connectionString),
      max: Number(process.env.PG_POOL_MAX || 10),
      // Fail fast instead of queueing forever when the pool or database is stuck.
      connectionTimeoutMillis: 10000,
      // Low, bursty traffic: keep connections across the app's 20 s polling gaps
      // instead of reconnecting (pg's default closes them after 10 s idle).
      idleTimeoutMillis: 60000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      // Server-side cap per statement; migrate.ts disables it (PG_STATEMENT_TIMEOUT_MS=0).
      statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 30000) || undefined,
    });
    // An idle connection closed by Postgres (restart, failover, network reset) is
    // re-emitted here; without a listener Node would exit. pg-pool has already
    // dropped that client, and the next query opens a new one.
    pool.on('error', (e) => console.warn('[db] idle connection lost:', e.message));
  }
  return pool;
}

function sslConfig(url: string) {
  if (process.env.PGSSLMODE === 'disable' || process.env.DATABASE_SSL === 'false') return false;
  if (process.env.DATABASE_SSL === 'true') return {rejectUnauthorized: false};
  // No SSL for local Postgres or Railway's private network (…​.railway.internal).
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(url) || /railway\.internal/.test(url)) return false;
  // Public managed Postgres (e.g. Railway proxy host): TLS without a public chain.
  return {rejectUnauthorized: false};
}

export function db(): NodePgDatabase<typeof schema> {
  const current = getPool();
  if (!database) database = drizzle(current, {schema});
  return database;
}

export {schema};
