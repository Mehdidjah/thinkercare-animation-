import 'reflect-metadata';
import {afterAll, beforeAll, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {randomBytes, randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {TerrainService} from '../src/terrain/terrain.service';
import {OperationsService} from '../src/terrain/operations.service';
import {PhotosService} from '../src/terrain/photos.service';
import {StorageService} from '../src/storage/storage.service';
import {HttpExceptionFilter} from '../src/common/http-exception.filter';
import {getPool} from '../src/db/client';
import {attendance, dayInAlger, shiftDay, weekStart, type User} from '../src/domain/core';

// Disposable local Postgres cluster, like passwords.test.ts. Never touches a
// configured, shared or production database.
const root = join(import.meta.dir, '..');
const directory = mkdtempSync(join(tmpdir(), 'terrain-data-tests-'));
const cluster = join(directory, 'pg');
const secret = () => 'Test-only-' + randomUUID();
const passwords = {direction: secret(), gestion: secret(), animatrice: secret(), medecin: secret()};
const terrain = new TerrainService(new OperationsService());
const saved = {...process.env};
let started = false;
let port = 0;
let admin: User, manager: User, field: User, doctor: User;
let storeId = '';

const pool = () => getPool();
const q = (s: string) => new URLSearchParams(s);
const today = dayInAlger();
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+01:00`).toISOString();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const C7 = 'Une autre animation est encore en cours. Pointez d’abord votre départ de cette animation.';

function command(program: string, args: string[], env: Record<string, string | undefined> = {}) {
  const result = spawnSync(program, args, {cwd: root, env: {...process.env, ...env}, encoding: 'utf8', timeout: 60000});
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return result.stdout + result.stderr;
}

const seed = (env: Record<string, string | undefined> = {}) => expect(command(process.execPath, ['src/db/seed.ts'], env)).toContain('Seed complete');

async function account(username: string): Promise<User> {
  return (await pool().query('SELECT id,username,label,role,active,force_change FROM tf_users WHERE username=$1', [username])).rows[0];
}

async function fieldUser(): Promise<User> {
  const id = randomUUID();
  const username = 'field-' + id.slice(0, 8);
  await pool().query(`INSERT INTO tf_users(id,username,label,role,active,salt,password_hash,force_change,created_at)
    VALUES($1,$2,$3,'field',1,'00','00',0,$4)`, [id, username, 'Animatrice ' + id.slice(0, 4), new Date().toISOString()]);
  return account(username);
}

async function addMission(o: {field: string; day: string; status?: string; start?: string; end?: string; actualStart?: string | null; actualEnd?: string | null; store?: string}) {
  const id = randomUUID();
  await pool().query(`INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,status,actual_start,actual_end,created_by,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'["TOUCHE","BELNCO"]',$7,$8,$9,$10,$11)`,
  [id, o.store || storeId, o.field, o.day, at(o.day, o.start || '08:00'), at(o.day, o.end || '10:00'), o.status || 'planned', o.actualStart ?? null, o.actualEnd ?? null, admin.id, new Date().toISOString()]);
  return id;
}

const row = async (table: string, id: string) => (await pool().query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows[0];

/** Runs the real global exception filter and returns what the client would receive. */
function respond(e: unknown, req: any = {method: 'POST', originalUrl: '/api/terrain', query: {}, body: ''}) {
  let status = 0;
  let body: any;
  const res = {headersSent: false, setHeader() {}, status(s: number) { status = s; return res; }, json(b: any) { body = b; }};
  new HttpExceptionFilter().catch(e, {switchToHttp: () => ({getResponse: () => res, getRequest: () => req})} as any);
  return {status, body};
}

async function failure(p: Promise<unknown>) {
  const e = await p.then(() => { throw new Error('expected a failure'); }, (x) => x);
  return respond(e);
}

async function captureLogs<T>(fn: () => Promise<T> | T) {
  const lines: string[] = [];
  const original = {error: console.error, warn: console.warn};
  console.error = (...a: any[]) => { lines.push(a.join(' ')); };
  console.warn = (...a: any[]) => { lines.push(a.join(' ')); };
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return lines;
}

async function photoRequest(noteId: string) {
  const data = new Uint8Array(4000);
  data.set([255, 216, 255]);
  const form = new FormData();
  form.set('note_id', noteId);
  form.set('photo_id', randomUUID());
  form.set('no_person', 'true');
  form.set('photo', new File([data], 'shelf.jpg', {type: 'image/jpeg'}));
  const body = new Response(form);
  const contentType = body.headers.get('content-type');
  const stream = Readable.from([Buffer.from(await body.arrayBuffer())]) as any;
  stream.headers = {'content-type': contentType};
  return stream;
}

beforeAll(async () => {
  const listener = createServer();
  port = await new Promise<number>((resolve) => listener.listen(0, '127.0.0.1', () => resolve((listener.address() as any).port)));
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  command('initdb', ['-D', cluster, '--auth=trust', '--no-locale', '--encoding=UTF8', '-U', 'terrain_test']);
  command('pg_ctl', ['-D', cluster, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${directory}`, '-w', 'start']);
  started = true;
  delete process.env.SEED_DEMO_DATA;
  Object.assign(process.env, {DATABASE_URL: `postgres://terrain_test@127.0.0.1:${port}/postgres`,
    DATABASE_SSL: 'false', PGSSLMODE: 'disable', ACCOUNT_PASSWORD_KEY: randomBytes(32).toString('hex'),
    STORAGE_DIR: join(directory, 'photos'), S3_BUCKET: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '',
    ADMIN_INITIAL_PASSWORD: passwords.direction, SEED_MANAGER_PASSWORD: passwords.gestion,
    SEED_FIELD_PASSWORD: passwords.animatrice, SEED_DOCTOR_PASSWORD: passwords.medecin});
  command(process.execPath, ['src/db/migrate.ts']);
  seed();
  [admin, manager, field, doctor] = await Promise.all(['direction', 'gestion', 'animatrice', 'medecin'].map(account));
  storeId = randomUUID();
  await pool().query(`INSERT INTO tf_stores(id,name,kind,city,address) VALUES($1,'Pharmacie des tests','pharmacy','Alger','1 rue des tests')`, [storeId]);
}, 90000);

