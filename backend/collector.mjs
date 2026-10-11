import { parseFeed, parsePage } from './parsers.mjs';
import { isAuthRequired } from './cookie-sessions.mjs';
import { AppError, cleanText } from './input.mjs';
import { isLoginPage } from './login-detection.mjs';

export class Collector {
  constructor(store, fetcher, { jobTimeoutMs = 180_000, visualCapture } = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.jobTimeoutMs = jobTimeoutMs;
    this.visualCapture = visualCapture;
    this.stopped = false;
    this.running = null;
    this.controller = new AbortController();
    store.recover();
  }

  kick() {
    if (this.stopped || this.running) return;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
  }

  async drain() {
    while (!this.stopped) {
      const job = this.store.nextJob();
      if (!job) return;
      await this.run(job);
    }
  }

  async run(job) {
    const result = {
      created: 0,
      updated: 0,
      duplicate: 0,
      unchanged: 0,
      failed: 0,
      skipped: 0,
      warnings: [],
      items: [],
    };
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(this.jobTimeoutMs),
    ]);
    const save = (article, resource) => {
      const saved = this.store.saveDocument(job.sourceId, article, resource);
      result[saved.outcome]++;
      result.items.push(saved);
      if (saved.warning) result.warnings.push({ url: saved.url, message: saved.warning });
      this.store.progress(job.id, result);
    };
    const skip = (url, error) => {
      result.failed++;
      result.skipped++;
      result.items.push({ url, outcome: 'skipped', errorCode: error.code, error: error.message });
      if (isAuthRequired(error)) {
        result.authRequired = true;
        result.sessionId = job.input.sessionId;
        result.errorCode = error.code;
      }
      this.store.progress(job.id, result);
    };
    try {
      const input = job.input;
      if (input.type === 'text') {
        save(
          { title: input.title, text: input.content, url: input.url, quality: 'imported_text' },
          {
            url: input.url,
            text: input.content,
            contentType: 'text/plain',
            fetchedAt: new Date().toISOString(),
          },
        );
      } else {
        const resource = input.renderMode === 'playwright'
          ? await this.visualCapture?.capture(input.url, { signal, sessionId: input.sessionId, fullPage: input.fullPage })
          : await this.fetcher.fetch(input.url, { signal, sessionId: input.sessionId });
        if (!resource) throw new AppError('Playwright 视觉采集未配置，请安装浏览器运行时后重试', 503, 'PLAYWRIGHT_UNAVAILABLE');
        if(input.autoDiscover&&isLoginPage(resource))throw new AppError('页面需要真人登录，请通过人工补采提交资料',409,'AUTH_REQUIRED');
        if (input.type === 'url') {
          let article;
          try { article = parsePage(resource); }
          catch (error) {
            if (input.renderMode === 'playwright' && resource.visualText && cleanText(resource.visualText).length >= 40) {
              article = { title: resource.visual?.title || input.url, text: cleanText(resource.visualText), quality: 'full_text', warning: '正文由 Playwright 渲染后的可见文字提取，请对照页面截图核实。' };
            } else throw error;
          }
          save({ ...article, url: input.url, requestedUrl: input.url }, resource);
        } else {
          const feed = parseFeed(resource, input.limit);
          if (feed.invalidCount)
            result.warnings.push({
              url: input.url,
              message: `${feed.invalidCount} 条订阅条目缺少有效地址，已跳过`,
            });
          let blockedSessionError;
          for (const entry of feed.items) {
            if (this.stopped) throw new Error('服务正在停止');
            const sessionId = new URL(entry.url).origin === new URL(input.url).origin ? input.sessionId : undefined;
            try {
              if (sessionId && blockedSessionError) throw blockedSessionError;
              const page = await this.fetcher.fetch(entry.url, { signal, sessionId });
              const article = parsePage(page);
              save(
                {
                  ...article,
                  url: entry.url,
                  title: article.title || entry.title,
                  author: article.author || entry.author,
                  publishedAt: article.publishedAt || entry.publishedAt,
                },
                page,
              );
            } catch (error) {
              if (this.stopped) throw error;
              if (isAuthRequired(error) || error.code === 'KEYCHAIN_UNAVAILABLE' || error.code === 'AUTH_SCOPE_MISMATCH') {
                // No user interaction belongs in the worker. Skip gated entries,
                // continue public ones, and then move on to other queued sources.
                if (sessionId && error.code !== 'AUTH_SCOPE_MISMATCH') blockedSessionError = error;
                skip(entry.url, error);
                continue;
              }
              if (entry.text) {
                save(
                  { ...entry, warning: `网页正文采集失败，保留订阅摘要：${error.message}` },
                  resource,
                );
              } else {
                result.failed++;
                result.items.push({ url: entry.url, outcome: 'failed', error: error.message });
                this.store.progress(job.id, result);
              }
            }
          }
        }
      }
      const successes = result.created + result.updated + result.duplicate + result.unchanged;
      const status =
        result.failed && !successes
          ? 'failed'
          : result.failed || result.warnings.length
            ? 'partial'
            : 'succeeded';
      this.store.finishJob(job.id, status, result, status === 'failed' ? '所有条目采集失败' : null);
    } catch (error) {
      // Leave an interrupted job queued so the next process can safely resume it.
      if (this.stopped) {
        this.store.db
          .prepare("UPDATE jobs SET status='queued',started_at=NULL WHERE id=?")
          .run(job.id);
        return;
      }
      const successes = result.created + result.updated + result.duplicate + result.unchanged;
      result.errorCode = error.code || 'COLLECTION_FAILED';
      if (isAuthRequired(error) || error.code === 'KEYCHAIN_UNAVAILABLE' || error.code === 'AUTH_SCOPE_MISMATCH') skip(job.input.url, error);
      this.store.finishJob(job.id, successes ? 'partial' : 'failed', result, error.message);
    }
  }

  async close() {
    this.stopped = true;
    this.controller.abort();
    await this.running;
    await this.fetcher.close();
  }
}
