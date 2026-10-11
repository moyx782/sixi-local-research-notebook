import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import { AppError } from './input.mjs';
import { isPublicAddress, publicLookup } from './fetch.mjs';

export const protocols = ['builtin', 'openai-chat', 'anthropic-messages'];

// Store a complete request URL so the UI and transport agree about the destination.
export function normalizeEndpoint(protocol, value) {
  if (protocol === 'builtin') return '';
  let url;
  try { url = new URL(value); } catch { throw new AppError('请输入有效的 Endpoint 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href.length > 2048)
    throw new AppError('Endpoint 必须是 HTTPS 地址，不能包含账号、密码、查询参数或片段');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if ((isIP(host) && !isPublicAddress(host)) || /(^|\.)(localhost|local|internal)$/.test(host))
    throw new AppError('Endpoint 不能指向本机、内网或保留地址');
  let path = url.pathname.replace(/\/+$/, '');
  if (protocol === 'openai-chat') {
    if (/\/(messages|responses)$/.test(path)) throw new AppError('当前协议需要 /chat/completions 接口');
    if (!path.endsWith('/chat/completions')) path += '/chat/completions';
  } else if (protocol === 'anthropic-messages') {
    if (/\/(chat\/completions|responses)$/.test(path)) throw new AppError('当前协议需要 /messages 接口');
    if (!path.endsWith('/messages')) path += path.endsWith('/v1') ? '/messages' : '/v1/messages';
  }
  url.pathname = path;
  return url.href;
}

function upstreamError(status) {
  const explanation = {
    400: '请求参数不兼容，请检查协议与模型 ID',
    401: '密钥无效或已过期', 402: '账户余额不足', 403: '该密钥没有访问权限',
    404: '接口或模型不存在，请检查 Endpoint 和模型 ID',
    422: '请求参数不兼容，请检查协议与模型 ID',
    429: '请求频率或额度受限，请稍后重试',
  }[status] || '服务暂时不可用，请稍后重试';
  return new AppError(`模型服务返回 HTTP ${status}：${explanation}`, 502, 'MODEL_HTTP_ERROR');
}

export function createModelConnection({ request = fetch, timeoutMs = 120_000, maxBytes = 2_000_000 } = {}) {
  // Public DNS answers are validated and pinned to the socket; keys never follow redirects.
  const agent = new Agent({ connect: { lookup: publicLookup, timeout: 10_000 }, connections: 2 });
  return {
    async complete(config, prompt, { test = false, signal } = {}) {
      const endpoint = normalizeEndpoint(config.protocol, config.endpoint);
      const anthropic = config.protocol === 'anthropic-messages';
      const payload = {
        model: config.model, messages: [{ role: 'user', content: prompt }],
        max_tokens: test ? 64 : 4096, stream: false,
        ...(new URL(endpoint).hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}),
      };
      let response;
      try {
        response = await request(endpoint, {
          method: 'POST', dispatcher: agent, redirect: 'manual',
          signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
          headers: {
            'content-type': 'application/json', accept: 'application/json',
            ...(anthropic ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
              : { authorization: `Bearer ${config.apiKey}` }),
          },
          body: JSON.stringify(payload),
        });
        if (response.status >= 300 && response.status < 400)
          throw new AppError('Endpoint 返回了跳转；请直接填写最终接口地址', 502, 'MODEL_REDIRECT');
        if (!response.ok) throw upstreamError(response.status);
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > maxBytes) throw new AppError('模型响应过大，请缩小输入资料范围', 502, 'MODEL_RESPONSE_TOO_LARGE');
          chunks.push(chunk);
        }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new AppError('接口未返回有效 JSON，请检查协议与 Endpoint', 502, 'MODEL_RESPONSE_INVALID'); }
        const truncated = anthropic ? data.stop_reason === 'max_tokens' : data.choices?.[0]?.finish_reason === 'length';
        if (truncated) throw new AppError('模型输出被截断，请缩小资料范围后重试', 502, 'MODEL_OUTPUT_TRUNCATED');
        const text = anthropic
          ? (Array.isArray(data.content) ? data.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('') : '')
          : data.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim())
          throw new AppError('模型没有返回正文，请检查协议、模型或输出限制', 502, 'MODEL_EMPTY_RESPONSE');
        return text.trim();
      } catch (error) {
        // Upstream errors can echo headers or prompts. Only locally constructed errors leave this boundary.
        if (error instanceof AppError) throw error;
        if (['TimeoutError', 'AbortError'].includes(error.name))
          throw new AppError('模型请求超时，请稍后重试', 504, 'MODEL_TIMEOUT');
        throw new AppError('无法连接模型服务，请检查 Endpoint、网络和协议', 502, 'MODEL_CONNECTION_FAILED');
      } finally {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      }
    },
    close() { return agent.destroy(); },
  };
}
