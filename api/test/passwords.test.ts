import 'reflect-metadata';
import {afterAll, beforeAll, beforeEach, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {randomBytes, randomUUID} from 'node:crypto';
import {AuthService, COOKIE} from '../src/auth/auth.service';
import {TerrainService} from '../src/terrain/terrain.service';
import {TerrainController} from '../src/terrain/terrain.controller';
import {OperationsService} from '../src/terrain/operations.service';
import {getPool} from '../src/db/client';
import {sealPassword, openPassword} from '../src/common/password-vault';

// Always starts a disposable local Postgres cluster. Never connects to the
// developer's DATABASE_URL, Railway, or a shared database.
const root = join(import.meta.dir, '..');
const directory = mkdtempSync(join(tmpdir(), 'terrain-password-tests-'));
const cluster = join(directory, 'pg');
const password = () => 'Test-only-' + randomUUID();
const initial = {direction: password(), gestion: password(), animatrice: password(), medecin: password()};
const fieldId = '22222222-2222-4222-8222-222222222222';
const adminId = '09d4ed63-862d-4224-8644-12fb416f590f';
const auth = new AuthService();
const terrain = new TerrainService(new OperationsService());
const controller = new TerrainController(auth, terrain);
let started = false;
let baseline: any[] = [];

function command(program: string, args: string[]) {
  const result = spawnSync(program, args, {cwd: root, env: process.env, encoding: 'utf8', timeout: 30000});
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return result.stdout + result.stderr;
}

function seed() {
  const output = command(process.execPath, ['src/db/seed.ts']);
  expect(output).toContain('Seed complete');
  for (const value of Object.values(initial)) expect(output).not.toContain(value);
}

function request(token = ''): any {
  return {cookies: {[COOKIE]: token}, headers: {origin: 'https://terrain.test', 'content-type': 'application/json'},
    protocol: 'https', ip: '127.0.0.1', get: () => 'terrain.test', originalUrl: '/api/terrain'};
}

async function post(body: any, req = request()) {
  let data: any;
  let token = '';
  const headers: Record<string, string> = {};
  await controller.post({...req, body: JSON.stringify(body)}, {
    json: (value: any) => {data = value;},
    cookie: (_name: string, value: string) => {token = value;},
    setHeader: (key: string, value: string) => {headers[key] = value;},
  } as any);
  return {data, token, headers};
}

async function login(username: keyof typeof initial, value = initial[username]) {
  const response = await post({action: 'login', username, password: value});
  return request(response.token);
}

const update = (value?: string, active = true) => ({action: 'user', id: fieldId, username: 'animatrice',
  label: 'Animatrice personnalisée', role: 'field', active, ...(value ? {password: value} : {})});

beforeAll(async () => {
  const listener = createServer();
  const port = await new Promise<number>(resolve => listener.listen(0, '127.0.0.1', () => resolve((listener.address() as any).port)));
  await new Promise<void>(resolve => listener.close(() => resolve()));
  command('initdb', ['-D', cluster, '--auth=trust', '--no-locale', '--encoding=UTF8', '-U', 'terrain_test']);
  command('pg_ctl', ['-D', cluster, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${directory}`, '-w', 'start']);
  started = true;
  Object.assign(process.env, {DATABASE_URL: `postgres://terrain_test@127.0.0.1:${port}/postgres`,
    DATABASE_SSL: 'false', PGSSLMODE: 'disable', ACCOUNT_PASSWORD_KEY: randomBytes(32).toString('hex'),
    ADMIN_INITIAL_PASSWORD: initial.direction, SEED_MANAGER_PASSWORD: initial.gestion,
    SEED_FIELD_PASSWORD: initial.animatrice, SEED_DOCTOR_PASSWORD: initial.medecin});
  command(process.execPath, ['src/db/migrate.ts']);
  seed();
  baseline = (await getPool().query('SELECT * FROM tf_users')).rows;
}, 60000);

beforeEach(async () => {
  await getPool().query('DELETE FROM tf_sessions; DELETE FROM tf_throttle; DELETE FROM tf_audit');
  for (const row of baseline) {
    await getPool().query('UPDATE tf_users SET label=$1,active=1,salt=$2,password_hash=$3,password_ciphertext=$4,force_change=0 WHERE id=$5',
      [row.label, row.salt, row.password_hash, row.password_ciphertext, row.id]);
  }
});

afterAll(async () => {
  if (started) {
    await getPool().end();
    command('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop']);
  }
  rmSync(directory, {recursive: true, force: true});
});

