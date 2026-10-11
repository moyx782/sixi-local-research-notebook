import { localHeaders } from './local-client.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// Default: isolated temporary library. An explicit base URL tests a deployed service
// and retains the two public verification sources in that service's library.
const target = process.env.SIXI_SMOKE_BASE_URL;
if (target) {
  const url = new URL(target);
  assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  assert.ok(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash);
}
const dataDir = target ? null : await mkdtemp(join(tmpdir(), 'sixi-live-'));
const app = target ? null : createApp({ dataDir });
try {
  if (app) {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
  }
  const base = target ? new URL(target).origin : `http://127.0.0.1:${app.server.address().port}`;
  const credentials = target ? await localHeaders(base) : {};
  const localFetch = (url, options = {}) => fetch(url, { ...options, headers: { ...credentials, ...options.headers }, redirect: 'error' });
  const collect = async (input) => {
    const response = await localFetch(`${base}/api/collections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 202);
    const { job } = await response.json();
    if (app) await app.collector.running;
    const deadline = Date.now() + 210_000;
    let result;
    do {
      result = await (
        await localFetch(`${base}/api/collections/${job.id}`, { signal: AbortSignal.timeout(5000) })
      ).json();
      if (!['queued', 'running'].includes(result.job.status)) break;
      assert.ok(Date.now() < deadline, '采集任务超过验收等待期限');
      await delay(250);
    } while (true);
    assert.ok(['succeeded', 'partial'].includes(result.job.status), JSON.stringify(result.job));
    assert.ok(
      result.job.result.items.some((item) => item.documentId),
      JSON.stringify(result.job),
    );
    return result.job;
  };

  const page = {
    type: 'url',
    url: 'https://www.sqlite.org/whentouse.html',
    title: '部署验收 · SQLite 官方文档',
  };
  const first = await collect(page);
  const documentId = first.result.items[0].documentId;
  const { document } = await (await localFetch(`${base}/api/documents/${documentId}`)).json();
  assert.equal(document.origins[0].quality, 'full_text');
  assert.ok(document.text.length > 1000);
  const { raw } = await (await localFetch(`${base}/api/documents/${documentId}/raw`)).json();
  assert.ok(raw.content.includes('<html'));
  console.log(
    JSON.stringify({
      type: 'url',
      status: first.status,
      title: document.title,
      textLength: document.text.length,
      hasRaw: true,
    }),
  );

  const repeated = await collect(page);
  assert.equal(repeated.result.unchanged, 1);
  console.log(JSON.stringify({ type: 'repeat', unchanged: repeated.result.unchanged }));

  const feed = await collect({
    type: 'feed',
    url: 'https://github.com/mozilla/readability/releases.atom',
    title: '部署验收 · Mozilla Readability 订阅',
    limit: 1,
  });
  console.log(
    JSON.stringify({
      type: 'feed',
      status: feed.status,
      items: feed.result.items,
      warnings: feed.result.warnings,
    }),
  );
  const search = await (await localFetch(`${base}/api/documents?q=SQLite`)).json();
  assert.ok(search.items.some((item) => item.id === documentId));
  console.log(
    JSON.stringify({
      type: 'query',
      matchedSavedPage: true,
      documents: (await (await localFetch(`${base}/api/health`)).json()).documents,
    }),
  );
} finally {
  if (app) await app.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}
