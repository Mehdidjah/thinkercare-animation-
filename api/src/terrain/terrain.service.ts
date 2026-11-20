import {Injectable} from '@nestjs/common';
import {z} from 'zod';
import {db} from '../db/client';
import {type Exec, first, all, run, serializable, sql} from '../db/tx';
import {fail} from '../common/errors';
import {hashNewPassword} from '../common/crypto';
import {sealPassword} from '../common/password-vault';
import {id, uuid, brand, text, date, qty} from '../common/validation';
import {mission, sales, counts, parseMission, range, auditSql, batchMission, changes} from './helpers';
import {manages, dayInAlger, shiftDay, weekStart, attendance, reportIssues, ticketTotal, soldBy, clock, type User} from '../domain/core';
import {OperationsService} from './operations.service';
import type {SQL} from 'drizzle-orm';

const iso = () => new Date().toISOString();
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

@Injectable()
export class TerrainService {
  constructor(private readonly ops: OperationsService) {}

  // =========================================================================
  // GET /api/terrain  — port of getTerrain()
  // =========================================================================
  async getTerrain(u: User, q: URLSearchParams): Promise<any> {
    const action = q.get('action') || 'bootstrap';
    if (u.force_change && action !== 'bootstrap') fail('Changez votre mot de passe initial.', 403);

    const extra = await this.ops.getOperations(u, q);
    if (extra) return extra;

    if (action === 'bootstrap') {
      if (u.force_change) return {user: u, products: [], stores: [], users: [], devices: [], limited: false, serverTime: iso()};
      const manager = manages(u);
      // Same week the Planning screen opens on, so it renders without a second round trip, along with
      // what that screen polls besides: the animatrice's bonus strip, the managers' attendance alerts.
      const from = weekStart(dayInAlger()), to = shiftDay(from, 6);
      const side = u.role === 'field' ? 'bonuses' : manager ? 'attendance-alerts' : null;
      const [p, stores, users, devices, week, extra] = await Promise.all([
        all(db(), sql`SELECT * FROM tf_products ORDER BY brand,name LIMIT 2001`),
        u.role === 'doctor' ? Promise.resolve([]) : manager
          ? all(db(), sql`SELECT * FROM tf_stores ORDER BY name LIMIT 2001`)
          : all(db(), sql`SELECT DISTINCT s.* FROM tf_stores s JOIN tf_missions m ON m.store_id=s.id WHERE m.field_id=${u.id} ORDER BY s.name LIMIT 2001`),
        manager ? all(db(), sql`SELECT id,username,label,role,active,force_change,password_ciphertext IS NOT NULL AS password_available FROM tf_users ORDER BY label LIMIT 1001`) : Promise.resolve([]),
        manager ? all(db(), sql`SELECT * FROM tf_devices ORDER BY name LIMIT 1001`) : Promise.resolve([]),
        u.role === 'doctor' ? Promise.resolve(null) : this.missions(u, from, to),
        side === 'bonuses' ? this.ops.getOperations(u, new URLSearchParams({action: side})) : side ? this.attendanceAlerts(u) : Promise.resolve(null),
      ]);
      const prefetch = {missions: {query: `action=missions&from=${from}&to=${to}`, data: week}, ...(side ? {[side]: {query: 'action=' + side, data: extra}} : {})};
      return {
        user: u,
        products: p.slice(0, 2000),
        stores: stores.slice(0, 2000),
        users: users.slice(0, 1000),
        devices: devices.slice(0, 1000),
        limited: p.length > 2000 || stores.length > 2000 || users.length > 1000 || devices.length > 1000,
        serverTime: iso(),
        ...(week ? {prefetch} : {}),
      };
    }

    if (action === 'attendance-alerts') {
      if (!manages(u)) fail('Accès gestionnaire ou direction requis.', 403);
      return this.attendanceAlerts(u);
    }

    if (action === 'missions') {
      if (u.role === 'doctor') fail('Accès aux réclamations uniquement.', 403);
      const {from, to} = range(q);
      return this.missions(u, from, to);
    }

    if (action === 'mission') {
      const m = await mission(db(), u, id.parse(q.get('id')));
      const [s, f, d, t, c, photos, prices] = await Promise.all([
        first<any>(db(), sql`SELECT * FROM tf_stores WHERE id=${m.store_id}`),
        first<any>(db(), sql`SELECT label FROM tf_users WHERE id=${m.field_id}`),
        m.device_id ? first<any>(db(), sql`SELECT name FROM tf_devices WHERE id=${m.device_id}`) : Promise.resolve(null),
        sales(db(), m.id),
        counts(db(), m.id),
        all(db(), sql`SELECT id,caption,created_at,purpose FROM tf_photos WHERE mission_id=${m.id} ORDER BY created_at`),
        all(db(), sql`SELECT product_id,unit_price FROM tf_store_prices WHERE store_id=${m.store_id}`),
      ]);
      return {mission: m, store: s, fieldName: f?.label, deviceName: d?.name, tickets: t, counts: c, photos, prices, serverTime: iso()};
    }

    if (action === 'stocks') {
      if (u.role === 'doctor') fail('Accès non autorisé.', 403);
      const store = id.parse(q.get('store'));
      if (
        !manages(u) &&
        !(await first(db(), sql`SELECT id FROM tf_missions WHERE store_id=${store} AND field_id=${u.id} LIMIT 1`))
      )
        fail('Point de vente non accessible.', 403);
      const r = await all(
        db(),
        sql`SELECT * FROM (
              SELECT c.*,p.name AS product_name,p.brand,p.unit,m.day,m.actual_end,
                ROW_NUMBER() OVER(PARTITION BY c.product_id ORDER BY m.actual_end DESC,c.updated_at DESC) AS rn
              FROM tf_counts c JOIN tf_missions m ON m.id=c.mission_id JOIN tf_products p ON p.id=c.product_id
              WHERE m.store_id=${store} AND m.status='completed' AND c.closing IS NOT NULL
            ) sub WHERE rn=1 ORDER BY brand,product_name`,
      );
      return {stocks: r};
    }

    if (action === 'reports') {
      if (u.role === 'doctor') fail('Accès non autorisé.', 403);
      const {from, to} = range(q);
      const conds = [sql`m.day>=${from}`, sql`m.day<=${to}`];
      if (!manages(u)) conds.push(sql`m.field_id=${u.id}`);
      // Refuse an oversized range before building and sending 20,000 rows the UI would discard.
      // Each report row needs at least one ticket line, so the cheap line count bounds it.
      const where = sql.join(conds, sql` AND `);
      const bound = await first<any>(
        db(),
        sql`SELECT COALESCE(SUM(jsonb_array_length(t.lines)),0) AS n FROM tf_tickets t JOIN tf_missions m ON m.id=t.mission_id WHERE t.status='valid' AND ${where}`,
      );
      if (bound.n > 20000) {
        const exact = await first<any>(
          db(),
          sql`SELECT COUNT(*) AS n FROM (SELECT 1 FROM tf_tickets t JOIN tf_missions m ON m.id=t.mission_id, jsonb_array_elements(t.lines) l
              WHERE t.status='valid' AND ${where}
              GROUP BY m.id,(l.value->>'product_id'),(l.value->>'name'),(l.value->>'brand') LIMIT 20001) g`,
        );
        if (exact.n > 20000) return {lines: [], truncated: true, from, to};
      }
      const lines = await all(
        db(),
        sql`SELECT m.id AS mission_id,m.day,m.field_id,f.label AS field_name,s.id AS store_id,s.name AS store_name,
             (l.value->>'brand') AS brand,(l.value->>'product_id') AS product_id,(l.value->>'name') AS name,
             SUM((l.value->>'qty')::numeric) AS units,
             SUM((l.value->>'qty')::numeric*(l.value->>'unit_price')::numeric) AS amount,
             COUNT(DISTINCT t.id) AS tickets
            FROM tf_tickets t JOIN tf_missions m ON m.id=t.mission_id JOIN tf_stores s ON s.id=m.store_id JOIN tf_users f ON f.id=m.field_id, jsonb_array_elements(t.lines) l
            WHERE t.status='valid' AND ${sql.join(conds, sql` AND `)}
            GROUP BY m.id,m.day,m.field_id,f.label,s.id,s.name,(l.value->>'product_id'),(l.value->>'name'),(l.value->>'brand')
            ORDER BY m.day DESC LIMIT 20001`,
      );
      return {lines: lines.slice(0, 20000), truncated: lines.length > 20000, from, to};
    }

    if (action === 'complaints') {
      const {from, to} = range(q);
      const start = new Date(from + 'T00:00:00+01:00').toISOString();
      const end = new Date(Date.parse(to + 'T00:00:00+01:00') + 86400000).toISOString();
      const conds = [sql`c.created_at>=${start}`, sql`c.created_at<${end}`];
      if (u.role === 'field') conds.push(sql`c.author_id=${u.id}`);
      const r = await all(
        db(),
        sql`SELECT c.id,c.mission_id,c.author_id,c.category,c.product_id,c.lot,c.code,c.status,c.priority,c.doctor_id,c.version,c.created_at,c.updated_at,c.public_note,s.name AS store_name,p.name AS product_name,f.label AS author_name,dr.label AS doctor_name
            FROM tf_complaints c JOIN tf_missions m ON m.id=c.mission_id JOIN tf_stores s ON s.id=m.store_id JOIN tf_users f ON f.id=c.author_id LEFT JOIN tf_products p ON p.id=c.product_id LEFT JOIN tf_users dr ON dr.id=c.doctor_id
            WHERE ${sql.join(conds, sql` AND `)} ORDER BY c.updated_at DESC LIMIT 1001`,
      );
      return {complaints: r.slice(0, 1000), truncated: r.length > 1000};
    }

    if (action === 'complaint') {
      const c = await first<any>(db(), sql`SELECT * FROM tf_complaints WHERE id=${uuid.parse(q.get('id'))}`);
      if (!c || (u.role === 'field' && c.author_id !== u.id)) fail('Réclamation non accessible.', 403);
      const {private_note, description, ...safe} = c;
      return {
        complaint: {
          ...safe,
          ...(u.role === 'doctor'
            ? {private_note, description}
            : c.author_id === u.id || (manages(u) && c.category !== 'tolerance')
              ? {description}
              : {}),
        },
      };
    }

    if (action === 'audit') {
      if (u.role !== 'admin') fail('Accès direction requis.', 403);
      // detail cast to text to preserve the original JSON-in-TEXT wire shape
      // (the UI renders a.detail directly as a string).
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const r = await all(
        db(),
        sql`SELECT a.id,a.at,a.action,a.target,a.detail::text AS detail,u.label FROM tf_audit a LEFT JOIN tf_users u ON u.id=a.user_id
            WHERE a.at>=${since} ORDER BY a.at DESC LIMIT 5001`,
      );
      return {events: r.slice(0, 5000), truncated: r.length > 5000};
    }

    fail('Action inconnue.', 404);
  }

