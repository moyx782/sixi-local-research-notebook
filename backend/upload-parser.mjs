import { setTimeout as delay } from 'node:timers/promises';
import { AppError, collectionInput } from './input.mjs';

const active = u => u.parser === 'mineru' && ['queued','running'].includes(u.parseStatus);
export class UploadParser {
  constructor(uploads,mineru,{pollMs=3000,deadlineMs=30*60*1000}={}) {
    this.uploads=uploads;this.mineru=mineru;this.pollMs=pollMs;this.deadlineMs=deadlineMs;
    this.controller=new AbortController();this.running=null;this.stopped=false;
  }
  kick(){if(this.stopped||this.running)return;this.running=this.drain().finally(()=>{this.running=null;});}
  async drain(){while(!this.stopped){const upload=this.uploads.listInternal().find(active);if(!upload)return;await this.run(upload);}}
  async run(upload){
    const save=()=>this.uploads.save(upload);
    const signal=this.controller.signal;
    try {
      const config=await this.mineru.readConfig();
      if(!config.token)throw new AppError('请先在 AI 设置中保存 MinerU Token，再点击重试',409);
      upload.parseStatus='running';upload.startedAt||=new Date().toISOString();upload.model||=config.model;upload.language||=config.language;save();
      const settings={...config,model:upload.model,language:upload.language};
      if(!upload.batchId){Object.assign(upload,await this.mineru.allocate(settings,upload,signal));upload.phase='uploading';save();}
      if(!upload.remoteUploaded){
        const row=this.uploads.file(upload.id);
        await this.mineru.upload(upload.uploadUrl,Buffer.from(row.bytes),signal);
        upload.remoteUploaded=true;delete upload.uploadUrl;upload.phase='pending';save();
      }
      let markdown;
      while(!signal.aborted){
        if(Date.now()-Date.parse(upload.startedAt)>this.deadlineMs)throw new AppError('MinerU 解析等待超过 30 分钟，原件已保留，可稍后重试',504);
        const status=await this.mineru.status(settings,upload.batchId,upload.id,upload.remoteFilename||upload.filename,signal);
        upload.phase=status.state;
        if(status.progress)upload.progress={extractedPages:Number(status.progress.extracted_pages)||0,totalPages:Number(status.progress.total_pages)||0};
        save();
        if(status.state==='failed'){upload.resetBatch=true;throw new AppError('MinerU 未能解析此文件，请检查原件或稍后重试',422);}
        if(status.state==='done'){markdown=await this.mineru.result(status.zipUrl,signal);break;}
        await delay(this.pollMs,undefined,{signal});
      }
      signal.throwIfAborted();
      if(typeof markdown!=='string'||!markdown.trim()||markdown.length>440000)throw new AppError('MinerU 解析文字为空或超过 440000 字');
      const content=`【MinerU 解析 · ${upload.model}】\n文件：${upload.filename}\n说明：以下为机器提取结果，引用前请对照原件核实。\n\n${markdown}${upload.notes?`\n\n【上传者补充说明】\n${upload.notes}`:''}`;
      const normalized=collectionInput({type:'text',title:upload.title,content,...(upload.sourceUrl?{url:upload.sourceUrl}:{})});
      const job=this.uploads.store.enqueue(normalized);
      Object.assign(upload,{sourceId:job.sourceId,jobId:job.id,hasText:true,parseStatus:'completed',phase:'done',finishedAt:new Date().toISOString(),error:null});save();
      if(upload.projectId)this.uploads.research?.mutate(upload.projectId,p=>{if(!p.sourceIds.includes(job.sourceId))p.sourceIds.push(job.sourceId);});
      this.uploads.collector.kick();
    } catch(error) {
      if(signal.aborted){upload.parseStatus='queued';save();return;}
      if(error.code==='MINERU_EXPIRED'||upload.phase==='uploading')upload.resetBatch=true;
      upload.parseStatus='failed';upload.error=error instanceof AppError?error.message:'文件解析失败，原件已保留，请稍后重试';save();
    }
  }
  async close(){this.stopped=true;this.controller.abort();await this.running;await this.mineru.close();}
}
