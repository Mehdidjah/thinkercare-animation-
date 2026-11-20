import {Injectable} from '@nestjs/common';
import {z} from 'zod';
import {db} from '../db/client';
import {type Exec, first, all, run, serializable, sql} from '../db/tx';
import {fail} from '../common/errors';
import {randomUUID} from '../common/crypto';
import {uuid, id, text, optionalDate} from '../common/validation';
import {auditSql, period, noteBy} from './helpers';
import {manages, canMission, type User} from '../domain/core';
import {MAX_REASONS, reasonFor, reasonCategory, canReadCase, safeCase} from '../domain/operations';

const txt = text;
const contextSchema = {mission_id: uuid.nullable(), store_id: id.nullable(), store_label: txt(160)};

/** Port of operations.server.ts: service desk cases, field notes, bonuses, performance. */
@Injectable()
export class OperationsService {
  /** Returns a response object, or null if the action is not handled here. */
  async getOperations(u: User, q: URLSearchParams): Promise<any | null> {
    const action = q.get('action');

    if (action === 'service-list') {
      const {start, end} = period(q);
      const conds = [sql`c.created_at>=${start}`, sql`c.created_at<${end}`];
      if (u.role === 'field') conds.push(sql`c.author_id=${u.id}`);
      if (u.role === 'doctor') conds.push(sql`c.kind='complaint'`);
      const rows = await all(
        db(),
        sql`SELECT c.id,c.kind,c.reason,c.reasons,c.category,c.channel,c.status,c.priority,c.code,c.created_at,c.updated_at,c.due_day,c.author_id,c.assignee_id,c.product_id,c.store_id,COALESCE(s.name,NULLIF(c.store_label,''),'Sans pharmacie') AS store_name,p.name AS product_name,f.label AS author_name,a.label AS assignee_name
            FROM tf_cases c LEFT JOIN tf_stores s ON s.id=c.store_id LEFT JOIN tf_products p ON p.id=c.product_id JOIN tf_users f ON f.id=c.author_id LEFT JOIN tf_users a ON a.id=c.assignee_id
            WHERE ${sql.join(conds, sql` AND `)} ORDER BY c.updated_at DESC LIMIT 1001`,
      );
      return {cases: rows.slice(0, 1000), truncated: rows.length > 1000};
    }

    if (action === 'service-detail') {
      const key = uuid.parse(q.get('id'));
      // Events are only returned once caseBy has authorised the read.
      const [c, rows] = await Promise.all([
        caseBy(db(), u, key),
        all<any>(db(), sql`SELECT e.*,u.label FROM tf_case_events e JOIN tf_users u ON u.id=e.user_id WHERE case_id=${key} ORDER BY at`),
      ]);
      const events = rows.filter((e) => !e.clinical || u.role === 'doctor' || c.author_id === u.id);
      return {case: safeCase(u, c), events};
    }

    if (action === 'field-notes') {
      if (u.role === 'doctor') fail('Accès commercial non autorisé.', 403);
      const {start, end} = period(q);
      const conds = [sql`n.created_at>=${start}`, sql`n.created_at<${end}`];
      if (!manages(u)) conds.push(sql`n.author_id=${u.id}`);
      const rows = await all(
        db(),
        sql`SELECT n.*,COALESCE(s.name,NULLIF(n.store_label,''),'Sans pharmacie') AS store_name,u.label AS author_name,
             (SELECT id FROM tf_field_photos p WHERE p.note_id=n.id ORDER BY p.created_at LIMIT 1) AS photo_id,
             (SELECT COUNT(*) FROM tf_field_photos p WHERE p.note_id=n.id) AS photo_count
            FROM tf_field_notes n LEFT JOIN tf_stores s ON s.id=n.store_id JOIN tf_users u ON u.id=n.author_id
            WHERE ${sql.join(conds, sql` AND `)} ORDER BY n.created_at DESC LIMIT 1001`,
      );
      return {notes: rows.slice(0, 1000), truncated: rows.length > 1000};
    }

    if (action === 'field-note') {
      const key = uuid.parse(q.get('id'));
      // Photos are only returned once noteBy has authorised the read.
      const [n, photos] = await Promise.all([
        noteBy(db(), u, key),
        all(db(), sql`SELECT id,created_at FROM tf_field_photos WHERE note_id=${key} ORDER BY created_at`),
      ]);
      return {note: n, photos};
    }

    if (action === 'bonuses') {
      if (u.role === 'doctor') fail('Accès non autorisé.', 403);
      const today = dayInAlgerNow();
      const month = today.slice(0, 7);
      const from = Number(month.slice(0, 4)) - 1 + month.slice(4) + '-01';
      const days = sql`m.day>=${from} AND m.day<=${today}`;
      // An animatrice's strip (polled every 20 s) looks up tickets per mission of hers, so its cost follows
      // her own missions; joined directly, the planner scans every ticket ever recorded. Managers cover
      // most tickets of the 13 months, where one scan with a hash join stays cheaper.
      const rows = await all<any>(
        db(),
        manages(u)
          ? sql`SELECT m.day,COUNT(*) AS tickets,SUM(t.bonus_amount) AS bonus,SUM(t.total) AS revenue
                FROM tf_tickets t JOIN tf_missions m ON m.id=t.mission_id
                WHERE t.status='valid' AND ${days} GROUP BY m.day ORDER BY m.day`
          : sql`SELECT m.day,SUM(x.tickets) AS tickets,SUM(x.bonus) AS bonus,SUM(x.revenue) AS revenue
                FROM tf_missions m CROSS JOIN LATERAL (SELECT COUNT(*) AS tickets,SUM(t.bonus_amount) AS bonus,SUM(t.total) AS revenue
                  FROM tf_tickets t WHERE t.mission_id=m.id AND t.status='valid') x
                WHERE m.field_id=${u.id} AND ${days} AND x.tickets>0 GROUP BY m.day ORDER BY m.day`,
      );
      const months: Record<string, any> = {};
      for (const r of rows) {
        const k = r.day.slice(0, 7);
        months[k] ??= {month: k, tickets: 0, bonus: 0, revenue: 0};
        for (const p of ['tickets', 'bonus', 'revenue']) months[k][p] += r[p];
      }
      return {
        today: rows.find((r) => r.day === today) || {day: today, tickets: 0, bonus: 0, revenue: 0},
        month: months[month] || {month, tickets: 0, bonus: 0, revenue: 0},
        months: Object.values(months).sort((a: any, b: any) => b.month.localeCompare(a.month)),
        days: rows.filter((r) => r.day.startsWith(month)),
        serverTime: new Date().toISOString(),
      };
    }

    if (action === 'performance') {
      if (u.role === 'doctor') fail('Accès non autorisé.', 403);
      const {from, to} = period(q);
      const conds = [sql`m.day>=${from}`, sql`m.day<=${to}`];
      if (!manages(u)) conds.push(sql`m.field_id=${u.id}`);
      else if (q.get('person')) conds.push(sql`m.field_id=${uuid.parse(q.get('person'))}`);
      if (q.get('store')) conds.push(sql`m.store_id=${id.parse(q.get('store'))}`);
      const scope = sql.join(conds, sql` AND `);
      const base = sql`FROM tf_tickets t JOIN tf_missions m ON m.id=t.mission_id JOIN tf_users f ON f.id=m.field_id JOIN tf_stores s ON s.id=m.store_id WHERE t.status='valid' AND ${scope}`;

      const [totals, fields, stores, days, products, brands, missions] = await Promise.all([
        first<any>(db(), sql`SELECT COUNT(*) AS tickets,COALESCE(SUM(t.total),0) AS revenue,COALESCE(SUM(t.bonus_amount),0) AS bonus ${base}`),
        all<any>(db(), sql`SELECT m.field_id AS id,f.label AS name,COUNT(*) AS tickets,SUM(t.total) AS revenue,SUM(t.bonus_amount) AS bonus ${base} GROUP BY m.field_id,f.label ORDER BY tickets DESC,revenue DESC LIMIT 1001`),
        all<any>(db(), sql`SELECT m.store_id AS id,s.name,COUNT(*) AS tickets,SUM(t.total) AS revenue,SUM(t.bonus_amount) AS bonus ${base} GROUP BY m.store_id,s.name ORDER BY revenue DESC LIMIT 2001`),
        all<any>(db(), sql`SELECT m.day,COUNT(*) AS tickets,SUM(t.total) AS revenue,SUM(t.bonus_amount) AS bonus ${base} GROUP BY m.day ORDER BY m.day`),
        all<any>(db(), sql`SELECT (l.value->>'product_id') AS id,(l.value->>'name') AS name,(l.value->>'brand') AS brand,SUM((l.value->>'qty')::numeric) AS units,SUM((l.value->>'qty')::numeric*(l.value->>'unit_price')::numeric) AS revenue,COUNT(DISTINCT t.id) AS tickets
            FROM tf_tickets t JOIN tf_missions m ON m.id=t.mission_id, jsonb_array_elements(t.lines) l
            WHERE t.status='valid' AND ${scope}
            GROUP BY (l.value->>'product_id'),(l.value->>'name'),(l.value->>'brand') ORDER BY units DESC,revenue DESC LIMIT 2001`),
        all<any>(db(), sql`SELECT (l.value->>'brand') AS name,SUM((l.value->>'qty')::numeric) AS units,SUM((l.value->>'qty')::numeric*(l.value->>'unit_price')::numeric) AS revenue,COUNT(DISTINCT t.id) AS tickets
            FROM tf_tickets t JOIN tf_missions m ON m.id=t.mission_id, jsonb_array_elements(t.lines) l
            WHERE t.status='valid' AND ${scope}
            GROUP BY (l.value->>'brand') ORDER BY revenue DESC`),
        all<any>(db(), sql`SELECT m.field_id AS id,f.label AS name,COUNT(*) AS scheduled,
             SUM(CASE WHEN m.status='completed' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN m.status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
             SUM(CASE WHEN m.actual_start IS NOT NULL AND EXTRACT(EPOCH FROM (m.actual_start::timestamptz - m.start_at::timestamptz))/60 > m.late_grace_minutes+0.001 THEN 1 ELSE 0 END) AS late,
             COALESCE(SUM(CASE WHEN m.actual_end IS NOT NULL THEN GREATEST(0,EXTRACT(EPOCH FROM (m.actual_end::timestamptz - m.actual_start::timestamptz))/3600) ELSE 0 END),0) AS hours
            FROM tf_missions m JOIN tf_users f ON f.id=m.field_id WHERE ${scope} GROUP BY m.field_id,f.label LIMIT 1001`),
      ]);

      const people = new Map<string, any>();
      for (const m of missions) people.set(m.id, {...m, tickets: 0, revenue: 0, bonus: 0});
      for (const f of fields) people.set(f.id, {...(people.get(f.id) || {}), ...f});
      const team = Array.from(people.values()).sort((a, b) => b.tickets - a.tickets || b.revenue - a.revenue);
      return {
        from,
        to,
        totals: {...totals, units: brands.reduce((n: number, b: any) => n + b.units, 0)},
        people: team,
        stores: stores.slice(0, 2000),
        days,
        products: products.slice(0, 2000),
        brands,
        truncated: fields.length > 1000 || stores.length > 2000 || products.length > 2000 || missions.length > 1000,
        serverTime: new Date().toISOString(),
      };
    }

    return null;
  }

