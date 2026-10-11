import { createHash } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const cleanText = (value) =>
  String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export function normalizeUrl(value, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw new AppError('请输入有效的 HTTP(S) 地址');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new AppError('仅支持不含登录凭据的 HTTP(S) 地址');
  }
  if (url.href.length > 4096) throw new AppError('地址过长');
  url.hash = '';
  return url.href;
}

export function integer(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    throw new AppError(`参数必须是 ${min}–${max} 之间的整数`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AppError(`参数必须是 ${min}–${max} 之间的整数`);
  }
  return number;
}

export function sessionId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new AppError('sessionId 必须为 1–64 位字母、数字、下划线或连字符');
  }
  return value;
}

export function collectionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AppError('请求必须是 JSON 对象');
  if (!['url', 'feed', 'text'].includes(input.type))
    throw new AppError('type 必须是 url、feed 或 text');
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 500)) {
    throw new AppError('title 必须是最多 500 字的字符串');
  }
  const title = cleanText(input.title);
  if (input.cookie !== undefined || input.cookies !== undefined || input.headers !== undefined) {
    throw new AppError('请通过会话接口录入 Cookie，采集任务只接受 sessionId');
  }
  if (input.type === 'text') {
    if (input.sessionId !== undefined) throw new AppError('手动文本不使用登录会话');
    if (typeof input.content !== 'string' || input.content.length > 500_000) {
      throw new AppError('content 必须是最多 500000 字的字符串');
    }
    const content = cleanText(input.content);
    if (!content) throw new AppError('导入文本不能为空');
    const url = input.url === undefined ? null : normalizeUrl(input.url);
    return { type: 'text', title: title || content.slice(0, 80), content, url };
  }
  if (typeof input.url !== 'string') throw new AppError('url 不能为空');
  if (input.renderMode !== undefined && !['http', 'playwright'].includes(input.renderMode))
    throw new AppError('renderMode 必须是 http 或 playwright');
  if (input.fullPage !== undefined && typeof input.fullPage !== 'boolean')
    throw new AppError('fullPage 必须是布尔值');
  return {
    type: input.type,
    title,
    url: normalizeUrl(input.url),
    limit: integer(input.limit, 20, 1, 50),
    ...(input.renderMode === 'playwright' ? { renderMode: 'playwright', fullPage: input.fullPage !== false } : {}),
    ...(input.sessionId === undefined ? {} : { sessionId: sessionId(input.sessionId) }),
  };
}
