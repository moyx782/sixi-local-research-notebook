import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { acquireInstanceLock } from '../backend/instance-lock.mjs';

// Use the production startup and signal handlers, but replace remote fetching
// with deterministic content so lifecycle tests never depend on the network.
const childSource = `
import { startServer } from ${JSON.stringify(new URL('../server.mjs', import.meta.url).href)};
const result = (url, text, contentType = 'text/plain') => ({ url, text, contentType, fetchedAt: new Date().toISOString() });
const app = startServer({
  port: 0,
  fetcher: {
    async fetch(url, { signal }) {
      if (url.endsWith('/feed')) return result(url, '<rss><channel><title>Lifecycle</title><item><title>First</title><link>https://example.com/first</link></item><item><title>Second</title><link>https://example.com/second</link></item></channel></rss>', 'application/rss+xml');
      if (url.endsWith('/second') && process.env.LIFECYCLE_MODE === 'block') {
        process.send({ event: 'blocked' });
        return new Promise((resolve, reject) => {
          signal.throwIfAborted();
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return result(url, url.endsWith('/first') ? '第一篇资料正文，验证部分采集结果在进程退出后仍然保留。' : '第二篇资料正文，验证恢复采集任务后能够继续完成后续内容。');
    },
    async close() {},
  },
});
app.server.on('listening', () => process.send({ event: 'ready', port: app.server.address().port }));
app.server.on('close', () => process.disconnect());
`;

function launch(dataDir, mode = 'complete') {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    env: { ...process.env, SIXI_DATA_DIR: dataDir, LIFECYCLE_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  child.on('message', (message) => messages.push(message));
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    output: () => output,
    async waitFor(event) {
      for (let attempt = 0; attempt < 200; attempt++) {
        const message = messages.find((message) => message.event === event);
        if (message) return message;
        if (child.exitCode !== null || child.signalCode !== null)
          assert.fail(`Child exited before ${event}: ${output}`);
        await delay(25);
      }
      assert.fail(`Timed out waiting for ${event}: ${output}`);
    },
    async stop(signal = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return exited;
    },
  };
}

async function readJob(base, id) {
  const response = await fetch(`${base}/api/collections/${id}`);
  assert.equal(response.status, 200);
  return (await response.json()).job;
}

async function waitForCompletion(base, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await readJob(base, id);
    if (!['queued', 'running'].includes(job.status)) return job;
    await delay(25);
  }
  assert.fail('Task did not complete after restart');
}

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`${signal} preserves partial collection data and releases the instance lock for recovery`, { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sixi-lifecycle-'));
    const children = [];
    try {
      const first = launch(directory, 'block');
      children.push(first);
      const { port } = await first.waitFor('ready');
      const base = `http://127.0.0.1:${port}`;
      const response = await fetch(base + '/api/collections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'feed', url: 'https://example.com/feed', limit: 2 }),
      });
      assert.equal(response.status, 202);
      const { job } = await response.json();
      await first.waitFor('blocked');
      const before = await readJob(base, job.id);
      assert.equal(before.status, 'running');
      assert.equal(before.result.created, 1);

      // A competing process must fail before recover() touches the active job.
      const competitor = launch(directory);
      children.push(competitor);
      assert.equal((await competitor.exited).code, 1);
      assert.match(competitor.output(), /INSTANCE_RUNNING/);
      assert.deepEqual(await readJob(base, job.id), before);

      const exit = await first.stop(signal);
      if (signal === 'SIGTERM') assert.deepEqual(exit, { code: 0, signal: null });
      else assert.equal(exit.signal, 'SIGKILL');
      const db = new DatabaseSync(join(directory, 'library.sqlite'), { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status,
          signal === 'SIGTERM' ? 'queued' : 'running');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 1);
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      } finally {
        db.close();
      }

      const restarted = launch(directory);
      children.push(restarted);
      const { port: restartPort } = await restarted.waitFor('ready');
      const restartBase = `http://127.0.0.1:${restartPort}`;
      const finished = await waitForCompletion(restartBase, job.id);
      assert.equal(finished.status, 'succeeded');
      assert.equal(finished.result.unchanged, 1);
      assert.equal(finished.result.created, 1);
      const health = await (await fetch(restartBase + '/api/health')).json();
      assert.equal(health.documents, 2);
      assert.equal(health.sources, 1);
      assert.equal(health.jobs.succeeded, 1);
      assert.deepEqual(await restarted.stop(), { code: 0, signal: null });
    } finally {
      await Promise.all(children.map((child) => child.stop('SIGKILL')));
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('failed initialization releases the data directory lock and close is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sixi-init-'));
  const library = join(directory, 'library.sqlite');
  try {
    await writeFile(library, 'not a database');
    assert.throws(() => createApp({ dataDir: directory }), /database/);
    const lock = acquireInstanceLock(directory);
    lock.close();
    lock.close();
    await rm(library);
    const app = createApp({ dataDir: directory });
    assert.throws(() => createApp({ dataDir: directory }), { code: 'INSTANCE_RUNNING' });
    await Promise.all([app.close(), app.close()]);
    const restarted = createApp({ dataDir: directory });
    await restarted.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
