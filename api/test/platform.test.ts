import {afterAll, beforeAll, expect, spyOn, test} from 'bun:test';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {connect, createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough, Writable} from 'node:stream';
import {randomBytes, randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {UploadLimiter, UPLOAD_BUSY, withUploadSlot} from '../src/common/upload-limiter';
import {checkConfig} from '../src/common/config-check';
import {dayInAlger} from '../src/domain/core';
import {PhotosService} from '../src/terrain/photos.service';

// Boots the real server (src/main.ts) in a child process against a disposable
// local Postgres cluster, so headers, static files and routing are checked over
// HTTP as Railway serves them. The test process itself never opens the shared
// pool from src/db/client (bun runs every test file in one process) and never
// uses a configured application or production database.
const root = join(import.meta.dir, '..');
const directory = mkdtempSync(join(tmpdir(), 'terrain-platform-tests-'));
const cluster = join(directory, 'pg');
const photos = join(directory, 'photos');
const site = join(directory, 'site');
const passwords = {gestion: 'Test-only-' + randomUUID(), animatrice: 'Test-only-' + randomUUID()};
const managerId = '11111111-1111-4111-8111-111111111111';
const fieldId = '22222222-2222-4222-8222-222222222222';
const storeId = randomUUID();
const otherStoreId = randomUUID();
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' https:; " +
  "connect-src 'self' https:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
const IMMUTABLE_PHOTO = 'private, max-age=31536000, immutable';
const servers: ChildProcess[] = [];
let env: Record<string, string | undefined> = {};
let pool: Pool | undefined;
let main: Awaited<ReturnType<typeof boot>>;
let base = '';
let started = false;

async function freePort() {
  const listener = createServer();
  const port = await new Promise<number>(resolve => listener.listen(0, '127.0.0.1', () => resolve((listener.address() as any).port)));
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}

function command(program: string, args: string[]) {
  const result = spawnSync(program, args, {cwd: root, env, encoding: 'utf8', timeout: 30000});
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return result.stdout + result.stderr;
}

async function boot(port: number, overrides: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['src/main.ts'], {cwd: root, env: {...env, ...overrides, PORT: String(port)}, stdio: ['ignore', 'pipe', 'pipe']});
  servers.push(child);
  let log = '';
  child.stdout!.on('data', chunk => (log += chunk));
  child.stderr!.on('data', chunk => (log += chunk));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('server exited: ' + log);
    try {
      if ((await fetch(url + '/robots.txt')).ok) return {child, url, log: () => log};
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error('server did not start: ' + log);
}

async function login(username: keyof typeof passwords) {
  const response = await fetch(base + '/api/terrain', {method: 'POST', headers: {origin: base, 'content-type': 'application/json'},
    body: JSON.stringify({action: 'login', username, password: passwords[username]})});
  expect(response.ok).toBe(true); // Nest answers POST with 201
  return response.headers.get('set-cookie')!.split(';')[0];
}

function jpeg(size = 2048) {
  const bytes = new Uint8Array(size);
  bytes.set([255, 216, 255]);
  return bytes;
}

function upload(path: string, cookie: string, fields: Record<string, string>, bytes = jpeg()) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set('no_person', 'true');
  form.set('photo', new File([bytes], 'photo.jpg', {type: 'image/jpeg'}));
  return fetch(base + path, {method: 'POST', headers: {cookie, origin: base}, body: form});
}

async function mission(status: string, day: string, store = storeId) {
  const id = randomUUID();
  await pool!.query(`INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,status,actual_start,created_by,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'["TOUCHE"]',$7,$8,$9,$10)`, [id, store, fieldId, day, day + 'T08:00:00.000Z', day + 'T17:00:00.000Z',
    status, status === 'planned' ? null : day + 'T08:05:00.000Z', managerId, new Date().toISOString()]);
  return id;
}

const storedPhotos = () => (existsSync(join(photos, 'terrain')) ? readdirSync(join(photos, 'terrain')).length : 0);

