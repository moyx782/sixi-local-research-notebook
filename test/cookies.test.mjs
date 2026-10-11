import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Store } from '../backend/store.mjs';
import { CookieSessions, cookieHeader, cookieSessionInput } from '../backend/cookie-sessions.mjs';
import { MacKeychain } from '../backend/keychain.mjs';
import { collectionInput, hash } from '../backend/input.mjs';
import { Collector } from '../backend/collector.mjs';
import { createFetcher } from '../backend/fetch.mjs';
import { createApp } from '../server.mjs';
import { html, rss } from './fixtures.mjs';

const secret = 'session=SYNTHETIC_SECRET_DO_NOT_PERSIST; csrf=abc';
const profile = (extra = {}) => ({ id: 'research', origin: 'https://example.com', cookie: secret, ...extra });
function memoryVault() {
  const values = new Map();
  return { values, async get(id) { return structuredClone(values.get(id) || null); },
    async set(id, value) { values.set(id, structuredClone(value)); }, async delete(id) { values.delete(id); } };
}
async function fixture(t) {
  const store = new Store(':memory:');
  const vault = memoryVault();
  const sessions = new CookieSessions(store, vault);
  t.after(() => store.close());
  await sessions.save(profile());
  return { store, vault, sessions };
}
const page = () => new Response(html(), { headers: { 'content-type': 'text/html' } });

test('Cookie input accepts request headers and rejects injection, unsafe scope and inline job secrets', () => {
  assert.equal(cookieHeader(' Cookie: a=1;b="abc" '), 'a=1; b="abc"');
  for (const value of ['a=1\r\nAuthorization: bad', 'a=含中文', 'bad', 'a=hello world', 'a=1; HttpOnly', 'a=' + 'x'.repeat(16384)]) {
    assert.throws(() => cookieHeader(value));
  }
  for (const origin of ['http://example.com', 'https://example.com/path', 'https://user:pass@example.com', 'https://example.com?q=1', 'https://example.com#x']) {
    assert.throws(() => cookieSessionInput(profile({ origin })));
  }
  assert.throws(() => cookieSessionInput(profile({ id: 'bad\nvalue' })));
  assert.throws(() => cookieSessionInput(profile({ expiresAt: '2020-01-01' })));
  assert.throws(() => collectionInput({ type: 'url', url: 'https://example.com', cookie: secret }));
  assert.throws(() => collectionInput({ type: 'text', content: 'hello', sessionId: 'research' }));
});

test('sessions store references only, separate sources, guard renewal races, expiry and removal', async (t) => {
  const { store, vault, sessions } = await fixture(t);
  const metadata = sessions.list()[0];
  assert.equal(metadata.cookie, undefined);
  assert.equal(metadata.revision, undefined);
  const old = await sessions.auth('research', 'https://example.com/article');
  await assert.rejects(sessions.save(profile({ origin: 'https://other.example' })), /不能更换/);
  await sessions.save(profile({ cookie: 'session=renewed' }));
  sessions.requireLogin('research', old.revision);
  assert.equal(sessions.list()[0].state, 'ready');
  assert.equal((await sessions.auth('research', 'https://example.com')).cookie, 'session=renewed');
  const anonymous = store.enqueue(collectionInput({ type: 'url', url: 'https://example.com/a' }));
  const authenticated = store.enqueue(collectionInput({ type: 'url', url: 'https://example.com/a', sessionId: 'research' }));
  assert.notEqual(anonymous.sourceId, authenticated.sourceId);
  for (const table of ['cookie_sessions', 'sources', 'jobs']) {
    assert.equal(JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()).includes('SYNTHETIC_SECRET'), false);
    assert.equal(JSON.stringify(store.db.prepare(`SELECT * FROM ${table}`).all()).includes('session=renewed'), false);
  }
  store.db.prepare('UPDATE cookie_sessions SET expires_at=?').run('2020-01-01T00:00:00Z');
  await assert.rejects(sessions.auth('research', 'https://example.com'), { code: 'AUTH_REQUIRED' });
  assert.equal(sessions.list()[0].state, 'needs_login');
  await sessions.save(profile());
  await sessions.delete('research');
  assert.equal(vault.values.size, 0);
  await assert.rejects(sessions.auth('research', 'https://example.com'), { code: 'AUTH_REQUIRED' });
  assert.equal(store.sources({ limit: 20, offset: 0 }).total, 2);
});

