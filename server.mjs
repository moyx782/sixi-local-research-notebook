import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './backend/store.mjs';
import { Collector } from './backend/collector.mjs';
import { createFetcher } from './backend/fetch.mjs';
import { collectionRoute } from './backend/api.mjs';
import { createAssistant } from './backend/assistant.mjs';
import { AppError, hash } from './backend/input.mjs';
import { acquireInstanceLock } from './backend/instance-lock.mjs';
import { createSearch } from './backend/search-provider.mjs';
import { CookieSessions } from './backend/cookie-sessions.mjs';
import { MacKeychain } from './backend/keychain.mjs';
import { Research, researchRoute } from './backend/research.mjs';
import { Authentication, authenticationRoute } from './backend/auth.mjs';
import { Discovery } from './backend/discovery.mjs';
import { Handoffs, handoffRoute } from './backend/handoffs.mjs';
import { LibraryUploads, uploadRoute } from './backend/uploads.mjs';
import { createMineru } from './backend/mineru.mjs';
import { createVisualCapture } from './backend/visual-capture.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/frontend/core.js', ['frontend/core.js', 'text/javascript; charset=utf-8']],
  ['/frontend/views.js', ['frontend/views.js', 'text/javascript; charset=utf-8']],
  ['/frontend/auth.js', ['frontend/auth.js', 'text/javascript; charset=utf-8']],
  ['/frontend/market.js', ['frontend/market.js', 'text/javascript; charset=utf-8']],
  ['/frontend/model-settings.js', ['frontend/model-settings.js', 'text/javascript; charset=utf-8']],
  ['/frontend/mineru.js', ['frontend/mineru.js', 'text/javascript; charset=utf-8']],
  ['/frontend/search-settings.js', ['frontend/search-settings.js', 'text/javascript; charset=utf-8']],
  ['/frontend/discovery.js', ['frontend/discovery.js', 'text/javascript; charset=utf-8']],
]);

