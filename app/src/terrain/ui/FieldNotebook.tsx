import {useState} from 'react';

import {Dialog} from './QuickTools';
import {sendFieldPhoto as sendPhoto, selectPhotos, type PickedPhoto as Picked} from './field-photo-client';
import {photoPath} from '../domain/response-checks';

import {request} from './client';

import {BRANDS,dayInAlger,manages} from '../domain/core';

import {NOTE_TYPES,NOTE_STATUS,SENTIMENTS} from '../domain/operations';

import {useRemote,Dates,Warning,formValues,localDate} from './OperationsUI';

const uid=()=>crypto.randomUUID();

export function FieldNoteForm({data,missionId=null,storeId='',close,done}:{data:any;missionId?:string|null;storeId?:string;close:()=>void;done:()=>void}){

const [id]=useState(uid),[type,setType]=useState('shelf'),[store,setStore]=useState(storeId),[photos,setPhotos]=useState<Picked[]>([]),[checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[created,setCreated]=useState(false),[err,setErr]=useState('');


return <Dialog
   title="Partager un retour terrain"
   close={close}
   busy={busy}>
  <form className="ops-form" onSubmit={async e=>{
   e.preventDefault();
  const v=formValues(e);
  setBusy(true);
  setErr('');
  try{

    if(!created){
     await request('',{action:'field-note-create',id,mission_id:missionId,store_id:store||null,store_label:v.store_label||'',category:type,product_id:v.product_id||null,brand:v.brand||'',competitor:v.competitor||'',sentiment:v.sentiment||'neutral',description:v.description});
    setCreated(true)
    }


    for(const p of photos){
     await sendPhoto(id,p);
    setPhotos(old=>old.filter(x=>x.id!==p.id))
    }
   done();

 }catch(e){
    setErr((e as Error).message)
   }finally{
    setBusy(false)
   }
  }}>

   {created&&<p className="notice">L’observation est enregistrée. Vous pouvez réessayer l’envoi des photos restantes.</p>}

   <fieldset disabled={busy||created}>
    <label>Type de retour<select value={type} onChange={e=>setType(e.target.value)}>
      {Object.entries(NOTE_TYPES).map(([k,n])=><option key={k} value={k}>
       {n}</option>)}</select></label>

    <label>Pharmacie<select
       value={store}
       disabled={!!missionId}
       onChange={e=>setStore(e.target.value)}>
      <option value="">Autre lieu / sans pharmacie</option>
      {data.stores.map((s:any)=><option key={s.id} value={s.id}>
       {s.name}</option>)}</select></label>
    {!store&&<label>Lieu<input
       name="store_label"
       maxLength={160}
       placeholder="Nom du point de vente"/></label>}

    {type==='competitor'&&<label>Marque concurrente<input
       name="competitor"
       maxLength={120}
       placeholder="Marque, promotion ou nouveauté observée"/></label>}

    {type==='feedback'&&<label>Ressenti du client<select name="sentiment" defaultValue="neutral">
      {Object.entries(SENTIMENTS).map(([k,n])=><option key={k} value={k}>
       {n}</option>)}</select></label>}

    <label>
     {type==='feedback'?'Retour reçu, sans identité cliente':type==='shelf'?'Ce que vous observez sur le rayon':'Observation'}
     <textarea
       name="description"
       minLength={5}
       maxLength={2500}
       rows={4}
       required
       placeholder={type==='shelf'?'Emplacement, visibilité, nombre de facings, présence de testeurs…':type==='competitor'?'Prix, promotion, mise en avant, argumentaire observé…':'Avis reçu, besoin exprimé ou action proposée…'}/></label>

    <details className="ops-details">
     <summary>Associer une marque ou un produit</summary>
     <label>Marque<select name="brand">
       <option value="">Toutes / non précisée</option>
       {Object.entries(BRANDS).map(([k,n])=><option key={k} value={k}>
        {n}</option>)}</select></label>
     <label>Produit<select name="product_id">
       <option value="">Aucun produit précis</option>
       {data.products.filter((p:any)=>p.active).map((p:any)=><option key={p.id} value={p.id}>
        {p.name}</option>)}</select></label></details></fieldset>

   <label className="capture-button">Photos du rayon ou de la mise en avant · 5 maximum<input
      type="file"
      accept="image/jpeg,image/png,image/webp"
      multiple
      disabled={busy||created}
      onChange={e=>{
     try {
      setPhotos(selectPhotos(Array.from(e.target.files || [])));
      setErr('');
    } catch (error) {
      setPhotos([]);
      e.target.value = '';
      setErr((error as Error).message);
    }
    }}/></label>

   {photos.length>0&&<>
    <ul className="photo-files">
     {photos.map(p=><li key={p.id}>
      {p.file.name}</li>)}</ul>
    <label className="check"><input
       type="checkbox"
       checked={checked}
       onChange={e=>setChecked(e.target.checked)}
       required/>Les photos montrent les produits ou rayons, sans clients ni documents personnels.</label></>}

   {err&&<Warning>
    {err}</Warning>}
   <button className="primary" disabled={busy||photos.length>0&&!checked}>
    {busy?'Enregistrement…':created?'Réessayer les photos':'Partager le retour'}</button>
   {created&&<button
     type="button"
     className="text"
     disabled={busy}
     onClick={done}>Terminer avec les éléments déjà enregistrés</button>}</form></Dialog>

}

export function FieldNotebook({data,notify}:{data:any;notify:(s:string)=>void}){

const today=dayInAlger(),[from,setFrom]=useState(today.slice(0,7)+'-01'),[to,setTo]=useState(today),[type,setType]=useState(''),[status,setStatus]=useState(''),[search,setSearch]=useState(''),[create,setCreate]=useState(false),[selected,setSelected]=useState('');


const r=useRemote('action=field-notes&'+new URLSearchParams({from,to})),rows=(r.data?.notes||[]).filter((n:any)=>(!type||n.category===type)&&(!status||n.status===status)&&(n.store_name+' '+n.competitor+' '+n.description+' '+n.author_name).toLowerCase().includes(search.toLowerCase()));


return <>
  <div className="section-head">
   <div>
    <h2>Photos, avis et observations</h2>
    <p>Un carnet partagé pour améliorer la présence de vos marques en pharmacie.</p></div>
   <button className="primary" onClick={()=>setCreate(true)}>+ Retour terrain</button></div>
  <section className="panel">
   <div className="filters">
    <Dates {...{from,to,setFrom,setTo}}/>
    <label>Type<select value={type} onChange={e=>setType(e.target.value)}>
      <option value="">Tous les retours</option>
      {Object.entries(NOTE_TYPES).map(([k,n])=><option key={k} value={k}>
       {n}</option>)}</select></label>
    <label>Suivi<select value={status} onChange={e=>setStatus(e.target.value)}>
      <option value="">Tous</option>
      {Object.entries(NOTE_STATUS).map(([k,n])=><option key={k} value={k}>
       {n}</option>)}</select></label>
    <label>Rechercher<input
       type="search"
       value={search}
       onChange={e=>setSearch(e.target.value)}
       placeholder="Pharmacie, concurrent, avis…"/></label></div>

   {r.error&&<Warning>
    {r.error}</Warning>}
   {r.data?.truncated&&<Warning>Liste limitée aux 1 000 observations les plus récentes. Réduisez la période.</Warning>}

   <p className="subtle">{rows.length} retour(s) · {rows.filter((n:any)=>n.status==='new').length} à lire · {rows.filter((n:any)=>n.category==='feedback'&&n.sentiment==='negative').length} avis négatif(s)</p>

   {r.loading?<p>Chargement…</p>:!rows.length?<div className="empty">
    <h3>Aucun retour pour cette sélection.</h3>
    <p>Ajoutez une photo du rayon, un avis client ou une observation sur un concurrent.</p></div>:<div className="field-note-grid">
    {rows.map((n:any)=><button
      className="field-note-card"
      key={n.id}
      onClick={()=>setSelected(n.id)}>
     {n.photo_id?<img
       loading="lazy"
       src={photoPath(n.photo_id)}
       alt={NOTE_TYPES[n.category]+' · '+n.store_name}/>:<div className="note-photo-empty">
      {NOTE_TYPES[n.category]}</div>}
     <div>
      <span className={'badge '+n.status}>
       {NOTE_STATUS[n.status]}</span>
      <small>
       {NOTE_TYPES[n.category]}
       {n.category==='feedback'?' · '+SENTIMENTS[n.sentiment]:''}</small>
      <h3>
       {n.store_name}</h3>
      <p>
       {n.description}</p>
      {n.competitor&&<b>
       {n.competitor}</b>}
      <small>{n.author_name} · {localDate(n.created_at)} · {n.photo_count} photo(s)</small></div></button>)}</div>}</section>

  {create&&<FieldNoteForm
    data={data}
    close={()=>setCreate(false)}
    done={()=>{
   setCreate(false);
  void r.reload();
  notify('Retour terrain enregistré.')
  }}/>}
  {selected&&<NoteDetail
    id={selected}
    data={data}
    close={()=>setSelected('')}
    saved={()=>{
   void r.reload();
  notify('Observation mise à jour.')
  }}/>}</>

}

function NoteDetail({id,data,close,saved}:{id:string;data:any;close:()=>void;saved:()=>void}){

const r=useRemote('action=field-note&id='+id),[err,setErr]=useState(''),[busy,setBusy]=useState(false),[photo,setPhoto]=useState<Picked|null>(null),n=r.data?.note;


return <Dialog
   title="Retour terrain"
   close={close}
   busy={busy}>
  <div className="ops-form">
   {r.error&&<Warning>
    {r.error}</Warning>}
   {n&&<>
    <span className="eyebrow">
     {NOTE_TYPES[n.category]}</span>
    <h2>
     {n.store_name}</h2>
    <small>{n.author_name} · {localDate(n.created_at)}</small>
    <p className="preline">
     {n.description}</p>
    {n.competitor&&<p>
     <b>Concurrent :</b>
     {n.competitor}</p>}
    {n.category==='feedback'&&<p>Ressenti : {SENTIMENTS[n.sentiment]}</p>}
    <div className="photo-grid">
     {r.data.photos.map((p:any)=><a
       key={p.id}
       href={photoPath(p.id)}
       target="_blank"
       rel="noreferrer">
      <img src={photoPath(p.id)} alt={'Rayon ou produit — '+n.store_name}/></a>)}</div>

    {r.data.photos.length<5&&<details className="ops-details">
     <summary>Ajouter une photo</summary>
     <form onSubmit={async e=>{
      e.preventDefault();
     if(!photo)return;
     setBusy(true);
     setErr('');
     try{
       await sendPhoto(id,photo);
      setPhoto(null);
      await r.reload();
      saved()
      }catch(e){
       setErr((e as Error).message)
      }finally{
       setBusy(false)
      }
     }}>
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        required
        onChange={e=>{
       const f=e.target.files?.[0];
      if(f) { try {setPhoto(selectPhotos([f],1)[0]);setErr('')} catch(error) {setPhoto(null);setErr((error as Error).message)} }else{
        setPhoto(null);
       setErr('Photo de 15 Mo maximum.')
       }
      }}/>
      <label className="check"><input type="checkbox" required/>Photo du lieu sans personnes ni documents personnels.</label>
      <button className="outline" disabled={busy||!photo}>Ajouter la photo</button></form></details>}

    {n.manager_note&&<div className="note-block">
     <b>Retour de la direction</b>
     <p>
      {n.manager_note}</p></div>}

    {manages(data.user)&&<form key={n.version} onSubmit={async e=>{
     e.preventDefault();
    const v=formValues(e);
    setBusy(true);
    setErr('');
    try{
      await request('',{action:'field-note-update',id,version:n.version,status:v.status,manager_note:v.manager_note});
     await r.reload();
     saved()
     }catch(e){
      setErr((e as Error).message)
     }finally{
      setBusy(false)
     }
    }}>
     <label>Suivi<select name="status" defaultValue={n.status}>
       {Object.entries(NOTE_STATUS).map(([k,s])=><option key={k} value={k}>
        {s}</option>)}</select></label>
     <label>Action ou réponse à l’animatrice<textarea
        name="manager_note"
        defaultValue={n.manager_note}
        maxLength={2000}/></label>
     <button className="primary" disabled={busy}>Enregistrer le suivi</button></form>}
    {err&&<Warning>
     {err}</Warning>}</>}</div></Dialog>

}
