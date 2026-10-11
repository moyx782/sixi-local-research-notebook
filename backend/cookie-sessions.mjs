import { randomUUID } from 'node:crypto';
import { AppError, normalizeUrl, sessionId } from './input.mjs';

export function cookieHeader(value) {
  if (typeof value !== 'string' || value.length > 16_384) throw new AppError('Cookie 必须是最多 16384 字节的字符串');
  const header = value.trim().replace(/^Cookie:\s*/i, '');
  if (!header || /[^\x20-\x7e]/.test(header)) throw new AppError('Cookie 必须为单行 HTTP Cookie 请求头');
  const pairs = header.split(';').map((pair) => pair.trim());
  for (const pair of pairs) {
    const match = pair.match(/^([!#$%&'*+.^_`|~\w-]+)=(.*)$/);
    if (!match) throw new AppError('Cookie 格式应为 name=value; other=value');
    const raw = match[2].startsWith('"') && match[2].endsWith('"') ? match[2].slice(1, -1) : match[2];
    if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(raw)) throw new AppError('Cookie 含无效字符，请复制请求中的 Cookie 头');
  }
  return pairs.join('; ');
}

export function cookieSessionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('会话必须是 JSON 对象');
  const id = sessionId(input.id);
  if (typeof input.origin !== 'string') throw new AppError('需要指定 Cookie 的 HTTPS 来源');
  const url = new URL(normalizeUrl(input.origin));
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || input.origin.includes('#')) {
    throw new AppError('origin 必须是精确的 HTTPS 来源，例如 https://wiki.example.com');
  }
  if (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 200)) throw new AppError('会话标签不能超过 200 字');
  if (input.expiresAt != null && (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt)))) {
    throw new AppError('expiresAt 必须是有效的日期字符串');
  }
  const expiresAt = input.expiresAt == null ? null : new Date(input.expiresAt).toISOString();
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw new AppError('Cookie 过期时间必须晚于当前时间');
  return { id, origin: url.origin, label: input.label?.trim() || id, expiresAt, cookie: cookieHeader(input.cookie) };
}

export const isAuthRequired = (error) => error?.code === 'AUTH_REQUIRED';

export class CookieSessions {
  constructor(store, vault) {
    this.store = store;
    this.vault = vault;
    this.writes = Promise.resolve();
  }

  serialize(operation) {
    const next = this.writes.then(operation);
    this.writes = next.catch(() => {});
    return next;
  }

  publicProfile(profile) { const { revision, ...metadata } = profile; return metadata; }

  list() {
    return this.store.cookieSessions().map((profile) => {
      if (profile.expiresAt && Date.parse(profile.expiresAt) <= Date.now()) {
        this.requireLogin(profile.id, profile.revision);
        profile.state = 'needs_login';
      }
      return this.publicProfile(profile);
    });
  }

  async save(raw) {
    const input = cookieSessionInput(raw);
    return this.serialize(async () => {
      const previous = this.store.cookieSession(input.id);
      if (previous && previous.origin !== input.origin) throw new AppError('已有会话不能更换来源，请使用新的会话编号', 409);
      const revision = randomUUID();
      await this.vault.set(input.id, { origin: input.origin, cookie: input.cookie, revision });
      return this.publicProfile(this.store.saveCookieSession({ ...input, revision }));
    });
  }

  async delete(id) {
    sessionId(id);
    return this.serialize(async () => {
      await this.vault.delete(id);
      this.store.deleteCookieSession(id);
    });
  }

  validate(id, url) {
    const profile = this.store.cookieSession(sessionId(id));
    if (!profile || profile.state === 'needs_login') throw new AppError('请先录入或更新该来源的 Cookie', 409, 'AUTH_REQUIRED');
    if (new URL(url).origin !== profile.origin) throw new AppError('会话只能用于绑定的 HTTPS 来源', 400, 'AUTH_SCOPE_MISMATCH');
    if (profile.expiresAt && Date.parse(profile.expiresAt) <= Date.now()) {
      this.requireLogin(id, profile.revision);
      throw new AppError('Cookie 已过期，请重新登录并更新', 409, 'AUTH_REQUIRED');
    }
    return profile;
  }

  async auth(id, url) {
    const profile = this.validate(id, url);
    let secret;
    try { secret = await this.vault.get(id); }
    catch (error) {
      if (isAuthRequired(error)) this.requireLogin(id, profile.revision);
      throw error;
    }
    if (!secret || secret.origin !== profile.origin || secret.revision !== profile.revision) {
      this.requireLogin(id, profile.revision);
      throw new AppError('钥匙串中缺少有效会话，请重新录入 Cookie', 409, 'AUTH_REQUIRED');
    }
    const current = this.validate(id, url);
    if (current.revision !== profile.revision) throw new AppError('Cookie 已更新，请重新提交采集', 409, 'AUTH_REQUIRED');
    let cookie;
    try { cookie = cookieHeader(secret.cookie); }
    catch {
      this.requireLogin(id, profile.revision);
      throw new AppError('钥匙串会话格式无效，请重新录入', 409, 'AUTH_REQUIRED');
    }
    return { id, origin: profile.origin, revision: profile.revision, cookie };
  }

  requireLogin(id, revision) { this.store.requireCookieLogin(id, revision); }
}
