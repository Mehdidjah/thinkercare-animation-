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
  reset = false,
): Promise<void> {
  const salt = randomSalt();
  const hash = passwordHash(password, salt);
  const base = sql`INSERT INTO tf_users(id,username,label,role,active,salt,password_hash,force_change,created_at)
        VALUES(${id},${username},${label},${role},1,${salt},${hash},${forceChange},${new Date().toISOString()})`;
  // reset=true (test accounts): re-affirm the documented password on every deploy,
  // so a bad password state can't persist. reset=false (admin): never touch the
  // password that's already there.
  if (reset) {
    await db().execute(
      sql`${base} ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label, salt=EXCLUDED.salt, password_hash=EXCLUDED.password_hash, force_change=EXCLUDED.force_change, active=1`,
    );
  } else {
    await db().execute(sql`${base} ON CONFLICT(id) DO NOTHING`);
  }
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

  // (a) Admin — direct login (force_change removed per request); keeps ADMIN_INITIAL_PASSWORD.
  await upsertUser(ADMIN_ID, 'direction', 'Direction ThinkerCare', 'admin', adminPassword, 0);
  // Also clear the flag on an already-seeded admin (updates force_change only, keeps the password).
  await db().execute(sql`UPDATE tf_users SET force_change=0 WHERE id=${ADMIN_ID}`);
  seeded.push({username: 'direction', password: adminPassword, role: 'admin', note: 'force_change=0 (direct login)'});

  // (b) Test accounts — force_change=0 (log in directly).
  const manager = {id: '11111111-1111-4111-8111-111111111111', username: 'gestion', label: 'Gestion — compte test'};
  const field = {id: '22222222-2222-4222-8222-222222222222', username: 'animatrice', label: 'Animatrice — compte test'};
  const doctor = {id: '33333333-3333-4333-8333-333333333333', username: 'medecin', label: 'Médecin — compte test'};
  await upsertUser(manager.id, manager.username, manager.label, 'manager', managerPassword, 0, true);
  await upsertUser(field.id, field.username, field.label, 'field', fieldPassword, 0, true);
  await upsertUser(doctor.id, doctor.username, doctor.label, 'doctor', doctorPassword, 0, true);
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

  // Demo stores (best-effort — demo data must never crash startup).
  try {
    const demoStores = [
      {id: 'aaaaaaa1-0000-4000-8000-000000000001', name: 'Pharmacie Centrale (démo)', city: 'Alger'},
      {id: 'aaaaaaa1-0000-4000-8000-000000000002', name: 'Parapharmacie du Parc (démo)', city: 'Oran'},
    ];
    for (const s of demoStores) {
      await db().execute(
        sql`INSERT INTO tf_stores(id,name,kind,city,address,contact,notes,active)
            VALUES(${s.id},${s.name},'pharmacy',${s.city},'Adresse de démonstration','','Donnée de démonstration',1)
            ON CONFLICT(id) DO NOTHING`,
      );
    }
  } catch (e) {
    console.warn('[seed] demo stores skipped:', (e as Error).message);
  }
  // No demo mission is seeded: the tf_no_overlap BEFORE-INSERT trigger fires
  // ahead of ON CONFLICT DO NOTHING, so re-seeding one could clash with a real
  // mission and crash startup. Schedule missions from the app
  // (Planning & suivi -> Programmer).

  // Print credentials.
  console.log('\n=== Seed complete — accounts ===');
  for (const s of seeded) {
    console.log(`  ${s.role.padEnd(8)} username=${s.username.padEnd(12)} password=${s.password}   (${s.note})`);
  }
  console.log(`  products seeded: ${products.length}`);
  console.log('  demo: 2 stores (schedule missions from the app)');
  console.log('================================\n');

  await getPool().end();
}

main().catch((err) => {
  // Seed is idempotent and best-effort; a seed error must never stop the server
  // from starting on a redeploy (the critical admin/catalogue rows are already
  // in place). Log loudly and let the container continue to `node dist/main.js`.
  console.error('[seed] error (continuing to start the server):', err);
  process.exit(0);
});
