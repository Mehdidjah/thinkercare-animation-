import 'reflect-metadata';
import {afterAll, beforeAll, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
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
import {clock, clockIssue, dayInAlger, midwayTime, shiftDay, type User} from '../src/domain/core';

// The middle photo through the real services, on a disposable local Postgres
// cluster like data.test.ts. Never touches a configured or production database.
const root = join(import.meta.dir, '..');
const directory = mkdtempSync(join(tmpdir(), 'terrain-midway-tests-'));
const cluster = join(directory, 'pg');
const storage = join(directory, 'photos');
const secret = () => 'Test-only-' + randomUUID();
const terrain = new TerrainService(new OperationsService());
const saved = {...process.env};
let photos: PhotosService;
let started = false;
let port = 0;
let manager: User, field: User;
let storeId = '';

const pool = () => getPool();
const q = (s: string) => new URLSearchParams(s);
const today = dayInAlger();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+01:00`).toISOString();
// Ends every departure refusal: an app opened before the deploy has no middle-photo button until reloaded.
const reload = ' Si le bouton n’apparaît pas, rechargez l’application.';
const row = async (id: string) => (await pool().query('SELECT * FROM tf_missions WHERE id=$1', [id])).rows[0];
const stored = () => (existsSync(join(storage, 'terrain')) ? readdirSync(join(storage, 'terrain')).length : 0);

function command(program: string, args: string[], env: Record<string, string | undefined> = {}) {
  const result = spawnSync(program, args, {cwd: root, env: {...process.env, ...env}, encoding: 'utf8', timeout: 60000});
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return result.stdout + result.stderr;
}

async function account(username: string): Promise<User> {
  return (await pool().query('SELECT id,username,label,role,active,force_change FROM tf_users WHERE username=$1', [username])).rows[0];
}

async function fieldUser(): Promise<User> {
  const id = randomUUID();
  await pool().query(`INSERT INTO tf_users(id,username,label,role,active,salt,password_hash,force_change,created_at)
    VALUES($1,$2,$3,'field',1,'00','00',0,$4)`, [id, 'field-' + id.slice(0, 8), 'Animatrice ' + id.slice(0, 4), new Date().toISOString()]);
  return (await pool().query('SELECT id,username,label,role,active,force_change FROM tf_users WHERE id=$1', [id])).rows[0];
}

/** A mission planned from `start` to `end` minutes from now (negative: in the past). */
async function addMission(o: {field: string; start: number; end: number; status?: string; actualStart?: string | null; day?: string}) {
  const id = randomUUID();
  await pool().query(`INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,status,actual_start,created_by,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'["TOUCHE"]',$7,$8,$9,$10)`,
  [id, storeId, o.field, o.day || today, ago(-o.start), ago(-o.end), o.status || 'ongoing', o.actualStart === undefined ? ago(-o.start) : o.actualStart, manager.id, new Date().toISOString()]);
  return id;
}

/** Runs the real global exception filter and returns what the client would receive. */
function respond(e: unknown) {
  let status = 0;
  let body: any;
  const res = {headersSent: false, setHeader() {}, status(s: number) { status = s; return res; }, json(b: any) { body = b; }};
  const req = {method: 'POST', originalUrl: '/api/photos', query: {}, body: ''};
  new HttpExceptionFilter().catch(e, {switchToHttp: () => ({getResponse: () => res, getRequest: () => req})} as any);
  return {status, body};
}

async function failure(p: Promise<unknown>) {
  const e = await p.then(() => { throw new Error('expected a failure'); }, (x) => x);
  return respond(e);
}

/** POST /api/photos as the browser sends it (multipart body on the request stream). */
async function upload(u: User, fields: Record<string, string>) {
  const data = new Uint8Array(4000);
  data.set([255, 216, 255]);
  const form = new FormData();
  for (const [key, value] of Object.entries({no_person: 'true', photo_id: randomUUID(), ...fields})) form.set(key, value);
  form.set('photo', new File([data], 'lieu.jpg', {type: 'image/jpeg'}));
  const body = new Response(form);
  const contentType = body.headers.get('content-type');
  const stream = Readable.from([Buffer.from(await body.arrayBuffer())]) as any;
  stream.headers = {'content-type': contentType};
  return photos.uploadPhoto(u, stream);
}

/** GET /api/photos with a matching ETag: answers 304 after the access check, without streaming. */
async function readPhoto(u: User, id: string) {
  let status = 0;
  const res: any = {set() { return res; }, status(s: number) { status = s; return res; }, end() {}};
  await photos.getPhoto(u, {query: {id}, headers: {'if-none-match': `"${id}"`}} as any, res);
  return status;
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
    STORAGE_DIR: storage, S3_BUCKET: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '',
    ADMIN_INITIAL_PASSWORD: secret(), SEED_MANAGER_PASSWORD: secret(), SEED_FIELD_PASSWORD: secret(), SEED_DOCTOR_PASSWORD: secret()});
  command(process.execPath, ['src/db/migrate.ts']);
  expect(command(process.execPath, ['src/db/seed.ts'])).toContain('Seed complete');
  photos = new PhotosService(new StorageService());
  [manager, field] = await Promise.all(['gestion', 'animatrice'].map(account));
  storeId = randomUUID();
  await pool().query(`INSERT INTO tf_stores(id,name,kind,city,address) VALUES($1,'Pharmacie du milieu','pharmacy','Alger','3 rue des tests')`, [storeId]);
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

test('before the midpoint, the middle photo and the departure are refused with the unlock time, and nothing is stored', async () => {
  const worker = await fieldUser();
  // Planned 1 h ago for 6 h: unlocks in 2 h.
  const id = await addMission({field: worker.id, start: -60, end: 300});
  const m = await row(id);
  const unlock = clock(midwayTime(m));
  const before = stored();
  expect(await failure(upload(worker, {mission_id: id, purpose: 'midway'}))).toEqual({status: 409, body: {error: `La photo du milieu sera disponible à ${unlock}.`}});
  expect(await failure(upload(worker, {mission_id: id, purpose: 'checkout'}))).toEqual({status: 409, body: {error: `Prenez d’abord la photo du milieu (disponible à ${unlock}).` + reload}});
  expect(stored()).toBe(before);
  expect((await pool().query('SELECT count(*)::int AS n FROM tf_photos WHERE mission_id=$1', [id])).rows[0].n).toBe(0);
  expect(await row(id)).toMatchObject({status: 'ongoing', midway_at: null, midway_photo_id: null, actual_end: null, version: m.version});
});

test('after the midpoint: the middle photo is recorded once (idempotent retry), readable by the mission’s viewers, then the departure completes', async () => {
  const worker = await fieldUser();
  // Planned 4 h ago for 6 h: unlocked an hour ago. A mission started before the deploy has no middle photo yet.
  const id = await addMission({field: worker.id, start: -240, end: 120});
  expect(await failure(upload(worker, {mission_id: id, purpose: 'checkout'}))).toEqual({status: 409, body: {error: 'Prenez d’abord la photo du milieu.' + reload}});
  expect(await failure(upload(worker, {mission_id: id, purpose: 'midway', no_person: 'false'}))).toEqual({status: 400, body: {error: 'Confirmez une photo du lieu sans personnes ni documents personnels.'}});
  const version = (await row(id)).version;
  const before = stored();
  const photo = randomUUID();
  const sent = await upload(worker, {mission_id: id, purpose: 'midway', photo_id: photo});
  expect(sent).toMatchObject({ok: true, id: photo});
  let m = await row(id);
  expect(m).toMatchObject({status: 'ongoing', midway_at: sent.serverTime, midway_photo_id: photo, actual_end: null, version: version + 1});
  // A lost answer retried with the same photo_id: no second photo, nothing changes.
  expect(await upload(worker, {mission_id: id, purpose: 'midway', photo_id: photo})).toEqual({ok: true, id: photo, duplicate: true});
  expect(stored()).toBe(before + 1);
  expect(await row(id)).toMatchObject({midway_at: sent.serverTime, midway_photo_id: photo, version: version + 1});
  expect(await failure(upload(worker, {mission_id: id, purpose: 'midway'}))).toEqual({status: 409, body: {error: 'La photo du milieu est déjà enregistrée.'}});
  // The same photo_id cannot be replayed as another step.
  expect(await failure(upload(worker, {mission_id: id, purpose: 'checkout', photo_id: photo}))).toEqual({status: 409, body: {error: 'Identifiant photo déjà utilisé.'}});
  const audit = (await pool().query("SELECT action,detail FROM tf_audit WHERE target=$1 AND action LIKE 'clock.%'", [id])).rows;
  expect(audit).toEqual([{action: 'clock.midway', detail: {photo, purpose: 'midway'}}]);

  for (const u of [worker, manager]) {
    const detail = await terrain.getTerrain(u, q('action=mission&id=' + id));
    expect(detail.mission).toMatchObject({midway_at: sent.serverTime, midway_photo_id: photo});
    expect(detail.photos.map((p: any) => [p.id, p.purpose, p.caption])).toEqual([[photo, 'midway', '']]);
    expect(await readPhoto(u, photo)).toBe(304);
  }
  expect(await failure(readPhoto(field, photo))).toEqual({status: 403, body: {error: 'Animation non accessible.'}});

  const end = await upload(worker, {mission_id: id, purpose: 'checkout'});
  m = await row(id);
  expect(m).toMatchObject({status: 'completed', actual_end: end.serverTime, end_photo_id: end.id, midway_photo_id: photo});
  expect((await terrain.getTerrain(worker, q('action=mission&id=' + id))).photos.map((p: any) => p.purpose)).toEqual(['midway', 'checkout']);
});

test('only the assigned animatrice takes the middle photo, and only while the mission is ongoing', async () => {
  const worker = await fieldUser();
  const id = await addMission({field: worker.id, start: -240, end: 120});
  expect(await failure(upload(field, {mission_id: id, purpose: 'midway'}))).toEqual({status: 403, body: {error: 'Animation non accessible.'}});
  expect(await failure(upload(manager, {mission_id: id, purpose: 'midway'}))).toEqual({status: 409, body: {error: 'Le pointage appartient à l’animatrice assignée.'}});
  const planned = await addMission({field: worker.id, start: -240, end: 120, status: 'planned', actualStart: null, day: shiftDay(today, -1)});
  expect(await failure(upload(worker, {mission_id: planned, purpose: 'midway'}))).toEqual({status: 409, body: {error: 'Pointez votre arrivée avant la photo du milieu.'}});
  expect(await failure(upload(worker, {mission_id: id, purpose: 'lunch'}))).toMatchObject({status: 400});
  expect((await pool().query('SELECT count(*)::int AS n FROM tf_photos WHERE mission_id = ANY($1)', [[id, planned]])).rows[0].n).toBe(0);
  expect(await row(id)).toMatchObject({midway_at: null, midway_photo_id: null});
});

test('an arrival after the midpoint can take the middle photo at once, then leave', async () => {
  const worker = await fieldUser();
  // Planned from 6 h ago to in 1 h: the midpoint (2 h 30 ago) is already past at check-in.
  const id = await addMission({field: worker.id, start: -360, end: 60, status: 'planned', actualStart: null});
  await upload(worker, {mission_id: id, purpose: 'checkin'});
  expect((await row(id)).status).toBe('ongoing');
  expect(await failure(upload(worker, {mission_id: id, purpose: 'checkout'}))).toEqual({status: 409, body: {error: 'Prenez d’abord la photo du milieu.' + reload}});
  expect((await upload(worker, {mission_id: id, purpose: 'midway'})).ok).toBe(true);
  expect((await upload(worker, {mission_id: id, purpose: 'checkout'})).ok).toBe(true);
  const m = await row(id);
  expect(m.status).toBe('completed');
  expect(Date.parse(m.actual_start) <= Date.parse(m.midway_at) && Date.parse(m.midway_at) <= Date.parse(m.actual_end)).toBe(true);
});

test('a manager closes a mission without a middle photo', async () => {
  const worker = await fieldUser();
  const day = shiftDay(today, -1);
  const id = randomUUID();
  await pool().query(`INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,status,actual_start,created_by,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'["TOUCHE"]','ongoing',$7,$8,$9)`, [id, storeId, worker.id, day, at(day, '09:00'), at(day, '17:00'), at(day, '09:05'), manager.id, new Date().toISOString()]);
  expect(await failure(upload(worker, {mission_id: id, purpose: 'checkout'}))).toEqual({status: 409, body: {error: 'Prenez d’abord la photo du milieu.' + reload}});
  expect(await terrain.postTerrain(manager, {action: 'close-mission', id, end: '17:00', reason: 'Départ confirmé par la pharmacie'})).toEqual({ok: true});
  expect(await row(id)).toMatchObject({status: 'completed', actual_end: at(day, '17:00'), midway_at: null, midway_photo_id: null});
  expect(await failure(upload(worker, {mission_id: id, purpose: 'midway'}))).toEqual({status: 409, body: {error: 'Pointez votre arrivée avant la photo du milieu.'}});
});

test('a manager’s departure time must follow the middle photo when there is one', async () => {
  const worker = await fieldUser();
  const day = shiftDay(today, -1);
  const insert = async (status: string, end: string | null) => {
    const id = randomUUID();
    await pool().query(`INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,status,actual_start,actual_end,midway_at,midway_photo_id,created_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'["TOUCHE"]',$7,$8,$9,$10,$11,$12,$13)`,
    [id, storeId, worker.id, day, at(day, '09:00'), at(day, '17:00'), status, at(day, '09:05'), end, at(day, '13:02'), randomUUID(), manager.id, new Date().toISOString()]);
    return id;
  };
  const close = (id: string, end: string) => terrain.postTerrain(manager, {action: 'close-mission', id, end, reason: 'Départ confirmé par la pharmacie'});
  const refused = {status: 400, body: {error: 'L’heure de départ doit suivre la photo du milieu (13:02).'}};
  // Correcting a completed mission: never before the middle photo.
  const completed = await insert('completed', at(day, '17:00'));
  for (const end of ['10:00', '13:02']) expect(await failure(close(completed, end))).toEqual(refused);
  expect(await row(completed)).toMatchObject({actual_end: at(day, '17:00')});
  expect(await close(completed, '13:03')).toEqual({ok: true});
  expect(await row(completed)).toMatchObject({status: 'completed', actual_end: at(day, '13:03'), midway_at: at(day, '13:02')});
  // Closing an ongoing mission that has its middle photo.
  const ongoing = await insert('ongoing', null);
  expect(await failure(close(ongoing, '11:00'))).toEqual(refused);
  expect(await row(ongoing)).toMatchObject({status: 'ongoing', actual_end: null});
  expect(await close(ongoing, '16:30')).toEqual({ok: true});
  expect(await row(ongoing)).toMatchObject({status: 'completed', actual_end: at(day, '16:30')});
});

test('migration 0003 applies on a database already at 0002 with data, and ongoing missions then need the middle photo', async () => {
  const url = `postgres://terrain_test@127.0.0.1:${port}/upgrade_midway`;
  await pool().query('CREATE DATABASE upgrade_midway');
  const legacy = join(directory, 'drizzle-0002');
  mkdirSync(join(legacy, 'meta'), {recursive: true});
  const journal = JSON.parse(readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8'));
  const total = journal.entries.length;
  expect(journal.entries.find((e: any) => e.idx === 3)?.tag).toBe('0003_midway_photo');
  journal.entries = journal.entries.filter((e: any) => e.idx <= 2);
  writeFileSync(join(legacy, 'meta/_journal.json'), JSON.stringify(journal));
  for (const e of journal.entries) copyFileSync(join(root, 'drizzle', e.tag + '.sql'), join(legacy, e.tag + '.sql'));
  const before = new Pool({connectionString: url});
  try {
    await migrate(drizzle(before), {migrationsFolder: legacy});
    await before.query(readFileSync(join(root, 'src/db/triggers.sql'), 'utf8'));
    await before.query(`INSERT INTO tf_users(id,username,label,role,salt,password_hash,created_at) VALUES('u1','u1','U','field','00','00','x');
      INSERT INTO tf_stores(id,name,kind,city,address) VALUES('s1','S','pharmacy','Alger','A');
      INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,status,actual_start,start_photo_id,created_by,updated_at)
        VALUES('m1','s1','u1','2026-11-01','2026-11-01T08:00:00.000Z','2026-11-01T16:00:00.000Z','["TOUCHE"]','ongoing','2026-11-01T08:00:00.000Z','p1','u1','x');
      INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,status,actual_start,actual_end,start_photo_id,end_photo_id,report_status,created_by,updated_at)
        VALUES('m2','s1','u1','2026-10-31','2026-10-31T08:00:00.000Z','2026-10-31T16:00:00.000Z','["TOUCHE"]','completed','2026-10-31T08:00:00.000Z','2026-10-31T16:00:00.000Z','p2','p3','approved','u1','x');
      INSERT INTO tf_photos(id,mission_id,user_id,created_at,mime,size,object_key,purpose) VALUES('p1','m1','u1','x','image/jpeg',1,'k1','checkin'),
        ('p2','m2','u1','x','image/jpeg',1,'k2','checkin'),('p3','m2','u1','x','image/jpeg',1,'k3','checkout');
      INSERT INTO tf_audit(id,user_id,at,action,target) VALUES('a1','u1','x','clock.checkin','m1');`);
    expect(await before.query('SELECT midway_at FROM tf_missions').then(() => 'ok', () => 'missing')).toBe('missing');
    for (let run = 0; run < 2; run++) command(process.execPath, ['src/db/migrate.ts'], {DATABASE_URL: url});
    for (const p of [before, pool()]) {
      const columns = (await p.query(`SELECT column_name,data_type,is_nullable FROM information_schema.columns
        WHERE table_name='tf_missions' AND column_name IN ('midway_at','midway_photo_id') ORDER BY column_name`)).rows;
      expect(columns).toEqual([{column_name: 'midway_at', data_type: 'text', is_nullable: 'YES'}, {column_name: 'midway_photo_id', data_type: 'text', is_nullable: 'YES'}]);
      expect((await p.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n).toBe(total);
    }
    const missions = (await before.query('SELECT * FROM tf_missions ORDER BY id')).rows;
    expect(missions.map((m) => [m.id, m.status, m.midway_at, m.midway_photo_id, m.actual_end])).toEqual([
      ['m1', 'ongoing', null, null, null], ['m2', 'completed', null, null, '2026-10-31T16:00:00.000Z']]);
    const kept = await before.query(`SELECT (SELECT count(*) FROM tf_photos)::int AS p,(SELECT count(*) FROM tf_audit)::int AS a,(SELECT count(*) FROM tf_users)::int AS u`);
    expect(kept.rows[0]).toEqual({p: 3, a: 1, u: 1});
    // The mission already in progress at the deploy: departure only after the middle photo.
    expect(clockIssue({id: 'u1', role: 'field'}, missions[0], 'checkout')).toBe('Prenez d’abord la photo du milieu.' + reload);
    expect(clockIssue({id: 'u1', role: 'field'}, missions[0], 'midway')).toBeNull();
    await before.query("UPDATE tf_missions SET midway_at='2026-11-01T12:00:00.000Z',midway_photo_id='p4' WHERE id='m1'");
    expect(clockIssue({id: 'u1', role: 'field'}, (await before.query("SELECT * FROM tf_missions WHERE id='m1'")).rows[0], 'checkout')).toBeNull();
  } finally {
    await before.end();
  }
}, 60000);
