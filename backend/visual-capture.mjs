import { chromium } from 'playwright';
import { AppError, normalizeUrl } from './input.mjs';
import { isLoginPage, isLoginUrl } from './login-detection.mjs';
import { isPublicAddress } from './fetch.mjs';
import { isIP } from 'node:net';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_SCREENSHOT = 5_000_000;

export function visualUrl(value, { allowLocal = false } = {}) {
  let url;
  try { url = new URL(normalizeUrl(value)); } catch { throw new AppError('视觉采集需要有效的 HTTP(S) 地址'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const privateHost = (isIP(host) && !isPublicAddress(host)) || /(^|\.)(localhost|local|internal)$/.test(host);
  if (!allowLocal && ((isIP(host) && !isPublicAddress(host)) || privateHost))
    throw new AppError('视觉采集地址不能指向本机、内网或保留地址', 400, 'BLOCKED_ADDRESS');
  return url.href;
}

function cookiesFromHeader(header, url) {
  return header.split(';').map(pair => pair.trim()).filter(Boolean).map(pair => {
    const index = pair.indexOf('=');
    return { name: pair.slice(0, index), value: pair.slice(index + 1), domain: new URL(url).hostname, path: '/', secure: new URL(url).protocol === 'https:' };
  });
}

async function browserExecutable() {
  const preferred = process.env.SIXI_PLAYWRIGHT_EXECUTABLE || chromium.executablePath();
  try { await access(preferred); return preferred; } catch { /* use the full browser bundle below */ }
  const cacheRoots = [join(homedir(), 'Library', 'Caches', 'ms-playwright'), join(homedir(), '.cache', 'ms-playwright')];
  const binary = process.platform === 'darwin' ? join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
    : process.platform === 'win32' ? join('chrome-win', 'chrome.exe') : join('chrome-linux', 'chrome');
  for (const root of cacheRoots) {
    try {
      const versions = (await readdir(root)).filter(name => /^chromium-\d+$/.test(name)).sort().reverse();
      for (const version of versions) { const candidate=join(root,version,binary); try { await access(candidate); return candidate; } catch {} }
    } catch {}
  }
  return preferred;
}

export function createVisualCapture({ sessions, timeoutMs = 35_000, allowLocal = false } = {}) {
  return {
    async capture(address, { signal, sessionId, fullPage = true, waitMs = 800 } = {}) {
      const url = visualUrl(address, { allowLocal });
      signal?.throwIfAborted();
      let browser;
      try {
        browser = await chromium.launch({ headless: true, executablePath: await browserExecutable() });
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
          userAgent: 'SixiVisualCollector/1.0 (local research notebook)' });
        if (sessionId) {
          if (!sessions) throw new AppError('Cookie 会话服务未配置', 503, 'KEYCHAIN_UNAVAILABLE');
          const auth = await sessions.auth(sessionId, url);
          await context.addCookies(cookiesFromHeader(auth.cookie, url));
        }
        const page = await context.newPage();
        const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        try { await page.waitForLoadState('networkidle', { timeout: Math.min(8_000, timeoutMs) }); } catch { /* dynamic pages may never become idle */ }
        if (waitMs) await new Promise((resolve, reject) => { const timer=setTimeout(resolve, Math.min(10_000, Math.max(0, waitMs))); combined.addEventListener('abort',()=>{clearTimeout(timer);reject(combined.reason);},{once:true}); });
        combined.throwIfAborted();
        const resource = { url: page.url(), text: await page.content(), visualText: (await page.locator('body').innerText({ timeout: timeoutMs })).slice(0, 450_000), contentType: 'text/html; charset=utf-8', fetchedAt: new Date().toISOString() };
        if (sessionId && (isLoginUrl(resource.url) || isLoginPage(resource))) {
          sessions.requireLogin(sessionId, sessions.store.cookieSession(sessionId)?.revision);
          throw new AppError('页面需要真人登录，请更新 Cookie 会话', 409, 'AUTH_REQUIRED');
        }
        const bytes = await page.screenshot({ type: 'png', fullPage: Boolean(fullPage), animations: 'disabled' });
        if (bytes.length > MAX_SCREENSHOT) throw new AppError('视觉截图超过 5 MB，请关闭整页截图或缩小页面', 422, 'SCREENSHOT_TOO_LARGE');
        resource.screenshot = { mime: 'image/png', bytes: Buffer.from(bytes) };
        resource.visual = { mode: 'playwright', title: await page.title(), finalUrl: resource.url, fullPage: Boolean(fullPage), viewport: '1440x900' };
        return resource;
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error?.name === 'TimeoutError' || error?.code === 'ERR_TIMED_OUT') throw new AppError('Playwright 页面加载超时，请改用普通 URL 或人工补采', 504, 'PLAYWRIGHT_TIMEOUT');
        if (error?.message?.includes('Executable doesn\'t exist')) throw new AppError('未安装 Chromium，请运行 npm run browser:install', 503, 'PLAYWRIGHT_UNAVAILABLE');
        throw new AppError(`Playwright 视觉采集失败：${error.message || '浏览器错误'}`, 502, 'PLAYWRIGHT_FAILED');
      } finally { await browser?.close(); }
    },
  };
}
