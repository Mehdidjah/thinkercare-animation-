import {checkedResult} from '../domain/response-checks';
import {useState, useEffect, useCallback, useRef, type ReactNode, type FormEvent} from 'react';
import {request, cachedResult, onDataChange, sessionExpired} from './client';
import {csv} from '../domain/core';

/** Stale-while-revalidate read: the last known result renders at once and is
 * refreshed in the background, every `every` ms while the tab is visible, when
 * it becomes visible again and after any write. Widgets polling the same query
 * share one request. `reload()` without argument forces a network read. */
export function useRemote(query:string, enabled=true, every=20000) {
 const [data,setData] = useState<any>(() => enabled ? cachedResult(query) ?? null : null);
 const [error,setError] = useState('');
 const [loading,setLoading] = useState(() => enabled && cachedResult(query) === undefined);
 const latest = useRef({query, sequence:0, mounted:true});
 latest.current.query = query;

 const reload = useCallback(async (maxAge=0) => {
  if (!enabled) return;
  const sequence = ++latest.current.sequence;
  const isCurrent = () => latest.current.mounted && latest.current.query===query && latest.current.sequence===sequence;
  try {
   const result = checkedResult(query, await request(query, undefined, {maxAge}));
   if (isCurrent()) {setData(result);setError('');}
  } catch (e) {
   if (isCurrent()) {
    setError((e as Error).message);
    // A 401 keeps the screen as is under the login overlay; a 403 hides what is no longer allowed.
    if ((e as any).status===403) setData(null);
   }
  } finally {
   if (isCurrent()) setLoading(false);
  }
 }, [query,enabled]);

 useEffect(() => {
  const state=latest.current;
  state.mounted=true;
  const cached = enabled ? cachedResult(query) : undefined;
  setData(cached ?? null);
  setError('');
  setLoading(enabled && cached === undefined);
  if (!enabled) return;
  void reload(15000);
  const live = () => !document.hidden && !sessionExpired();
  // Most of a period: a widget polling the same query just before is reused.
  const timer=setInterval(() => {if (live()) void reload(every*0.9);},every);
  const visible = () => {if (live()) void reload(every*0.9);};
  document.addEventListener('visibilitychange',visible);
  const off = onDataChange(() => {if (live()) void reload(15000);});
  return () => {
   state.mounted=false;
   state.sequence++;
   clearInterval(timer);
   document.removeEventListener('visibilitychange',visible);
   off();
  };
 }, [reload,query,enabled,every]);

 return {data,error,loading,reload};
}

/** The value, once it has stopped changing for `ms` (typed dates). */
export function useSettled<T>(value:T, ms=500) {
 const [settled,setSettled] = useState(value);
 useEffect(() => {
  const timer=setTimeout(() => setSettled(value),ms);
  return () => clearTimeout(timer);
 }, [value,ms]);
 return settled;
}

export const formValues=(e:FormEvent<HTMLFormElement>) =>
 Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string,string>;

export function Warning({children}:{children:ReactNode}) {
 return <p className="notice error" role="alert">{children}</p>;
}

export function Dates({from,to,setFrom,setTo}:{from:string;to:string;setFrom:(v:string)=>void;setTo:(v:string)=>void}) {
 return <>
  <label>Du<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label>
  <label>Au<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>
 </>;
}

export function exportCSV(name:string,rows:unknown[][]) {
 const url=URL.createObjectURL(new Blob([csv(rows)],{type:'text/csv;charset=utf-8;'}));
 const link=document.createElement('a');
 link.href=url;
 link.download=name;
 link.click();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export const localDate=(s:string)=>
 new Date(s).toLocaleString('fr-FR',{timeZone:'Africa/Algiers',dateStyle:'short',timeStyle:'short'});