  /** Returns a response object, or null if the action is not handled here. */
  async postOperations(u: User, b: any): Promise<any | null> {
    if (b.action === 'service-create') {
      const v = z
        .object({
          action: z.literal('service-create'),
          id: uuid,
          ...contextSchema,
          kind: z.enum(['complaint', 'request']),
          reasons: z.array(txt(40)).optional(),
          // An app opened before multiple reasons sends a single one.
          reason: txt(40).optional(),
          channel: z.enum(['onsite', 'phone', 'whatsapp', 'email', 'other']),
          product_id: id.nullable(),
          lot: txt(80),
          code: z.string().regex(/^[A-Za-z0-9._-]{0,40}$/),
          priority: z.enum(['normal', 'priority']),
          description: txt(2500).min(10),
          consent: z.boolean(),
          due_day: optionalDate,
        })
        .strict()
        .parse(b);
      if (u.role === 'doctor' && v.kind !== 'complaint') fail('Les demandes commerciales sont réservées à l’équipe terrain.', 403);
      const keys = v.reasons ?? (v.reason === undefined ? [] : [v.reason]);
      // Own keys only: an inherited name such as "toString" is not a reason.
      if (!keys.length || keys.length > MAX_REASONS || new Set(keys).size < keys.length || !keys.every((k) => reasonFor(v.kind, k)))
        fail('Sélectionnez entre 1 et 3 motifs valides.');
      const category = reasonCategory(v.kind, keys);
      if (category === 'tolerance' && !v.consent) fail('La transmission anonymisée au médecin doit être acceptée.');
      return serializable(async (tx) => {
        const old = await first<any>(tx, sql`SELECT author_id FROM tf_cases WHERE id=${v.id}`);
        if (old) {
          if (old.author_id !== u.id) fail('Identifiant déjà utilisé.', 409);
          return {ok: true, duplicate: true, id: v.id};
        }
        const store = await context(tx, u, v);
        if (v.product_id && !(await first(tx, sql`SELECT id FROM tf_products WHERE id=${v.product_id}`)))
          fail('Produit introuvable.');
        const now = new Date().toISOString();
        await run(
          tx,
          sql`INSERT INTO tf_cases(id,mission_id,store_id,store_label,author_id,product_id,kind,reason,reasons,category,channel,lot,code,priority,description,consent,due_day,created_at,updated_at)
              VALUES(${v.id},${v.mission_id},${store},${v.store_label},${u.id},${v.product_id},${v.kind},${keys[0]},${keys.join(',')},${category},${v.channel},${v.lot},${v.code},${v.priority},${v.description},${+v.consent},${v.due_day},${now},${now})`,
        );
        await run(
          tx,
          sql`INSERT INTO tf_case_events(id,case_id,user_id,at,status) VALUES(${randomUUID()},${v.id},${u.id},${now},'new')`,
        );
        await run(tx, auditSql(u, 'service.created', v.id, {kind: v.kind, reasons: keys}));
        return {ok: true, id: v.id};
      });
    }

    if (b.action === 'service-update') {
      const v = z
        .object({
          action: z.literal('service-update'),
          id: uuid,
          version: z.number().int(),
          status: z.enum(['new', 'assigned', 'ongoing', 'waiting', 'resolved', 'closed']),
          assignee_id: uuid.nullable(),
          due_day: optionalDate,
          public_note: txt(2000),
          private_note: txt(4000).optional(),
        })
        .strict()
        .parse(b);
      return serializable(async (tx) => {
        const c = await caseBy(tx, u, v.id);
        if (!manages(u) && u.role !== 'doctor') fail('Suivi réservé aux responsables.', 403);
        if (c.version !== v.version) fail('Ce dossier a changé. Rouvrez-le avant de modifier.', 409);
        if (u.role !== 'doctor' && v.private_note !== undefined) fail('Note privée réservée au médecin.', 403);
        if (c.category === 'tolerance' && u.role !== 'doctor' && !['new', 'assigned'].includes(v.status) && v.status !== c.status)
          fail('Le médecin met à jour la prise en charge de tolérance.', 403);
        if (u.role === 'doctor' && v.assignee_id !== u.id) fail('Attribuez la prise en charge à votre compte.');
        if (v.assignee_id) {
          const a = await first<any>(tx, sql`SELECT role FROM tf_users WHERE id=${v.assignee_id} AND active=1`);
          const allowed = c.category === 'tolerance'
            ? a?.role === 'doctor'
            : ['admin', 'manager', ...(c.kind === 'complaint' ? ['doctor'] : [])].includes(a?.role);
          if (!a || !allowed) fail('Responsable incompatible avec ce dossier.');
        }
        const now = new Date().toISOString();
        const changed = await run(
          tx,
          sql`UPDATE tf_cases SET status=${v.status},assignee_id=${v.assignee_id},doctor_id=${c.category === 'tolerance' ? v.assignee_id : c.doctor_id},due_day=${v.due_day},public_note=${v.public_note},private_note=${u.role === 'doctor' ? v.private_note || '' : c.private_note},version=version+1,updated_at=${now} WHERE id=${c.id} AND version=${v.version}`,
        );
        if (!changed) fail('Ce dossier a changé. Rouvrez-le avant de modifier.', 409);
        await run(
          tx,
          sql`INSERT INTO tf_case_events(id,case_id,user_id,at,status,note) VALUES(${randomUUID()},${c.id},${u.id},${now},${v.status},${v.public_note})`,
        );
        await run(tx, auditSql(u, 'service.updated', c.id, {status: v.status}));
        return {ok: true};
      });
    }

    if (b.action === 'service-message') {
      const v = z
        .object({action: z.literal('service-message'), id: uuid, note: txt(2000).min(3), message_id: uuid})
        .strict()
        .parse(b);
      return serializable(async (tx) => {
        const c = await caseBy(tx, u, v.id);
        if (c.category === 'tolerance' && u.role !== 'doctor' && c.author_id !== u.id)
          fail('Complément de tolérance réservé à l’auteur et au médecin.', 403);
        const old = await first<any>(tx, sql`SELECT case_id,user_id FROM tf_case_events WHERE id=${v.message_id}`);
        if (old) {
          if (old.case_id !== c.id || old.user_id !== u.id) fail('Identifiant déjà utilisé.', 409);
          return {ok: true};
        }
        await run(
          tx,
          sql`INSERT INTO tf_case_events(id,case_id,user_id,at,status,note,clinical) VALUES(${v.message_id},${c.id},${u.id},${new Date().toISOString()},${c.status},${v.note},${+(c.category === 'tolerance')})`,
        );
        await run(tx, auditSql(u, 'service.message', c.id));
        return {ok: true};
      });
    }

    if (b.action === 'field-note-create') {
      if (u.role === 'doctor') fail('Accès non autorisé.', 403);
      const v = z
        .object({
          action: z.literal('field-note-create'),
          id: uuid,
          ...contextSchema,
          category: z.enum(['shelf', 'competitor', 'feedback', 'availability', 'opportunity', 'other']),
          product_id: id.nullable(),
          brand: z.enum(['', 'TOUCHE', 'BELNCO', 'NOOM']),
          competitor: txt(120),
          sentiment: z.enum(['positive', 'neutral', 'negative']),
          description: txt(2500).min(5),
        })
        .strict()
        .parse(b);
      return serializable(async (tx) => {
        const old = await first<any>(tx, sql`SELECT author_id FROM tf_field_notes WHERE id=${v.id}`);
        if (old) {
          if (old.author_id !== u.id) fail('Identifiant déjà utilisé.', 409);
          return {ok: true, id: v.id};
        }
        const store = await context(tx, u, v);
        if (v.product_id && !(await first(tx, sql`SELECT id FROM tf_products WHERE id=${v.product_id}`)))
          fail('Produit introuvable.');
        const now = new Date().toISOString();
        await run(
          tx,
          sql`INSERT INTO tf_field_notes(id,author_id,mission_id,store_id,store_label,category,product_id,brand,competitor,sentiment,description,created_at,updated_at)
              VALUES(${v.id},${u.id},${v.mission_id},${store},${v.store_label},${v.category},${v.product_id},${v.brand},${v.competitor},${v.sentiment},${v.description},${now},${now})`,
        );
        await run(tx, auditSql(u, 'field-note.created', v.id, {category: v.category}));
        return {ok: true, id: v.id};
      });
    }

    if (b.action === 'field-note-update') {
      if (!manages(u)) fail('Accès responsable requis.', 403);
      const v = z
        .object({
          action: z.literal('field-note-update'),
          id: uuid,
          version: z.number().int(),
          status: z.enum(['new', 'seen', 'actioned']),
          manager_note: txt(2000),
        })
        .strict()
        .parse(b);
      return serializable(async (tx) => {
        const n = await noteBy(tx, u, v.id);
        const changed = await run(
          tx,
          sql`UPDATE tf_field_notes SET status=${v.status},manager_note=${v.manager_note},version=version+1,updated_at=${new Date().toISOString()} WHERE id=${n.id} AND version=${v.version}`,
        );
        if (!changed) fail('Observation modifiée entre-temps. Rouvrez-la.', 409);
        await run(tx, auditSql(u, 'field-note.updated', n.id, {status: v.status}));
        return {ok: true};
      });
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Local helpers (ported from operations.server.ts).

async function context(ex: Exec, u: User, v: {mission_id: string | null; store_id: string | null; store_label: string}) {
  let store = v.store_id;
  if (v.mission_id) {
    const m = await first<any>(ex, sql`SELECT * FROM tf_missions WHERE id=${v.mission_id}`);
    if (!m || !canMission(u, m)) fail('Animation non accessible.', 403);
    if (store && store !== m.store_id) fail('La pharmacie ne correspond pas à cette animation.');
    store = m.store_id;
  }
  if (store) {
    const s = await first(ex, sql`SELECT id FROM tf_stores WHERE id=${store}`);
    if (!s) fail('Pharmacie introuvable.');
    if (
      u.role === 'field' &&
      !(await first(ex, sql`SELECT id FROM tf_missions WHERE store_id=${store} AND field_id=${u.id} LIMIT 1`))
    )
      fail('Pharmacie non accessible.', 403);
  }
  return store;
}

async function caseBy(ex: Exec, u: User, key: string) {
  const c = await first<any>(
    ex,
    sql`SELECT c.*,COALESCE(s.name,NULLIF(c.store_label,''),'Sans pharmacie') AS store_name,f.label AS author_name,a.label AS assignee_name
        FROM tf_cases c LEFT JOIN tf_stores s ON s.id=c.store_id JOIN tf_users f ON f.id=c.author_id LEFT JOIN tf_users a ON a.id=c.assignee_id
        WHERE c.id=${key}`,
  );
  if (!c || !canReadCase(u, c)) fail('Dossier non accessible.', 403);
  return c;
}

function dayInAlgerNow(): string {
  return new Date(new Date().getTime() + 3600000).toISOString().slice(0, 10);
}
