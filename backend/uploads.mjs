import { randomUUID } from 'node:crypto';
import { AppError, collectionInput } from './input.mjs';
import { pdfInput } from './pdf.mjs';
import { screenshot } from './handoffs.mjs';
import { UploadParser } from './upload-parser.mjs';

export class LibraryUploads {
  constructor(store,collector,{mineru,research,...options}={}){this.store=store;this.collector=collector;this.research=research;store.db.exec('CREATE TABLE IF NOT EXISTS library_uploads (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,data_json TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL)');if(mineru)this.parser=new UploadParser(this,mineru,options);}
  file(id){const row=this.store.db.prepare('SELECT * FROM library_uploads WHERE id=?').get(id);if(!row)throw new AppError('文件不存在',404);return row;}
  listInternal(){return this.store.db.prepare('SELECT data_json FROM library_uploads ORDER BY rowid').all().map(r=>JSON.parse(r.data_json));}
  public(upload){const {uploadUrl,batchId,notes,resetBatch,remoteUploaded,...safe}=upload;const doc=upload.sourceId&&this.store.documents({sourceId:upload.sourceId,limit:1,offset:0}).items[0];return {...safe,documentId:doc?.id||null};}
  list(){return this.listInternal().reverse().map(u=>this.public(u));}
  save(upload){this.store.db.prepare('UPDATE library_uploads SET source_id=?,data_json=? WHERE id=?').run(upload.sourceId||'',JSON.stringify(upload),upload.id);}
  retry(id){const upload=JSON.parse(this.file(id).data_json);if(upload.parser!=='mineru')throw new AppError('此文件未使用 MinerU');if(['queued','running','completed'].includes(upload.parseStatus))return this.public(upload);if(upload.resetBatch){delete upload.batchId;delete upload.uploadUrl;delete upload.remoteUploaded;delete upload.resetBatch;}upload.parseStatus='queued';upload.error=null;upload.startedAt=null;this.save(upload);this.parser.kick();return this.public(upload);}
  async parseExisting(id){const row=this.file(id),u=JSON.parse(row.data_json);if(u.parser==='mineru')return {upload:this.retry(id)};return this.upload({filename:u.filename,base64:Buffer.from(row.bytes).toString('base64'),title:u.title,...(u.sourceId&&this.store.sourceInput(u.sourceId).url?{url:this.store.sourceInput(u.sourceId).url}:{}),parser:'mineru'});}
  kick(){this.parser?.kick();}
  async close(){await this.parser?.close();}
  async upload(input,{projectId}={}){
    if(input.parser!==undefined&&!['local','mineru'].includes(input.parser))throw new AppError('请选择本地提取或 MinerU');
    const cloud=input.parser==='mineru';
    if(cloud&&!this.parser)throw new AppError('MinerU 服务未配置');
    if(typeof input.content!=='string'&&input.content!==undefined)throw new AppError('文字格式无效');
    const notes=(input.content||'').trim();if(notes.length>450000)throw new AppError('文字不能超过 450000 字');
    let bytes,mime,content,kind,filename;
    if(input.base64!==undefined){
      if(typeof input.filename!=='string'||!input.filename.trim()||input.filename.length>250||/[\r\n\u0000/\\]/.test(input.filename))throw new AppError('文件名无效');
      filename=input.filename;
      if(typeof input.base64!=='string'||input.base64.length>7_000_000||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64))throw new AppError('文件格式无效或超过 5 MB');
      bytes=Buffer.from(input.base64,'base64');if(!bytes.length||bytes.length>5_000_000)throw new AppError('文件须为 1 字节至 5 MB');
      if(bytes.subarray(0,5).equals(Buffer.from('%PDF-'))){
        if(!cloud){const parsed=await pdfInput({base64:input.base64,title:filename});content=parsed.content;}mime='application/pdf';kind='pdf';
      }else if(/\.(md|markdown|txt)$/i.test(filename)){
        if(bytes.length>1_000_000)throw new AppError('文本文件不能超过 1 MB');
        try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new AppError('文本文件须使用 UTF-8 编码');}
        if(!content.trim())throw new AppError('文本文件不能为空');mime='text/plain; charset=utf-8';kind='text';
      }else{
        const image=screenshot(input);mime=image.mime;kind='image';
        // An image without an accompanying transcription is an asset, not a
        // document. Keep the original bytes in the library, but do not enqueue
        // synthetic text such as “尚未提供文字摘录” into the research corpus.
        if (!cloud && !notes) {
          const id=randomUUID(),metadata={id,sourceId:'',filename,title:input.title||filename,kind,hasText:false,uploadedAt:new Date().toISOString(),size:bytes.length,parser:'local',assetOnly:true,sourceUrl:input.url||null};
          this.store.db.prepare('INSERT INTO library_uploads VALUES (?,?,?,?,?)').run(id,'',JSON.stringify(metadata),mime,bytes);
          return {upload:this.public(metadata),job:null};
        }
        content=notes;
      }
      if(notes&&kind!=='image'&&!cloud)content+=`\n\n【上传者补充说明】\n${notes}`;
    }else{
      if(!notes)throw new AppError('请选择文件，或填写要保存的文字');
      content=notes;bytes=Buffer.from(notes);filename='manual-capture.txt';mime='text/plain; charset=utf-8';kind='text';
    }
    if(cloud){
      if(!['pdf','image'].includes(kind))throw new AppError('MinerU 用于 PDF 或截图；文字文件请选择本地提取');
      if(notes.length>5000)throw new AppError('MinerU 补充说明最多 5000 字');
      const normalized=collectionInput({type:'text',title:input.title||filename,content:'等待 MinerU 解析',...(input.url?{url:input.url}:{})});
      const id=randomUUID(),upload={id,sourceId:'',filename,title:normalized.title,kind,hasText:false,uploadedAt:new Date().toISOString(),size:bytes.length,parser:'mineru',parseStatus:'queued',phase:'queued',notes,sourceUrl:normalized.url,projectId};
      this.store.db.prepare('INSERT INTO library_uploads VALUES (?,?,?,?,?)').run(id,'',JSON.stringify(upload),mime,bytes);
      this.kick();return {upload:this.public(upload),job:null};
    }
    const normalized=collectionInput({type:'text',title:input.title||filename,content,...(input.url?{url:input.url}:{})});
    const job=this.store.enqueue(normalized),id=randomUUID();
    const metadata={id,sourceId:job.sourceId,filename,title:normalized.title,kind,hasText:kind!=='image'||Boolean(notes),uploadedAt:new Date().toISOString(),size:bytes.length};
    this.store.db.prepare('INSERT INTO library_uploads VALUES (?,?,?,?,?)').run(id,job.sourceId,JSON.stringify(metadata),mime,bytes);
    this.collector.kick();return {upload:metadata,job};
  }
  attachmentsForDocument(doc){
    const sources=[...new Set(doc.origins.map(o=>o.sourceId))];
    if(!sources.length)return [];
    return this.store.db.prepare(`SELECT data_json FROM library_uploads WHERE source_id IN (${sources.map(()=>'?').join(',')})`).all(...sources).map(r=>{
      const upload=JSON.parse(r.data_json);return {...this.public(upload),url:`/api/library/uploads/${upload.id}/${upload.kind==='image'?'image':'file'}`,downloadUrl:`/api/library/uploads/${upload.id}/file`,capturedAt:upload.uploadedAt};
    });
  }
}

