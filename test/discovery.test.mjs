import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { defaultQueries, rankCandidates, candidateUrl, irrelevantReason } from '../backend/discovery.mjs';
import { html, resource } from './fixtures.mjs';

const projectInput={question:'Where are motor application gaps?',objectType:'company',objectName:'Domel',scope:{market:'industrial motors',period:'2026 Q3'}};
const publicPage=url=>resource(html(`Public motor specifications at ${url}. This source supports technical details, not independent market share.`.repeat(3)),url);
async function fixture(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),'sixi-discovery-'));let app,base;
 const start=async()=>{app=createApp({dataDir:dir,fetcher:{fetch:options.fetch|| (async url=>publicPage(url)),close(){}},discoveryOptions:{pollMs:5,...options}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;};
 await start();
 t.after(async()=>{await app.close();await rm(dir,{recursive:true});});
 const call=async(path,input)=>{const r=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});return {status:r.status,...await r.json()};};
 const project=(await call('/api/research/projects',projectInput)).project;
 return {call,project,path:`/api/research/projects/${project.id}`,get app(){return app;},get base(){return base;},async restart(){await app.close();await start();}};
}
async function eventually(fn){for(let i=0;i<100;i++){if(await fn())return;await delay(10);}assert.fail('Condition did not become true');}
const item=(url,title='Domel industrial motor product')=>({url,title,snippet:'Official product applications and industrial motor specifications.'});

test('rule queries cover the research scope, and URL selection deduplicates tracking while rejecting unsafe/file targets',()=>{
 const queries=defaultQueries(projectInput);assert.equal(queries.length,6);assert.ok(queries.some(q=>q.query.includes('Domel')));assert.ok(queries.some(q=>q.dimension==='competition'));assert.ok(queries.every(q=>q.query.length<=200));
 const deepQueries=defaultQueries(projectInput,{depth:'deep'});assert.ok(deepQueries.length>queries.length);assert.ok(deepQueries.length<=10);
 assert.equal(candidateUrl('https://example.com/a?utm_source=test&id=2#x'),'https://example.com/a?id=2');
 for(const url of ['http://127.0.0.1/test','https://10.0.0.1/','https://site.local/','file:///etc/passwd','https://example.com/report.pdf'])assert.throws(()=>candidateUrl(url));
 const candidates=[0,1,2,3].map(i=>({...item(`https://example.com/${i}`),rank:i}));candidates.push({...item('https://independent.example/report'),rank:5});
 const selected=rankCandidates(candidates,projectInput,8);assert.equal(selected.length,4);assert.ok(selected.some(i=>i.url.includes('independent')));
 const short={...item('https://longform.example/short'),rank:1,title:'Product update',snippet:'Motor product note.'};
 const long={...item('https://longform.example/report'),rank:4,title:'2026 Industrial Motor Market Outlook Report',snippet:'Long-form market analysis and outlook. '.repeat(30)};
 assert.equal(rankCandidates([short,long],projectInput,1,{maxPerDomain:5,preferLongform:true})[0].url,long.url);
 assert.ok(irrelevantReason({url:'https://lurexadomel-engine.com/zh/',title:'Lurexa Domel official website',snippet:'Trading education and financial market guides'},projectInput));
 assert.ok(irrelevantReason(item('https://www.similarweb.com/website/domel.com/competitors/'),projectInput));
 assert.equal(irrelevantReason({url:'https://www.domel.com/products',title:'Domel Products',snippet:'Product catalog'},projectInput),'');
});

test('deep discovery expands query coverage and supports a custom material count',async t=>{
 let searches=0;
 const f=await fixture(t,{search:async()=>{searches++;return {provider:'Fixture',items:Array.from({length:10},(_,index)=>item(`https://source-${searches}-${index}.example/report`,`Deep market source ${searches}-${index}`))};}});
 const started=await f.call(f.path+'/discover',{depth:'deep',maxSources:20,useAI:false});assert.equal(started.status,202);await f.app.discovery.running;await f.app.collector.running;
 const run=(await f.call(f.path)).discovery;assert.equal(run.status,'completed');assert.equal(run.depth,'deep');assert.equal(run.maxSources,20);assert.equal(run.queries.length,9);assert.equal(searches,9);assert.equal(run.candidates.length,90);assert.equal(run.selected.length,20);assert.equal(run.counts.completed,20);
});

