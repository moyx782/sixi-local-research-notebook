import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import yauzl from 'yauzl';
import { AppError } from './input.mjs';
import { isPublicAddress, publicLookup } from './fetch.mjs';

export const MINERU_ENDPOINT = 'https://mineru.net/api/v4';
const defaults = { endpoint: MINERU_ENDPOINT, model: 'vlm', language: 'ch' };
const failure = (message, code='MINERU_ERROR') => new AppError(message,502,code);

export function checkedMineruUrl(value) {
  let url;try {url=new URL(value);} catch {throw failure('MinerU 返回了无效文件地址');}
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.href.length>12000||
    (isIP(host)&&!isPublicAddress(host))||/(^|\.)(localhost|local|internal)$/.test(host))
    throw failure('MinerU 文件地址必须指向公共 HTTPS 服务');
  return url.href;
}

// Read only the Markdown entry into memory. Never extract paths or execute returned content.
export function markdownFromZip(bytes) {
  return new Promise((resolve,reject)=>{
    yauzl.fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true},(error,zip)=>{
      if(error)return reject(failure('MinerU 结果不是有效 ZIP 文件'));
      let done=false,count=0;
      const finish=(error,text)=>{if(done)return;done=true;zip.close();error?reject(error):resolve(text);};
      zip.on('error',()=>finish(failure('MinerU ZIP 文件损坏')));
      zip.on('end',()=>finish(failure('MinerU 结果缺少 full.md')));
      zip.on('entry',entry=>{
        if(++count>10000)return finish(failure('MinerU ZIP 文件条目过多'));
        if(!/(^|\/)full\.md$/.test(entry.fileName)){zip.readEntry();return;}
        if(entry.uncompressedSize>2_000_000||entry.isEncrypted())return finish(failure('MinerU 解析文字过大或已加密，请拆分文件'));
        zip.openReadStream(entry,(error,stream)=>{
          if(error)return finish(failure('无法读取 MinerU Markdown'));
          const chunks=[];let size=0;
          stream.on('data',chunk=>{size+=chunk.length;if(size>2_000_000){stream.destroy();finish(failure('MinerU 解析文字过大，请拆分文件'));}else chunks.push(chunk);});
          stream.on('error',()=>finish(failure('MinerU Markdown 损坏')));
          stream.on('end',()=>{
            let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)).trim();}catch{return finish(failure('MinerU Markdown 编码无效'));}
            if(!text||text.length>440000)return finish(failure('MinerU 未识别到文字，或文字超过 440000 字，请检查或拆分文件'));
            finish(null,text);
          });
        });
      });
      zip.readEntry();
    });
  });
}

