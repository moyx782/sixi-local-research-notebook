import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelConnection, normalizeEndpoint } from '../backend/model-connection.mjs';
import { createAssistant } from '../backend/assistant.mjs';
import { createApp } from '../server.mjs';

const config = { provider: 'deepseek', protocol: 'openai-chat', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', apiKey: 'test-fixture-key-only' };
const chat = text => Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });

test('model endpoints normalize base and full URLs without duplicating protocol paths; unsafe targets are rejected', () => {
  for (const [input,expected] of [
    ['https://api.deepseek.com','https://api.deepseek.com/chat/completions'],
    ['https://api.deepseek.com/v1/','https://api.deepseek.com/v1/chat/completions'],
    ['https://api.deepseek.com/chat/completions/','https://api.deepseek.com/chat/completions'],
  ]) assert.equal(normalizeEndpoint('openai-chat',input),expected);
  assert.equal(normalizeEndpoint('anthropic-messages','https://api.deepseek.com/anthropic'),'https://api.deepseek.com/anthropic/v1/messages');
  for (const input of ['https://api.anthropic.com','https://api.anthropic.com/v1','https://api.anthropic.com/v1/messages'])
    assert.equal(normalizeEndpoint('anthropic-messages',input),'https://api.anthropic.com/v1/messages');
  for (const input of ['http://api.deepseek.com','https://key@api.deepseek.com','https://api.deepseek.com?key=secret','https://api.deepseek.com#secret','https://127.0.0.1','https://10.0.0.1','https://[::1]','https://169.254.169.254','https://localhost','https://service.internal'])
    assert.throws(()=>normalizeEndpoint('openai-chat',input));
  assert.throws(()=>normalizeEndpoint('openai-chat','https://example.com/v1/messages'),/chat\/completions/);
  assert.throws(()=>normalizeEndpoint('anthropic-messages','https://example.com/v1/chat/completions'),/messages/);
});