test('a second discovery round skips the same collected URL without enqueueing another job',async t=>{
 const f=await fixture(t,{search:async()=>({provider:'Fixture',items:[item('https://source.example/repeated')]})});
 await f.call(f.path+'/discover',{depth:'standard',maxSources:1,useAI:false});await f.app.discovery.running;await f.app.collector.running;
 const firstJobs=f.app.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
 await f.call(f.path+'/discover',{depth:'standard',maxSources:1,useAI:false});await f.app.discovery.running;await f.app.collector.running;
 const detail=await f.call(f.path),run=detail.discovery;
 assert.equal(run.status,'completed');assert.equal(run.selected.length,0);assert.equal(run.reusedCount,1);assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,firstJobs);assert.equal(detail.documents.length,1);
});

test('automatic discovery continues after search/login failures, deduplicates sources, and groups human follow-up',async t=>{
 let searches=0,releaseFirst;const f=await fixture(t,{
   search:async()=>{searches++;if(searches===1){await new Promise(resolve=>{releaseFirst=resolve;});throw new Error('Search verification needed');}return {provider:'Fixture',items:[item('https://example.com/login'),item('https://example.com/public?utm_source=test'),item('https://example.com/public'),item('http://127.0.0.1/private'),item('https://example.com/catalog.pdf')]};},
   fetch:async url=>url.includes('/login')?resource('<html><title>Login</title><form><input type="password"></form></html>',url):publicPage(url),
 });
 const start=await f.call(f.path+'/discover',{maxSources:4,useAI:false});assert.equal(start.status,202);
 const second=await f.call(f.path+'/discover',{});assert.equal(second.discovery.id,start.discovery.id);assert.equal(second.discovery.reused,true);
 releaseFirst();
 await f.app.discovery.running;await f.app.collector.running;
 const detail=await f.call(f.path);assert.equal(detail.discovery.status,'partial');assert.equal(searches,6);
 assert.equal(detail.discovery.candidates.length,2);assert.equal(detail.discovery.counts.completed,1);assert.equal(detail.discovery.counts.failed,1);
 assert.equal(detail.documents.length,1);assert.equal(detail.handoffs.filter(t=>t.status==='open').length,1,'automatic failures are grouped into one actionable task');
 assert.match(detail.handoffs.find(t=>t.status==='open').reason,/\/login/);assert.match(detail.handoffs.find(t=>t.status==='open').reason,/catalog\.pdf/);
 assert.equal(detail.project.evidence.length,0,'collection never fabricates evidence or findings');
 await f.call(f.path+'/discover',{useAI:false});await f.app.discovery.running;
 const next=await f.call(f.path);assert.ok(next.discovery.reusedCount>=1);assert.equal(next.discovery.selected.some(s=>s.url.endsWith('/public')),false,'a completed URL is not collected again');assert.equal(next.handoffs.filter(t=>t.status==='open').length,1,'open human tasks do not duplicate');
});

test('invalid AI plans or invented candidate URLs fall back to rule search and selection',async t=>{
 let calls=0;const f=await fixture(t,{aiAvailable:async()=>true,ask:async()=>{calls++;return calls===1?'invalid JSON':JSON.stringify({items:[{url:'https://invented.example/',reason:'not offered'}]});},search:async()=>({provider:'Fixture',items:[item('https://source.example/product')]})});
 await f.call(f.path+'/discover',{});await f.app.discovery.running;
 const run=(await f.call(f.path)).discovery;assert.equal(run.status,'completed');assert.equal(run.planner,'rules');assert.equal(run.selector,'rules');assert.equal(run.warnings.length,2);assert.equal(run.selected[0].url,'https://source.example/product');
});

test('AI selects only supplied URLs and never gets existing private research content for planning',async t=>{
 let calls=0;const f=await fixture(t,{aiAvailable:async()=>true,ask:async input=>{
   calls++;assert.equal(input.context.some(c=>c.body.includes('PRIVATE EVIDENCE')),false);
   return calls===1?JSON.stringify({queries:[{query:'Domel motors',dimension:'structure'},{query:'motor demand',dimension:'demand'}]}):JSON.stringify({items:[{url:'https://source.example/product',reason:'Official product details to verify.'}]});
 },search:async()=>({provider:'Fixture',items:[item('https://source.example/product'),item('https://unselected.example/a')]})});
 await f.call(f.path+'/collect',{type:'text',title:'private',content:'PRIVATE EVIDENCE in existing research'});await f.app.collector.running;
 await f.call(f.path+'/discover',{});await f.app.discovery.running;
 const run=(await f.call(f.path)).discovery;assert.equal(run.planner,'ai');assert.equal(run.selector,'ai');assert.equal(run.selected.length,1);assert.equal(run.status,'completed');
});

