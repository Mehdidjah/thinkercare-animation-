import 'reflect-metadata';
import {afterAll, beforeAll, beforeEach, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {randomBytes, randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {AuthService, COOKIE, DEVICE_COOKIE} from '../src/auth/auth.service';
import {AuthGuard} from '../src/auth/auth.guard';
import {sha, hashNewPassword, passwordHashAsync} from '../src/common/crypto';
import {TerrainService} from '../src/terrain/terrain.service';
import {TerrainController} from '../src/terrain/terrain.controller';
import {OperationsService} from '../src/terrain/operations.service';
import {getPool} from '../src/db/client';
import {sealPassword, openPassword} from '../src/common/password-vault';
import {PhotosService} from '../src/terrain/photos.service';
import {StorageService} from '../src/storage/storage.service';
import {PHOTO_MAX_BYTES} from '../src/terrain/photo-limits';

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

function response() {
  const out = {data: undefined as any, status: undefined as number | undefined, cookies: [] as {name: string; value: string; options: any}[],
    headers: {} as Record<string, string>, res: {} as any};
  out.res = {
    status: (code: number) => {out.status = code; return out.res;},
    json: (value: any) => {out.data = value;},
    cookie: (name: string, value: string, options: any) => {out.cookies.push({name, value, options});},
    setHeader: (key: string, value: string) => {out.headers[key] = value;},
  };
  return out;
}

async function post(body: any, req = request()) {
  const out = response();
  await controller.post({...req, body: JSON.stringify(body)}, out.res);
  const cookie = out.cookies.filter(c => c.name === COOKIE).at(-1);
  return {data: out.data, status: out.status, token: cookie?.value ?? '', cookie: cookie?.options, headers: out.headers,
    device: out.cookies.find(c => c.name === DEVICE_COOKIE)};
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
    STORAGE_DIR: join(directory, 'photos'), S3_BUCKET: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '',
    ADMIN_INITIAL_PASSWORD: initial.direction, SEED_MANAGER_PASSWORD: initial.gestion,
    SEED_FIELD_PASSWORD: initial.animatrice, SEED_DOCTOR_PASSWORD: initial.medecin, SEED_DEMO_DATA: '1'});
  command(process.execPath, ['src/db/migrate.ts']);
  seed();
  const seeded = (await getPool().query('SELECT id,username,salt,password_hash FROM tf_users')).rows;
  for (const row of seeded) expect(row.password_hash).toMatch(/^pbkdf2-sha256\$600000\$[a-f0-9]{64}$/);
  // Production accounts predate the current format: the suite starts from legacy hashes.
  for (const row of seeded) {
    await getPool().query('UPDATE tf_users SET password_hash=$1 WHERE id=$2',
      [await passwordHashAsync(initial[row.username as keyof typeof initial], row.salt), row.id]);
  }
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
  expect((await userRow(fieldId)).password_hash).toMatch(/^pbkdf2-sha256\$600000\$[a-f0-9]{64}$/);
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

test('short passwords work for account creation, admin resets and personal changes', async () => {
  const admin = await login('direction');
  const id = randomUUID();
  await post({action:'user', id, username:'short-password-test', label:'Compte de test', role:'field', active:true, password:'a'}, admin);
  expect((await userRow(id)).password_hash).toMatch(/^pbkdf2-sha256\$600000\$[a-f0-9]{64}$/);
  const created = await post({action:'login', username:'short-password-test', password:'a'});
  expect(created.data.user.id).toBe(id);
  await post(update('b'), admin);
  const field = await login('animatrice', 'b');
  await post({action:'password', current:'b', next:'c'}, field);
  expect((await auth.current(await login('animatrice', 'c'))).force_change).toBe(0);
  expect((await post({action:'user-password', id:fieldId, adminPassword:initial.direction}, admin)).data.password).toBe('c');
  await post({action:'password', current:initial.direction, next:'d'}, admin);
  expect((await auth.current(await login('direction', 'd'))).role).toBe('admin');
});

test('passwords must still be non-empty', async () => {
  const admin = await login('direction');
  const field = await login('animatrice');
  await expect(post({...update(), password:''}, admin)).rejects.toMatchObject({name:'ZodError'});
  await expect(post({action:'password', current:initial.animatrice, next:''}, field)).rejects.toMatchObject({name:'ZodError'});
});

test('mission and field-note photo uploads store 20 MB images and reject larger files', async () => {
  const admin = await auth.current(await login('direction'));
  const storage = new StorageService();
  const photos = new PhotosService(storage);
  const missionId = randomUUID(), noteId = randomUUID();
  const storeId = 'aaaaaaa1-0000-4000-8000-000000000001';
  const now = new Date().toISOString();
  await getPool().query(`INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,status,created_by,updated_at)
    VALUES($1,$2,$3,'2026-11-16','2026-11-16T08:00:00.000Z','2026-11-16T10:00:00.000Z','["TOUCHE"]','ongoing',$4,$5)`, [missionId,storeId,fieldId,admin.id,now]);
  await getPool().query(`INSERT INTO tf_field_notes(id,author_id,category,description,created_at,updated_at)
    VALUES($1,$2,'shelf','Upload boundary test',$3,$3)`, [noteId,admin.id,now]);
  async function uploadRequest(kind: 'mission'|'note', bytes: number) {
    const data = new Uint8Array(bytes); data.set([255,216,255]);
    const form = new FormData();
    form.set(kind==='mission'?'mission_id':'note_id', kind==='mission'?missionId:noteId);
    form.set('photo_id',randomUUID()); form.set('no_person','true');
    form.set('photo',new File([data],'boundary.jpg',{type:'image/jpeg'}));
    const body = new Response(form);
    const contentType = body.headers.get('content-type');
    const stream = Readable.from([Buffer.from(await body.arrayBuffer())]) as any;
    stream.headers={'content-type':contentType};
    return stream;
  }
  for (const kind of ['mission','note'] as const) {
    const upload = kind==='mission' ? photos.uploadPhoto.bind(photos) : photos.uploadFieldMedia.bind(photos);
    const saved = await upload(admin,await uploadRequest(kind,PHOTO_MAX_BYTES));
    expect(saved.ok).toBe(true);
    const table = kind==='mission' ? 'tf_photos' : 'tf_field_photos';
    const stored = (await getPool().query(`SELECT size,object_key FROM ${table} WHERE id=$1`,[saved.id])).rows[0];
    expect(stored.size).toBe(PHOTO_MAX_BYTES);
    const content = await storage.get(stored.object_key);
    let size=0; for await (const chunk of content!) size+=chunk.length;
    expect(size).toBe(PHOTO_MAX_BYTES);
    await expect(upload(admin,await uploadRequest(kind,PHOTO_MAX_BYTES+1))).rejects.toMatchObject({status:413});
  }
},30000);

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

const SESSION_MS = 28800000;
const sessionExpires = async (req: any) =>
  Number((await getPool().query('SELECT expires FROM tf_sessions WHERE token_hash=$1', [sha(req.cookies[COOKIE])])).rows[0]?.expires);
const age = (req: any, expires: number) =>
  getPool().query('UPDATE tf_sessions SET expires=$1 WHERE token_hash=$2', [expires, sha(req.cookies[COOKIE])]);
const userRow = async (id: string) => (await getPool().query('SELECT * FROM tf_users WHERE id=$1', [id])).rows[0];
const forwarded = (ip: string) => ({...request(), headers: {...request().headers, 'x-forwarded-for': `${ip}, 10.0.0.1`}});

test('a session past half its lifetime is extended and its cookie re-sent; a younger one is left alone', async () => {
  const field = await login('animatrice');
  const issued = await sessionExpires(field);
  const young = response();
  await controller.get(field, young.res);
  expect(young.data.user.id).toBe(fieldId);
  expect(young.cookies).toEqual([]);
  expect(await sessionExpires(field)).toBe(issued);

  const guard = new AuthGuard(auth);
  const context = (req: any, res: any) => ({switchToHttp: () => ({getRequest: () => req, getResponse: () => res})}) as any;
  for (const via of ['get', 'guard', 'post'] as const) {
    await age(field, Date.now() + SESSION_MS / 2 - 60000);
    const before = Date.now();
    const out = response();
    if (via === 'get') await controller.get(field, out.res);
    else if (via === 'guard') expect(await guard.canActivate(context(field, out.res))).toBe(true);
    else await expect(controller.post({...field, body: JSON.stringify({action: 'password', current: 'incorrect', next: password()})}, out.res)).rejects.toMatchObject({status: 400});
    expect(out.cookies).toEqual([{name: COOKIE, value: field.cookies[COOKIE],
      options: {httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: SESSION_MS}}]);
    expect(await sessionExpires(field)).toBeGreaterThanOrEqual(before + SESSION_MS);
  }
  expect(young.data.user).not.toHaveProperty('expires');
  expect(await auth.current(field)).not.toHaveProperty('expires');

  await age(field, Date.now() - 1000);
  const late = response();
  await expect(auth.current(field, late.res)).rejects.toMatchObject({status: 401});
  expect(late.cookies).toEqual([]);
  expect(await sessionExpires(field)).toBeLessThan(Date.now());
});

test('logout answers 200 and clears the cookie and cache with or without a valid session', async () => {
  const expired = await login('animatrice');
  await age(expired, Date.now() - 1000);
  const revoked = request('f'.repeat(64));
  for (const req of [request(), expired, revoked, {...request(), cookies: {}}]) {
    const out = await post({action: 'logout'}, req);
    expect(out.status).toBe(200);
    expect(out.data).toEqual({ok: true});
    expect(out.headers['Clear-Site-Data']).toBe('"cache"');
    expect(out.token).toBe('');
    expect(out.cookie).toMatchObject({httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 0});
  }
  expect(await sessionExpires(expired)).toBeNaN();
  const live = await login('animatrice');
  const other = await login('animatrice');
  await post({action: 'logout'}, live);
  await expect(auth.current(live)).rejects.toMatchObject({status: 401});
  expect((await auth.current(other)).id).toBe(fieldId);
  await expect(post({action: 'logout'}, {...live, headers: {...live.headers, origin: 'https://elsewhere.test'}})).rejects.toMatchObject({status: 403});
});

test('failed logins are throttled per username whatever the forwarded IP; successes do not count', async () => {
  const attempt = (username: string, value: string, i: number) => post({action: 'login', username, password: value}, forwarded(`198.51.100.${i}`));
  for (let i = 0; i < 12; i++) await attempt('animatrice', initial.animatrice, i);
  for (let i = 0; i < 9; i++) await expect(attempt('animatrice', 'incorrect', 20 + i)).rejects.toMatchObject({status: 401});
  await attempt('animatrice', initial.animatrice, 40);
  await expect(attempt('animatrice', 'incorrect', 41)).rejects.toMatchObject({status: 401});
  await expect(attempt('animatrice', initial.animatrice, 42)).rejects.toMatchObject({status: 429});
  await expect(attempt('ANIMATRICE', initial.animatrice, 43)).rejects.toMatchObject({status: 429});
  await expect(post({action: 'login', username: 'animatrice', password: initial.animatrice})).rejects.toMatchObject({status: 429});
  expect((await attempt('gestion', initial.gestion, 44)).data.user.username).toBe('gestion');
  for (let i = 0; i < 10; i++) await expect(attempt('nobody', 'incorrect', 50 + i)).rejects.toMatchObject({status: 401});
  await expect(attempt('nobody', 'incorrect', 60)).rejects.toMatchObject({status: 429});
  expect((await getPool().query("SELECT * FROM tf_audit WHERE action='auth.login_failed'")).rowCount).toBe(10);
}, 30000);

test('guesses from elsewhere cannot lock the real user out of a browser they already logged in from', async () => {
  const known = await post({action: 'login', username: 'animatrice', password: initial.animatrice});
  expect(known.device!.value).toMatch(/^[a-f0-9]{32}\.[a-f0-9]{64}$/);
  expect(known.device!.options).toEqual({httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 365 * 86400000});
  const fromDevice = (value: string, device = known.device!.value) =>
    post({action: 'login', username: 'animatrice', password: value}, {...forwarded('203.0.113.9'), cookies: {[DEVICE_COOKIE]: device}});
  for (let i = 0; i < 10; i++)
    await expect(post({action: 'login', username: 'animatrice', password: 'incorrect'}, forwarded(`198.51.100.${i}`))).rejects.toMatchObject({status: 401});
  await expect(post({action: 'login', username: 'animatrice', password: initial.animatrice}, forwarded('198.51.100.99'))).rejects.toMatchObject({status: 429});
  expect((await fromDevice(initial.animatrice)).data.user.username).toBe('animatrice');
  // Forged or tampered cookies, and another account's, get no exemption.
  const [nonce, mac] = known.device!.value.split('.');
  for (const forged of ['0'.repeat(32) + '.' + mac, nonce + '.' + '0'.repeat(64), 'garbage'])
    await expect(fromDevice(initial.animatrice, forged)).rejects.toMatchObject({status: 429});
  const manager = await post({action: 'login', username: 'gestion', password: initial.gestion});
  await expect(fromDevice(initial.animatrice, manager.device!.value)).rejects.toMatchObject({status: 429});
  // The known browser has its own allowance of 10 failed attempts.
  for (let i = 0; i < 10; i++) await expect(fromDevice('incorrect')).rejects.toMatchObject({status: 401});
  await expect(fromDevice(initial.animatrice)).rejects.toMatchObject({status: 429});
}, 30000);

test('a legacy hash still logs in and is upgraded to the current format, keeping the saved copy', async () => {
  const before = await userRow(fieldId);
  expect(before.password_hash).toMatch(/^[a-f0-9]{64}$/);
  await login('animatrice');
  const after = await userRow(fieldId);
  expect(after.password_hash).toMatch(/^pbkdf2-sha256\$600000\$[a-f0-9]{64}$/);
  expect(after.salt).not.toBe(before.salt);
  expect(after.password_ciphertext).toBe(before.password_ciphertext);
  await login('animatrice');
  expect((await userRow(fieldId)).password_hash).toBe(after.password_hash);
  await expect(login('animatrice', 'incorrect')).rejects.toMatchObject({status: 401});
  const admin = await login('direction');
  expect((await userRow(adminId)).password_hash).toMatch(/^pbkdf2-sha256\$600000\$/);
  expect((await post({action: 'user-password', id: fieldId, adminPassword: initial.direction}, admin)).data.password).toBe(initial.animatrice);
});

test('logins and failed attempts on existing accounts are audited without credentials', async () => {
  await login('animatrice');
  await expect(login('animatrice', 'Wrong-secret-1')).rejects.toMatchObject({status: 401});
  await expect(post({action: 'login', username: 'nobody', password: 'Wrong-secret-2'})).rejects.toMatchObject({status: 401});
  await getPool().query('UPDATE tf_users SET active=0 WHERE id=$1', [fieldId]);
  await expect(login('animatrice')).rejects.toMatchObject({status: 401});
  const events = (await getPool().query('SELECT user_id,action,target,detail FROM tf_audit ORDER BY at')).rows;
  expect(events).toEqual([
    {user_id: fieldId, action: 'auth.login', target: fieldId, detail: {ip: '127.0.0.1'}},
    {user_id: fieldId, action: 'auth.login_failed', target: fieldId, detail: {ip: '127.0.0.1'}},
    {user_id: fieldId, action: 'auth.login_failed', target: fieldId, detail: {ip: '127.0.0.1'}},
  ]);
  for (const secret of [initial.animatrice, 'Wrong-secret-1', 'Wrong-secret-2']) expect(JSON.stringify(events)).not.toContain(secret);
});

test('password change and admin reveal accept both legacy and current hashes', async () => {
  const admin = await login('direction');
  const field = await login('animatrice');
  const legacy = (id: string) => {
    const row = baseline.find(r => r.id === id);
    return getPool().query('UPDATE tf_users SET salt=$1,password_hash=$2 WHERE id=$3', [row.salt, row.password_hash, id]);
  };
  const reveal = (value: string) => post({action: 'user-password', id: fieldId, adminPassword: value}, admin);
  const first = password(), second = password();

  await expect(reveal('incorrect')).rejects.toMatchObject({status: 403});
  expect((await reveal(initial.direction)).data.password).toBe(initial.animatrice);
  await expect(post({action: 'password', current: 'incorrect', next: first}, field)).rejects.toMatchObject({status: 400});
  await post({action: 'password', current: initial.animatrice, next: first}, field);
  expect((await userRow(fieldId)).password_hash).toMatch(/^pbkdf2-sha256\$600000\$/);

  await legacy(adminId);
  await legacy(fieldId);
  await expect(reveal('incorrect')).rejects.toMatchObject({status: 403});
  expect((await reveal(initial.direction)).data.password).toBe(first);
  await expect(post({action: 'password', current: 'incorrect', next: second}, field)).rejects.toMatchObject({status: 400});
  await post({action: 'password', current: initial.animatrice, next: second}, field);
  expect((await userRow(fieldId)).password_hash).toMatch(/^pbkdf2-sha256\$600000\$/);
  await login('animatrice', second);
  expect((await reveal(initial.direction)).data.password).toBe(second);

  const {salt, hash} = await hashNewPassword(initial.direction);
  await getPool().query('UPDATE tf_users SET salt=$1,password_hash=$2 WHERE id=$3', [salt, hash, adminId]);
  await post({action: 'password', current: initial.direction, next: first}, admin);
  expect((await auth.current(await login('direction', first))).role).toBe('admin');
});
