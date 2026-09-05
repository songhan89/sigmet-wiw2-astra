import type { MultiPolygon } from 'geojson';
export type Level = {value:string; unit:string|null; reference:string|null} | null;
export type Condition = {
  geometry: MultiPolygon; anchor:[number,number]; upper:Level; lower:Level; vertical:string;
  intensity:string|null; motion:{bearing:number|null; speed:number|null; unit:string|null; stationary:boolean; label:string; stationarySource:string};
};
export type Sigmet = {
  id:string; source:string; sourceHash:string; issueTime:string; validFrom:string; validTo:string;
  rawValidTo:string; qualityNotes:string[]; sequence:string; firCode:string; fir:string; issuer:string;
  issuingATS:string; cancellation:boolean; hazardKey:string|null; hazardUri:string|null; hazard:string; description:string;
  tac:string; conditions:Condition[]; observation:string|null; phenomenonTime:string|null;
  bulletinTime:string; type:string; targetId:string|null; cancelledBy:string|null; cancelEffective:string|null;
};
export type Dataset = {schemaVersion:number; range:{start:string;end:string;stepMinutes:number}; summary:{reports:number;cancellations:number;sourceFiles:number;corrections:number}; records:Sigmet[]};
export const START = Date.parse('2026-05-01T00:00:00Z');
export const STEP = 30*60*1000;
export const LAST_STEP = 1487;
export const timeAt = (step:number) => START+Math.max(0,Math.min(LAST_STEP,Math.round(step)))*STEP;
export const stepAt = (timestamp:number) => Math.max(0,Math.min(LAST_STEP,Math.round((timestamp-START)/STEP)));
export const intensityLabel = (value:string|null) => ({INTENSIFY:'↑ Intensifying', NO_CHANGE:'= No change', WEAKEN:'↓ Weakening'}[value ?? ''] ?? 'Not reported');
export function replayState(records:Sigmet[], timestamp:number) {
  const active = records.filter(r=>!r.cancellation && Date.parse(r.issueTime)<=timestamp && Date.parse(r.validFrom)<=timestamp && timestamp<Date.parse(r.validTo)
    && (!r.cancelEffective || timestamp<Date.parse(r.cancelEffective)));
  const pairs = records.filter(r=>r.cancellation && r.cancelEffective && Date.parse(r.cancelEffective)<=timestamp)
    .flatMap(cancellation=>{
      const original=records.find(r=>r.id===cancellation.targetId);
      return original && timestamp<Date.parse(original.validTo) ? [{cancellation,original}] : [];
    });
  return {active,pairs};
}
export function destination(anchor:[number,number], bearing:number, nauticalMiles=45):[number,number] {
  const [lon,lat]=anchor.map(v=>v*Math.PI/180), b=bearing*Math.PI/180,d=nauticalMiles*1852/6371008.8;
  const y=Math.asin(Math.sin(lat)*Math.cos(d)+Math.cos(lat)*Math.sin(d)*Math.cos(b));
  const x=lon+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(lat),Math.cos(d)-Math.sin(lat)*Math.sin(y));
  return [x*180/Math.PI,y*180/Math.PI];
}