test('discovery resumes interrupted searches after restart without repeating completed queries',async t=>{
 let block=true;const seen=[];
 const f=await fixture(t,{search:async(input,{signal})=>{seen.push(input.query);if(seen.length===2&&block){await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}));}return {provider:'Fixture',items:[item('https://source.example/resume')]};}});
 await f.call(f.path+'/discover',{useAI:false});await eventually(()=>seen.length===2);
 block=false;await f.restart();await f.app.discovery.running;
 const run=(await f.call(f.path)).discovery;assert.equal(run.status,'completed');assert.equal(seen.length,7);assert.equal(seen.filter(q=>q===seen[0]).length,1);assert.equal(run.queries.filter(q=>q.status==='completed').length,6);
});

test('scope changes stop stale search results before attaching sources; cancellation leaves collection usable',async t=>{
 let release;const f=await fixture(t,{search:async()=>{await new Promise(resolve=>{release=resolve;});return {provider:'Fixture',items:[item('https://source.example/stale')]};}});
 await f.call(f.path+'/discover',{useAI:false});await eventually(()=>Boolean(release));
 await f.call(f.path+'/edit',{...projectInput,question:'A different scope'});release();await f.app.discovery.running;
 let detail=await f.call(f.path);assert.equal(detail.discovery.status,'cancelled');assert.equal(detail.project.sourceIds.length,0);
 await f.call(f.path+'/discover',{useAI:false});await eventually(()=>f.app.discovery.latest(f.project.id).queries.some(q=>q.status==='running'));
 const cancelled=await f.call(f.path+'/discover/cancel',{});assert.equal(cancelled.discovery.status,'cancelled');release();await f.app.discovery.running;
 assert.equal((await f.call(f.path+'/collect',{type:'text',title:'Still usable',content:'Public manual material remains collectible.'})).status,202);await f.app.collector.running;
 detail=await f.call(f.path);assert.equal(detail.documents.length,1);
});

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=';
test('human handoffs store screenshot plus attributed text, enforce project ownership, and survive restart',async t=>{
 const f=await fixture(t,{search:async()=>({provider:'Fixture',items:[]})});
 const created=await f.call(f.path+'/handoffs',{title:'Verify a catalog',url:'https://example.com/catalog',reason:'Requires human login',assignee:'Researcher'});assert.equal(created.status,201);
 const id=created.task.id;
 const second=(await f.call('/api/research/projects',projectInput)).project;
 assert.equal((await f.call(`/api/research/projects/${second.id}/handoffs/${id}`,{action:'skip'})).status,404);
 assert.equal((await f.call(f.path+'/handoffs/'+id,{action:'complete',content:'Excerpt',screenshot:{base64:Buffer.from('<svg>not allowed</svg>').toString('base64')}})).status,400);
 const complete=await f.call(f.path+'/handoffs/'+id,{action:'complete',content:'Manufacturer states that the motor supports battery applications.',screenshot:{base64:png}});assert.equal(complete.status,200);
 await f.app.collector.running;
 const detail=await f.call(f.path);assert.equal(detail.handoffs[0].status,'completed');assert.equal(detail.documents.length,1);
 const doc=(await f.call('/api/documents/'+detail.documents[0].id)).document;assert.equal(doc.attachments.length,1);assert.match(doc.text,/Researcher/);assert.match(doc.text,/未执行 OCR/);assert.equal(doc.origins[0].url,'https://example.com/catalog');
 const image=await fetch(f.base+doc.attachments[0].url);assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),Buffer.from(png,'base64'));
 assert.equal((await f.call(f.path+'/handoffs/'+id,{action:'complete',content:'again'})).status,409);
 await f.restart();assert.equal((await f.call(f.path)).handoffs[0].hasScreenshot,true);assert.equal((await fetch(f.base+doc.attachments[0].url)).status,200);
});

