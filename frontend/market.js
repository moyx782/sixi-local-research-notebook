import { escapeHtml as esc } from './core.js';
export const dimensions = {structure:'市场结构与发展',competition:'竞争与替代品',demand:'客户需求与细分',technology:'技术趋势',environment:'外部环境',attractiveness:'市场吸引力',strategy:'战略建议'};
export const levels = {unassessed:'未评估',primary:'一级资料',secondary:'二手资料'};
const ratings={unassessed:'证据不足 / 未评估',high:'高',medium:'中',low:'低'};
const options=(map,value)=>Object.entries(map).map(([key,label])=>`<option value="${key}" ${key===value?'selected':''}>${label}</option>`).join('');
const scopeFields={market:'市场边界',geography:'地域范围',period:'复盘周期',segments:'客户与应用细分',validationPlan:'访谈与核实计划',monitoringPlan:'持续跟踪计划'};
export function defaultScope() {
 const now=new Date();return {market:'工业电机与机电设备',geography:'中国市场，结合全球竞争格局',period:`${now.getFullYear()} Q${Math.floor(now.getMonth()/3)+1}`,
 segments:'',dimensions:Object.keys(dimensions),validationPlan:'与 Domel 市场经理、业务拓展和产品策略人员核实关键发现，记录不同意见与原始依据。',monitoringPlan:'按季度复盘；跟踪竞品产品更新、客户应用需求、技术变化与外部环境，补采资料后更新 Evidence 与 Findings。'};
}
export function scopeForm(project,step) {
 const scope=project?.scope||defaultScope();
 return `<details class="market-scope" ${step===2?'open':''}><summary><span>Domel 战略市场研究框架 <small>季度复盘</small></span><span>${esc(scope.market||'设置市场边界')} · ${esc(scope.period||'设置周期')} <b>⌄</b></span></summary><div class="scope-body"><div class="two-fields"><label>市场边界<input name="scopeMarket" maxlength="500" value="${esc(scope.market)}" placeholder="纳入哪些产品、技术与行业；排除什么"></label><label>地域范围<input name="scopeGeography" maxlength="300" value="${esc(scope.geography)}" placeholder="例如：中国 / 欧洲 / 全球"></label></div><div class="two-fields"><label>复盘周期<input name="scopePeriod" maxlength="100" value="${esc(scope.period)}" placeholder="例如：2026 Q3"></label><label>客户与应用细分<input name="scopeSegments" maxlength="1000" value="${esc(scope.segments)}" placeholder="例如：工业自动化、园林工具、清洁设备"></label></div><fieldset class="dimension-checks"><legend>本次研究维度</legend>${Object.entries(dimensions).map(([key,label])=>`<label><input name="scopeDimensions" type="checkbox" value="${key}" ${(scope.dimensions||[]).includes(key)?'checked':''}><span>${label}</span></label>`).join('')}</fieldset><label>访谈与核实计划<textarea name="scopeValidationPlan" rows="2" maxlength="2000">${esc(scope.validationPlan)}</textarea></label><label>持续跟踪计划<textarea name="scopeMonitoringPlan" rows="2" maxlength="2000">${esc(scope.monitoringPlan)}</textarea></label><p class="field-hint">访谈用于核实发现。当前支持手动触发更新与 RSS 抓取，定时调度尚未开启。</p></div></details>`;
}
export function scopeFromForm(data) {
 return Object.fromEntries([...Object.keys(scopeFields).map(key=>[key,data.get('scope'+key[0].toUpperCase()+key.slice(1))||'']),['dimensions',data.getAll('scopeDimensions')]]);
}
export function evidenceFields() {
 return `<details class="analysis-fields"><summary>分类与来源评估 <span>支持后续战略分析</span></summary><div class="analysis-fields-body"><label>研究维度<select name="dimension">${options(dimensions,'structure')}</select></label><label>涉及公司 / 产品<input name="entity" maxlength="300" placeholder="例如：Domel 720"></label><label>客户 / 应用细分<input name="segment" maxlength="500" placeholder="例如：电池驱动园林工具"></label><label>来源层级<select name="sourceLevel">${options(levels,'unassessed')}</select></label><label>可信度与局限<textarea name="credibility" rows="3" maxlength="2000" placeholder="直接资料还是转述？是否及时？可能有哪些偏差？"></textarea></label></div></details>`;
}
export function evidenceMetadata(e) {
 return `<div class="evidence-tags"><span>${dimensions[e.dimension]||dimensions.structure}</span><span>${levels[e.sourceLevel]||levels.unassessed}</span>${e.entity?`<span>${esc(e.entity)}</span>`:''}${e.segment?`<span>${esc(e.segment)}</span>`:''}</div>${e.credibility?`<p class="source-evaluation"><strong>来源评估</strong>${esc(e.credibility)}</p>`:''}`;
}
export function findingFields(evidence=[]) {
 return `<details class="analysis-fields"><summary>市场分析与战略意义 <span>可选</span></summary><div class="analysis-fields-body"><div class="two-fields"><label>研究维度<select name="dimension">${options(dimensions,'structure')}</select></label><label>市场吸引力判断<select name="attractiveness">${options(ratings,'unassessed')}</select></label></div><div class="two-fields"><label>涉及公司 / 产品<input name="entity" maxlength="300" placeholder="对比对象"></label><label>客户 / 应用细分<input name="segment" maxlength="500" placeholder="哪类客户或场景"></label></div><label>对 Domel 的影响<textarea name="implication" rows="2" maxlength="2000" placeholder="与产品规划、市场进入或业务拓展的关系"></textarea></label><label>情景与假设<textarea name="scenario" rows="2" maxlength="2000" placeholder="假设、驱动因素、可观察信号，以及尚待验证的条件"></textarea></label><label>战略建议<textarea name="recommendation" rows="2" maxlength="2000" placeholder="基于证据建议采取什么行动？需要怎样验证？"></textarea></label>${scoreForm(evidence)}</div></details>`;
}
export function analysisFromForm(data,isEvidence=false) {
 const keys=isEvidence?['dimension','entity','segment','sourceLevel','credibility']:['dimension','entity','segment','attractiveness','implication','scenario','recommendation'];
 return Object.fromEntries(keys.map(key=>[key,data.get(key)||'']));
}
export function findingExtras(f) {
 return `${scoreDisplay(f.marketAssessment)}${f.entity||f.segment?`<p class="finding-context">${esc([f.entity,f.segment].filter(Boolean).join(' · '))}</p>`:''}
 ${f.attractiveness&&f.attractiveness!=='unassessed'?`<p class="finding-assessment">市场吸引力：<strong>${ratings[f.attractiveness]}</strong><span>研究判断</span></p>`:''}
 ${[['implication','对 Domel 的影响'],['scenario','情景与假设'],['recommendation','战略建议']].map(([key,label])=>f[key]?`<div class="strategic-note"><strong>${label}</strong><p>${esc(f[key])}</p></div>`:'').join('')}`;
}
export function marketNav(s) {
 return `<div class="market-view-tabs" aria-label="分析视图">${[['board','发现看板'],['comparison','竞争对比'],['demand','客户需求'],['strategy','吸引力与战略建议']].map(([key,label])=>`<button class="${s.findingView===key?'active':''}" data-finding-view="${key}">${label}</button>`).join('')}</div>`;
}
function refs(f,p) {return f.evidenceIds.map(id=>`E${p.evidence.findIndex(e=>e.id===id)+1}`).join(' · ');}
export function analysisView(s) {
 const p=s.project, findings=p.findings.filter(f=>f.status!=='reject');
 if(s.findingView==='demand') {
 const rows=findings.filter(f=>f.dimension==='demand');
 return `<section class="panel analysis-panel"><div class="section-heading"><h2>客户需求与应用细分</h2><span class="badge">${rows.length} 条发现</span></div><p class="field-hint">按“客户需求与细分”研究维度整理；访谈记录可通过 Manual Capture 加入并提取证据。</p>${rows.length?`<div class="strategy-grid">${rows.map(f=>`<article class="strategy-card"><span class="badge">${f.status==='keep'?'Keep':f.status==='investigate'?'待调查':'未审核'}</span><h3>${esc(f.title)}</h3><p>${esc(f.body)}</p>${findingExtras(f)}<div class="strategy-refs">引用 ${refs(f,p)}</div></article>`).join('')}</div>`:'<div class="analysis-empty">暂无客户需求类发现。先收集客户应用资料或访谈记录，再基于原文整理需求。</div>'}</section>`;
 }
 if(s.findingView==='comparison') {
 const rows=findings.filter(f=>f.category==='competitor'||f.dimension==='competition');
 return `<section class="panel analysis-panel"><div class="section-heading"><h2>竞争对手与替代方案</h2><span class="badge">${rows.length} 条证据支持的判断</span></div><p class="field-hint">使用“竞争”类型或“竞争与替代品”维度的发现。对比沿用原文证据，不自动推断市场排名。</p>${rows.length?`<div class="table-scroll"><table class="comparison-table"><thead><tr><th>公司 / 产品</th><th>客户与应用</th><th>判断与局限</th><th>证据</th><th>状态</th></tr></thead><tbody>${rows.map(f=>`<tr><td><strong>${esc(f.entity||'待明确对象')}</strong></td><td>${esc(f.segment||'未注明')}</td><td><strong>${esc(f.title)}</strong><p>${esc(f.body)}</p></td><td>${refs(f,p)}</td><td>${{draft:'未审核',keep:'Keep',investigate:'待调查'}[f.status]}</td></tr>`).join('')}</tbody></table></div>`:'<div class="analysis-empty">暂无竞争类发现。添加带公司 / 产品名称和引用证据的发现，即可建立对比。</div>'}</section>`;
 }
 const rows=findings.filter(f=>f.marketAssessment?.coverage||f.implication||f.recommendation||f.scenario||f.attractiveness&&f.attractiveness!=='unassessed');
 return `<section class="panel analysis-panel"><div class="section-heading"><h2>从市场判断到行动建议</h2><span class="badge">${rows.length} 条分析</span></div><p class="field-hint">吸引力评价和情景属于研究判断；结合证据、假设与访谈验证后使用。</p>${rows.length?`<div class="strategy-grid">${rows.map(f=>`<article class="strategy-card"><span class="badge">${{draft:'未审核',keep:'Keep',investigate:'待调查'}[f.status]}</span><h3>${esc(f.title)}</h3><p>${esc(f.body)}</p>${findingExtras(f)}<div class="strategy-refs">引用 ${refs(f,p)}</div></article>`).join('')}</div>`:'<div class="analysis-empty">在“手动整理 → 市场分析与战略意义”中添加吸引力判断、情景假设与战略建议；也可使用 AI 基于已确认的证据生成。</div>'}</section>`;
}
export function reportScope(p) {
 const scope=p.scope;if(!scope)return '';
 return `<section class="report-scope"><h2>市场范围与研究任务</h2><dl>${['market','geography','period','segments'].map(key=>scope[key]?`<div><dt>${scopeFields[key]}</dt><dd>${esc(scope[key])}</dd></div>`:'').join('')}</dl><p>${(scope.dimensions||[]).map(d=>dimensions[d]).join(' · ')}</p></section>`;
}
export function reportPlan(p) {
 const scope=p.scope;if(!scope?.validationPlan&&!scope?.monitoringPlan)return '';
 return `<section><h2>验证与持续情报计划</h2>${scope.validationPlan?`<h3>员工访谈与来源核查</h3><p>${esc(scope.validationPlan)}</p><p class="field-hint">这是验证计划，不代表访谈已经执行。</p>`:''}${scope.monitoringPlan?`<h3>持续跟踪</h3><p>${esc(scope.monitoringPlan)}</p>`:''}<p class="field-hint">当前采集由用户手动触发，支持 RSS / Atom；尚未启用定时调度。</p></section>`;
}
export function monitoring(s) {
 const feeds=s.sources.filter(src=>s.project.sourceIds.includes(src.id)&&src.type==='feed');
 return `<section class="panel monitoring-panel"><div><div class="eyebrow">QUARTERLY MARKET INTELLIGENCE</div><h2>为下一轮复盘积累信号</h2><p>${esc(s.project.scope?.monitoringPlan||'持续收集竞品动态、客户需求和技术变化，再回到 Evidence 核实新发现。')}</p><span class="badge">${feeds.length} 个 RSS 来源</span><span class="monitoring-status">当前：手动触发更新 · 未开启定时调度</span></div><button class="button" data-action="refresh-sources">更新所有研究来源</button></section>`;
}