export async function body(req, maximum = 1_000_000) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json'))
    throw new AppError('请使用 application/json', 415, 'UNSUPPORTED_MEDIA_TYPE');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maximum) {
      req.resume();
      throw new AppError(`请求体超过 ${maximum / 1_000_000} MB 上限`, 413, 'PAYLOAD_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new AppError('请求必须是有效的 JSON 对象');
  }
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

export function createApp({
  dataDir = process.env.SIXI_DATA_DIR || join(homedir(), '.sixi'),
  fetcher,
  vault,
  ask,
  modelConnection,
  discoveryOptions,
  mineruOptions,
  searchOptions,
  visualOptions,
  authRequired = process.env.SIXI_AUTH_REQUIRED === '1',
} = {}) {
  // Acquire before opening the library or recovering jobs: a second process
  // must not reset work owned by the already running process.
  const instanceLock = acquireInstanceLock(dataDir);
  let store;
  try {
    store = new Store(join(dataDir, 'library.sqlite'));
    const sessions = new CookieSessions(store, vault || new MacKeychain(hash(realpathSync(dataDir))));
    return createLockedApp({ dataDir, store, sessions, fetcher: fetcher || createFetcher({ sessions }), instanceLock, ask, authRequired, modelConnection, discoveryOptions, mineruOptions, searchOptions, visualOptions });
  } catch (error) {
    try {
      store?.close();
    } finally {
      instanceLock.close();
    }
    throw error;
  }
}

function createLockedApp({ dataDir, store, sessions, fetcher, instanceLock, ask, authRequired, modelConnection, discoveryOptions, mineruOptions, searchOptions, visualOptions }) {
  const collector = new Collector(store, fetcher);
  const assistant = createAssistant(dataDir, { connection: modelConnection });
  const research = new Research(store, ask || assistant.ask);
  const handoffs = new Handoffs(store,research,collector);
  const mineru=createMineru(dataDir,mineruOptions);
  const visualCapture=createVisualCapture({sessions,...visualOptions});
  collector.visualCapture=visualCapture;
  const search=createSearch(dataDir,fetcher,searchOptions);
  const uploads = new LibraryUploads(store,collector,{mineru,research,...mineruOptions});
  handoffs.uploads=uploads;
  const discovery = new Discovery(store,research,collector,{
    search:search.search,ask:(input,options)=>assistant.ask(input,undefined,options),
    aiAvailable:async()=>Boolean((await assistant.readConfig()).apiKey),...discoveryOptions,handoffs,
  });
  const auth = new Authentication(store, { enabled: authRequired, dataDir, secureCookie: process.env.SIXI_SECURE_COOKIE === '1' });
  const server = http.createServer(async (req, res) => {
    try {
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || ''))
        throw new AppError('Host 不受支持', 403, 'FORBIDDEN');
      const origin = req.headers.origin;
      const allowed = [
        `http://127.0.0.1:${req.socket.localPort}`,
        `http://localhost:${req.socket.localPort}`,
        `http://[::1]:${req.socket.localPort}`,
      ];
      if (origin && !allowed.includes(origin)) throw new AppError('来源不受支持', 403, 'FORBIDDEN');
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        });
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      if (await authenticationRoute(req, url, { auth, res, body, json })) return;
      if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
        const admin = ['POST', 'DELETE'].includes(req.method) && (url.pathname === '/api/config' || url.pathname.startsWith('/api/config/') || url.pathname.startsWith('/api/mineru/config') || url.pathname.startsWith('/api/search/config') || url.pathname.startsWith('/api/cookie-sessions'));
        auth.require(req, { admin });
      }
      if(url.pathname==='/api/mineru/config'){
        if(req.method==='GET')return json(res,200,{ok:true,...await mineru.config()});
        if(req.method==='POST')return json(res,200,{ok:true,...await mineru.saveConfig(await body(req))});
        if(req.method==='DELETE')return json(res,200,{ok:true,...await mineru.saveConfig({},true)});
        throw new AppError('不支持此操作',405);
      }
      if(url.pathname==='/api/mineru/config/test'&&req.method==='POST')return json(res,200,{ok:true,...await mineru.test(await body(req))});
      if(url.pathname==='/api/search/config'){
        if(req.method==='GET')return json(res,200,{ok:true,...await search.config()});
        if(req.method==='POST')return json(res,200,{ok:true,...await search.saveConfig(await body(req))});
        throw new AppError('该接口仅支持 GET、POST',405);
      }
      if(url.pathname==='/api/search/config/test'&&req.method==='POST')return json(res,200,{ok:true,...await search.test(await body(req))});
      if (url.pathname === '/api/search') {
        if (req.method !== 'POST') throw new AppError('搜索接口仅支持 POST', 405, 'METHOD_NOT_ALLOWED');
        return json(res, 200, { ok: true, ...await search.search(await body(req)) });
      }
      if (url.pathname === '/api/config') {
        let config;
        if (req.method === 'GET') config = await assistant.readConfig();
        else if (req.method === 'POST') config = await assistant.saveConfig(await body(req));
        else if (req.method === 'DELETE') config = await assistant.clearKey();
        else throw new AppError('该接口仅支持 GET、POST、DELETE', 405, 'METHOD_NOT_ALLOWED');
        return json(res, 200, {
          ok: true,
          provider: config.provider,
          model: config.model,
          protocol: config.protocol,
          endpoint: config.endpoint,
          hasKey: Boolean(config.apiKey),
        });
      }
      if (url.pathname === '/api/config/test' && req.method === 'POST') {
        return json(res, 200, { ok: true, ...await assistant.testConnection(await body(req)) });
      }
      if (url.pathname === '/api/ask' && req.method === 'POST') {
        return json(res, 200, { ok: true, answer: await assistant.ask(await body(req)) });
      }
      if (await uploadRoute(req, url, { uploads, body, json, res })) return;
      if (await collectionRoute(req, url, { store, collector, sessions, handoffs, uploads, body, json, res })) return;
      if (await handoffRoute(req, url, { handoffs, research, body, json, res })) return;
      if (await researchRoute(req, url, { research, store, collector, sessions, discovery, handoffs, body, json, res })) return;
      const asset = assets.get(url.pathname);
      if (req.method !== 'GET' || !asset) throw new AppError('接口或文件不存在', 404, 'NOT_FOUND');
      const content = await readFile(join(root, asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      res.end(content);
    } catch (error) {
      if (res.headersSent) return res.destroy(error);
      if (!(error instanceof AppError)) console.error(error);
      json(res, error.status || 500, {
        ok: false,
        error: error.message || '请求失败',
        code: error.code || 'INTERNAL_ERROR',
      });
    }
  });
  collector.kick();
  discovery.kick();
  uploads.kick();
  let closing;
  return {
    server,
    store,
    collector,
    sessions,
    discovery,
    uploads,
    close() {
      closing ||= (async () => {
        const stopped = new Promise((resolve, reject) =>
          server.listening ? server.close((error) => (error ? reject(error) : resolve())) : resolve(),
        );
        server.closeIdleConnections();
        const discoveryStopped=discovery.close();
        const results = await Promise.allSettled([discoveryStopped,uploads.close(),collector.close(),assistant.close(),stopped]);
        try {
          store.close();
        } finally {
          instanceLock.close();
        }
        const failure = results.find((result) => result.status === 'rejected');
        if (failure) throw failure.reason;
      })();
      return closing;
    },
  };
}

export function startServer({ port = Number(process.env.PORT || 4173), ...options } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new AppError('PORT 必须是 0–65535 之间的整数');
  const app = createApp(options);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  app.server.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
    void shutdown();
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  app.server.listen(port, '127.0.0.1', () =>
    console.log(`思绪后端：http://127.0.0.1:${app.server.address().port}`),
  );
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
