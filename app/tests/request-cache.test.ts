import {expect, test} from 'bun:test';
import {createRequestCache} from '../src/terrain/ui/request-cache';
import {checkedResult} from '../src/terrain/domain/response-checks';

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: any) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

test('repeat visits reuse fresh data and expire after 15 seconds', async () => {
  let time = 0, calls = 0;
  const client = createRequestCache(async () => ({revision: ++calls}), () => time);
  expect(await client.request('action=missions&from=2026-11-01')).toEqual({revision: 1});
  time = 14000;
  expect(await client.request('from=2026-11-01&action=missions')).toEqual({revision: 1});
  expect(calls).toBe(1);
  time = 15000;
  expect(client.cached('action=missions&from=2026-11-01')).toBeUndefined();
  expect(await client.request('action=missions&from=2026-11-01')).toEqual({revision: 2});
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
  expect(client.cached('action=missions')).toBeUndefined();
  const nextRead = client.request('action=missions');
  expect(reads).toBe(1);
  write.resolve(null);
  await saved;
  expect(await nextRead).toEqual({revision: 2});
  expect(reads).toBe(2);
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

test('failed writes invalidate cached state too', async () => {
  let reads = 0;
  const client = createRequestCache(async (_query, body) => {
    if (body) throw new Error('Write failed');
    return {revision: ++reads};
  });
  await client.request('action=performance');
  await expect(client.request('', {action: 'sale'})).rejects.toThrow('Write failed');
  expect(client.cached('action=performance')).toBeUndefined();
  expect(await client.request('action=performance')).toEqual({revision: 2});
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

test('bootstrap, credentials, individual records and audit data are never cached', async () => {
  let calls = 0;
  const client = createRequestCache(async () => ({revision: ++calls}));
  for (const query of ['', 'action=bootstrap', 'action=user-password', 'action=mission&id=test', 'action=audit', 'action=service-detail&id=test']) {
    const before = calls;
    await client.request(query);
    await client.request(query);
    expect(calls - before).toBe(2);
    expect(client.cached(query)).toBeUndefined();
  }
});

test('different filters stay separate and an external tab invalidation forces a fresh read', async () => {
  let calls = 0;
  const client = createRequestCache(async query => ({query, revision: ++calls}));
  const first = await client.request('action=performance&person=one');
  const second = await client.request('action=performance&person=two');
  expect(first.query).not.toBe(second.query);
  expect(calls).toBe(2);
  client.clear();
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
