import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';
import { AppError, normalizeUrl } from './input.mjs';
import { isLoginPage, isLoginUrl } from './login-detection.mjs';

export function isPublicAddress(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}

// Validate every DNS answer, and pass the checked address directly to the socket.
// A second DNS lookup would permit rebinding between validation and connection.
async function resolvePublicDns(hostname, family) {
  const url = new URL('https://1.1.1.1/dns-query');
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', family === 6 ? 'AAAA' : 'A');
  const response = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`公共 DNS 返回 HTTP ${response.status}`);
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 65_536) throw new Error('DNS 响应过大');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (data.Status !== 0) throw new AppError('域名无法解析', 422, 'DNS_LOOKUP_FAILED');
  return (data.Answer || [])
    .filter((answer) => answer.type === (family === 6 ? 28 : 1))
    .map((answer) => ({ address: answer.data, family: family === 6 ? 6 : 4 }));
}

export function createPublicLookup({
  resolve = lookup,
  fallback = resolvePublicDns,
  fallbackEnabled = process.env.SIXI_DNS_FALLBACK !== 'off',
} = {}) {
  return (hostname, options, callback) => {
    Promise.resolve()
      .then(async () => {
        let addresses = await resolve(hostname, { all: true, verbatim: true });
        // TUN proxies often synthesize addresses in 198.18.0.0/15. Resolve those
        // public hostnames independently; never permit the reserved address itself.
        const fakeIp = (address) => /^198\.(18|19)\./.test(address);
        if (
          fallbackEnabled &&
          addresses.length &&
          addresses.every(({ address }) => fakeIp(address))
        ) {
          addresses = await fallback(hostname, options.family);
        }
        return addresses;
      })
      .then((addresses) => {
        if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
          return callback(
            new AppError('采集地址不能指向本机、内网或保留地址', 400, 'BLOCKED_ADDRESS'),
          );
        }
        const family = options.family === 4 || options.family === 6 ? options.family : null;
        const matching = family ? addresses.filter((entry) => entry.family === family) : addresses;
        if (!matching.length) return callback(new Error('没有可用的 DNS 地址'));
        if (options.all) callback(null, matching);
        else callback(null, matching[0].address, matching[0].family);
      }, callback);
  };
}

export const publicLookup = createPublicLookup();

function checkedUrl(value) {
  const url = new URL(normalizeUrl(value));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    (isIP(hostname) && !isPublicAddress(hostname)) ||
    /(^|\.)(localhost|local|internal)$/.test(hostname)
  ) {
    throw new AppError('采集地址不能指向本机、内网或保留地址', 400, 'BLOCKED_ADDRESS');
  }
  return url.href;
}

export function createFetcher({
  request = fetch,
  dispatcher,
  timeoutMs = 15_000,
  maxBytes = 2_000_000,
  attempts = 3,
  sleep = delay,
  sessions,
} = {}) {
  const agent = dispatcher || new Agent({ connect: { lookup: publicLookup }, connections: 2 });

  function loginRequired(auth) {
    sessions.requireLogin(auth.id, auth.revision);
    return new AppError('登录会话已失效或访问被拒绝，请重新登录并更新 Cookie', 409, 'AUTH_REQUIRED');
  }

  async function once(address, signal, sessionId) {
    let url = checkedUrl(address);
    for (let redirect = 0; redirect <= 5; redirect++) {
      const auth = sessionId ? await sessions.auth(sessionId, url) : null;
      signal.throwIfAborted();
      const response = await request(url, {
        dispatcher: agent,
        redirect: 'manual',
        signal,
        headers: {
          ...(auth ? { cookie: auth.cookie } : {}),
          'user-agent': 'SixiCollector/1.0 (local research notebook)',
          accept:
            'text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml,text/plain;q=0.9',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new AppError('跳转响应缺少 Location', 422, 'INVALID_REDIRECT');
        const target = normalizeUrl(location, url);
        if (auth && isLoginUrl(target)) throw loginRequired(auth);
        if (auth && new URL(target).origin !== auth.origin) {
          throw new AppError('已停止跨来源跳转，请为目标网站单独配置会话', 400, 'AUTH_SCOPE_MISMATCH');
        }
        url = checkedUrl(target);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (auth && [401, 403].includes(response.status)) throw loginRequired(auth);
        const error = new AppError(`来源返回 HTTP ${response.status}`, 502, 'UPSTREAM_HTTP');
        error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
        const retryAfter = response.headers.get('retry-after');
        const seconds = Number(retryAfter);
        error.retryAfterMs = retryAfter
          ? Math.min(
              30_000,
              Math.max(
                0,
                Number.isFinite(seconds)
                  ? seconds * 1000
                  : Date.parse(retryAfter) - Date.now() || 0,
              ),
            )
          : 0;
        throw error;
      }
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (
        !/^(text\/(html|plain|xml)|application\/(xhtml\+xml|rss\+xml|atom\+xml|xml))\b/.test(
          contentType,
        )
      ) {
        await response.body?.cancel();
        throw new AppError(
          auth ? '来源返回了不支持的内容类型' : `暂不支持该内容类型：${contentType || '未知'}`,
          422,
          'UNSUPPORTED_CONTENT',
        );
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new AppError('来源内容超过 2 MB 上限', 422, 'CONTENT_TOO_LARGE');
      }
      const chunks = [];
      let size = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > maxBytes)
            throw new AppError('来源内容超过 2 MB 上限', 422, 'CONTENT_TOO_LARGE');
          chunks.push(chunk);
        }
      }
      const bytes = Buffer.concat(chunks);
      const prefix = bytes.subarray(0, 2048).toString('latin1');
      const charset =
        contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] ||
        prefix.match(/(?:charset|encoding)\s*=\s*["']?([a-zA-Z0-9_-]+)/i)?.[1] ||
        'utf-8';
      let text;
      try {
        text = new TextDecoder(charset).decode(bytes);
      } catch {
        throw new AppError(auth ? '来源返回了不支持的编码' : `不支持来源编码：${charset}`, 422, 'UNSUPPORTED_ENCODING');
      }
      const resource = { url, text, contentType, fetchedAt: new Date().toISOString() };
      if (auth && (isLoginUrl(url) || isLoginPage(resource))) throw loginRequired(auth);
      return resource;
    }
    throw new AppError('来源跳转次数过多', 422, 'TOO_MANY_REDIRECTS');
  }

  return {
    async fetch(url, { signal, sessionId } = {}) {
      if (sessionId && !sessions) throw new AppError('Cookie 会话服务未配置', 503, 'KEYCHAIN_UNAVAILABLE');
      for (let attempt = 0; attempt < attempts; attempt++) {
        signal?.throwIfAborted();
        try {
          const timeout = AbortSignal.timeout(timeoutMs);
          return await once(url, signal ? AbortSignal.any([signal, timeout]) : timeout, sessionId);
        } catch (error) {
          const cause = error.cause instanceof AppError ? error.cause : error;
          const retryable = cause.retryable ?? !(cause instanceof AppError);
          if (signal?.aborted || !retryable || attempt === attempts - 1) {
            // Transport errors can contain request details. Never persist them for authenticated requests.
            if (sessionId && !(cause instanceof AppError)) throw new AppError('登录来源请求失败或超时，请重试', 502, 'FETCH_FAILED');
            if (cause === error && error.cause?.message) {
              error.message = `${error.message}: ${error.cause.message}`;
            }
            throw cause;
          }
          await sleep(Math.max(cause.retryAfterMs || 0, 250 * 2 ** attempt), undefined, { signal });
        }
      }
    },
    async close() {
      if (!dispatcher) await agent.destroy();
    },
  };
}