export const marketCriteria = {demand:['客户需求强度',25],growth:['市场发展潜力',20],competition:['竞争环境有利度',20],access:['市场进入可行性',15],fit:['Domel 战略匹配度',20]};
export function scoreForm(evidence) {
 return `<details class="score-form"><summary>市场吸引力评分 <span>有证据才评分</span></summary><p class="field-hint">各项 1–5 分，5 表示最有利。必须填写依据并引用证据；未完成五项时不计算总分。权重为原型假设，待团队验证。</p>${Object.entries(marketCriteria).map(([key,[label,weight]])=>`<div class="score-row"><div class="score-row-title">${label}<span>权重 ${weight}%</span></div><div class="two-fields"><label>评分<select name="score_${key}"><option value="">未评分</option>${[1,2,3,4,5].map(n=>`<option value="${n}">${n} / 5</option>`).join('')}</select></label><label>引用证据<select name="scoreEvidence_${key}"><option value="">选择 Evidence</option>${evidence.map((e,i)=>e.verified?`<option value="${e.id}">E${i+1} · ${esc(e.quote.slice(0,55))}</option>`:'').join('')}</select></label></div><label>评分依据<textarea name="scoreBasis_${key}" rows="2" maxlength="1000" placeholder="证据如何支持此分数？有什么局限？"></textarea></label></div>`).join('')}</details>`;
}
export function scoresFromForm(data) {
 const scores={};for(const key of Object.keys(marketCriteria)){const score=data.get('score_'+key);if(score)scores[key]={score:Number(score),basis:data.get('scoreBasis_'+key)||'',evidenceIds:[data.get('scoreEvidence_'+key)].filter(Boolean)};}return scores;
}
export function scoreDisplay(value) {
 if(!value?.coverage)return '';
 return `<div class="market-score"><div class="score-total"><span>市场吸引力 · 原型评分</span><strong>${value.score===null?'待补充':value.score+'<small>/100</small>'}</strong></div><p>${value.score===null?`已评 ${value.coverage}/5 项，不计算总分`:'五项加权评分，数值越高越有利'}</p><dl>${Object.entries(value.criteria).map(([key,c])=>`<div><dt>${marketCriteria[key][0]} <small>${marketCriteria[key][1]}%</small></dt><dd><strong>${c.score}/5</strong><span>${esc(c.basis)}</span></dd></div>`).join('')}</dl><small>权重尚待 Domel 团队验证，不等同于市场预测。</small></div>`;
}
