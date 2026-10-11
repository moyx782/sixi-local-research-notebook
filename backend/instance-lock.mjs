import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './input.mjs';

// Keep a transaction open for the process lifetime. SQLite releases its OS lock
// after both graceful shutdown and SIGKILL; never unlink this file to unlock it.
export function acquireInstanceLock(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'instance.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch (error) {
    db.close();
    if ((error.errcode & 0xff) === 5 || (error.errcode & 0xff) === 6) {
      throw new AppError('此数据目录已有后端实例运行，请先停止原有服务。', 409, 'INSTANCE_RUNNING');
    }
    throw error;
  }
  let closed = false;
  return {
    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  };
}