test('personal password survives startup, authenticates, and is visible only through the admin endpoint', async () => {
  const field = await login('animatrice');
  const other = await login('animatrice');
  await getPool().query('UPDATE tf_users SET force_change=1 WHERE id=$1', [fieldId]);
  const next = password();
  await post({action: 'password', current: initial.animatrice, next}, field);
  expect((await auth.current(field)).force_change).toBe(0);
  await expect(auth.current(other)).rejects.toMatchObject({status: 401});
  seed();
  await login('animatrice', next);
  await expect(login('animatrice')).rejects.toMatchObject({status: 401});
  const admin = await login('direction');
  const response = await post({action: 'user-password', id: fieldId, adminPassword: initial.direction}, admin);
  expect(response.data.password).toBe(next);
  expect(response.headers['Cache-Control']).toBe('no-store');
  const row = (await getPool().query('SELECT * FROM tf_users WHERE id=$1', [fieldId])).rows[0];
  expect(JSON.stringify(row)).not.toContain(next);
  expect(row.force_change).toBe(0);
  for (const req of [admin, field, await login('gestion'), await login('medecin')]) {
    const data = await terrain.getTerrain(await auth.current(req), new URLSearchParams());
    expect(JSON.stringify(data)).not.toContain(next);
    expect(JSON.stringify(data)).not.toContain('password_ciphertext');
    expect(JSON.stringify(data)).not.toContain('password_hash');
  }
  const events = (await getPool().query('SELECT * FROM tf_audit')).rows;
  expect(events.some(row => row.action === 'account.password_viewed')).toBe(true);
  expect(JSON.stringify(events)).not.toContain(next);
  expect(JSON.stringify(events)).not.toContain(initial.direction);
});

test('login supplies role-scoped startup data in one response without credential material', async () => {
  for (const username of Object.keys(initial) as (keyof typeof initial)[]) {
    const response = await post({action: 'login', username, password: initial[username]});
    expect(response.data.user.username).toBe(username);
    expect(Array.isArray(response.data.products)).toBe(true);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(JSON.stringify(response.data)).not.toContain(initial[username]);
    expect(JSON.stringify(response.data)).not.toContain('password_hash');
    expect(JSON.stringify(response.data)).not.toContain('password_ciphertext');
    if (username === 'animatrice' || username === 'medecin') expect(response.data.users).toEqual([]);
  }
  await getPool().query('UPDATE tf_users SET force_change=1 WHERE id=$1', [fieldId]);
  const required = await post({action: 'login', username: 'animatrice', password: initial.animatrice});
  expect(required.data.user.force_change).toBe(1);
  expect(required.data.products).toEqual([]);
  expect(required.data.stores).toEqual([]);
});

test('admin reset replaces the saved password, revokes sessions and survives startup', async () => {
  const field = await login('animatrice');
  const admin = await login('direction');
  const temporary = password();
  await post(update(temporary), admin);
  await expect(auth.current(field)).rejects.toMatchObject({status: 401});
  seed();
  const resetLogin = await login('animatrice', temporary);
  expect((await auth.current(resetLogin)).force_change).toBe(1);
  expect((await post({action: 'user-password', id: fieldId, adminPassword: initial.direction}, admin)).data.password).toBe(temporary);
  await expect(post({action: 'user-password', id: fieldId, adminPassword: initial.direction}, resetLogin)).rejects.toMatchObject({status: 403});
  const personal = password();
  await post({action: 'password', current: temporary, next: personal}, resetLogin);
  expect((await post({action: 'user-password', id: fieldId, adminPassword: initial.direction}, admin)).data.password).toBe(personal);
  await expect(login('animatrice', temporary)).rejects.toMatchObject({status: 401});
  await post(update(), admin);
  await login('animatrice', personal);
  expect((await getPool().query("SELECT detail FROM tf_audit WHERE action='account.updated' ORDER BY at LIMIT 1")).rows[0].detail.password_reset).toBe(true);
});

test('startup preserves deactivation and admin-required password changes', async () => {
  const admin = await login('direction');
  await post(update(undefined, false), admin);
  await getPool().query('UPDATE tf_users SET force_change=1 WHERE id=$1', [adminId]);
  seed();
  const rows = (await getPool().query('SELECT id,active,force_change,label FROM tf_users')).rows;
  expect(rows.find(row => row.id === fieldId)).toMatchObject({active: 0, label: 'Animatrice personnalisée'});
  expect(rows.find(row => row.id === adminId).force_change).toBe(1);
  await expect(login('animatrice')).rejects.toMatchObject({status: 401});
});

