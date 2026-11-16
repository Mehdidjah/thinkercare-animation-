import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {db, getPool} from './client';
import {passwordHash, randomSalt} from '../common/crypto';
import {sealPassword} from '../common/password-vault';

/**
 * Seeds the initial admin, explicitly configured test accounts, catalogue and
 * demo stores. Existing accounts are never changed: personal passwords, admin
 * resets, required password changes and deactivations must survive every boot.
 */

const ADMIN_ID = '09d4ed63-862d-4224-8644-12fb416f590f'; // same identity as the original migration

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

async function seedUser(
  id: string,
  username: string,
  label: string,
  role: string,
  password: string,
  forceChange: number,
): Promise<void> {
  const salt = randomSalt();
  const hash = passwordHash(password, salt);
  const sealed = role === 'admin' ? null : sealPassword(id, password);
  await db().execute(sql`INSERT INTO tf_users(id,username,label,role,active,salt,password_hash,password_ciphertext,force_change,created_at)
        VALUES(${id},${username},${label},${role},1,${salt},${hash},${sealed},${forceChange},${new Date().toISOString()})
        ON CONFLICT DO NOTHING`);
}

async function main() {
  const adminPassword = process.env.ADMIN_INITIAL_PASSWORD;
  if (!adminPassword) {
    throw new Error('ADMIN_INITIAL_PASSWORD is required to seed the initial admin account.');
  }
  // Initial admin has direct access; subsequent boots preserve all account state.
  await seedUser(ADMIN_ID, 'direction', 'Direction ThinkerCare', 'admin', adminPassword, 0);

  // Optional test accounts require explicit passwords. No shared fallback
  // credentials are created, and existing accounts are retained without them.
  const accounts = [
    {id: '11111111-1111-4111-8111-111111111111', username: 'gestion', label: 'Gestion — compte test', role: 'manager', password: process.env.SEED_MANAGER_PASSWORD},
    {id: '22222222-2222-4222-8222-222222222222', username: 'animatrice', label: 'Animatrice — compte test', role: 'field', password: process.env.SEED_FIELD_PASSWORD},
    {id: '33333333-3333-4333-8333-333333333333', username: 'medecin', label: 'Médecin — compte test', role: 'doctor', password: process.env.SEED_DOCTOR_PASSWORD},
  ];
  for (const account of accounts) {
    if (account.password) {
      await seedUser(account.id, account.username, account.label, account.role, account.password, 0);
    }
  }

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

  console.log('\n=== Seed complete — existing account credentials preserved ===');
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
