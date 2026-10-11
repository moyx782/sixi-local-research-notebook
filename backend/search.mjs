import { JSDOM } from 'jsdom';
import { AppError, integer, normalizeUrl } from './input.mjs';

const endpoint = 'https://html.duckduckgo.com/html/';

export function parseSearchResults(html, limit = 10) {
  const dom = new JSDOM(html, { url: endpoint });
  try {
    const document = dom.window.document;
    if (document.querySelector('form[action*="anomaly"], .anomaly-modal, #challenge-form')) {
      throw new AppError('搜索服务要求验证，请稍后重试，或直接粘贴网页链接收集。', 503, 'SEARCH_BLOCKED');
    }
    const items = [], seen = new Set();
    for (const result of document.querySelectorAll('.result')) {
      if (result.matches('.result--ad') || result.querySelector('.result__badge')) continue;
      const anchor = result.querySelector('.result__a');
      if (!anchor) continue;
      let url;
      try {
        const target = new URL(anchor.getAttribute('href'), endpoint);
        url = normalizeUrl(target.hostname === 'duckduckgo.com' && target.pathname === '/l/' ? target.searchParams.get('uddg') : target.href);
        if (new URL(url).hostname.endsWith('duckduckgo.com')) continue;
      } catch { continue; }
      const title = anchor.textContent.trim();
      if (!title || seen.has(url)) continue;
      seen.add(url);
      items.push({ title: title.slice(0, 500), url, snippet: (result.querySelector('.result__snippet')?.textContent || '').trim().slice(0, 2000) });
      if (items.length >= limit) break;
    }
    if (!items.length && !document.querySelector('.no-results, .result--no-result')) {
      throw new AppError('搜索服务未返回可识别的结果，请稍后重试或改用网页链接。', 502, 'SEARCH_UNAVAILABLE');
    }
    return items;
  } finally { dom.window.close(); }
}

export async function searchWeb(input, fetcher, { signal } = {}) {
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.trim().length > 200)
    throw new AppError('搜索主题需为 1–200 字。');
  const query = input.query.trim(), limit = integer(input.limit, 10, 1, 10);
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  let resource;
  try { resource = await fetcher.fetch(url.href, { signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000) }); }
  catch { throw new AppError('暂时无法连接搜索服务，请稍后重试，或粘贴网页链接收集。', 503, 'SEARCH_UNAVAILABLE'); }
  return { query, provider: 'DuckDuckGo', searchedAt: new Date().toISOString(), items: parseSearchResults(resource.text, limit) };
}
