import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../backend/store.mjs';
import { Collector } from '../backend/collector.mjs';
import { collectionInput, hash } from '../backend/input.mjs';
import { html, resource, rss } from './fixtures.mjs';

async function collect(store, collector, input) {
  const job = store.enqueue(collectionInput(input));
  collector.kick();
  await collector.running;
  return store.job(job.id);
}

test('deduplication shares content without losing provenance; changed URLs get new versions', async () => {
  const store = new Store(':memory:');
  let text = html();
  const collector = new Collector(store, { fetch: async (url) => resource(text, url), close() {} });
  try {
    const first = await collect(store, collector, { type: 'url', url: 'https://example.com/a' });
    const id = first.result.items[0].documentId;
    assert.equal(first.result.created, 1);
    const repeated = await collect(store, collector, { type: 'url', url: 'https://example.com/a' });
    assert.equal(repeated.result.unchanged, 1);
    const canonicalRepeat = await collect(store, collector, { type: 'url', url: 'https://www.example.com/a/?utm_source=research' });
    assert.equal(canonicalRepeat.result.unchanged, 1);
    assert.equal(store.sources({ limit: 20, offset: 0 }).total, 1, 'tracking, www and trailing slash variants reuse one source');
    const alias = await collect(store, collector, { type: 'url', url: 'https://example.com/b' });
    assert.equal(alias.result.duplicate, 1);
    assert.equal(store.document(id).origins.length, 2);
    assert.equal(store.stats().documents, 1);
    text = html(
      '更新后的研究资料包含更多来源信息，采集系统需要识别正文变化，保持旧资料仍能从其他来源访问。',
    );
    const changed = await collect(store, collector, { type: 'url', url: 'https://example.com/a' });
    assert.equal(changed.result.updated, 1);
    assert.notEqual(changed.result.items[0].documentId, id);
    assert.equal(store.document(id).origins.length, 1);
    assert.equal(store.stats().documents, 2);
    assert.equal(store.raw(changed.result.items[0].documentId).content, text);
  } finally {
    await collector.close();
    store.close();
  }
});

test('normalized content fingerprints merge formatting-only duplicates after collection', () => {
  const store = new Store(':memory:');
  try {
    const first = store.enqueue(collectionInput({
      type: 'text', title: '第一份资料', content: '工业电机需要可靠的效率数据。', url: 'https://example.com/first',
    }));
    const second = store.enqueue(collectionInput({
      type: 'text', title: '第二份资料', content: '工业电机需要可靠的效率数据。', url: 'https://example.com/second',
    }));
    const one = store.saveDocument(first.sourceId, {
      title: '第一份资料', text: '工业电机需要\n可靠的效率数据。', url: 'https://example.com/first', quality: 'full_text',
    }, resource('raw-one', 'https://example.com/first'));
    const two = store.saveDocument(second.sourceId, {
      title: '第二份资料', text: '工业电机需要 可靠的效率数据。', url: 'https://example.com/second', quality: 'full_text',
    }, resource('raw-two', 'https://example.com/second'));
    assert.equal(one.outcome, 'created');
    assert.equal(two.outcome, 'duplicate');
    assert.equal(two.documentId, one.documentId);
    assert.equal(store.stats().documents, 1);
    assert.equal(store.document(one.documentId).origins.length, 2);
  } finally {
    store.close();
  }
});

