import {useState,type ReactNode} from 'react';

import {BRANDS,dayInAlger,manages,money,shiftDay} from '../domain/core';

import {useRemote,Dates,Warning,exportCSV} from './OperationsUI';

function Stat({label,value,note}:{label:string;value:ReactNode;note?:string}){
return <div className="metric">
  <span>
   {label}</span>
  <strong>
   {value}</strong>
  {note&&<small>
   {note}</small>}</div>
}

export function BonusStrip(){
const r=useRemote('action=bonuses');
return <section className="bonus-strip" aria-label="Mes primes">
  {r.error?<Warning>
   {r.error}</Warning>:r.data?<>
   <div>
    <span>Ma prime aujourd’hui</span>
    <strong>
     {money(r.data.today.bonus)}</strong>
    <small>{r.data.today.tickets} vente(s) · 50 DA par vente</small></div>
   <div>
    <span>Ma prime ce mois-ci</span>
    <strong>
     {money(r.data.month.bonus)}</strong>
    <small>{r.data.month.tickets} vente(s) comptabilisées</small></div>
   <p>Chaque vente compte.<br/><small>Montants calculés, hors ventes annulées.</small></p></>:<p>Chargement de mes primes…</p>}</section>
}

export function Performance({data,details}:{data:any;details:ReactNode}){

const today=dayInAlger(),manager=manages(data.user),[from,setFrom]=useState(today.slice(0,7)+'-01'),[to,setTo]=useState(today),[person,setPerson]=useState(''),[store,setStore]=useState(''),[tab,setTab]=useState('overview'),[rank,setRank]=useState<'tickets'|'revenue'>('tickets'),[productSearch,setProductSearch]=useState(''),[brand,setBrand]=useState('');


const r=useRemote('action=performance&'+new URLSearchParams({from,to,person,store})),bonus=useRemote('action=bonuses'),d=r.data;


const team=d?[...d.people].sort((a:any,b:any)=>b[rank]-a[rank]):[],products=(d?.products||[]).filter((p:any)=>(!brand||p.brand===brand)&&p.name.toLowerCase().includes(productSearch.toLowerCase()));


function exportRows(){
 if(!d)return;
exportCSV('thinkercare-statistiques-'+from+'-'+to+'.csv',[
 ['Période',from,to],['Ventes',d.totals.tickets],['Unités',d.totals.units],['CA DZD',d.totals.revenue/100],['Primes calculées DZD',d.totals.bonus/100],[],
 ['Animatrice','Ventes','CA DZD','Prime DZD','Animations terminées','Animations prévues','Retards'],
 ...d.people.map((p:any)=>[p.name,p.tickets,p.revenue/100,p.bonus/100,p.completed||0,p.scheduled||0,p.late||0]),[],
 ['Produit','Marque','Unités','CA DZD','Tickets contenant le produit'],...d.products.map((p:any)=>[p.name,BRANDS[p.brand],p.units,p.revenue/100,p.tickets]),[],
 ['Pharmacie','Ventes','CA DZD','Prime DZD'],...d.stores.map((s:any)=>[s.name,s.tickets,s.revenue/100,s.bonus/100])
 ]);
}


return <>
  <div className="heading">
   <div>
    <p className="eyebrow">
     {manager?'PERFORMANCES & PRIMES':'VOTRE TRAVAIL, VOS RÉSULTATS'}</p>
    <h1>
     {manager?'Ce qui fait avancer le terrain.':'Chaque vente vous rapporte.'}</h1>
    <p>50 DA par vente enregistrée, quel que soit le nombre de produits. Les ventes annulées sont exclues.</p></div>
   {tab!=='reports'&&<button
     className="outline"
     disabled={!d||!!r.error||d.truncated}
     onClick={exportRows}>Exporter les statistiques</button>}</div>

  {!manager&&<BonusStrip/>}
  <div className="tabs">
   {[['overview',manager?'Vue d’ensemble':'Mes résultats'],['bonus','Primes & progression'],['reports','Rapports d’animation']].map(([k,n])=><button
     key={k}
     className={tab===k?'on':''}
     onClick={()=>setTab(k)}>
    {n}</button>)}</div>

  {tab==='reports'?details:<>
   <section className="panel">
    <div className="filters">
     <Dates {...{from,to,setFrom,setTo}}/>
     {manager&&<label>Animatrice<select value={person} onChange={e=>setPerson(e.target.value)}>
       <option value="">Toute l’équipe</option>
       {data.users.filter((u:any)=>u.role==='field').map((u:any)=><option key={u.id} value={u.id}>
        {u.label}</option>)}</select></label>}
     <label>Pharmacie<select value={store} onChange={e=>setStore(e.target.value)}>
       <option value="">Toutes</option>
       {data.stores.map((s:any)=><option key={s.id} value={s.id}>
        {s.name}</option>)}</select></label>
     <button className="text" onClick={()=>{
      setFrom(today);
     setTo(today)
     }}>Aujourd’hui</button>
     <button className="text" onClick={()=>{
      setFrom(today.slice(0,7)+'-01');
     setTo(today)
     }}>Ce mois</button></div>
    <p className="subtle">Calcul selon la date de l’animation, en heure d’Alger. Une vente correspond à un ticket ; un lot vendu compte comme une unité commerciale. Les primes affichées ne constituent pas un paiement.</p></section>

   {r.error&&<Warning>
    {r.error}</Warning>}
   {r.loading&&<p>Calcul des résultats…</p>}
   {d?.truncated&&<Warning>Certains tableaux dépassent leur limite d’affichage. Les totaux restent complets ; réduisez la sélection pour exporter tous les détails.</Warning>}

   {d&&<>
    <div className="metrics ops-metrics">
     <Stat
       label="Ventes"
       value={d.totals.tickets}
       note="Tickets valides"/>
     <Stat
       label="Chiffre d’affaires"
       value={money(d.totals.revenue)}
       note={d.totals.units+' unité(s) vendue(s)'}/>
     <Stat
       label="Primes calculées"
       value={money(d.totals.bonus)}
       note="50 DA par vente"/>
     <Stat
       label="Panier moyen"
       value={money(d.totals.tickets?Math.round(d.totals.revenue/d.totals.tickets):0)}
       note="Chiffre d’affaires / ventes"/></div>

    {tab==='bonus'?<>
     <section className="panel">
      <h2>La prime progresse à chaque vente</h2>
      <p>Cumul sur la période sélectionnée · {money(d.totals.bonus)}</p>
      <Trend
        days={d.days}
        value="bonus"
        cumulative/>
      <p className="subtle">Un ticket annulé retire sa prime de la date de l’animation concernée.</p></section>
     <section className="panel">
      <div className="section-head">
       <h2>Primes par animatrice</h2>
       <small>{from} → {to}</small></div>
      <RankTable rows={team} bonus/></section>

     {!person&&!store&&<section className="panel">
      <h2>
       {manager?'Historique mensuel de l’équipe':'Mon historique mensuel'}</h2>
      <p className="subtle">Historique global des 13 derniers mois, indépendant de la période sélectionnée ci-dessus. Mois sans vente : 0 DA.</p>
      {bonus.error&&<Warning>
       {bonus.error}</Warning>}
      <div className="table-wrap">
       <table>
        <thead>
         <tr>
          <th>Mois</th>
          <th>Ventes</th>
          <th>Prime calculée</th></tr></thead>
        <tbody>
         {(bonus.data?.months||[]).map((m:any)=><tr key={m.month}>
          <td>
          {m.month}</td>
          <td>
          {m.tickets}</td>
          <td>
          <b>
          {money(m.bonus)}</b></td></tr>)}</tbody></table></div>
      {bonus.data&&!bonus.data.months.length&&<p>Aucune prime enregistrée pour le moment.</p>}</section>}</>:
 <>
     <div className="stats-columns">
      <section className="panel">
       <div className="section-head">
        <h2>
         {manager?'Classement des animatrices':'Mes performances'}</h2>
        <label>Trier par<select value={rank} onChange={e=>setRank(e.target.value==='revenue'?'revenue':'tickets')}>
          <option value="tickets">Nombre de ventes</option>
          <option value="revenue">Chiffre d’affaires</option></select></label></div>
       <RankTable rows={team}/>
       <p className="subtle">Le classement porte sur la période et les pharmacies sélectionnées. Les retards sont comparés à la tolérance prévue.</p></section>
      <section className="panel">
       <h2>Ventes au fil des jours</h2>
       <Trend days={d.days} value="tickets"/>
       <div className="mini-metrics">
        <span><b>
          {d.people.reduce((n:number,p:any)=>n+(p.completed||0),0)}</b> animations terminées</span>
        <span><b>
          {d.people.reduce((n:number,p:any)=>n+(p.late||0),0)}</b> arrivées tardives</span></div></section></div>

     <section className="panel">
      <div className="section-head">
       <h2>Produits les plus vendus</h2>
       <div className="filters">
        <label>Produit<input
          type="search"
          value={productSearch}
          onChange={e=>setProductSearch(e.target.value)}
          placeholder="Rechercher…"/></label>
        <label>Marque<select value={brand} onChange={e=>setBrand(e.target.value)}>
          <option value="">Toutes</option>
          {Object.entries(BRANDS).map(([k,n])=><option key={k} value={k}>
          {n}</option>)}</select></label></div></div>
      <div className="table-wrap">
       <table>
        <thead>
         <tr>
          <th>Produit</th>
          <th>Marque</th>
          <th>Unités</th>
          <th>Ventes concernées</th>
          <th>CA</th></tr></thead>
        <tbody>
         {products.map((p:any)=><tr key={p.id+'-'+p.brand}>
          <td>
          <b>
          {p.name}</b></td>
          <td>
          {BRANDS[p.brand]}</td>
          <td>
          {p.units}</td>
          <td>
          {p.tickets}</td>
          <td>
          {money(p.revenue)}</td></tr>)}</tbody></table></div>
      {!products.length&&<p>Aucun produit vendu pour cette sélection.</p>}
      <p className="subtle">Un même ticket peut contenir plusieurs produits et marques : les ventes concernées ne s’additionnent pas entre ces lignes.</p></section>

     <div className="stats-columns">
      <section className="panel">
       <h2>Résultats par marque</h2>
       <div className="table-wrap">
        <table>
         <thead>
          <tr>
          <th>Marque</th>
          <th>Unités</th>
          <th>CA</th></tr></thead>
         <tbody>
          {d.brands.map((b:any)=><tr key={b.name}>
          <td>
          {BRANDS[b.name]}</td>
          <td>
          {b.units}</td>
          <td>
          {money(b.revenue)}</td></tr>)}</tbody></table></div>
       {!d.brands.length&&<p>Aucune vente sur cette période.</p>}</section>
      <section className="panel">
       <h2>Pharmacies les plus performantes</h2>
       <div className="table-wrap">
        <table>
         <thead>
          <tr>
          <th>Pharmacie</th>
          <th>Ventes</th>
          <th>CA</th></tr></thead>
         <tbody>
          {d.stores.map((s:any)=><tr key={s.id}>
          <td>
          {s.name}</td>
          <td>
          {s.tickets}</td>
          <td>
          {money(s.revenue)}</td></tr>)}</tbody></table></div>
       {!d.stores.length&&<p>Aucune pharmacie sur cette période.</p>}</section></div></>}</>}</>}</>

}

