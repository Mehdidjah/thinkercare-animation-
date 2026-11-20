import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {db, getPool} from './client';
import {hashNewPassword} from '../common/crypto';
import {sealPassword} from '../common/password-vault';

/**
 * Seeds the initial admin, explicitly configured test accounts, catalogue and
 * (with SEED_DEMO_DATA=1) demo stores. Runs on every boot, so it only adds what
 * is missing: existing accounts are never changed (personal passwords, admin
 * resets, required password changes and deactivations must survive), and
 * manager edits to catalogue products (name, SKU, unit, price, active) are kept.
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
  if ((await db().execute(sql`SELECT 1 FROM tf_users WHERE id=${id} OR username=${username}`)).rows.length) return;
  const {salt, hash} = await hashNewPassword(password);
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

  // (c) Full product catalogue (baseline). Missing products are inserted (a
  // product whose brand+SKU a manager already uses is skipped, not crashed on);
  // existing rows only get the import-owned columns refreshed. Columns managers
  // edit through the 'product' action (sku, name, unit, price_hint, active) and
  // the historical brand are never overwritten.
  const products = catalogue();
  const rows = JSON.stringify(
    products.map((p) => ({
      id: p.id, brand: p.brand, sku: p.sku, name: p.name, unit: p.unit, price_hint: p.price_hint, active: p.active ?? 1,
      image_url: p.image_url ?? '', source_url: p.source_url ?? '', source_id: p.source_id ?? '', is_bulk: p.is_bulk ?? 0, catalog_at: p.catalog_at ?? '',
    })),
  );
  const shape = sql`jsonb_to_recordset(${rows}::jsonb) AS p(id text,brand text,sku text,name text,unit text,price_hint int,active int,image_url text,source_url text,source_id text,is_bulk int,catalog_at text)`;
  const added = await db().execute(
    sql`INSERT INTO tf_products(id,brand,sku,name,unit,price_hint,active,image_url,source_url,source_id,is_bulk,catalog_at)
        SELECT id,brand,sku,name,unit,price_hint,active,image_url,source_url,source_id,is_bulk,catalog_at FROM ${shape}
        ON CONFLICT DO NOTHING`,
  );
  const refreshed = await db().execute(
    sql`UPDATE tf_products t SET image_url=p.image_url,source_url=p.source_url,source_id=p.source_id,is_bulk=p.is_bulk,catalog_at=p.catalog_at
        FROM ${shape} WHERE t.id=p.id
        AND (t.image_url,t.source_url,t.source_id,t.is_bulk,t.catalog_at) IS DISTINCT FROM (p.image_url,p.source_url,p.source_id,p.is_bulk,p.catalog_at)`,
  );

  // Demo stores, only on request (SEED_DEMO_DATA=1). Existing rows are never
  // touched or deleted, so turning the flag off keeps stores already created.
  const demo = process.env.SEED_DEMO_DATA === '1';
  if (demo) {
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
  }
  // No demo mission is seeded: the tf_no_overlap BEFORE-INSERT trigger fires
  // ahead of ON CONFLICT DO NOTHING, so re-seeding one could clash with a real
  // mission and crash startup. Schedule missions from the app
  // (Planning & suivi -> Programmer).

  console.log('\n=== Seed complete — existing account credentials preserved ===');
  console.log(`  catalogue: ${products.length} products, ${added.rowCount ?? 0} added, ${refreshed.rowCount ?? 0} refreshed (manager edits kept)`);
  console.log(demo ? '  demo: 2 stores (schedule missions from the app)' : '  demo: skipped (set SEED_DEMO_DATA=1 to add the 2 demo stores)');
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