test('startup cleanup merges legacy normalized duplicates while keeping provenance', () => {
  const store = new Store(':memory:');
  try {
    const first = store.enqueue(collectionInput({ type: 'text', title: '旧资料一', content: '一', url: 'https://example.com/legacy-a' }));
    const second = store.enqueue(collectionInput({ type: 'text', title: '旧资料二', content: '二', url: 'https://example.com/legacy-b' }));
    const normalized = hash('同一篇正文');
    store.db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?)').run('legacy-a', hash('raw-a'), '旧资料一', '同一篇 正文', '同一篇 正文', new Date().toISOString(), normalized);
    store.db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?)').run('legacy-b', hash('raw-b'), '旧资料二', '同一篇\n正文', '同一篇\n正文', new Date().toISOString(), normalized);
    const fetchedAt = new Date().toISOString();
    store.db.prepare('INSERT INTO origins VALUES (?,?,?,?,?,?,?)').run(first.sourceId, 'https://example.com/legacy-a', 'legacy-a', '{}', 'raw-a', 'text/plain', fetchedAt);
    store.db.prepare('INSERT INTO origins VALUES (?,?,?,?,?,?,?)').run(second.sourceId, 'https://example.com/legacy-b', 'legacy-b', '{}', 'raw-b', 'text/plain', fetchedAt);
    const result = store.deduplicateDocuments();
    assert.equal(result.merged, 1);
    assert.equal(store.stats().documents, 1);
    const remaining = store.db.prepare('SELECT id FROM documents').get().id;
    assert.equal(store.document(remaining).origins.length, 2);
  } finally {
    store.close();
  }
});

test('feed saves successful pages and explicitly reports fallback and failures', async () => {
  const store = new Store(':memory:');
  const collector = new Collector(store, {
    fetch: async (url) => {
      if (url.endsWith('/feed')) return resource(rss, url, 'application/rss+xml');
      if (url.endsWith('/one')) return resource(html(), url);
      throw new Error('来源返回 HTTP 503');
    },
    close() {},
  });
  try {
    const job = await collect(store, collector, { type: 'feed', url: 'https://example.com/feed' });
    assert.equal(job.status, 'partial');
    assert.equal(job.result.created, 2);
    assert.equal(job.result.failed, 1);
    assert.equal(job.result.items[1].quality, 'feed_excerpt');
    assert.match(job.result.items[1].warning, /503/);
    assert.equal(
      store.document(job.result.items[1].documentId).text,
      '第二篇正文，网站暂时不可访问。',
    );
    const repeated = await collect(store, collector, {
      type: 'feed',
      url: 'https://example.com/feed',
    });
    assert.equal(repeated.result.unchanged, 2);
    assert.equal(store.stats().documents, 2);
  } finally {
    await collector.close();
    store.close();
  }
});

test('queued and interrupted jobs survive database close and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sixi-recovery-'));
  const path = join(directory, 'library.sqlite');
  let store = new Store(path);
  const input = collectionInput({
    type: 'text',
    title: '持久化',
    content: '重启之后继续搜集资料。',
  });
  const first = store.enqueue(input);
  assert.equal(store.enqueue(input).id, first.id);
  store.nextJob();
  assert.equal(store.job(first.id).status, 'running');
  store.close();
  store = new Store(path);
  const collector = new Collector(store, { close() {} });
  try {
    assert.equal(store.job(first.id).status, 'queued');
    collector.kick();
    await collector.running;
    assert.equal(store.job(first.id).status, 'succeeded');
    assert.equal(store.documents({ q: '重启', limit: 10, offset: 0 }).total, 1);
    assert.equal(store.documents({ q: '%', limit: 10, offset: 0 }).total, 0);
  } finally {
    await collector.close();
    store.close();
    await rm(directory, { recursive: true });
  }
});

test('a transient feed article failure never replaces previously collected full text with an excerpt', async () => {
  const store = new Store(':memory:');
  let fail = false;
  const collector = new Collector(store, {
    fetch: async (url) => {
      if (url.endsWith('/feed')) return resource(rss, url, 'application/rss+xml');
      if (fail) throw new Error('网页临时不可用');
      return resource(html(), url);
    },
    close() {},
  });
  try {
    const first = await collect(store, collector, {
      type: 'feed',
      url: 'https://example.com/feed',
      limit: 1,
    });
    const id = first.result.items[0].documentId;
    const original = store.document(id).text;
    fail = true;
    const second = await collect(store, collector, {
      type: 'feed',
      url: 'https://example.com/feed',
      limit: 1,
    });
    assert.equal(second.status, 'partial');
    assert.equal(second.result.unchanged, 1);
    assert.equal(second.result.items[0].documentId, id);
    assert.equal(store.document(id).text, original);
    assert.equal(store.document(id).origins[0].quality, 'full_text');
  } finally {
    await collector.close();
    store.close();
  }
});
