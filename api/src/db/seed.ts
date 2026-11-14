import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {db, getPool} from './client';
import {passwordHash, randomSalt, randomUUID} from '../common/crypto';

/**
 * Seeds the baseline (design §9.1.3/4): the `direction` admin (force_change=1,
 * password from ADMIN_INITIAL_PASSWORD), three test accounts the human logs in
 * with directly (force_change=0), the full product catalogue, and a little demo
 * data so the dashboard is not empty. Idempotent: users/stores/mission use
 * ON CONFLICT DO NOTHING (never resets a changed password), products upsert.
 */

const ADMIN_ID = '09d4ed63-862d-4224-8644-12fb416f590f'; // same identity as the original migration

type Seeded = {username: string; password: string; role: string; note: string};

function catalogue(): any[] {
  const candidates = [
    join(__dirname, 'catalogue.json'),
    join(__dirname, '..', '..', 'src', 'db', 'catalogue.json'),
    join(process.cwd(), 'src', 'db', 'catalogue.json'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Cannot locate catalogue.json');
  return JSON.parse(readFileSync(found, 'utf8'));
}

async function upsertUser(
  id: string,
  username: string,
  label: string,
  role: string,
  password: string,
  forceChange: number,
): Promise<void> {
  const salt = randomSalt();
  const hash = passwordHash(password, salt);
  await db().execute(
    sql`INSERT INTO tf_users(id,username,label,role,active,salt,password_hash,force_change,created_at)
        VALUES(${id},${username},${label},${role},1,${salt},${hash},${forceChange},${new Date().toISOString()})
        ON CONFLICT(id) DO NOTHING`,
  );
}

async function main() {
  const adminPassword = process.env.ADMIN_INITIAL_PASSWORD;
  if (!adminPassword) {
    throw new Error('ADMIN_INITIAL_PASSWORD is required to seed the initial admin account.');
  }
  const managerPassword = process.env.SEED_MANAGER_PASSWORD || 'Gestion-Terrain-2026';
  const fieldPassword = process.env.SEED_FIELD_PASSWORD || 'Animatrice-Terrain-2026';
  const doctorPassword = process.env.SEED_DOCTOR_PASSWORD || 'Medecin-Terrain-2026';

  const seeded: Seeded[] = [];

  // (a) Admin — force_change=1 (must change at first login).
  await upsertUser(ADMIN_ID, 'direction', 'Direction ThinkerCare', 'admin', adminPassword, 1);
  seeded.push({username: 'direction', password: adminPassword, role: 'admin', note: 'force_change=1 (change at first login)'});

  // (b) Test accounts — force_change=0 (log in directly).
  const manager = {id: '11111111-1111-4111-8111-111111111111', username: 'gestion', label: 'Gestion — compte test'};
  const field = {id: '22222222-2222-4222-8222-222222222222', username: 'animatrice', label: 'Animatrice — compte test'};
  const doctor = {id: '33333333-3333-4333-8333-333333333333', username: 'medecin', label: 'Médecin — compte test'};
  await upsertUser(manager.id, manager.username, manager.label, 'manager', managerPassword, 0);
  await upsertUser(field.id, field.username, field.label, 'field', fieldPassword, 0);
  await upsertUser(doctor.id, doctor.username, doctor.label, 'doctor', doctorPassword, 0);
  seeded.push({username: 'gestion', password: managerPassword, role: 'manager', note: 'SEED_MANAGER_PASSWORD'});
  seeded.push({username: 'animatrice', password: fieldPassword, role: 'field', note: 'SEED_FIELD_PASSWORD'});
  seeded.push({username: 'medecin', password: doctorPassword, role: 'doctor', note: 'SEED_DOCTOR_PASSWORD'});

  // (c) Full product catalogue (baseline).
  const products = catalogue();
  for (const p of products) {
    await db().execute(
      sql`INSERT INTO tf_products(id,brand,sku,name,unit,price_hint,active,image_url,source_url,source_id,is_bulk,catalog_at)
          VALUES(${p.id},${p.brand},${p.sku},${p.name},${p.unit},${p.price_hint},${p.active ?? 1},${p.image_url ?? ''},${p.source_url ?? ''},${p.source_id ?? ''},${p.is_bulk ?? 0},${p.catalog_at ?? ''})
          ON CONFLICT(id) DO UPDATE SET brand=excluded.brand,sku=excluded.sku,name=excluded.name,unit=excluded.unit,price_hint=excluded.price_hint,active=excluded.active,image_url=excluded.image_url,source_url=excluded.source_url,source_id=excluded.source_id,is_bulk=excluded.is_bulk,catalog_at=excluded.catalog_at`,
    );
  }

  // Demo stores + one planned demo mission (so the dashboard is not empty).
  const storeA = {id: 'aaaaaaa1-0000-4000-8000-000000000001', name: 'Pharmacie Centrale (démo)', city: 'Alger'};
  const storeB = {id: 'aaaaaaa1-0000-4000-8000-000000000002', name: 'Parapharmacie du Parc (démo)', city: 'Oran'};
  for (const s of [storeA, storeB]) {
    await db().execute(
      sql`INSERT INTO tf_stores(id,name,kind,city,address,contact,notes,active)
          VALUES(${s.id},${s.name},'pharmacy',${s.city},'Adresse de démonstration','','Donnée de démonstration',1)
          ON CONFLICT(id) DO NOTHING`,
    );
  }

  const today = new Date(new Date().getTime() + 3600000).toISOString().slice(0, 10); // Alger day
  const startAt = new Date(today + 'T09:00:00+01:00').toISOString();
  const endAt = new Date(today + 'T13:00:00+01:00').toISOString();
  await db().execute(
    sql`INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,device_location,instructions,status,report_status,created_by,updated_at,late_grace_minutes)
        VALUES('bbbbbbb1-0000-4000-8000-000000000001',${storeA.id},${field.id},${today},${startAt},${endAt},${JSON.stringify(['TOUCHE'])}::jsonb,'','Animation de démonstration','planned','draft',${ADMIN_ID},${new Date().toISOString()},15)
        ON CONFLICT(id) DO NOTHING`,
  );

  // Print credentials.
  console.log('\n=== Seed complete — accounts ===');
  for (const s of seeded) {
    console.log(`  ${s.role.padEnd(8)} username=${s.username.padEnd(12)} password=${s.password}   (${s.note})`);
  }
  console.log(`  products seeded: ${products.length}`);
  console.log('  demo: 2 stores + 1 planned mission (today) for the "animatrice" account');
  console.log('================================\n');

  await getPool().end();
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
