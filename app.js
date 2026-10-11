import { searchFormInput } from './frontend/search-settings.js';
import { loginView, teamPanel, teamContent } from './frontend/auth.js';
import { scopeFromForm, analysisFromForm, scoresFromForm } from './frontend/market.js';
import { request, allPages, escapeHtml as esc } from './frontend/core.js';
import * as view from './frontend/views.js';
import { syncModelSettings, modelSettingsChanged } from './frontend/model-settings.js';
import { autoPanel, humanPanel, handoffForm, libraryUploadForm } from './frontend/discovery.js';

const state = { projects:[], project:null, documents:[], library:[], jobs:[], sources:[], sessions:[], config:{}, mineru:{}, searchConfig:{}, searchMeta:null, uploads:[], discovery:null, handoffs:[],
  step:1, view:'research', sourceType:'search', searchResults:null, searchQuery:'', reviewFilter:'all', findingView:'board', libraryQuery:'', report:null, busy:false, auth:{enabled:false,user:null} };
const main=document.querySelector('#mainContent'), modal=document.querySelector('#modal');
let toastTimer, refreshing=false, readerDocument=null, selection='';
const path=(suffix='',id=state.project?.id)=>`/api/research/projects/${id}${suffix?'/'+suffix:''}`;
function toast(message,error=false) {
 const el=document.querySelector('#toast'); el.textContent=message;el.className=`toast visible ${error?'error':''}`;
 clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),error?9000:4500);
 if(modal.open){let note=modal.querySelector('.modal-notice');if(!note){note=document.createElement('p');note.className='modal-notice';note.setAttribute('role','status');modal.querySelector('.modal-heading').after(note);}note.textContent=message;note.classList.toggle('error',error);}
}
function render() {
 const loginRequired=state.auth.enabled&&!state.auth.user;
 document.body.classList.toggle('auth-screen',loginRequired);
 if(loginRequired){main.innerHTML=loginView(state.auth);document.querySelector('#sidebar').innerHTML='';return;}
 document.querySelector('.avatar').textContent=state.auth.user?.username?.slice(0,1)||'我';
 document.querySelector('#sidebar').innerHTML=view.sidebar(state);
 document.querySelector('#breadcrumb').textContent=state.view==='library'?'全部资料库':state.view==='settings'?'AI 设置':state.project?.objectName||'新建研究';
 if(state.view==='library')main.innerHTML=view.library(state);
 else if(state.view==='settings')main.innerHTML=teamPanel(state)+view.settings(state);
 else if(!state.project||state.step<=2)main.innerHTML=view.brief(state);
 else main.innerHTML=({3:view.sources,4:view.collection,5:view.evidence,6:view.findings,7:view.review,8:view.report}[state.step])(state);
 main.setAttribute('aria-busy',String(state.busy));
 syncModelSettings(document.querySelector('#settingsForm'));
 syncMobileNavigation();
}
async function loadAuthentication(){state.auth=await request('/api/auth/status');if(state.auth.enabled&&!state.auth.user&&modal.open)modal.close();return !state.auth.enabled||Boolean(state.auth.user);}
function navigate(step) {
 if(!state.project&&step>2)return toast('先定义研究问题与对象。');
 state.step=step;state.view='research';state.report=null;render();saveLocation();
 main.scrollIntoView({behavior:'instant',block:'start'});document.querySelector('#sidebar').classList.remove('open');syncMobileNavigation();
}
function saveLocation() {
 const query=new URLSearchParams();if(state.project)query.set('project',state.project.id);query.set('step',String(state.step));if(state.view!=='research')query.set('view',state.view);
 history.replaceState(null,'','#'+query);
}
async function refresh({paint=true}={}) {
 if(refreshing)return;refreshing=true;
 try {
  const [projects,library,jobs,sources,config,sessions,mineru,uploads,searchConfig]=await Promise.all([request('/api/research/projects'),allPages('/api/documents'),allPages('/api/collections'),allPages('/api/sources'),request('/api/config'),request('/api/cookie-sessions'),request('/api/mineru/config'),request('/api/library/uploads'),request('/api/search/config')]);
  state.projects=projects.items;state.library=library;state.jobs=jobs;state.sources=sources;state.config=config;state.sessions=sessions.items;state.mineru=mineru;state.uploads=uploads.items;state.searchConfig=searchConfig;
  if(state.project) {const detail=await request(path());state.project=detail.project;state.documents=detail.documents;state.discovery=detail.discovery;state.handoffs=detail.handoffs||[];}
  document.querySelector('#connection').innerHTML='<i></i> 本地服务已连接';
  document.querySelector('#connection').classList.add('online');
  if(paint)render();
  else if(state.view==='research'&&[3,4].includes(state.step)){
   const auto=document.querySelector('#autoDiscoveryPanel'),human=document.querySelector('#humanHandoffPanel');
   if(auto&&!auto.contains(document.activeElement))auto.outerHTML=autoPanel(state);
   if(human&&!human.contains(document.activeElement))human.outerHTML=humanPanel(state);
  }
 } catch(error) {document.querySelector('#connection').textContent='连接失败 · 点击刷新重试';document.querySelector('#connection').classList.remove('online');throw error;}
 finally{refreshing=false;}
}
async function openProject(id) {
 const detail=await request(path('',id));state.project=detail.project;state.documents=detail.documents;state.discovery=detail.discovery;state.handoffs=detail.handoffs||[];
 state.searchResults=null;state.reviewFilter='all';state.report=null;state.step=3;state.view='research';render();saveLocation();
}
function showModal(html,wide=false) {
 modal.innerHTML=html;modal.className=wide?'wide-dialog':'';if(!modal.open)modal.showModal();
}
async function openReader(id) {
 readerDocument=(await request(`/api/documents/${id}`)).document;selection='';showModal(view.reader(readerDocument,state),true);
}
async function updateProject(suffix,data) {
 const id=state.project.id;const result=await request(path(suffix,id),{method:'POST',body:data});
 if(state.project?.id===id)state.project=result.project;state.report=null;
 await refresh();return result;
}
async function enqueue(items,projectId=state.project.id,{all=false}={}) {
 let accepted=0;let reused=0;const failures=[];
 if(all){
  try {
   const result=await request(path('collect-all',projectId),{method:'POST',body:{items}});
   accepted=result.accepted||0;reused=result.reused||0;
  } catch(error){failures.push(`批量采集：${error.message}`);}
 } else for(const input of items) {
  try {await request(path('collect',projectId),{method:'POST',body:input});accepted++;}
  catch(error){failures.push(`${input.url||input.title||'资料'}：${error.message}`);}
 }
 await refresh();
 if(failures.length)showModal(view.dialogShell('采集提交结果',`<div class="notice"><div><strong>${accepted} 项已加入后台采集</strong><span>以下 ${failures.length} 项未提交，其余任务继续运行。</span></div></div><ul class="error-list">${failures.map(e=>`<li>${esc(e)}</li>`).join('')}</ul>${view.button('查看 Agent 进度','collection','primary')}`));
 else{state.searchResults=null;navigate(4);toast(`${accepted} 项已处理${reused?`，复用 ${reused} 个已有来源`:''}`);}
}
async function ai(mode,documentId) {
 if(!state.config.hasKey){if(modal.open)modal.close();state.view='settings';render();saveLocation();toast('先配置模型密钥；也可以继续手动提取和整理。');return;}
 const projectId=state.project.id;toast('AI 正在分析选定内容，结果将保存为待确认草稿…');
 const result=await request(path('generate',projectId),{method:'POST',body:{mode,documentId}});
 if(modal.open)modal.close();await refresh();navigate(mode==='evidence'?5:6);
 toast(`已保存 ${result.added} 条${mode==='evidence'?'候选证据':'待审核发现'}${result.skipped?`；${result.skipped} 条未通过引用校验，已丢弃`:''}`,!result.added);
}
const actions={
 async refresh(){if(await loadAuthentication())await refresh();else render();toast('已更新连接状态');},
 async logout(){await request('/api/auth/logout',{method:'POST',body:{}});state.project=null;state.documents=[];state.projects=[];state.library=[];state.jobs=[];state.sources=[];state.report=null;await loadAuthentication();render();},
 async team(){const data=await request('/api/auth/users');showModal(view.dialogShell('团队成员',teamContent(data.items)));},
 home(){state.project=null;state.documents=[];navigate(1);},
 new(){if(modal.open)modal.close();state.project=null;state.documents=[];state.searchResults=null;navigate(1);document.querySelector('#question')?.focus();},
 library(){state.view='library';render();saveLocation();}, settings(){state.view='settings';render();saveLocation();},
 sources(){navigate(3);}, collection(){if(modal.open)modal.close();navigate(4);}, findings(){navigate(6);}, review(){navigate(7);}, report(){navigate(8);},
 'close-modal'(){modal.close();},
 async read(el){await openReader(el.dataset.id);},
 async attach(el){await updateProject('attach',{documentIds:[el.dataset.id]});toast('资料已加入当前研究');},
 async 'detach-document'(el){await updateProject('detach',{documentId:el.dataset.id});toast('已移出当前研究，原资料仍保留在资料库。');},
 async 'attach-reader'(el){await updateProject('attach',{documentIds:[el.dataset.id]});await openReader(el.dataset.id);toast('已加入研究，可以提取 Evidence');},
 'pick-document'(){if(!state.documents.length){navigate(3);toast('先添加或从资料库选择研究资料。');return;}showModal(view.dialogShell('选择资料，提取 Evidence',`<div class="document-picker">${state.documents.map(d=>`<button data-read="${d.id}">${view.icon('report')}<span><strong>${esc(d.title)}</strong><small>${esc(d.excerpt.slice(0,110))}</small></span>${view.icon('arrow')}</button>`).join('')}</div>`));},
 'quote-selection'(){if(!selection)return toast('先在左侧原文中选中一段文字。');const field=document.querySelector('#quoteText');field.value=selection;field.focus();},
 'generate-evidence'(el){return ai('evidence',el.dataset.id);}, 'generate-findings'(){return ai('findings');},
 'webfetch'(){state.sourceType='url';navigate(3);document.querySelector('#links')?.focus();},
 async 'auto-collect'(){const maxSources=Number(document.querySelector('#autoSourceLimit')?.value||12),depth=document.querySelector('#autoDepth')?.value||'deep';if(!Number.isInteger(maxSources)||maxSources<1||maxSources>30)throw new Error('材料数量必须是 1–30 之间的整数');if(!['standard','deep'].includes(depth))throw new Error('搜集深度选项无效');const result=await request(path('discover'),{method:'POST',body:{maxSources,depth}});state.discovery=result.discovery;await refresh();navigate(4);toast(`自动搜集已在后台开始（${depth==='deep'?'深入':'标准'}，目标 ${maxSources} 个材料），可以离开页面。`);},
 async 'stop-auto'(){await request(path('discover/cancel'),{method:'POST',body:{}});await refresh();toast('已停止后续搜索；已提交的采集和人工任务继续保留。');},
 'new-handoff'(){showModal(view.dialogShell('创建人工补采任务',handoffForm(state)));},
 'upload-library'(){showModal(view.dialogShell('直接上传到资料库',libraryUploadForm(state)));},
 'open-handoff'(el){const task=state.handoffs.find(t=>t.id===el.dataset.id);if(task)showModal(view.dialogShell('人工补采 · '+task.title,handoffForm(state,task)));},
 async 'assign-handoff'(el){const assignee=el.closest('form').elements.assignee.value;await request(path('handoffs/'+el.dataset.id),{method:'POST',body:{action:'assign',assignee}});await refresh({paint:false});toast('负责人已保存，任务继续等待人工补采。');},
 async 'skip-handoff'(el){await request(path('handoffs/'+el.dataset.id),{method:'POST',body:{action:'skip'}});modal.close();await refresh();toast('人工任务已跳过，自动搜集继续。');},
 async 'confirm-evidence'(el){await updateProject(`evidence/${el.dataset.id}`,{action:'confirm'});toast('证据已确认');},
 async 'remove-evidence'(el){await updateProject(`evidence/${el.dataset.id}`,{action:'remove'});toast('证据已移除');},
 'add-finding'(){if(!state.project.evidence.some(e=>e.verified)){navigate(5);toast('先提取并确认至少一条 Evidence。');return;}showModal(view.findingForm(state));},
 async reviewFinding(el){const note=document.querySelector(`[data-review-note="${el.dataset.id}"]`)?.value||'';await updateProject(`review/${el.dataset.id}`,{status:el.dataset.status,note});toast('审核结果已保存');},
 async recollect(el){await request(`/api/sources/${el.dataset.id}/collect`,{method:'POST',body:{}});await refresh();toast('已重新加入采集队列');},
 async 'refresh-sources'(){
  const sources=state.sources.filter(src=>state.project.sourceIds.includes(src.id)&&src.type!=='text');
  if(!sources.length){navigate(3);toast('先添加 URL 或 RSS 来源，再触发更新。');return;}
  let added=0;const failed=[];
  for(const source of sources){try{await request(`/api/sources/${source.id}/collect`,{method:'POST',body:{}});added++;}catch(error){failed.push(`${source.title||source.url}：${error.message}`);}}
  await refresh();navigate(4);toast(`${added} 个来源已加入更新队列${failed.length?`；${failed.length} 个来源未提交，其余继续`:''}`);
  if(failed.length)showModal(view.dialogShell('部分来源需要关注',`<p>已提交的 ${added} 个来源会继续更新。</p><ul class="error-list">${failed.map(message=>`<li>${esc(message)}</li>`).join('')}</ul>`));
 },
 async 'collect-search'(){const selected=[...document.querySelectorAll('[name="searchResult"]:checked')].map(el=>state.searchResults[Number(el.value)]);if(!selected.length)throw new Error('请先选择要采集的搜索结果');await enqueue(selected.map(item=>({type:'url',url:item.url,title:item.title})));},
 async 'collect-all-search'(){if(!state.searchResults?.length)throw new Error('当前没有可采集的搜索结果');await enqueue(state.searchResults.map(item=>({type:'url',url:item.url,title:item.title})),state.project.id,{all:true});},
 async 'build-report'(){state.report=await request(path('report'));render();},
 async 'skip-review'(){state.report=await request(path('report')+'?skipReview=true');state.step=8;state.view='research';render();saveLocation();toast('报告已生成，待审核发现已标注；可随时返回补审。');},
 'export-report'(){const blob=new Blob([state.report.markdown],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`${state.project.objectName.replace(/[^\p{L}\p{N} _-]/gu,'')||'research'}-研究报告.md`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Markdown 报告已导出');},
 'print-report'(){window.print();},
 'parse-existing'(el){showModal(view.dialogShell('使用 MinerU 解析原件',`<p>这份原件将发送至 MinerU 官方云服务。解析结果作为新资料入库，已有文字和 Evidence 保留。</p><div class="form-footer"><button class="button primary" data-action="retry-mineru" data-id="${el.dataset.id}">发送至 MinerU 并解析</button></div>`));},
 async 'retry-mineru'(el){await request(`/api/library/uploads/${el.dataset.id}/parse`,{method:'POST',body:{}});if(modal.open)modal.close();state.view='library';await refresh();saveLocation();toast('已加入 MinerU 后台解析队列');},
 async 'test-search'(){const form=document.querySelector('#searchSettingsForm'),result=form.querySelector('#searchTestResult');result.textContent='正在检索 Domel electric motors…';try{const data=await request('/api/search/config/test',{method:'POST',body:searchFormInput(form)});result.className='connection-result success';result.textContent=`${data.message} ${(data.latencyMs/1000).toFixed(1)} 秒。${data.warnings.join(' ')} 修改后请保存。`;}catch(error){result.className='connection-result error';result.textContent=error.message;throw error;}},
 async 'clear-mineru'(){await request('/api/mineru/config',{method:'DELETE'});await refresh();toast('MinerU Token 已清除');},
 async 'test-mineru'(){const form=document.querySelector('#mineruSettingsForm');const result=form.querySelector('#mineruTestResult');result.textContent='正在验证 MinerU 上传接口…';try{const data=await request('/api/mineru/config/test',{method:'POST',body:Object.fromEntries(new FormData(form))});result.className='connection-result success';result.textContent=`${data.message} ${(data.latencyMs/1000).toFixed(1)} 秒；修改后请保存。`;}catch(error){result.className='connection-result error';result.textContent=error.message;throw error;}},
 async 'clear-key'(){await request('/api/config',{method:'DELETE'});await refresh();toast('密钥已清除');},
 async 'test-model'(){
  const form=document.querySelector('#settingsForm');if(!form.reportValidity())return;
  const input=Object.fromEntries(new FormData(form)),result=form.querySelector('#modelTestResult'),fields=form.querySelector('fieldset');
  result.className='connection-result';result.textContent='正在发送测试消息…';fields.disabled=true;
  try{
   const data=await request('/api/config/test',{method:'POST',body:input});
   result.textContent=`连接成功 · ${data.model} · ${(data.latencyMs/1000).toFixed(1)} 秒。当前表单已测试；如有修改，请保存配置。`;
   result.className='connection-result success';
  }catch(error){result.textContent=error.message;result.className='connection-result error';throw error;}
  finally{fields.disabled=false;}
 }
};
// A busy operation locks only this tab's controls. Server-side collection never waits for the UI.
async function perform(task,control) {
 if(state.busy)return;
 state.busy=true;main.setAttribute('aria-busy','true');const label=control?.innerHTML;
 if(control){control.disabled=true;control.classList.add('loading');}
 document.body.classList.add('working');
 try {await task();}catch(error){if(error.code==='AUTHENTICATION_REQUIRED'){await loadAuthentication();render();}toast(error.message,true);}
 finally{state.busy=false;main.setAttribute('aria-busy','false');document.body.classList.remove('working');if(control?.isConnected){control.disabled=false;control.classList.remove('loading');control.innerHTML=label;}}
}
document.addEventListener('click',event=>{
 const control=event.target.closest('button,[data-action]');if(!control)return;
 const {action,step,project,sourceType,read,reviewFilter,findingView}=control.dataset;
 if(action||step||project||sourceType||read||reviewFilter||findingView)event.preventDefault();
 if(action==='close-modal'){modal.close();return;}
 if(state.busy)return;
 if(control.closest('#sidebar')){document.querySelector('#sidebar').classList.remove('open');syncMobileNavigation();}
 if(step)navigate(Number(step));
 else if(project)void perform(()=>openProject(project),control);
 else if(sourceType){state.sourceType=sourceType;state.searchResults=null;render();}
 else if(read)void perform(()=>openReader(read),control);
 else if(reviewFilter){state.reviewFilter=reviewFilter;render();}
 else if(findingView){state.findingView=findingView;render();}
 else if(action)void perform(()=>action==='review'&&control.dataset.id?actions.reviewFinding(control):actions[action]?.(control),control);
});
document.addEventListener('change',modelSettingsChanged);
document.addEventListener('input',event=>{if(event.target.closest('#settingsForm'))modelSettingsChanged(event);});
const mobileQuery=matchMedia('(max-width:720px)');
function syncMobileNavigation(){const sidebar=document.querySelector('#sidebar');sidebar.inert=mobileQuery.matches&&!sidebar.classList.contains('open');document.querySelector('#menuButton').setAttribute('aria-expanded',String(sidebar.classList.contains('open')));}
mobileQuery.addEventListener('change',syncMobileNavigation);
document.querySelector('#menuButton').addEventListener('click',()=>{document.querySelector('#sidebar').classList.toggle('open');syncMobileNavigation();});
document.addEventListener('selectionchange',()=>{
 if(!modal.open)return;const current=window.getSelection();const text=document.querySelector('#documentText');
 if(text&&current&&!current.isCollapsed&&text.contains(current.anchorNode)&&text.contains(current.focusNode))selection=current.toString();
});
document.addEventListener('input',event=>{
 if(event.target.id==='librarySearch'){
  const start=event.target.selectionStart;state.libraryQuery=event.target.value;render();const next=document.querySelector('#librarySearch');next.focus();next.setSelectionRange(start,start);
 }
});
document.addEventListener('submit',event=>{
 const form=event.target;if(!['projectForm','sourceForm','evidenceForm','findingForm','settingsForm','loginForm','memberForm','handoffForm','handoffCaptureForm','libraryUploadForm','mineruSettingsForm','searchSettingsForm'].includes(form.id))return;
 event.preventDefault();const data=new FormData(form);const control=form.querySelector('[type="submit"]');
 void perform(async()=>{
  if(form.id==='loginForm') {
   if(state.auth.needsSetup&&data.get('password')!==data.get('confirmPassword'))throw new Error('两次密码不一致');
   await request('/api/auth/'+(state.auth.needsSetup?'setup':'login'),{method:'POST',body:{username:data.get('username'),password:data.get('password')}});
   await loadAuthentication();await refresh();toast('已登录研究工作区');
  } else if(form.id==='memberForm') {
   await request('/api/auth/users',{method:'POST',body:{username:data.get('username'),password:data.get('password'),role:'analyst'}});
   await actions.team();toast('研究成员已创建');
  } else if(form.id==='projectForm') {
   const input={question:data.get('question'),objectName:data.get('objectName'),objectType:data.get('objectType'),scope:scopeFromForm(data)};const result=await request(state.project?path('edit'):'/api/research/projects',{method:'POST',body:input});
   state.project=result.project;await refresh();navigate(3);
   if(data.get('autoCollect'))await actions['auto-collect']();else toast('研究已保存，可以自动搜集或添加指定来源');
  } else if(form.id==='handoffForm') {
   await request(path('handoffs'),{method:'POST',body:Object.fromEntries(data)});modal.close();await refresh();toast('人工任务已创建，不影响后台采集。');
  } else if(form.id==='handoffCaptureForm') {
   const input=Object.fromEntries(data);delete input.attachment;input.action='complete';input.attachToProject=data.has('attachToProject');
   const file=data.get('attachment');if(file?.size){if(file.size>5_000_000)throw new Error('附件不能超过 5 MB');input.attachment={filename:file.name,base64:await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('附件读取失败'));reader.readAsDataURL(file);})};}
   await request(path('handoffs/'+form.dataset.id),{method:'POST',body:input});modal.close();await refresh();toast(input.attachToProject?'补采文字与附件已保存到资料库，并加入当前研究。':'补采文字与附件已直接保存到资料库。');
  } else if(form.id==='libraryUploadForm') {
   const input=Object.fromEntries(data);delete input.file;const file=data.get('file');
   if(file?.size){if(file.size>5_000_000)throw new Error('文件不能超过 5 MB');input.filename=file.name;input.base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('文件读取失败'));reader.readAsDataURL(file);});}
   await request('/api/library/uploads',{method:'POST',body:input});modal.close();state.view='library';await refresh();saveLocation();toast('资料已上传，正在整理入库。');
  } else if(form.id==='sourceForm') {
   const type=state.sourceType,id=state.project.id;
   if(type==='search'){
    const result=await request('/api/search',{method:'POST',body:{query:data.get('query'),limit:10}});
    state.searchResults=result.results||result.items||[];state.searchMeta={provider:result.provider,warnings:result.warnings||[]};state.searchQuery='';
    document.querySelector('#searchResults').innerHTML=view.searchResults(state);document.querySelector('#searchResults').scrollIntoView({behavior:'smooth',block:'start'});
   }else if(type==='url'||type==='feed'){
    const links=[...new Set(String(data.get('links')).split(/\r?\n/).map(s=>s.trim()).filter(Boolean))];
    if(!links.length||links.length>10)throw new Error('每次填写 1–10 个链接，每行一个');
    await enqueue(links.map(url=>({type,url,...(data.get('sessionId')?{sessionId:data.get('sessionId')}:{}) ,...(type==='url'&&data.get('renderMode')?{renderMode:'playwright',fullPage:true}:{} )})),id);
   }else if(type==='manual'){
    await enqueue([{type:'text',title:data.get('title'),content:data.get('content'),...(data.get('url')?{url:data.get('url')}:{})}],id);
   }else{
    const file=data.get('file');if(!file?.size)throw new Error('请选择非空文件');
    if(type==='pdf'){
     if(file.size>5_000_000)throw new Error('PDF 文件不能超过 5 MB');
     const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('文件读取失败'));reader.readAsDataURL(file);});
     await request(path('pdf',id),{method:'POST',body:{title:file.name,base64}});await refresh();navigate(4);toast('PDF 文字已提取，正在保存资料');
    }else{
     if(file.size>1_000_000)throw new Error('文本文件不能超过 1 MB');
     const content=await file.text();if(content.length>450000)throw new Error('文本不能超过 450,000 字');
     await enqueue([{type:'text',title:file.name,content}],id);
    }
   }
  }else if(form.id==='evidenceForm'){
   await updateProject('evidence',{documentId:form.dataset.document,quote:data.get('quote'),note:data.get('note'),...analysisFromForm(data,true)});modal.close();navigate(5);toast('Evidence 已保存，原文已核验');
  }else if(form.id==='findingForm'){
   const marketScores=scoresFromForm(data);
   await updateProject('findings',{marketScores,title:data.get('title'),body:data.get('body'),category:data.get('category'),evidenceIds:[...new Set([...data.getAll('evidenceIds'),...Object.values(marketScores).flatMap(c=>c.evidenceIds)])],...analysisFromForm(data)});modal.close();navigate(6);toast('发现已保存，可以审核或直接生成报告');
  }else if(form.id==='searchSettingsForm'){
   await request('/api/search/config',{method:'POST',body:searchFormInput(form)});await refresh();toast('搜索配置已保存，后续搜索与自动搜集将使用此服务');
  }else if(form.id==='mineruSettingsForm'){
   await request('/api/mineru/config',{method:'POST',body:Object.fromEntries(data)});await refresh();toast('MinerU 配置已保存');
  }else if(form.id==='settingsForm'){
   const config=await request('/api/config',{method:'POST',body:Object.fromEntries(data)});await refresh();toast(config.hasKey?'模型配置已保存；可点击测试连接':'配置已保存，请填写对应服务商密钥');
  }
 },control);
});
modal.addEventListener('click',event=>{if(event.target===modal){const box=modal.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)modal.close();}});
async function boot(){
 try{if(!await loadAuthentication()){render();return;}render();await refresh();const route=new URLSearchParams(location.hash.slice(1));const id=route.get('project');
 if(id&&state.projects.some(p=>p.id===id)){const detail=await request(path('',id));state.project=detail.project;state.documents=detail.documents;state.discovery=detail.discovery;state.handoffs=detail.handoffs||[];state.step=Math.max(1,Math.min(8,Number(route.get('step'))||3));}
 if(['library','settings'].includes(route.get('view')))state.view=route.get('view');render();
 }catch(error){toast(error.message,true);main.innerHTML=view.heading('WORKSPACE','工作区暂时无法连接','研究数据仍保存在本机。请确认后端服务运行后重试。',view.button('重新连接','refresh','primary'));}
}
setInterval(()=>{
 const editing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
 if(document.hidden||state.busy||modal.open||refreshing||state.auth.enabled&&!state.auth.user)return;
 if(state.uploads.some(u=>['queued','running'].includes(u.parseStatus))||state.jobs.some(j=>['running','queued'].includes(j.status))||state.discovery&&['running','queued'].includes(state.discovery.status))void refresh({paint:!editing&&(state.view==='library'||state.view==='research'&&state.step===4)}).catch(error=>toast(error.message,true));
},2500);
void boot();