test('authenticated redirects retain exact-origin cookies and refuse other hosts, ports and HTTP', async (t) => {
  const { sessions } = await fixture(t);
  for (const target of ['https://other.example/article', 'https://sub.example.com/a', 'https://example.com:444/a', 'http://example.com/a']) {
    let calls = 0;
    const fetcher = createFetcher({ sessions, request: async (_, options) => {
      calls++;
      assert.equal(options.headers.cookie, secret);
      return new Response(null, { status: 302, headers: { location: target } });
    } });
    try {
      await assert.rejects(fetcher.fetch('https://example.com/a', { sessionId: 'research' }), { code: 'AUTH_SCOPE_MISMATCH' });
      assert.equal(calls, 1);
    } finally { await fetcher.close(); }
  }
  const requests = [];
  const fetcher = createFetcher({ sessions, request: async (url, options) => {
    requests.push({ url, cookie: options.headers.cookie });
    return url.endsWith('/a') ? new Response(null, { status: 302, headers: { location: '/b' } }) : page();
  } });
  try {
    await fetcher.fetch('https://example.com/a', { sessionId: 'research' });
    await fetcher.fetch('https://example.com/b');
    assert.deepEqual(requests.map((r) => r.cookie), [secret, secret, undefined]);
    await assert.rejects(fetcher.fetch('https://other.example/a', { sessionId: 'research' }), { code: 'AUTH_SCOPE_MISMATCH' });
    assert.equal(requests.length, 3);
  } finally { await fetcher.close(); }
});

