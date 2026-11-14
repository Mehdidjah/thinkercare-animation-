import {photoFormData} from './body.server';
import {getOperations,postOperations,readFieldMedia,uploadFieldMedia} from './operations.server';
import {z} from 'zod';
import {bindings} from '../../lib/bindings.server';
import {manages,canMission,canEdit,dayInAlger,shiftDay,attendance,clockIssue,reportIssues,ticketTotal,type User} from '../domain/core';
const COOKIE='__Host-terrain-session';
const id=z.string().regex(/^[a-zA-Z0-9_-]{2,64}$/),uuid=z.string().uuid();
const brand=z.enum(['TOUCHE','BELNCO','NOOM']);
const text=(n=1200)=>z.string().trim().max(n);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>!isNaN(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s);
const qty=z.number().int().min(0).max(100000);
const j=(data:unknown,status=200,headers:Record<string,string>={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow',...headers}});
const DB=()=>{const d=bindings().DB;if(!d)throw new Error('NO_DB');return d};
const fail=(s:string,status=400):never=>{throw Object.assign(new Error(s),{status})};
const hex=(a:ArrayBuffer|Uint8Array)=>Array.from(new Uint8Array(a as ArrayBuffer),x=>x.toString(16).padStart(2,'0')).join('');
async function sha(s:string){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))}
async function passwordHash(s:string,salt:string){const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(s),'PBKDF2',false,['deriveBits']);return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new Uint8Array(salt.match(/../g)!.map(x=>parseInt(x,16))),iterations:100000},k,256))}
function equal(a:string,b:string){let d=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)d|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return d===0}
const token=(req:Request)=>(req.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
async function current(req:Request):Promise<User>{const t=token(req);if(!/^[a-f0-9]{64}$/.test(t))fail('Connectez-vous à votre espace.',401);const u=await DB().prepare('SELECT u.id,u.username,u.label,u.role,u.active,u.force_change FROM tf_users u JOIN tf_sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires>? AND u.active=1').bind(await sha(t),Date.now()).first<User>();if(!u)fail('Votre session a expiré.',401);return u!}
const audit=(u:User,action:string,target:string,detail:unknown={})=>DB().prepare('INSERT INTO tf_audit(id,user_id,at,action,target,detail) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),u.id,new Date().toISOString(),action,target,JSON.stringify(detail));
async function mission(u:User,key:string,edit=false):Promise<any>{const m=await DB().prepare('SELECT * FROM tf_missions WHERE id=?').bind(key).first<any>();if(!m||!canMission(u,m))fail('Animation non accessible.',403);if(edit&&!canEdit(u,m))fail('Cette animation est verrouillée. Une correction doit être demandée.',409);return{...m,brands:JSON.parse(m.brands)}}
async function batchMission(u:User,m:any,action:string,statements:any[],detail:unknown={}){const guard=crypto.randomUUID();await DB().batch([DB().prepare('INSERT INTO tf_guards(id,ok) VALUES(?,(SELECT CASE WHEN version=? THEN 1 ELSE 0 END FROM tf_missions WHERE id=?))').bind(guard,m.version,m.id),...statements,DB().prepare('UPDATE tf_missions SET version=version+1,updated_at=? WHERE id=?').bind(new Date().toISOString(),m.id),audit(u,action,m.id,detail),DB().prepare('DELETE FROM tf_guards WHERE id=?').bind(guard)]);}
async function sales(key:string){const r=await DB().prepare('SELECT * FROM tf_tickets WHERE mission_id=? ORDER BY created_at DESC').bind(key).all<any>();return r.results.map(x=>({...x,lines:JSON.parse(x.lines)}))}
async function counts(key:string){return(await DB().prepare('SELECT c.*,p.name AS product_name,p.brand,p.unit FROM tf_counts c JOIN tf_products p ON p.id=c.product_id WHERE mission_id=? ORDER BY p.brand,p.name').bind(key).all<any>()).results}
function range(q:URLSearchParams){const from=date.parse(q.get('from')||dayInAlger()),to=date.parse(q.get('to')||from);if(to<from||(Date.parse(to)-Date.parse(from))/86400000>366)fail('Période invalide (366 jours maximum).');return{from,to}}
const parseMission=(m:any)=>({...m,brands:JSON.parse(m.brands)});
export async function getTerrain(req:Request):Promise<Response>{try{
 const u=await current(req),q=new URL(req.url).searchParams,action=q.get('action')||'bootstrap';
 if(u.force_change&&action!=='bootstrap')fail('Changez votre mot de passe initial.',403);
 const extra=await getOperations(u,q);if(extra)return extra;
 if(action==='bootstrap'){
  const p=(await DB().prepare('SELECT * FROM tf_products ORDER BY brand,name LIMIT 2001').all()).results;
  const stores=u.role==='doctor'?[]:(await (manages(u)?DB().prepare('SELECT * FROM tf_stores ORDER BY name LIMIT 2001'):DB().prepare('SELECT DISTINCT s.* FROM tf_stores s JOIN tf_missions m ON m.store_id=s.id WHERE m.field_id=? ORDER BY s.name LIMIT 2001').bind(u.id)).all()).results;
  const users=manages(u)?(await DB().prepare('SELECT id,username,label,role,active,force_change FROM tf_users ORDER BY label LIMIT 1001').all()).results:[];
  const devices=manages(u)?(await DB().prepare('SELECT * FROM tf_devices ORDER BY name LIMIT 1001').all()).results:[];
  return j({user:u,products:u.force_change?[]:p,stores:u.force_change?[]:stores,users:u.force_change?[]:users,devices:u.force_change?[]:devices,limited:p.length>2000||stores.length>2000||users.length>1000||devices.length>1000,serverTime:new Date().toISOString()});
 }
 if(action==='attendance-alerts'){
  if(!manages(u))fail('Accès gestionnaire ou direction requis.',403);
  const now=new Date().toISOString(),today=dayInAlger(now);
  const r=(await DB().prepare(`SELECT m.*,s.name AS store_name,f.label AS field_name FROM tf_missions m JOIN tf_stores s ON s.id=m.store_id JOIN tf_users f ON f.id=m.field_id WHERE m.day>=? AND m.day<=? AND m.status!='cancelled' ORDER BY m.start_at DESC LIMIT 1001`).bind(shiftDay(today,-7),today).all<any>()).results;
  const a=(await DB().prepare('SELECT mission_id,kind,ack_at FROM tf_alert_ack WHERE user_id=?').bind(u.id).all<any>()).results;
  const alerts=r.slice(0,1000).flatMap(m=>{const x=attendance(m,now);return x?[{id:m.id+':'+x.kind,mission_id:m.id,store_name:m.store_name,field_name:m.field_name,day:m.day,start_at:m.start_at,actual_start:m.actual_start,start_photo_id:m.start_photo_id,...x,acknowledged:a.some(k=>k.mission_id===m.id&&k.kind===x.kind)}]:[]});
  return j({alerts,truncated:r.length>1000,serverTime:now});
 }
 if(action==='missions'){
  if(u.role==='doctor')fail('Accès aux réclamations uniquement.',403);const {from,to}=range(q);const args:any[]=[from,to],scope=manages(u)?'':' AND m.field_id=?';if(scope)args.push(u.id);
  const r=(await DB().prepare(`SELECT m.*,s.name AS store_name,s.city,s.address,f.label AS field_name,d.name AS device_name,(SELECT COALESCE(SUM(total),0) FROM tf_tickets t WHERE t.mission_id=m.id AND t.status='valid') AS sales_total,(SELECT COUNT(*) FROM tf_tickets t WHERE t.mission_id=m.id AND t.status='valid') AS tickets,(SELECT COALESCE(SUM(json_extract(l.value,'$.qty')),0) FROM tf_tickets t,json_each(t.lines) l WHERE t.mission_id=m.id AND t.status='valid') AS units FROM tf_missions m JOIN tf_stores s ON s.id=m.store_id JOIN tf_users f ON f.id=m.field_id LEFT JOIN tf_devices d ON d.id=m.device_id WHERE m.day>=? AND m.day<=?${scope} ORDER BY m.start_at LIMIT 2001`).bind(...args).all<any>()).results;
  return j({missions:r.slice(0,2000).map(parseMission),truncated:r.length>2000,serverTime:new Date().toISOString()});
 }
 if(action==='mission'){
  const m=await mission(u,id.parse(q.get('id')));const [s,f,d,t,c,photos]=await Promise.all([DB().prepare('SELECT * FROM tf_stores WHERE id=?').bind(m.store_id).first(),DB().prepare('SELECT label FROM tf_users WHERE id=?').bind(m.field_id).first<any>(),m.device_id?DB().prepare('SELECT name FROM tf_devices WHERE id=?').bind(m.device_id).first<any>():null,sales(m.id),counts(m.id),DB().prepare('SELECT id,caption,created_at,purpose FROM tf_photos WHERE mission_id=? ORDER BY created_at').bind(m.id).all()]);
  const prices=(await DB().prepare('SELECT product_id,unit_price FROM tf_store_prices WHERE store_id=?').bind(m.store_id).all<any>()).results;
  return j({mission:m,store:s,fieldName:f?.label,deviceName:d?.name,tickets:t,counts:c,photos:photos.results,prices,serverTime:new Date().toISOString()});
 }
 if(action==='stocks'){
  if(u.role==='doctor')fail('Accès non autorisé.',403);const store=id.parse(q.get('store'));if(!manages(u)&&!await DB().prepare('SELECT id FROM tf_missions WHERE store_id=? AND field_id=? LIMIT 1').bind(store,u.id).first())fail('Point de vente non accessible.',403);
  const r=(await DB().prepare(`SELECT * FROM (SELECT c.*,p.name AS product_name,p.brand,p.unit,m.day,m.actual_end,ROW_NUMBER() OVER(PARTITION BY c.product_id ORDER BY m.actual_end DESC,c.updated_at DESC) AS rn FROM tf_counts c JOIN tf_missions m ON m.id=c.mission_id JOIN tf_products p ON p.id=c.product_id WHERE m.store_id=? AND m.status='completed' AND c.closing IS NOT NULL) WHERE rn=1 ORDER BY brand,product_name`).bind(store).all()).results;return j({stocks:r});
 }
 if(action==='reports'){
  if(u.role==='doctor')fail('Accès non autorisé.',403);const {from,to}=range(q),args:any[]=[from,to],scope=manages(u)?'':' AND m.field_id=?';if(scope)args.push(u.id);
  const lines=(await DB().prepare(`SELECT m.id AS mission_id,m.day,m.field_id,f.label AS field_name,s.id AS store_id,s.name AS store_name,json_extract(l.value,'$.brand') AS brand,json_extract(l.value,'$.product_id') AS product_id,json_extract(l.value,'$.name') AS name,SUM(json_extract(l.value,'$.qty')) AS units,SUM(json_extract(l.value,'$.qty')*json_extract(l.value,'$.unit_price')) AS amount,COUNT(DISTINCT t.id) AS tickets FROM tf_tickets t JOIN tf_missions m ON m.id=t.mission_id JOIN tf_stores s ON s.id=m.store_id JOIN tf_users f ON f.id=m.field_id,json_each(t.lines) l WHERE t.status='valid' AND m.day>=? AND m.day<=?${scope} GROUP BY m.id,product_id,brand ORDER BY m.day DESC LIMIT 20001`).bind(...args).all()).results;
  return j({lines:lines.slice(0,20000),truncated:lines.length>20000,from,to});
 }
 if(action==='complaints'){
  const {from,to}=range(q),args:any[]=[new Date(from+'T00:00:00+01:00').toISOString(),new Date(Date.parse(to+'T00:00:00+01:00')+86400000).toISOString()];let scope='';if(u.role==='field'){scope=' AND c.author_id=?';args.push(u.id)}
  const r=(await DB().prepare(`SELECT c.id,c.mission_id,c.author_id,c.category,c.product_id,c.lot,c.code,c.status,c.priority,c.doctor_id,c.version,c.created_at,c.updated_at,c.public_note,s.name AS store_name,p.name AS product_name,f.label AS author_name,dr.label AS doctor_name FROM tf_complaints c JOIN tf_missions m ON m.id=c.mission_id JOIN tf_stores s ON s.id=m.store_id JOIN tf_users f ON f.id=c.author_id LEFT JOIN tf_products p ON p.id=c.product_id LEFT JOIN tf_users dr ON dr.id=c.doctor_id WHERE c.created_at>=? AND c.created_at<?${scope} ORDER BY c.updated_at DESC LIMIT 1001`).bind(...args).all()).results;return j({complaints:r.slice(0,1000),truncated:r.length>1000});
 }
 if(action==='complaint'){
  const c=await DB().prepare('SELECT * FROM tf_complaints WHERE id=?').bind(uuid.parse(q.get('id'))).first<any>();if(!c||u.role==='field'&&c.author_id!==u.id)fail('Réclamation non accessible.',403);
  const {private_note,description,...safe}=c;return j({complaint:{...safe,...(u.role==='doctor'?{private_note,description}:c.author_id===u.id||manages(u)&&c.category!=='tolerance'?{description}:{})}});
 }
 if(action==='audit'){
  if(u.role!=='admin')fail('Accès direction requis.',403);const r=(await DB().prepare('SELECT a.id,a.at,a.action,a.target,a.detail,u.label FROM tf_audit a LEFT JOIN tf_users u ON u.id=a.user_id ORDER BY at DESC LIMIT 300').all()).results;return j({events:r});
 }
 return j({error:'Action inconnue.'},404);
 }catch(e){return errorResponse(e)} }
function errorResponse(e:any){if(e instanceof z.ZodError)return j({error:'Vérifiez les champs : '+e.issues.slice(0,2).map(x=>x.path.join('.')+' '+x.message).join('; ')},400);if(e?.status)return j({error:e.message},e.status);const msg=String(e?.message||'');if(msg.includes('SCHEDULE_CONFLICT'))return j({error:'Chevauchement : l’animatrice ou ce Dermoscan est déjà programmé sur cet horaire.'},409);if(msg.includes('STOCK_INSUFFICIENT'))return j({error:'Quantité supérieure au stock compté disponible. Actualisez le stock.'},409);if(msg.includes('REPORT_LOCKED'))return j({error:'Le rapport a été verrouillé entre-temps. Actualisez.'},409);if(msg.includes('tf_guards')||msg.includes('UNIQUE'))return j({error:'Données modifiées ou enregistrement déjà présent. Actualisez avant de réessayer.'},409);return j({error:'L’opération n’a pas abouti. Les données confirmées sont conservées.'},500)}
export async function postTerrain(req:Request):Promise<Response>{try{
 if(req.headers.get('origin')!==new URL(req.url).origin)fail('Origine non autorisée.',403);if(!req.headers.get('content-type')?.includes('application/json'))fail('Format JSON requis.',415);const raw=await req.text();if(raw.length>70000)fail('Requête trop volumineuse.',413);let b:any;try{b=JSON.parse(raw)}catch{fail('JSON invalide.')}if(!b||typeof b!=='object'||Array.isArray(b))fail('Objet JSON requis.');
 if(b.action==='login'){
  const v=z.object({action:z.literal('login'),username:text(60).min(1),password:z.string().min(1).max(200)}).strict().parse(b),now=Date.now(),key=await sha((req.headers.get('CF-Connecting-IP')||'unknown')+'|'+Math.floor(now/900000));
  await DB().prepare('INSERT INTO tf_throttle(bucket,count,expires) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1').bind(key,now+900000).run();const limit=await DB().prepare('SELECT count FROM tf_throttle WHERE bucket=?').bind(key).first<any>();if(limit.count>20)fail('Trop de tentatives. Réessayez dans 15 minutes.',429);
  const r=await DB().prepare('SELECT * FROM tf_users WHERE username=?').bind(v.username.toLowerCase()).first<any>();const h=await passwordHash(v.password,r?.salt||'0123456789abcdef0123456789abcdef');if(!r||!r.active||!equal(h,r.password_hash))fail('Identifiant ou mot de passe incorrect.',401);
  const t=hex(crypto.getRandomValues(new Uint8Array(32)));await DB().batch([DB().prepare('INSERT INTO tf_sessions(token_hash,user_id,expires) VALUES(?,?,?)').bind(await sha(t),r.id,now+28800000),DB().prepare('DELETE FROM tf_sessions WHERE expires<?').bind(now),DB().prepare('DELETE FROM tf_throttle WHERE expires<?').bind(now)]);return j({ok:true},200,{'Set-Cookie':`${COOKIE}=${t}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`});
 }
 const u=await current(req);
 if(b.action==='logout'){await DB().prepare('DELETE FROM tf_sessions WHERE token_hash=?').bind(await sha(token(req))).run();return j({ok:true},200,{'Set-Cookie':`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`})}
 if(b.action==='password'){
  const v=z.object({action:z.literal('password'),current:z.string().max(200),next:z.string().min(14).max(200)}).strict().parse(b);const r=await DB().prepare('SELECT salt,password_hash FROM tf_users WHERE id=?').bind(u.id).first<any>();if(!equal(await passwordHash(v.current,r.salt),r.password_hash))fail('Mot de passe actuel incorrect.');if(v.current===v.next)fail('Choisissez un nouveau mot de passe.');const salt=hex(crypto.getRandomValues(new Uint8Array(16)));await DB().batch([DB().prepare('UPDATE tf_users SET salt=?,password_hash=?,force_change=0 WHERE id=?').bind(salt,await passwordHash(v.next,salt),u.id),DB().prepare('DELETE FROM tf_sessions WHERE user_id=? AND token_hash<>?').bind(u.id,await sha(token(req))),audit(u,'account.password',u.id)]);return j({ok:true});
 }
 if(u.force_change)fail('Changez votre mot de passe initial.',403);
 const extra=await postOperations(u,b);if(extra)return extra;
 if(['complaint','case-update'].includes(b.action))fail('Le suivi a été mis à jour. Actualisez la page avant de continuer.',409);
 if(b.action==='ack-attendance'){
  if(!manages(u))fail('Accès gestionnaire ou direction requis.',403);
  const v=z.object({action:z.literal('ack-attendance'),id:uuid,kind:z.enum(['missing_start','late_start'])}).strict().parse(b),m=await mission(u,v.id),a=attendance(m);
  if(!a||a.kind!==v.kind)fail('Cette alerte a changé. Actualisez la liste.',409);
  await DB().batch([DB().prepare('INSERT INTO tf_alert_ack(user_id,mission_id,kind,ack_at) VALUES(?,?,?,?) ON CONFLICT(user_id,mission_id,kind) DO UPDATE SET ack_at=excluded.ack_at').bind(u.id,m.id,v.kind,new Date().toISOString()),audit(u,'attendance.seen',m.id,{kind:v.kind})]);return j({ok:true});
 }
 if(b.action==='user'){
  if(u.role!=='admin')fail('Accès direction requis.',403);const v=z.object({action:z.literal('user'),id:uuid,username:z.string().regex(/^[a-z0-9._-]{3,40}$/),label:text(80).min(2),role:z.enum(['manager','field','doctor']),active:z.boolean(),password:z.string().min(14).max(200).optional()}).strict().parse(b);const old=await DB().prepare('SELECT role FROM tf_users WHERE id=?').bind(v.id).first<any>();if(old?.role==='admin')fail('Le compte direction se gère séparément.');if(old&&old.role!==v.role)fail('Ne changez pas le rôle d’un compte existant : désactivez-le et créez un compte nominatif distinct.');if(!old&&!v.password)fail('Mot de passe initial requis.');const stm:any[]=[];if(!old){const salt=hex(crypto.getRandomValues(new Uint8Array(16)));stm.push(DB().prepare('INSERT INTO tf_users(id,username,label,role,active,salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(v.id,v.username,v.label,v.role,+v.active,salt,await passwordHash(v.password!,salt),new Date().toISOString()))}else{stm.push(DB().prepare('UPDATE tf_users SET label=?,active=? WHERE id=?').bind(v.label,+v.active,v.id));if(v.password){const salt=hex(crypto.getRandomValues(new Uint8Array(16)));stm.push(DB().prepare('UPDATE tf_users SET salt=?,password_hash=?,force_change=1 WHERE id=?').bind(salt,await passwordHash(v.password,salt),v.id))}if(!v.active||v.password)stm.push(DB().prepare('DELETE FROM tf_sessions WHERE user_id=?').bind(v.id))}stm.push(audit(u,'account.updated',v.id,{role:v.role,active:v.active}));await DB().batch(stm);return j({ok:true});
 }
 if(['store','product','device','schedule','cancel','review'].includes(b.action)&&!manages(u))fail('Accès gestionnaire ou direction requis.',403);
 if(b.action==='store'){
  const v=z.object({action:z.literal('store'),id:uuid,name:text(150).min(2),kind:z.enum(['pharmacy','beauty','wholesale','other']),city:text(80).min(2),address:text(400).min(3),contact:text(150),notes:text(),active:z.boolean()}).strict().parse(b);
  await DB().batch([DB().prepare('INSERT INTO tf_stores(id,name,kind,city,address,contact,notes,active) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,city=excluded.city,address=excluded.address,contact=excluded.contact,notes=excluded.notes,active=excluded.active').bind(v.id,v.name,v.kind,v.city,v.address,v.contact,v.notes,+v.active),audit(u,'store.updated',v.id)]);return j({ok:true});
 }
 if(b.action==='device'){
  const v=z.object({action:z.literal('device'),id:uuid,name:text(100).min(2),location:text(200),active:z.boolean()}).strict().parse(b);await DB().batch([DB().prepare('INSERT INTO tf_devices(id,name,location,active) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,location=excluded.location,active=excluded.active').bind(v.id,v.name,v.location,+v.active),audit(u,'device.updated',v.id)]);return j({ok:true});
 }
 if(b.action==='product'){
  const v=z.object({action:z.literal('product'),id,brand,sku:text(60).min(1),name:text(160).min(2),unit:z.enum(['pièce','pack']),price_hint:z.number().int().min(0).max(10000000),active:z.boolean()}).strict().parse(b);const old=await DB().prepare('SELECT brand FROM tf_products WHERE id=?').bind(v.id).first<any>();if(old&&old.brand!==v.brand)fail('La marque historique ne peut pas être changée.');await DB().batch([DB().prepare('INSERT INTO tf_products(id,brand,sku,name,unit,price_hint,active) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sku=excluded.sku,name=excluded.name,unit=excluded.unit,price_hint=excluded.price_hint,active=excluded.active').bind(v.id,v.brand,v.sku,v.name,v.unit,v.price_hint,+v.active),audit(u,'product.updated',v.id)]);return j({ok:true});
 }
 if(b.action==='schedule'){
  const v=z.object({action:z.literal('schedule'),id:uuid,store_id:uuid,field_id:uuid,day:date,start:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),end:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),brands:z.array(brand).min(1).max(3),device_id:uuid.nullable(),device_location:text(250),instructions:text(),late_grace_minutes:z.number().int().min(0).max(120).default(15),version:z.number().int().optional()}).strict().parse(b);if(v.start>=v.end)fail('La fin doit être après le début, le même jour.');if(new Set(v.brands).size!==v.brands.length)fail('Marques dupliquées.');if(v.device_id&&!v.device_location)fail('Indiquez le lieu d’installation du Dermoscan.');
  const f=await DB().prepare("SELECT id FROM tf_users WHERE id=? AND role='field' AND active=1").bind(v.field_id).first(),s=await DB().prepare('SELECT id FROM tf_stores WHERE id=? AND active=1').bind(v.store_id).first();if(!f||!s)fail('Sélectionnez une animatrice et un point de vente actifs.');if(v.device_id&&!await DB().prepare('SELECT id FROM tf_devices WHERE id=? AND active=1').bind(v.device_id).first())fail('Dermoscan indisponible.');
  const start=new Date(v.day+'T'+v.start+':00+01:00').toISOString(),end=new Date(v.day+'T'+v.end+':00+01:00').toISOString(),old=await DB().prepare('SELECT * FROM tf_missions WHERE id=?').bind(v.id).first<any>();
  if(old){if(old.status!=='planned'||old.version!==v.version)fail('L’animation a changé ou a déjà commencé.',409);await batchMission(u,old,'mission.rescheduled',[DB().prepare('UPDATE tf_missions SET store_id=?,field_id=?,day=?,start_at=?,end_at=?,brands=?,device_id=?,device_location=?,instructions=?,late_grace_minutes=? WHERE id=?').bind(v.store_id,v.field_id,v.day,start,end,JSON.stringify(v.brands),v.device_id,v.device_location,v.instructions,v.late_grace_minutes,v.id)])}else{await DB().batch([DB().prepare('INSERT INTO tf_missions(id,store_id,field_id,day,start_at,end_at,brands,device_id,device_location,instructions,late_grace_minutes,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(v.id,v.store_id,v.field_id,v.day,start,end,JSON.stringify(v.brands),v.device_id,v.device_location,v.instructions,v.late_grace_minutes,u.id,new Date().toISOString()),audit(u,'mission.created',v.id)])}return j({ok:true,id:v.id});
 }
 if(b.action==='clock')fail('Ajoutez la photo du lieu avec le bouton de pointage.',400);
 if(b.action==='cancel'){
  const v=z.object({action:z.literal('cancel'),id:uuid,reason:text().min(5)}).strict().parse(b),m=await mission(u,v.id);if(m.status!=='planned')fail('Seule une animation non commencée peut être annulée.');await batchMission(u,m,'mission.cancelled',[DB().prepare("UPDATE tf_missions SET status='cancelled',cancel_reason=? WHERE id=?").bind(v.reason,m.id)],{reason:v.reason});return j({ok:true});
 }
 if(b.action==='stock-batch'){
  const v=z.object({action:z.literal('stock-batch'),mission_id:uuid,version:z.number().int(),mode:z.enum(['opening','closing']),rows:z.array(z.object({product_id:id,quantity:qty,note:text().optional()}).strict()).min(1).max(150)}).strict().parse(b),m=await mission(u,v.mission_id,true);
  if(m.version!==v.version)fail('L’animation a changé. Fermez puis rouvrez le stock pour actualiser.',409);
  if(new Set(v.rows.map(r=>r.product_id)).size!==v.rows.length)fail('Référence répétée.');
  const cs=await counts(m.id),ts=await sales(m.id),ps=(await DB().prepare('SELECT id,brand FROM tf_products WHERE active=1').all<any>()).results,at=new Date().toISOString();
  const stm=v.rows.map(r=>{const p=ps.find(p=>p.id===r.product_id),old=cs.find(c=>c.product_id===r.product_id);if(!p||!m.brands.includes(p.brand))fail('Produit non autorisé pour cette animation.');
   const sold=ts.filter(t=>t.status==='valid').flatMap(t=>t.lines).filter(l=>l.product_id===r.product_id).reduce((n,l)=>n+l.qty,0);
   if(v.mode==='opening'){
    if(r.quantity+(old?.received||0)-(old?.other_out||0)<sold)fail('Stock de départ inférieur aux ventes : '+r.product_id);
    return DB().prepare('INSERT INTO tf_counts(mission_id,product_id,opening,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(mission_id,product_id) DO UPDATE SET opening=excluded.opening,updated_by=excluded.updated_by,updated_at=excluded.updated_at').bind(m.id,r.product_id,r.quantity,u.id,at);
   }
   if(!old)fail('Renseignez le stock de départ avant le comptage final.');
   return DB().prepare('UPDATE tf_counts SET closing=?,note=?,updated_by=?,updated_at=? WHERE mission_id=? AND product_id=?').bind(r.quantity,r.note??old.note,u.id,at,m.id,r.product_id);
  });
  await batchMission(u,m,'stock.batch',stm,{mode:v.mode,products:v.rows.length});return j({ok:true});
 }
 if(b.action==='count'){
  const v=z.object({action:z.literal('count'),mission_id:uuid,product_id:id,opening:qty,received:qty,other_out:qty,closing:qty.nullable(),damaged:qty,expiring:qty,expiry:z.union([z.literal(''),date]),note:text(),previous:z.string().nullable()}).strict().parse(b),m=await mission(u,v.mission_id,true),p=await DB().prepare('SELECT * FROM tf_products WHERE id=? AND active=1').bind(v.product_id).first<any>();if(!p||!m.brands.includes(p.brand))fail('Référence absente des marques de cette animation.');if(v.expiring>0&&!v.expiry)fail('Date d’expiration la plus proche requise.');if(v.other_out>0&&!v.note)fail('Expliquez les sorties hors ventes.');const old=await DB().prepare('SELECT updated_at FROM tf_counts WHERE mission_id=? AND product_id=?').bind(m.id,v.product_id).first<any>();if((old?.updated_at||null)!==v.previous)fail('Comptage modifié entre-temps. Rechargez la fiche.',409);
  const sold=(await sales(m.id)).filter(x=>x.status==='valid').flatMap(x=>x.lines).filter(l=>l.product_id===v.product_id).reduce((s,l)=>s+l.qty,0);if(v.opening+v.received-v.other_out<sold)fail('Le disponible déclaré est inférieur aux ventes déjà saisies.');await batchMission(u,m,'stock.counted',[DB().prepare('INSERT INTO tf_counts(mission_id,product_id,opening,received,other_out,closing,damaged,expiring,expiry,note,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(mission_id,product_id) DO UPDATE SET opening=excluded.opening,received=excluded.received,other_out=excluded.other_out,closing=excluded.closing,damaged=excluded.damaged,expiring=excluded.expiring,expiry=excluded.expiry,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at').bind(m.id,v.product_id,v.opening,v.received,v.other_out,v.closing,v.damaged,v.expiring,v.expiry,v.note,u.id,new Date().toISOString())],{product:v.product_id});return j({ok:true});
 }
 if(b.action==='sale'){
  const v=z.object({action:z.literal('sale'),id:uuid,mission_id:uuid,lines:z.array(z.object({product_id:id,qty:qty.refine(n=>n>0),unit_price:z.number().int().min(1).max(10000000)}).strict()).min(1).max(30)}).strict().parse(b),m=await mission(u,v.mission_id,true);if(new Set(v.lines.map(x=>x.product_id)).size!==v.lines.length)fail('Regroupez les quantités de la même référence sur une ligne.');const old=await DB().prepare('SELECT user_id,mission_id,lines FROM tf_tickets WHERE id=?').bind(v.id).first<any>();if(old){if(old.user_id!==u.id||old.mission_id!==m.id||JSON.stringify(JSON.parse(old.lines).map((l:any)=>({product_id:l.product_id,qty:l.qty,unit_price:l.unit_price})))!==JSON.stringify(v.lines))fail('Identifiant déjà utilisé pour une autre saisie.',409);return j({ok:true,duplicate:true})}
  const ps=(await DB().prepare('SELECT * FROM tf_products WHERE active=1').all<any>()).results;const lines=v.lines.map(l=>{const p=ps.find(x=>x.id===l.product_id);if(!p||!m.brands.includes(p.brand))fail('Produit non autorisé pour cette animation.');return{...l,name:p.name,brand:p.brand,unit:p.unit}});const total=ticketTotal(lines);if(!Number.isSafeInteger(total)||total>1000000000)fail('Montant trop élevé.');await batchMission(u,m,'sale.recorded',[DB().prepare('INSERT INTO tf_tickets(id,mission_id,user_id,created_at,lines,total) VALUES(?,?,?,?,?,?)').bind(v.id,m.id,u.id,new Date().toISOString(),JSON.stringify(lines),total),...lines.map(l=>DB().prepare('INSERT INTO tf_store_prices(store_id,product_id,unit_price,updated_at) VALUES(?,?,?,?) ON CONFLICT(store_id,product_id) DO UPDATE SET unit_price=excluded.unit_price,updated_at=excluded.updated_at').bind(m.store_id,l.product_id,l.unit_price,new Date().toISOString()))],{ticket:v.id,total});return j({ok:true});
 }
 if(b.action==='void-sale'){
  if(!manages(u))fail('Correction réservée à la gestionnaire.',403);const v=z.object({action:z.literal('void-sale'),id:uuid,reason:text().min(5)}).strict().parse(b),t=await DB().prepare('SELECT * FROM tf_tickets WHERE id=?').bind(v.id).first<any>();if(!t)fail('Vente introuvable.');const m=await mission(u,t.mission_id,true);if(t.status==='void')return j({ok:true});await batchMission(u,m,'sale.voided',[DB().prepare("UPDATE tf_tickets SET status='void',void_reason=? WHERE id=?").bind(v.reason,v.id)],{ticket:v.id,reason:v.reason});return j({ok:true});
 }
 if(b.action==='submit'){
  const v=z.object({action:z.literal('submit'),id:uuid,notes:text(2000),no_sales:z.boolean()}).strict().parse(b),m=await mission(u,v.id,true);if(m.status!=='completed'||!m.actual_start||!m.actual_end)fail('Pointez le début et la fin avant de soumettre.');const issues=reportIssues(await counts(m.id),await sales(m.id),v.no_sales);if(issues.length)fail(issues.join(' '));await batchMission(u,m,'report.submitted',[DB().prepare("UPDATE tf_missions SET report_status='submitted',report_notes=?,no_sales=? WHERE id=?").bind(v.notes,+v.no_sales,m.id)]);return j({ok:true});
 }
 if(b.action==='review'){
  const v=z.object({action:z.literal('review'),id:uuid,decision:z.enum(['approved','changes']),note:text(2000)}).strict().parse(b),m=await mission(u,v.id);if(m.status!=='completed'||!['submitted','approved'].includes(m.report_status))fail('Rapport non soumis.');if(v.decision==='changes'&&v.note.length<5)fail('Expliquez les corrections demandées.');await batchMission(u,m,'report.'+v.decision,[DB().prepare('UPDATE tf_missions SET report_status=?,review_note=? WHERE id=?').bind(v.decision,v.note,m.id)],{note:v.note});return j({ok:true});
 }
 if(b.action==='complaint'){
  const v=z.object({action:z.literal('complaint'),id:uuid,mission_id:uuid,product_id:id.nullable(),category:z.enum(['quality','commercial','tolerance']),lot:text(80),code:z.string().regex(/^[A-Za-z0-9._-]{0,40}$/),priority:z.enum(['normal','priority']),description:text(2500).min(10),consent:z.boolean()}).strict().parse(b);const m=await mission(u,v.mission_id);if(v.category==='tolerance'&&!v.consent)fail('Expliquez la transmission au médecin et confirmez l’accord avant de saisir le signalement anonymisé.');if(v.product_id){const p=await DB().prepare('SELECT brand FROM tf_products WHERE id=?').bind(v.product_id).first<any>();if(!p||!m.brands.includes(p.brand))fail('Produit non lié aux marques de cette animation.');}const existing=await DB().prepare('SELECT author_id FROM tf_complaints WHERE id=?').bind(v.id).first<any>();if(existing){if(existing.author_id!==u.id)fail('Identifiant déjà utilisé.',409);return j({ok:true})}const now=new Date().toISOString();await DB().batch([DB().prepare('INSERT INTO tf_complaints(id,mission_id,author_id,product_id,category,lot,code,priority,description,consent,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(v.id,m.id,u.id,v.product_id,v.category,v.lot,v.code,v.priority,v.description,+v.consent,now,now),audit(u,'complaint.created',v.id,{category:v.category})]);return j({ok:true});
 }
 if(b.action==='case-update'){
  const v=z.object({action:z.literal('case-update'),id:uuid,version:z.number().int(),status:z.enum(['new','assigned','ongoing','waiting','resolved','closed']),doctor_id:uuid.nullable(),public_note:text(2000),private_note:text(4000).optional()}).strict().parse(b);const c=await DB().prepare('SELECT * FROM tf_complaints WHERE id=?').bind(v.id).first<any>();if(!c)fail('Réclamation introuvable.');if(c.version!==v.version)fail('Ce dossier a changé. Actualisez.',409);if(!manages(u)&&u.role!=='doctor')fail('Prise en charge réservée aux responsables.',403);if(u.role!=='doctor'&&v.private_note!==undefined)fail('Les notes médicales sont réservées aux médecins.',403);if(c.category==='tolerance'&&u.role!=='doctor'&&!['new','assigned'].includes(v.status))fail('La prise en charge clinique appartient au médecin.',403);if(v.doctor_id&&!await DB().prepare("SELECT id FROM tf_users WHERE id=? AND role='doctor' AND active=1").bind(v.doctor_id).first())fail('Médecin non actif.');if(u.role==='doctor'&&v.doctor_id!==u.id)fail('Attribuez la prise en charge à votre compte.');const r=await DB().prepare('UPDATE tf_complaints SET status=?,doctor_id=?,public_note=?,private_note=?,version=version+1,updated_at=? WHERE id=? AND version=?').bind(v.status,v.doctor_id,v.public_note,u.role==='doctor'?(v.private_note||''):c.private_note,new Date().toISOString(),v.id,v.version).run();if(!r.meta.changes)fail('Dossier modifié entre-temps.',409);await audit(u,'complaint.status',v.id,{status:v.status}).run();return j({ok:true});
 }
 return j({error:'Action inconnue.'},404);
 }catch(e){return errorResponse(e)} }
export async function uploadPhoto(req:Request):Promise<Response>{try{
 if(req.headers.get('origin')!==new URL(req.url).origin)fail('Origine non autorisée.',403);
 const u=await current(req);if(u.force_change)fail('Changez votre mot de passe.',403);
 if(Number(req.headers.get('content-length')||0)>5300000)fail('Photo trop volumineuse.',413);
 const form=await photoFormData(req),file=form.get('photo'),key=uuid.parse(form.get('mission_id')),purpose=z.enum(['report','checkin','checkout']).parse(form.get('purpose')||'report'),photo=uuid.parse(form.get('photo_id')||crypto.randomUUID()),m=await mission(u,key);
 const old=await DB().prepare('SELECT mission_id,user_id,purpose FROM tf_photos WHERE id=?').bind(photo).first<any>();
 if(old){if(old.mission_id!==m.id||old.user_id!==u.id||old.purpose!==purpose)fail('Identifiant photo déjà utilisé.',409);return j({ok:true,id:photo,duplicate:true})}
 if(purpose==='report'){if(!canEdit(u,m))fail('Cette animation est verrouillée.',409)}else{const issue=clockIssue(u,m,purpose);if(issue)fail(issue,409)}
 if(!(file instanceof File)||file.size>5000000||file.size<12)fail('JPEG, PNG ou WebP de 5 Mo maximum.');
 if(form.get('no_person')!=='true')fail('Confirmez une photo du lieu sans personnes ni documents personnels.');
 const imageFile=file as File,caption=text(300).parse(form.get('caption')||''),bytes=new Uint8Array(await imageFile.arrayBuffer());
 const mime=bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10'?'image/png':String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP'?'image/webp':null;if(!mime)fail('Format image non reconnu.');
 const n=await DB().prepare("SELECT COUNT(*) AS n FROM tf_photos WHERE mission_id=? AND purpose='report'").bind(m.id).first<any>();if(purpose==='report'&&n.n>=15)fail('15 photos de suivi maximum par animation.');
 const r2=bindings().STORAGE;if(!r2)fail('Stockage photo indisponible.',503);
 const object_key='terrain/'+crypto.randomUUID(),at=new Date().toISOString();
 await r2!.put(object_key,bytes,{httpMetadata:{contentType:mime!}});
 try{
  const stm:any[]=[DB().prepare('INSERT INTO tf_photos(id,mission_id,user_id,created_at,caption,mime,size,object_key,purpose) VALUES(?,?,?,?,?,?,?,?,?)').bind(photo,m.id,u.id,at,caption,mime,imageFile.size,object_key,purpose)];
  if(purpose==='checkin')stm.push(DB().prepare("UPDATE tf_missions SET status='ongoing',actual_start=?,start_photo_id=? WHERE id=?").bind(at,photo,m.id));
  if(purpose==='checkout')stm.push(DB().prepare("UPDATE tf_missions SET status='completed',actual_end=?,end_photo_id=? WHERE id=?").bind(at,photo,m.id));
  await batchMission(u,m,purpose==='report'?'photo.added':'clock.'+purpose,stm,{photo,purpose});
 }catch(e){await r2!.delete(object_key);throw e}
 return j({ok:true,id:photo,serverTime:at});
 }catch(e){return errorResponse(e)} }
export async function getPhoto(req:Request):Promise<Response>{try{const u=await current(req);if(u.force_change)fail('Changez votre mot de passe.',403);const p=await DB().prepare('SELECT * FROM tf_photos WHERE id=?').bind(uuid.parse(new URL(req.url).searchParams.get('id'))).first<any>();if(!p)fail('Photo introuvable.',404);await mission(u,p.mission_id);const r=await bindings().STORAGE?.get(p.object_key);if(!r)fail('Photo indisponible.',404);return new Response(r!.body as any,{headers:{'Content-Type':p.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}})}catch(e){return errorResponse(e)}}

export async function fieldPhotoEndpoint(req:Request):Promise<Response>{try{const u=await current(req);if(u.force_change)fail('Changez votre mot de passe.',403);if(req.method==='GET')return await readFieldMedia(u,new URL(req.url).searchParams);if(req.headers.get('origin')!==new URL(req.url).origin)fail('Origine non autorisée.',403);return await uploadFieldMedia(u,req)}catch(e){return errorResponse(e)}}