export async function uploadRoute(req,url,{uploads,body,json,res}){
  if(url.pathname==='/api/library/uploads'&&req.method==='POST'){json(res,202,{ok:true,...await uploads.upload(await body(req,8_000_000))});return true;}
  if(url.pathname==='/api/library/uploads'&&req.method==='GET'){json(res,200,{ok:true,items:uploads.list()});return true;}
  const retry=url.pathname.match(/^\/api\/library\/uploads\/([\w-]+)\/parse$/);
  if(retry&&req.method==='POST'){await body(req);json(res,202,{ok:true,...await uploads.parseExisting(retry[1])});return true;}
  const match=url.pathname.match(/^\/api\/library\/uploads\/([\w-]+)\/(image|file)$/);if(!match||req.method!=='GET')return false;
  const row=uploads.store.db.prepare('SELECT * FROM library_uploads WHERE id=?').get(match[1]);if(!row)throw new AppError('文件不存在',404);
  const metadata=JSON.parse(row.data_json),inline=match[2]==='image';
  if(inline&&!row.mime.startsWith('image/'))throw new AppError('此附件不是图片',404);
  res.writeHead(200,{'Content-Type':row.mime,'Content-Length':row.bytes.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'",...(!inline?{'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(metadata.filename)}`}:{})});
  res.end(Buffer.from(row.bytes));return true;
}
