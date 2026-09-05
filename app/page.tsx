'use client';
import Image from 'next/image';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { Map as GLMap, Popup, Marker, GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection, Geometry } from 'geojson';
import { symbolAssets } from '@/lib/symbols';
import { assetPath } from '@/lib/base-path';
import { Slider } from '@/components/ui/slider';
import { destination, intensityLabel, LAST_STEP, replayState, stepAt, timeAt, type Dataset, type Sigmet } from '@/lib/replay';
import 'maplibre-gl/dist/maplibre-gl.css';

const EMPTY_RECORDS:Sigmet[]=[];
const clock=(value:string|number)=>new Date(value).toLocaleString('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false});
const shortClock=(value:string)=>new Date(value).toLocaleTimeString('en-GB',{timeZone:'UTC',hour:'2-digit',minute:'2-digit',hour12:false});
const color=(r:Sigmet)=>r.hazardKey==='SEV_ICE'?'#276bd3':'#d35c22';
const bounds:[number,number,number,number]=[98,-2,119,12];
type Selection={ids:string[]; id:string; anchor:[number,number]};

function HazardSymbol({uri}:{uri:string|null|undefined}) {
  return <span className="hazard-symbol" aria-hidden="true">{symbolAssets(uri).map(src=><Image unoptimized key={src} src={src} alt="" width={30} height={30} onError={e=>{e.currentTarget.style.display='none'}}/>)}</span>;
}
function Intensity({value}:{value:string|null}) {return <span className={`intensity intensity-${value ?? 'missing'}`}>{intensityLabel(value)}</span>}
function Details({report,original}:{report:Sigmet;original?:Sigmet}) {
  const [copied,setCopied]=useState<string|null>(null);
  const copy=async()=>{try{await navigator.clipboard.writeText(report.tac);setCopied(report.id)}catch{setCopied(null)}};
  return <div className="report-details">
    <div className="eyebrow">{report.cancellation?'Cancellation message':'Original alphanumeric message'}<button onClick={copy} className="copy-button">{copied===report.id?'Copied':'Copy TAC'}</button></div>
    <pre className="tac-block">{report.tac}</pre>
    <div className="eyebrow detail-heading">Decoded elements</div>
    <dl className="decoded-grid">
      <div><dt>Phenomenon</dt><dd>{report.description}{report.hazardUri&&<a className="wmo-link" href={report.hazardUri.replace("http:","https:")} target="_blank" rel="noreferrer">WMO code definition ↗</a>}</dd></div><div><dt>Affected FIR</dt><dd>{report.fir} ({report.firCode})</dd></div>
      <div><dt>Issuing office</dt><dd>{report.issuer}</dd></div><div><dt>Issued · UTC</dt><dd>{clock(report.issueTime)}</dd></div>
      <div className="span-two"><dt>Validity · UTC</dt><dd>{clock(report.validFrom)} — {clock(report.validTo)}</dd></div>
      {!report.cancellation&&<><div><dt>Reported as</dt><dd>{report.observation==='OBSERVATION'?'Observed':report.observation==='FORECAST'?'Forecast':report.observation ?? 'Not reported'}</dd></div>
      <div><dt>Observation / forecast time · UTC</dt><dd>{report.phenomenonTime?clock(report.phenomenonTime):'Not reported'}</dd></div></>}
    </dl>
    {report.conditions.map((c,index)=><div className="condition-details" key={index}>
      {report.conditions.length>1&&<strong>Area {index+1}</strong>}
      <dl className="decoded-grid"><div><dt>Vertical extent</dt><dd>{c.vertical}</dd></div><div><dt>Movement</dt><dd>{c.motion.label}{c.motion.bearing!==null&&<small> Bearing {c.motion.bearing}°</small>}</dd></div><div className="span-two"><dt>Intensity trend</dt><dd><Intensity value={c.intensity}/></dd></div></dl>
      <details><summary>Polygon coordinates · longitude, latitude</summary><pre className="coordinate-block">{c.geometry.coordinates.map((p,i)=>`Polygon ${i+1}\n`+p.map((ring,j)=>`${j?'Interior':'Exterior'}\n`+ring.map(([x,y])=>`${x.toFixed(2)}, ${y.toFixed(2)}`).join('\n')).join('\n')).join('\n')}</pre></details>
    </div>)}
    {report.qualityNotes.map(note=><p className="quality-note" key={note}>{note}</p>)}
    <p className="source-note">Source: {report.id}</p>
    {original&&<section className="cancelled-original"><div className="eyebrow">Cancelled original · {original.sequence}</div><h3>{original.hazard} <span>Cancelled</span></h3><Details report={original}/></section>}
  </div>
}

export default function Page() {
  const [data,setData]=useState<Dataset|null>(null),[error,setError]=useState('');
  const [step,setStep]=useState(0),[playing,setPlaying]=useState(false),[ready,setReady]=useState(false),[mapError,setMapError]=useState(process.env.NEXT_PUBLIC_MAPTILER_KEY?'':'MapTiler key is missing. Configure MAPTILER_API in .env and restart the local server.');
  const [requestedSelection,setSelection]=useState<Selection|null>(null),[popupHost,setPopupHost]=useState<HTMLElement|null>(null);
  const mapRef=useRef<GLMap|null>(null), container=useRef<HTMLDivElement>(null),popupRef=useRef<Popup|null>(null),markers=useRef<Marker[]>([]);
  const current=useRef<{records:Sigmet[];step:number}>({records:[],step:0});
  const records=data?.records ?? EMPTY_RECORDS;
  useEffect(()=>{current.current={records,step}},[records,step]);
  const timestamp=timeAt(step);
  const state=useMemo(()=>replayState(records,timestamp),[records,timestamp]);
  const selection=requestedSelection && (state.active.some(r=>r.id===requestedSelection.id)||state.pairs.some(p=>p.cancellation.id===requestedSelection.id)) ? requestedSelection : null;
  const selected=records.find(r=>r.id===selection?.id);
  const cancelledOriginal=selected?.cancellation?records.find(r=>r.id===selected.targetId):undefined;
  useEffect(()=>{const controller=new AbortController();fetch(assetPath('/data/sigmets.json'),{signal:controller.signal}).then(r=>{if(!r.ok)throw Error('The replay archive could not be loaded. Run the data pipeline and reload.');return r.json() as Promise<Dataset>}).then(setData).catch(e=>{if(e.name!=='AbortError')setError(e.message)});return()=>controller.abort()},[]);
  useEffect(()=>{
    const context=(document as unknown as {modelContext?:{registerTool:(tool:object,options:{signal:AbortSignal})=>void|Promise<void>}}).modelContext;
    if(!context?.registerTool)return;
    const lifecycle=new AbortController();
    try { void Promise.resolve(context.registerTool({
      name:'set_sigmet_replay_time',title:'Set SIGMET replay time',
      description:'Pause playback and seek the visible SIGMET map and banners to a 30-minute UTC position in May 2026.',
      inputSchema:{type:'object',properties:{time:{type:'string',description:'UTC ISO timestamp on a 00 or 30 minute boundary'}},required:['time'],additionalProperties:false},
      annotations:{readOnlyHint:false,untrustedContentHint:false},
      execute:(input:unknown)=>{
        if(!input||typeof input!=='object'||!('time' in input)||typeof input.time!=='string'||!input.time.endsWith('Z'))throw Error('Provide a UTC ISO time ending in Z.');
        const at=Date.parse(input.time);
        if(!Number.isFinite(at)||at<timeAt(0)||at>timeAt(LAST_STEP)||at!==timeAt(stepAt(at)))throw Error('Time must be a 30-minute position within May 2026.');
        flushSync(()=>{setPlaying(false);setStep(stepAt(at))});
        const frame=replayState(current.current.records,at);
        return {time:new Date(at).toISOString(),active:frame.active.map(r=>({id:r.id,hazard:r.hazard,sequence:r.sequence})),cancellations:frame.pairs.length};
      }
    },{signal:lifecycle.signal})).catch(()=>{}); } catch { /* Optional proposed browser API. */ }
    return()=>lifecycle.abort();
  },[]);
  useEffect(()=>{if(!playing)return;const id=window.setInterval(()=>setStep(s=>{if(s>=LAST_STEP){setPlaying(false);return LAST_STEP}return s+1}),1000);return()=>clearInterval(id)},[playing]);
  useEffect(()=>{
    let disposed=false;
    const key=process.env.NEXT_PUBLIC_MAPTILER_KEY;
    if(!key)return;
    void import('maplibre-gl').then(gl=>{
      if(disposed||!container.current)return;
      gl.setWorkerUrl(assetPath('/maplibre/maplibre-gl-worker.mjs'));
      const map=new gl.Map({container:container.current,style:`https://api.maptiler.com/maps/dataviz-light/style.json?key=${encodeURIComponent(key)}`,
        bounds,fitBoundsOptions:{padding:40},dragRotate:false,pitchWithRotate:false,attributionControl:{compact:true}});
      mapRef.current=map;
      map.addControl(new gl.NavigationControl({showCompass:false}),'top-right');map.addControl(new gl.ScaleControl(),'bottom-left');
      map.on('error',()=>setMapError('Some map tiles could not load. Check the connection and MapTiler key; warning banners remain available.'));
      map.on('load',()=>{
        if(disposed)return;
        map.addSource('hazards',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
        map.addLayer({id:'hazard-fill',type:'fill',source:'hazards',paint:{'fill-color':['get','color'],'fill-opacity':.16}});
        map.addLayer({id:'hazard-outline',type:'line',source:'hazards',paint:{'line-color':['get','color'],'line-width':2}});
        map.addLayer({id:'hazard-selected',type:'line',source:'hazards',filter:['==',['get','id'],''],paint:{'line-color':'#133b56','line-width':4}});
        map.addSource('motion',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
        map.addLayer({id:'motion-line',type:'line',source:'motion',paint:{'line-color':'#096b64','line-width':2.5}});
        map.on('mouseenter','hazard-fill',()=>{map.getCanvas().style.cursor='pointer'});map.on('mouseleave','hazard-fill',()=>{map.getCanvas().style.cursor=''});
        map.on('click','hazard-fill',e=>{
          const ids=[...new Set((e.features??[]).map(f=>String(f.properties?.id)))];
          if(ids.length)setSelection({ids,id:ids[0],anchor:[e.lngLat.lng,e.lngLat.lat]});
        });setReady(true);
      });
    }).catch(()=>setMapError('The interactive map could not start. Your browser needs WebGL support.'));
    return()=>{disposed=true;mapRef.current?.remove();mapRef.current=null};
  },[]);
  useEffect(()=>{
    if(!ready||!mapRef.current)return;
    const map=mapRef.current;let disposed=false;
    const features:FeatureCollection={type:'FeatureCollection',features:state.active.flatMap(r=>r.conditions.map(c=>({type:'Feature' as const,geometry:c.geometry,properties:{id:r.id,color:color(r)}})))};
    void (map.getSource('hazards') as GeoJSONSource).setData(features);
    const lines:FeatureCollection<Geometry>={type:'FeatureCollection',features:[]};
    markers.current.forEach(m=>m.remove());markers.current=[];
    void import('maplibre-gl').then(gl=>{
      if(disposed)return;
      for(const r of state.active)for(const c of r.conditions){
        const tag=document.createElement('button');tag.type='button';tag.className='map-label';tag.style.setProperty('--hazard-color',color(r));tag.setAttribute('aria-label',`View ${r.hazard} SIGMET ${r.sequence}, ${r.fir}`);
        const iconGroup=document.createElement('span');iconGroup.className='map-symbols';
        for(const src of symbolAssets(r.hazardUri)){
          const icon=document.createElement('img');icon.src=src;icon.alt='';icon.width=18;icon.height=18;
          icon.onerror=()=>{icon.style.display='none'};iconGroup.appendChild(icon);
        }
        tag.appendChild(iconGroup);
        const code=document.createElement('strong');code.textContent=`${r.hazard} · ${r.sequence}`;tag.appendChild(code);
        tag.title=`${r.hazard} · ${r.sequence} · ${c.vertical} — click for details`;
        tag.onclick=e=>{e.stopPropagation();setSelection({ids:[r.id],id:r.id,anchor:c.anchor})};
        markers.current.push(new gl.Marker({element:tag,anchor:'bottom'}).setLngLat(c.anchor).addTo(map));
        const speed=document.createElement('span');speed.className='motion-label';speed.textContent=c.motion.label;
        const start:[number,number]=[c.anchor[0],c.anchor[1]-.3];
        markers.current.push(new gl.Marker({element:speed,anchor:'top',offset:[0,4]}).setLngLat(start).addTo(map));
        if(!c.motion.stationary&&c.motion.bearing!==null){
          const end=destination(start,c.motion.bearing);
          lines.features.push({type:'Feature',geometry:{type:'LineString',coordinates:[start,end]},properties:{}});
          const head=document.createElement('span');head.className='motion-head';head.textContent='▲';head.setAttribute('aria-hidden','true');
          markers.current.push(new gl.Marker({element:head,rotation:c.motion.bearing,rotationAlignment:'map'}).setLngLat(end).addTo(map));
        }
      }
      void (map.getSource('motion') as GeoJSONSource).setData(lines);
    });
    return()=>{disposed=true};
  },[ready,state]);
  useEffect(()=>{
    if(!ready||!mapRef.current)return;
    const map=mapRef.current;
    map.setFilter('hazard-selected',['==',['get','id'],selection?.id??'']);
    if(!selection){popupRef.current?.remove();popupRef.current=null;return}
    let disposed=false;
    void import('maplibre-gl').then(gl=>{
      if(disposed)return;
      const host=document.createElement('div');host.className='popup-inner';host.setAttribute('role','dialog');host.setAttribute('aria-label','SIGMET details');
      const popup=new gl.Popup({closeButton:false,closeOnClick:false,maxWidth:'460px',offset:16,className:'sigmet-popup',focusAfterOpen:false}).setLngLat(selection.anchor).setDOMContent(host).addTo(map);
      popupRef.current=popup;setPopupHost(host);host.tabIndex=-1;host.focus({preventScroll:true});
    });
    const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')setSelection(null)};window.addEventListener('keydown',onKey);
    return()=>{disposed=true;popupRef.current?.remove();popupRef.current=null;window.removeEventListener('keydown',onKey)};
  },[selection,ready]);
  const seek=(n:number)=>{setStep(Math.max(0,Math.min(LAST_STEP,n)));setPlaying(false)};
  const openReport=(r:Sigmet)=>{
    const target=r.cancellation?records.find(x=>x.id===r.targetId):r;
    const anchor=target?.conditions[0]?.anchor ?? [107,4];
    setSelection({ids:[r.id],id:r.id,anchor:anchor as [number,number]});
    mapRef.current?.easeTo({center:anchor as [number,number],duration:450});
  };
  const fit=()=>{
    const coords=state.active.flatMap(r=>r.conditions.flatMap(c=>c.geometry.coordinates.flat(2)));
    if(!coords.length){mapRef.current?.fitBounds(bounds,{padding:40});return}
    const xs=coords.map(p=>p[0]),ys=coords.map(p=>p[1]);
    mapRef.current?.fitBounds([Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)],{padding:95,maxZoom:7,duration:500});
  };
  return <main>
    <header className="masthead"><div className="wordmark"><span className="brand-mark">S</span><div><h1>SIGMET <span>/ archive replay</span></h1><p>Singapore & Jakarta FIRs · May 2026</p></div></div><div className="mode-label"><span className="status-dot"/>Historical proof of concept</div></header>
    <section className="warning-section" aria-label="SIGMET warning banners">
      <div className="section-heading"><div><span className="eyebrow">Warning banner</span><h2>{state.active.length} active <span>at {clock(timestamp)} UTC</span></h2></div><span className="archive-count">{data?`${data.summary.reports} reports · ${data.summary.cancellations} cancellations`:'Loading archive…'}</span></div>
      {error&&<div className="error-message" role="alert">{error}</div>}
      {!error&&data&&state.active.length===0&&state.pairs.length===0&&<div className="empty-banner"><span className="empty-mark">—</span><div><strong>No active SIGMET in the supplied archive at this time</strong><p>Step through May to see warnings as they become valid.</p></div></div>}
      <div className="banner-stack">{state.active.map(r=><button className={`warning-banner ${r.hazardKey==='SEV_ICE'?'icing':''} ${selection?.id===r.id?'selected':''}`} key={r.id} onClick={()=>openReport(r)}>
        <div className="banner-top"><HazardSymbol uri={r.hazardUri}/><strong className="hazard-code">{r.hazard}</strong><span className="sequence">{r.sequence}</span><span>{r.firCode} · {r.fir}</span><span className="valid-time">{shortClock(r.validFrom)}–{shortClock(r.validTo)} UTC</span><Intensity value={r.conditions[0]?.intensity??null}/><span className="open-hint">View ↗</span></div>
        <p className="banner-tac">{r.tac}</p></button>)}
        {state.pairs.map(({cancellation:c,original:o})=><div className="cancellation-pair" key={c.id}>
          <button className="warning-banner cancellation" onClick={()=>openReport(c)}><div className="banner-top"><strong className="hazard-code">CNL SIGMET</strong><span className="sequence">{c.sequence}</span><span>Cancels {o.sequence} · {o.firCode}</span><span className="valid-time">Since {shortClock(c.cancelEffective!)} UTC</span><span className="open-hint">View pair ↗</span></div><p className="banner-tac">{c.tac}</p></button>
          <button className="warning-banner cancelled" onClick={()=>openReport(c)}><div className="banner-top"><HazardSymbol uri={o.hazardUri}/><strong className="hazard-code">{o.hazard}</strong><span className="sequence">{o.sequence}</span><span className="cancelled-badge">Cancelled</span><span>Original warning · removed from map</span><span className="valid-time">Retained until {clock(o.validTo)} UTC</span></div><p className="banner-tac">{o.tac}</p></button>
        </div>)}
      </div>
    </section>
    <section className="map-section" aria-label="Active SIGMET map">
      <div className="map-toolbar"><div><span className="map-status-dot"/><strong>Reported hazard areas</strong><span className="toolbar-note">Click a polygon or label to inspect</span></div><button onClick={fit}>Fit active areas</button></div>
      <div className="map-shell"><div ref={container} className="map-canvas"/>{mapError&&<div className="map-error" role="alert">{mapError}</div>}
        <div className="map-legend"><span><i className="legend-area"/>Active hazard</span><span><b className="legend-arrow">↗</b>Reported motion · schematic arrow</span><span>Cancelled areas are removed</span></div>
      </div>
    </section>
    <section className="time-player" aria-label="May 2026 time player">
      <div className="player-top"><div className="play-buttons"><button aria-label="Previous 30 minutes" disabled={step===0} onClick={()=>seek(step-1)}>‹</button><button className="play-button" disabled={step===LAST_STEP&&!playing} onClick={()=>setPlaying(!playing)}>{playing?'Ⅱ Pause':'▶ Play'}</button><button aria-label="Next 30 minutes" disabled={step===LAST_STEP} onClick={()=>seek(step+1)}>›</button></div>
        <div className="replay-clock"><span className="eyebrow">Replay time · UTC</span><strong>{clock(timestamp)} <span>2026</span></strong></div>
        <label className="date-control">Jump to UTC<input aria-label="Replay date and time UTC" type="datetime-local" min="2026-05-01T00:00" max="2026-05-31T23:30" step={1800} value={new Date(timestamp).toISOString().slice(0,16)} onChange={e=>{if(e.target.value){const v=Date.parse(e.target.value+'Z');if(Number.isFinite(v))seek(stepAt(v))}}}/></label>
        <span className="interval-note">30 min / step</span></div>
      <div className="timeline"><Slider aria-label="May replay timeline" min={0} max={LAST_STEP} step={1} value={[step]} onValueChange={value=>seek(Array.isArray(value)?value[0]:value)}/><div className="timeline-dates"><span>01 MAY</span><span>08 MAY</span><span>15 MAY</span><span>22 MAY</span><span>31 MAY</span></div></div>
    </section>
    <footer>Supplied archive only · Geometry stays at its reported position · All times UTC <span>Source: IWXXM 2023-1 / embedded TAC · <a href="https://github.com/OGCMetOceanDWG/WorldWeatherSymbols" target="_blank" rel="noreferrer">Symbols: OGC MetOcean DWG</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a></span></footer>
    {popupHost&&selected&&createPortal(<><div className="popup-header"><div><span className="eyebrow">{selected.firCode} · SIGMET {selected.sequence}</span><h2><HazardSymbol uri={selected.hazardUri}/>{selected.hazard}</h2></div><button aria-label="Close SIGMET popup" className="popup-close" onClick={()=>setSelection(null)}>×</button></div>
      {selection&&selection.ids.length>1&&<div className="overlap-picker"><span>Overlapping warnings</span>{selection.ids.map(id=>{const r=records.find(r=>r.id===id);return r&&<button key={id} aria-pressed={id===selected.id} onClick={()=>setSelection({...selection,id})}>{r.hazard} {r.sequence}</button>})}</div>}
      <Details report={selected} original={cancelledOriginal}/></>,popupHost)}
  </main>
}
