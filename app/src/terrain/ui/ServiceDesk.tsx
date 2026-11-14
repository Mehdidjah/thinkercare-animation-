import {useState} from 'react';

import {Dialog} from './QuickTools';

import {request} from './client';

import {CASE_STATUS,BRANDS,dayInAlger,manages} from '../domain/core';

import {REASONS,REQUEST_REASONS,CHANNELS,CASE_KINDS,reasonLabel} from '../domain/operations';

import {useRemote,Dates,Warning,formValues,localDate} from './OperationsUI';

import {FieldNotebook} from './FieldNotebook';

const uid=()=>crypto.randomUUID();

export function ServiceForm({data,missionId=null,storeId='',initialKind='complaint',close,done}:{data:any;missionId?:string|null;storeId?:string;initialKind?:string;close:()=>void;done:()=>void}){

const [key]=useState(uid),[kind,setKind]=useState(initialKind),[reason,setReason]=useState(''),[store,setStore]=useState(storeId),[busy,setBusy]=useState(false),[err,setErr]=useState('');


const reasons=kind==='request'?REQUEST_REASONS:REASONS,clinical=reasons[reason]?.category==='tolerance';


return <Dialog
   title={kind==='request'?'Nouvelle demande':'Nouvelle réclamation'}
   close={close}
   busy={busy}>
  <form className="ops-form" onSubmit={async e=>{
   e.preventDefault();
  const v=formValues(e);
  setBusy(true);
  setErr('');
  try{
    await request('',{action:'service-create',id:key,mission_id:missionId,store_id:store||null,store_label:v.store_label||'',kind,reason,channel:v.channel,product_id:v.product_id||null,lot:v.lot||'',code:v.code||'',priority:v.priority||'normal',description:v.description,consent:v.consent==='on',due_day:v.due_day||''});
   done()
   }catch(e){
    setErr((e as Error).message)
   }finally{
    setBusy(false)
   }
  }}>

   <p className="subtle">
    {missionId?'Cette demande sera reliée à l’animation.':'Accessible à tout moment, même sans animation ou à la suite d’un appel.'}</p>

   {data.user.role!=='doctor'&&<div className="choice-pills">
    {Object.entries(CASE_KINDS).map(([k,n])=><button
      type="button"
      key={k}
      className={kind===k?'selected':''}
      onClick={()=>{
     setKind(k);
    setReason('')
    }}>
     {n}</button>)}</div>}

   <label>
    {kind==='request'?'Que souhaite la pharmacie ?':'Quel est le problème ?'}
    <select
      required
      value={reason}
      onChange={e=>setReason(e.target.value)}>
     <option value="">Choisir un motif</option>
     {Object.entries(reasons).map(([k,r])=><option key={k} value={k}>
      {r.label}</option>)}</select></label>

   <div className="form-grid">
    <label>Pharmacie<select
       value={store}
       disabled={!!missionId}
       onChange={e=>setStore(e.target.value)}>
      <option value="">Autre lieu / sans pharmacie</option>
      {data.stores.map((s:any)=><option key={s.id} value={s.id}>
       {s.name}</option>)}</select></label>
    <label>Reçu par<select name="channel" defaultValue={missionId?'onsite':'phone'}>
      {Object.entries(CHANNELS).map(([k,n])=><option key={k} value={k}>
       {n}</option>)}</select></label></div>

   {!store&&<label>Nom du lieu, si connu<input
      name="store_label"
      maxLength={160}
      placeholder="Pharmacie ou point de vente"/></label>}

   <label>
    {reason==='other'?'Précisez votre demande':'Détails utiles'}
    <textarea
      name="description"
      required
      minLength={10}
      maxLength={2500}
      rows={4}
      placeholder={kind==='request'?'Besoin exprimé, date souhaitée, éléments à préparer…':'Décrivez les faits et la solution attendue, sans identité cliente.'}/></label>

   <details className="ops-details">
    <summary>Produit, priorité et informations complémentaires</summary>
    <label>Produit concerné<select name="product_id">
      <option value="">Aucun produit précis</option>
      {data.products.filter((p:any)=>p.active).map((p:any)=><option key={p.id} value={p.id}>{BRANDS[p.brand]} · {p.name}</option>)}</select></label>
    <div className="form-grid">
     <label>Lot produit<input name="lot" maxLength={80}/></label>
     <label>Référence de suivi anonyme<input
        name="code"
        maxLength={40}
        pattern="[A-Za-z0-9._-]*"
        placeholder="Ex. SUIVI-024"/></label>
     <label>Priorité<select name="priority">
       <option value="normal">Normale</option>
       <option value="priority">Prioritaire</option></select></label>
     <label>
      {kind==='request'?'Date souhaitée':'Échéance souhaitée'}
      <input name="due_day" type="date"/></label></div></details>

   {clinical&&<div className="notice">
    <p>Ce signalement sera transmis aux médecins. Saisissez les faits sans nom, téléphone ni photo de peau.</p>
    <label className="check"><input
       type="checkbox"
       name="consent"
       required/>La transmission anonymisée au médecin a été expliquée et acceptée.</label></div>}

   {err&&<Warning>
    {err}</Warning>}
   <button className="primary" disabled={busy||!reason}>
    {busy?'Enregistrement…':kind==='request'?'Enregistrer la demande':'Enregistrer la réclamation'}</button></form></Dialog>

}

