import {expect, test} from 'bun:test';
import {createRequestCache} from '../src/terrain/ui/request-cache';
import {checkedResult} from '../src/terrain/domain/response-checks';

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: any) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

test('repeat visits reuse fresh data; after 15 seconds the last result stays visible but is refetched', async () => {
  let time = 0, calls = 0;
  const client = createRequestCache(async () => ({revision: ++calls}), () => time);
  expect(await client.request('action=missions&from=2026-11-01')).toEqual({revision: 1});
  time = 14000;
  expect(await client.request('from=2026-11-01&action=missions')).toEqual({revision: 1});
  expect(calls).toBe(1);
  time = 15000;
  expect(client.peek('action=missions&from=2026-11-01')).toEqual({data: {revision: 1}, stale: true});
  expect(client.cached('action=missions&from=2026-11-01')).toEqual({revision: 1});
  expect(await client.request('action=missions&from=2026-11-01')).toEqual({revision: 2});
  expect(client.peek('action=missions&from=2026-11-01')).toEqual({data: {revision: 2}, stale: false});
});

test('simultaneous readers share a request; explicit refresh still gets new data', async () => {
  const result = deferred();
  let calls = 0;
  const client = createRequestCache(async () => {calls++; return result.promise;});
  const one = client.request('action=bonuses'), two = client.request('action=bonuses');
  expect(calls).toBe(1);
  result.resolve({bonus: 5000});
  expect(await one).toEqual(await two);
  await client.request('action=bonuses', undefined, {fresh: true});
  expect(calls).toBe(2);
});

test('two widgets polling the same query issue one request per period', async () => {
  let time = 0, calls = 0;
  const client = createRequestCache(async () => ({revision: ++calls}), () => time);
  await client.request('action=bonuses', undefined, {maxAge: 54000});
  time = 7000;
  await client.request('action=bonuses', undefined, {maxAge: 54000});
  expect(calls).toBe(1);
  time = 60000;
  await client.request('action=bonuses', undefined, {maxAge: 54000});
  time = 67000;
  await client.request('action=bonuses', undefined, {maxAge: 54000});
  expect(calls).toBe(2);
});

test('an answer is aged from the request start, so a slow answer does not skip the next poll', async () => {
  let time = 0, calls = 0;
  const client = createRequestCache(async () => {calls++; time += 3000; return {revision: calls};}, () => time);
  await client.request('action=missions', undefined, {maxAge: 18000});
  time = 20000;
  expect(await client.request('action=missions', undefined, {maxAge: 18000})).toEqual({revision: 2});
});

test('reads during a write wait for confirmation and never reuse pre-write data', async () => {
  const write = deferred();
  let revision = 1, reads = 0;
  const client = createRequestCache(async (_query, body) => {
    if (body) {await write.promise; revision = 2; return {ok: true};}
    reads++;
    return {revision};
  });
  await client.request('action=missions');
  const saved = client.request('', {action: 'schedule'});
  expect(client.peek('action=missions')?.stale).toBe(true);
  const nextRead = client.request('action=missions');
  expect(reads).toBe(1);
  write.resolve(null);
  await saved;
  expect(await nextRead).toEqual({revision: 2});
  expect(reads).toBe(2);
});

test('a write keeps the last results on screen (stale) and asks subscribers to refresh them', async () => {
  let revision = 1, notified = 0;
  const client = createRequestCache(async (_query, body) => body ? {ok: true} : {revision});
  const off = client.subscribe(() => notified++);
  await client.request('action=missions');
  revision = 2;
  await client.request('', {action: 'sale'});
  expect(notified).toBe(1);
  expect(client.cached('action=missions')).toEqual({revision: 1});
  expect(client.peek('action=missions')?.stale).toBe(true);
  expect(await client.request('action=missions')).toEqual({revision: 2});
  off();
  await client.write(async () => ({ok: true}));
  expect(notified).toBe(1);
});

test('an old account response cannot return or repopulate cache after login/logout', async () => {
  const oldRead = deferred();
  let reads = 0;
  const client = createRequestCache(async (_query, body) => {
    if (body) return {ok: true};
    if (++reads === 1) return oldRead.promise;
    return {owner: 'new-account'};
  });
  const pending = client.request('action=service-list');
  await client.request('', {action: 'logout'});
  await client.request('', {action: 'login'});
  oldRead.resolve({owner: 'previous-account'});
  expect(await pending).toEqual({owner: 'new-account'});
  expect(client.cached('action=service-list')).toEqual({owner: 'new-account'});
});

test('a hard clear (logout, account change) drops even stale results and in-flight reads', async () => {
  const slow = deferred();
  let calls = 0;
  const client = createRequestCache(async () => (++calls === 2 ? slow.promise : {revision: calls}));
  await client.request('action=performance');
  const inFlight = client.request('action=stocks&store=x');
  client.clear();
  expect(client.cached('action=performance')).toBeUndefined();
  slow.resolve({owner: 'previous-account'});
  expect(await inFlight).toEqual({revision: 3});
});