function expectSecurityHeaders(response: Response) {
  const policy = response.headers.get('content-security-policy')!;
  expect(policy).toBe(CSP);
  expect(policy.split('; ').find(directive => directive.startsWith('script-src'))).toBe("script-src 'self'");
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains; preload');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  expect(response.headers.get('permissions-policy')).toBe('camera=(self), microphone=(), geolocation=()');
  expect(response.headers.get('x-xss-protection')).toBe('0');
  expect(response.headers.get('x-powered-by')).toBeNull();
}

beforeAll(async () => {
  const databasePort = await freePort();
  const databaseUrl = `postgres://terrain_test@127.0.0.1:${databasePort}/postgres`;
  env = {...process.env, DATABASE_URL: databaseUrl, DATABASE_SSL: 'false', PGSSLMODE: 'disable',
    ACCOUNT_PASSWORD_KEY: randomBytes(32).toString('hex'), STORAGE_DIR: photos, STATIC_DIR: site,
    S3_ENDPOINT: '', S3_BUCKET: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '', APP_ORIGIN: '',
    ADMIN_INITIAL_PASSWORD: 'Test-only-' + randomUUID(), SEED_MANAGER_PASSWORD: passwords.gestion,
    SEED_FIELD_PASSWORD: passwords.animatrice, SEED_DOCTOR_PASSWORD: ''};
  command('initdb', ['-D', cluster, '--auth=trust', '--no-locale', '--encoding=UTF8', '-U', 'terrain_test']);
  command('pg_ctl', ['-D', cluster, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${databasePort} -k ${directory}`, '-w', 'start']);
  started = true;
  command(process.execPath, ['src/db/migrate.ts']);
  command(process.execPath, ['src/db/seed.ts']);
  pool = new Pool({connectionString: databaseUrl});
  await pool.query(`INSERT INTO tf_stores(id,name,kind,city,address) VALUES($1,'Pharmacie des Tests','pharmacy','Alger','Rue 1'),
    ($2,'Pharmacie du Port','pharmacy','Oran','Rue 2')`, [storeId, otherStoreId]);
  mkdirSync(join(site, 'assets'), {recursive: true});
  mkdirSync(join(site, 'presets'));
  writeFileSync(join(site, 'index.html'), '<!doctype html><html><head><script type="module" src="/assets/index-Ab12Cd34.js"></script></head><body><div id="root"></div></body></html>');
  writeFileSync(join(site, 'assets', 'index-Ab12Cd34.js'), 'console.log("terrain")');
  writeFileSync(join(site, 'assets', 'index-Ef56Gh78.css'), 'body{margin:0}');
  writeFileSync(join(site, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(site, 'presets', 'cover.png'), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  main = await boot(await freePort());
  base = main.url;
}, 90000);

afterAll(async () => {
  for (const child of servers) child.kill();
  await pool?.end();
  if (started) command('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop']);
  rmSync(directory, {recursive: true, force: true});
});

test('security headers cover index.html, SPA routes, static files and API responses; static caching follows the asset kind', async () => {
  for (const [path, cache, type] of [
    ['/', 'no-cache', 'text/html'],
    ['/planning/semaine', 'no-cache', 'text/html'],
    ['/index.html', 'no-cache', 'text/html'],
    ['/assets/index-Ab12Cd34.js', 'public, max-age=31536000, immutable', 'javascript'],
    ['/assets/index-Ef56Gh78.css', 'public, max-age=31536000, immutable', 'text/css'],
    ['/assets/favicon.svg', 'public, max-age=86400', 'image/svg+xml'],
    ['/presets/cover.png', 'no-cache', 'image/png'],
  ]) {
    const response = await fetch(base + path);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(cache);
    expect(response.headers.get('content-type')).toContain(type);
    expect(response.headers.get('x-robots-tag')).toBeNull();
    expectSecurityHeaders(response);
    await response.arrayBuffer();
  }
  const cookie = await login('gestion');
  const bootstrap = await fetch(base + '/api/terrain', {headers: {cookie}});
  expect(bootstrap.status).toBe(200);
  expect(bootstrap.headers.get('cache-control')).toBe('no-store');
  expect(bootstrap.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expectSecurityHeaders(bootstrap);
  expect((await bootstrap.json()).user.username).toBe('gestion');
  const anonymous = await fetch(base + '/api/terrain');
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get('cache-control')).toBe('no-store');
  expectSecurityHeaders(anonymous);
  await anonymous.arrayBuffer();
}, 30000);

test('/healthz reports database health, and unknown API paths answer a JSON 404 instead of the SPA', async () => {
  const healthy = await fetch(base + '/healthz');
  expect(healthy.status).toBe(200);
  expect(healthy.headers.get('cache-control')).toBe('no-store');
  expectSecurityHeaders(healthy);
  expect(await healthy.json()).toEqual({ok: true});
  for (const [method, path] of [['GET', '/api/nope'], ['POST', '/api/nope'], ['GET', '/api'], ['GET', '/api/terrain/extra']]) {
    const response = await fetch(base + path, {method, headers: {origin: base}});
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({error: 'Ressource introuvable.'});
  }
  const down = await boot(await freePort(), {DATABASE_URL: `postgres://terrain_test@127.0.0.1:${await freePort()}/postgres`});
  const unhealthy = await fetch(down.url + '/healthz');
  expect(unhealthy.status).toBe(503);
  expect(unhealthy.headers.get('cache-control')).toBe('no-store');
  expect(await unhealthy.json()).toEqual({error: 'Base de données indisponible.'});
  down.child.kill();
}, 30000);

test('photos are privately cacheable with an ETag and Content-Length, revalidate with 304, and retries reuse the photo id', async () => {
  const cookie = await login('gestion');
  const missionId = await mission('completed', '2026-11-16');
  const noteId = randomUUID();
  await pool!.query(`INSERT INTO tf_field_notes(id,author_id,category,description,created_at,updated_at)
    VALUES($1,$2,'shelf','Platform cache test',$3,$3)`, [noteId, managerId, new Date().toISOString()]);
  const bytes = jpeg(150_000);
  const missionPhoto = randomUUID();
  const notePhoto = randomUUID();
  expect((await upload('/api/photos', cookie, {mission_id: missionId, photo_id: missionPhoto}, bytes)).ok).toBe(true);
  expect(await (await upload('/api/photos', cookie, {mission_id: missionId, photo_id: missionPhoto}, bytes)).json())
    .toMatchObject({ok: true, id: missionPhoto, duplicate: true});
  expect((await upload('/api/field-photos', cookie, {note_id: noteId, photo_id: notePhoto}, bytes)).ok).toBe(true);
  for (const [path, id] of [['/api/photos?id=', missionPhoto], ['/api/field-photos?id=', notePhoto]]) {
    const etag = `"${id}"`;
    const response = await fetch(base + path + id, {headers: {cookie}});
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE_PHOTO);
    expect(response.headers.get('etag')).toBe(etag);
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expectSecurityHeaders(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    for (const tag of [etag, 'W/' + etag, `"${randomUUID()}", ${etag}`]) {
      const revalidated = await fetch(base + path + id, {headers: {cookie, 'if-none-match': tag}});
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get('etag')).toBe(etag);
      expect(revalidated.headers.get('cache-control')).toBe(IMMUTABLE_PHOTO);
      expect((await revalidated.arrayBuffer()).byteLength).toBe(0);
    }
    const changed = await fetch(base + path + id, {headers: {cookie, 'if-none-match': `"${randomUUID()}"`}});
    expect(changed.status).toBe(200);
    await changed.arrayBuffer();
    // A revalidation still needs a session.
    const anonymous = await fetch(base + path + id, {headers: {'if-none-match': etag}});
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('no-store');
    expect(anonymous.headers.get('etag')).not.toBe(etag);
    await anonymous.arrayBuffer();
  }
}, 30000);

test('photo streaming destroys the storage stream when the client goes away or the response fails', async () => {
  for (const end of ['abort', 'error'] as const) {
    const source = new PassThrough();
    const service = new PhotosService({configured: () => true, open: async () => ({stream: source, size: 1 << 20})} as any);
    // A client that stops reading: the response never drains.
    const res = Object.assign(new Writable({highWaterMark: 1, write: () => {}}), {headers: {} as Record<string, string>,
      set(values: Record<string, string>) { Object.assign(this.headers, values); return this; },
      setHeader(name: string, value: string) { this.headers[name] = value; }}) as any;
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await (service as any).send({headers: {}}, res, {id: randomUUID(), object_key: 'terrain/test', mime: 'image/jpeg'});
      source.write(Buffer.alloc(64 * 1024));
      expect(res.headers).toMatchObject({'Cache-Control': IMMUTABLE_PHOTO, 'Content-Length': String(1 << 20), 'Content-Type': 'image/jpeg'});
      if (end === 'abort') res.destroy();
      else res.destroy(new Error('socket reset'));
      await Bun.sleep(20);
      expect(source.destroyed).toBe(true);
      expect(errors.mock.calls.length).toBe(end === 'abort' ? 0 : 1);
    } finally {
      errors.mockRestore();
    }
  }
});