export function createMineru(dataDir,{request=fetch,timeoutMs=60_000}={}) {
  const configPath=join(dataDir,'mineru.json');
  const agent=new Agent({connect:{lookup:publicLookup,timeout:10000},connections:2});
  async function readConfig(){try{return {...defaults,...JSON.parse(await readFile(configPath,'utf8'))};}catch(error){if(error.code==='ENOENT')return {...defaults};throw error;}}
  const publicConfig=config=>({endpoint:MINERU_ENDPOINT,model:config.model,language:config.language,hasToken:Boolean(config.token)});
  async function resolve(input){
    const current=await readConfig(),next={...current};
    if(input.endpoint!==undefined&&input.endpoint!==MINERU_ENDPOINT)throw new AppError('当前使用 MinerU 官方云 API，Endpoint 固定');
    if(input.model!==undefined){if(!['vlm','pipeline'].includes(input.model))throw new AppError('MinerU 模型须为 vlm 或 pipeline');next.model=input.model;}
    if(input.language!==undefined){if(!['ch','en','chinese_cht'].includes(input.language))throw new AppError('请选择支持的识别语言');next.language=input.language;}
    if(input.token!==undefined){if(typeof input.token!=='string'||input.token.length>8192||/[\s\u0000]/.test(input.token.trim()))throw new AppError('Token 格式无效，只填写 Token 本身');if(input.token.trim())next.token=input.token.trim();}
    return next;
  }
  async function saveConfig(input,clear=false){const config=await resolve(input);if(clear)delete config.token;const temp=configPath+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(config),{mode:0o600});await rename(temp,configPath);await chmod(configPath,0o600);return publicConfig(config);}
  async function bytesRequest(url,options={},maxBytes=1_000_000,signal){
    let response;
    try {
      response=await request(checkedMineruUrl(url),{...options,dispatcher:agent,redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
      if(!response.ok){const hint={401:'Token 无效或过期',403:'无访问权限',429:'额度或请求频率受限'}[response.status]||'请稍后重试';throw failure(`MinerU 请求返回 HTTP ${response.status}：${hint}`);}
      if(Number(response.headers.get('content-length'))>maxBytes)throw failure('MinerU 返回的文件超过大小限制');
      const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>maxBytes)throw failure('MinerU 返回的文件超过大小限制');chunks.push(chunk);}return Buffer.concat(chunks);
    }catch(error){if(error instanceof AppError)throw error;if(signal?.aborted)throw signal.reason;throw failure('MinerU 连接失败或超时，请检查网络后重试');}
    finally{if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});}
  }
  async function api(path,config,payload,signal){
    if(!config.token)throw new AppError('请先在 AI 设置中保存 MinerU Token',409,'MINERU_TOKEN_REQUIRED');
    const bytes=await bytesRequest(MINERU_ENDPOINT+path,{method:payload?'POST':'GET',headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})},1_000_000,signal);
    let data;try{data=JSON.parse(bytes.toString('utf8'));}catch{throw failure('MinerU 未返回有效 JSON');}
    if(data.code!==0){const code=String(data.code);const hint={A0202:'Token 无效',A0211:'Token 已过期','-60018':'今日解析额度已用完','-60006':'文件页数超出限制，请拆分','-60012':'任务已失效，请重新提交'}[code]||'接口拒绝请求，请检查 Token 或稍后重试';throw failure(`MinerU：${hint}`,code==='-60012'?'MINERU_EXPIRED':'MINERU_API_ERROR');}
    if(!data.data||typeof data.data!=='object')throw failure('MinerU 响应缺少任务数据');return data.data;
  }
  async function allocate(config,file,signal){
    const data=await api('/file-urls/batch',config,{files:[{name:file.filename,data_id:file.id,is_ocr:true}],model_version:config.model,language:config.language,enable_table:true,enable_formula:true},signal);
    if(typeof data.batch_id!=='string'||!/^[-\w]{1,128}$/.test(data.batch_id)||!Array.isArray(data.file_urls)||data.file_urls.length!==1)throw failure('MinerU 未返回有效上传任务');
    return {batchId:data.batch_id,uploadUrl:checkedMineruUrl(data.file_urls[0])};
  }
  return {
    readConfig,publicConfig,saveConfig,
    async config(){return publicConfig(await readConfig());},
    async test(input){const config=await resolve(input);const start=Date.now();await allocate(config,{id:randomUUID(),filename:'connection-test.pdf'});return {latencyMs:Date.now()-start,message:'Token 可用，已验证上传接口；未上传文件、未启动解析。'};},
    allocate,
    async upload(url,bytes,signal){await bytesRequest(url,{method:'PUT',body:bytes},100000,signal);},
    async status(config,batchId,fileId,filename,signal){
      if(!/^[-\w]{1,128}$/.test(batchId))throw failure('无效 MinerU 任务 ID');
      const data=await api('/extract-results/batch/'+batchId,config,null,signal);
      if(!Array.isArray(data.extract_result))throw failure('MinerU 返回了无效进度');
      const entry=data.extract_result.find(item=>item.data_id===fileId)||data.extract_result.find(item=>!item.data_id&&item.file_name===filename);
      if(!entry)return {state:'pending'};
      if(!['done','failed','waiting-file','pending','running','converting'].includes(entry.state))throw failure('MinerU 返回了未知解析状态');
      return {state:entry.state,zipUrl:entry.full_zip_url,progress:entry.extract_progress};
    },
    async result(url,signal){return markdownFromZip(await bytesRequest(url,{},30_000_000,signal));},
    close(){return agent.destroy();},
  };
}