test('401, 403, login redirects and HTTP-200 login forms require renewal without retries', async (t) => {
  const { sessions } = await fixture(t);
  for (const response of [
    () => new Response('', { status: 401 }), () => new Response('', { status: 403 }),
    () => new Response('', { status: 302, headers: { location: '/login?next=/article' } }),
    () => new Response('', { status: 302, headers: { location: 'https://sso.example/signin' } }),
    () => new Response('<html><title>Welcome</title><form><input type="password"></form></html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('<html><title>登录</title><form>扫码继续</form></html>', { headers: { 'content-type': 'text/html' } }),
  ]) {
    await sessions.save(profile());
    let calls = 0;
    const fetcher = createFetcher({ sessions, request: async () => { calls++; return response(); } });
    try {
      await assert.rejects(fetcher.fetch('https://example.com/article', { sessionId: 'research' }), { code: 'AUTH_REQUIRED' });
      assert.equal(calls, 1);
      assert.equal(sessions.list()[0].state, 'needs_login');
      await assert.rejects(fetcher.fetch('https://example.com/article', { sessionId: 'research' }), { code: 'AUTH_REQUIRED' });
      assert.equal(calls, 1);
    } finally { await fetcher.close(); }
  }
});

test('transport errors cannot persist Cookie request details; missing vault records require login', async (t) => {
  const { sessions, vault } = await fixture(t);
  const fetcher = createFetcher({ sessions, attempts: 2, sleep: async () => {}, request: async () => { throw new Error(`transport debug ${secret}`); } });
  try {
    await assert.rejects(fetcher.fetch('https://example.com/article', { sessionId: 'research' }), (error) => {
      assert.equal(error.code, 'FETCH_FAILED');
      assert.equal(error.message.includes(secret), false);
      return true;
    });
    await vault.delete('research');
    await assert.rejects(fetcher.fetch('https://example.com/article', { sessionId: 'research' }), { code: 'AUTH_REQUIRED' });
    assert.equal(sessions.list()[0].state, 'needs_login');
  } finally { await fetcher.close(); }
});

test('RSS auth failure skips gated entries without excerpt fallback and retains preceding full text', async (t) => {
  const { sessions, store } = await fixture(t);
  const requested = [];
  let renewed = false;
  const fetcher = createFetcher({ sessions, request: async (url, options) => {
    assert.equal(options.headers.cookie, secret);
    requested.push(url);
    if (url.endsWith('/feed')) return new Response(rss, { headers: { 'content-type': 'application/rss+xml' } });
    if (url.endsWith('/two') && !renewed) return new Response('', { status: 401 });
    return page();
  } });
  const collector = new Collector(store, fetcher);
  try {
    const job = store.enqueue(collectionInput({ type: 'feed', url: 'https://example.com/feed', sessionId: 'research' }));
    collector.kick(); await collector.running;
    const finished = store.job(job.id);
    assert.equal(finished.status, 'partial');
    assert.equal(finished.result.created, 1);
    assert.equal(finished.result.authRequired, true);
    assert.equal(finished.result.sessionId, 'research');
    assert.equal(finished.result.warnings.length, 0);
    assert.equal(finished.result.skipped, 2);
    assert.equal(requested.length, 3);
    const document = store.documents({ limit: 20, offset: 0 }).items[0];
    assert.equal(store.document(document.id).origins[0].quality, 'full_text');
    renewed = true;
    await sessions.save(profile());
    const again = store.recollect(job.sourceId);
    collector.kick(); await collector.running;
    assert.equal(store.job(again.id).status, 'succeeded');
    assert.equal(store.job(again.id).result.unchanged, 1);
  } finally { await collector.close(); }
});

test('unattended authentication failure never blocks later public feed entries or queued sources', async (t) => {
  const { sessions, store } = await fixture(t);
  const requested = [];
  const mixedFeed = rss.replace('https://example.com/three', 'https://public.example/three');
  const fetcher = createFetcher({ sessions, request: async (url, options) => {
    requested.push(url);
    if (url.endsWith('/feed')) return new Response(mixedFeed, { headers: { 'content-type': 'application/rss+xml' } });
    if (url.endsWith('/two')) return new Response('', { status: 401 });
    if (new URL(url).hostname === 'public.example') assert.equal(options.headers.cookie, undefined);
    return page();
  } });
  const collector = new Collector(store, fetcher);
  try {
    const feed = store.enqueue(collectionInput({ type: 'feed', url: 'https://example.com/feed', sessionId: 'research' }));
    const gated = store.enqueue(collectionInput({ type: 'url', url: 'https://example.com/gated', sessionId: 'research' }));
    const publicJob = store.enqueue(collectionInput({ type: 'url', url: 'https://public.example/next' }));
    collector.kick(); await collector.running;
    assert.equal(store.job(feed.id).status, 'partial');
    assert.equal(store.job(feed.id).result.skipped, 1);
    assert.ok(store.job(feed.id).result.items.some(item => item.url === 'https://public.example/three' && item.quality === 'full_text'));
    assert.equal(store.job(gated.id).status, 'failed');
    assert.equal(store.job(gated.id).result.skipped, 1);
    assert.equal(store.job(gated.id).result.authRequired, true);
    assert.equal(store.job(publicJob.id).status, 'succeeded');
    assert.ok(requested.includes('https://public.example/next'));
    assert.ok(!requested.includes('https://example.com/gated'));
  } finally { await collector.close(); }
});

test('RSS links to other origins are fetched anonymously', async (t) => {
  const { sessions, store } = await fixture(t);
  const calls = [];
  const fetcher = createFetcher({ sessions, request: async (url, options) => {
    calls.push({ url, cookie: options.headers.cookie });
    return url.endsWith('/feed') ? new Response(rss.replaceAll('https://example.com/', 'https://other.example/'), { headers: { 'content-type': 'application/rss+xml' } }) : page();
  } });
  const collector = new Collector(store, fetcher);
  try {
    const job = store.enqueue(collectionInput({ type: 'feed', url: 'https://example.com/feed', sessionId: 'research' }));
    collector.kick(); await collector.running;
    assert.equal(store.job(job.id).status, 'succeeded');
    assert.equal(calls[0].cookie, secret);
    assert.ok(calls.slice(1).every((call) => call.cookie === undefined));
  } finally { await collector.close(); }
});

test('Keychain chunk protocol keeps long secrets out of argv, validates writes and cleans up renewal', async () => {
  const records = new Map();
  const run = async (args, input) => {
    assert.equal(JSON.stringify(args).includes('SYNTHETIC'), false);
    assert.equal(JSON.stringify(args).includes(Buffer.from(secret).toString('base64')), false);
    if (args[0] === '-i') {
      assert.ok(input.length < 4096);
      const match = input.match(/ -a (\S+) -w (\S+)\n$/);
      records.set(match[1], match[2]);
      return { code: 0, stdout: '', stderr: '' };
    }
    const account = args[args.indexOf('-a') + 1];
    if (args[0] === 'delete-generic-password') return { code: records.delete(account) ? 0 : 44, stdout: '', stderr: '' };
    return { code: records.has(account) ? 0 : 44, stdout: records.get(account) || '', stderr: '' };
  };
  const vault = new MacKeychain(hash('isolated-test'), { run });
  const value = { cookie: secret + 'x'.repeat(16000), origin: 'https://example.com', revision: 'one' };
  await vault.set('research', value);
  assert.deepEqual(await vault.get('research'), value);
  assert.ok(records.size > 2);
  await vault.set('research', { cookie: 'session=renewed' });
  assert.equal(records.size, 2);
  await vault.delete('research');
  assert.equal(records.size, 0);
  const broken = new MacKeychain(hash('broken-test'), { run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  await assert.rejects(broken.set('research', value), { code: 'AUTH_REQUIRED' });
  await broken.delete('research');
  const silentFailure = new MacKeychain(hash('silent-failure'), { run: async (args) => ({ code: args[0] === 'find-generic-password' ? 44 : 0, stdout: '', stderr: '' }) });
  await assert.rejects(silentFailure.set('research', value), { code: 'KEYCHAIN_UNAVAILABLE' });
});

test('HTTP and CLI session workflow persists references, renews after login failure and survives restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sixi-cookies-'));
  const vault = memoryVault();
  let network;
  let denied = false;
  let calls = 0;
  let app;
  async function start() {
    app = createApp({ dataDir: directory, vault, fetcher: { fetch: (...args) => network.fetch(...args), close: () => network.close() } });
    network = createFetcher({ sessions: app.sessions, request: async (_, options) => {
      calls++;
      assert.equal(options.headers.cookie, secret);
      return denied ? new Response('', { status: 401 }) : page();
    } });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    return `http://127.0.0.1:${app.server.address().port}`;
  }
  let base = await start();
  const request = async (path, method = 'GET', input) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: input ? JSON.stringify(input) : undefined });
    const data = await response.json();
    assert.equal(JSON.stringify(data).includes('SYNTHETIC_SECRET'), false);
    return { status: response.status, data };
  };
  async function cli(args, stdin = '') {
    const child = spawn(process.execPath, ['scripts/cookies.mjs', ...args], { env: { ...process.env, SIXI_BASE_URL: base }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.stdin.end(stdin);
    const [code] = await once(child, 'close');
    assert.equal(output.includes('SYNTHETIC_SECRET'), false);
    assert.equal(code, 0, output);
    return output;
  }
  try {
    await cli(['set', 'research', 'https://example.com'], secret + '\n');
    assert.match(await cli(['list']), /research.*ready/);
    assert.equal((await request('/api/collections', 'POST', { type: 'url', url: 'https://other.example', sessionId: 'research' })).status, 400);
    assert.equal(calls, 0);
    const accepted = await request('/api/collections', 'POST', { type: 'url', url: 'https://example.com/article', sessionId: 'research' });
    assert.equal(accepted.status, 202);
    await app.collector.running;
    assert.equal(app.store.job(accepted.data.job.id).status, 'succeeded');
    await app.close(); base = await start();
    assert.equal((await request('/api/cookie-sessions')).data.items[0].state, 'ready');
    denied = true;
    const failed = await request(`/api/sources/${accepted.data.job.sourceId}/collect`, 'POST');
    await app.collector.running;
    assert.equal(app.store.job(failed.data.job.id).result.authRequired, true);
    assert.equal((await request(`/api/sources/${accepted.data.job.sourceId}/collect`, 'POST')).status, 409);
    assert.match(await cli(['list']), /needs_login/);
    await cli(['set', 'research', 'https://example.com'], secret);
    denied = false;
    const renewed = await request(`/api/sources/${accepted.data.job.sourceId}/collect`, 'POST');
    await app.collector.running;
    assert.equal(app.store.job(renewed.data.job.id).result.unchanged, 1);
    await cli(['remove', 'research']);
    assert.equal((await request('/api/cookie-sessions')).data.items.length, 0);
    assert.equal((await request('/api/documents')).data.total, 1);
    await app.close();
    assert.equal((await readFile(join(directory, 'library.sqlite'))).includes(Buffer.from('SYNTHETIC_SECRET')), false);
  } finally { await app.close(); await rm(directory, { recursive: true }); }
});
