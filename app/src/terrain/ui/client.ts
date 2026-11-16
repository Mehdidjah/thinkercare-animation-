import {createRequestCache} from './request-cache';
import {checkedResult} from '../domain/response-checks';

const API = import.meta.env.VITE_API_URL || '';
const client = createRequestCache(async (action, body) => {
  const response = await fetch(API + '/api/terrain' + (action ? '?' + action : ''), {
    method: body ? 'POST' : 'GET', credentials: 'include',
    headers: body ? {'Content-Type': 'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Connexion indisponible.'), {status: response.status});
  return body === undefined ? checkedResult(action, data) : data;
});

// Synchronize invalidation between tabs without storing any account data.
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('terrain-data-changed');
if (channel) channel.onmessage = () => client.clear();
export const cachedResult = client.cached;
export async function request(action = '', body?: any, options?: {fresh?: boolean}) {
  if (body !== undefined) channel?.postMessage('invalidate');
  try {return await client.request(action, body, options);}
  finally {if (body !== undefined) channel?.postMessage('invalidate');}
}
