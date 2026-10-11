import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { html, resource } from './fixtures.mjs';

async function start(dataDir) {
  const app = createApp({
    dataDir,
    fetcher: { fetch: async (url) => resource(html(), url), close() {} },
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, method = 'GET', input) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, data: await response.json() };
  };
  return { app, base, request };
}

test('HTTP collection, querying, source refresh, raw evidence and persistence work without AI keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sixi-api-'));
  let { app, request } = await start(directory);
  try {
    const accepted = await request('/api/collections', 'POST', {
      type: 'url',
      url: 'https://example.com/article',
    });
    assert.equal(accepted.status, 202);
    await app.collector.running;
    const { job } = (await request(`/api/collections/${accepted.data.job.id}`)).data;
    assert.equal(job.status, 'succeeded');
    const documents = (await request('/api/documents?q=数据&limit=1')).data;
    assert.equal(documents.total, 1);
    const id = documents.items[0].id;
    const document = (await request(`/api/documents/${id}`)).data.document;
    assert.equal(document.origins[0].url, 'https://example.com/article');
    assert.equal(document.origins[0].quality, 'full_text');
    assert.equal((await request(`/api/documents/${id}/raw`)).data.raw.content, html());
    assert.equal((await request('/api/sources')).data.items[0].documentCount, 1);
    const again = await request(`/api/sources/${job.sourceId}/collect`, 'POST');
    await app.collector.running;
    assert.equal(
      (await request(`/api/collections/${again.data.job.id}`)).data.job.result.unchanged,
      1,
    );
    assert.equal((await request('/api/health')).data.documents, 1);
    assert.equal((await request('/api/config')).data.hasKey, false);
    await app.close();
    ({ app, request } = await start(directory));
    assert.equal((await request('/api/documents')).data.total, 1);
    assert.equal((await request('/api/collections')).data.total, 2);
  } finally {
    await app.close();
    await rm(directory, { recursive: true });
  }
});

test('HTTP errors reject malformed, oversized and unsafe requests without exposing local files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sixi-validation-'));
  const { app, base, request } = await start(directory);
  try {
    assert.equal(
      (await request('/api/collections', 'POST', { type: 'text', content: '' })).status,
      400,
    );
    assert.equal((await request('/api/documents?limit=abc')).status, 400);
    assert.equal((await request('/api/documents/not-found')).status, 404);
    assert.equal((await request('/api/missing')).status, 404);
    for (const path of ['/server.mjs', '/backend/store.mjs', '/package.json', '/.git/config'])
      assert.equal((await request(path)).status, 404);
    const malformed = await fetch(base + '/api/collections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    const large = await fetch(base + '/api/collections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'text', content: 'x'.repeat(1_000_001) }),
    });
    assert.equal(large.status, 413);
    const crossOrigin = await fetch(base + '/api/documents', {
      headers: { origin: 'https://other.example' },
    });
    assert.equal(crossOrigin.status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
      http
        .get(base + '/api/documents', { headers: { host: 'attacker.example' } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
        .on('error', reject);
    });
    assert.equal(wrongHost, 403);
    const staticPage = await fetch(base + '/');
    assert.equal(staticPage.status, 200);
    assert.equal(await staticPage.text(), await readFile(new URL('../index.html', import.meta.url), 'utf8'));
  } finally {
    await app.close();
    await rm(directory, { recursive: true });
  }
});

test('existing AI configuration API preserves keys when changing a model and never returns the key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sixi-config-'));
  const { app, request } = await start(directory);
  try {
    await request('/api/config', 'POST', { apiKey: 'test-key-only', model: 'original' });
    const updated = await request('/api/config', 'POST', { model: 'updated' });
    assert.equal(updated.data.hasKey, true);
    assert.equal(updated.data.model, 'updated');
    assert.equal(updated.data.apiKey, undefined);
    assert.equal((await request('/api/config', 'DELETE')).data.hasKey, false);
    assert.equal((await request('/api/ask', 'POST', { question: 'hello' })).status, 400);
  } finally {
    await app.close();
    await rm(directory, { recursive: true });
  }
});

test('opaque browser origins cannot read data, change configuration or pass preflight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sixi-origin-'));
  const { app, base, request } = await start(directory);
  try {
    await request('/api/config', 'POST', { apiKey: 'test-key-only', model: 'original' });
    for (const [path, method, input] of [
      ['/api/documents', 'GET'],
      ['/api/config', 'POST', { model: 'attacker' }],
      ['/api/config', 'DELETE'],
      ['/api/collections', 'OPTIONS'],
    ]) {
      const response = await fetch(base + path, {
        method,
        headers: { origin: 'null', 'content-type': 'application/json' },
        body: input ? JSON.stringify(input) : undefined,
      });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      await response.arrayBuffer();
    }
    const config = (await request('/api/config')).data;
    assert.equal(config.model, 'original');
    assert.equal(config.hasKey, true);
    const allowed = await fetch(base + '/api/health', { headers: { origin: base } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), base);
    await allowed.arrayBuffer();
  } finally {
    await app.close();
    await rm(directory, { recursive: true });
  }
});