test('uploads beyond 4 in progress and 8 queued get 503 with Retry-After, and aborted uploads free their slots', async () => {
  const cookie = await login('gestion');
  const missionId = await mission('completed', '2026-11-14');
  // Raw sockets: headers and the start of a 1 MB body, then nothing more.
  const stalled = Array.from({length: 12}, () => {
    const socket = connect(Number(new URL(base).port), '127.0.0.1');
    socket.on('error', () => {});
    socket.write(`POST /api/photos HTTP/1.1\r\nHost: ${new URL(base).host}\r\nOrigin: ${base}\r\nCookie: ${cookie}\r\n` +
      'Content-Type: multipart/form-data; boundary=x\r\nContent-Length: 1000000\r\n\r\n--x\r\n');
    return socket;
  });
  await Bun.sleep(2000);
  const busy = await upload('/api/photos', cookie, {mission_id: missionId, photo_id: randomUUID()});
  expect(busy.status).toBe(503);
  expect(busy.headers.get('retry-after')).toBe('5');
  expect(await busy.json()).toEqual({error: UPLOAD_BUSY});
  for (const pending of stalled) pending.destroy();
  await Bun.sleep(1500);
  const next = await upload('/api/photos', cookie, {mission_id: missionId, photo_id: randomUUID()});
  expect(next.ok).toBe(true);
}, 30000);

