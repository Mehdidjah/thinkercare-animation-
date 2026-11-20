import {beforeEach, expect, test} from 'bun:test';

// No cross-tab channel in this process; every request goes to the stub below.
(globalThis as any).BroadcastChannel = undefined;
type Reply = {status?: number; body: unknown} | Error | Response | Promise<Response>;
let replies: Reply[] = [];
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push((init?.method || 'GET') + ' ' + String(input) + (init?.body && typeof init.body === 'string' ? ' ' + JSON.parse(init.body).action : ''));
  const reply = replies.shift();
  if (!reply) throw new Error('unexpected request ' + String(input));
  if (reply instanceof Error) throw reply;
  if (reply instanceof Response || reply instanceof Promise) return reply;
  return new Response(JSON.stringify(reply.body), {status: reply.status ?? 200, headers: {'content-type': 'application/json'}});
}) as typeof fetch;
const json = (body: unknown) => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});

/** Stands in for the cross-tab channel; `deliver` plays a message sent by another tab. */
class FakeChannel {
  static last: FakeChannel;
  sent: unknown[] = [];
  onmessage: ((event: {data: unknown}) => void) | null = null;
  constructor() {FakeChannel.last = this;}
  postMessage(data: unknown) {this.sent.push(data);}
  deliver(data: unknown) {this.onmessage?.({data});}
}
async function withChannel() {
  (globalThis as any).BroadcastChannel = FakeChannel;
  try {return {client: await fresh(), channel: FakeChannel.last};} finally {(globalThis as any).BroadcastChannel = undefined;}
}
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

test('the bonus strip or the attendance alerts sent with bootstrap are shown without another request', async () => {
  const client = await fresh();
  const bonuses = {today: {tickets: 1, bonus: 5000, revenue: 9}, month: {tickets: 1, bonus: 5000, revenue: 9}, months: [], days: []};
  replies.push({body: {...bootstrap('u1'), prefetch: {...bootstrap('u1').prefetch, bonuses: {query: 'action=bonuses', data: bonuses},
    'attendance-alerts': {query: 'action=attendance-alerts', data: {alerts: [{id: 'a'}]}},
    // A mislabelled entry is ignored.
    performance: {query: 'action=bonuses', data: {}}}}});
  await client.request();
  expect(await client.request('action=bonuses')).toEqual(bonuses);
  expect(await client.request('action=attendance-alerts')).toEqual({alerts: [{id: 'a'}]});
  expect(calls).toEqual(['GET /api/terrain']);
  expect(client.cachedResult('action=performance')).toBeUndefined();
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

test('a photo upload does not hold reads back, then refreshes the open screens', async () => {
  const client = await fresh();
  replies.push({body: bootstrap('u1')}, {body: {stocks: [{product_id: 'p'}]}});
  await client.request();
  await client.request('action=stocks&store=s1');
  let refreshed = 0;
  const off = client.onDataChange(() => refreshed++);
  let answer!: (response: Response) => void;
  replies.push(new Promise<Response>(resolve => (answer = resolve)));
  const sending = client.upload('/api/photos', new FormData());
  // A mission sheet opened meanwhile loads at once instead of waiting for the photo.
  replies.push({body: {stocks: [{product_id: 'q'}]}});
  expect(await client.request('action=stocks&store=s2')).toEqual({stocks: [{product_id: 'q'}]});
  expect(calls.slice(-2)).toEqual(['POST /api/photos', 'GET /api/terrain?action=stocks&store=s2']);
  expect(refreshed).toBe(0);
  answer(json({ok: true, id: 'photo'}));
  expect(await sending).toEqual({ok: true, id: 'photo'});
  expect(refreshed).toBe(1);
  // Results from before the upload stay on screen but are read again.
  expect(client.cachedResult('action=stocks&store=s1')).toEqual({stocks: [{product_id: 'p'}]});
  replies.push({body: {stocks: []}});
  expect(await client.request('action=stocks&store=s1')).toEqual({stocks: []});
  off();
});

test('a logout in another tab logs this one out without the expired-session prompt', async () => {
  const {client, channel} = await withChannel();
  replies.push({body: bootstrap('u1')});
  await client.request();
  let asked = 0, ended = 0, reloaded = 0;
  const offs = [client.onAuthRequired(() => asked++), client.onLogout(() => ended++), client.onSessionChange(() => reloaded++)];
  channel.deliver('logout');
  expect([ended, asked, reloaded]).toEqual([1, 0, 0]);
  expect(client.cachedResult(planning)).toBeUndefined();
  // A poll answered 401 afterwards does not raise the prompt either.
  replies.push(expired);
  await expect(client.request('action=bonuses', undefined, {fresh: true})).rejects.toMatchObject({status: 401});
  expect(asked).toBe(0);
  offs.forEach(off => off());
});

test('logging out tells the other tabs to log out, logging in tells them to reload', async () => {
  const {client, channel} = await withChannel();
  replies.push({body: {ok: true, ...bootstrap('u1')}}, {body: {ok: true}});
  await client.request('', {action: 'login', username: 'a', password: 'b'});
  expect(channel.sent.filter(m => m !== 'invalidate')).toEqual(['session']);
  await client.logout();
  expect(channel.sent.filter(m => m !== 'invalidate')).toEqual(['session', 'logout']);
});

test('logout ends logged out locally even when the server cannot be reached', async () => {
  const client = await fresh();
  replies.push({body: bootstrap('u1')}, new TypeError('Failed to fetch'));
  await client.request();
  await expect(client.logout()).rejects.toThrow('Connexion impossible');
  expect(client.cachedResult(planning)).toBeUndefined();
});
