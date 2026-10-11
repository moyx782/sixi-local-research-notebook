export const categories = {
  all: '全部资料', competitor: '竞品动态', users: '用户声音', market: '市场趋势', ideas: '产品灵感', uncategorized: '未分类',
};
export const statuses = {
  queued: ['等待采集', 'neutral'], running: ['采集中', 'blue'], succeeded: ['采集完成', 'green'],
  partial: ['需关注', 'amber'], failed: ['采集失败', 'red'],
};
export const qualities = { full_text: '正文已提取', feed_excerpt: '仅订阅摘要', imported_text: '手动导入' };
export const storageKey = 'sixi-collect-preferences-v1';
export const blankPreferences = () => ({ documents: {}, sources: {} });

export function readPreferences(storage) {
  const raw = storage.getItem(storageKey);
  if (!raw) return blankPreferences();
  const data = JSON.parse(raw);
  if (!data || typeof data.documents !== 'object' || !data.documents || Array.isArray(data.documents) ||
      typeof data.sources !== 'object' || !data.sources || Array.isArray(data.sources)) throw new Error('分类数据格式无效');
  return data;
}

export function parseLinks(value) {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('请粘贴至少一个网页或订阅链接。');
  if (lines.length > 10) throw new Error('每次最多提交 10 个链接。');
  return [...new Set(lines.map((line) => {
    let url;
    try { url = new URL(line); } catch { throw new Error(`链接格式不正确：${line}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096)
      throw new Error('请使用不含账号密码的公开 HTTP(S) 链接。');
    url.hash = '';
    return url.href;
  }))];
}

export function documentMeta(preferences, id) {
  const item = preferences.documents[id] || {};
  return { category: categories[item.category] && item.category !== 'all' ? item.category : 'uncategorized', topic: item.topic || '', favorite: Boolean(item.favorite) };
}

export function inheritSourceMetadata(preferences, jobs) {
  for (const job of jobs) {
    const source = preferences.sources[job.sourceId];
    if (!source) continue;
    for (const item of job.result?.items || []) {
      if (item.documentId && !preferences.documents[item.documentId]) {
        preferences.documents[item.documentId] = { category: source.category, topic: source.topic, favorite: false };
      }
    }
  }
}

export function filterDocuments(documents, preferences, { category = 'all', favorites = false, topic = '' } = {}) {
  return documents.filter((doc) => {
    const meta = documentMeta(preferences, doc.id);
    return (category === 'all' || meta.category === category) && (!favorites || meta.favorite) && (!topic || meta.topic === topic);
  });
}

export function safeUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}
export function domain(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return '手动导入'; }
}
export function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function makeCsv(documents, preferences) {
  const rows = [['标题', '分类', '收集主题', '来源', '内容类型', '采集时间', '正文']];
  for (const doc of documents) {
    const meta = documentMeta(preferences, doc.id);
    rows.push([doc.title, categories[meta.category], meta.topic, doc.origins.map((origin) => origin.url).filter(Boolean).join('\n'),
      [...new Set(doc.origins.map((origin) => qualities[origin.quality] || origin.quality))].join('；'), doc.origins[0]?.fetchedAt || doc.createdAt, doc.text]);
  }
  return '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
export function makeMarkdown(documents, preferences) {
  return '# 产品信息收集\n\n' + documents.map((doc, index) => {
    const meta = documentMeta(preferences, doc.id);
    const origins = doc.origins.map((origin) => `- 来源：${origin.url || '手动文本'}\n  类型：${qualities[origin.quality] || origin.quality}；采集时间：${origin.fetchedAt}${origin.warning ? `\n  说明：${origin.warning}` : ''}`).join('\n');
    return `## ${index + 1}. ${doc.title.replace(/\n/g, ' ')}\n\n分类：${categories[meta.category]}${meta.topic ? `｜主题：${meta.topic}` : ''}\n\n${origins}\n\n${doc.text}`;
  }).join('\n\n---\n\n');
}

export async function request(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, { method, signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error('服务返回了无法读取的响应，请刷新或检查后端。'); }
  if (!response.ok || !data.ok) { const error = new Error(data.error || '请求失败，请重试。'); error.status = response.status; error.code = data.code; throw error; }
  return data;
}
export async function allPages(path) {
  const items = [];
  let total;
  do {
    const response = await request(`${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${items.length}`);
    items.push(...response.items);
    total = response.total;
    if (!response.items.length) break;
  } while (items.length < total);
  return items;
}
