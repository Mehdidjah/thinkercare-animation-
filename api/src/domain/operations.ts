import {manages,type User} from './core';
export const BONUS_PER_SALE=5000;
export const CASE_KINDS:Record<string,string>={complaint:'Réclamation',request:'Demande'};
export const CHANNELS:Record<string,string>={onsite:'Sur place',phone:'Appel téléphonique',whatsapp:'WhatsApp',email:'E-mail',other:'Autre'};
export const REASONS:Record<string,{label:string;category:string}>={
 packaging:{label:'Emballage, pompe ou bouchon',category:'quality'},texture:{label:'Texture, odeur ou aspect',category:'quality'},
 damaged:{label:'Produit abîmé ou fuite',category:'quality'},expiry:{label:'Péremption ou lot',category:'quality'},
 availability:{label:'Rupture ou produit introuvable',category:'commercial'},price:{label:'Prix ou promotion',category:'commercial'},
 delivery:{label:'Commande ou livraison',category:'commercial'},service:{label:'Accueil ou service',category:'commercial'},
 tolerance:{label:'Réaction ou problème de tolérance',category:'tolerance'},other:{label:'Autre — préciser',category:'commercial'}
};
export const REQUEST_REASONS:Record<string,{label:string;category:string}>={
 new_animation:{label:'Organiser une nouvelle animation',category:'commercial'},dermoscan:{label:'Demander un Dermoscan',category:'commercial'},
 restock:{label:'Réassort ou commande',category:'commercial'},material:{label:'Présentoir, testeurs ou supports',category:'commercial'},
 training:{label:'Formation de l’équipe pharmacie',category:'commercial'},followup:{label:'Rappel ou visite commerciale',category:'commercial'},
 partnership:{label:'Partenariat ou référencement',category:'commercial'},other:{label:'Autre — préciser',category:'commercial'}
};
export const NOTE_TYPES:Record<string,string>={shelf:'Rayon & mise en avant',competitor:'Concurrence',feedback:'Retour client',availability:'Disponibilité & stock',opportunity:'Opportunité commerciale',other:'Autre observation'};
export const NOTE_STATUS:Record<string,string>={new:'À lire',seen:'Vu',actioned:'Action engagée'};
export const SENTIMENTS:Record<string,string>={positive:'Positif',neutral:'Neutre',negative:'Négatif'};
export const MAX_REASONS=3;
export function reasonFor(kind:string,reason:string){const r=kind==='request'?REQUEST_REASONS:REASONS;return Object.hasOwn(r,reason)?r[reason]:undefined;}
// Selection order, main reason first; rows created before multiple reasons only have `reason`.
export function caseReasons(c:any):string[]{const keys=String(c.reasons||'').split(',').filter(Boolean);return keys.length?keys:c.reason?[c.reason]:[];}
export function reasonCategory(kind:string,keys:string[]){const found=keys.map(k=>reasonFor(kind,k)?.category);return found.includes('tolerance')?'tolerance':found.includes('quality')?'quality':'commercial';}
export function reasonLabel(c:any){return caseReasons(c).map(k=>reasonFor(c.kind,k)?.label||'Autre').join(' · ')||'Autre';}
export function canReadCase(u:Pick<User,'id'|'role'>,c:any){return manages(u)||u.role==='doctor'&&c.kind==='complaint'||u.role==='field'&&c.author_id===u.id;}
export function safeCase(u:Pick<User,'id'|'role'>,c:any){const {private_note,description,...safe}=c;return {...safe,...(u.role==='doctor'?{private_note,description}:c.author_id===u.id||manages(u)&&c.category!=='tolerance'?{description}:{})};}
export function canReadFieldNote(u:Pick<User,'id'|'role'>,n:any){return manages(u)||u.role==='field'&&n.author_id===u.id;}
export const bonusForTickets=(tickets:any[])=>tickets.filter(t=>t.status==='valid').reduce((n,t)=>n+Number(t.bonus_amount??BONUS_PER_SALE),0);
