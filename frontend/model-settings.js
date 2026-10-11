import { escapeHtml as esc } from './core.js';

export const modelPresets = {
  deepseek: { provider: 'deepseek', protocol: 'openai-chat', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash' },
  'deepseek-anthropic': { provider: 'deepseek', protocol: 'anthropic-messages', endpoint: 'https://api.deepseek.com/anthropic/v1/messages', model: 'deepseek-flash' },
};

export function modelSettingsForm(config, canEdit = true) {
  return `<form id="settingsForm"><fieldset class="model-settings-fields" ${canEdit ? '' : 'disabled'}>
    <label>快速配置<select id="modelPreset"><option value="">保留当前配置 / 自定义</option><option value="deepseek">DeepSeek · Chat Completions</option><option value="deepseek-anthropic">DeepSeek · Anthropic Messages</option></select></label>
    <div class="two-fields"><label>服务商标识（Provider）<input name="provider" required value="${esc(config.provider || 'anthropic')}" placeholder="deepseek / anthropic / 自定义名称"></label>
    <label>API 协议<select name="protocol">${[['builtin','内置服务商 · 自动匹配'],['openai-chat','OpenAI 兼容 · Chat Completions'],['anthropic-messages','Anthropic 兼容 · Messages']].map(([value,label]) => `<option value="${value}" ${(config.protocol || 'builtin') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
    <label>Endpoint<input name="endpoint" type="url" value="${esc(config.endpoint || '')}" placeholder="https://api.deepseek.com/chat/completions" ${config.protocol && config.protocol !== 'builtin' ? 'required' : 'disabled'} aria-describedby="endpointHint"></label>
    <p class="field-hint" id="endpointHint"></p>
    <label>模型 ID（Model）<input name="model" required value="${esc(config.model || '')}" list="modelSuggestions" placeholder="例如 deepseek-flash"></label>
    <datalist id="modelSuggestions"><option value="deepseek-flash"></option><option value="deepseek-v4-pro"></option></datalist>
    <label>API Key<input name="apiKey" type="password" autocomplete="off" placeholder="${config.hasKey ? '已保存；同一连接留空保留密钥' : '输入所选服务商的密钥'}"></label>
    <p class="field-hint" id="modelKeyHint">${config.hasKey ? '修改服务商、协议或 Endpoint 后，需要重新填写对应密钥。' : '密钥只保存在本机服务端。'}<br>测试连接发送一条简短测试消息，不包含研究资料，可能产生少量 API 费用。</p>
    <div class="form-footer model-settings-actions"><button type="button" class="button ghost" data-action="clear-key">清除密钥</button><button type="button" class="button" data-action="test-model">测试连接</button><button type="submit" class="button primary">保存配置</button></div>
    </fieldset><p id="modelTestResult" class="connection-result" role="status" aria-live="polite">${canEdit ? '保存不会自动测试连接。' : '仅管理员可修改或测试模型连接。'}</p></form>`;
}

export function syncModelSettings(form) {
  if (!form) return;
  const protocol = form.elements.protocol.value;
  const builtin = protocol === 'builtin';
  form.elements.endpoint.disabled = builtin;
  form.elements.endpoint.required = !builtin;
  form.querySelector('#endpointHint').textContent = builtin
    ? '由内置模型库选择接口地址。使用 DeepSeek 或自定义网关时，请选择具体协议。'
    : protocol === 'openai-chat'
      ? '填写 HTTPS 基础地址或完整 /chat/completions 地址。基础地址会自动补全，保存后显示最终请求地址。'
      : '填写 HTTPS 基础地址或完整 /messages 地址。基础地址会自动补全 /v1/messages；已有 /v1 时不会重复。';
}

export function modelSettingsChanged(event) {
  const form = event.target.closest('#settingsForm');
  if (!form) return;
  if (event.target.id === 'modelPreset') {
    const preset = modelPresets[event.target.value];
    if (preset) for (const [name,value] of Object.entries(preset)) form.elements[name].value = value;
  }
  syncModelSettings(form);
  form.querySelector('#modelTestResult').textContent = '配置已修改，尚未保存或测试。';
  form.querySelector('#modelTestResult').className = 'connection-result';
}
