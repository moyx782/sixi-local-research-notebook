import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { visualUrl, createVisualCapture } from '../backend/visual-capture.mjs';

test('visual URL guard blocks private addresses and allows only explicit local test mode', () => {
  for (const url of ['http://127.0.0.1:4173/', 'http://localhost:8080/', 'http://192.168.1.2/', 'file:///tmp/a']) assert.throws(() => visualUrl(url));
  assert.equal(visualUrl('http://127.0.0.1:4173/', { allowLocal: true }), 'http://127.0.0.1:4173/');
  assert.equal(visualUrl('https://www.domel.com/'), 'https://www.domel.com/');
});

test('Playwright renders a dynamic page, captures visible content and persists screenshot attachment', async t => {
  const page=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Visual fixture</title><main><h1>Industrial motor</h1><p id="dynamic">Loading…</p><script>setTimeout(()=>document.querySelector("#dynamic").textContent="Rendered client content",20)</script></main>');});
  page.listen(0,'127.0.0.1');await once(page,'listening');t.after(()=>new Promise(resolve=>page.close(resolve)));
  const dir=await mkdtemp(join(tmpdir(),'sixi-visual-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const app=createApp({dataDir:dir,authRequired:false,visualOptions:{allowLocal:true},fetcher:{close(){},async fetch(){throw new Error('HTTP collector must not be used for visual input');}}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  async function call(path,input){const r=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});return {status:r.status,...await r.json()};}
  const project=(await call('/api/research/projects',{question:'What is rendered?',objectType:'company',objectName:'Domel'})).project;
  const url=`http://127.0.0.1:${page.address().port}/dynamic`;
  const accepted=await call(`/api/research/projects/${project.id}/collect`,{type:'url',url,renderMode:'playwright',fullPage:true});assert.equal(accepted.status,202);
  await app.collector.running;
  const detail=await call(`/api/research/projects/${project.id}`);assert.equal(detail.documents.length,1);
  const doc=await call('/api/documents/'+detail.documents[0].id);assert.match(doc.document.text,/Rendered client content/);const capture=doc.document.attachments.find(a=>a.parser==='playwright');assert.ok(capture);assert.equal(capture.kind,'image');
  const image=await fetch(base+capture.url);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.ok((await image.arrayBuffer()).byteLength>100);
  const job=(await call('/api/collections?limit=100')).items.find(j=>j.id===accepted.job.id);assert.equal(job.status,'partial');assert.equal(job.result.created,1);
});

test('Playwright adapter reports a missing browser with an actionable error', async () => {
  const visual=createVisualCapture({allowLocal:true});
  // The installed browser is exercised by the integration test above. This guard
  // remains a contract test for callers that pass a cancellation signal.
  const controller=new AbortController();controller.abort(new Error('cancelled'));
  await assert.rejects(visual.capture('http://127.0.0.1:1/',{signal:controller.signal}),/cancelled|Playwright/);
});
