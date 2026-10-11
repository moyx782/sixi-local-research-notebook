import { randomUUID } from 'node:crypto';
import { AppError, normalizeUrl, collectionInput } from './input.mjs';

const now = () => new Date().toISOString();
const text = (value, max, label, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new AppError(`${label}格式不正确`);
  return value.trim();
};
export function screenshot(input) {
  if (!input) return null;
  if (typeof input.base64 !== 'string' || input.base64.length > 7_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) throw new AppError('截图格式无效或超过 5 MB');
  const bytes = Buffer.from(input.base64, 'base64');
  if (!bytes.length || bytes.length > 5_000_000) throw new AppError('每张截图最多 5 MB');
  let mime;
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime='image/png';
  else if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) mime='image/jpeg';
  else if (bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') mime='image/webp';
  if (!mime) throw new AppError('截图仅支持 PNG、JPEG 或 WebP 图片');
  return { bytes, mime };
}

function attachment(input) {
  if (input === undefined || input === null) return null;
  if (!input || typeof input !== 'object' || typeof input.filename !== 'string' || typeof input.base64 !== 'string')
    throw new AppError('附件格式无效');
  if (!input.filename.trim() || input.filename.length > 250 || /[\r\n\u0000/\\]/.test(input.filename))
    throw new AppError('附件文件名无效');
  return { filename: input.filename, base64: input.base64 };
}

export class Handoffs {
  constructor(store, research, collector) {
    this.store=store;this.research=research;this.collector=collector;
    store.db.exec(`CREATE TABLE IF NOT EXISTS research_handoffs (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,data_json TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS handoffs_project ON research_handoffs(project_id);
      CREATE TABLE IF NOT EXISTS research_screenshots (task_id TEXT PRIMARY KEY,mime TEXT NOT NULL,bytes BLOB NOT NULL);`);
    this.compactLegacyAutoTasks();
  }
  list(projectId) {return this.store.db.prepare('SELECT data_json FROM research_handoffs WHERE project_id=? ORDER BY updated_at DESC,rowid DESC').all(projectId).map(row=>JSON.parse(row.data_json));}
  get(id) {const row=this.store.db.prepare('SELECT data_json FROM research_handoffs WHERE id=?').get(id);if(!row)throw new AppError('人工任务不存在',404);return JSON.parse(row.data_json);}
  save(task) {task.updatedAt=now();this.store.db.prepare('INSERT INTO research_handoffs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at').run(task.id,task.projectId,JSON.stringify(task),task.updatedAt);return task;}
  compactLegacyAutoTasks() {
    const rows=this.store.db.prepare(`SELECT project_id,data_json FROM research_handoffs WHERE data_json LIKE '%"status":"open"%' ORDER BY updated_at ASC,rowid ASC`).all();
    const groups=new Map();
    for(const row of rows){
      let task;try{task=JSON.parse(row.data_json);}catch{continue;}
      if(!task.dedupeKey||!/^(source|query|pdf|empty):/.test(task.dedupeKey))continue;
      if(!groups.has(row.project_id))groups.set(row.project_id,[]);groups.get(row.project_id).push(task);
    }
    for(const [projectId,tasks] of groups){
      if(tasks.length<2)continue;
      const canonical=tasks[0],key=`legacy-auto:${projectId}`;
      canonical.title=`自动采集待补充资料（已合并 ${tasks.length} 项）`;canonical.url='';canonical.dedupeKey=key;
      canonical.reason=tasks.map(task=>`【${task.title}】${task.url?`\n来源：${task.url}`:''}\n${task.reason}`).join('\n\n').slice(0,2000);
      this.save(canonical);
      for(const duplicate of tasks.slice(1))this.save({...duplicate,status:'skipped',mergedInto:canonical.id,updatedAt:now()});
    }
  }
  create(projectId,input) {
    this.research.get(projectId);
    const tasks=this.list(projectId);
    const url=input.url?normalizeUrl(input.url):'';
    const key=input.dedupeKey||url;
    const existing=key&&tasks.find(t=>t.dedupeKey===key && t.status==='open');
    if(existing)return existing;
    if(tasks.length>=100)throw new AppError('此研究最多保留 100 条人工任务');
    return this.save({id:randomUUID(),projectId,title:text(input.title,300,'任务标题',true),url,reason:text(input.reason||'',2000,'任务说明'),
      assignee:text(input.assignee||'',100,'负责人'),status:'open',dedupeKey:key||'',createdAt:now(),sourceId:null,hasScreenshot:false});
  }
  async complete(id,input) {
    const task=this.get(id);if(task.status!=='open')throw new AppError('此任务已经处理',409);
    const file=attachment(input.attachment),image=screenshot(input.screenshot);
    const imageFile=file&&/\.(png|jpe?g|webp)$/i.test(file.filename);
    // A file upload can stand on its own: image-only captures are preserved as
    // library assets and must not be forced through a synthetic text record.
    // Text-only handoffs still require the researcher to provide an excerpt.
    const caption=text(input.content||'',450000,'补采文字',input.parser!=='mineru'&&!file);
    const url=input.url?normalizeUrl(input.url):task.url;
    const assignee=text(input.assignee||task.assignee||'',100,'负责人');
    const title=text(input.title||task.title,300,'资料标题',true);
    const attachToProject=input.attachToProject!==false;
    const notes=`人工补采记录人：${assignee||'未署名'}${url?`\n原始来源：${url}`:''}${caption?`\n\n${caption}`:''}`;
    if(file){
      if(!this.uploads)throw new AppError('资料上传服务未配置',503);
      const uploadContent=imageFile&&!caption?'':notes;
      const result=await this.uploads.upload({parser:input.parser==='mineru'?'mineru':'local',filename:file.filename,base64:file.base64,title,url,content:uploadContent},{projectId:attachToProject?task.projectId:undefined});
      if(result.job&&attachToProject)this.research.mutate(task.projectId,p=>{if(!p.sourceIds.includes(result.job.sourceId))p.sourceIds.push(result.job.sourceId);});
      const saved={...task,title,url,assignee,status:'completed',uploadId:result.upload.id,sourceId:result.job?.sourceId||null,jobId:result.job?.id||null,hasScreenshot:result.upload.kind==='image',attachmentFilename:result.upload.filename,attachmentKind:result.upload.kind,parser:result.upload.parser||'local',attachedToProject:Boolean(attachToProject&&result.job),completedAt:now()};
      this.save(saved);
      if(result.job)this.collector.kick();
      return {task:this.get(id),...result};
    }
    if(input.parser==='mineru'){
      if(!image)throw new AppError('请选择要交给 MinerU 识别的截图');
      if(caption.length>4500)throw new AppError('MinerU 补充说明最多 4500 字');
      const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[image.mime];
      const result=await this.uploads.upload({parser:'mineru',filename:`capture.${ext}`,base64:input.screenshot.base64,title,url,content:notes},{projectId:attachToProject?task.projectId:undefined});
      this.save({...task,title,url,assignee,status:'completed',uploadId:result.upload.id,hasScreenshot:true,attachmentFilename:result.upload.filename,attachmentKind:'image',parser:'mineru',attachedToProject:attachToProject,completedAt:now()});
      return {task:this.get(id),...result};
    }
    const content=`【人工补采记录${image?' · 附截图':''}】\n记录时间：${now()}\n${assignee?`记录人：${assignee}\n`:''}${url?`原始来源：${url}\n`:''}\n${caption}\n\n说明：以上文字由用户填写${image?'，截图作为核对材料保存，系统未执行 OCR':''}；仍需核实出处与内容。`;
    const job=this.store.enqueue(collectionInput({type:'text',title,content,...(url?{url}:{})}));
    if(attachToProject)this.research.mutate(task.projectId,p=>{if(!p.sourceIds.includes(job.sourceId))p.sourceIds.push(job.sourceId);});
    if(image)this.store.db.prepare('INSERT INTO research_screenshots VALUES (?,?,?)').run(task.id,image.mime,image.bytes);
    this.save({...task,title,url,assignee,status:'completed',sourceId:job.sourceId,jobId:job.id,hasScreenshot:Boolean(image),attachedToProject:attachToProject,completedAt:now()});
    this.collector.kick();return {task:this.get(id),job};
  }
  update(id,input) {
    const task=this.get(id);if(task.status!=='open')throw new AppError('此任务已经处理',409);
    if(input.action==='skip')task.status='skipped';
    else if(input.action==='assign')task.assignee=text(input.assignee||'',100,'负责人');
    else throw new AppError('人工任务操作无效');
    return this.save(task);
  }
  attachmentsForDocument(doc) {
    const ids=new Set(doc.origins.map(origin=>origin.sourceId));
    return this.store.db.prepare('SELECT data_json FROM research_handoffs').all().map(r=>JSON.parse(r.data_json))
      .filter(t=>t.hasScreenshot&&!t.uploadId&&ids.has(t.sourceId)).map(t=>({url:`/api/handoffs/${t.id}/image`,title:t.title,capturedAt:t.completedAt,assignee:t.assignee}));
  }
}