export function ServiceDesk({data,notify}:{data:any;notify:(s:string)=>void}){

const today=dayInAlger(),[from,setFrom]=useState(today.slice(0,7)+'-01'),[to,setTo]=useState(today),[kind,setKind]=useState('complaint'),[status,setStatus]=useState(''),[search,setSearch]=useState(''),[create,setCreate]=useState(false),[selected,setSelected]=useState(''),doctor=data.user.role==='doctor';


const remote=useRemote('action=service-list&'+new URLSearchParams({from,to})),rows=(remote.data?.cases||[]).filter((c:any)=>c.kind===kind&&(!status||c.status===status)&&(c.store_name+' '+c.code+' '+reasonLabel(c)+' '+c.author_name).toLowerCase().includes(search.toLowerCase()));


const overdue=rows.filter((c:any)=>c.due_day&&c.due_day<today&&!['resolved','closed'].includes(c.status)).length;


return <>
  <div className="heading">
   <div>
    <p className="eyebrow">
     {doctor?'ESPACE MÉDECINS':'UN SUIVI, À TOUT MOMENT'}</p>
    <h1>
     {kind==='notes'?'Les retours du terrain.':kind==='request'?'Les demandes à organiser.':'Chaque réclamation est suivie.'}</h1>
    <p>Appel, visite ou retour après une animation : retrouvez chaque dossier et son avancement.</p></div>
   {kind!=='notes'&&<button className="primary" onClick={()=>setCreate(true)}>
    {kind==='request'?'+ Nouvelle demande':'+ Nouvelle réclamation'}</button>}</div>

  <div className="tabs">
   <button className={kind==='complaint'?'on':''} onClick={()=>setKind('complaint')}>Réclamations</button>
   {!doctor&&<>
    <button className={kind==='request'?'on':''} onClick={()=>setKind('request')}>Demandes</button>
    <button className={kind==='notes'?'on':''} onClick={()=>setKind('notes')}>Retours terrain</button></>}</div>

  {kind==='notes'?<FieldNotebook data={data} notify={notify}/>:<section className="panel">
   <div className="filters">
    <Dates {...{from,to,setFrom,setTo}}/>
    <label>Statut<select value={status} onChange={e=>setStatus(e.target.value)}>
      <option value="">Tous les statuts</option>
      {Object.entries(CASE_STATUS).map(([k,n])=><option key={k} value={k}>
       {n}</option>)}</select></label>
    <label>Rechercher<input
       type="search"
       placeholder="Pharmacie, motif, référence…"
       value={search}
       onChange={e=>setSearch(e.target.value)}/></label></div>

   {remote.error&&<Warning>
    {remote.error}</Warning>}
   {remote.data?.truncated&&<Warning>Les 1 000 dossiers les plus récents sont affichés. Réduisez la période pour une liste complète.</Warning>}

   <div className="service-summary">
    <span>{rows.length} dossier(s)</span>
    <span>{rows.filter((c:any)=>!['closed','resolved'].includes(c.status)).length} à traiter</span>
    {overdue>0&&<strong>{overdue} échéance(s) dépassée(s)</strong>}</div>

   {remote.loading?<p>Chargement des dossiers…</p>:!rows.length?<div className="empty">
    <h3>Aucun dossier pour cette sélection.</h3>
    <p>Vous pouvez en créer un sans démarrer d’animation.</p></div>:<div className="case-grid">
    {rows.map((c:any)=><button
      className="case-card"
      key={c.id}
      onClick={()=>setSelected(c.id)}>
     <div>
      <span className={'badge '+c.status}>
       {CASE_STATUS[c.status]}</span>
      {c.priority==='priority'&&<span className="alert-tag">Prioritaire</span>}</div>
     <h3>
      {reasonLabel(c)}</h3>
     <p>
      {c.store_name}</p>
     <small>{CHANNELS[c.channel]} · {localDate(c.created_at)}</small>
     <small>{c.author_name} · {c.code||c.id.slice(0,8)}</small>
     <b>
      {c.assignee_name||'En attente d’attribution'}</b>
     {c.due_day&&<small className={c.due_day<today&&!['resolved','closed'].includes(c.status)?'danger-text':''}>Échéance : {c.due_day}</small>}</button>)}</div>}</section>}

  {create&&<ServiceForm
    data={data}
    initialKind={kind}
    close={()=>setCreate(false)}
    done={()=>{
   setCreate(false);
  void remote.reload();
  notify('Dossier enregistré.')
  }}/>}

  {selected&&<CaseDetail
    key={selected}
    id={selected}
    data={data}
    close={()=>setSelected('')}
    saved={()=>{
   void remote.reload();
  notify('Suivi enregistré.')
  }}/>}</>

}

