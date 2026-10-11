import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, integer, normalizeUrl } from './input.mjs';
import { searchWeb } from './search.mjs';

const defaults = { provider: 'duckduckgo', endpoint: 'http://127.0.0.1:8888/search', fallback: true };
const failure = message => new AppError(message, 503, 'SEARCH_UNAVAILABLE');

// A separate, administrator-configured loopback transport. Public page fetching
// retains its existing private-address and redirect protections.
export function searchEndpoint(value) {
  let url; try { url = new URL(value); } catch { throw new AppError('请输入本地 SearxNG 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !['/', '/search', '/search/'].includes(url.pathname))
    throw new AppError('SearxNG 仅支持本机地址，例如 http://127.0.0.1:8888/search');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  url.pathname = '/search';
  return url.href;
}

function validate(input, current = defaults) {
  const next = { ...current };
  if (input.provider !== undefined) next.provider = input.provider;
  if (!['searxng', 'duckduckgo'].includes(next.provider)) throw new AppError('请选择 SearxNG 或 DuckDuckGo；WebFetch 请使用网址采集入口');
  next.endpoint = searchEndpoint(input.endpoint ?? next.endpoint);
  if (input.fallback !== undefined) {
    if (typeof input.fallback !== 'boolean') throw new AppError('fallback 必须为布尔值');
    next.fallback = input.fallback;
  }
  return next;
}

async function readJSON(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw failure(response.status === 403 ? 'SearxNG 拒绝 JSON 搜索，请在 settings.yml 的 search.formats 中启用 json。' : `SearxNG 返回 HTTP ${response.status}，请检查本地服务。`);
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel(); throw failure('SearxNG 未返回 JSON，请检查地址和 search.formats 配置。');
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2_000_000) throw failure('SearxNG 搜索响应过大，请缩小检索范围。');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('SearxNG 返回的 JSON 无效。'); }
  if (!Array.isArray(data.results)) throw failure('SearxNG 返回缺少 results，无法读取搜索结果。');
  return data;
}

export function createSearch(dataDir, fetcher, { request = fetch, timeoutMs = 20_000 } = {}) {
  const configPath = join(dataDir, 'search.json');
  async function config() {
    try { return validate(JSON.parse(await readFile(configPath, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { ...defaults }; throw error; }
  }
  async function saveConfig(input) {
    const next = validate(input, await config()), temporary = `${configPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, configPath); return next;
  }
  async function searxng(query, limit, selected, signal) {
    const url = new URL(selected.endpoint);
    url.search = new URLSearchParams({ q: query, format: 'json', categories: 'general' });
    let data;
    try {
      const response = await request(url.href, { headers: { accept: 'application/json' }, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      data = await readJSON(response);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AppError) throw error;
      throw failure('无法连接本地 SearxNG，或搜索超时。请启动搜索服务并测试连接。');
    }
    const items = [], seen = new Set();
    for (const result of data.results) {
      try {
        if (!result || typeof result.title !== 'string' || !result.title.trim() || typeof result.url !== 'string') continue;
        const url = normalizeUrl(result.url);
        if (seen.has(url)) continue;
        seen.add(url);
        items.push({ title: result.title.trim().slice(0, 500), url, snippet: String(result.content || '').slice(0, 2000),
          engines: Array.isArray(result.engines) ? result.engines.filter(e => typeof e === 'string').slice(0, 10) : [] });
        if (items.length >= limit) break;
      } catch { /* Invalid result URLs cannot become collection jobs. */ }
    }
    const unavailable = Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines.length : 0;
    if (!items.length && unavailable) throw failure(`SearxNG 未取得结果，${unavailable} 个上游搜索引擎未响应，请检查网络或代理。`);
    return { query, provider: 'SearxNG', searchedAt: new Date().toISOString(), items,
      warnings: unavailable ? [`SearxNG 有 ${unavailable} 个上游引擎未响应，已使用其他引擎的结果。`] : [] };
  }
  async function search(input, { signal, selected } = {}) {
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.trim().length > 200) throw new AppError('搜索主题需为 1–200 字。');
    const query = input.query.trim(), limit = integer(input.limit, 10, 1, 10);
    const settings = selected || await config();
    signal?.throwIfAborted();
    if (settings.provider === 'duckduckgo') return searchWeb({ query, limit }, fetcher, { signal });
    try { return await searxng(query, limit, settings, signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (!settings.fallback) throw error;
      try {
        const result = await searchWeb({ query, limit }, fetcher, { signal });
        return { ...result, fallbackFrom: 'SearxNG', warnings: [`${error.message} 本次已回退到 DuckDuckGo。`] };
      } catch {
        signal?.throwIfAborted();
        throw failure(`${error.message} 备用搜索也不可用；可用 WebFetch 直接添加网址，或继续人工补采。`);
      }
    }
  }
  return { config, saveConfig, search, async test(input) {
    const selected = validate(input, await config()), started = Date.now();
    // A connection test must exercise the selected provider, never hide failure with fallback.
    const result = await search({ query: 'Domel electric motors', limit: 3 }, { selected: { ...selected, fallback: false } });
    return { provider: result.provider, count: result.items.length, latencyMs: Date.now() - started,
      warnings: result.warnings || [], message: `${result.provider} 已连接，返回 ${result.items.length} 个搜索结果。` };
  } };
}
