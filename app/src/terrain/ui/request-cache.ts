type Options = {fresh?: boolean};
type Transport = (query: string, body?: any) => Promise<any>;
const CACHE_MS = 15000;
const MAX_ENTRIES = 40;
const CACHEABLE = new Set(['missions', 'attendance-alerts', 'performance', 'bonuses', 'service-list', 'field-notes', 'stocks', 'reports']);

/** Short-lived, in-memory reads only. Credentials and account/bootstrap data
 * are never cached. Every write invalidates both cached and in-flight reads. */
export function createRequestCache(transport: Transport, now = Date.now) {
  let generation = 0;
  let writing = 0;
  let waiting: (() => void)[] = [];
  const cache = new Map<string, {data: any; expires: number}>();
  const pending = new Map<string, Promise<any>>();
  const keyFor = (query: string) => {
    const params = new URLSearchParams(query);
    params.sort();
    return params.toString();
  };
  const clear = () => {generation++; cache.clear(); pending.clear();};
  function cached(query: string): any | undefined {
    const key = keyFor(query), item = cache.get(key);
    if (!item) return undefined;
    if (item.expires <= now()) {cache.delete(key); return undefined;}
    return item.data;
  }
  async function request(query = '', body?: any, options: Options = {}): Promise<any> {
    if (body !== undefined) {
      writing++;
      clear();
      try {return await transport(query, body);} finally {
        clear();
        if (--writing === 0) {const callbacks = waiting; waiting = []; callbacks.forEach(resolve => resolve());}
      }
    }
    if (writing) await new Promise<void>(resolve => waiting.push(resolve));
    const key = keyFor(query);
    const hit = !options.fresh ? cached(query) : undefined;
    if (hit !== undefined) return hit;
    const existing = pending.get(key);
    if (existing) return existing;
    const version = generation;
    const promise = (async () => {
      try {
        const data = await transport(query);
        if (version !== generation) return request(query, undefined, {fresh: true});
        if (CACHEABLE.has(new URLSearchParams(query).get('action') || '')) {
          cache.delete(key);
          cache.set(key, {data, expires: now() + CACHE_MS});
          if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
        }
        return data;
      } catch (error) {
        if (version !== generation) return request(query, undefined, {fresh: true});
        if ([401, 403].includes((error as any).status)) clear();
        throw error;
      }
    })();
    pending.set(key, promise);
    try {return await promise;} finally {if (pending.get(key) === promise) pending.delete(key);}
  }
  return {request, cached, clear};
}
