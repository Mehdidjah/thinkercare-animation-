import 'reflect-metadata';
import {afterAll, beforeAll, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {randomBytes, randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {TerrainService} from '../src/terrain/terrain.service';
import {OperationsService} from '../src/terrain/operations.service';
import {PhotosService} from '../src/terrain/photos.service';
import {StorageService} from '../src/storage/storage.service';
import {HttpExceptionFilter} from '../src/common/http-exception.filter';
import {getPool} from '../src/db/client';
import {clock, dayInAlger, midwayTime, reportIssues, shiftDay, type User} from '../src/domain/core';

// Présentoir photos through the real photo and terrain services, on a disposable
// local Postgres cluster like midway.test.ts. Never touches a configured or production database.
const root = join(import.meta.dir, '..');
const directory = mkdtempSync(join(tmpdir(), 'terrain-presentoir-tests-'));
const cluster = join(directory, 'pg');
const storage = join(directory, 'photos');
const secret = () => 'Test-only-' + randomUUID();
const terrain = new TerrainService(new OperationsService());
const saved = {...process.env};
let photos: PhotosService;
let started = false;
let manager: User, field: User, doctor: User;
let storeId = '';

const pool = () => getPool();
const q = (s: string) => new URLSearchParams(s);
const today = dayInAlger();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+01:00`).toISOString();
const reload = ' Si le bouton n’apparaît pas, rechargez l’application.';
const LOCKED = {status: 409, body: {error: 'Cette animation est verrouillée.'}};
const FORBIDDEN = {status: 403, body: {error: 'Animation non accessible.'}};
const row = async (id: string) => (await pool().query('SELECT * FROM tf_missions WHERE id=$1', [id])).rows[0];
const stored = () => (existsSync(join(storage, 'terrain')) ? readdirSync(join(storage, 'terrain')).length : 0);
const kinds = async (id: string) =>
  Object.fromEntries((await pool().query('SELECT purpose,count(*)::int AS n FROM tf_photos WHERE mission_id=$1 GROUP BY purpose', [id])).rows.map((r) => [r.purpose, r.n]));
const kindIds = async (id: string, purpose: string) =>
  (await pool().query('SELECT id FROM tf_photos WHERE mission_id=$1 AND purpose=$2', [id, purpose])).rows.map((r) => r.id as string);
const jpeg = (size = 4000) => {
  const data = new Uint8Array(size);
  data.set([255, 216, 255]);
  return data;
};

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

async function addStore(name: string) {
  const id = randomUUID();
  await pool().query(`INSERT INTO tf_stores(id,name,kind,city,address) VALUES($1,$2,'pharmacy','Alger','5 rue des tests')`, [id, name]);
  return id;
}

/** A mission of the day (09:00–17:00 unless given), clocked in (and out when completed) like the app does. */
async function addMission(o: {field: string; store?: string; day?: string; status?: string; report?: string; start?: string; end?: string; actualStart?: string | null}) {
  const id = randomUUID();
  const day = o.day || today;
  const status = o.status || 'ongoing';
  const begun = ['ongoing', 'completed'].includes(status);
  await pool().query(`INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,status,report_status,actual_start,actual_end,created_by,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'["TOUCHE"]',$7,$8,$9,$10,$11,$12)`,
  [id, o.store || storeId, o.field, day, o.start || at(day, '09:00'), o.end || at(day, '17:00'), status, o.report || 'draft',
    o.actualStart !== undefined ? o.actualStart : begun ? o.start || at(day, '09:05') : null, status === 'completed' ? at(day, '16:55') : null, manager.id, new Date().toISOString()]);
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

/** POST /api/photos as the app sends it (multipart body on the request stream), optionally with its grid thumbnail. */
async function upload(u: User, fields: Record<string, string>, o: {bytes?: Uint8Array; thumb?: boolean} = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({no_person: 'true', photo_id: randomUUID(), ...fields})) form.set(key, value);
  form.set('photo', new File([o.bytes || jpeg()], 'presentoir.jpg', {type: 'image/jpeg'}));
  if (o.thumb) form.set('thumb', new File([jpeg(600)], 'miniature.jpg', {type: 'image/jpeg'}));
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

const gallery = async (u: User, store: string) => (await terrain.getTerrain(u, q('action=stocks&store=' + store))).presentoir;

beforeAll(async () => {
  const listener = createServer();
  const port = await new Promise<number>((resolve) => listener.listen(0, '127.0.0.1', () => resolve((listener.address() as any).port)));
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
  [manager, field, doctor] = await Promise.all(['gestion', 'animatrice', 'medecin'].map(account));
  storeId = await addStore('Pharmacie du présentoir');
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

test('a présentoir photo is recorded with its thumbnail and caption, once per photo_id, audited as photo.added, without touching the clock', async () => {
  const worker = await fieldUser();
  // Started an hour ago for 6 h: the middle photo is not available yet.
  const id = await addMission({field: worker.id, start: ago(60), end: ago(-300)});
  const before = await row(id);
  const files = stored();
  expect(await failure(upload(worker, {mission_id: id, purpose: 'presentoir', no_person: 'false'}))).toEqual({status: 400, body: {error: 'Confirmez une photo du lieu sans personnes ni documents personnels.'}});
  expect(await failure(upload(worker, {mission_id: id, purpose: 'presentoir'}, {bytes: new Uint8Array(4000)}))).toEqual({status: 400, body: {error: 'Format image non reconnu.'}});
  expect(stored()).toBe(files);

  const photo = randomUUID();
  const sent = await upload(worker, {mission_id: id, purpose: 'presentoir', photo_id: photo, caption: 'Présentoir près de la caisse'}, {thumb: true});
  expect(sent).toEqual({ok: true, id: photo, serverTime: expect.any(String)});
  const p = (await pool().query('SELECT * FROM tf_photos WHERE id=$1', [photo])).rows[0];
  expect(p).toMatchObject({mission_id: id, user_id: worker.id, purpose: 'presentoir', caption: 'Présentoir près de la caisse', mime: 'image/jpeg', created_at: sent.serverTime});
  expect(existsSync(join(storage, p.object_key))).toBe(true);
  expect(existsSync(join(storage, p.object_key + '.thumb'))).toBe(true);
  // Only the version moves: no arrival, middle or departure is recorded by a présentoir photo.
  const after = await row(id);
  expect(after).toEqual({...before, version: before.version + 1, updated_at: after.updated_at});

  // A lost answer retried with the same photo_id: nothing more is stored; the id cannot be replayed as another kind.
  expect(await upload(worker, {mission_id: id, purpose: 'presentoir', photo_id: photo})).toEqual({ok: true, id: photo, duplicate: true});
  expect(stored()).toBe(files + 2);
  for (const purpose of ['report', 'midway'])
    expect(await failure(upload(worker, {mission_id: id, purpose, photo_id: photo}))).toEqual({status: 409, body: {error: 'Identifiant photo déjà utilisé.'}});
  const audit = (await pool().query('SELECT action,detail FROM tf_audit WHERE target=$1', [id])).rows;
  expect(audit).toEqual([{action: 'photo.added', detail: {photo, purpose: 'presentoir'}}]);

  for (const u of [worker, manager]) {
    const detail = await terrain.getTerrain(u, q('action=mission&id=' + id));
    expect(detail.photos).toEqual([{id: photo, caption: 'Présentoir près de la caisse', created_at: sent.serverTime, purpose: 'presentoir'}]);
    expect(detail.mission).toMatchObject({actual_start: before.actual_start, midway_at: null, midway_photo_id: null, actual_end: null, end_photo_id: null});
    expect(await readPhoto(u, photo)).toBe(304);
  }
  for (const u of [field, doctor]) expect(await failure(readPhoto(u, photo))).toEqual(FORBIDDEN);
  // It is not a middle photo: the clock steps still wait for the midpoint.
  const unlock = clock(midwayTime(after));
  expect(await failure(upload(worker, {mission_id: id, purpose: 'midway'}))).toEqual({status: 409, body: {error: `La photo du milieu sera disponible à ${unlock}.`}});
  expect(await failure(upload(worker, {mission_id: id, purpose: 'checkout'}))).toEqual({status: 409, body: {error: `Prenez d’abord la photo du milieu (disponible à ${unlock}).` + reload}});
});

test('10 présentoir photos per animation, a cap separate from the 15 suivi photos', async () => {
  const worker = await fieldUser();
  const id = await addMission({field: worker.id});
  for (let i = 0; i < 10; i++) expect((await upload(worker, {mission_id: id, purpose: 'presentoir', caption: 'Vue ' + i})).ok).toBe(true);
  let files = stored();
  const full = {status: 400, body: {error: '10 photos du présentoir maximum par animation.'}};
  expect(await failure(upload(worker, {mission_id: id, purpose: 'presentoir'}))).toEqual(full);
  expect(await failure(upload(manager, {mission_id: id, purpose: 'presentoir'}))).toEqual(full);
  expect(stored()).toBe(files);
  // The suivi photos keep their own 15, whatever the présentoir count.
  for (let i = 0; i < 15; i++) expect((await upload(worker, {mission_id: id})).ok).toBe(true);
  files = stored();
  expect(await failure(upload(worker, {mission_id: id, purpose: 'report'}))).toEqual({status: 400, body: {error: '15 photos de suivi maximum par animation.'}});
  expect(await failure(upload(worker, {mission_id: id, purpose: 'presentoir'}))).toEqual(full);
  expect(stored()).toBe(files);
  expect(await kinds(id)).toEqual({presentoir: 10, report: 15});

  // Fifteen suivi photos first leave the 10 présentoir photos available.
  const other = await addMission({field: worker.id, status: 'completed', day: shiftDay(today, -1)});
  for (let i = 0; i < 15; i++) await upload(worker, {mission_id: other});
  expect(await failure(upload(worker, {mission_id: other}))).toMatchObject({status: 400});
  expect((await upload(worker, {mission_id: other, purpose: 'presentoir'})).ok).toBe(true);
  expect(await kinds(other)).toEqual({presentoir: 1, report: 15});
});

test('présentoir photos follow the suivi photo rules: editable mission only, by those who may edit it', async () => {
  const worker = await fieldUser();
  const yesterday = shiftDay(today, -1);
  const missions = {
    planned: await addMission({field: worker.id, status: 'planned'}),
    cancelled: await addMission({field: worker.id, status: 'cancelled', day: yesterday}),
    submitted: await addMission({field: worker.id, status: 'completed', report: 'submitted', day: yesterday}),
    approved: await addMission({field: worker.id, status: 'completed', report: 'approved', day: yesterday}),
  };
  for (const id of Object.values(missions)) {
    expect(await failure(upload(worker, {mission_id: id, purpose: 'presentoir'}))).toEqual(LOCKED);
    expect(await failure(upload(worker, {mission_id: id, purpose: 'report'}))).toEqual(LOCKED);
    expect(await failure(upload(manager, {mission_id: id, purpose: 'presentoir'}))).toEqual(LOCKED);
  }
  const ongoing = await addMission({field: worker.id});
  for (const u of [field, doctor]) {
    expect(await failure(upload(u, {mission_id: ongoing, purpose: 'presentoir'}))).toEqual(FORBIDDEN);
    expect(await failure(upload(u, {mission_id: ongoing, purpose: 'report'}))).toEqual(FORBIDDEN);
  }
  expect((await pool().query('SELECT count(*)::int AS n FROM tf_photos WHERE mission_id = ANY($1)', [[...Object.values(missions), ongoing]])).rows[0].n).toBe(0);

  // Ongoing, or completed with a report still in draft or sent back: the animatrice and the managers may add them.
  const changes = await addMission({field: worker.id, status: 'completed', report: 'changes', day: shiftDay(today, -2)});
  for (const id of [ongoing, changes]) for (const u of [worker, manager]) expect((await upload(u, {mission_id: id, purpose: 'presentoir'})).ok).toBe(true);
  const audit = (await pool().query('SELECT user_id,action FROM tf_audit WHERE target=$1', [ongoing])).rows;
  expect(audit.map((a) => a.user_id).sort()).toEqual([worker.id, manager.id].sort());
  expect(new Set(audit.map((a) => a.action))).toEqual(new Set(['photo.added']));
  expect(await kinds(changes)).toEqual({presentoir: 2});
});

test('the Stocks page lists the 8 latest présentoir photos of the pharmacy, only from missions the reader may open', async () => {
  const [ana, bea] = [await fieldUser(), await fieldUser()];
  const store = await addStore('Pharmacie des présentoirs');
  const elsewhere = await addStore('Pharmacie voisine');
  const day = (n: number) => shiftDay(today, -n);
  const a1 = await addMission({field: ana.id, store, status: 'completed', day: day(1)});
  const b1 = await addMission({field: bea.id, store, status: 'completed', report: 'changes', day: day(2)});
  // Ana's arrival, middle and departure photos at this pharmacy, through the real clock flow (before a2: one ongoing animation at a time).
  const clocked = await addMission({field: ana.id, store, status: 'planned', start: ago(360), end: ago(-60), actualStart: null});
  const clockPhotos: string[] = [];
  for (const purpose of ['checkin', 'midway', 'checkout']) clockPhotos.push((await upload(ana, {mission_id: clocked, purpose})).id);
  expect(await row(clocked)).toMatchObject({status: 'completed', start_photo_id: clockPhotos[0], midway_photo_id: clockPhotos[1], end_photo_id: clockPhotos[2]});
  const a2 = await addMission({field: ana.id, store});
  const cancelled = await addMission({field: ana.id, store, status: 'cancelled', day: day(3)});
  const away = await addMission({field: ana.id, store: elsewhere, status: 'completed', day: day(4)});
  expect(await gallery(manager, store)).toEqual([]);
  expect(await gallery(ana, store)).toEqual([]);

  const sent: {id: string; mission: string; field: User; by: User; day: string; caption: string}[] = [];
  // The last one is added by a manager on Ana's animation: it belongs to the animation, so Ana sees it under her name.
  for (const [mission, who, by, d, n] of [[a1, ana, ana, day(1), 3], [b1, bea, bea, day(2), 4], [a2, ana, ana, today, 3], [a2, ana, manager, today, 1]] as const)
    for (let i = 0; i < n; i++) {
      const caption = `Présentoir ${sent.length}`;
      const r = await upload(by, {mission_id: mission, purpose: 'presentoir', caption});
      sent.push({id: r.id, mission, field: who, by, day: d, caption});
    }
  const byManager = sent[sent.length - 1];
  expect((await pool().query('SELECT user_id FROM tf_photos WHERE id=$1', [byManager.id])).rows[0].user_id).toBe(manager.id);
  // Never listed: suivi and clock photos, another pharmacy, a cancelled mission (written directly, the API refuses it).
  await upload(ana, {mission_id: a1, caption: 'Rayon'});
  await upload(ana, {mission_id: away, purpose: 'presentoir'});
  await pool().query(`INSERT INTO tf_photos(id,mission_id,user_id,created_at,caption,mime,size,object_key,purpose)
    VALUES($1,$2,$3,$4,'','image/jpeg',1,$5,'presentoir')`, [randomUUID(), cancelled, ana.id, ago(-60), 'terrain/' + randomUUID()]);
  // Distinct times in upload order (the server stamps at the millisecond); the others are the newest.
  for (const [i, s] of sent.entries()) await pool().query('UPDATE tf_photos SET created_at=$2 WHERE id=$1', [s.id, ago(30 - i)]);
  await pool().query(`UPDATE tf_photos SET created_at=$2 WHERE mission_id=ANY($1) AND purpose<>'presentoir' OR mission_id=$3`, [[a1, a2, b1, clocked], ago(-30), away]);
  // So the 8 newest photos of the pharmacy's live animations are not all présentoir photos: the clock ones lead.
  const latest = await pool().query(`SELECT ph.id,ph.purpose FROM tf_photos ph JOIN tf_missions m ON m.id=ph.mission_id
    WHERE m.store_id=$1 AND m.status<>'cancelled' ORDER BY ph.created_at DESC LIMIT 8`, [store]);
  expect(latest.rows.filter((p) => p.purpose !== 'presentoir').map((p) => p.id).sort()).toEqual([...clockPhotos, ...(await kindIds(a1, 'report'))].sort());

  const shape = async (list: typeof sent) =>
    Promise.all(list.map(async (s) => ({id: s.id, created_at: (await pool().query('SELECT created_at FROM tf_photos WHERE id=$1', [s.id])).rows[0].created_at,
      caption: s.caption, day: s.day, field_name: s.field.label, mission_id: s.mission})));
  const newest = [...sent].reverse();
  expect(await gallery(manager, store)).toEqual(await shape(newest.slice(0, 8)));
  expect(await gallery(ana, store)).toEqual(await shape(newest.filter((s) => s.field.id === ana.id)));
  expect(await gallery(bea, store)).toEqual(await shape(newest.filter((s) => s.field.id === bea.id)));
  for (const u of [manager, ana]) expect((await gallery(u, store)).filter((p: any) => clockPhotos.includes(p.id))).toEqual([]);
  expect((await gallery(ana, store)).find((p: any) => p.id === byManager.id)).toMatchObject({field_name: ana.label, mission_id: a2});
  expect((await gallery(bea, store)).map((p: any) => p.id)).not.toContain(byManager.id);

  // Every listed photo opens for its reader; an animatrice never gets a colleague's photo.
  for (const u of [manager, ana, bea]) for (const p of await gallery(u, store)) expect(await readPhoto(u, p.id)).toBe(304);
  expect(await readPhoto(ana, byManager.id)).toBe(304);
  for (const s of sent.filter((x) => x.field.id === bea.id)) expect(await failure(readPhoto(ana, s.id))).toEqual(FORBIDDEN);
  expect(await failure(readPhoto(bea, byManager.id))).toEqual(FORBIDDEN);
  // Unchanged access to the page itself.
  expect(await failure(terrain.getTerrain(field, q('action=stocks&store=' + store)))).toEqual({status: 403, body: {error: 'Point de vente non accessible.'}});
  expect(await failure(terrain.getTerrain(doctor, q('action=stocks&store=' + store)))).toEqual({status: 403, body: {error: 'Accès non autorisé.'}});
  // The counted stock is still the latest closing count of completed missions.
  const product = (await pool().query("SELECT id FROM tf_products WHERE brand='TOUCHE' AND active=1 ORDER BY id LIMIT 1")).rows[0].id;
  await terrain.postTerrain(ana, {action: 'count', mission_id: a1, product_id: product, opening: 5, received: 0, other_out: 0, closing: 3, damaged: 0, expiring: 0, expiry: '', note: '', previous: null});
  const page = await terrain.getTerrain(manager, q('action=stocks&store=' + store));
  expect(page.stocks.map((s: any) => [s.product_id, s.closing, s.day])).toEqual([[product, 3, day(1)]]);
  expect(page.presentoir).toHaveLength(8);
});

test('présentoir photos change nothing in the clock steps, the stock or the report submission', async () => {
  const worker = await fieldUser();
  // Planned from 6 h ago to in 1 h: the midpoint is already past at arrival.
  const id = await addMission({field: worker.id, status: 'planned', start: ago(360), end: ago(-60), actualStart: null});
  expect(await failure(upload(worker, {mission_id: id, purpose: 'presentoir'}))).toEqual(LOCKED);
  const arrival = await upload(worker, {mission_id: id, purpose: 'checkin'});
  const first = await upload(worker, {mission_id: id, purpose: 'presentoir'});
  expect(await failure(upload(worker, {mission_id: id, purpose: 'checkout'}))).toEqual({status: 409, body: {error: 'Prenez d’abord la photo du milieu.' + reload}});
  const middle = await upload(worker, {mission_id: id, purpose: 'midway'});
  const second = await upload(worker, {mission_id: id, purpose: 'presentoir'});
  const departure = await upload(worker, {mission_id: id, purpose: 'checkout'});
  expect(await row(id)).toMatchObject({status: 'completed', report_status: 'draft', start_photo_id: arrival.id, midway_photo_id: middle.id, end_photo_id: departure.id,
    actual_start: arrival.serverTime, midway_at: middle.serverTime, actual_end: departure.serverTime});
  const detail = await terrain.getTerrain(worker, q('action=mission&id=' + id));
  expect(detail.photos.map((p: any) => [p.id, p.purpose])).toEqual([[arrival.id, 'checkin'], [first.id, 'presentoir'], [middle.id, 'midway'], [second.id, 'presentoir'], [departure.id, 'checkout']]);
  expect(detail.counts).toEqual([]);
  expect(detail.tickets).toEqual([]);

  // The report checks are those of a mission without photos: here, only the no-sale confirmation.
  expect(reportIssues(detail.counts, detail.tickets, false)).toEqual(['Confirmez explicitement une animation sans vente.']);
  expect(await failure(terrain.postTerrain(worker, {action: 'submit', id, notes: '', no_sales: false}))).toEqual({status: 400, body: {error: 'Confirmez explicitement une animation sans vente.'}});
  expect(await terrain.postTerrain(worker, {action: 'submit', id, notes: '', no_sales: true})).toEqual({ok: true});
  expect(await failure(upload(worker, {mission_id: id, purpose: 'presentoir'}))).toEqual(LOCKED);
  const audit = (await pool().query('SELECT action FROM tf_audit WHERE target=$1', [id])).rows.map((r) => r.action).sort();
  expect(audit).toEqual(['clock.checkin', 'clock.checkout', 'clock.midway', 'photo.added', 'photo.added', 'report.submitted']);
});
