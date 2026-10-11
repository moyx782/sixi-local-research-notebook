import { localHeaders } from './local-client.mjs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { cookieHeader, cookieSessionInput } from '../backend/cookie-sessions.mjs';
import { sessionId } from '../backend/input.mjs';

const usage = `用法：
  npm run cookies -- set 会话编号 https://网站域名 [--expires ISO日期]
  npm run cookies -- list
  npm run cookies -- remove 会话编号
set 会提示隐藏输入 Cookie 请求头，请勿把 Cookie 写入命令参数。
服务地址默认 http://127.0.0.1:4173，可用 SIXI_BASE_URL 设置本机端口。`;

async function readCookie() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 16_386) throw new Error('Cookie 输入过长');
      chunks.push(chunk);
    }
    return cookieHeader(Buffer.concat(chunks).toString('utf8'));
  }
  process.stderr.write('粘贴请求中的 Cookie（输入隐藏），按回车保存：');
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 });
  try {
    return await new Promise((resolve, reject) => {
      reader.once('line', resolve);
      reader.once('SIGINT', () => reject(new Error('已取消 Cookie 录入')));
      reader.once('close', () => reject(new Error('Cookie 输入已关闭')));
    });
  } finally {
    reader.close();
    process.stderr.write('\n');
  }
}

async function main() {
  const [command, id, origin, flag, expiresAt, ...extra] = process.argv.slice(2);
  if (command === 'list' ? id !== undefined : command === 'remove' ? !id || origin !== undefined
    : command === 'set' ? !id || !origin || extra.length || (flag !== undefined && (flag !== '--expires' || !expiresAt)) : true) {
    throw new Error(usage);
  }
  const base = new URL(process.env.SIXI_BASE_URL || 'http://127.0.0.1:4173');
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
      base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('SIXI_BASE_URL 必须是本机 HTTP 服务地址');
  }
  let input;
  if (command !== 'list') sessionId(id);
  if (command === 'set') {
    // Validate the target before prompting for the sensitive value.
    cookieSessionInput({ id, origin, expiresAt, cookie: 'validation=only' });
    input = cookieSessionInput({ id, origin, expiresAt, cookie: await readCookie() });
  }
  const path = `/api/cookie-sessions${command === 'remove' ? `/${id}` : ''}`;
  let response;
  try {
    response = await fetch(new URL(path, base), {
      method: command === 'set' ? 'POST' : command === 'remove' ? 'DELETE' : 'GET',
      headers: { 'content-type': 'application/json', ...await localHeaders(base) },
      body: input ? JSON.stringify(input) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new Error('无法连接本机后端，请检查服务状态'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败：HTTP ${response.status}`);
  if (command === 'list') {
    if (!result.items.length) console.log('尚未配置 Cookie 会话。');
    else for (const item of result.items) console.log(`${item.id}\t${item.origin}\t${item.state}\t${item.expiresAt || '未设置到期时间'}`);
  } else if (command === 'set') console.log(`已保存会话 ${result.session.id}（${result.session.origin}）。`);
  else console.log('会话已移除；已有资料保留。');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
