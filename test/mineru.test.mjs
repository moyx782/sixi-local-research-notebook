import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server.mjs';
import {createMineru,MINERU_ENDPOINT,markdownFromZip,checkedMineruUrl} from '../backend/mineru.mjs';

// Minimal stored ZIP fixture, independent of the reader library.
export function zipFixture(text,name='full.md',declaredSize){
 const data=Buffer.from(text),filename=Buffer.from(name);let crc=0xffffffff;
 for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(declaredSize??data.length,22);local.writeUInt16LE(filename.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(declaredSize??data.length,24);central.writeUInt16LE(filename.length,28);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+filename.length,12);end.writeUInt32LE(local.length+filename.length+data.length,16);
 return Buffer.concat([local,filename,data,central,filename,end]);
}
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOAAAAABJRU5ErkJggg==';
const json=data=>new Response(JSON.stringify({code:0,data}),{headers:{'content-type':'application/json'}});
function cloud(){
 const calls=[],batches=new Map();let pending=false,fail=false;
 return {calls,batches,set pending(v){pending=v;},set fail(v){fail=v;},async request(url,options){
   calls.push({url,options});
   if(url===MINERU_ENDPOINT+'/file-urls/batch'){
     const file=JSON.parse(options.body).files[0],batchId=`batch-${batches.size+1}`;batches.set(batchId,file);
     return json({batch_id:batchId,file_urls:[`https://upload.example.com/${batchId}?signature=PRIVATE-SIGNED-LINK`]});
   }
   if(options.method==='PUT'){assert.equal(options.headers?.authorization,undefined);return new Response('');}
   if(url.startsWith(MINERU_ENDPOINT+'/extract-results/batch/')){
     const id=url.split('/').at(-1),file=batches.get(id);return json({batch_id:id,extract_result:[{file_name:file.name,data_id:file.data_id,state:pending?'running':fail?'failed':'done',full_zip_url:'https://result.example.com/output.zip',extract_progress:{extracted_pages:1,total_pages:2}}]});
   }
   if(url==='https://result.example.com/output.zip'){assert.equal(options.headers?.authorization,undefined);return new Response(zipFixture('# Motor research\n\nRated power: 250 W.\n\n| Model | Power |\n| --- | --- |\n| Test | 250 W |'));}
   throw new Error('Unexpected request');
 }};
}
async function fixture(t,extra={}){
 const dir=await mkdtemp(join(tmpdir(),'sixi-mineru-')),mock=cloud();let app,base;
 async function start(){app=createApp({dataDir:dir,mineruOptions:{request:mock.request,pollMs:5,...extra},fetcher:{close(){},async fetch(){throw new Error('No web calls expected');}}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;}
 await start();t.after(async()=>{await app.close();await rm(dir,{recursive:true});});
 const call=async(path,input)=>{const r=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});return {status:r.status,...await r.json()};};
 return {dir,mock,call,get app(){return app;},get base(){return base;},async restart(){await app.close();await start();}};
}
async function eventually(fn){for(let i=0;i<200;i++){if(await fn())return;await delay(5);}assert.fail('Expected parser progress');}

test('MinerU config keeps Token private, validates settings, and connection test never uploads data',async t=>{
 const f=await fixture(t);
 const saved=await f.call('/api/mineru/config',{token:'secret-mineru-token',model:'vlm',language:'ch'});assert.equal(saved.hasToken,true);assert.equal(saved.token,undefined);
 assert.equal((await stat(join(f.dir,'mineru.json'))).mode&0o777,0o600);
 await f.call('/api/mineru/config',{token:'',model:'pipeline'});assert.equal(JSON.parse(await readFile(join(f.dir,'mineru.json'),'utf8')).token,'secret-mineru-token');
 assert.equal((await f.call('/api/mineru/config',{endpoint:'https://attacker.example/v4'})).status,400);
 assert.equal((await f.call('/api/mineru/config',{token:'Bearer secret'})).status,400);
 const checked=await f.call('/api/mineru/config/test',{});assert.equal(checked.status,200);assert.equal(f.mock.calls.length,1);assert.equal(f.mock.calls[0].options.headers.authorization,'Bearer secret-mineru-token');
 assert.equal((await f.call('/api/mineru/config')).token,undefined);
});

