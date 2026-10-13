import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { html, resource } from './fixtures.mjs';

async function fixture(t, ask) {
 const dir=await mkdtemp(join(tmpdir(),'sixi-research-'));
 let app;let base;
 const start=async()=>{
  app=createApp({dataDir:dir,ask,fetcher:{fetch:async url=>resource(html(),url),close(){}}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;
 };
 await start();
 t.after(async()=>{await app.close();await rm(dir,{recursive:true});});
 const call=async(path,body)=>{
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,...await r.json()};
 };
 const p=(await call('/api/research/projects',{question:'What changed?',objectType:'company',objectName:'Example'})).project;
 const endpoint=`/api/research/projects/${p.id}`;
 return {call,p,endpoint,app,base,async restart(){await app.close();await start();}};
}
const quote='The company introduced an efficient electric motor in 2026.';
async function seed(f) {
 const queued=await f.call(f.endpoint+'/collect',{type:'text',title:'Public specifications',content:quote+' Public specifications do not establish competitive superiority.'});
 assert.equal(queued.status,202);await f.app.collector.running;
 const detail=await f.call(f.endpoint);return detail.documents[0];
}
test('research workflow persists evidence, reviews and cited report; report excludes draft/rejected findings',async t=>{
 const f=await fixture(t);const doc=await seed(f);
 assert.equal((await f.call(f.endpoint+'/report')).status,400);
 const invalid=await f.call(f.endpoint+'/evidence',{documentId:doc.id,quote:'This is invented'});
 assert.equal(invalid.code,'UNGROUNDED_EVIDENCE');
 let p=(await f.call(f.endpoint+'/evidence',{documentId:doc.id,quote,note:'Product fact, not a market claim'})).project;
 const id=p.evidence[0].id;
 assert.equal(p.evidence[0].verified,true);
 assert.ok(p.evidence[0].origins[0].fetchedAt);
 assert.equal((await f.call(f.endpoint+'/findings',{title:'No citation',body:'Bad',category:'trend',evidenceIds:['missing']})).status,400);
 for(const title of ['Kept fact','Rejected claim','Unreviewed claim','Open question']) p=(await f.call(f.endpoint+'/findings',{title,body:'Bounded interpretation.',category:'trend',evidenceIds:[id]})).project;
 for(const [i,status] of ['keep','reject','draft','investigate'].entries())await f.call(f.endpoint+'/review/'+p.findings[i].id,{status,note:status==='investigate'?'Need independent evidence':''});
 const report=await f.call(f.endpoint+'/report');
 assert.match(report.markdown,/Kept fact/);assert.match(report.markdown,/Public specifications/);assert.match(report.markdown,/Need independent evidence/);
 assert.doesNotMatch(report.markdown,/Rejected claim|Unreviewed claim/);
 assert.equal((await f.call(f.endpoint+'/evidence/'+id,{action:'remove'})).status,400);
 await f.restart();p=(await f.call(f.endpoint)).project;
 assert.deepEqual(p.findings.map(f=>f.status),['keep','reject','draft','investigate']);assert.equal(p.evidence[0].quote,quote);
 await f.call(f.endpoint+'/edit',{question:'A new research scope',objectType:'product',objectName:'New product'});
 assert.equal((await f.call(f.endpoint+'/report')).status,400);
 assert.ok((await f.call(f.endpoint)).project.findings.every(f=>f.status==='draft'));
});

test('AI candidates are grounded, limited to supplied documents/evidence, and require human confirmation',async t=>{
 let answer='';const f=await fixture(t,async()=>answer);const doc=await seed(f);
 answer=JSON.stringify({items:[{documentId:doc.id,quote,note:'Valid'}, {documentId:doc.id,quote:'Fabricated quote'}, {documentId:'not-supplied',quote}]});
 const generated=await f.call(f.endpoint+'/generate',{mode:'evidence',documentId:doc.id});
 assert.equal(generated.added,1);assert.equal(generated.skipped,2);
 const e=generated.project.evidence[0];assert.equal(e.verified,false);
 assert.equal((await f.call(f.endpoint+'/findings',{title:'x',body:'x',category:'trend',evidenceIds:[e.id]})).status,400);
 await f.call(f.endpoint+'/evidence/'+e.id,{action:'confirm'});
 answer=JSON.stringify({items:[{title:'Valid finding',body:'With uncertainty',category:'opportunity',implication:'This matters for Domel planning.',recommendation:'Product strategy should validate it this quarter with one customer metric.',evidenceIds:[e.id]},{title:'Invalid',body:'False',category:'trend',evidenceIds:['invented']}]});
 const result=await f.call(f.endpoint+'/generate',{mode:'findings'});assert.equal(result.added,1);assert.equal(result.skipped,1);assert.equal(result.project.findings[0].status,'draft');
 assert.equal((await f.call(f.endpoint+'/report')).status,400);
 answer='{"items":[]}';assert.equal((await f.call(f.endpoint+'/generate',{mode:'findings'})).status,422);
 answer='broken JSON';assert.equal((await f.call(f.endpoint+'/generate',{mode:'findings'})).status,422);
 assert.equal((await f.call(f.endpoint)).project.findings.length,1);
});

test('existing sources can be attached; unrelated sources cannot silently supply evidence; invalid input does not block later collection',async t=>{
 const f=await fixture(t);const doc=await seed(f);
 const second=(await f.call('/api/research/projects',{question:'Other question',objectType:'industry',objectName:'Other'})).project;
 const secondPath=`/api/research/projects/${second.id}`;
 assert.equal((await f.call(secondPath+'/evidence',{documentId:doc.id,quote})).status,400);
 await f.call(secondPath+'/attach',{documentIds:[doc.id]});
 assert.equal((await f.call(secondPath+'/evidence',{documentId:doc.id,quote})).status,201);
 assert.equal((await f.call(f.endpoint+'/collect',{type:'url',url:'https://example.com/private',sessionId:'missing'})).status,409);
 const publicJob=await f.call(f.endpoint+'/collect',{type:'url',url:'https://example.com/public'});
 assert.equal(publicJob.status,202);await f.app.collector.running;
 assert.equal((await f.call('/api/collections/'+publicJob.job.id)).job.status,'succeeded');
 for(const asset of ['/','/app.js','/styles.css','/frontend/core.js','/frontend/views.js','/frontend/market.js','/frontend/auth.js']) {
  const response=await fetch(f.base+asset);assert.equal(response.status,200,asset);assert.ok((await response.text()).length>100);
 }
});

test('one-click batch collection reuses queued or completed sources and attaches them to the project', async t => {
 const f=await fixture(t);
 const batch=await f.call(f.endpoint+'/collect-all',{items:[
   {type:'url',url:'https://example.com/batch'},
   {type:'url',url:'https://www.example.com/batch/?utm_source=duplicate'},
 ]});
 assert.equal(batch.status,202);
 assert.equal(batch.accepted,2);
 assert.equal(batch.reused,1);
 await f.app.collector.running;
 const detail=await f.call(f.endpoint);
 assert.equal(detail.documents.length,1);
 const jobs=await f.call('/api/collections?limit=20');
 assert.equal(jobs.total,1);
 const repeat=await f.call(f.endpoint+'/collect-all',{items:[{type:'url',url:'https://example.com/batch'}]});
 assert.equal(repeat.status,202);
 assert.equal(repeat.reused,1);
 assert.equal((await f.call('/api/collections?limit=20')).total,1,'a completed source is reused instead of creating a second job');
});

function tinyPDF() {
 // A deterministic valid PDF fixture with real font/text operators, not a parser mock.
 const stream='BT /F1 16 Tf 50 200 Td (A public research document with traceable evidence.) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let text='%PDF-1.4\n';const offsets=[0];objects.forEach((value,i)=>{offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${value}\nendobj\n`;});
 const xref=Buffer.byteLength(text);text+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(o=>`${String(o).padStart(10,'0')} 00000 n \n`).join('');text+=`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
 return Buffer.from(text).toString('base64');
}
test('PDF upload extracts actual page text into the existing collector and rejects invalid files',async t=>{
 const f=await fixture(t);
 assert.equal((await f.call(f.endpoint+'/pdf',{title:'Bad',base64:Buffer.from('Not a PDF').toString('base64')})).status,400);
 const imported=await f.call(f.endpoint+'/pdf',{title:'Sample.pdf',base64:tinyPDF()});assert.equal(imported.status,202);
 await f.app.collector.running;
 const docs=(await f.call(f.endpoint)).documents;assert.equal(docs.length,1);
 const detail=(await f.call('/api/documents/'+docs[0].id)).document;
 assert.match(detail.text,/PDF 第 1 页/);assert.match(detail.text,/A public research document with traceable evidence/);
});

test('optional review includes explicitly labelled drafts, never includes rejected findings, and never marks drafts Keep',async t=>{
 const f=await fixture(t);const doc=await seed(f);
 let p=(await f.call(f.endpoint+'/evidence',{documentId:doc.id,quote})).project;
 for(const title of ['Draft to include','Rejected to exclude'])p=(await f.call(f.endpoint+'/findings',{title,body:'Evidence-based draft',category:'competitor',evidenceIds:[p.evidence[0].id]})).project;
 await f.call(f.endpoint+'/review/'+p.findings[1].id,{status:'reject'});
 assert.equal((await f.call(f.endpoint+'/report')).status,400);
 const report=await f.call(f.endpoint+'/report?skipReview=true');
 assert.equal(report.status,200);assert.equal(report.includesUnreviewed,true);assert.equal(report.findings.length,1);
 assert.match(report.markdown,/Draft to include（未人工审核）/);assert.doesNotMatch(report.markdown,/Rejected to exclude/);
 assert.equal((await f.call(f.endpoint)).project.findings[0].status,'draft');
 await f.call(f.endpoint+'/review/'+p.findings[0].id,{status:'keep'});
 assert.equal((await f.call(f.endpoint+'/report')).includesUnreviewed,false);
});

test('Domel market scope, source assessment, segmentation and strategy remain linked to original evidence in reports',async t=>{
 let prompt;const f=await fixture(t,async input=>{prompt=input;return JSON.stringify({items:[{title:'Evidence-backed action',body:'Prioritize the application validation described by the evidence.',category:'opportunity',evidenceIds:[input.context[0].title],implication:'This gives Domel a concrete validation priority.',recommendation:'Product strategy should validate it this quarter with one customer metric.'}]});});const doc=await seed(f);
 const scope={market:'Industrial motors and electromechanical equipment',geography:'China with global comparison',period:'2026 Q3',segments:'Industrial automation',dimensions:['competition','technology','attractiveness','strategy'],validationPlan:'Interview Domel market staff; record disagreements',monitoringPlan:'Quarterly review of competitor product updates'};
 assert.equal((await f.call(f.endpoint+'/edit',{question:f.p.question,objectType:f.p.objectType,objectName:f.p.objectName,scope})).status,200);
 assert.equal((await f.call(f.endpoint+'/edit',{question:f.p.question,objectType:f.p.objectType,objectName:f.p.objectName,scope:{...scope,dimensions:['invented']}})).status,400);
 let p=(await f.call(f.endpoint+'/evidence',{documentId:doc.id,quote,dimension:'technology',entity:'Domel motor',segment:'Industrial automation',sourceLevel:'primary',credibility:'Manufacturer statement; no independent performance comparison'})).project;
 const e=p.evidence[0];assert.equal(e.sourceLevel,'primary');assert.equal(e.entity,'Domel motor');
 p=(await f.call(f.endpoint+'/findings',{title:'Application opportunity',body:'Needs validation against application requirements',category:'opportunity',evidenceIds:[e.id],dimension:'attractiveness',entity:'Domel',segment:'Industrial automation',attractiveness:'medium',implication:'Potential product planning relevance',scenario:'If demand shifts toward efficient motors, evaluate application fit',recommendation:'Interview market staff and verify customer requirements'})).project;
 await f.call(f.endpoint+'/generate',{mode:'findings'});assert.match(prompt.question,/2026 Q3/);assert.match(prompt.question,/每条至少回答/);assert.match(prompt.question,/具体动作/);assert.match(prompt.context[0].body,/Manufacturer statement/);
 const report=await f.call(f.endpoint+'/report?skipReview=true');assert.equal(report.status,200);
 for(const text of ['2026 Q3','Industrial automation','Manufacturer statement','Interview market staff','Quarterly review','未人工审核','未启用定时调度'])assert.ok(report.markdown.includes(text),text);
 await f.restart();const saved=(await f.call(f.endpoint)).project;assert.deepEqual(saved.scope,scope);assert.equal(saved.findings[0].recommendation,p.findings[0].recommendation);
});