function RankTable({rows,bonus=false}:{rows:any[];bonus?:boolean}){
return rows.length?<div className="table-wrap">
  <table>
   <thead>
    <tr>
     <th>Animatrice</th>
     <th>Ventes</th>
     <th>
      {bonus?'Prime calculée':'CA'}</th>
     {!bonus&&<>
      <th>Prime</th>
      <th>Terminées / prévues</th>
      <th>Retards</th></>}</tr></thead>
   <tbody>
    {rows.map((p:any,i:number)=><tr key={p.id}>
     <td>
      <span className="rank-number">
       {i+1}</span>
      <b>
       {p.name}</b></td>
     <td>
      {p.tickets}</td>
     <td>
      {money(bonus?p.bonus:p.revenue)}</td>
     {!bonus&&<>
      <td>
       {money(p.bonus)}</td>
      <td>{p.completed||0} / {p.scheduled||0}</td>
      <td>
       {p.late||0}</td></>}</tr>)}</tbody></table></div>:<p>Aucune activité pour cette sélection.</p>
}

function Trend({days,value,cumulative=false}:{days:any[];value:string;cumulative?:boolean}){
let total=0;
const rows=days.map(d=>({...d,value:cumulative?(total+=d[value]):d[value]})),max=Math.max(1,...rows.map(r=>r.value));
return !rows.length?<div className="empty">
  <p>Les premières ventes feront apparaître la progression.</p></div>:<div
   className="trend"
   role="img"
   aria-label={cumulative?'Progression cumulée des primes':'Ventes quotidiennes'}>
  {rows.map((r:any)=><div className="trend-row" key={r.day}>
   <small>
    {r.day.slice(8)+'/'+r.day.slice(5,7)}</small>
   <div>
    <i style={{width:(r.value/max*100)+'%'}}/></div>
   <b>
    {value==='bonus'?money(r.value):r.value}</b></div>)}</div>
}