export async function handoffRoute(req,url,{handoffs,research,body,json,res}) {
  const image=url.pathname.match(/^\/api\/handoffs\/([\w-]+)\/image$/);
  if(image&&req.method==='GET') {
    const row=handoffs.store.db.prepare('SELECT mime,bytes FROM research_screenshots WHERE task_id=?').get(image[1]);
    if(!row)throw new AppError('截图不存在',404);
    res.writeHead(200,{'Content-Type':row.mime,'Content-Length':row.bytes.length,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'none'"});res.end(Buffer.from(row.bytes));return true;
  }
  const match=url.pathname.match(/^\/api\/research\/projects\/([\w-]+)\/handoffs(?:\/([\w-]+))?$/);
  if(!match)return false;
  const [,projectId,id]=match;research.get(projectId);
  if(id&&handoffs.get(id).projectId!==projectId)throw new AppError('任务不属于此研究',404);
  if(req.method==='GET'&&!id)json(res,200,{ok:true,items:handoffs.list(projectId)});
  else if(req.method==='POST') {
    const input=await body(req,8_000_000);
    if(!id)json(res,201,{ok:true,task:handoffs.create(projectId,input)});
    else if(input.action==='complete')json(res,200,{ok:true,...await handoffs.complete(id,input)});
    else json(res,200,{ok:true,task:handoffs.update(id,input)});
  }else throw new AppError('不支持此操作',405);
  return true;
}