afterAll(async () => {
  if (started) {
    await getPool().end();
    command('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop']);
  }
  rmSync(directory, {recursive: true, force: true});
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

test('service requests reject inherited object keys as reasons (400, not 500)', async () => {
  const body = (kind: string, reason: string) => ({action: 'service-create', id: randomUUID(), mission_id: null, store_id: null, store_label: '',
    kind, reason, channel: 'onsite', product_id: null, lot: '', code: '', priority: 'normal', description: 'Description assez longue', consent: false, due_day: ''});
  for (const reason of ['toString', 'constructor', '__proto__', 'hasOwnProperty'])
    for (const kind of ['complaint', 'request'])
      expect(await failure(terrain.postTerrain(field, body(kind, reason)))).toEqual({status: 400, body: {error: 'Sélectionnez un motif valide.'}});
  expect((await terrain.postTerrain(field, body('complaint', 'packaging'))).ok).toBe(true);
  expect((await terrain.postTerrain(field, body('request', 'restock'))).ok).toBe(true);
});

test('an existing account cannot be renamed', async () => {
  const rename = {action: 'user', id: field.id, username: 'animatrice-renommee', label: 'Animatrice', role: 'field', active: true};
  expect(await failure(terrain.postTerrain(admin, rename))).toEqual({status: 400, body: {error: 'L’identifiant d’un compte existant ne peut pas être modifié.'}});
  expect((await row('tf_users', field.id)).username).toBe('animatrice');
  expect((await terrain.postTerrain(admin, {...rename, username: 'animatrice', label: 'Animatrice — compte test'})).ok).toBe(true);
});

test('impossible calendar dates are refused', async () => {
  for (const query of ['action=missions&from=2026-02-31&to=2026-03-01', 'action=reports&from=2026-02-01&to=2026-02-30', 'action=field-notes&from=2026-04-31'])
    expect(await failure(terrain.getTerrain(manager, q(query)))).toEqual({status: 400, body: {error: 'Date invalide.'}});
  expect((await terrain.getTerrain(manager, q('action=missions&from=2024-02-29&to=2024-02-29'))).missions).toEqual([]);
});

test('bootstrap prefetches exactly the planning week the missions action returns', async () => {
  const from = weekStart(today);
  const query = `action=missions&from=${from}&to=${shiftDay(from, 6)}`;
  await addMission({field: field.id, day: today, start: '09:00', end: '11:00'});
  for (const u of [admin, manager, field]) {
    const boot = await terrain.getTerrain(u, q(''));
    expect(boot.prefetch.missions.query).toBe(query);
    const direct = await terrain.getTerrain(u, q(query));
    expect({...boot.prefetch.missions.data, serverTime: 0}).toEqual({...direct, serverTime: 0});
    expect(boot.prefetch.missions.data.missions.length).toBeGreaterThan(0);
    expect(typeof boot.prefetch.missions.data.serverTime).toBe('string');
  }
  expect((await terrain.getTerrain(doctor, q(''))).prefetch).toBeUndefined();
  expect((await terrain.getTerrain({...field, force_change: 1}, q(''))).prefetch).toBeUndefined();
});

test('bootstrap lists are cut to their cap when limited', async () => {
  await pool().query(`INSERT INTO tf_products(id,brand,sku,name) SELECT 'zz-cap-'||g,'NOOM','zz-cap-'||g,'Cap '||g FROM generate_series(1,2001) g`);
  try {
    const boot = await terrain.getTerrain(manager, q(''));
    expect(boot.limited).toBe(true);
    expect(boot.products.length).toBe(2000);
  } finally {
    await pool().query(`DELETE FROM tf_products WHERE id LIKE 'zz-cap-%'`);
  }
});

test('attendance raises missing_end for a mission still ongoing after its end', () => {
  const m = {status: 'ongoing', start_at: '2026-11-20T07:00:00.000Z', end_at: '2026-11-20T09:00:00.000Z', actual_start: '2026-11-20T07:05:00.000Z', late_grace_minutes: 15};
  expect(attendance(m, '2026-11-20T09:15:00.000Z')).toBeNull();
  expect(attendance(m, '2026-11-20T09:16:00.000Z')).toEqual({kind: 'missing_end', minutes: 16});
  expect(attendance({...m, status: 'completed', actual_end: '2026-11-20T09:00:00.000Z'}, '2026-11-21T09:00:00.000Z')).toBeNull();
  expect(attendance({...m, actual_start: '2026-11-20T08:00:00.000Z'}, '2026-11-20T08:30:00.000Z')).toEqual({kind: 'late_start', minutes: 60});
  expect(attendance({...m, status: 'planned', actual_start: null}, '2026-11-20T08:00:00.000Z')).toEqual({kind: 'missing_start', minutes: 60});
});

test('missing_end alerts survive the 8-day window, can be acknowledged, skip inactive staff; managers close or correct the departure', async () => {
  const worker = await fieldUser();
  const day = shiftDay(today, -10);
  const id = await addMission({field: worker.id, day, actualStart: at(day, '08:05'), status: 'ongoing'});
  const alerts = async () => (await terrain.getTerrain(manager, q('action=attendance-alerts'))).alerts.filter((a: any) => a.mission_id === id);
  let [alert] = await alerts();
  expect(alert).toMatchObject({kind: 'missing_end', acknowledged: false, end_at: at(day, '10:00')});
  expect(alert.minutes).toBeGreaterThan(9 * 24 * 60);
  expect(await failure(terrain.postTerrain(manager, {action: 'ack-attendance', id, kind: 'missing_start'}))).toMatchObject({status: 409});
  expect((await terrain.postTerrain(manager, {action: 'ack-attendance', id, kind: 'missing_end'})).ok).toBe(true);
  [alert] = await alerts();
  expect(alert.acknowledged).toBe(true);
  await pool().query('UPDATE tf_users SET active=0 WHERE id=$1', [worker.id]);
  expect(await alerts()).toEqual([]);
  await pool().query('UPDATE tf_users SET active=1 WHERE id=$1', [worker.id]);

  const close = (end: string, reason = 'Oubli de pointage confirmé par téléphone') => ({action: 'close-mission', id, end, reason});
  for (const u of [worker, field, doctor]) expect(await failure(terrain.postTerrain(u, close('12:00')))).toMatchObject({status: 403});
  expect(await failure(terrain.postTerrain(manager, close('08:00')))).toEqual({status: 400, body: {error: 'L’heure de départ doit suivre l’heure d’arrivée pointée.'}});
  expect(await failure(terrain.postTerrain(manager, close('25:00')))).toMatchObject({status: 400});
  expect(await failure(terrain.postTerrain(manager, close('12:00', 'ok')))).toMatchObject({status: 400});
  const version = (await row('tf_missions', id)).version;
  expect(await terrain.postTerrain(manager, close('12:30'))).toEqual({ok: true});
  await pause(3);
  let m = await row('tf_missions', id);
  expect(m).toMatchObject({status: 'completed', actual_end: at(day, '12:30'), version: version + 1});
  expect(await alerts()).toEqual([]);
  expect(await terrain.postTerrain(admin, close('11:00', 'Heure confirmée par la pharmacie'))).toEqual({ok: true});
  m = await row('tf_missions', id);
  expect(m.actual_end).toBe(at(day, '11:00'));
  const audit = (await pool().query("SELECT action,detail FROM tf_audit WHERE target=$1 AND action LIKE 'mission.%' ORDER BY at", [id])).rows;
  expect(audit.map((a) => a.action)).toEqual(['mission.closed_by_manager', 'mission.end_corrected']);
  expect(audit[0].detail).toMatchObject({reason: 'Oubli de pointage confirmé par téléphone', end: at(day, '12:30'), previous_end: null});
  expect(audit[1].detail).toMatchObject({reason: 'Heure confirmée par la pharmacie', previous_end: at(day, '12:30')});

  const tomorrow = shiftDay(today, 1);
  const future = await addMission({field: worker.id, day: tomorrow, status: 'completed', actualStart: at(tomorrow, '08:00'), actualEnd: at(tomorrow, '10:00')});
  expect(await failure(terrain.postTerrain(manager, {...close('09:00'), id: future}))).toEqual({status: 400, body: {error: 'L’heure de départ ne peut pas être dans le futur.'}});
  const planned = await addMission({field: worker.id, day: today});
  expect(await failure(terrain.postTerrain(manager, {...close('09:00'), id: planned}))).toEqual({status: 400, body: {error: 'Seule une animation commencée peut être clôturée.'}});
});

test('a second ongoing mission maps to the explicit check-in message (C7 race fallback)', async () => {
  const worker = await fieldUser();
  await addMission({field: worker.id, day: shiftDay(today, -1), status: 'ongoing', actualStart: at(shiftDay(today, -1), '08:00')});
  const second = await addMission({field: worker.id, day: today});
  const error = await pool().query("UPDATE tf_missions SET status='ongoing' WHERE id=$1", [second]).then(() => null, (e) => e);
  expect(error).toMatchObject({code: '23505', constraint: 'tf_one_ongoing'});
  expect(respond(error)).toEqual({status: 409, body: {error: C7}});
});

test('unique violations name the duplicated field', async () => {
  const user = {action: 'user', id: randomUUID(), username: 'animatrice', label: 'Doublon', role: 'field', active: true, password: 'a'};
  expect(await failure(terrain.postTerrain(admin, user))).toEqual({status: 409, body: {error: 'Cet identifiant est déjà utilisé.'}});
  const device = () => ({action: 'device', id: randomUUID(), name: 'Dermoscan doublon', location: 'Comptoir', active: true});
  await terrain.postTerrain(manager, device());
  expect(await failure(terrain.postTerrain(manager, device()))).toEqual({status: 409, body: {error: 'Ce nom d’appareil est déjà utilisé.'}});
  const product = () => ({action: 'product', id: 'dup-' + randomUUID().slice(0, 8), brand: 'NOOM', sku: 'NOOM-DOUBLON', name: 'Doublon', unit: 'pièce', price_hint: 100, active: true});
  await terrain.postTerrain(manager, product());
  expect(await failure(terrain.postTerrain(manager, product()))).toEqual({status: 409, body: {error: 'Cette référence (SKU) existe déjà.'}});
  expect(respond({code: '23505', severity: 'ERROR', constraint: 'tf_photos_object_key_unique', message: 'duplicate'}))
    .toEqual({status: 409, body: {error: 'Données modifiées ou enregistrement déjà présent. Actualisez avant de réessayer.'}});
});

test('unexpected errors and database conflicts are logged without request bodies', async () => {
  const req = {method: 'POST', originalUrl: '/api/terrain?x=1', query: {}, user: {id: 'user-123'},
    body: JSON.stringify({action: 'user', password: 'Never-log-me-42', username: 'x'}), headers: {cookie: '__Host-terrain-session=cookie-token-zz9'}};
  let lines = await captureLogs(() => expect(respond(new TypeError('boom in handler'), req)).toMatchObject({status: 500}));
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain('500 POST /api/terrain action=user user=user-123');
  expect(lines[0]).toContain('TypeError: boom in handler');
  expect(lines[0]).not.toContain('Never-log-me-42');
  expect(lines[0]).not.toContain('cookie-token-zz9');
  lines = await captureLogs(() => respond({code: '23505', severity: 'ERROR', constraint: 'tf_users_username_unique', message: 'dup'}, {...req, query: {action: 'bootstrap'}}));
  expect(lines).toEqual(['[http] 409 POST /api/terrain action=bootstrap user=user-123 sqlstate=23505 constraint=tf_users_username_unique']);
  lines = await captureLogs(() => failure(terrain.postTerrain(field, {action: 'user'})));
  expect(lines).toEqual([]);
});

test('the boot seed keeps manager edits to catalogue products and only adds demo stores on request', async () => {
  const catalogue = JSON.parse(readFileSync(join(root, 'src/db/catalogue.json'), 'utf8'));
  // Products no other test has counted or priced yet (their rows reference tf_products).
  const used = new Set((await pool().query(`SELECT product_id FROM tf_counts UNION SELECT product_id FROM tf_store_prices UNION SELECT product_id FROM tf_complaints
    UNION SELECT product_id FROM tf_cases UNION SELECT product_id FROM tf_field_notes`)).rows.map((r) => r.product_id));
  const [missing, taken] = catalogue.filter((p: any) => p.id !== 'antiacne' && !used.has(p.id)).slice(-2);
  const edit = {action: 'product', id: 'antiacne', brand: 'TOUCHE', sku: 'antiacne-v2', name: 'Anti Acné (renommé)', unit: 'pack', price_hint: 192345, active: false};
  await terrain.postTerrain(manager, edit);
  await pool().query("UPDATE tf_products SET image_url='stale' WHERE id='antiacne'");
  await pool().query('DELETE FROM tf_products WHERE id = ANY($1)', [[missing.id, taken.id]]);
  await terrain.postTerrain(manager, {action: 'product', id: 'manager-owned', brand: taken.brand, sku: taken.sku, name: 'Créé par la gestion', unit: 'pièce', price_hint: 1, active: true});
  expect((await pool().query("SELECT count(*)::int AS n FROM tf_stores WHERE id LIKE 'aaaaaaa1-%'")).rows[0].n).toBe(0);
  seed();
  expect(await row('tf_products', 'antiacne')).toMatchObject({sku: 'antiacne-v2', name: 'Anti Acné (renommé)', unit: 'pack', price_hint: 192345, active: 0, image_url: catalogue.find((p: any) => p.id === 'antiacne').image_url});
  expect(await row('tf_products', missing.id)).toMatchObject({sku: missing.sku, name: missing.name, price_hint: missing.price_hint});
  expect(await row('tf_products', taken.id)).toBeUndefined();
  expect((await row('tf_products', 'manager-owned')).name).toBe('Créé par la gestion');
  seed({SEED_DEMO_DATA: '1'});
  expect((await pool().query("SELECT count(*)::int AS n FROM tf_stores WHERE id LIKE 'aaaaaaa1-%'")).rows[0].n).toBe(2);
  await pool().query("UPDATE tf_stores SET active=0,name='Renommée' WHERE id='aaaaaaa1-0000-4000-8000-000000000001'");
  seed({SEED_DEMO_DATA: '1'});
  expect(await row('tf_stores', 'aaaaaaa1-0000-4000-8000-000000000001')).toMatchObject({active: 0, name: 'Renommée'});
}, 60000);

test('voiding a sale restores the remembered store price it had set', async () => {
  const worker = await fieldUser();
  // Own store: sales recorded by other tests at the shared store would count as "the last valid sale".
  const store = randomUUID();
  await pool().query(`INSERT INTO tf_stores(id,name,kind,city,address) VALUES($1,'Pharmacie des prix','pharmacy','Alger','2 rue des tests')`, [store]);
  const id = await addMission({field: worker.id, day: today, status: 'ongoing', actualStart: at(today, '08:00'), store});
  const [p, other] = (await pool().query("SELECT id FROM tf_products WHERE brand='TOUCHE' AND active=1 AND id<>'antiacne' ORDER BY id LIMIT 2")).rows.map((r) => r.id);
  const sale = async (lines: {product_id: string; qty: number; unit_price: number}[]) => {
    const ticket = randomUUID();
    await terrain.postTerrain(worker, {action: 'sale', id: ticket, mission_id: id, lines});
    await pause(3);
    return ticket;
  };
  const price = async (product: string) => (await pool().query('SELECT unit_price FROM tf_store_prices WHERE store_id=$1 AND product_id=$2', [store, product])).rows[0]?.unit_price;
  const voidSale = (ticket: string) => terrain.postTerrain(manager, {action: 'void-sale', id: ticket, reason: 'Erreur de saisie'});

  const good = await sale([{product_id: p, qty: 1, unit_price: 180000}]);
  const typo = await sale([{product_id: p, qty: 1, unit_price: 18}, {product_id: other, qty: 2, unit_price: 500}]);
  expect([await price(p), await price(other)]).toEqual([18, 500]);
  await voidSale(typo);
  // p returns to the last valid sale; other had no other sale, so it is left as it was.
  expect([await price(p), await price(other)]).toEqual([180000, 500]);
  const later = await sale([{product_id: p, qty: 1, unit_price: 175000}]);
  await voidSale(good);
  expect(await price(p)).toBe(175000); // set by a later sale: untouched by voiding an older one
  await voidSale(later);
  expect(await price(p)).toBe(175000); // no valid sale left: unchanged
});

test('stock sheets save in one statement with the same per-row rules', async () => {
  const worker = await fieldUser();
  const id = await addMission({field: worker.id, day: today, status: 'ongoing', actualStart: at(today, '08:00')});
  const [a, b] = (await pool().query("SELECT id FROM tf_products WHERE brand='BELNCO' AND active=1 ORDER BY id LIMIT 2")).rows.map((r) => r.id);
  const version = async () => (await row('tf_missions', id)).version;
  const sheet = async (mode: string, rows: any[]) => terrain.postTerrain(worker, {action: 'stock-batch', mission_id: id, version: await version(), mode, rows});
  expect(await failure(sheet('closing', [{product_id: a, quantity: 1}]))).toEqual({status: 400, body: {error: 'Renseignez le stock de départ avant le comptage final.'}});
  await sheet('opening', [{product_id: a, quantity: 10}, {product_id: b, quantity: 4}]);
  await pool().query("UPDATE tf_counts SET note='Ancienne note' WHERE mission_id=$1 AND product_id=$2", [id, b]);
  await sheet('opening', [{product_id: a, quantity: 12}]);
  await terrain.postTerrain(worker, {action: 'sale', id: randomUUID(), mission_id: id, lines: [{product_id: a, qty: 3, unit_price: 1000}]});
  expect(await failure(sheet('opening', [{product_id: a, quantity: 2}]))).toEqual({status: 400, body: {error: 'Stock de départ inférieur aux ventes : ' + a}});
  await sheet('closing', [{product_id: a, quantity: 9, note: 'Compté deux fois'}, {product_id: b, quantity: 4}]);
  const counts = Object.fromEntries((await pool().query('SELECT product_id,opening,closing,note FROM tf_counts WHERE mission_id=$1', [id])).rows.map((r) => [r.product_id, r]));
  expect(counts).toEqual({[a]: {product_id: a, opening: 12, closing: 9, note: 'Compté deux fois'}, [b]: {product_id: b, opening: 4, closing: 4, note: 'Ancienne note'}});
  await pool().query("UPDATE tf_missions SET status='completed',report_status='submitted' WHERE id=$1", [id]);
  const locked = await pool().query(`INSERT INTO tf_counts(mission_id,product_id,opening,updated_by,updated_at)
    SELECT $1,r.product_id,1,'x','x' FROM jsonb_to_recordset($2::jsonb) AS r(product_id text)`, [id, JSON.stringify([{product_id: 'antiacne'}])]).then(() => null, (e) => e);
  expect(String(locked?.message)).toContain('REPORT_LOCKED');
});

test('an animatrice’s bonus strip (per-mission lookup) matches the joined aggregation', async () => {
  const worker = await fieldUser();
  const id = await addMission({field: worker.id, day: today, status: 'ongoing', actualStart: at(today, '08:00')});
  const [p] = (await pool().query("SELECT id FROM tf_products WHERE brand='TOUCHE' AND active=1 ORDER BY id LIMIT 1")).rows.map((r) => r.id);
  for (const price of [1000, 2500]) await terrain.postTerrain(worker, {action: 'sale', id: randomUUID(), mission_id: id, lines: [{product_id: p, qty: 2, unit_price: price}]});
  const mine = await terrain.getTerrain(worker, q('action=bonuses'));
  expect(mine.today).toEqual({day: today, tickets: 2, bonus: 10000, revenue: 7000});
  const joined = (await pool().query(`SELECT m.day,COUNT(*)::int AS tickets,SUM(t.bonus_amount)::int AS bonus,SUM(t.total)::int AS revenue
    FROM tf_tickets t JOIN tf_missions m ON m.id=t.mission_id WHERE t.status='valid' AND m.field_id=$1 GROUP BY m.day ORDER BY m.day`, [worker.id])).rows;
  expect(mine.days).toEqual(joined);
  expect((await terrain.getTerrain(manager, q('action=bonuses'))).today.tickets).toBeGreaterThanOrEqual(2);
});

test('concurrent field-note photo uploads to different notes all succeed', async () => {
  const photos = new PhotosService(new StorageService());
  const notes = await Promise.all(Array.from({length: 10}, async () => {
    const id = randomUUID();
    await terrain.postTerrain(manager, {action: 'field-note-create', id, mission_id: null, store_id: null, store_label: '', category: 'shelf',
      product_id: null, brand: '', competitor: '', sentiment: 'neutral', description: 'Rayon à photographier'});
    return id;
  }));
  const requests = await Promise.all(notes.map(photoRequest));
  const results = await Promise.all(requests.map((req) => photos.uploadFieldMedia(manager, req).then((r) => r.ok, (e) => respond(e))));
  expect(results).toEqual(notes.map(() => true));
  expect((await pool().query('SELECT count(*)::int AS n FROM tf_field_photos WHERE note_id = ANY($1)', [notes])).rows[0].n).toBe(10);
}, 30000);

test('reports refuse an oversized range before running the full query', async () => {
  const worker = await fieldUser();
  const wide = '2026-01-14', narrow = '2026-01-15';
  const insertTickets = (mission: string, product: string) => pool().query(`INSERT INTO tf_tickets(id,mission_id,user_id,created_at,lines,total)
    SELECT gen_random_uuid()::text,$1,$2,'2026-01-14T09:00:00.000Z',jsonb_build_array(jsonb_build_object('product_id',${product},'name','Produit','brand','TOUCHE','qty',1,'unit_price',100)),100
    FROM generate_series(1,20001) g`, [mission, worker.id]);
  const many = await addMission({field: worker.id, day: wide, status: 'ongoing', actualStart: at(wide, '08:00')});
  await insertTickets(many, "'p'||g");
  await pool().query("UPDATE tf_missions SET status='completed' WHERE id=$1", [many]);
  const same = await addMission({field: worker.id, day: narrow, status: 'ongoing', actualStart: at(narrow, '08:00')});
  await insertTickets(same, "'antiacne'");
  try {
    expect(await terrain.getTerrain(manager, q(`action=reports&from=${wide}&to=${wide}`))).toEqual({lines: [], truncated: true, from: wide, to: wide});
    const report = await terrain.getTerrain(manager, q(`action=reports&from=${narrow}&to=${narrow}`));
    expect(report.truncated).toBe(false);
    expect(report.lines).toMatchObject([{mission_id: same, product_id: 'antiacne', units: 20001, tickets: 20001}]);
  } finally {
    await pool().query('DELETE FROM tf_tickets WHERE mission_id = ANY($1)', [[many, same]]);
  }
}, 60000);

test('the audit view covers the last 30 days and records changed referential fields without secrets', async () => {
  const old = randomUUID();
  await pool().query(`INSERT INTO tf_audit(id,user_id,at,action,target) VALUES($1,$2,$3,'store.updated','ancien')`, [old, admin.id, new Date(Date.now() - 40 * 86400000).toISOString()]);
  const store = {action: 'store', id: randomUUID(), name: 'Pharmacie auditée', kind: 'pharmacy', city: 'Oran', address: '2 rue des tests', contact: '', notes: '', active: true};
  await terrain.postTerrain(manager, store);
  await pause(3);
  await terrain.postTerrain(manager, {...store, city: 'Blida'});
  const created = randomUUID();
  await terrain.postTerrain(admin, {action: 'user', id: created, username: 'audit-' + created.slice(0, 6), label: 'Compte audité', role: 'field', active: true, password: 'Secret-audit-77'});
  await pause(3);
  await terrain.postTerrain(admin, {action: 'user', id: created, username: 'audit-' + created.slice(0, 6), label: 'Compte audité', role: 'field', active: true, password: 'Secret-audit-88'});
  const view = await terrain.getTerrain(admin, q('action=audit'));
  expect(view.truncated).toBe(false);
  expect(view.events.some((e: any) => e.id === old)).toBe(false);
  const storeEvents = view.events.filter((e: any) => e.target === store.id).map((e: any) => JSON.parse(e.detail));
  expect(storeEvents[0]).toEqual({changes: {city: {from: 'Oran', to: 'Blida'}}});
  expect(storeEvents[1].changes).toMatchObject({name: {from: null, to: 'Pharmacie auditée'}, active: {from: null, to: 1}});
  const userEvents = view.events.filter((e: any) => e.target === created);
  expect(JSON.parse(userEvents[0].detail)).toEqual({role: 'field', active: true, password_reset: true, changes: {}});
  for (const e of userEvents) expect(e.detail).not.toMatch(/Secret-audit|salt|hash|ciphertext/);
  await expect(terrain.getTerrain(manager, q('action=audit'))).rejects.toMatchObject({status: 403});
});

test('migration 0002 applies on a fresh database and on one already at 0001 with data', async () => {
  const url = `postgres://terrain_test@127.0.0.1:${port}/upgrade`;
  await pool().query('CREATE DATABASE upgrade');
  const legacy = join(directory, 'drizzle-0001');
  mkdirSync(join(legacy, 'meta'), {recursive: true});
  const journal = JSON.parse(readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: any) => e.idx <= 1);
  writeFileSync(join(legacy, 'meta/_journal.json'), JSON.stringify(journal));
  for (const e of journal.entries) copyFileSync(join(root, 'drizzle', e.tag + '.sql'), join(legacy, e.tag + '.sql'));
  const before = new Pool({connectionString: url});
  try {
    await migrate(drizzle(before), {migrationsFolder: legacy});
    await before.query(readFileSync(join(root, 'src/db/triggers.sql'), 'utf8'));
    await before.query(`INSERT INTO tf_users(id,username,label,role,salt,password_hash,created_at) VALUES('u1','u1','U','field','00','00','x');
      INSERT INTO tf_stores(id,name,kind,city,address) VALUES('s1','S','pharmacy','Alger','A');
      INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,status,actual_start,created_by,updated_at)
        VALUES('m1','s1','u1','2026-11-01','2026-11-01T07:00:00Z','2026-11-01T09:00:00Z','["TOUCHE"]','ongoing','2026-11-01T07:00:00Z','u1','x');
      INSERT INTO tf_alert_ack(user_id,mission_id,kind,ack_at) VALUES('u1','m1','late_start','x');
      INSERT INTO tf_field_notes(id,author_id,category,description,created_at,updated_at) VALUES('n1','u1','shelf','Note','x','x');
      INSERT INTO tf_field_photos(id,note_id,user_id,object_key,mime,size,created_at) VALUES('f1','n1','u1','k1','image/jpeg',1,'x');
      INSERT INTO tf_photos(id,mission_id,user_id,created_at,mime,size,object_key) VALUES('p1','m1','u1','x','image/jpeg',1,'k2');
      INSERT INTO tf_audit(id,user_id,at,action,target) VALUES('a1','u1','x','t','t');`);
    expect(await before.query("INSERT INTO tf_alert_ack(user_id,mission_id,kind,ack_at) VALUES('u1','m1','missing_end','x')").then(() => 'ok', () => 'refused')).toBe('refused');
    for (let run = 0; run < 2; run++) command(process.execPath, ['src/db/migrate.ts'], {DATABASE_URL: url});
    for (const p of [before, pool()]) {
      const indexes = (await p.query(`SELECT indexname FROM pg_indexes WHERE indexname = ANY($1) ORDER BY indexname`,
        [['tf_audit_at', 'tf_field_photos_note', 'tf_mission_field', 'tf_mission_store', 'tf_photos_mission']])).rows.map((r) => r.indexname);
      expect(indexes).toEqual(['tf_audit_at', 'tf_field_photos_note', 'tf_mission_field', 'tf_mission_store', 'tf_photos_mission']);
      expect((await p.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n)
        .toBe(JSON.parse(readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8')).entries.length);
    }
    await before.query("INSERT INTO tf_alert_ack(user_id,mission_id,kind,ack_at) VALUES('u1','m1','missing_end','x')");
    expect(await before.query("INSERT INTO tf_alert_ack(user_id,mission_id,kind,ack_at) VALUES('u1','m1','bogus','x')").then(() => 'ok', () => 'refused')).toBe('refused');
    const kept = await before.query(`SELECT (SELECT count(*) FROM tf_missions)::int AS m,(SELECT count(*) FROM tf_field_photos)::int AS f,
      (SELECT count(*) FROM tf_photos)::int AS p,(SELECT count(*) FROM tf_audit)::int AS a,(SELECT count(*) FROM tf_alert_ack)::int AS k`);
    expect(kept.rows[0]).toEqual({m: 1, f: 1, p: 1, a: 1, k: 2});
  } finally {
    await before.end();
  }
}, 60000);