test('cloud PDF upload preserves original, collects Markdown and tables, and completed retries are idempotent',async t=>{
 const f=await fixture(t);await f.call('/api/mineru/config',{token:'test-token'});
 const bytes=Buffer.from('%PDF-1.7\nScanned fixture, no local text layer');
 const uploaded=await f.call('/api/library/uploads',{parser:'mineru',filename:'scan.pdf',base64:bytes.toString('base64'),url:'https://example.com/original',content:'User annotation'});assert.equal(uploaded.status,202);assert.equal(uploaded.job,null);
 await f.app.uploads.parser.running;await f.app.collector.running;
 const list=await f.call('/api/library/uploads'),upload=list.items[0];assert.equal(upload.parseStatus,'completed');assert.ok(upload.documentId);assert.equal(upload.batchId,undefined);assert.equal(upload.uploadUrl,undefined);assert.ok(!JSON.stringify(list).includes('PRIVATE-SIGNED-LINK'));
 const doc=(await f.call('/api/documents/'+upload.documentId)).document;assert.match(doc.text,/Rated power: 250 W/);assert.match(doc.text,/\| Model \| Power \|/);assert.match(doc.text,/User annotation/);assert.equal(doc.attachments[0].parser,'mineru');assert.equal(doc.origins[0].url,'https://example.com/original');
 const original=await fetch(f.base+doc.attachments[0].downloadUrl);assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes);
 const allocations=f.mock.batches.size;await f.call(`/api/library/uploads/${upload.id}/parse`,{});assert.equal(f.mock.batches.size,allocations);
});

test('missing Token keeps image available; normal collection continues and retry creates readable OCR',async t=>{
 const f=await fixture(t);
 const first=await f.call('/api/library/uploads',{parser:'mineru',filename:'screen.png',base64:png});await f.app.uploads.parser.running;
 assert.equal((await f.call('/api/library/uploads')).items[0].parseStatus,'failed');assert.equal(f.mock.calls.length,0);
 const original=await fetch(`${f.base}/api/library/uploads/${first.upload.id}/file`);assert.equal(original.status,200);
 await f.call('/api/library/uploads',{content:'Normal text continues while OCR is waiting.'});await f.app.collector.running;assert.equal((await f.call('/api/documents')).total,1);
 await f.call('/api/mineru/config',{token:'token'});await f.call(`/api/library/uploads/${first.upload.id}/parse`,{});await f.app.uploads.parser.running;await f.app.collector.running;
 assert.equal((await f.call('/api/documents')).total,2);const item=(await f.call('/api/library/uploads')).items.find(u=>u.id===first.upload.id);assert.equal(item.hasText,true);assert.equal(item.parseStatus,'completed');
 assert.equal((await f.call('/api/library/uploads',{parser:'mineru',filename:'note.md',base64:Buffer.from('Text').toString('base64')})).status,400);
});

test('restart resumes the same remote batch; failed parse can be retried without losing originals',async t=>{
 const f=await fixture(t);await f.call('/api/mineru/config',{token:'token'});f.mock.pending=true;
 const first=await f.call('/api/library/uploads',{parser:'mineru',filename:'scan.png',base64:png});
 await eventually(()=>f.app.uploads.listInternal()[0]?.remoteUploaded);
 await f.restart();f.mock.pending=false;await f.app.uploads.parser.running;await f.app.collector.running;
 assert.equal(f.mock.batches.size,1);assert.equal((await f.call('/api/library/uploads')).items[0].parseStatus,'completed');
 f.mock.fail=true;const second=await f.call('/api/library/uploads',{parser:'mineru',filename:'bad.png',base64:png});await f.app.uploads.parser.running;
 assert.equal((await f.call('/api/library/uploads')).items[0].parseStatus,'failed');
 f.mock.fail=false;await f.call(`/api/library/uploads/${second.upload.id}/parse`,{});await f.app.uploads.parser.running;await f.app.collector.running;
 assert.equal(f.mock.batches.size,3);assert.equal((await f.call('/api/library/uploads')).items[0].parseStatus,'completed');
 assert.equal((await fetch(`${f.base}/api/library/uploads/${first.upload.id}/image`)).status,200);
});

