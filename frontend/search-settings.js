import { escapeHtml as esc } from './core.js';

export const searchName = s => s.searchConfig?.provider === 'searxng' ? '本地 SearxNG' : 'DuckDuckGo';
export function searchSettings(s) {
 const c=s.searchConfig||{},admin=!s.auth?.enabled||s.auth.user?.role==='admin';
 return `<section class="panel settings-panel"><div class="section-heading"><h2>搜索与网页采集</h2><span class="badge">${searchName(s)}</span></div><p class="muted">SearxNG 搜索公开网页，WebFetch 抓取结果正文并保存出处。搜索和网页采集无需模型密钥。</p>
 <form id="searchSettingsForm"><fieldset ${admin?'':'disabled'}><label>搜索服务<select name="provider"><option value="searxng" ${c.provider==='searxng'?'selected':''}>本地 SearxNG</option><option value="duckduckgo" ${c.provider!=='searxng'?'selected':''}>DuckDuckGo</option></select></label><label>SearxNG Endpoint<input name="endpoint" type="url" required value="${esc(c.endpoint||'http://127.0.0.1:8888/search')}"></label><p class="field-hint">仅连接本机服务。默认地址：http://127.0.0.1:8888/search；无需 API Key。</p><label class="auto-start-choice"><input name="fallback" type="checkbox" ${c.fallback!==false?'checked':''}><span>SearxNG 不可用时，尝试 DuckDuckGo<small>会记录实际使用的搜索服务与失败原因。</small></span></label><div class="form-footer"><button type="button" class="button" data-action="test-search">测试搜索连接</button><button type="submit" class="button primary">保存搜索配置</button></div><p id="searchTestResult" class="connection-result" role="status"></p></fieldset>${admin?'':'<p class="field-hint">仅管理员可修改搜索配置。</p>'}</form><p class="field-hint">已有网址：在「信息源 → WebFetch / URL」直接粘贴，跳过搜索；需要人工登录的页面不会阻塞其他资料。</p></section>`;
}

export function searchFormInput(form) {
 const data=new FormData(form);
 return {provider:data.get('provider'),endpoint:data.get('endpoint'),fallback:data.has('fallback')};
}
