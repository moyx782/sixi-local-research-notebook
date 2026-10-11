import { AppError, collectionInput, integer } from './input.mjs';

export async function collectionRoute(req, url, { store, collector, sessions, handoffs, uploads, body, json, res }) {
  const path = url.pathname;
  const page = () => ({
    limit: integer(url.searchParams.get('limit'), 20, 1, 100),
    offset: integer(url.searchParams.get('offset'), 0, 0, 1_000_000),
  });
  if (path === '/api/health' && req.method === 'GET') {
    json(res, 200, { ok: true, ...store.stats() });
    return true;
  }
  if (path === '/api/cookie-sessions') {
    if (req.method === 'GET') json(res, 200, { ok: true, items: sessions.list() });
    else if (req.method === 'POST') json(res, 200, { ok: true, session: await sessions.save(await body(req)) });
    else throw new AppError('该接口仅支持 GET、POST', 405, 'METHOD_NOT_ALLOWED');
    return true;
  }
  const session = path.match(/^\/api\/cookie-sessions\/([\w-]+)$/);
  if (session && req.method === 'DELETE') {
    await sessions.delete(session[1]);
    json(res, 200, { ok: true });
    return true;
  }
  if (path === '/api/collections') {
    if (req.method === 'POST') {
      const input = collectionInput(await body(req));
      if (input.sessionId) sessions.validate(input.sessionId, input.url);
      const job = store.enqueue(input);
      collector.kick();
      json(res, 202, { ok: true, job });
    } else if (req.method === 'GET') json(res, 200, { ok: true, ...store.jobs(page()) });
    else throw new AppError('该接口仅支持 GET、POST', 405, 'METHOD_NOT_ALLOWED');
    return true;
  }
  const collection = path.match(/^\/api\/collections\/([\w-]+)$/);
  if (collection && req.method === 'GET') {
    const job = store.job(collection[1]);
    if (!job) throw new AppError('采集任务不存在', 404, 'NOT_FOUND');
    json(res, 200, { ok: true, job });
    return true;
  }
  if (path === '/api/sources' && req.method === 'GET') {
    json(res, 200, { ok: true, ...store.sources(page()) });
    return true;
  }
  const recollect = path.match(/^\/api\/sources\/([\w-]+)\/collect$/);
  if (recollect && req.method === 'POST') {
    const input = store.sourceInput(recollect[1]);
    if (input.sessionId) sessions.validate(input.sessionId, input.url);
    const job = store.recollect(recollect[1]);
    collector.kick();
    json(res, 202, { ok: true, job });
    return true;
  }
  if (path === '/api/documents' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    if (q.length > 200) throw new AppError('查询关键词不能超过 200 字');
    json(res, 200, {
      ok: true,
      ...store.documents({ ...page(), q, sourceId: url.searchParams.get('sourceId') || '' }),
    });
    return true;
  }
  const document = path.match(/^\/api\/documents\/([\w-]+)(\/raw)?$/);
  if (document && req.method === 'GET') {
    const value = document[2]
      ? store.raw(document[1], url.searchParams.get('sourceId') || '')
      : store.document(document[1]);
    if (!value) throw new AppError('资料不存在', 404, 'NOT_FOUND');
    if(!document[2])value.attachments=[...(handoffs?.attachmentsForDocument(value)||[]),...(uploads?.attachmentsForDocument(value)||[]),...(store.visualCapturesForDocument(value.id)||[]).map(a=>({...a,kind:'image',parser:'playwright',url:`/api/visual-captures/${a.id}/image`,downloadUrl:`/api/visual-captures/${a.id}/image`}))];
    json(res, 200, { ok: true, [document[2] ? 'raw' : 'document']: value });
    return true;
  }
  const visual = path.match(/^\/api\/visual-captures\/([\w-]+)\/image$/);
  if (visual && req.method === 'GET') {
    const row=store.visualCapture(visual[1]);if(!row)throw new AppError('视觉截图不存在',404,'NOT_FOUND');
    res.writeHead(200,{'Content-Type':row.mime,'Content-Length':row.bytes.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'"});res.end(Buffer.from(row.bytes));return true;
  }
  return false;
}
