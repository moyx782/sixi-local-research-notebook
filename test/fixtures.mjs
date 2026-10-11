export const articleText =
  '本地研究笔记需要可靠的数据来源。采集系统保存正文、出处和时间，帮助研究者追溯结论。重复来源应当合并，更新后的内容应当保留独立版本。可靠的数据比漂亮的界面更重要。';
export const html = (text = articleText) =>
  `<!doctype html><html lang="zh"><head><title>后端数据采集</title><meta name="author" content="研究者"><meta property="article:published_time" content="2026-09-17"></head><body><nav>导航</nav><main><article><h1>后端数据采集</h1><p>${text}</p><p>${text}</p></article></main><script>throw new Error('不应执行脚本')</script><footer>页脚</footer></body></html>`;
export const resource = (text, url = 'https://example.com/article', contentType = 'text/html') => ({
  text,
  url,
  contentType,
  fetchedAt: new Date().toISOString(),
});
export const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>研究订阅</title>
  <item><title>第一篇</title><link>https://example.com/one</link><description><![CDATA[<p>第一篇的摘要</p>]]></description><pubDate>Thu, 17 Sep 2026 00:00:00 GMT</pubDate></item>
  <item><title>第二篇</title><link>https://example.com/two</link><content:encoded><![CDATA[<p>第二篇正文，网站暂时不可访问。</p>]]></content:encoded></item>
  <item><title>第三篇</title><link>https://example.com/three</link></item>
</channel></rss>`;
