import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {replayState,timeAt,stepAt,START,LAST_STEP,STEP,intensityLabel,destination} from '../lib/replay.ts';
const {records}=JSON.parse(readFileSync(new URL('../public/data/sigmets.json',import.meta.url),'utf8'));
test('full archive and 1,488 UTC positions',()=>{
 assert.equal(records.length,193);assert.equal(records.filter(r=>r.cancellation).length,16);
 assert.equal(new Date(timeAt(0)).toISOString(),'2026-05-01T00:00:00.000Z');
 assert.equal(new Date(timeAt(LAST_STEP)).toISOString(),'2026-05-31T23:30:00.000Z');
 for(let s=0;s<=LAST_STEP;s++)assert.equal(stepAt(timeAt(s)),s);
 assert.equal(replayState(records,START).active.length,0);
});
test('all real cancellation boundaries remove geometry but retain linked banner pairs',()=>{
 for(const c of records.filter(r=>r.cancellation)){
   const o=records.find(r=>r.id===c.targetId), effective=Date.parse(c.cancelEffective);
   assert.ok(o);assert.equal(o.cancelledBy,c.id);assert.equal(o.firCode,c.firCode);
   assert.ok(!replayState(records,effective-1).pairs.some(p=>p.cancellation.id===c.id));
   assert.ok(replayState(records,effective).pairs.some(p=>p.cancellation.id===c.id));
   assert.ok(!replayState(records,effective).active.some(r=>r.id===o.id));
   assert.ok(!replayState(records,Date.parse(o.validTo)).pairs.some(p=>p.cancellation.id===c.id));
 }
});
test('every frame has only issued, valid, uncancelled polygons and reversible state',()=>{
 for(let s=0;s<=LAST_STEP;s++){
  const at=timeAt(s),state=replayState(records,at);
  for(const r of state.active){assert.ok(Date.parse(r.issueTime)<=at);assert.ok(Date.parse(r.validFrom)<=at);assert.ok(at<Date.parse(r.validTo));assert.ok(!r.cancelEffective||at<Date.parse(r.cancelEffective));assert.ok(r.conditions.length>0)}
  for(const p of state.pairs){assert.ok(at>=Date.parse(p.cancellation.cancelEffective));assert.ok(at<Date.parse(p.original.validTo));assert.ok(!state.active.includes(p.original))}
  replayState(records,timeAt(LAST_STEP-s));assert.deepEqual(replayState(records,at),state);
 }
});
test('publication before validity; expiry and future cancellation do not leak',()=>{
 const base=records.find(r=>!r.cancellation&&!r.cancelEffective);
 const issue=Date.parse(base.issueTime),start=Date.parse(base.validFrom),end=Date.parse(base.validTo);
 assert.ok(!replayState([base],issue-1).active.length);
 assert.ok(!replayState([base],start-1).active.length);
 assert.equal(replayState([base],Math.max(issue,start)).active.length,1);
 assert.equal(replayState([base],end).active.length,0);
});
test('geographic motion uses sixteen compass bearings, not wind-from direction',()=>{
 const a=[105,4];assert.ok(destination(a,0)[1]>a[1]);assert.ok(destination(a,90)[0]>a[0]);assert.ok(destination(a,180)[1]<a[1]);assert.ok(destination(a,270)[0]<a[0]);
 const nne=destination(a,22.5),nnw=destination(a,337.5);
 assert.ok(nne[0]>a[0]&&nne[1]>a[1]);assert.ok(nnw[0]<a[0]&&nnw[1]>a[1]);
});
test('exact intensity text and month rollover are preserved',()=>{
 assert.equal(intensityLabel('NO_CHANGE'),'= No change');assert.equal(intensityLabel('INTENSIFY'),'↑ Intensifying');assert.equal(intensityLabel('WEAKEN'),'↓ Weakening');assert.equal(intensityLabel(null),'Not reported');
 const r=records.find(r=>r.qualityNotes.length);assert.equal(r.rawValidTo,'2026-05-01T02:45:00Z');assert.equal(r.validTo,'2026-06-01T02:45:00Z');
 assert.equal(replayState([r],Date.parse('2026-06-01T01:00:00Z')).active.length,1);
});

test('WMO code URIs resolve only to local assets and unknown codes fall back to text',async()=>{
 const {symbolAssets}=await import('../lib/symbols.ts');
 const {existsSync}=await import('node:fs');
 const codes=['OBSC_TS','EMBD_TS','FRQ_TS','SQL_TS','OBSC_TSGR','EMBD_TSGR','FRQ_TSGR','SQL_TSGR','TC','SEV_TURB','SEV_ICE','SEV_ICE_FZRA','SEV_MTW','HVY_DS','HVY_SS','VA','RDOACT_CLD'];
 for(const code of codes){const assets=symbolAssets(`http://codes.wmo.int/49-2/SigWxPhenomena/${code}`);assert.ok(assets.length);for(const file of assets)assert.ok(existsSync(new URL('../public'+file,import.meta.url)))}
 assert.deepEqual(symbolAssets('https://codes.wmo.int/49-2/SigWxPhenomena/UNKNOWN'),[]);
 assert.deepEqual(symbolAssets('https://example.com/49-2/SigWxPhenomena/EMBD_TS'),[]);
 assert.deepEqual(symbolAssets(null),[]);
 assert.deepEqual(symbolAssets('https://codes.wmo.int/49-2/SigWxPhenomena/EMBD_TS'),symbolAssets('http://codes.wmo.int/49-2/SigWxPhenomena/EMBD_TS'));
});