test('failed writes invalidate cached state too', async () => {
  let reads = 0;
  const client = createRequestCache(async (_query, body) => {
    if (body) throw new Error('Write failed');
    return {revision: ++reads};
  });
  await client.request('action=performance');
  await expect(client.request('', {action: 'sale'})).rejects.toThrow('Write failed');
  expect(client.peek('action=performance')?.stale).toBe(true);
  expect(await client.request('action=performance')).toEqual({revision: 2});
});

test('an invalidation (photo upload) marks results stale and re-issues reads in flight, without holding new reads', async () => {
  const first = deferred();
  let reads = 0;
  const client = createRequestCache(async () => (++reads === 1 ? first.promise : {revision: reads}));
  const inFlight = client.request('action=missions');
  client.invalidate();
  expect(await client.request('action=bonuses')).toEqual({revision: 2});
  first.resolve({revision: 'before the upload'});
  expect(await inFlight).toEqual({revision: 3});
  client.invalidate();
  expect(client.peek('action=missions')?.stale).toBe(true);
  expect(await client.request('action=missions')).toEqual({revision: 4});
});

test('authentication/authorization failures discard every cached result and are not cached', async () => {
  let authorized = true, calls = 0;
  const client = createRequestCache(async () => {
    calls++;
    if (!authorized) throw Object.assign(new Error('Denied'), {status: 403});
    return {cases: []};
  });
  await client.request('action=service-list');
  authorized = false;
  await expect(client.request('action=bonuses')).rejects.toMatchObject({status: 403});
  expect(client.cached('action=service-list')).toBeUndefined();
  await expect(client.request('action=bonuses')).rejects.toMatchObject({status: 403});
  expect(calls).toBe(3);
});

test('bootstrap, credentials, audit data and medical case details are never cached', async () => {
  let calls = 0;
  const client = createRequestCache(async () => ({revision: ++calls}));
  for (const query of ['', 'action=bootstrap', 'action=user-password', 'action=audit', 'action=service-detail&id=test', 'action=field-note&id=test']) {
    const before = calls;
    await client.request(query);
    await client.request(query);
    expect(calls - before).toBe(2);
    expect(client.cached(query)).toBeUndefined();
    client.prime(query, {primed: true});
    expect(client.cached(query)).toBeUndefined();
  }
});

test('a mission sheet reopened shows its last result at once and is refreshed after a save', async () => {
  let revision = 1, calls = 0;
  const client = createRequestCache(async (_query, body) => body ? {ok: true} : {revision, calls: ++calls});
  expect(await client.request('action=mission&id=m1')).toEqual({revision: 1, calls: 1});
  expect(client.cached('action=mission&id=m1')).toEqual({revision: 1, calls: 1});
  revision = 2;
  await client.request('', {action: 'sale'});
  expect(client.cached('action=mission&id=m1')).toEqual({revision: 1, calls: 1});
  expect(await client.request('action=mission&id=m1')).toEqual({revision: 2, calls: 2});
});

test('the week sent with bootstrap primes the planning query, whatever the parameter order', async () => {
  let calls = 0;
  const client = createRequestCache(async () => ({missions: [], revision: ++calls}));
  client.prime('action=missions&from=2026-11-16&to=2026-11-22', {missions: [{id: 'm1'}]});
  const planning = new URLSearchParams({action: 'missions', from: '2026-11-16', to: '2026-11-22'}).toString();
  expect(await client.request(planning)).toEqual({missions: [{id: 'm1'}]});
  expect(await client.request('to=2026-11-22&from=2026-11-16&action=missions')).toEqual({missions: [{id: 'm1'}]});
  expect(calls).toBe(0);
});

test('different filters stay separate and an external tab invalidation forces a fresh read', async () => {
  let calls = 0;
  const client = createRequestCache(async query => ({query, revision: ++calls}));
  const first = await client.request('action=performance&person=one');
  const second = await client.request('action=performance&person=two');
  expect(first.query).not.toBe(second.query);
  expect(calls).toBe(2);
  client.invalidate();
  await client.request('action=performance&person=one');
  expect(calls).toBe(3);
});

test('invalid API results are rejected before they can be reused on a later visit', async () => {
  let calls = 0;
  const client = createRequestCache(async query => {
    calls++;
    return checkedResult(query, calls === 1 ? {cases: null} : {cases: []});
  });
  await expect(client.request('action=service-list')).rejects.toThrow('La réponse reçue est incomplète.');
  expect(client.cached('action=service-list')).toBeUndefined();
  expect(await client.request('action=service-list')).toEqual({cases: []});
  expect(calls).toBe(2);
});
