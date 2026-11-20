import 'reflect-metadata';
import {afterAll, beforeAll, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {randomBytes, randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {TerrainService} from '../src/terrain/terrain.service';
import {OperationsService} from '../src/terrain/operations.service';
import {HttpExceptionFilter} from '../src/common/http-exception.filter';
import {getPool} from '../src/db/client';
import {caseReasons, reasonLabel} from '../src/domain/operations';
import {type User} from '../src/domain/core';

// Up to three reasons per complaint or request, through the real services on a
// disposable local Postgres cluster like data.test.ts. Never touches a configured
// or production database.
const root = join(import.meta.dir, '..');
const directory = mkdtempSync(join(tmpdir(), 'terrain-reasons-tests-'));
const cluster = join(directory, 'pg');
const secret = () => 'Test-only-' + randomUUID();
const terrain = new TerrainService(new OperationsService());
const saved = {...process.env};
let started = false;
let port = 0;
let manager: User, field: User, doctor: User;

const pool = () => getPool();
const q = (s: string) => new URLSearchParams(s);
const refused = {status: 400, body: {error: 'Sélectionnez entre 1 et 3 motifs valides.'}};
const consent = {status: 400, body: {error: 'La transmission anonymisée au médecin doit être acceptée.'}};
const body = (o: Record<string, unknown>) => ({action: 'service-create', id: randomUUID(), mission_id: null, store_id: null, store_label: '',
  kind: 'complaint', channel: 'onsite', product_id: null, lot: '', code: '', priority: 'normal', description: 'Description assez longue', consent: false, due_day: '', ...o});
const stored = async (id: string) => (await pool().query('SELECT reason,reasons,category FROM tf_cases WHERE id=$1', [id])).rows[0];
const cases = async () => (await pool().query('SELECT count(*)::int AS n FROM tf_cases')).rows[0].n;

function command(program: string, args: string[], env: Record<string, string | undefined> = {}) {
  const result = spawnSync(program, args, {cwd: root, env: {...process.env, ...env}, encoding: 'utf8', timeout: 60000});
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return result.stdout + result.stderr;
}

async function account(username: string): Promise<User> {
  return (await pool().query('SELECT id,username,label,role,active,force_change FROM tf_users WHERE username=$1', [username])).rows[0];
}

/** Creates a case as `u` and returns its id. */
async function create(u: User, o: Record<string, unknown>) {
  const b = body(o);
  expect(await terrain.postTerrain(u, b)).toEqual({ok: true, id: b.id});
  return b.id;
}

/** Runs the real global exception filter and returns what the client would receive. */
function respond(e: unknown) {
  let status = 0;
  let body: any;
  const res = {headersSent: false, setHeader() {}, status(s: number) { status = s; return res; }, json(b: any) { body = b; }};
  const req = {method: 'POST', originalUrl: '/api/terrain', query: {}, body: ''};
  new HttpExceptionFilter().catch(e, {switchToHttp: () => ({getResponse: () => res, getRequest: () => req})} as any);
  return {status, body};
}

async function failure(p: Promise<unknown>) {
  const e = await p.then(() => { throw new Error('expected a failure'); }, (x) => x);
  return respond(e);
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
    ADMIN_INITIAL_PASSWORD: secret(), SEED_MANAGER_PASSWORD: secret(), SEED_FIELD_PASSWORD: secret(), SEED_DOCTOR_PASSWORD: secret()});
  command(process.execPath, ['src/db/migrate.ts']);
  expect(command(process.execPath, ['src/db/seed.ts'])).toContain('Seed complete');
  [manager, field, doctor] = await Promise.all(['gestion', 'animatrice', 'medecin'].map(account));
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

test('one, two or three reasons are stored in selection order, the first one as the main reason', async () => {
  const one = await create(field, {reasons: ['price']});
  const two = await create(field, {reasons: ['expiry', 'price']});
  const three = await create(field, {reasons: ['delivery', 'damaged', 'other']});
  const request = await create(field, {kind: 'request', reasons: ['training', 'restock', 'other']});
  expect(await stored(one)).toEqual({reason: 'price', reasons: 'price', category: 'commercial'});
  expect(await stored(two)).toEqual({reason: 'expiry', reasons: 'expiry,price', category: 'quality'});
  expect(await stored(three)).toEqual({reason: 'delivery', reasons: 'delivery,damaged,other', category: 'quality'});
  expect(await stored(request)).toEqual({reason: 'training', reasons: 'training,restock,other', category: 'commercial'});

  const list = (await terrain.getTerrain(field, q('action=service-list'))).cases;
  const listed = (id: string) => list.find((c: any) => c.id === id);
  expect(listed(three)).toMatchObject({reason: 'delivery', reasons: 'delivery,damaged,other', category: 'quality'});
  expect(reasonLabel(listed(three))).toBe('Commande ou livraison · Produit abîmé ou fuite · Autre — préciser');
  expect(reasonLabel(listed(one))).toBe('Prix ou promotion');
  expect(reasonLabel(listed(request))).toBe('Formation de l’équipe pharmacie · Réassort ou commande · Autre — préciser');
  const detail = (await terrain.getTerrain(field, q('action=service-detail&id=' + two))).case;
  expect(detail).toMatchObject({reason: 'expiry', reasons: 'expiry,price', description: 'Description assez longue'});
  expect(caseReasons(detail)).toEqual(['expiry', 'price']);

  const audit = (await pool().query("SELECT detail FROM tf_audit WHERE target=$1 AND action='service.created'", [three])).rows;
  expect(audit).toEqual([{detail: {kind: 'complaint', reasons: ['delivery', 'damaged', 'other']}}]);
});

test('refused: no reason, more than three, duplicates, unknown or inherited keys, or another kind’s reasons', async () => {
  const before = await cases();
  for (const reasons of [[], ['price', 'damaged', 'expiry', 'delivery'], ['price', 'price'], ['price', 'nope'], ['toString'], ['price', '__proto__'], ['constructor'], ['']])
    expect(await failure(terrain.postTerrain(field, body({reasons})))).toEqual(refused);
  // Complaint reasons are not request reasons, and the other way round.
  for (const reasons of [['packaging'], ['restock', 'tolerance'], ['price']])
    expect(await failure(terrain.postTerrain(field, body({kind: 'request', reasons})))).toEqual(refused);
  expect(await failure(terrain.postTerrain(field, body({reasons: ['restock']})))).toEqual(refused);
  expect(await failure(terrain.postTerrain(field, body({})))).toEqual(refused);
  // Sent together, `reasons` wins over the single `reason`.
  expect(await failure(terrain.postTerrain(field, body({reason: 'price', reasons: []})))).toEqual(refused);
  expect(await failure(terrain.postTerrain(field, body({reason: 'nope', reasons: ['price', 'nope']})))).toEqual(refused);
  expect(await failure(terrain.postTerrain(field, body({reasons: 'price'})))).toMatchObject({status: 400});
  expect(await cases()).toBe(before);
});

test('any tolerance reason makes the case a confidential tolerance case and needs consent; otherwise quality wins over commercial', async () => {
  const before = await cases();
  for (const reasons of [['tolerance'], ['price', 'tolerance'], ['packaging', 'service', 'tolerance']])
    expect(await failure(terrain.postTerrain(field, body({reasons})))).toEqual(consent);
  expect(await cases()).toBe(before);

  const id = await create(field, {reasons: ['price', 'tolerance'], consent: true, description: 'Rougeurs après application'});
  expect(await stored(id)).toEqual({reason: 'price', reasons: 'price,tolerance', category: 'tolerance'});
  const read = async (u: User) => (await terrain.getTerrain(u, q('action=service-detail&id=' + id))).case;
  // Visibility is unchanged: the description stays with the author and the doctors.
  expect((await read(manager)).description).toBeUndefined();
  expect(await read(manager)).toMatchObject({category: 'tolerance', reasons: 'price,tolerance'});
  expect((await read(doctor)).description).toBe('Rougeurs après application');
  expect((await read(field)).description).toBe('Rougeurs après application');
  expect((await terrain.getTerrain(doctor, q('action=service-list'))).cases.some((c: any) => c.id === id)).toBe(true);

  expect(await stored(await create(field, {reasons: ['price', 'service']}))).toMatchObject({category: 'commercial'});
  expect(await stored(await create(field, {reasons: ['availability', 'texture', 'service']}))).toMatchObject({category: 'quality'});
  expect(await stored(await create(doctor, {reasons: ['packaging']}))).toMatchObject({category: 'quality'});
});

test('an app opened before the update still sends a single reason', async () => {
  const id = await create(field, {reason: 'price'});
  expect(await stored(id)).toEqual({reason: 'price', reasons: 'price', category: 'commercial'});
  expect(await stored(await create(field, {kind: 'request', reason: 'restock'}))).toEqual({reason: 'restock', reasons: 'restock', category: 'commercial'});
  expect(await failure(terrain.postTerrain(field, body({reason: 'tolerance'})))).toEqual(consent);
  for (const reason of ['nope', 'toString', ''])
    expect(await failure(terrain.postTerrain(field, body({reason})))).toEqual(refused);
  const both = await create(field, {reason: 'price', reasons: ['damaged', 'service']});
  expect(await stored(both)).toEqual({reason: 'damaged', reasons: 'damaged,service', category: 'quality'});
  const audit = (await pool().query("SELECT detail FROM tf_audit WHERE target=$1 AND action='service.created'", [id])).rows;
  expect(audit).toEqual([{detail: {kind: 'complaint', reasons: ['price']}}]);
});

test('migration 0004 applies on a database already at 0003 with cases, and backfills their reasons', async () => {
  const url = `postgres://terrain_test@127.0.0.1:${port}/upgrade_reasons`;
  await pool().query('CREATE DATABASE upgrade_reasons');
  const legacy = join(directory, 'drizzle-0003');
  mkdirSync(join(legacy, 'meta'), {recursive: true});
  const journal = JSON.parse(readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8'));
  const total = journal.entries.length;
  expect(journal.entries.find((e: any) => e.idx === 4)?.tag).toBe('0004_multi_reason');
  journal.entries = journal.entries.filter((e: any) => e.idx <= 3);
  writeFileSync(join(legacy, 'meta/_journal.json'), JSON.stringify(journal));
  for (const e of journal.entries) copyFileSync(join(root, 'drizzle', e.tag + '.sql'), join(legacy, e.tag + '.sql'));
  const before = new Pool({connectionString: url});
  try {
    await migrate(drizzle(before), {migrationsFolder: legacy});
    await before.query(readFileSync(join(root, 'src/db/triggers.sql'), 'utf8'));
    await before.query(`INSERT INTO tf_users(id,username,label,role,salt,password_hash,created_at) VALUES('u1','u1','U','field','00','00','x');
      INSERT INTO tf_cases(id,author_id,kind,reason,category,description,created_at,updated_at) VALUES
        ('c1','u1','complaint','price','commercial','Prix affiché différent','2026-11-01T08:00:00.000Z','x'),
        ('c2','u1','complaint','tolerance','tolerance','Rougeurs après application','2026-11-02T08:00:00.000Z','x'),
        ('c3','u1','request','restock','commercial','Réassort avant la promotion','2026-11-03T08:00:00.000Z','x');
      INSERT INTO tf_case_events(id,case_id,user_id,at,status) VALUES('e1','c1','u1','x','new');`);
    expect(await before.query('SELECT reasons FROM tf_cases').then(() => 'ok', () => 'missing')).toBe('missing');
    for (let run = 0; run < 2; run++) command(process.execPath, ['src/db/migrate.ts'], {DATABASE_URL: url});
    for (const p of [before, pool()]) {
      const columns = (await p.query(`SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns
        WHERE table_name='tf_cases' AND column_name='reasons'`)).rows;
      expect(columns).toEqual([{column_name: 'reasons', data_type: 'text', is_nullable: 'NO', column_default: "''::text"}]);
      expect((await p.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n).toBe(total);
    }
    const rows = (await before.query('SELECT id,kind,reason,reasons,category FROM tf_cases ORDER BY id')).rows;
    expect(rows.map((c) => [c.id, c.reason, c.reasons, c.category])).toEqual([
      ['c1', 'price', 'price', 'commercial'], ['c2', 'tolerance', 'tolerance', 'tolerance'], ['c3', 'restock', 'restock', 'commercial']]);
    expect(rows.map(reasonLabel)).toEqual(['Prix ou promotion', 'Réaction ou problème de tolérance', 'Réassort ou commande']);
    const kept = await before.query(`SELECT (SELECT count(*) FROM tf_case_events)::int AS e,(SELECT count(*) FROM tf_users)::int AS u`);
    expect(kept.rows[0]).toEqual({e: 1, u: 1});
    // A row written by an API still on the previous version (no reasons) reads as its single reason.
    await before.query(`INSERT INTO tf_cases(id,author_id,kind,reason,category,description,created_at,updated_at) VALUES('c4','u1','complaint','damaged','quality','Flacon fissuré','x','x')`);
    const late = (await before.query("SELECT kind,reason,reasons FROM tf_cases WHERE id='c4'")).rows[0];
    expect(late.reasons).toBe('');
    expect(caseReasons(late)).toEqual(['damaged']);
    expect(reasonLabel(late)).toBe('Produit abîmé ou fuite');
  } finally {
    await before.end();
  }
}, 60000);
