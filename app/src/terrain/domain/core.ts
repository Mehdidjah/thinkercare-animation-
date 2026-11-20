export const BRANDS:Record<string,string>={TOUCHE:'TOUCHÉ',BELNCO:'BELNCO',NOOM:'NOOM'};
export const ROLES:Record<string,string>={admin:'Direction',manager:'Gestionnaire',field:'Animatrice',doctor:'Médecin'};
export const STATUS:Record<string,string>={planned:'Programmée',ongoing:'En cours',completed:'Terminée',cancelled:'Annulée'};
export const REPORT:Record<string,string>={draft:'Brouillon',submitted:'À valider',approved:'Validé',changes:'À corriger'};
export const CASE_STATUS:Record<string,string>={new:'Nouvelle',assigned:'Attribuée',ongoing:'Prise en charge',waiting:'En attente',resolved:'Résolue',closed:'Clôturée'};
export type User={id:string;username:string;label:string;role:string;active:number;force_change:number};
export const manages=(u:Pick<User,'role'>)=>['admin','manager'].includes(u.role);
export const canMission=(u:Pick<User,'id'|'role'>,m:{field_id:string})=>manages(u)||u.role==='field'&&m.field_id===u.id;
export const canEdit=(u:Pick<User,'id'|'role'>,m:{field_id:string;status:string;report_status:string})=>canMission(u,m)&&(m.status==='ongoing'||m.status==='completed'&&['draft','changes'].includes(m.report_status));
export function dayInAlger(x:string|number|Date=new Date()){return new Date(new Date(x).getTime()+3600000).toISOString().slice(0,10);}
export const shiftDay=(s:string,n:number)=>new Date(Date.parse(s+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
export function weekStart(s:string){const dow=new Date(s+'T12:00:00Z').getUTCDay();return shiftDay(s,-((dow+6)%7));}
export const money=(n:number)=>new Intl.NumberFormat('fr-DZ',{minimumFractionDigits:n%100?2:0,maximumFractionDigits:2}).format(n/100)+' DA';
export const clock=(s:string|null)=>s?new Date(s).toLocaleTimeString('fr-FR',{timeZone:'Africa/Algiers',hour:'2-digit',minute:'2-digit'}):'Non pointé';
export const dateLabel=(s:string)=>new Date(s+'T12:00:00Z').toLocaleDateString('fr-FR',{weekday:'short',day:'numeric',month:'short'});
export const ticketTotal=(lines:{qty:number;unit_price:number}[])=>lines.reduce((n,l)=>n+l.qty*l.unit_price,0);
export function soldBy(tickets:any[]){const r:Record<string,number>=Object.create(null);for(const t of tickets.filter(t=>t.status==='valid'))for(const l of t.lines)r[l.product_id]=(r[l.product_id]||0)+l.qty;return r;}
export const expected=(s:any,sold:number)=>s.opening+s.received-s.other_out-sold;
export function expiryState(date:string,today:string=dayInAlger()){if(!date)return'unknown';const days=Math.floor((Date.parse(date)-Date.parse(today))/86400000);return days<0?'expired':days<=90?'soon':'ok';}
export function reportIssues(counts:any[],tickets:any[],noSales:boolean){const sold=soldBy(tickets),out:string[]=[];if(!tickets.some(t=>t.status==='valid')&&!noSales)out.push('Confirmez explicitement une animation sans vente.');for(const s of counts){if(s.closing===null)out.push('Stock final manquant : '+(s.product_name||s.product_id));else if(s.closing!==expected(s,sold[s.product_id]||0)&&!s.note.trim())out.push('Expliquez l’écart de stock : '+(s.product_name||s.product_id));}return out;}
export function csv(rows:unknown[][]){return '\uFEFF'+rows.map(r=>r.map(v=>{let x=String(v??'');if(/^[=+\-@\t\r]/.test(x))x="'"+x;return '"'+x.replaceAll('"','""')+'"'}).join(';')).join('\r\n');}
export const stats=(missions:any[])=>({planned:missions.filter(m=>m.status==='planned').length,ongoing:missions.filter(m=>m.status==='ongoing').length,completed:missions.filter(m=>m.status==='completed').length,cancelled:missions.filter(m=>m.status==='cancelled').length,sales:missions.reduce((s,m)=>s+(m.sales_total||0),0),tickets:missions.reduce((s,m)=>s+(m.tickets||0),0),units:missions.reduce((s,m)=>s+(m.units||0),0)});

export function attendance(m:any,now:string|number=new Date().toISOString()):{kind:'missing_start'|'late_start'|'missing_end';minutes:number}|null {
 if(m.status==='cancelled')return null;
 const start=Date.parse(m.start_at),actual=m.actual_start?Date.parse(m.actual_start):new Date(now).getTime();
 const grace=Number.isFinite(m.late_grace_minutes)?m.late_grace_minutes:15;
 const end=Date.parse(m.end_at),at=new Date(now).getTime();
 if(m.status==='ongoing'&&Number.isFinite(end)&&at>end+grace*60000)return {kind:'missing_end',minutes:Math.floor((at-end)/60000)};
 if(!Number.isFinite(start)||!Number.isFinite(actual)||actual<=start+grace*60000)return null;
 if(!m.actual_start&&m.status!=='planned')return null;
 return {kind:m.actual_start?'late_start':'missing_start',minutes:Math.floor((actual-start)/60000)};
}
/** The middle photo unlocks halfway through the planned slot (a late arrival past it may take it at once). */
export function midwayTime(m:{start_at:string;end_at:string}){const start=Date.parse(m.start_at);return new Date(start+(Date.parse(m.end_at)-start)/2).toISOString();}
export function clockIssue(u:Pick<User,'id'|'role'>,m:any,purpose:string,now:string|number=new Date().toISOString()):string|null {
 if(u.role!=='field'||u.id!==m.field_id)return 'Le pointage appartient à l’animatrice assignée.';
 if(purpose==='checkin')return m.status!=='planned'||m.day!==dayInAlger(now)?'L’arrivée se pointe le jour prévu, une seule fois par animation.':null;
 if(purpose!=='midway'&&purpose!=='checkout')return 'Type de pointage invalide.';
 if(purpose==='midway'&&m.midway_at)return 'La photo du milieu est déjà enregistrée.';
 if(m.status!=='ongoing'||!m.actual_start)return purpose==='midway'?'Pointez votre arrivée avant la photo du milieu.':'Pointez votre arrivée avant votre départ.';
 if(m.midway_at)return null;
 const at=midwayTime(m),early=Date.parse(at)>new Date(now).getTime();
 if(purpose==='midway')return early?'La photo du milieu sera disponible à '+clock(at)+'.':null;
 return early?'Prenez d’abord la photo du milieu (disponible à '+clock(at)+').':'Prenez d’abord la photo du milieu.';
}
export const delayLabel=(minutes:number)=>minutes>=60?Math.floor(minutes/60)+' h'+(minutes%60?' '+minutes%60+' min':''):minutes+' min';
