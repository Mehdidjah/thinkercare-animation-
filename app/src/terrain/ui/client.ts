import {createRequestCache} from './request-cache';
import {checkedResult} from '../domain/response-checks';
import {readJson, unsure, OFFLINE} from './http';

// Same origin only: the session cookie is __Host- and SameSite=Strict, and photo
// URLs are relative. Vercel and the Vite dev server proxy /api to the API.
async function send(action: string, body?: any) {
  const response = await fetch('/api/terrain' + (action ? '?' + action : ''), {
    method: body ? 'POST' : 'GET', credentials: 'same-origin',
    headers: body ? {'Content-Type': 'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {throw unsure(OFFLINE);});
  const data = await readJson(response);
  return body === undefined ? checkedResult(action, data) : data;
}
const client = createRequestCache(send);

// Tabs share invalidations and session changes, never account data.
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('terrain-data-changed');
const authListeners = new Set<() => void>();
const sessionListeners = new Set<() => void>();
let owner: string | null = null;
let expired = false;
if (channel) channel.onmessage = event => {
  if (event.data === 'session') {client.clear(); sessionListeners.forEach(listener => listener());}
  else {client.invalidate(); client.notify();}
};

function subscribe(set: Set<() => void>, listener: () => void) {
  set.add(listener);
  return () => {set.delete(listener);};
}
export const cachedResult = client.cached;
export const onDataChange = client.subscribe;
/** Any 401 outside the login form: the session is gone, ask to log in again. */
export const onAuthRequired = (listener: () => void) => subscribe(authListeners, listener);
/** Another tab logged in or out. */
export const onSessionChange = (listener: () => void) => subscribe(sessionListeners, listener);
export const sessionExpired = () => expired;

function failed(error: unknown, login = false) {
  if ((error as {status?: number})?.status === 401 && !login) {
    client.clear();
    if (!expired) {expired = true; authListeners.forEach(listener => listener());}
  }
  return error;
}

// Bootstrap and login answers carry the account: a different account drops
// every cached read, and the week's missions sent along are reused as is.
function session(result: any) {
  const wasExpired = expired, id = typeof result?.user?.id === 'string' ? result.user.id : null;
  expired = false;
  if (id !== owner) {client.clear(); owner = id;}
  const prefetch = result?.prefetch?.missions;
  if (typeof prefetch?.query === 'string' && new URLSearchParams(prefetch.query).get('action') === 'missions' && Array.isArray(prefetch.data?.missions)) {
    client.prime(prefetch.query, prefetch.data);
  }
  if (wasExpired) client.notify();
}

export async function request(action = '', body?: any, options?: {fresh?: boolean; maxAge?: number}) {
  const login = body?.action === 'login';
  if (body !== undefined) channel?.postMessage('invalidate');
  try {
    const data = await client.request(action, body, options);
    if (login || body === undefined && !action) session(data);
    if (login) channel?.postMessage('session');
    return data;
  } catch (error) {
    throw failed(error, login);
  } finally {
    if (body !== undefined && !login) channel?.postMessage('invalidate');
  }
}

/** Multipart photo POST: counts as a write (screens refresh, other tabs too). */
export async function upload(path: '/api/photos' | '/api/field-photos', body: FormData) {
  channel?.postMessage('invalidate');
  try {
    return await client.write(async () => {
      const response = await fetch(path, {method: 'POST', body, credentials: 'same-origin'}).catch(() => {
        throw unsure('Envoi non confirmé. Vérifiez votre connexion puis réessayez.');
      });
      return readJson(response);
    });
  } catch (error) {
    throw failed(error);
  } finally {
    channel?.postMessage('invalidate');
  }
}

/** Always ends logged out locally, even when the server cannot be reached.
 * A 401 means the session was already gone: that is a confirmed logout. */
export async function logout() {
  expired = true;
  client.clear();
  try {
    await send('', {action: 'logout'});
  } catch (error) {
    if ((error as {status?: number})?.status !== 401) throw error;
  } finally {
    owner = null;
    client.clear();
    channel?.postMessage('session');
  }
}