test('human handoffs accept document attachments and keep the original in the library',async t=>{
 const f=await fixture(t,{search:async()=>({items:[]})});
 const created=await f.call(f.path+'/handoffs',{title:'Download the product brief',url:'https://example.com/brief',reason:'The public page requires a human download.'});
 const id=created.task.id;
 const original='# Product brief\n\nThe manufacturer describes an industrial motor application.';
 const completed=await f.call(f.path+'/handoffs/'+id,{action:'complete',parser:'local',attachment:{filename:'product-brief.md',base64:Buffer.from(original).toString('base64')},content:'Downloaded by a researcher.'});
 assert.equal(completed.status,200);assert.equal(completed.task.attachmentKind,'text');assert.equal(completed.task.attachmentFilename,'product-brief.md');
 await f.app.collector.running;
 const detail=await f.call(f.path);assert.equal(detail.documents.length,1);assert.ok(detail.project.sourceIds.includes(completed.task.sourceId));
 const doc=(await f.call('/api/documents/'+detail.documents[0].id)).document;assert.match(doc.text,/Product brief/);assert.equal(doc.attachments[0].kind,'text');
 const file=await fetch(f.base+doc.attachments[0].downloadUrl);assert.equal(file.status,200);assert.equal(await file.text(),original);
 await f.restart();const after=(await f.call(f.path)).handoffs[0];assert.equal(after.attachmentFilename,'product-brief.md');assert.equal((await fetch(f.base+doc.attachments[0].downloadUrl)).status,200);
});

test('image-only human handoff keeps the original asset without creating placeholder text',async t=>{
 const f=await fixture(t,{search:async()=>({items:[]})});
 const created=await f.call(f.path+'/handoffs',{title:'Capture gated page',url:'https://example.com/gated',reason:'The page needs a human session.'});
 const completed=await f.call(f.path+'/handoffs/'+created.task.id,{action:'complete',attachment:{filename:'gated.png',base64:png},attachToProject:true});
 assert.equal(completed.status,200);assert.equal(completed.task.attachedToProject,false);assert.equal(completed.task.attachmentKind,'image');
 assert.equal((await f.call(f.path)).documents.length,0,'an image without text is not a research document');
 const upload=(await f.call('/api/library/uploads')).items[0];assert.equal(upload.documentId,null);assert.equal(upload.hasText,false);
 assert.equal((await fetch(f.base+`/api/library/uploads/${upload.id}/image`)).status,200);
});

test('files and screenshots upload directly to the library with originals retained and no project attachment required',async t=>{
 const f=await fixture(t,{search:async()=>({items:[]})});
 const text='# Public source\n\nA manufacturer describes battery-powered applications.';
 const uploaded=await f.call('/api/library/uploads',{filename:'公开资料.md',base64:Buffer.from(text).toString('base64'),url:'https://example.com/spec'});
 assert.equal(uploaded.status,202);await f.app.collector.running;
 let library=await f.call('/api/documents');assert.equal(library.items.length,1);assert.equal((await f.call(f.path)).documents.length,0);
 const doc=(await f.call('/api/documents/'+library.items[0].id)).document;assert.equal(doc.text,text);assert.equal(doc.attachments[0].kind,'text');
 const original=await fetch(f.base+doc.attachments[0].downloadUrl);assert.equal(await original.text(),text);assert.match(original.headers.get('content-disposition'),/^attachment;/);
 const imageUpload=await f.call('/api/library/uploads',{filename:'capture.png',base64:png});assert.equal(imageUpload.status,202);assert.equal(imageUpload.upload.documentId,null);
 library=await f.call('/api/documents');assert.equal(library.items.length,1,'image-only uploads do not create a placeholder document');
 const uploads=await f.call('/api/library/uploads');const imageAsset=uploads.items.find(u=>u.id===imageUpload.upload.id);assert.equal(imageAsset.hasText,false);assert.equal(imageAsset.documentId,null);
 assert.equal((await f.call('/api/library/uploads',{filename:'invalid.png',base64:Buffer.from('<html>bad</html>').toString('base64')})).status,400);
 assert.equal((await f.call('/api/library/uploads',{})).status,400);
 const task=(await f.call(f.path+'/handoffs',{title:'Library only'})).task;
 await f.call(f.path+'/handoffs/'+task.id,{action:'complete',content:'Human research captured directly to library.',attachToProject:false});await f.app.collector.running;
 assert.equal((await f.call(f.path)).documents.length,0);assert.equal((await f.call('/api/documents')).items.length,2);
 await f.restart();assert.equal((await fetch(f.base+`/api/library/uploads/${imageUpload.upload.id}/image`)).status,200);assert.equal((await f.call('/api/documents')).items.length,2);
});
