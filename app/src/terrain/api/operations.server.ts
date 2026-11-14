import {photoFormData} from './body.server';
import {z} from 'zod';
import {bindings} from '../../lib/bindings.server';
import {manages,canMission,dayInAlger,type User} from '../domain/core';
import {REASONS,REQUEST_REASONS,canReadCase,safeCase,canReadFieldNote} from '../domain/operations';
const db=()=>bindings().DB!;
const fail=(message:string,status=400):never=>{throw Object.assign(new Error(message),{status})};
const json=(x:unknown)=>Response.json(x,{headers:{'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'}});
const uuid=z.string().uuid(),id=z.string().regex(/^[a-zA-Z0-9_-]{2,64}$/),txt=(n=1200)=>z.string().trim().max(n);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>!isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s);
const optionalDate=z.union([z.literal(''),date]);
function period(q:URLSearchParams){const from=date.parse(q.get('from')||dayInAlger().slice(0,7)+'-01'),to=date.parse(q.get('to')||dayInAlger());if(to<from||Date.parse(to)-Date.parse(from)>366*86400000)fail('Choisissez une période de 366 jours maximum.');return {from,to,start:new Date(from+'T00:00:00+01:00').toISOString(),end:new Date(Date.parse(to+'T00:00:00+01:00')+86400000).toISOString()};}
const audit=(u:User,action:string,target:string,detail:unknown={})=>db().prepare('INSERT INTO tf_audit(id,user_id,at,action,target,detail) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),u.id,new Date().toISOString(),action,target,JSON.stringify(detail));
async function context(u:User,v:{mission_id:string|null;store_id:string|null;store_label:string}){
 let store=v.store_id;
 if(v.mission_id){const m=await db().prepare('SELECT * FROM tf_missions WHERE id=?').bind(v.mission_id).first<any>();if(!m||!canMission(u,m))fail('Animation non accessible.',403);if(store&&store!==m.store_id)fail('La pharmacie ne correspond pas à cette animation.');store=m.store_id;}
 if(store){const s=await db().prepare('SELECT id FROM tf_stores WHERE id=?').bind(store).first();if(!s)fail('Pharmacie introuvable.');if(u.role==='field'&&!await db().prepare('SELECT id FROM tf_missions WHERE store_id=? AND field_id=? LIMIT 1').bind(store,u.id).first())fail('Pharmacie non accessible.',403);}
 return store;
}
async function caseBy(u:User,key:string){const c=await db().prepare('SELECT c.*,COALESCE(s.name,NULLIF(c.store_label,\'\'),\'Sans pharmacie\') AS store_name,f.label AS author_name,a.label AS assignee_name FROM tf_cases c LEFT JOIN tf_stores s ON s.id=c.store_id JOIN tf_users f ON f.id=c.author_id LEFT JOIN tf_users a ON a.id=c.assignee_id WHERE c.id=?').bind(key).first<any>();if(!c||!canReadCase(u,c))fail('Dossier non accessible.',403);return c;}
async function noteBy(u:User,key:string){const n=await db().prepare('SELECT n.*,COALESCE(s.name,NULLIF(n.store_label,\'\'),\'Sans pharmacie\') AS store_name,u.label AS author_name FROM tf_field_notes n LEFT JOIN tf_stores s ON s.id=n.store_id JOIN tf_users u ON u.id=n.author_id WHERE n.id=?').bind(key).first<any>();if(!n||!canReadFieldNote(u,n))fail('Observation non accessible.',403);return n;}
export async function getOperations(u:User,q:URLSearchParams):Promise<Response|null>{
 const action=q.get('action');
 if(action==='service-list'){
  const {start,end}=period(q),args:any[]=[start,end];let scope='';
  if(u.role==='field'){scope+=' AND c.author_id=?';args.push(u.id)}if(u.role==='doctor')scope+=" AND c.kind='complaint'";
  const rows=(await db().prepare(`SELECT c.id,c.kind,c.reason,c.category,c.channel,c.status,c.priority,c.code,c.created_at,c.updated_at,c.due_day,c.author_id,c.assignee_id,c.product_id,c.store_id,COALESCE(s.name,NULLIF(c.store_label,''),'Sans pharmacie') AS store_name,p.name AS product_name,f.label AS author_name,a.label AS assignee_name FROM tf_cases c LEFT JOIN tf_stores s ON s.id=c.store_id LEFT JOIN tf_products p ON p.id=c.product_id JOIN tf_users f ON f.id=c.author_id LEFT JOIN tf_users a ON a.id=c.assignee_id WHERE c.created_at>=? AND c.created_at<?${scope} ORDER BY c.updated_at DESC LIMIT 1001`).bind(...args).all()).results;
  return json({cases:rows.slice(0,1000),truncated:rows.length>1000});
 }
 if(action==='service-detail'){const c=await caseBy(u,uuid.parse(q.get('id'))),events=(await db().prepare('SELECT e.*,u.label FROM tf_case_events e JOIN tf_users u ON u.id=e.user_id WHERE case_id=? ORDER BY at').bind(c.id).all<any>()).results.filter(e=>!e.clinical||u.role==='doctor'||c.author_id===u.id);return json({case:safeCase(u,c),events});}
 if(action==='field-notes'){
  if(u.role==='doctor')fail('Accès commercial non autorisé.',403);const {start,end}=period(q),args:any[]=[start,end],scope=manages(u)?'':' AND n.author_id=?';if(scope)args.push(u.id);
  const rows=(await db().prepare(`SELECT n.*,COALESCE(s.name,NULLIF(n.store_label,''),'Sans pharmacie') AS store_name,u.label AS author_name,(SELECT id FROM tf_field_photos p WHERE p.note_id=n.id ORDER BY p.created_at LIMIT 1) AS photo_id,(SELECT COUNT(*) FROM tf_field_photos p WHERE p.note_id=n.id) AS photo_count FROM tf_field_notes n LEFT JOIN tf_stores s ON s.id=n.store_id JOIN tf_users u ON u.id=n.author_id WHERE n.created_at>=? AND n.created_at<?${scope} ORDER BY n.created_at DESC LIMIT 1001`).bind(...args).all()).results;
  return json({notes:rows.slice(0,1000),truncated:rows.length>1000});
 }
 if(action==='field-note'){const n=await noteBy(u,uuid.parse(q.get('id'))),photos=(await db().prepare('SELECT id,created_at FROM tf_field_photos WHERE note_id=? ORDER BY created_at').bind(n.id).all()).results;return json({note:n,photos});}
 if(action==='bonuses'){
  if(u.role==='doctor')fail('Accès non autorisé.',403);
  const today=dayInAlger(),month=today.slice(0,7),from=(Number(month.slice(0,4))-1)+month.slice(4)+'-01',scope=manages(u)?'':' AND m.field_id=?',args=manages(u)?[from,today]:[from,today,u.id];
  const rows=(await db().prepare(`SELECT m.day,COUNT(*) AS tickets,SUM(t.bonus_amount) AS bonus,SUM(t.total) AS revenue FROM tf_tickets t JOIN tf_missions m ON m.id=t.mission_id WHERE t.status='valid' AND m.day>=? AND m.day<=?${scope} GROUP BY m.day ORDER BY m.day`).bind(...args).all<any>()).results;
  const months:Record<string,any>={};for(const r of rows){const k=r.day.slice(0,7);months[k]??={month:k,tickets:0,bonus:0,revenue:0};for(const p of ['tickets','bonus','revenue'])months[k][p]+=r[p];}
  return json({today:rows.find(r=>r.day===today)||{day:today,tickets:0,bonus:0,revenue:0},month:months[month]||{month,tickets:0,bonus:0,revenue:0},months:Object.values(months).sort((a,b)=>b.month.localeCompare(a.month)),days:rows.filter(r=>r.day.startsWith(month)),serverTime:new Date().toISOString()});
 }
 if(action==='performance'){
  if(u.role==='doctor')fail('Accès non autorisé.',403);const {from,to}=period(q),args:any[]=[from,to];let scope='m.day>=? AND m.day<=?';
  if(!manages(u)){scope+=' AND m.field_id=?';args.push(u.id)}else if(q.get('person')){scope+=' AND m.field_id=?';args.push(uuid.parse(q.get('person')))}
  if(q.get('store')){scope+=' AND m.store_id=?';args.push(id.parse(q.get('store')))}
  const base=`FROM tf_tickets t JOIN tf_missions m ON m.id=t.mission_id JOIN tf_users f ON f.id=m.field_id JOIN tf_stores s ON s.id=m.store_id WHERE t.status='valid' AND ${scope}`;
  const [totals,fields,stores,days,products,brands,missions]=await Promise.all([
   db().prepare('SELECT COUNT(*) AS tickets,COALESCE(SUM(t.total),0) AS revenue,COALESCE(SUM(t.bonus_amount),0) AS bonus '+base).bind(...args).first<any>(),
   db().prepare('SELECT m.field_id AS id,f.label AS name,COUNT(*) AS tickets,SUM(t.total) AS revenue,SUM(t.bonus_amount) AS bonus '+base+' GROUP BY m.field_id ORDER BY tickets DESC,revenue DESC LIMIT 1001').bind(...args).all<any>(),
   db().prepare('SELECT m.store_id AS id,s.name,COUNT(*) AS tickets,SUM(t.total) AS revenue,SUM(t.bonus_amount) AS bonus '+base+' GROUP BY m.store_id ORDER BY revenue DESC LIMIT 2001').bind(...args).all<any>(),
   db().prepare('SELECT m.day,COUNT(*) AS tickets,SUM(t.total) AS revenue,SUM(t.bonus_amount) AS bonus '+base+' GROUP BY m.day ORDER BY m.day').bind(...args).all<any>(),
   db().prepare(`SELECT json_extract(l.value,'$.product_id') AS id,json_extract(l.value,'$.name') AS name,json_extract(l.value,'$.brand') AS brand,SUM(json_extract(l.value,'$.qty')) AS units,SUM(json_extract(l.value,'$.qty')*json_extract(l.value,'$.unit_price')) AS revenue,COUNT(DISTINCT t.id) AS tickets FROM tf_tickets t JOIN tf_missions m ON m.id=t.mission_id,json_each(t.lines) l WHERE t.status='valid' AND ${scope} GROUP BY json_extract(l.value,'$.product_id'),json_extract(l.value,'$.brand') ORDER BY units DESC,revenue DESC LIMIT 2001`).bind(...args).all<any>(),
   db().prepare(`SELECT json_extract(l.value,'$.brand') AS name,SUM(json_extract(l.value,'$.qty')) AS units,SUM(json_extract(l.value,'$.qty')*json_extract(l.value,'$.unit_price')) AS revenue,COUNT(DISTINCT t.id) AS tickets FROM tf_tickets t JOIN tf_missions m ON m.id=t.mission_id,json_each(t.lines) l WHERE t.status='valid' AND ${scope} GROUP BY name ORDER BY revenue DESC`).bind(...args).all<any>(),
   db().prepare(`SELECT m.field_id AS id,f.label AS name,COUNT(*) AS scheduled,SUM(CASE WHEN m.status='completed' THEN 1 ELSE 0 END) AS completed,SUM(CASE WHEN m.status='cancelled' THEN 1 ELSE 0 END) AS cancelled,SUM(CASE WHEN m.actual_start IS NOT NULL AND (julianday(m.actual_start)-julianday(m.start_at))*1440>m.late_grace_minutes+0.001 THEN 1 ELSE 0 END) AS late,COALESCE(SUM(CASE WHEN m.actual_end IS NOT NULL THEN MAX(0,(julianday(m.actual_end)-julianday(m.actual_start))*24) ELSE 0 END),0) AS hours FROM tf_missions m JOIN tf_users f ON f.id=m.field_id WHERE ${scope} GROUP BY m.field_id LIMIT 1001`).bind(...args).all<any>()
  ]);
  const people=new Map<string,any>();for(const m of missions.results)people.set(m.id,{...m,tickets:0,revenue:0,bonus:0});for(const f of fields.results)people.set(f.id,{...(people.get(f.id)||{}),...f});const team=Array.from(people.values()).sort((a,b)=>b.tickets-a.tickets||b.revenue-a.revenue);
  return json({from,to,totals:{...totals,units:brands.results.reduce((n,b)=>n+b.units,0)},people:team,stores:stores.results.slice(0,2000),days:days.results,products:products.results.slice(0,2000),brands:brands.results,truncated:fields.results.length>1000||stores.results.length>2000||products.results.length>2000||missions.results.length>1000,serverTime:new Date().toISOString()});
 }
 return null;
}
const contextSchema={mission_id:uuid.nullable(),store_id:id.nullable(),store_label:txt(160)};
export async function postOperations(u:User,b:any):Promise<Response|null>{
 if(b.action==='service-create'){
  const v=z.object({action:z.literal('service-create'),id:uuid,...contextSchema,kind:z.enum(['complaint','request']),reason:txt(40),channel:z.enum(['onsite','phone','whatsapp','email','other']),product_id:id.nullable(),lot:txt(80),code:z.string().regex(/^[A-Za-z0-9._-]{0,40}$/),priority:z.enum(['normal','priority']),description:txt(2500).min(10),consent:z.boolean(),due_day:optionalDate}).strict().parse(b);
  if(u.role==='doctor'&&v.kind!=='complaint')fail('Les demandes commerciales sont réservées à l’équipe terrain.',403);
  const reason=(v.kind==='request'?REQUEST_REASONS:REASONS)[v.reason];if(!reason)fail('Sélectionnez un motif valide.');
  if(reason.category==='tolerance'&&!v.consent)fail('La transmission anonymisée au médecin doit être acceptée.');
  const old=await db().prepare('SELECT author_id FROM tf_cases WHERE id=?').bind(v.id).first<any>();if(old){if(old.author_id!==u.id)fail('Identifiant déjà utilisé.',409);return json({ok:true,duplicate:true,id:v.id})}
  const store=await context(u,v);if(v.product_id&&!await db().prepare('SELECT id FROM tf_products WHERE id=?').bind(v.product_id).first())fail('Produit introuvable.');
  const now=new Date().toISOString();await db().batch([db().prepare('INSERT INTO tf_cases(id,mission_id,store_id,store_label,author_id,product_id,kind,reason,category,channel,lot,code,priority,description,consent,due_day,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(v.id,v.mission_id,store,v.store_label,u.id,v.product_id,v.kind,v.reason,reason.category,v.channel,v.lot,v.code,v.priority,v.description,+v.consent,v.due_day,now,now),db().prepare('INSERT INTO tf_case_events(id,case_id,user_id,at,status) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),v.id,u.id,now,'new'),audit(u,'service.created',v.id,{kind:v.kind,reason:v.reason})]);return json({ok:true,id:v.id});
 }
 if(b.action==='service-update'){
  const v=z.object({action:z.literal('service-update'),id:uuid,version:z.number().int(),status:z.enum(['new','assigned','ongoing','waiting','resolved','closed']),assignee_id:uuid.nullable(),due_day:optionalDate,public_note:txt(2000),private_note:txt(4000).optional()}).strict().parse(b),c=await caseBy(u,v.id);
  if(!manages(u)&&u.role!=='doctor')fail('Suivi réservé aux responsables.',403);
  if(c.version!==v.version)fail('Ce dossier a changé. Rouvrez-le avant de modifier.',409);
  if(u.role!=='doctor'&&v.private_note!==undefined)fail('Note privée réservée au médecin.',403);
  if(c.category==='tolerance'&&u.role!=='doctor'&&!['new','assigned'].includes(v.status)&&v.status!==c.status)fail('Le médecin met à jour la prise en charge de tolérance.',403);
  if(u.role==='doctor'&&v.assignee_id!==u.id)fail('Attribuez la prise en charge à votre compte.');
  if(v.assignee_id){const a=await db().prepare('SELECT role FROM tf_users WHERE id=? AND active=1').bind(v.assignee_id).first<any>();if(!a||!(c.category==='tolerance'?a.role==='doctor':['admin','manager',...(c.kind==='complaint'?['doctor']:[])].includes(a.role)))fail('Responsable incompatible avec ce dossier.');}
  const guard=crypto.randomUUID(),now=new Date().toISOString();await db().batch([
   db().prepare('INSERT INTO tf_guards(id,ok) VALUES(?,(SELECT CASE WHEN version=? THEN 1 ELSE 0 END FROM tf_cases WHERE id=?))').bind(guard,v.version,c.id),
   db().prepare('UPDATE tf_cases SET status=?,assignee_id=?,doctor_id=?,due_day=?,public_note=?,private_note=?,version=version+1,updated_at=? WHERE id=?').bind(v.status,v.assignee_id,c.category==='tolerance'?v.assignee_id:c.doctor_id,v.due_day,v.public_note,u.role==='doctor'?v.private_note||'':c.private_note,now,c.id),
   db().prepare('INSERT INTO tf_case_events(id,case_id,user_id,at,status,note) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),c.id,u.id,now,v.status,v.public_note),
   audit(u,'service.updated',c.id,{status:v.status}),db().prepare('DELETE FROM tf_guards WHERE id=?').bind(guard)
  ]);return json({ok:true});
 }
 if(b.action==='service-message'){
  const v=z.object({action:z.literal('service-message'),id:uuid,note:txt(2000).min(3),message_id:uuid}).strict().parse(b),c=await caseBy(u,v.id);
  if(c.category==='tolerance'&&u.role!=='doctor'&&c.author_id!==u.id)fail('Complément de tolérance réservé à l’auteur et au médecin.',403);
  const old=await db().prepare('SELECT case_id,user_id FROM tf_case_events WHERE id=?').bind(v.message_id).first<any>();if(old){if(old.case_id!==c.id||old.user_id!==u.id)fail('Identifiant déjà utilisé.',409);return json({ok:true})}
  await db().batch([db().prepare('INSERT INTO tf_case_events(id,case_id,user_id,at,status,note,clinical) VALUES(?,?,?,?,?,?,?)').bind(v.message_id,c.id,u.id,new Date().toISOString(),c.status,v.note,+(c.category==='tolerance')),audit(u,'service.message',c.id)]);return json({ok:true});
 }
 if(b.action==='field-note-create'){
  if(u.role==='doctor')fail('Accès non autorisé.',403);
  const v=z.object({action:z.literal('field-note-create'),id:uuid,...contextSchema,category:z.enum(['shelf','competitor','feedback','availability','opportunity','other']),product_id:id.nullable(),brand:z.enum(['','TOUCHE','BELNCO','NOOM']),competitor:txt(120),sentiment:z.enum(['positive','neutral','negative']),description:txt(2500).min(5)}).strict().parse(b);
  const old=await db().prepare('SELECT author_id FROM tf_field_notes WHERE id=?').bind(v.id).first<any>();if(old){if(old.author_id!==u.id)fail('Identifiant déjà utilisé.',409);return json({ok:true,id:v.id})}
  const store=await context(u,v);if(v.product_id&&!await db().prepare('SELECT id FROM tf_products WHERE id=?').bind(v.product_id).first())fail('Produit introuvable.');
  const now=new Date().toISOString();await db().batch([db().prepare('INSERT INTO tf_field_notes(id,author_id,mission_id,store_id,store_label,category,product_id,brand,competitor,sentiment,description,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(v.id,u.id,v.mission_id,store,v.store_label,v.category,v.product_id,v.brand,v.competitor,v.sentiment,v.description,now,now),audit(u,'field-note.created',v.id,{category:v.category})]);return json({ok:true,id:v.id});
 }
 if(b.action==='field-note-update'){
  if(!manages(u))fail('Accès responsable requis.',403);
  const v=z.object({action:z.literal('field-note-update'),id:uuid,version:z.number().int(),status:z.enum(['new','seen','actioned']),manager_note:txt(2000)}).strict().parse(b),n=await noteBy(u,v.id);
  const r=await db().prepare('UPDATE tf_field_notes SET status=?,manager_note=?,version=version+1,updated_at=? WHERE id=? AND version=?').bind(v.status,v.manager_note,new Date().toISOString(),n.id,v.version).run();if(!r.meta.changes)fail('Observation modifiée entre-temps. Rouvrez-la.',409);await audit(u,'field-note.updated',n.id,{status:v.status}).run();return json({ok:true});
 }
 return null;
}
export async function uploadFieldMedia(u:User,req:Request){
 if(u.role==='doctor')fail('Accès non autorisé.',403);
 if(Number(req.headers.get('content-length')||0)>5300000)fail('Photo trop volumineuse.',413);
 const f=await photoFormData(req),key=uuid.parse(f.get('note_id')),photo=uuid.parse(f.get('photo_id')),n=await noteBy(u,key);
 if(n.author_id!==u.id&&!manages(u))fail('Ajout non autorisé.',403);
 const old=await db().prepare('SELECT note_id,user_id FROM tf_field_photos WHERE id=?').bind(photo).first<any>();if(old){if(old.note_id!==key||old.user_id!==u.id)fail('Identifiant déjà utilisé.',409);return json({ok:true,id:photo})}
 const input=f.get('photo');if(!(input instanceof File)||input.size>5000000||input.size<12)fail('Photo de 5 Mo maximum.');
 if(f.get('no_person')!=='true')fail('Confirmez une photo de rayon sans personnes ni documents personnels.');
 const file=input as File,bytes=new Uint8Array(await file.arrayBuffer()),mime=bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10'?'image/png':String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP'?'image/webp':null;
 if(!mime)fail('Format image non reconnu.');const r2=bindings().STORAGE;if(!r2)fail('Stockage indisponible.',503);
 const object='terrain-notes/'+crypto.randomUUID();await r2!.put(object,bytes,{httpMetadata:{contentType:mime!}});
 try{await db().batch([db().prepare('INSERT INTO tf_field_photos(id,note_id,user_id,object_key,mime,size,created_at) VALUES(?,?,?,?,?,?,?)').bind(photo,key,u.id,object,mime,file.size,new Date().toISOString()),audit(u,'field-note.photo',key)])}catch(e){await r2!.delete(object);if(String(e).includes('FIELD_PHOTO_LIMIT'))fail('Cinq photos maximum par observation.');throw e}
 return json({ok:true,id:photo});
}
export async function readFieldMedia(u:User,q:URLSearchParams){
 const p=await db().prepare('SELECT * FROM tf_field_photos WHERE id=?').bind(uuid.parse(q.get('id'))).first<any>();if(!p)fail('Photo introuvable.',404);await noteBy(u,p.note_id);const r=await bindings().STORAGE?.get(p.object_key);if(!r)fail('Photo indisponible.',404);return new Response(r!.body as any,{headers:{'Content-Type':p.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
