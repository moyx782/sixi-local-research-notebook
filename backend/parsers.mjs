import { JSDOM } from 'jsdom';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AppError, cleanText, normalizeUrl } from './input.mjs';

const date = (value) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const string = (value) => (typeof value === 'string' ? value : value?.['#text'] || '');
const array = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function removePageControls(node) {
  node
    .querySelectorAll(
      'script,style,noscript,nav,footer,header,form,iframe,svg,button,select,' +
        '[role="navigation"],[role="button"],[hidden],[aria-hidden="true"]',
    )
    .forEach((element) => element.remove());
}

function readableText(node) {
  removePageControls(node);
  node
    .querySelectorAll('p,div,section,article,h1,h2,h3,h4,li,blockquote,pre,tr,br')
    .forEach((element) => {
      element.appendChild(node.ownerDocument.createTextNode('\n'));
    });
  return cleanText(node.textContent);
}

export function htmlText(value) {
  const fragment = JSDOM.fragment(value);
  return readableText(fragment);
}

function extractedBody(parsed) {
  const fragment = JSDOM.fragment(parsed?.content || '');
  removePageControls(fragment);
  // Check the extracted fragment, not hidden prose elsewhere on the page.
  const hasProse = isProbablyReaderable(fragment, { minContentLength: 40, minScore: 5 });
  const text = readableText(fragment);
  const isErrorPage = text.length < 1500 &&
    /(?:^|\n)\s*(?:just a moment|verify you are human|checking your browser|there was an error while loading|enable javascript and cookies to continue)\b/i.test(text);
  return { text, valid: text.length >= 40 && hasProse && !isErrorPage };
}

export function parsePage(resource) {
  if (resource.contentType.startsWith('text/plain')) {
    const text = cleanText(resource.text);
    if (!text) throw new AppError('来源没有可用正文', 422, 'EMPTY_CONTENT');
    return {
      title: text.slice(0, 80),
      text,
      author: null,
      publishedAt: null,
      quality: 'full_text',
    };
  }
  if (!/^(text\/html|application\/xhtml\+xml)\b/.test(resource.contentType)) {
    throw new AppError('该地址不是网页或纯文本；RSS 请使用 feed 类型', 422, 'UNSUPPORTED_CONTENT');
  }
  const dom = new JSDOM(resource.text, { url: resource.url });
  try {
    const document = dom.window.document;
    const title = cleanText(
      document.querySelector('meta[property="og:title"]')?.content || document.title,
    );
    const author = document.querySelector('meta[name="author"]')?.content || null;
    const publishedAt = date(
      document.querySelector('meta[property="article:published_time"]')?.content ||
        document.querySelector('time[datetime]')?.dateTime,
    );
    removePageControls(document);
    const fallbackRoot = document.querySelector('main,article,[role="main"],section#content')?.cloneNode(true);
    const options = { maxElemsToParse: 30_000, charThreshold: 80 };
    let parsed = new Readability(document, options).parse();
    let body = extractedBody(parsed);
    if (!body.valid && fallbackRoot) {
      // Catalog layout class names can make Readability prefer a short promo.
      // Retry only the explicit content region, with layout hints removed;
      // keep the same prose/error checks and never fall back to whole-page text.
      for (const element of [fallbackRoot, ...fallbackRoot.querySelectorAll('*')]) {
        element.removeAttribute('class');
        element.removeAttribute('id');
      }
      const retry = document.implementation.createHTMLDocument(title);
      const base = retry.createElement('base');
      base.href = resource.url;
      retry.head.append(base);
      retry.body.append(fallbackRoot);
      parsed = new Readability(retry, options).parse();
      body = extractedBody(parsed);
    }
    if (!body.valid)
      throw new AppError('未提取到足够正文，来源可能需要 JavaScript 或登录', 422, 'EMPTY_CONTENT');
    return {
      title: cleanText(parsed.title) || title || new URL(resource.url).hostname,
      text: body.text,
      author: cleanText(parsed.byline || author) || null,
      publishedAt: date(parsed.publishedTime) || publishedAt,
      quality: 'full_text',
    };
  } finally {
    dom.window.close();
  }
}

export function parseFeed(resource, limit = 20) {
  // DTDs are unnecessary for feeds; rejecting them also prevents entity expansion.
  if (/<!DOCTYPE|<!ENTITY/i.test(resource.text))
    throw new AppError('订阅源不能包含 DTD 或实体声明', 422, 'INVALID_FEED');
  if (XMLValidator.validate(resource.text) !== true)
    throw new AppError('订阅源 XML 格式无效', 422, 'INVALID_FEED');
  const parsed = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    removeNSPrefix: true,
    stopNodes: ['*.content', '*.description', '*.summary', '*.encoded'],
  }).parse(resource.text);
  const isAtom = Boolean(parsed.feed);
  const channel = parsed.rss?.channel || parsed.feed || parsed.RDF;
  if (!channel) throw new AppError('该地址不是 RSS 或 Atom 订阅源', 422, 'INVALID_FEED');
  const entries = array(isAtom ? channel.entry : channel.item);
  const seen = new Set();
  const items = [];
  let invalidCount = 0;
  for (const entry of entries) {
    const links = array(entry.link);
    const link = isAtom
      ? links.find((value) => !value['@_rel'] || value['@_rel'] === 'alternate')?.['@_href']
      : string(entry.link);
    const address = link || (entry.guid?.['@_isPermaLink'] !== 'false' ? string(entry.guid) : '');
    if (!address.trim()) {
      invalidCount++;
      continue;
    }
    let url;
    try {
      const feedBase = normalizeUrl(channel['@_base'] || resource.url, resource.url);
      const entryBase = normalizeUrl(entry['@_base'] || feedBase, feedBase);
      url = normalizeUrl(address, entryBase);
    } catch {
      invalidCount++;
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    let content = string(entry.encoded || entry.content || entry.description || entry.summary);
    if (/^<!\[CDATA\[/.test(content))
      content = content.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');
    else {
      // stopNodes preserves raw XML text. Decode that layer before stripping HTML.
      const textarea = JSDOM.fragment('<textarea></textarea>').firstChild;
      textarea.innerHTML = content;
      content = textarea.value;
    }
    items.push({
      url,
      title: htmlText(string(entry.title)),
      text: htmlText(content),
      author: cleanText(string(entry.author?.name || entry.author || entry.creator)) || null,
      publishedAt: date(string(entry.published || entry.pubDate || entry.updated || entry.date)),
      quality: 'feed_excerpt',
    });
    if (items.length >= limit) break;
  }
  return { title: htmlText(string(channel.title || channel.channel?.title)), items, invalidCount };
}