test('check-in is refused before the photo is stored while another animation is still ongoing', async () => {
  const cookie = await login('animatrice');
  const ongoing = await mission('ongoing', '2026-11-18', otherStoreId);
  const today = await mission('planned', dayInAlger());
  const before = storedPhotos();
  const id = randomUUID();
  const refused = await upload('/api/photos', cookie, {mission_id: today, purpose: 'checkin', photo_id: id});
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({error: 'Une autre animation est encore en cours (Pharmacie du Port, 18/11/2026). Pointez d’abord votre départ de cette animation.'});
  expect(storedPhotos()).toBe(before);
  expect((await pool!.query('SELECT 1 FROM tf_photos WHERE id=$1', [id])).rowCount).toBe(0);
  expect((await pool!.query('SELECT status FROM tf_missions WHERE id=$1', [today])).rows[0].status).toBe('planned');
  await pool!.query(`UPDATE tf_missions SET status='completed',actual_end=$2 WHERE id=$1`, [ongoing, new Date().toISOString()]);
  const accepted = await upload('/api/photos', cookie, {mission_id: today, purpose: 'checkin', photo_id: id});
  expect(accepted.ok).toBe(true);
  expect(storedPhotos()).toBe(before + 1);
  expect((await pool!.query('SELECT status FROM tf_missions WHERE id=$1', [today])).rows[0].status).toBe('ongoing');
}, 30000);

test('upload limiter grants slots in order, bounds its queue, times out, honours aborts and releases once', async () => {
  expect(new UploadLimiter()).toMatchObject({slots: 4, queue: 8, waitMs: 20000});
  const limiter = new UploadLimiter(2, 2, 200);
  const first = await limiter.acquire();
  const second = await limiter.acquire();
  const gone = new AbortController();
  const third = limiter.acquire();
  const leaving = limiter.acquire(gone.signal);
  expect(limiter.stats()).toEqual({active: 2, waiting: 2});
  await expect(limiter.acquire()).rejects.toMatchObject({status: 503, message: UPLOAD_BUSY});
  gone.abort();
  await expect(leaving).rejects.toMatchObject({status: 503});
  expect(limiter.stats()).toEqual({active: 2, waiting: 1});
  first();
  first();
  const releaseThird = await third;
  expect(limiter.stats()).toEqual({active: 2, waiting: 0});
  await expect(limiter.acquire()).rejects.toMatchObject({status: 503, message: UPLOAD_BUSY});
  expect(limiter.stats()).toEqual({active: 2, waiting: 0});
  second();
  releaseThird();
  expect(limiter.stats()).toEqual({active: 0, waiting: 0});
});