function CaseDetail({id,data,close,saved}:{id:string;data:any;close:()=>void;saved:()=>void}){

const r=useRemote('action=service-detail&id='+id),[err,setErr]=useState(''),[busy,setBusy]=useState(false),[messageId,setMessageId]=useState(uid),doctor=data.user.role==='doctor',manager=manages(data.user),c=r.data?.case;


return <Dialog
   title="Suivi du dossier"
   close={close}
   busy={busy}>
  <div className="ops-form">
   {r.error&&<Warning>
    {r.error}</Warning>}
   {!c?<p>Chargement…</p>:<>
    <div className="inline">
     <span className={'badge '+c.status}>
      {CASE_STATUS[c.status]}</span>
     <b>
      {reasonLabel(c)}</b></div>
    <p>{c.store_name} · {CHANNELS[c.channel]} · {localDate(c.created_at)}</p>
    {c.description!==undefined?<p className="note-block preline">
     {c.description}</p>:<p className="notice">Les détails de tolérance sont réservés à l’auteur et aux médecins.</p>}
    {c.public_note&&<div className="note-block">
     <h3>Retour à l’équipe</h3>
     <p className="preline">
      {c.public_note}</p></div>}

    <details className="ops-details">
     <summary>Historique du dossier ({r.data.events.length})</summary>
     {r.data.events.map((e:any)=><div className="case-event" key={e.id}>
      <small>{localDate(e.at)} · {e.label} · {CASE_STATUS[e.status]}</small>
      {e.note&&<p className="preline">
       {e.note}</p>}</div>)}</details>

    {(manager||doctor)&&<form key={c.version} onSubmit={async e=>{
     e.preventDefault();
    const v=formValues(e);
    setBusy(true);
    setErr('');
    try{
      await request('',{action:'service-update',id,version:c.version,status:v.status,assignee_id:doctor?data.user.id:v.assignee_id||null,due_day:v.due_day||'',public_note:v.public_note,...(doctor?{private_note:v.private_note}:{})});
     await r.reload();
     saved()
     }catch(e){
      setErr((e as Error).message)
     }finally{
      setBusy(false)
     }
    }}>

     <h3>Prendre en charge</h3>
     {!doctor&&<label>Responsable<select name="assignee_id" defaultValue={c.assignee_id||''}>
       <option value="">Non attribué</option>
       {data.users.filter((u:any)=>u.active&&(c.category==='tolerance'?u.role==='doctor':['admin','manager',...(c.kind==='complaint'?['doctor']:[])].includes(u.role))).map((u:any)=><option key={u.id} value={u.id}>
        {u.label}</option>)}</select></label>}

     <div className="form-grid">
      <label>Statut<select name="status" defaultValue={c.status}>
        {Object.entries(CASE_STATUS).filter(([k])=>doctor||c.category!=='tolerance'||['new','assigned',c.status].includes(k)).map(([k,n])=><option key={k} value={k}>
         {n}</option>)}</select></label>
      <label>Échéance<input
         type="date"
         name="due_day"
         defaultValue={c.due_day}/></label></div>

     {doctor&&<label>Note privée médecin<textarea
        name="private_note"
        maxLength={4000}
        defaultValue={c.private_note||''}/></label>}
     <label>Retour opérationnel partagé<textarea
        name="public_note"
        maxLength={2000}
        defaultValue={c.public_note}
        placeholder="Action prévue, sans information médicale."/></label>
     <button className="primary" disabled={busy}>
      {busy?'Enregistrement…':'Enregistrer le suivi'}</button></form>}

    {(c.category!=='tolerance'||doctor||c.author_id===data.user.id)&&<form className="ops-details" onSubmit={async e=>{
     e.preventDefault();
    const form=e.currentTarget,v=formValues(e);
    setBusy(true);
    setErr('');
    try{
      await request('',{action:'service-message',id,message_id:messageId,note:v.note});
     setMessageId(uid());
     form.reset();
     await r.reload();
     saved()
     }catch(e){
      setErr((e as Error).message)
     }finally{
      setBusy(false)
     }
    }}>
     <label>Ajouter un complément<textarea
        name="note"
        minLength={3}
        maxLength={2000}
        required
        placeholder="Nouvelle information ou retour reçu…"/></label>
     <button className="outline" disabled={busy}>Ajouter au dossier</button></form>}

    {err&&<Warning>
     {err}</Warning>}</>}</div></Dialog>

}