test('existing local captures keep their text; cloud human handoff attaches OCR to the intended research',async t=>{
 const f=await fixture(t);await f.call('/api/mineru/config',{token:'token'});
 const local=await f.call('/api/library/uploads',{filename:'original.png',base64:png,content:'Original human interpretation.'});await f.app.collector.running;
 const originalId=(await f.call('/api/documents')).items[0].id;
 await f.call(`/api/library/uploads/${local.upload.id}/parse`,{});await f.app.uploads.parser.running;await f.app.collector.running;
 assert.equal((await f.call('/api/documents/'+originalId)).document.text,'Original human interpretation.');
 const project=(await f.call('/api/research/projects',{question:'Research motors',objectType:'company',objectName:'Domel'})).project;
 const task=(await f.call(`/api/research/projects/${project.id}/handoffs`,{title:'Product screenshot'})).task;
 const completed=await f.call(`/api/research/projects/${project.id}/handoffs/${task.id}`,{action:'complete',parser:'mineru',screenshot:{base64:png},content:'',assignee:'Tester'});assert.equal(completed.status,200);
 await f.app.uploads.parser.running;await f.app.collector.running;
 const detail=await f.call('/api/research/projects/'+project.id);assert.equal(detail.documents.length,1);assert.match((await f.call('/api/documents/'+detail.documents[0].id)).document.text,/Tester/);
});

test('ZIP and cloud responses are bounded, unsafe URLs rejected, and upstream messages cannot disclose Token',async t=>{
 assert.equal(await markdownFromZip(zipFixture('Extracted text','result/full.md')),'Extracted text');
 await assert.rejects(markdownFromZip(Buffer.from('not a zip')));
 await assert.rejects(markdownFromZip(zipFixture('','full.md')));
 await assert.rejects(markdownFromZip(zipFixture('hello','../full.md')));
 await assert.rejects(markdownFromZip(zipFixture('x','full.md',2_000_001)));
 await assert.rejects(markdownFromZip(zipFixture('x','other.md')));
 for(const url of ['http://example.com/a','https://127.0.0.1/a','https://a.local/a','https://user:pass@example.com/a'])assert.throws(()=>checkedMineruUrl(url));
 const dir=await mkdtemp(join(tmpdir(),'mineru-error-'));t.after(()=>rm(dir,{recursive:true}));
 const client=createMineru(dir,{request:async()=>new Response('Bearer secret-token',{status:401})});t.after(()=>client.close());
 await assert.rejects(client.test({token:'secret-token'}),error=>!error.message.includes('secret-token')&&error.message.includes('401'));
 const bad=createMineru(dir,{request:async()=>new Response(JSON.stringify({code:'A0202',msg:'secret-token'}))});t.after(()=>bad.close());
 await assert.rejects(bad.test({token:'secret-token'}),error=>!error.message.includes('secret-token')&&error.message.includes('Token'));
});


test('expired upload URLs get a fresh batch on explicit retry',async t=>{
 let failUpload=true;const mock=cloud();
 const f=await fixture(t,{request:async(url,options)=>options.method==='PUT'&&failUpload?new Response('expired signed URL',{status:403}):mock.request(url,options)});
 await f.call('/api/mineru/config',{token:'token'});
 const uploaded=await f.call('/api/library/uploads',{parser:'mineru',filename:'screen.png',base64:png});await f.app.uploads.parser.running;
 assert.equal((await f.call('/api/library/uploads')).items[0].parseStatus,'failed');
 failUpload=false;await f.call(`/api/library/uploads/${uploaded.upload.id}/parse`,{});await f.app.uploads.parser.running;await f.app.collector.running;
 assert.equal(mock.batches.size,2);assert.equal((await f.call('/api/library/uploads')).items[0].parseStatus,'completed');
});
