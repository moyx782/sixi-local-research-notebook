import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const action=process.argv[2]||'status';
if(!['start','stop','status'].includes(action))throw new Error('使用 start、stop 或 status');
const runtime=join(process.env.SIXI_DATA_DIR||join(homedir(),'.sixi'),'searxng');
const template=fileURLToPath(new URL('./searxng/',import.meta.url));
const exists=path=>access(path).then(()=>true,()=>false);
function docker(args){return new Promise((resolve,reject)=>{
 const context=process.env.SIXI_DOCKER_CONTEXT;
 const child=spawn('docker',[...(context?['--context',context]:[]),'compose','-f',join(runtime,'compose.yaml'),...args],{stdio:'inherit'});
 child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Docker Compose 退出码 ${code}`)));
});}
if(action==='start'){
 await mkdir(join(runtime,'config'),{recursive:true,mode:0o700});
 for(const name of ['compose.yaml'])if(!await exists(join(runtime,name)))await copyFile(join(template,name),join(runtime,name));
 if(!await exists(join(runtime,'.env')))await writeFile(join(runtime,'.env'),`SEARXNG_SECRET=${randomBytes(32).toString('hex')}\n`,{mode:0o600});
 const settings=join(runtime,'config','settings.yml');
 if(!await exists(settings)){
   let content=await readFile(join(template,'settings.yml'),'utf8');
   if(process.env.SEARXNG_PROXY){
     const proxy=new URL(process.env.SEARXNG_PROXY);
     if(!['http:','https:','socks5:','socks5h:'].includes(proxy.protocol))throw new Error('不支持此代理协议');
     content+=`  proxies:\n    all://:\n      - ${JSON.stringify(proxy.href)}\n`;
   }
   await writeFile(settings,content,{mode:0o644});
 }
 await docker(['up','-d','--wait','--wait-timeout','60']);
 console.log(`SearxNG: http://127.0.0.1:8888/\n应用 Endpoint: http://127.0.0.1:8888/search\n运行配置: ${runtime}`);
}else{
 if(!await exists(join(runtime,'compose.yaml')))throw new Error('尚未部署。先运行 npm run search:start');
 await docker(action==='stop'?['stop']:['ps']);
}
