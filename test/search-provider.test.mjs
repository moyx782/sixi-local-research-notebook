import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearch, searchEndpoint } from '../backend/search-provider.mjs';
import { createApp } from '../server.mjs';
import { html, resource } from './fixtures.mjs';

const result = { title: 'Domel industrial motor products', url: 'https://www.domel.com/products', content: 'Industrial motor specifications and customer applications.', engines: ['google', 'bing'] };
const fallbackHTML = '<div class="result"><a class="result__a" href="https://www.domel.com/">Domel</a><div class="result__snippet">Public motor data</div></div>';
async function temporary(t) { const dir=await mkdtemp(join(tmpdir(),'sixi-search-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir; }

test('SearxNG endpoint permits only explicit loopback services and normalizes the search path',()=>{
 assert.equal(searchEndpoint('http://localhost:8888/'),'http://127.0.0.1:8888/search');
 for(const value of ['https://external.example/search','http://192.168.1.2/','file:///tmp/settings','http://127.0.0.1/private','http://user:pass@localhost/','http://localhost/?q=x','http://localhost/#x'])assert.throws(()=>searchEndpoint(value));
});

test('real loopback JSON transport encodes queries, deduplicates URLs and persists settings',async t=>{
 let received;
 const local=http.createServer((req,res)=>{received=new URL(req.url,'http://localhost');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({results:[result,result,{title:'Invalid',url:'javascript:alert(1)'},{title:'Other',url:'https://other.example/page',content:'Second source'}],unresponsive_engines:[['bing','timeout']]}));});
 local.listen(0,'127.0.0.1');await once(local,'listening');t.after(()=>new Promise(resolve=>local.close(resolve)));
 const dir=await temporary(t),fetcher={async fetch(){assert.fail('Should not fall back');}},search=createSearch(dir,fetcher);
 await search.saveConfig({provider:'searxng',endpoint:`http://127.0.0.1:${local.address().port}`,fallback:false});
 const found=await search.search({query:'Domel & motors 中文',limit:2});
 assert.equal(received.pathname,'/search');assert.equal(received.searchParams.get('q'),'Domel & motors 中文');assert.equal(received.searchParams.get('format'),'json');
 assert.equal(found.provider,'SearxNG');assert.equal(found.items.length,2);assert.deepEqual(found.items[0].engines,['google','bing']);assert.equal(found.warnings.length,1);
 assert.equal((await createSearch(dir,fetcher).config()).provider,'searxng');
 assert.equal((await search.test({})).count,2);
});

test('fallback is visible, test does not fall back or save, abort prevents fallback',async t=>{
 const dir=await temporary(t);let secondary=0;
 const search=createSearch(dir,{async fetch(){secondary++;return {text:fallbackHTML};}},{request:async()=>{throw new Error('connection refused');}});
 await search.saveConfig({provider:'searxng'});
 const found=await search.search({query:'Domel'});assert.equal(found.provider,'DuckDuckGo');assert.equal(found.fallbackFrom,'SearxNG');assert.match(found.warnings[0],/回退/);assert.equal(secondary,1);
 await assert.rejects(search.test({endpoint:'http://localhost:9999'}),{code:'SEARCH_UNAVAILABLE'});assert.equal(secondary,1);assert.equal((await search.config()).endpoint,'http://127.0.0.1:8888/search');
 await search.saveConfig({fallback:false});await assert.rejects(search.search({query:'Domel'}),{code:'SEARCH_UNAVAILABLE'});assert.equal(secondary,1);
 const controller=new AbortController();controller.abort(new Error('cancelled'));await assert.rejects(search.search({query:'Domel'},{signal:controller.signal}),/cancelled/);
 await assert.rejects(search.search({query:' '}),{status:400});
});

test('SearxNG rejects forbidden JSON, malformed responses, oversized streams and bounded timeouts',async t=>{
 const dir=await temporary(t);
 for(const response of [new Response('',{status:403}),new Response('<html>HTML</html>',{headers:{'content-type':'text/html'}}),new Response('{bad',{headers:{'content-type':'application/json'}}),Response.json({results:{}}),Response.json({results:[],unresponsive_engines:[['google','timeout']]}),Response.json({results:[],padding:'x'.repeat(2_000_001)})]){
   const search=createSearch(dir,{}, {request:async()=>response});await search.saveConfig({provider:'searxng',fallback:false});await assert.rejects(search.search({query:'test'}),{code:'SEARCH_UNAVAILABLE'});
 }
 // Keep a real local socket open until the adapter deadline aborts the request.
 const local=http.createServer(()=>{});local.listen(0,'127.0.0.1');await once(local,'listening');
 t.after(()=>{local.closeAllConnections();local.close();});
 const search=createSearch(dir,{}, {timeoutMs:50});await search.saveConfig({endpoint:`http://127.0.0.1:${local.address().port}`});await assert.rejects(search.search({query:'test'}),{code:'SEARCH_UNAVAILABLE'});
});

test('shared provider drives manual Search and automatic collection; WebFetch still works with search offline',async t=>{
 const dir=await temporary(t);let online=true,searches=0;
 const app=createApp({dataDir:dir,fetcher:{close(){},async fetch(url){return resource(html('Domel public motor specifications and applications. '.repeat(8)),url);}},searchOptions:{request:async()=>{searches++;if(!online)throw new Error('Offline');return Response.json({results:[result],unresponsive_engines:[['bing','timeout']]});}},discoveryOptions:{pollMs:5}});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.close());
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const call=async(path,input)=>{const r=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});return {status:r.status,...await r.json()};};
 assert.equal((await call('/api/search/config',{provider:'searxng',fallback:false})).provider,'searxng');
 assert.equal((await call('/api/search',{query:'Domel'})).provider,'SearxNG');
 const project=(await call('/api/research/projects',{question:'Motor applications',objectType:'company',objectName:'Domel'})).project;
 const path=`/api/research/projects/${project.id}`;
 await call(path+'/discover',{useAI:false,maxSources:4});await app.discovery.running;
 const detail=await call(path);assert.equal(detail.discovery.status,'completed');assert.equal(detail.documents.length,1);assert.equal(detail.discovery.queries.every(q=>q.provider==='SearxNG'),true);assert.equal(detail.discovery.warnings.length,1);assert.equal(searches,7);
 online=false;assert.equal((await call('/api/search',{query:'offline'})).status,503);
 assert.equal((await call(path+'/collect',{type:'url',url:'https://www.domel.com/webfetch-test'})).status,202);await app.collector.running;
 const after=await call(path);assert.equal(after.project.sourceIds.length,2);assert.equal(app.store.job(app.store.db.prepare('SELECT id FROM jobs ORDER BY rowid DESC LIMIT 1').get().id).status,'succeeded');
});
