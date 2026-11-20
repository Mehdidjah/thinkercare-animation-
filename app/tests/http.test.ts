import {expect, test} from 'bun:test';
import {readJson, retryable, unsure, UNAVAILABLE} from '../src/terrain/ui/http';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json; charset=utf-8'}});

test('a proxy error page (HTML 502/504) gives a readable message, not a SyntaxError', async () => {
  for (const status of [502, 504]) {
    const page = new Response('<html><body>Bad gateway</body></html>', {status, headers: {'content-type': 'text/html'}});
    const error = await readJson(page).catch(e => e);
    expect(error.message).toBe(UNAVAILABLE);
    expect(error.status).toBe(status);
    expect(retryable(error)).toBe(true);
  }
});

test('API errors keep their message and status; 4xx are not worth retrying', async () => {
  const conflict = await readJson(json({error: 'L’animation a changé.'}, 409)).catch(e => e);
  expect(conflict).toMatchObject({message: 'L’animation a changé.', status: 409});
  expect(retryable(conflict)).toBe(false);
  const busy = await readJson(json({error: 'Trop d’envois de photos en cours. Réessayez dans quelques secondes.'}, 503)).catch(e => e);
  expect(busy.status).toBe(503);
  expect(retryable(busy)).toBe(true);
});

test('a cut-off or non-JSON success is reported as unconfirmed', async () => {
  const truncated = new Response('{"ok":tr', {status: 200, headers: {'content-type': 'application/json'}});
  const error = await readJson(truncated).catch(e => e);
  expect(error.message).toBe(UNAVAILABLE);
  expect(retryable(error)).toBe(true);
  expect(await readJson(json({ok: true}))).toEqual({ok: true});
});

test('network failures are retryable, local checks are not', () => {
  expect(retryable(unsure('Connexion impossible.'))).toBe(true);
  expect(retryable(new Error('Photo illisible.'))).toBe(false);
  expect(retryable(Object.assign(new Error('Session'), {status: 401}))).toBe(false);
});