test('all non-admin roles are blocked from reading and resetting passwords', async () => {
  for (const role of ['gestion', 'animatrice', 'medecin'] as const) {
    const req = await login(role);
    await expect(post({action: 'user-password', id: fieldId, adminPassword: initial.direction}, req)).rejects.toMatchObject({status: 403});
    await expect(post(update(password()), req)).rejects.toMatchObject({status: 403});
  }
  await expect(post({action: 'user-password', id: fieldId, adminPassword: initial.direction})).rejects.toMatchObject({status: 401});
});

test('admin reveal requires their correct password and cannot reveal admin credentials', async () => {
  const admin = await login('direction');
  await expect(post({action: 'user-password', id: fieldId, adminPassword: 'incorrect'}, admin)).rejects.toMatchObject({status: 403});
  await expect(post({action: 'user-password', id: adminId, adminPassword: initial.direction}, admin)).rejects.toMatchObject({status: 403});
  expect((await getPool().query("SELECT * FROM tf_audit WHERE action='account.password_viewed'")).rowCount).toBe(0);
});

test('reveal throttling is bound to the admin account, independent of forwarded IP', async () => {
  const admin = await login('direction');
  for (let i = 0; i < 10; i++) {
    admin.headers['x-forwarded-for'] = `192.0.2.${i}`;
    await expect(post({action: 'user-password', id: fieldId, adminPassword: 'incorrect'}, admin)).rejects.toMatchObject({status: 403});
  }
  await expect(post({action: 'user-password', id: fieldId, adminPassword: initial.direction}, admin)).rejects.toMatchObject({status: 429});
});

test('legacy hash-only accounts remain usable and return no invented password', async () => {
  await getPool().query('UPDATE tf_users SET password_ciphertext=NULL WHERE id=$1', [fieldId]);
  const admin = await login('direction');
  expect((await post({action: 'user-password', id: fieldId, adminPassword: initial.direction}, admin)).data.password).toBeNull();
  const req = await login('animatrice');
  const next = password();
  await post({action: 'password', current: initial.animatrice, next}, req);
  expect((await post({action: 'user-password', id: fieldId, adminPassword: initial.direction}, admin)).data.password).toBe(next);
});

test('failed audit write rolls back password, encrypted copy and session revocation together', async () => {
  const field = await login('animatrice');
  const other = await login('animatrice');
  const next = password();
  await getPool().query("ALTER TABLE tf_audit ADD CONSTRAINT test_reject_password CHECK (action <> 'account.password')");
  try {
    await expect(post({action: 'password', current: initial.animatrice, next}, field)).rejects.toBeDefined();
  } finally {
    await getPool().query('ALTER TABLE tf_audit DROP CONSTRAINT test_reject_password');
  }
  await auth.current(other);
  await login('animatrice');
  await expect(login('animatrice', next)).rejects.toMatchObject({status: 401});
  const admin = await login('direction');
  expect((await post({action: 'user-password', id: fieldId, adminPassword: initial.direction}, admin)).data.password).toBe(initial.animatrice);
});

test('incorrect current password and missing encryption key leave credentials intact', async () => {
  const req = await login('animatrice');
  await expect(post({action: 'password', current: 'incorrect', next: password()}, req)).rejects.toMatchObject({status: 400});
  const key = process.env.ACCOUNT_PASSWORD_KEY;
  try {
    delete process.env.ACCOUNT_PASSWORD_KEY;
    await expect(post({action: 'password', current: initial.animatrice, next: password()}, req)).rejects.toMatchObject({status: 503});
  } finally { process.env.ACCOUNT_PASSWORD_KEY = key; }
  await login('animatrice');
});

test('encrypted passwords reject tampering and ciphertext moved to another user', () => {
  const value = password();
  const sealed = sealPassword(fieldId, value);
  expect(openPassword(fieldId, sealed)).toBe(value);
  expect(sealPassword(fieldId, value)).not.toBe(sealed);
  expect(() => openPassword(adminId, sealed)).toThrow();
  const parts = sealed.split('.');
  const data = Buffer.from(parts[3], 'base64url');
  data[0] ^= 1;
  parts[3] = data.toString('base64url');
  expect(() => openPassword(fieldId, parts.join('.'))).toThrow();
});
