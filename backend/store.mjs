import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError, hash } from './input.mjs';

function canonicalSourceUrl(value) {
  const url = new URL(value);
  url.hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, '') || '';
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
  url.search = new URLSearchParams([...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))).toString();
  return url.href;
}

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
        title TEXT NOT NULL, url TEXT, input_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
        input_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','partial','failed')),
        result_json TEXT, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs(source_id) WHERE status IN ('queued','running');
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, content_hash TEXT UNIQUE NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
        excerpt TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS origins (
        source_id TEXT NOT NULL REFERENCES sources(id), url TEXT NOT NULL,
        document_id TEXT NOT NULL REFERENCES documents(id), metadata_json TEXT NOT NULL,
        raw TEXT NOT NULL, content_type TEXT NOT NULL, fetched_at TEXT NOT NULL,
        PRIMARY KEY (source_id,url)
      );
      CREATE INDEX IF NOT EXISTS origins_document ON origins(document_id);
      CREATE TABLE IF NOT EXISTS visual_captures (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
        document_id TEXT NOT NULL REFERENCES documents(id), mime TEXT NOT NULL,
        bytes BLOB NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS visual_captures_document ON visual_captures(document_id);
      CREATE TABLE IF NOT EXISTS cookie_sessions (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL, label TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('ready','needs_login')),
        expires_at TEXT, revision TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      PRAGMA user_version=2;
    `);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  enqueue(input) {
    return this.transaction(() => {
      const sourceUrl = input.type === 'text' ? '' : canonicalSourceUrl(input.url);
      const identity =
        input.type === 'text'
          ? `text:${hash(`${input.url || ''}\n${input.content}`)}`
          : `${input.type}:${sourceUrl}${input.sessionId ? `\nsession:${input.sessionId}` : ''}`;
      const now = new Date().toISOString();
      let source = this.db.prepare('SELECT id,identity FROM sources WHERE identity=?').get(identity);
      if (!source && input.type !== 'text') {
        const candidates = this.db.prepare('SELECT id,identity,url,input_json FROM sources WHERE type=? AND url IS NOT NULL').all(input.type);
        source = candidates.find(candidate => {
          try {
            const previous = JSON.parse(candidate.input_json);
            return (previous.sessionId || '') === (input.sessionId || '') && canonicalSourceUrl(candidate.url) === sourceUrl;
          } catch { return false; }
        });
      }
      if (source) {
        this.db.prepare('UPDATE sources SET title=?,input_json=? WHERE id=?').run(input.title || input.url, JSON.stringify(input), source.id);
      } else {
        const id = randomUUID();
        this.db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          id, identity, input.type, input.title || input.url, input.url, JSON.stringify(input), now,
        );
        source = { id, identity };
      }
      const active = this.db
        .prepare("SELECT id FROM jobs WHERE source_id=? AND status IN ('queued','running')")
      .get(source.id);
      if (active) return { ...this.job(active.id), reused: true };
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO jobs(id,source_id,input_json,status,created_at) VALUES (?,?,?,'queued',?)",
        )
        .run(id, source.id, JSON.stringify(input), now);
      return { ...this.job(id), reused: false };
    });
  }

  recollect(id) {
    return this.enqueue(this.sourceInput(id));
  }

  sourceInput(id) {
    const source = this.db.prepare('SELECT input_json FROM sources WHERE id=?').get(id);
    if (!source) throw new AppError('来源不存在', 404, 'NOT_FOUND');
    return JSON.parse(source.input_json);
  }

  recover() {
    this.db
      .prepare(
        "UPDATE jobs SET status='queued',started_at=NULL,finished_at=NULL,error=NULL WHERE status='running'",
      )
      .run();
  }

  nextJob() {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT id,input_json FROM jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1",
        )
        .get();
      if (!row) return null;
      this.db
        .prepare("UPDATE jobs SET status='running',started_at=? WHERE id=?")
        .run(new Date().toISOString(), row.id);
      return { ...this.job(row.id), input: JSON.parse(row.input_json) };
    });
  }

  finishJob(id, status, result, error = null) {
    this.db
      .prepare('UPDATE jobs SET status=?,result_json=?,error=?,finished_at=? WHERE id=?')
      .run(status, JSON.stringify(result), error, new Date().toISOString(), id);
  }

  progress(id, result) {
    this.db.prepare('UPDATE jobs SET result_json=? WHERE id=?').run(JSON.stringify(result), id);
  }

  job(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      sourceId: row.source_id,
      status: row.status,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  jobs({ limit, offset }) {
    return {
      items: this.db
        .prepare('SELECT id FROM jobs ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?')
        .all(limit, offset)
        .map(({ id }) => this.job(id)),
      total: this.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,
      limit,
      offset,
    };
  }

  sources({ limit, offset }) {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM origins o WHERE o.source_id=s.id) AS document_count,
      (SELECT status FROM jobs j WHERE j.source_id=s.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS last_status
      FROM sources s ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        url: row.url,
        sessionId: JSON.parse(row.input_json).sessionId || null,
        createdAt: row.created_at,
        documentCount: row.document_count,
        lastStatus: row.last_status,
      })),
      total: this.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n,
      limit,
      offset,
    };
  }

  cookieSession(id) {
    const row = this.db.prepare('SELECT * FROM cookie_sessions WHERE id=?').get(id);
    return row ? { id: row.id, origin: row.origin, label: row.label, state: row.state,
      expiresAt: row.expires_at, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  cookieSessions() {
    return this.db.prepare('SELECT id FROM cookie_sessions ORDER BY created_at DESC').all().map(({ id }) => this.cookieSession(id));
  }

  saveCookieSession({ id, origin, label, expiresAt, revision }) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO cookie_sessions VALUES (?,?,?,'ready',?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label,state='ready',expires_at=excluded.expires_at,
      revision=excluded.revision,updated_at=excluded.updated_at`).run(id, origin, label, expiresAt, revision, now, now);
    return this.cookieSession(id);
  }

  requireCookieLogin(id, revision) {
    this.db.prepare("UPDATE cookie_sessions SET state='needs_login',updated_at=? WHERE id=? AND revision=?")
      .run(new Date().toISOString(), id, revision);
  }

  deleteCookieSession(id) { this.db.prepare('DELETE FROM cookie_sessions WHERE id=?').run(id); }

  saveDocument(sourceId, article, resource) {
    return this.transaction(() => {
      const contentHash = hash(article.text);
      const existing = this.db
        .prepare('SELECT id FROM documents WHERE content_hash=?')
        .get(contentHash);
      const rawOriginUrl = article.url || resource.url || '';
      const originUrl = rawOriginUrl ? (() => { try { return canonicalSourceUrl(rawOriginUrl); } catch { return rawOriginUrl; } })() : '';
      const previous = this.db
        .prepare('SELECT document_id,metadata_json FROM origins WHERE source_id=? AND url=?')
        .get(sourceId, originUrl);
      // A temporary page failure must never replace a previously collected full text with a feed excerpt.
      if (
        previous &&
        article.quality === 'feed_excerpt' &&
        JSON.parse(previous.metadata_json).quality === 'full_text'
      ) {
        return {
          documentId: previous.document_id,
          url: originUrl,
          outcome: 'unchanged',
          quality: 'full_text',
          warning: `${article.warning || '本次仅获取到订阅摘要'}；已保留此前采集的完整正文`,
        };
      }
      const id = existing?.id || randomUUID();
      if (!existing) {
        this.db
          .prepare('INSERT INTO documents VALUES (?,?,?,?,?,?)')
          .run(
            id,
            contentHash,
            article.title || originUrl || '未命名资料',
            article.text,
            article.text.slice(0, 280),
            resource.fetchedAt,
          );
      }
      const metadata = {
        title: article.title,
        author: article.author || null,
        publishedAt: article.publishedAt || null,
        quality: article.quality,
        requestedUrl: article.requestedUrl || originUrl || null,
        finalUrl: resource.url || null,
        warning: article.warning || null,
        ...(resource.visual ? { visual: resource.visual } : {}),
      };
      this.db
        .prepare(
          `INSERT INTO origins VALUES (?,?,?,?,?,?,?) ON CONFLICT(source_id,url) DO UPDATE SET
        document_id=excluded.document_id,metadata_json=excluded.metadata_json,raw=excluded.raw,
        content_type=excluded.content_type,fetched_at=excluded.fetched_at`,
        )
        .run(
          sourceId,
          originUrl,
          id,
          JSON.stringify(metadata),
          resource.text,
          resource.contentType,
          resource.fetchedAt,
        );
      if (resource.screenshot?.bytes) {
        this.db.prepare('INSERT INTO visual_captures VALUES (?,?,?,?,?,?,?)').run(
          randomUUID(), sourceId, id, resource.screenshot.mime, resource.screenshot.bytes,
          JSON.stringify(resource.visual || {}), resource.fetchedAt,
        );
      }
      return {
        documentId: id,
        url: originUrl || null,
        outcome: previous
          ? previous.document_id === id
            ? 'unchanged'
            : 'updated'
          : existing
            ? 'duplicate'
            : 'created',
        quality: article.quality,
        warning: article.warning || null,
      };
    });
  }

  documents({ q = '', sourceId = '', limit, offset }) {
    const escaped = q.replace(/[\\%_]/g, '\\$&');
    const where = `EXISTS (SELECT 1 FROM origins o WHERE o.document_id=d.id AND (?='' OR o.source_id=?))
      AND (?='' OR d.title LIKE ? ESCAPE '\\' OR d.text LIKE ? ESCAPE '\\')`;
    const args = [sourceId, sourceId, q, `%${escaped}%`, `%${escaped}%`];
    const rows = this.db
      .prepare(
        `SELECT d.id,d.title,d.excerpt,d.content_hash,d.created_at,
      (SELECT MAX(fetched_at) FROM origins o WHERE o.document_id=d.id) AS fetched_at
      FROM documents d WHERE ${where} ORDER BY fetched_at DESC,d.id LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);
    return {
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        excerpt: row.excerpt,
        contentHash: row.content_hash,
        createdAt: row.created_at,
        fetchedAt: row.fetched_at,
      })),
      total: this.db.prepare(`SELECT COUNT(*) AS n FROM documents d WHERE ${where}`).get(...args).n,
      limit,
      offset,
    };
  }

  document(id) {
    const row = this.db.prepare('SELECT * FROM documents WHERE id=?').get(id);
    if (!row) return null;
    const origins = this.db
      .prepare(
        `SELECT o.*,s.type FROM origins o JOIN sources s ON s.id=o.source_id WHERE document_id=? ORDER BY fetched_at DESC`,
      )
      .all(id);
    return {
      id: row.id,
      title: row.title,
      text: row.text,
      excerpt: row.excerpt,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      origins: origins.map((origin) => ({
        sourceId: origin.source_id,
        type: origin.type,
        url: origin.url || null,
        ...JSON.parse(origin.metadata_json),
        fetchedAt: origin.fetched_at,
      })),
    };
  }

  visualCapturesForDocument(documentId) {
    return this.db.prepare('SELECT id,source_id,mime,metadata_json,created_at FROM visual_captures WHERE document_id=? ORDER BY created_at DESC')
      .all(documentId).map(row => ({ id: row.id, sourceId: row.source_id, mime: row.mime, ...JSON.parse(row.metadata_json), capturedAt: row.created_at }));
  }

  visualCapture(id) {
    return this.db.prepare('SELECT * FROM visual_captures WHERE id=?').get(id);
  }

  raw(id, sourceId = '') {
    const row = this.db
      .prepare(
        `SELECT raw,content_type,url,fetched_at,metadata_json FROM origins WHERE document_id=?
      AND (?='' OR source_id=?) ORDER BY fetched_at DESC LIMIT 1`,
      )
      .get(id, sourceId, sourceId);
    return row
      ? {
          content: row.raw,
          contentType: row.content_type,
          url: row.url || null,
          fetchedAt: row.fetched_at,
          ...JSON.parse(row.metadata_json),
        }
      : null;
  }

  stats() {
    return {
      sources: this.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n,
      documents: this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM documents d WHERE EXISTS (SELECT 1 FROM origins o WHERE o.document_id=d.id)',
        )
        .get().n,
      jobs: Object.fromEntries(
        this.db
          .prepare('SELECT status,COUNT(*) AS n FROM jobs GROUP BY status')
          .all()
          .map((row) => [row.status, row.n]),
      ),
    };
  }

  close() {
    this.db.close();
  }
}
