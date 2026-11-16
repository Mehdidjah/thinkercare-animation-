import {checkedResult} from '../domain/response-checks';
import {useState, useEffect, useCallback, useRef, type ReactNode, type FormEvent} from 'react';
import {request, cachedResult} from './client';
import {csv} from '../domain/core';

export function useRemote(query:string, enabled=true) {
 const [data,setData] = useState<any>(() => enabled ? cachedResult(query) ?? null : null);
 const [error,setError] = useState('');
 const [loading,setLoading] = useState(() => enabled && cachedResult(query) === undefined);
 const latest = useRef({query, sequence:0, mounted:true});
 latest.current.query = query;

 const reload = useCallback(async (fresh=true) => {
  if (!enabled) return;
  const sequence = ++latest.current.sequence;
  const isCurrent = () => latest.current.mounted && latest.current.query===query && latest.current.sequence===sequence;
  try {
   const result = checkedResult(query, await request(query, undefined, {fresh}));
   if (isCurrent()) {setData(result);setError('');}
  } catch (e) {
   if (isCurrent() && !(e as any).stale) {
    setError((e as Error).message);
    if ([401,403].includes((e as any).status)) setData(null);
   }
  } finally {
   if (isCurrent()) setLoading(false);
  }
 }, [query,enabled]);

 useEffect(() => {
  latest.current.mounted=true;
  const cached = enabled ? cachedResult(query) : undefined;
  setData(cached ?? null);
  setError('');
  setLoading(enabled && cached === undefined);
  if (!enabled) return;
  void reload(false);
  const timer=setInterval(() => {
   if (document.visibilityState==='visible') void reload();
  },20000);
  return () => {
   latest.current.mounted=false;
   latest.current.sequence++;
   clearInterval(timer);
  };
 }, [reload]);

 return {data,error,loading,reload};
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