test('custom adapters send the selected model, protocol headers and bounded output; only final text is consumed', async t => {
  const calls=[];
  const connection=createModelConnection({request:async(url,options)=>{
    calls.push({url,...options,payload:JSON.parse(options.body)});
    return options.headers['x-api-key']
      ? Response.json({content:[{type:'thinking',thinking:'not final'},{type:'text',text:'Anthropic '},{type:'text',text:'OK'}],stop_reason:'end_turn'})
      : chat('Chat OK');
  }});
  t.after(()=>connection.close());
  assert.equal(await connection.complete(config,'public research'),'Chat OK');
  assert.equal(calls[0].headers.authorization,`Bearer ${config.apiKey}`);
  assert.equal(calls[0].headers['x-api-key'],undefined);
  assert.equal(calls[0].redirect,'manual');
  assert.equal(calls[0].payload.model,'deepseek-flash');
  assert.deepEqual(calls[0].payload.thinking,{type:'disabled'});
  assert.equal(calls[0].payload.max_tokens,4096);
  assert.equal(calls[0].payload.stream,false);
  assert.equal(await connection.complete({...config,protocol:'anthropic-messages',endpoint:'https://api.deepseek.com/anthropic'},'test',{test:true}),'Anthropic OK');
  assert.equal(calls[1].url,'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(calls[1].headers.authorization,undefined);
  assert.equal(calls[1].headers['x-api-key'],config.apiKey);
  assert.equal(calls[1].headers['anthropic-version'],'2023-06-01');
  assert.equal(calls[1].payload.max_tokens,64);
  assert.deepEqual(calls[1].payload.thinking,{type:'disabled'});
});

test('model failures are actionable and do not disclose upstream headers, bodies or partial reasoning', async t => {
  const cases=[
    [()=>new Response('secret echoed key',{status:401}),'MODEL_HTTP_ERROR'],
    [()=>new Response('secret',{status:402}),'MODEL_HTTP_ERROR'],
    [()=>new Response('secret',{status:429}),'MODEL_HTTP_ERROR'],
    [()=>new Response('secret',{status:302,headers:{location:'https://other.example'}}),'MODEL_REDIRECT'],
    [()=>new Response('<html>secret</html>'),'MODEL_RESPONSE_INVALID'],
    [()=>chat(''),'MODEL_EMPTY_RESPONSE'],
    [()=>Response.json({choices:[{message:{reasoning_content:'secret'},finish_reason:'stop'}]}),'MODEL_EMPTY_RESPONSE'],
    [()=>Response.json({choices:[{message:{content:'partial'},finish_reason:'length'}]}),'MODEL_OUTPUT_TRUNCATED'],
    [()=>{throw new Error('secret echoed header');},'MODEL_CONNECTION_FAILED'],
    [()=>{throw new DOMException('secret','TimeoutError');},'MODEL_TIMEOUT'],
  ];
  for(const [request,code] of cases){
    let count=0;const connection=createModelConnection({request:async()=>{count++;return request();}});t.after(()=>connection.close());
    await assert.rejects(connection.complete(config,'test'),error=>error.code===code&&!error.message.includes('secret'));
    assert.equal(count,1,'no retry or redirect can duplicate calls or forward keys');
  }
  const bounded=createModelConnection({request:async()=>chat('a'.repeat(100)),maxBytes:50});t.after(()=>bounded.close());
  await assert.rejects(bounded.complete(config,'test'),{code:'MODEL_RESPONSE_TOO_LARGE'});
});

test('legacy settings migrate; model edits retain keys while connection changes require a fresh key; tests never save',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sixi-model-config-'));
  const file=join(dir,'config.json');
  await writeFile(file,JSON.stringify({provider:'anthropic',model:'legacy',apiKey:'old-key'}));
  const calls=[];
  const assistant=createAssistant(dir,{connection:{complete:async(...args)=>{calls.push(args);return 'OK';},close(){}}});
  t.after(async()=>{await assistant.close();await rm(dir,{recursive:true});});
  assert.equal((await assistant.readConfig()).protocol,'builtin');
  assert.equal((await assistant.saveConfig({model:'updated',apiKey:''})).apiKey,'old-key');
  const saved=await assistant.saveConfig(config);
  assert.equal(saved.apiKey,config.apiKey);
  assert.equal((await stat(file)).mode&0o777,0o600);
  const before=await readFile(file,'utf8');
  const result=await assistant.testConnection({model:'unsaved-model',apiKey:''});
  assert.equal(result.model,'unsaved-model');assert.equal(result.apiKey,undefined);
  assert.equal(calls[0][0].apiKey,config.apiKey);
  assert.match(calls[0][1],/connection test/);
  assert.deepEqual(calls[0][2],{test:true});
  assert.equal(await readFile(file,'utf8'),before);
  await assert.rejects(assistant.testConnection({endpoint:'https://other.example/v1'}),/密钥/);
  assert.equal(calls.length,1);
  assert.equal(await readFile(file,'utf8'),before);
  for(const field of ['endpoint','provider','protocol']){
    await assistant.saveConfig(config);
    const update=field==='endpoint'?{endpoint:'https://other.example/v1'}:field==='provider'?{provider:'other'}:{protocol:'anthropic-messages',endpoint:'https://api.deepseek.com/anthropic'};
    assert.equal((await assistant.saveConfig(update)).apiKey,undefined,field);
  }
  await assert.rejects(assistant.saveConfig({protocol:'not-a-protocol'}),/协议/);
});

test('HTTP settings, unsaved connection test and research ask route use the configured adapter without exposing keys',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sixi-model-api-'));
  const calls=[];
  const connection=createModelConnection({request:async(url,options)=>{calls.push({url,headers:options.headers,payload:JSON.parse(options.body)});return chat('OK');}});
  const app=createApp({dataDir:dir,modelConnection:connection,fetcher:{close(){},async fetch(){throw new Error('unexpected collection');}}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{await app.close();await rm(dir,{recursive:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const call=async(path,input)=>{const response=await fetch(base+path,{method:input?'POST':'GET',headers:{'content-type':'application/json'},body:input?JSON.stringify(input):undefined});return {status:response.status,data:await response.json()};};
  const tested=await call('/api/config/test',config);
  assert.equal(tested.status,200);assert.equal(tested.data.apiKey,undefined);
  assert.equal((await call('/api/config')).data.hasKey,false);
  const saved=await call('/api/config',config);
  assert.equal(saved.data.hasKey,true);assert.equal(saved.data.endpoint,config.endpoint);assert.equal(saved.data.protocol,config.protocol);
  assert.equal(JSON.stringify(saved).includes(config.apiKey),false);
  const asked=await call('/api/ask',{question:'Which applications?',context:[{title:'public',body:'PUBLIC EVIDENCE'}]});
  assert.equal(asked.data.answer,'OK');assert.match(calls[1].payload.messages[0].content,/PUBLIC EVIDENCE/);
  assert.equal(calls[0].payload.messages[0].content.includes('PUBLIC EVIDENCE'),false);
  assert.equal((await call('/api/config/test',{endpoint:'https://other.example'})).status,400);
  assert.equal(calls.length,2);
});
