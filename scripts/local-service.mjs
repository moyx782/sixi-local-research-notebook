import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rename, writeFile, access, rm } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync, backup } from 'node:sqlite';

const root = fileURLToPath(new URL('..', import.meta.url));
const label = 'com.sixi.backend';
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;
const installDir = join(homedir(), 'Library', 'Application Support', 'Sixi', 'backend');
const logDir = join(homedir(), 'Library', 'Logs', 'Sixi');
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const statePath = join(installDir, 'active.json');

function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry.internal && entry.family === 'IPv4' && entry.address && isLanIPv4(entry.address)) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

function isLanIPv4(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
}

function serviceUrls(port, bindHost) {
  if (bindHost === '0.0.0.0' || bindHost === '::') return lanAddresses().map((address) => `http://${address}:${port}`);
  const display = bindHost.includes(':') && !bindHost.startsWith('[') ? `[${bindHost}]` : bindHost;
  return [`http://${display}:${port}`];
}

function run(command, args, { cwd = root, output = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: output ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !allowFailure)
        reject(new Error(`${command} ${args[0]} failed (${code}): ${stderr.trim()}`));
      else resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const loaded = async () =>
  (await run('launchctl', ['print', service], { allowFailure: true })).code === 0;
const xml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char],
  );
const atomicWrite = async (path, content) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
};

async function portOccupied(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function healthy(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const value = await response.json();
      if (response.ok && value.ok) return value;
    } catch {
      /* launchd may still be starting the process */
    }
    await delay(250);
  }
  throw new Error(`服务未在 30 秒内就绪，请检查 ${join(logDir, 'stderr.log')}`);
}

async function bootout() {
  if (await loaded()) {
    await run('launchctl', ['bootout', service]);
    const deadline = Date.now() + 25_000;
    while (await loaded()) {
      if (Date.now() >= deadline) throw new Error('launchd 尚未卸载旧服务，请稍后重试');
      await delay(250);
    }
  }
}

async function bootstrap() {
  await run('launchctl', ['enable', service]);
  // bootout can return before launchd has fully released the service name.
  // Retry that transient EIO only while the service is still absent.
  const deadline = Date.now() + 10_000;
  while (true) {
    const result = await run('launchctl', ['bootstrap', domain, plistPath], { allowFailure: true });
    if (result.code === 0) return;
    if (result.code !== 5 || Date.now() >= deadline || await loaded()) {
      throw new Error(`launchctl bootstrap failed (${result.code}): ${result.stderr}`);
    }
    await delay(250);
  }
}

async function deploy() {
  const backendOnly = process.argv.includes('--backend-only');
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('PORT 必须在 1024–65535 之间');
  const dataDir = resolve(process.env.SIXI_DATA_DIR || join(homedir(), '.sixi'));
  const previousState = backendOnly ? JSON.parse(await readFile(statePath, 'utf8')) : null;
  const bindHost = process.env.SIXI_BIND_HOST || previousState?.bindHost || '127.0.0.1';
  const releaseId = new Date().toISOString().replace(/[-:.]/g, '') + `-${process.pid}`;
  const releaseDir = join(installDir, 'releases', releaseId);
  const assetsRoot = backendOnly ? previousState.releaseDir : root;
  const hadService = await loaded();
  if (!hadService && (await portOccupied(port)))
    throw new Error(`端口 ${port} 被未托管的进程占用；先确认并停止旧服务，再部署。`);
  for (const path of [releaseDir, logDir, dataDir, dirname(plistPath)])
    await mkdir(path, { recursive: true, mode: 0o700 });
  console.log(`准备独立部署目录：${releaseDir}`);
  for (const name of [
    'server.mjs',
    'backend',
    'scripts',
    'test',
    'docs',
    'README.md',
    'package.json',
    'package-lock.json',
  ]) {
    await cp(join(root, name), join(releaseDir, name), { recursive: true });
  }
  for (const name of ['index.html', 'app.js', 'styles.css']) await cp(join(assetsRoot, name), join(releaseDir, name));
  if (await exists(join(assetsRoot, 'frontend'))) await cp(join(assetsRoot, 'frontend'), join(releaseDir, 'frontend'), { recursive: true });
  await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: releaseDir,
    output: true,
  });
  await run('npm', ['run', 'check'], { cwd: releaseDir, output: true });
  await run('npm', ['test'], { cwd: releaseDir, output: true });

  let backupPath = null;
  const dbPath = join(dataDir, 'library.sqlite');
  if (await exists(dbPath)) {
    await mkdir(join(dataDir, 'backups'), { recursive: true, mode: 0o700 });
    backupPath = join(dataDir, 'backups', `${releaseId}.sqlite`);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      await backup(db, backupPath);
    } finally {
      db.close();
    }
    console.log(`资料库备份：${backupPath}`);
  }

  const oldPlist = (await exists(plistPath)) ? await readFile(plistPath, 'utf8') : null;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(releaseDir, 'server.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(releaseDir)}</string>
<key>EnvironmentVariables</key><dict>
<key>NODE_ENV</key><string>production</string><key>PORT</key><string>${port}</string>
<key>SIXI_DATA_DIR</key><string>${xml(dataDir)}</string>
<key>SIXI_BIND_HOST</key><string>${xml(bindHost)}</string>
<key>SIXI_AUTH_REQUIRED</key><string>${xml(process.env.SIXI_AUTH_REQUIRED || '1')}</string>
<key>SIXI_DNS_FALLBACK</key><string>${xml(process.env.SIXI_DNS_FALLBACK || 'on')}</string>
<key>PATH</key><string>${xml(dirname(process.execPath))}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>20</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(logDir, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logDir, 'stderr.log'))}</string>
</dict></plist>
`;
  await bootout();
  try {
    await atomicWrite(plistPath, plist);
    await run('plutil', ['-lint', plistPath]);
    await bootstrap();
    const health = await healthy(port);
    const state = {
      service,
      releaseDir,
      port,
      bindHost,
      urls: serviceUrls(port, bindHost),
      dataDir,
      plistPath,
      logDir,
      backupPath,
      node: process.execPath,
      deployedAt: new Date().toISOString(),
      ...(backendOnly ? { assetsFrom: assetsRoot } : {}),
    };
    await atomicWrite(statePath, JSON.stringify(state, null, 2));
    console.log(JSON.stringify({ ...state, health }, null, 2));
  } catch (error) {
    await bootout();
    if (oldPlist) {
      await atomicWrite(plistPath, oldPlist);
      if (hadService) await bootstrap();
    } else await rm(plistPath, { force: true });
    throw error;
  }
}

try {
  if (process.platform !== 'darwin') throw new Error('此脚本用于 macOS 用户级 launchd 部署');
  const command = process.argv[2] || 'status';
  if (command === 'deploy') await deploy();
  else {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (command === 'restart') {
      await bootout();
      await bootstrap();
    } else if (command === 'stop') await bootout();
    else if (command === 'start') {
      if (!(await loaded())) await bootstrap();
    } else if (command !== 'status') throw new Error('支持 deploy、status、restart、start、stop');
    const running = await loaded();
    console.log(
      JSON.stringify(
        {
          service,
          loaded: running,
          releaseDir: state.releaseDir,
          bindHost: state.bindHost || '127.0.0.1',
          url: serviceUrls(state.port, state.bindHost || '127.0.0.1')[0] || `http://127.0.0.1:${state.port}`,
          urls: serviceUrls(state.port, state.bindHost || '127.0.0.1'),
          health: running ? await healthy(state.port) : null,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
