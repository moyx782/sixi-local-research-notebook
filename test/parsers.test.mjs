import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePage, parseFeed } from '../backend/parsers.mjs';
import { collectionInput, normalizeUrl } from '../backend/input.mjs';
import { html, resource, rss, articleText } from './fixtures.mjs';

test('HTML extracts Chinese paragraphs and metadata without executing scripts', () => {
  const article = parsePage(resource(html()));
  assert.equal(article.title, '后端数据采集');
  assert.equal(article.author, '研究者');
  assert.equal(article.publishedAt, '2026-09-17T00:00:00.000Z');
  assert.ok(article.text.includes(articleText));
  assert.ok(article.text.includes('\n'));
  assert.doesNotMatch(article.text, /导航|页脚|throw new Error/);
  assert.equal(article.quality, 'full_text');
});

test('RSS retains CDATA content, dates and per-entry URLs', () => {
  const feed = parseFeed(resource(rss, 'https://example.com/feed', 'application/rss+xml'));
  assert.equal(feed.items.length, 3);
  assert.equal(feed.items[0].text, '第一篇的摘要');
  assert.equal(feed.items[1].text, '第二篇正文，网站暂时不可访问。');
  assert.equal(feed.items[0].publishedAt, '2026-09-17T00:00:00.000Z');
  assert.equal(parseFeed(resource(rss), 1).items.length, 1);
});

test('namespaced Atom resolves alternate links and xml:base, skips invalid links', () => {
  const atom = `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xml:base="/posts/"><atom:title>Atom</atom:title>
    <atom:entry><atom:title>第一篇</atom:title><atom:link rel="self" href="entry.xml"/><atom:link rel="alternate" href="one"/><atom:content type="html">&lt;p&gt;正文内容&lt;/p&gt;</atom:content><atom:author><atom:name>作者</atom:name></atom:author></atom:entry>
    <atom:entry><atom:title>重复</atom:title><atom:link href="one#anchor"/></atom:entry>
    <atom:entry><atom:title>无链接</atom:title></atom:entry>
    <atom:entry><atom:link href="javascript:alert(1)"/></atom:entry></atom:feed>`;
  const feed = parseFeed(resource(atom, 'https://example.com/feed'));
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].url, 'https://example.com/posts/one');
  assert.equal(feed.items[0].text, '正文内容');
  assert.equal(feed.items[0].author, '作者');
  assert.equal(feed.invalidCount, 2);
});

test('rejects malformed XML, DTDs, empty pages and unsupported content', () => {
  for (const text of ['<rss><channel>', '<!DOCTYPE rss><rss/>', '<html/>'])
    assert.throws(() => parseFeed(resource(text)));
  assert.throws(() => parsePage(resource('<html><body></body></html>')), /正文/);
  assert.throws(() => parsePage(resource('%PDF', undefined, 'application/pdf')), /不是网页/);
});

test('navigation controls and loading pages are not reported as collected full text', () => {
  const controls = `<html><head><title>Release 0.6.0</title></head><body><main>
    <ul><li><span>Notifications</span><span>You must be signed in to change notification settings</span></li>
    <li><a href="/fork">Fork</a> 731</li><li><a href="/star">Star</a> 11.4k</li></ul>
    <button>Sign in to receive notifications about this project and its new releases</button>
    <div hidden><p>${articleText}</p></div></main></body></html>`;
  assert.throws(() => parsePage(resource(controls)), { code: 'EMPTY_CONTENT' });
  const loading = html('There was an error while loading. Please reload this page and try again.');
  assert.throws(() => parsePage(resource(loading)), { code: 'EMPTY_CONTENT' });
  assert.equal(parsePage(resource(html())).quality, 'full_text');
});

test('catalog prose survives misleading layout classes without admitting hidden prose or navigation', () => {
  const content = `<html><head><title>Motor catalog</title></head><body>
    <nav><p>${articleText.repeat(6)}</p></nav>
    <section id="content"><div class="catalog"><section class="related"><h1>Battery motors</h1>
      <p>${articleText}</p><p>${articleText}</p>
      <div hidden><p>Hidden specifications must not be imported.</p></div>
    </section></div></section>
    <aside><h3>Our company</h3><p><a href="/about">Explore our products</a></p></aside></body></html>`;
  const article = parsePage(resource(content));
  assert.equal(article.title, 'Motor catalog');
  assert.match(article.text, /Battery motors/);
  assert.ok(article.text.includes(articleText));
  assert.doesNotMatch(article.text, /Hidden specifications|Explore our products/);
  assert.equal(article.quality, 'full_text');
});

test('input validation preserves meaningful query parameters and normalizes only fragments', () => {
  assert.equal(
    normalizeUrl('https://EXAMPLE.com:443/a?b=2&a=1#x'),
    'https://example.com/a?b=2&a=1',
  );
  assert.throws(() => normalizeUrl('https://user:secret@example.com/'));
  for (const input of [
    { type: 'other' },
    { type: 'text', content: '  ' },
    { type: 'url', url: 'file:///etc/passwd' },
    { type: 'feed', url: 'https://example.com', limit: 0 },
  ])
    assert.throws(() => collectionInput(input));
});