  /** Attendance alerts for a manager, exactly as GET action=attendance-alerts returns them (also prefetched by bootstrap). */
  private async attendanceAlerts(u: User) {
    const now = iso();
    const today = dayInAlger(now);
    // Missions still open are kept past the 8-day window: a forgotten check-out stays visible until closed.
    const r = await all<any>(
      db(),
      sql`SELECT m.*,s.name AS store_name,f.label AS field_name,
           ARRAY(SELECT k.kind FROM tf_alert_ack k WHERE k.user_id=${u.id} AND k.mission_id=m.id) AS acked
          FROM tf_missions m JOIN tf_stores s ON s.id=m.store_id JOIN tf_users f ON f.id=m.field_id
          WHERE (m.day>=${shiftDay(today, -7)} AND m.day<=${today} OR m.status='ongoing') AND m.status<>'cancelled' AND f.active=1
          ORDER BY m.start_at DESC LIMIT 1001`,
    );
    const alerts = r.slice(0, 1000).flatMap((m) => {
      const x = attendance(m, now);
      return x
        ? [
            {
              id: m.id + ':' + x.kind,
              mission_id: m.id,
              store_name: m.store_name,
              field_name: m.field_name,
              day: m.day,
              start_at: m.start_at,
              end_at: m.end_at,
              actual_start: m.actual_start,
              start_photo_id: m.start_photo_id,
              ...x,
              acknowledged: m.acked.includes(x.kind),
            },
          ]
        : [];
    });
    return {alerts, truncated: r.length > 1000, serverTime: now};
  }

