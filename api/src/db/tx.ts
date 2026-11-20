import {sql, type SQL} from 'drizzle-orm';
import {db} from './client';
import {fail} from '../common/errors';

/**
 * Minimal executor surface shared by the pool-bound `db()` and a transaction
 * handle — both expose `.execute(sql)` returning a node-postgres QueryResult.
 */
export interface Exec {
  execute(query: SQL): Promise<{rows: any[]; rowCount: number | null}>;
}

export async function first<T = any>(ex: Exec, query: SQL): Promise<T | undefined> {
  const r = await ex.execute(query);
  return r.rows[0] as T | undefined;
}

export async function all<T = any>(ex: Exec, query: SQL): Promise<T[]> {
  const r = await ex.execute(query);
  return r.rows as T[];
}

export async function run(ex: Exec, query: SQL): Promise<number> {
  const r = await ex.execute(query);
  return r.rowCount ?? 0;
}

/**
 * Runs a mutating unit of work in a SERIALIZABLE transaction with a small
 * retry-on-serialization-failure loop (design §9.1.1). SQLite serialized every
 * write; under Postgres SERIALIZABLE closes the overlap/oversell race that
 * READ COMMITTED would allow. Conflicts are rare but real (e.g. simultaneous
 * photo uploads whose triggers read the same index pages), so retries wait a
 * jittered, exponentially growing 20–200 ms to let the competing transaction
 * commit first; an exhausted retry becomes a 409 "data changed, retry".
 */
export async function serializable<T>(fn: (tx: Exec) => Promise<T>, retries = 5): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await db().transaction(async (tx) => fn(tx as unknown as Exec), {
        isolationLevel: 'serializable',
      })) as T;
    } catch (e: any) {
      const code = e?.code;
      if ((code === '40001' || code === '40P01') && attempt < retries) {
        await new Promise((r) => setTimeout(r, Math.min(200, 20 * 2 ** attempt * (1 + Math.random()))));
        continue;
      }
      if (code === '40001' || code === '40P01') {
        console.warn(`[tx] serialization retries exhausted (sqlstate=${code})`);
        fail('Données modifiées ou enregistrement déjà présent. Actualisez avant de réessayer.', 409);
      }
      throw e;
    }
  }
}

export {sql};
