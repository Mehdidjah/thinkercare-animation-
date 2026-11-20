type Options = {fresh?: boolean; maxAge?: number};
type Transport = (query: string, body?: any) => Promise<any>;
const CACHE_MS = 15000;
const MAX_ENTRIES = 40;
// Mission sheets too: reopening one shows it at once while it refreshes.
const CACHEABLE = new Set(['missions', 'mission', 'attendance-alerts', 'performance', 'bonuses', 'service-list', 'field-notes', 'stocks', 'reports']);

/** In-memory, stale-while-revalidate reads. Credentials and account/bootstrap
 * data are never cached. A write marks every entry stale (screens keep showing
 * it), re-issues reads that were in flight and tells subscribers to refresh in
 * the background; clear() drops everything (logout, 401, account change). */
export function createRequestCache(transport: Transport, now = Date.now) {
  let generation = 0;
  let writing = 0;
  let waiting: (() => void)[] = [];
  const cache = new Map<string, {data: any; at: number; stale: boolean}>();
  const pending = new Map<string, Promise<any>>();
  const listeners = new Set<() => void>();
  const keyFor = (query: string) => {
    const params = new URLSearchParams(query);
    params.sort();
    return params.toString();
  };
  const cacheable = (query: string) => CACHEABLE.has(new URLSearchParams(query).get('action') || '');
  const store = (query: string, data: any, at: number) => {
    const key = keyFor(query);
    cache.delete(key);
    cache.set(key, {data, at, stale: false});
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  };
  const clear = () => {generation++; cache.clear(); pending.clear();};
  const invalidate = () => {generation++; pending.clear(); for (const item of cache.values()) item.stale = true;};
  const notify = () => listeners.forEach(listener => listener());
  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {listeners.delete(listener);};
  }
  /** Last known result, even when stale, for an immediate render. */
  function cached(query: string): any | undefined {
    return cache.get(keyFor(query))?.data;
  }
  function peek(query: string): {data: any; stale: boolean} | undefined {
    const item = cache.get(keyFor(query));
    return item && {data: item.data, stale: item.stale || now() - item.at >= CACHE_MS};
  }
  /** Seeds a read the server already answered (bootstrap prefetch). */
  function prime(query: string, data: any) {
    if (cacheable(query)) store(query, data, now());
  }
  async function write<T>(run: () => Promise<T>): Promise<T> {
    writing++;
    invalidate();
    try {return await run();} finally {
      invalidate();
      if (--writing === 0) {const callbacks = waiting; waiting = []; callbacks.forEach(resolve => resolve());}
      notify();
    }
  }
  async function request(query = '', body?: any, options: Options = {}): Promise<any> {
    if (body !== undefined) return write(() => transport(query, body));
    if (writing) await new Promise<void>(resolve => waiting.push(resolve));
    const key = keyFor(query), item = cache.get(key), maxAge = options.fresh ? 0 : options.maxAge ?? CACHE_MS;
    if (item && !item.stale && now() - item.at < maxAge) return item.data;
    const existing = pending.get(key);
    if (existing) return existing;
    const version = generation, started = now();
    const promise = (async () => {
      try {
        const data = await transport(query);
        if (version !== generation) return request(query, undefined, {fresh: true});
        // Aged from the request start so a slow answer does not skip a polling cycle.
        if (cacheable(query)) store(query, data, started);
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
  return {request, write, cached, peek, prime, clear, invalidate, notify, subscribe};
}