  /** Week/range planning rows, exactly as GET action=missions returns them (also used for the bootstrap prefetch). */
  private async missions(u: User, from: string, to: string) {
    const conds = [sql`m.day>=${from}`, sql`m.day<=${to}`];
    if (!manages(u)) conds.push(sql`m.field_id=${u.id}`);
    const r = await all<any>(
      db(),
      sql`SELECT m.*,s.name AS store_name,s.city,s.address,f.label AS field_name,d.name AS device_name,
           (SELECT COALESCE(SUM(total),0) FROM tf_tickets t WHERE t.mission_id=m.id AND t.status='valid') AS sales_total,
           (SELECT COUNT(*) FROM tf_tickets t WHERE t.mission_id=m.id AND t.status='valid') AS tickets,
           (SELECT COALESCE(SUM((l.value->>'qty')::numeric),0) FROM tf_tickets t, jsonb_array_elements(t.lines) l WHERE t.mission_id=m.id AND t.status='valid') AS units
          FROM tf_missions m JOIN tf_stores s ON s.id=m.store_id JOIN tf_users f ON f.id=m.field_id LEFT JOIN tf_devices d ON d.id=m.device_id
          WHERE ${sql.join(conds, sql` AND `)} ORDER BY m.start_at LIMIT 2001`,
    );
    return {missions: r.slice(0, 2000).map(parseMission), truncated: r.length > 2000, serverTime: iso()};
  }