test('withUploadSlot releases after success, failure and a queued client disconnect, and marks 503s with Retry-After', async () => {
  const response = () => Object.assign(new EventEmitter(), {headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; }}) as any;
  const limiter = new UploadLimiter(1, 1, 10_000);
  expect(await withUploadSlot(response(), async () => 'saved', limiter)).toBe('saved');
  await expect(withUploadSlot(response(), async () => { throw new Error('storage failed'); }, limiter)).rejects.toThrow('storage failed');
  expect(limiter.stats()).toEqual({active: 0, waiting: 0});
  let finish!: () => void;
  const running = withUploadSlot(response(), () => new Promise<void>(resolve => (finish = resolve)), limiter);
  const queued = response();
  const waiting = withUploadSlot(queued, async () => 'never', limiter);
  const rejected = response();
  await expect(withUploadSlot(rejected, async () => 'never', limiter)).rejects.toMatchObject({status: 503});
  expect(rejected.headers['Retry-After']).toBe('5');
  queued.emit('close');
  await expect(waiting).rejects.toMatchObject({status: 503});
  expect(limiter.stats()).toEqual({active: 1, waiting: 0});
  finish();
  await running;
  expect(limiter.stats()).toEqual({active: 0, waiting: 0});
});

test('boot configuration report flags missing settings without printing secrets', async () => {
  expect(main.log()).toContain('[config] photo storage: filesystem at');
  expect(main.log()).toContain('[config] STORAGE_DIR write/read/delete check passed');
  expect(main.log()).toContain('[config] APP_ORIGIN is not set');
  expect(main.log()).not.toContain(env.ACCOUNT_PASSWORD_KEY!);
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error'] as const).map(level =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(level + ' ' + args.join(' ')); }));
  try {
    expect(await checkConfig({})).toBe(false);
    expect(lines.join('\n')).toContain('error [config] DATABASE_URL is not set');
    lines.length = 0;
    const secret = 'secret-' + randomUUID();
    expect(await checkConfig({DATABASE_URL: `postgres://user:${secret}@db/terrain`, ACCOUNT_PASSWORD_KEY: 'short',
      S3_BUCKET: 'photos', S3_SECRET_ACCESS_KEY: secret, APP_ORIGIN: 'https://ok.example, https://bad.example/path'})).toBe(true);
    const report = lines.join('\n');
    expect(report).toContain('error [config] ACCOUNT_PASSWORD_KEY is missing or is not 64 hex characters');
    expect(report).toContain('error [config] incomplete S3 configuration (only S3_BUCKET, S3_SECRET_ACCESS_KEY set)');
    expect(report).toContain('error [config] no photo storage configured');
    expect(report).toContain('warn [config] APP_ORIGIN entry "https://bad.example/path"');
    expect(report).not.toContain(secret);
    lines.length = 0;
    const probe = join(directory, 'probe');
    expect(await checkConfig({DATABASE_URL: 'postgres://db/terrain', ACCOUNT_PASSWORD_KEY: 'a'.repeat(64), STORAGE_DIR: probe, APP_ORIGIN: 'https://ok.example'})).toBe(true);
    expect(lines.filter(line => !line.startsWith('log '))).toEqual([]);
    expect(readdirSync(probe)).toEqual([]);
    lines.length = 0;
    writeFileSync(join(directory, 'not-a-directory'), '');
    await checkConfig({DATABASE_URL: 'postgres://db/terrain', ACCOUNT_PASSWORD_KEY: 'a'.repeat(64), STORAGE_DIR: join(directory, 'not-a-directory'), APP_ORIGIN: 'https://ok.example'});
    expect(lines.join('\n')).toContain('error [config] STORAGE_DIR write/read/delete check FAILED');
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
