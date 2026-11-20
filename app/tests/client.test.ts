import {beforeEach, expect, test} from 'bun:test';

// No cross-tab channel in this process; every request goes to the stub below.
(globalThis as any).BroadcastChannel = undefined;
type Reply = {status?: number; body: unknown} | Error | Response;
let replies: Reply[] = [];
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push((init?.method || 'GET') + ' ' + String(input) + (init?.body && typeof init.body === 'string' ? ' ' + JSON.parse(init.body).action : ''));
  const reply = replies.shift();
  if (!reply) throw new Error('unexpected request ' + String(input));
  if (reply instanceof Error) throw reply;
  if (reply instanceof Response) return reply;
  return new Response(JSON.stringify(reply.body), {status: reply.status ?? 200, headers: {'content-type': 'application/json'}});
}) as typeof fetch;
// The client keeps the session in module state: each test gets its own copy, so they pass in any order.
let instance = 0;
const fresh = (): Promise<typeof import('../src/terrain/ui/client')> => import('../src/terrain/ui/client.ts?test=' + ++instance);

const week = 'action=missions&from=2026-11-16&to=2026-11-22';
const planning = new URLSearchParams({action: 'missions', from: '2026-11-16', to: '2026-11-22'}).toString();
const bootstrap = (id: string, prefetch = true) => ({
  user: {id, role: 'field'}, products: [], stores: [], users: [], devices: [], limited: false,
  ...(prefetch ? {prefetch: {missions: {query: week, data: {missions: [{id: 'm-' + id}], truncated: false, serverTime: 'x'}}}} : {}),
});
const expired = {status: 401, body: {error: 'Votre session a expiré.'}};

beforeEach(() => {replies = []; calls.length = 0;});

test('the week sent with bootstrap is shown by the planning without a second request', async () => {
  const client = await fresh();
  replies.push({body: bootstrap('u1')});
  await client.request();
  expect(await client.request(planning)).toMatchObject({missions: [{id: 'm-u1'}]});
  expect(calls).toEqual(['GET /api/terrain']);
});

test('any 401 outside the login form asks to log in again once and drops cached data', async () => {
  const client = await fresh();
  replies.push({body: bootstrap('u1')});
  await client.request();
  let asked = 0;
  const off = client.onAuthRequired(() => asked++);
  replies.push(expired, expired);
  await expect(client.request('action=bonuses', undefined, {fresh: true})).rejects.toMatchObject({status: 401});
  await expect(client.request('action=performance')).rejects.toMatchObject({status: 401});
  expect(asked).toBe(1);
  expect(client.sessionExpired()).toBe(true);
  expect(client.cachedResult(planning)).toBeUndefined();
  replies.push({status: 401, body: {error: 'Identifiant ou mot de passe incorrect.'}});
  await expect(client.request('', {action: 'login', username: 'a', password: 'b'})).rejects.toMatchObject({status: 401});
  expect(asked).toBe(1);
  off();
});

test('logging in again as the same account resumes and refreshes the open screens', async () => {
  const client = await fresh();
  replies.push({body: bootstrap('u1')}, expired);
  await client.request();
  await expect(client.request('action=bonuses', undefined, {fresh: true})).rejects.toMatchObject({status: 401});
  expect(client.sessionExpired()).toBe(true);
  let refreshed = 0;
  const off = client.onDataChange(() => refreshed++);
  replies.push({body: {ok: true, ...bootstrap('u1')}});
  await client.request('', {action: 'login', username: 'a', password: 'b'});
  expect(client.sessionExpired()).toBe(false);
  expect(refreshed).toBeGreaterThan(0);
  expect(client.cachedResult(planning)).toMatchObject({missions: [{id: 'm-u1'}]});
  off();
});

test('another account drops everything the previous one had loaded', async () => {
  const client = await fresh();
  replies.push({body: bootstrap('u1')}, {body: {stocks: [{product_id: 'p'}]}});
  await client.request();
  await client.request('action=stocks&store=s1');
  expect(client.cachedResult('action=stocks&store=s1')).toBeDefined();
  replies.push({body: bootstrap('u2', false)});
  await client.request();
  expect(client.cachedResult('action=stocks&store=s1')).toBeUndefined();
  expect(client.cachedResult(planning)).toBeUndefined();
});

test('a non-JSON gateway error shows the unavailable message', async () => {
  const client = await fresh();
  replies.push(new Response('<html>502</html>', {status: 502, headers: {'content-type': 'text/html'}}));
  await expect(client.request('action=service-list', undefined, {fresh: true})).rejects.toThrow('momentanément indisponible');
});

test('logging out with an already expired session counts as logged out', async () => {
  const client = await fresh();
  replies.push(expired);
  let asked = 0;
  const off = client.onAuthRequired(() => asked++);
  await client.logout();
  expect(asked).toBe(0);
  off();
});

test('logout ends logged out locally even when the server cannot be reached', async () => {
  const client = await fresh();
  replies.push({body: bootstrap('u1')}, new TypeError('Failed to fetch'));
  await client.request();
  await expect(client.logout()).rejects.toThrow('Connexion impossible');
  expect(client.cachedResult(planning)).toBeUndefined();
});