  // =========================================================================
  // POST /api/terrain  — port of postTerrain() (authed section; login/logout/
  // password handled by AuthService in the controller before this runs).
  // =========================================================================
  async postTerrain(u: User, b: any): Promise<any> {
    const extra = await this.ops.postOperations(u, b);
    if (extra) return extra;

    if (['complaint', 'case-update'].includes(b.action))
      fail('Le suivi a été mis à jour. Actualisez la page avant de continuer.', 409);

    if (b.action === 'ack-attendance') {
      if (!manages(u)) fail('Accès gestionnaire ou direction requis.', 403);
      const v = z.object({action: z.literal('ack-attendance'), id: uuid, kind: z.enum(['missing_start', 'late_start', 'missing_end'])}).strict().parse(b);
      const m = await mission(db(), u, v.id);
      const a = attendance(m);
      if (!a || a.kind !== v.kind) fail('Cette alerte a changé. Actualisez la liste.', 409);
      const now = iso();
      await serializable(async (tx) => {
        await run(
          tx,
          sql`INSERT INTO tf_alert_ack(user_id,mission_id,kind,ack_at) VALUES(${u.id},${m.id},${v.kind},${now})
              ON CONFLICT(user_id,mission_id,kind) DO UPDATE SET ack_at=excluded.ack_at`,
        );
        await run(tx, auditSql(u, 'attendance.seen', m.id, {kind: v.kind}));
      });
      return {ok: true};
    }

    if (b.action === 'user') {
      if (u.role !== 'admin') fail('Accès direction requis.', 403);
      const v = z
        .object({
          action: z.literal('user'),
          id: uuid,
          username: z.string().regex(/^[a-z0-9._-]{3,40}$/),
          label: text(80).min(2),
          role: z.enum(['manager', 'field', 'doctor']),
          active: z.boolean(),
          password: z.string().min(1).max(200).optional(),
        })
        .strict()
        .parse(b);
      const old = await first<any>(db(), sql`SELECT username,label,role,active FROM tf_users WHERE id=${v.id}`);
      if (old?.role === 'admin') fail('Le compte direction se gère séparément.');
      if (old && old.username !== v.username) fail('L’identifiant d’un compte existant ne peut pas être modifié.');
      if (old && old.role !== v.role) fail('Ne changez pas le rôle d’un compte existant : désactivez-le et créez un compte nominatif distinct.');
      if (!old && !v.password) fail('Mot de passe initial requis.');
      const sealed = v.password ? sealPassword(v.id, v.password) : null;
      // Hash off the event loop, before the transaction opens.
      const {salt, hash} = v.password ? await hashNewPassword(v.password) : {salt: null, hash: null};
      await serializable(async (tx) => {
        if (!old) {
          await run(
            tx,
            sql`INSERT INTO tf_users(id,username,label,role,active,salt,password_hash,password_ciphertext,created_at)
                VALUES(${v.id},${v.username},${v.label},${v.role},${+v.active},${salt},${hash},${sealed},${iso()})`,
          );
        } else {
          await run(tx, sql`UPDATE tf_users SET label=${v.label},active=${+v.active} WHERE id=${v.id}`);
          if (v.password)
            await run(tx, sql`UPDATE tf_users SET salt=${salt},password_hash=${hash},password_ciphertext=${sealed},force_change=1 WHERE id=${v.id}`);
          if (!v.active || v.password) await run(tx, sql`DELETE FROM tf_sessions WHERE user_id=${v.id}`);
        }
        await run(
          tx,
          auditSql(u, 'account.updated', v.id, {
            role: v.role,
            active: v.active,
            password_reset: !!old && !!v.password,
            changes: changes(old, {username: v.username, label: v.label, role: v.role, active: +v.active}),
          }),
        );
      });
      // Deactivation keeps her visits (attendance alerts skip inactive staff): they are
      // returned so the admin reassigns, cancels or closes each one from the planning.
      const pending =
        old?.active && !v.active
          ? await all<any>(
              db(),
              sql`SELECT m.id,m.day,m.status,s.name AS store_name FROM tf_missions m JOIN tf_stores s ON s.id=m.store_id
                  WHERE m.field_id=${v.id} AND (m.status='planned' AND m.day>=${dayInAlger()} OR m.status='ongoing')
                  ORDER BY m.day,m.start_at LIMIT 100`,
            )
          : [];
      return {ok: true, pending};
    }

    if (['store', 'product', 'device', 'schedule', 'cancel', 'close-mission', 'review'].includes(b.action) && !manages(u))
      fail('Accès gestionnaire ou direction requis.', 403);

    if (b.action === 'store') {
      const v = z
        .object({
          action: z.literal('store'),
          id: uuid,
          name: text(150).min(2),
          kind: z.enum(['pharmacy', 'beauty', 'wholesale', 'other']),
          city: text(80).min(2),
          address: text(400).min(3),
          contact: text(150),
          notes: text(),
          active: z.boolean(),
        })
        .strict()
        .parse(b);
      await serializable(async (tx) => {
        const old = await first<any>(tx, sql`SELECT name,kind,city,address,contact,notes,active FROM tf_stores WHERE id=${v.id}`);
        await run(
          tx,
          sql`INSERT INTO tf_stores(id,name,kind,city,address,contact,notes,active) VALUES(${v.id},${v.name},${v.kind},${v.city},${v.address},${v.contact},${v.notes},${+v.active})
              ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,city=excluded.city,address=excluded.address,contact=excluded.contact,notes=excluded.notes,active=excluded.active`,
        );
        const next = {name: v.name, kind: v.kind, city: v.city, address: v.address, contact: v.contact, notes: v.notes, active: +v.active};
        await run(tx, auditSql(u, 'store.updated', v.id, {changes: changes(old, next)}));
      });
      return {ok: true};
    }

    if (b.action === 'device') {
      const v = z
        .object({action: z.literal('device'), id: uuid, name: text(100).min(2), location: text(200), active: z.boolean()})
        .strict()
        .parse(b);
      await serializable(async (tx) => {
        const old = await first<any>(tx, sql`SELECT name,location,active FROM tf_devices WHERE id=${v.id}`);
        await run(
          tx,
          sql`INSERT INTO tf_devices(id,name,location,active) VALUES(${v.id},${v.name},${v.location},${+v.active})
              ON CONFLICT(id) DO UPDATE SET name=excluded.name,location=excluded.location,active=excluded.active`,
        );
        await run(tx, auditSql(u, 'device.updated', v.id, {changes: changes(old, {name: v.name, location: v.location, active: +v.active})}));
      });
      return {ok: true};
    }

    if (b.action === 'product') {
      const v = z
        .object({
          action: z.literal('product'),
          id,
          brand,
          sku: text(60).min(1),
          name: text(160).min(2),
          unit: z.enum(['pièce', 'pack']),
          price_hint: z.number().int().min(0).max(10000000),
          active: z.boolean(),
        })
        .strict()
        .parse(b);
      await serializable(async (tx) => {
        const old = await first<any>(tx, sql`SELECT brand,sku,name,unit,price_hint,active FROM tf_products WHERE id=${v.id}`);
        if (old && old.brand !== v.brand) fail('La marque historique ne peut pas être changée.');
        await run(
          tx,
          sql`INSERT INTO tf_products(id,brand,sku,name,unit,price_hint,active) VALUES(${v.id},${v.brand},${v.sku},${v.name},${v.unit},${v.price_hint},${+v.active})
              ON CONFLICT(id) DO UPDATE SET sku=excluded.sku,name=excluded.name,unit=excluded.unit,price_hint=excluded.price_hint,active=excluded.active`,
        );
        const next = {brand: v.brand, sku: v.sku, name: v.name, unit: v.unit, price_hint: v.price_hint, active: +v.active};
        await run(tx, auditSql(u, 'product.updated', v.id, {changes: changes(old, next)}));
      });
      return {ok: true};
    }

    if (b.action === 'schedule') {
      const v = z
        .object({
          action: z.literal('schedule'),
          id: uuid,
          store_id: uuid,
          field_id: uuid,
          day: date,
          start: HHMM,
          end: HHMM,
          brands: z.array(brand).min(1).max(3),
          device_id: uuid.nullable(),
          device_location: text(250),
          instructions: text(),
          late_grace_minutes: z.number().int().min(0).max(120).default(15),
          version: z.number().int().optional(),
        })
        .strict()
        .parse(b);
      if (v.start >= v.end) fail('La fin doit être après le début, le même jour.');
      if (new Set(v.brands).size !== v.brands.length) fail('Marques dupliquées.');
      if (v.device_id && !v.device_location) fail('Indiquez le lieu d’installation du Dermoscan.');
      const [f, s, d, old] = await Promise.all([
        first(db(), sql`SELECT id FROM tf_users WHERE id=${v.field_id} AND role='field' AND active=1`),
        first(db(), sql`SELECT id FROM tf_stores WHERE id=${v.store_id} AND active=1`),
        v.device_id ? first(db(), sql`SELECT id FROM tf_devices WHERE id=${v.device_id} AND active=1`) : Promise.resolve(true),
        first<any>(db(), sql`SELECT * FROM tf_missions WHERE id=${v.id}`),
      ]);
      if (!f || !s) fail('Sélectionnez une animatrice et un point de vente actifs.');
      if (!d) fail('Dermoscan indisponible.');
      const start = new Date(v.day + 'T' + v.start + ':00+01:00').toISOString();
      const end = new Date(v.day + 'T' + v.end + ':00+01:00').toISOString();
      if (old) {
        if (old.status !== 'planned' || old.version !== v.version) fail('L’animation a changé ou a déjà commencé.', 409);
        const next = {store_id: v.store_id, field_id: v.field_id, day: v.day, start_at: start, end_at: end, brands: v.brands, device_id: v.device_id, late_grace_minutes: v.late_grace_minutes};
        await batchMission(
          u,
          old,
          'mission.rescheduled',
          [
            sql`UPDATE tf_missions SET store_id=${v.store_id},field_id=${v.field_id},day=${v.day},start_at=${start},end_at=${end},brands=${JSON.stringify(v.brands)}::jsonb,device_id=${v.device_id},device_location=${v.device_location},instructions=${v.instructions},late_grace_minutes=${v.late_grace_minutes} WHERE id=${v.id}`,
          ],
          {changes: changes(old, next)},
        );
      } else {
        await serializable(async (tx) => {
          await run(
            tx,
            sql`INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,device_id,device_location,instructions,late_grace_minutes,created_by,updated_at)
                VALUES(${v.id},${v.store_id},${v.field_id},${v.day},${start},${end},${JSON.stringify(v.brands)}::jsonb,${v.device_id},${v.device_location},${v.instructions},${v.late_grace_minutes},${u.id},${iso()})`,
          );
          await run(tx, auditSql(u, 'mission.created', v.id));
        });
      }
      return {ok: true, id: v.id};
    }

    if (b.action === 'clock') fail('Ajoutez la photo du lieu avec le bouton de pointage.', 400);

    if (b.action === 'cancel') {
      const v = z.object({action: z.literal('cancel'), id: uuid, reason: text().min(5)}).strict().parse(b);
      const m = await mission(db(), u, v.id);
      if (m.status !== 'planned') fail('Seule une animation non commencée peut être annulée.');
      await batchMission(
        u,
        m,
        'mission.cancelled',
        [sql`UPDATE tf_missions SET status='cancelled',cancel_reason=${v.reason} WHERE id=${m.id}`],
        {reason: v.reason},
      );
      return {ok: true};
    }

    if (b.action === 'close-mission') {
      const v = z.object({action: z.literal('close-mission'), id: uuid, end: HHMM, reason: text().min(5)}).strict().parse(b);
      const m = await mission(db(), u, v.id);
      if (!['ongoing', 'completed'].includes(m.status)) fail('Seule une animation commencée peut être clôturée.');
      // Same Alger-time conversion as scheduling: the departure is on the mission day.
      const end = new Date(m.day + 'T' + v.end + ':00+01:00').toISOString();
      if (!m.actual_start || Date.parse(end) <= Date.parse(m.actual_start)) fail('L’heure de départ doit suivre l’heure d’arrivée pointée.');
      if (m.midway_at && Date.parse(end) <= Date.parse(m.midway_at)) fail('L’heure de départ doit suivre la photo du milieu (' + clock(m.midway_at) + ').');
      if (Date.parse(end) > Date.now()) fail('L’heure de départ ne peut pas être dans le futur.');
      await batchMission(
        u,
        m,
        m.status === 'ongoing' ? 'mission.closed_by_manager' : 'mission.end_corrected',
        [sql`UPDATE tf_missions SET status='completed',actual_end=${end} WHERE id=${m.id}`],
        {reason: v.reason, end, previous_end: m.actual_end},
      );
      return {ok: true};
    }

    if (b.action === 'stock-batch') {
      const v = z
        .object({
          action: z.literal('stock-batch'),
          mission_id: uuid,
          version: z.number().int(),
          mode: z.enum(['opening', 'closing']),
          rows: z.array(z.object({product_id: id, quantity: qty, note: text().optional()}).strict()).min(1).max(150),
        })
        .strict()
        .parse(b);
      const m = await mission(db(), u, v.mission_id, true);
      if (m.version !== v.version) fail('L’animation a changé. Fermez puis rouvrez le stock pour actualiser.', 409);
      if (new Set(v.rows.map((r) => r.product_id)).size !== v.rows.length) fail('Référence répétée.');
      const [cs, ts, ps] = await Promise.all([
        counts(db(), m.id),
        sales(db(), m.id),
        all<any>(db(), sql`SELECT id,brand FROM tf_products WHERE active=1`),
      ]);
      const sold = soldBy(ts);
      for (const r of v.rows) {
        const p = ps.find((x) => x.id === r.product_id);
        const old = cs.find((c) => c.product_id === r.product_id);
        if (!p || !m.brands.includes(p.brand)) fail('Produit non autorisé pour cette animation.');
        if (v.mode === 'closing') {
          if (!old) fail('Renseignez le stock de départ avant le comptage final.');
        } else if (r.quantity + (old?.received || 0) - (old?.other_out || 0) < (sold[r.product_id] || 0))
          fail('Stock de départ inférieur aux ventes : ' + r.product_id);
      }
      // One set-based statement for the whole sheet; the row-level triggers still fire per row.
      const at = iso();
      const rows = sql`jsonb_to_recordset(${JSON.stringify(v.rows)}::jsonb) AS r(product_id text,quantity int,note text)`;
      const write =
        v.mode === 'opening'
          ? sql`INSERT INTO tf_counts(mission_id,product_id,opening,updated_by,updated_at) SELECT ${m.id},r.product_id,r.quantity,${u.id},${at} FROM ${rows}
                ON CONFLICT(mission_id,product_id) DO UPDATE SET opening=excluded.opening,updated_by=excluded.updated_by,updated_at=excluded.updated_at`
          : sql`UPDATE tf_counts c SET closing=r.quantity,note=COALESCE(r.note,c.note),updated_by=${u.id},updated_at=${at} FROM ${rows}
                WHERE c.mission_id=${m.id} AND c.product_id=r.product_id`;
      await batchMission(u, m, 'stock.batch', [write], {mode: v.mode, products: v.rows.length});
      return {ok: true};
    }

    if (b.action === 'count') {
      const v = z
        .object({
          action: z.literal('count'),
          mission_id: uuid,
          product_id: id,
          opening: qty,
          received: qty,
          other_out: qty,
          closing: qty.nullable(),
          damaged: qty,
          expiring: qty,
          expiry: z.union([z.literal(''), date]),
          note: text(),
          previous: z.string().nullable(),
        })
        .strict()
        .parse(b);
      const m = await mission(db(), u, v.mission_id, true);
      const [p, old, ts] = await Promise.all([
        first<any>(db(), sql`SELECT * FROM tf_products WHERE id=${v.product_id} AND active=1`),
        first<any>(db(), sql`SELECT updated_at FROM tf_counts WHERE mission_id=${m.id} AND product_id=${v.product_id}`),
        sales(db(), m.id),
      ]);
      if (!p || !m.brands.includes(p.brand)) fail('Référence absente des marques de cette animation.');
      if (v.expiring > 0 && !v.expiry) fail('Date d’expiration la plus proche requise.');
      if (v.other_out > 0 && !v.note) fail('Expliquez les sorties hors ventes.');
      if ((old?.updated_at || null) !== v.previous) fail('Comptage modifié entre-temps. Rechargez la fiche.', 409);
      const sold = soldBy(ts)[v.product_id] || 0;
      if (v.opening + v.received - v.other_out < sold) fail('Le disponible déclaré est inférieur aux ventes déjà saisies.');
      await batchMission(
        u,
        m,
        'stock.counted',
        [
          sql`INSERT INTO tf_counts(mission_id,product_id,opening,received,other_out,closing,damaged,expiring,expiry,note,updated_by,updated_at)
              VALUES(${m.id},${v.product_id},${v.opening},${v.received},${v.other_out},${v.closing},${v.damaged},${v.expiring},${v.expiry},${v.note},${u.id},${iso()})
              ON CONFLICT(mission_id,product_id) DO UPDATE SET opening=excluded.opening,received=excluded.received,other_out=excluded.other_out,closing=excluded.closing,damaged=excluded.damaged,expiring=excluded.expiring,expiry=excluded.expiry,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
        ],
        {product: v.product_id},
      );
      return {ok: true};
    }

    if (b.action === 'sale') {
      const v = z
        .object({
          action: z.literal('sale'),
          id: uuid,
          mission_id: uuid,
          lines: z
            .array(z.object({product_id: id, qty: qty.refine((n) => n > 0), unit_price: z.number().int().min(1).max(10000000)}).strict())
            .min(1)
            .max(30),
        })
        .strict()
        .parse(b);
      const m = await mission(db(), u, v.mission_id, true);
      if (new Set(v.lines.map((x) => x.product_id)).size !== v.lines.length)
        fail('Regroupez les quantités de la même référence sur une ligne.');
      const [old, ps] = await Promise.all([
        first<any>(db(), sql`SELECT user_id,mission_id,lines FROM tf_tickets WHERE id=${v.id}`),
        all<any>(db(), sql`SELECT * FROM tf_products WHERE active=1`),
      ]);
      if (old) {
        const sameLines =
          JSON.stringify((old.lines as any[]).map((l) => ({product_id: l.product_id, qty: l.qty, unit_price: l.unit_price}))) ===
          JSON.stringify(v.lines);
        if (old.user_id !== u.id || old.mission_id !== m.id || !sameLines)
          fail('Identifiant déjà utilisé pour une autre saisie.', 409);
        return {ok: true, duplicate: true};
      }
      const lines = v.lines.map((l) => {
        const p = ps.find((x) => x.id === l.product_id);
        if (!p || !m.brands.includes(p.brand)) fail('Produit non autorisé pour cette animation.');
        return {...l, name: p.name, brand: p.brand, unit: p.unit};
      });
      const total = ticketTotal(lines);
      if (!Number.isSafeInteger(total) || total > 1000000000) fail('Montant trop élevé.');
      const now = iso();
      // The remembered prices carry the ticket's created_at: void-sale relies on it to find what this sale set.
      const writes: SQL[] = [
        sql`INSERT INTO tf_tickets(id,mission_id,user_id,created_at,lines,total) VALUES(${v.id},${m.id},${u.id},${now},${JSON.stringify(lines)}::jsonb,${total})`,
        sql`INSERT INTO tf_store_prices(store_id,product_id,unit_price,updated_at)
            SELECT ${m.store_id},l.product_id,l.unit_price,${now} FROM jsonb_to_recordset(${JSON.stringify(v.lines)}::jsonb) AS l(product_id text,unit_price int)
            ON CONFLICT(store_id,product_id) DO UPDATE SET unit_price=excluded.unit_price,updated_at=excluded.updated_at`,
      ];
      await batchMission(u, m, 'sale.recorded', writes, {ticket: v.id, total});
      return {ok: true};
    }

    if (b.action === 'void-sale') {
      if (!manages(u)) fail('Correction réservée à la gestionnaire.', 403);
      const v = z.object({action: z.literal('void-sale'), id: uuid, reason: text().min(5)}).strict().parse(b);
      const t = await first<any>(db(), sql`SELECT * FROM tf_tickets WHERE id=${v.id}`);
      if (!t) fail('Vente introuvable.');
      const m = await mission(db(), u, t.mission_id, true);
      if (t.status === 'void') return {ok: true};
      await batchMission(
        u,
        m,
        'sale.voided',
        [
          sql`UPDATE tf_tickets SET status='void',void_reason=${v.reason} WHERE id=${v.id}`,
          // A remembered price still stamped with this ticket's created_at was set by it: take it back to the
          // latest remaining valid sale of that product in this store, or forget it when there is none
          // (the next sale then proposes the catalogue price).
          sql`UPDATE tf_store_prices sp SET unit_price=r.unit_price,updated_at=r.created_at
              FROM (SELECT DISTINCT ON (l.value->>'product_id') (l.value->>'product_id') AS product_id,(l.value->>'unit_price')::int AS unit_price,t.created_at
                    FROM tf_tickets t JOIN tf_missions x ON x.id=t.mission_id, jsonb_array_elements(t.lines) l
                    WHERE x.store_id=${m.store_id} AND t.status='valid'
                    ORDER BY (l.value->>'product_id'),t.created_at DESC) r
              WHERE sp.store_id=${m.store_id} AND sp.product_id=r.product_id AND sp.updated_at=${t.created_at}
                AND sp.product_id IN (SELECT l.value->>'product_id' FROM jsonb_array_elements(${JSON.stringify(t.lines)}::jsonb) l)`,
          sql`DELETE FROM tf_store_prices sp
              WHERE sp.store_id=${m.store_id} AND sp.updated_at=${t.created_at}
                AND sp.product_id IN (SELECT l.value->>'product_id' FROM jsonb_array_elements(${JSON.stringify(t.lines)}::jsonb) l)
                AND NOT EXISTS (SELECT 1 FROM tf_tickets v JOIN tf_missions x ON x.id=v.mission_id, jsonb_array_elements(v.lines) l
                                WHERE x.store_id=${m.store_id} AND v.status='valid' AND l.value->>'product_id'=sp.product_id)`,
        ],
        {ticket: v.id, reason: v.reason},
      );
      return {ok: true};
    }

    if (b.action === 'submit') {
      const v = z.object({action: z.literal('submit'), id: uuid, notes: text(2000), no_sales: z.boolean()}).strict().parse(b);
      const m = await mission(db(), u, v.id, true);
      if (m.status !== 'completed' || !m.actual_start || !m.actual_end) fail('Pointez le début et la fin avant de soumettre.');
      const [cs, ts] = await Promise.all([counts(db(), m.id), sales(db(), m.id)]);
      const issues = reportIssues(cs, ts, v.no_sales);
      if (issues.length) fail(issues.join(' '));
      await batchMission(u, m, 'report.submitted', [
        sql`UPDATE tf_missions SET report_status='submitted',report_notes=${v.notes},no_sales=${+v.no_sales} WHERE id=${m.id}`,
      ]);
      return {ok: true};
    }

    if (b.action === 'review') {
      const v = z
        .object({action: z.literal('review'), id: uuid, decision: z.enum(['approved', 'changes']), note: text(2000)})
        .strict()
        .parse(b);
      const m = await mission(db(), u, v.id);
      if (m.status !== 'completed' || !['submitted', 'approved'].includes(m.report_status)) fail('Rapport non soumis.');
      if (v.decision === 'changes' && v.note.length < 5) fail('Expliquez les corrections demandées.');
      await batchMission(
        u,
        m,
        'report.' + v.decision,
        [sql`UPDATE tf_missions SET report_status=${v.decision},review_note=${v.note} WHERE id=${m.id}`],
        {note: v.note},
      );
      return {ok: true};
    }

    fail('Action inconnue.', 404);
  }
}
