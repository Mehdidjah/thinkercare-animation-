import type {SQL} from 'drizzle-orm';
import {type Exec, first, all, run, serializable, sql} from '../db/tx';
import {fail} from '../common/errors';
import {randomUUID} from '../common/crypto';
import {canMission, canEdit, dayInAlger, type User} from '../domain/core';
import {canReadFieldNote} from '../domain/operations';

/**
 * Shared terrain helpers ported from api.server.ts / operations.server.ts.
 * All take an `Exec` (the pool-bound db() for reads, or a transaction handle for
 * mutations) so the same logic runs inside and outside SERIALIZABLE transactions.
 */

/** INSERT into tf_audit; detail is encoded as jsonb (was JSON-in-TEXT in SQLite). */
export function auditSql(u: User, action: string, target: string, detail: unknown = {}) {
  return sql`INSERT INTO tf_audit(id,user_id,at,action,target,detail)
             VALUES(${randomUUID()},${u.id},${new Date().toISOString()},${action},${target},${JSON.stringify(detail)}::jsonb)`;
}

/** Load a mission the user may access (brands arrives already parsed from jsonb). */
export async function mission(ex: Exec, u: User, key: string, edit = false): Promise<any> {
  const m = await first<any>(ex, sql`SELECT * FROM tf_missions WHERE id=${key}`);
  if (!m || !canMission(u, m)) fail('Animation non accessible.', 403);
  if (edit && !canEdit(u, m)) fail('Cette animation est verrouillée. Une correction doit être demandée.', 409);
  return m; // brands already an array (jsonb) — no JSON.parse (design §9.2)
}

/** Sales tickets for a mission (lines already parsed from jsonb). */
export async function sales(ex: Exec, key: string): Promise<any[]> {
  return all<any>(ex, sql`SELECT * FROM tf_tickets WHERE mission_id=${key} ORDER BY created_at DESC`);
}

/** Stock counts for a mission, joined to product metadata. */
export async function counts(ex: Exec, key: string): Promise<any[]> {
  return all<any>(
    ex,
    sql`SELECT c.*,p.name AS product_name,p.brand,p.unit
        FROM tf_counts c JOIN tf_products p ON p.id=c.product_id
        WHERE mission_id=${key} ORDER BY p.brand,p.name`,
  );
}

/** brands arrives parsed from jsonb; the original JSON.parse is gone. */
export const parseMission = (m: any) => m;

/** Load a field observation the user may read (ported from operations.server noteBy). */
export async function noteBy(ex: Exec, u: User, key: string) {
  const n = await first<any>(
    ex,
    sql`SELECT n.*,COALESCE(s.name,NULLIF(n.store_label,''),'Sans pharmacie') AS store_name,u.label AS author_name
        FROM tf_field_notes n LEFT JOIN tf_stores s ON s.id=n.store_id JOIN tf_users u ON u.id=n.author_id
        WHERE n.id=${key}`,
  );
  if (!n || !canReadFieldNote(u, n)) fail('Observation non accessible.', 403);
  return n;
}

/**
 * Replaces the D1 `tf_guards` version-guard hack. Inside a SERIALIZABLE
 * transaction: bump the mission version with an optimistic
 * `WHERE version=$expected` guard (rowCount 0 => concurrent change => 409), run
 * the mission's writes (integrity triggers fire here), then record the audit
 * event. Serialization-failure retries are handled by serializable().
 */
export async function batchMission(u: User, m: any, action: string, writes: SQL[], detail: unknown = {}) {
  const now = new Date().toISOString();
  await serializable(async (tx: Exec) => {
    const bumped = await run(
      tx,
      sql`UPDATE tf_missions SET version=version+1,updated_at=${now} WHERE id=${m.id} AND version=${m.version}`,
    );
    if (!bumped) fail('Données modifiées ou enregistrement déjà présent. Actualisez avant de réessayer.', 409);
    for (const w of writes) await run(tx, w);
    await run(tx, auditSql(u, action, m.id, detail));
  });
}

/** GET-range validator (api.server.getTerrain): defaults + 366-day cap. */
export function range(q: URLSearchParams): {from: string; to: string} {
  const from = parseDate(q.get('from') || dayInAlger());
  const to = parseDate(q.get('to') || from);
  if (to < from || (Date.parse(to) - Date.parse(from)) / 86400000 > 366) fail('Période invalide (366 jours maximum).');
  return {from, to};
}

/** operations.server.period(): month-start default, ISO window bounds. */
export function period(q: URLSearchParams) {
  const from = parseDate(q.get('from') || dayInAlger().slice(0, 7) + '-01');
  const to = parseDate(q.get('to') || dayInAlger());
  if (to < from || Date.parse(to) - Date.parse(from) > 366 * 86400000)
    fail('Choisissez une période de 366 jours maximum.');
  return {
    from,
    to,
    start: new Date(from + 'T00:00:00+01:00').toISOString(),
    end: new Date(Date.parse(to + 'T00:00:00+01:00') + 86400000).toISOString(),
  };
}

function parseDate(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + 'T00:00:00Z'))) fail('Date invalide.');
  return s;
}
