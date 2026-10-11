import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AppError } from './input.mjs';

// Never place secret data in argv, environment variables, errors or console output.
export function runSecurity(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(new AppError('无法访问 macOS 钥匙串', 503, 'KEYCHAIN_UNAVAILABLE'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export class MacKeychain {
  constructor(namespace, { run = runSecurity } = {}) {
    if (!/^[a-f0-9]{64}$/.test(namespace)) throw new Error('Invalid Keychain namespace');
    this.service = `com.sixi.cookies.${namespace}`;
    this.run = run;
  }

  account(id) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new AppError('会话编号格式无效');
    return id;
  }

  async readRaw(account) {
    const result = await this.run(['find-generic-password', '-s', this.service, '-a', account, '-w']);
    if (result.code === 44) return null;
    if (result.code !== 0) throw new AppError('无法读取钥匙串，请确认登录钥匙串已解锁', 503, 'KEYCHAIN_UNAVAILABLE');
    return result.stdout.trim();
  }

  async writeRaw(account, encoded) {
    if (!/^[A-Za-z0-9_:-]{1,128}$/.test(account) || !/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new Error('Invalid Keychain payload');
    // Each interactive command must fit security's fixed-size input buffer.
    // Secret data travels through stdin, never through argv or the environment.
    const command = `add-generic-password -U -s ${this.service} -a ${account} -w ${encoded}\n`;
    const result = await this.run(['-i', '-q', '-p', ''], command);
    if (result.code !== 0 || await this.readRaw(account) !== encoded) {
      throw new AppError('无法保存到钥匙串，请确认登录钥匙串已解锁', 503, 'KEYCHAIN_UNAVAILABLE');
    }
  }

  async removeRaw(account) {
    const result = await this.run(['delete-generic-password', '-s', this.service, '-a', account]);
    if (![0, 44].includes(result.code)) throw new AppError('无法移除钥匙串会话', 503, 'KEYCHAIN_UNAVAILABLE');
  }

  async manifest(id) {
    const raw = await this.readRaw(this.account(id));
    if (raw === null) return null;
    try {
      const value = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      if (value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.token) || !Number.isInteger(value.parts) || value.parts < 1 || value.parts > 32) throw new Error();
      return value;
    } catch { throw new AppError('钥匙串会话格式无效，请移除后重新录入', 409, 'AUTH_REQUIRED'); }
  }

  partAccount(id, manifest, index) { return `${id}:${manifest.token}:${index}`; }

  async get(id) {
    const manifest = await this.manifest(id);
    if (!manifest) return null;
    const parts = [];
    for (let index = 0; index < manifest.parts; index++) {
      const part = await this.readRaw(this.partAccount(id, manifest, index));
      if (part === null) throw new AppError('钥匙串会话不完整，请重新录入', 409, 'AUTH_REQUIRED');
      parts.push(part);
    }
    try { return JSON.parse(Buffer.from(parts.join(''), 'base64').toString('utf8')); }
    catch { throw new AppError('钥匙串会话格式无效，请重新录入', 409, 'AUTH_REQUIRED'); }
  }

  async set(id, value) {
    const previous = await this.manifest(id);
    const encoded = Buffer.from(JSON.stringify(value)).toString('base64');
    const chunks = encoded.match(/.{1,2048}/g);
    if (!chunks || chunks.length > 32) throw new AppError('钥匙串会话过大');
    const manifest = { version: 1, token: randomUUID(), parts: chunks.length };
    let published = false;
    try {
      for (let index = 0; index < chunks.length; index++) await this.writeRaw(this.partAccount(id, manifest, index), chunks[index]);
      await this.writeRaw(this.account(id), Buffer.from(JSON.stringify(manifest)).toString('base64'));
      published = true;
      if (previous) for (let index = 0; index < previous.parts; index++) await this.removeRaw(this.partAccount(id, previous, index));
    } catch (error) {
      // A failed root verification may still have published the new manifest.
      // Keep referenced parts intact; only discard a definitively unpublished set.
      const current = await this.manifest(id).catch(() => undefined);
      if (!published && current !== undefined && current?.token !== manifest.token) {
        for (let index = 0; index < chunks.length; index++) await this.removeRaw(this.partAccount(id, manifest, index)).catch(() => {});
      }
      throw error;
    }
  }

  async delete(id) {
    let manifest;
    try { manifest = await this.manifest(id); }
    catch (error) {
      if (error.code !== 'AUTH_REQUIRED') throw error;
      // Allow removing a corrupt root without trusting its invalid chunk references.
      manifest = null;
    }
    if (manifest) for (let index = 0; index < manifest.parts; index++) await this.removeRaw(this.partAccount(id, manifest, index));
    await this.removeRaw(this.account(id));
  }
}
