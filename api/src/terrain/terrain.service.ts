import {Injectable} from '@nestjs/common';
import {z} from 'zod';
import {db} from '../db/client';
import {type Exec, first, all, run, serializable, sql} from '../db/tx';
import {fail} from '../common/errors';
import {passwordHash, randomSalt} from '../common/crypto';
import {sealPassword} from '../common/password-vault';
import {id, uuid, brand, text, date, qty} from '../common/validation';
import {mission, sales, counts, parseMission, range, auditSql, batchMission} from './helpers';
import {manages, dayInAlger, shiftDay, attendance, reportIssues, ticketTotal, type User} from '../domain/core';
import {OperationsService} from './operations.service';
import type {SQL} from 'drizzle-orm';

const iso = () => new Date().toISOString();

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
      const [p, stores, users, devices] = await Promise.all([
        all(db(), sql`SELECT * FROM tf_products ORDER BY brand,name LIMIT 2001`),
        u.role === 'doctor' ? Promise.resolve([]) : manager
          ? all(db(), sql`SELECT * FROM tf_stores ORDER BY name LIMIT 2001`)
          : all(db(), sql`SELECT DISTINCT s.* FROM tf_stores s JOIN tf_missions m ON m.store_id=s.id WHERE m.field_id=${u.id} ORDER BY s.name LIMIT 2001`),
        manager ? all(db(), sql`SELECT id,username,label,role,active,force_change,password_ciphertext IS NOT NULL AS password_available FROM tf_users ORDER BY label LIMIT 1001`) : Promise.resolve([]),
        manager ? all(db(), sql`SELECT * FROM tf_devices ORDER BY name LIMIT 1001`) : Promise.resolve([]),
      ]);
      return {
        user: u,
        products: p,
        stores,
        users,
        devices,
        limited: p.length > 2000 || stores.length > 2000 || users.length > 1000 || devices.length > 1000,
        serverTime: iso(),
      };
    }

    if (action === 'attendance-alerts') {
      if (!manages(u)) fail('Accès gestionnaire ou direction requis.', 403);
      const now = iso();
      const today = dayInAlger(now);
      const r = await all<any>(
        db(),
        sql`SELECT m.*,s.name AS store_name,f.label AS field_name FROM tf_missions m JOIN tf_stores s ON s.id=m.store_id JOIN tf_users f ON f.id=m.field_id
            WHERE m.day>=${shiftDay(today, -7)} AND m.day<=${today} AND m.status<>'cancelled' ORDER BY m.start_at DESC LIMIT 1001`,
      );
      const a = await all<any>(db(), sql`SELECT mission_id,kind,ack_at FROM tf_alert_ack WHERE user_id=${u.id}`);
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
                actual_start: m.actual_start,
                start_photo_id: m.start_photo_id,
                ...x,
                acknowledged: a.some((k) => k.mission_id === m.id && k.kind === x.kind),
              },
            ]
          : [];
      });
      return {alerts, truncated: r.length > 1000, serverTime: now};
    }

    if (action === 'missions') {
      if (u.role === 'doctor') fail('Accès aux réclamations uniquement.', 403);
      const {from, to} = range(q);
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

    if (action === 'mission') {
      const m = await mission(db(), u, id.parse(q.get('id')));
      const [s, f, d, t, c, photos] = await Promise.all([
        first<any>(db(), sql`SELECT * FROM tf_stores WHERE id=${m.store_id}`),
        first<any>(db(), sql`SELECT label FROM tf_users WHERE id=${m.field_id}`),
        m.device_id ? first<any>(db(), sql`SELECT name FROM tf_devices WHERE id=${m.device_id}`) : Promise.resolve(null),
        sales(db(), m.id),
        counts(db(), m.id),
        all(db(), sql`SELECT id,caption,created_at,purpose FROM tf_photos WHERE mission_id=${m.id} ORDER BY created_at`),
      ]);
      const prices = await all(db(), sql`SELECT product_id,unit_price FROM tf_store_prices WHERE store_id=${m.store_id}`);
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
      const r = await all(
        db(),
        sql`SELECT a.id,a.at,a.action,a.target,a.detail::text AS detail,u.label FROM tf_audit a LEFT JOIN tf_users u ON u.id=a.user_id ORDER BY at DESC LIMIT 300`,
      );
      return {events: r};
    }

    fail('Action inconnue.', 404);
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
      const v = z.object({action: z.literal('ack-attendance'), id: uuid, kind: z.enum(['missing_start', 'late_start'])}).strict().parse(b);
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
      const old = await first<any>(db(), sql`SELECT role FROM tf_users WHERE id=${v.id}`);
      if (old?.role === 'admin') fail('Le compte direction se gère séparément.');
      if (old && old.role !== v.role) fail('Ne changez pas le rôle d’un compte existant : désactivez-le et créez un compte nominatif distinct.');
      if (!old && !v.password) fail('Mot de passe initial requis.');
      const sealed = v.password ? sealPassword(v.id, v.password) : null;
      await serializable(async (tx) => {
        if (!old) {
          const salt = randomSalt();
          await run(
            tx,
            sql`INSERT INTO tf_users(id,username,label,role,active,salt,password_hash,password_ciphertext,created_at)
                VALUES(${v.id},${v.username},${v.label},${v.role},${+v.active},${salt},${passwordHash(v.password!, salt)},${sealed},${iso()})`,
          );
        } else {
          await run(tx, sql`UPDATE tf_users SET label=${v.label},active=${+v.active} WHERE id=${v.id}`);
          if (v.password) {
            const salt = randomSalt();
            await run(tx, sql`UPDATE tf_users SET salt=${salt},password_hash=${passwordHash(v.password, salt)},password_ciphertext=${sealed},force_change=1 WHERE id=${v.id}`);
          }
          if (!v.active || v.password) await run(tx, sql`DELETE FROM tf_sessions WHERE user_id=${v.id}`);
        }
        await run(tx, auditSql(u, 'account.updated', v.id, {role: v.role, active: v.active, password_reset: !!old && !!v.password}));
      });
      return {ok: true};
    }

    if (['store', 'product', 'device', 'schedule', 'cancel', 'review'].includes(b.action) && !manages(u))
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
        await run(
          tx,
          sql`INSERT INTO tf_stores(id,name,kind,city,address,contact,notes,active) VALUES(${v.id},${v.name},${v.kind},${v.city},${v.address},${v.contact},${v.notes},${+v.active})
              ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,city=excluded.city,address=excluded.address,contact=excluded.contact,notes=excluded.notes,active=excluded.active`,
        );
        await run(tx, auditSql(u, 'store.updated', v.id));
      });
      return {ok: true};
    }

    if (b.action === 'device') {
      const v = z
        .object({action: z.literal('device'), id: uuid, name: text(100).min(2), location: text(200), active: z.boolean()})
        .strict()
        .parse(b);
      await serializable(async (tx) => {
        await run(
          tx,
          sql`INSERT INTO tf_devices(id,name,location,active) VALUES(${v.id},${v.name},${v.location},${+v.active})
              ON CONFLICT(id) DO UPDATE SET name=excluded.name,location=excluded.location,active=excluded.active`,
        );
        await run(tx, auditSql(u, 'device.updated', v.id));
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
      const old = await first<any>(db(), sql`SELECT brand FROM tf_products WHERE id=${v.id}`);
      if (old && old.brand !== v.brand) fail('La marque historique ne peut pas être changée.');
      await serializable(async (tx) => {
        await run(
          tx,
          sql`INSERT INTO tf_products(id,brand,sku,name,unit,price_hint,active) VALUES(${v.id},${v.brand},${v.sku},${v.name},${v.unit},${v.price_hint},${+v.active})
              ON CONFLICT(id) DO UPDATE SET sku=excluded.sku,name=excluded.name,unit=excluded.unit,price_hint=excluded.price_hint,active=excluded.active`,
        );
        await run(tx, auditSql(u, 'product.updated', v.id));
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
          start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
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
      const f = await first(db(), sql`SELECT id FROM tf_users WHERE id=${v.field_id} AND role='field' AND active=1`);
      const s = await first(db(), sql`SELECT id FROM tf_stores WHERE id=${v.store_id} AND active=1`);
      if (!f || !s) fail('Sélectionnez une animatrice et un point de vente actifs.');
      if (v.device_id && !(await first(db(), sql`SELECT id FROM tf_devices WHERE id=${v.device_id} AND active=1`)))
        fail('Dermoscan indisponible.');
      const start = new Date(v.day + 'T' + v.start + ':00+01:00').toISOString();
      const end = new Date(v.day + 'T' + v.end + ':00+01:00').toISOString();
      const old = await first<any>(db(), sql`SELECT * FROM tf_missions WHERE id=${v.id}`);
      if (old) {
        if (old.status !== 'planned' || old.version !== v.version) fail('L’animation a changé ou a déjà commencé.', 409);
        await batchMission(u, old, 'mission.rescheduled', [
          sql`UPDATE tf_missions SET store_id=${v.store_id},field_id=${v.field_id},day=${v.day},start_at=${start},end_at=${end},brands=${JSON.stringify(v.brands)}::jsonb,device_id=${v.device_id},device_location=${v.device_location},instructions=${v.instructions},late_grace_minutes=${v.late_grace_minutes} WHERE id=${v.id}`,
        ]);
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
      const cs = await counts(db(), m.id);
      const ts = await sales(db(), m.id);
      const ps = await all<any>(db(), sql`SELECT id,brand FROM tf_products WHERE active=1`);
      const at = iso();
      const stm: SQL[] = v.rows.map((r) => {
        const p = ps.find((x) => x.id === r.product_id);
        const old = cs.find((c) => c.product_id === r.product_id);
        if (!p || !m.brands.includes(p.brand)) fail('Produit non autorisé pour cette animation.');
        const sold = ts
          .filter((t) => t.status === 'valid')
          .flatMap((t) => t.lines)
          .filter((l: any) => l.product_id === r.product_id)
          .reduce((n: number, l: any) => n + l.qty, 0);
        if (v.mode === 'opening') {
          if (r.quantity + (old?.received || 0) - (old?.other_out || 0) < sold)
            fail('Stock de départ inférieur aux ventes : ' + r.product_id);
          return sql`INSERT INTO tf_counts(mission_id,product_id,opening,updated_by,updated_at) VALUES(${m.id},${r.product_id},${r.quantity},${u.id},${at})
                     ON CONFLICT(mission_id,product_id) DO UPDATE SET opening=excluded.opening,updated_by=excluded.updated_by,updated_at=excluded.updated_at`;
        }
        if (!old) fail('Renseignez le stock de départ avant le comptage final.');
        return sql`UPDATE tf_counts SET closing=${r.quantity},note=${r.note ?? old.note},updated_by=${u.id},updated_at=${at} WHERE mission_id=${m.id} AND product_id=${r.product_id}`;
      });
      await batchMission(u, m, 'stock.batch', stm, {mode: v.mode, products: v.rows.length});
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
      const p = await first<any>(db(), sql`SELECT * FROM tf_products WHERE id=${v.product_id} AND active=1`);
      if (!p || !m.brands.includes(p.brand)) fail('Référence absente des marques de cette animation.');
      if (v.expiring > 0 && !v.expiry) fail('Date d’expiration la plus proche requise.');
      if (v.other_out > 0 && !v.note) fail('Expliquez les sorties hors ventes.');
      const old = await first<any>(db(), sql`SELECT updated_at FROM tf_counts WHERE mission_id=${m.id} AND product_id=${v.product_id}`);
      if ((old?.updated_at || null) !== v.previous) fail('Comptage modifié entre-temps. Rechargez la fiche.', 409);
      const sold = (await sales(db(), m.id))
        .filter((x) => x.status === 'valid')
        .flatMap((x) => x.lines)
        .filter((l: any) => l.product_id === v.product_id)
        .reduce((s: number, l: any) => s + l.qty, 0);
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
      const old = await first<any>(db(), sql`SELECT user_id,mission_id,lines FROM tf_tickets WHERE id=${v.id}`);
      if (old) {
        const sameLines =
          JSON.stringify((old.lines as any[]).map((l) => ({product_id: l.product_id, qty: l.qty, unit_price: l.unit_price}))) ===
          JSON.stringify(v.lines);
        if (old.user_id !== u.id || old.mission_id !== m.id || !sameLines)
          fail('Identifiant déjà utilisé pour une autre saisie.', 409);
        return {ok: true, duplicate: true};
      }
      const ps = await all<any>(db(), sql`SELECT * FROM tf_products WHERE active=1`);
      const lines = v.lines.map((l) => {
        const p = ps.find((x) => x.id === l.product_id);
        if (!p || !m.brands.includes(p.brand)) fail('Produit non autorisé pour cette animation.');
        return {...l, name: p.name, brand: p.brand, unit: p.unit};
      });
      const total = ticketTotal(lines);
      if (!Number.isSafeInteger(total) || total > 1000000000) fail('Montant trop élevé.');
      const now = iso();
      const writes: SQL[] = [
        sql`INSERT INTO tf_tickets(id,mission_id,user_id,created_at,lines,total) VALUES(${v.id},${m.id},${u.id},${now},${JSON.stringify(lines)}::jsonb,${total})`,
        ...lines.map(
          (l) =>
            sql`INSERT INTO tf_store_prices(store_id,product_id,unit_price,updated_at) VALUES(${m.store_id},${l.product_id},${l.unit_price},${now})
                ON CONFLICT(store_id,product_id) DO UPDATE SET unit_price=excluded.unit_price,updated_at=excluded.updated_at`,
        ),
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
        [sql`UPDATE tf_tickets SET status='void',void_reason=${v.reason} WHERE id=${v.id}`],
        {ticket: v.id, reason: v.reason},
      );
      return {ok: true};
    }

    if (b.action === 'submit') {
      const v = z.object({action: z.literal('submit'), id: uuid, notes: text(2000), no_sales: z.boolean()}).strict().parse(b);
      const m = await mission(db(), u, v.id, true);
      if (m.status !== 'completed' || !m.actual_start || !m.actual_end) fail('Pointez le début et la fin avant de soumettre.');
      const issues = reportIssues(await counts(db(), m.id), await sales(db(), m.id), v.no_sales);
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
