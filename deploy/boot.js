'use strict';

/**
 * 单容器双进程引导器
 *   - 子进程 1：天翼云 / 移动云电脑控制台（ctyun-dashboard），默认 8566
 *   - 子进程 2：中国移动云手机控制台（cmcc-phone），默认 8577
 *   - 本进程：8555 统一入口页 + /health 聚合健康检查
 *
 * 设计原则：
 *   1. 两个上游项目互不感知，各自用独立的数据目录，互不污染；
 *   2. 任一子进程崩溃自动拉起（指数退避，稳定运行后重置）；
 *   3. 收到 SIGTERM/SIGINT 时先给子进程发信号，等待退出，避免数据写坏；
 *   4. 只依赖 Node 内置模块，不引入 supervisor / s6 之类的额外组件。
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CTYUN_DIR = process.env.CTYUN_DIR || '/opt/ctyun';
const CMCC_DIR = process.env.CMCC_DIR || '/opt/cmcc';
const DATA_ROOT = process.env.DATA_ROOT || '/data';
const PORTAL_PORT = Number(process.env.PORTAL_PORT || 8555);

const APPS = [
  {
    name: 'ctyun',
    label: '天翼云 / 移动云电脑',
    port: Number(process.env.CTYUN_PORT || 8566),
    script: path.join(CTYUN_DIR, 'server.js'),
    cwd: CTYUN_DIR,
    dataDir: path.join(DATA_ROOT, 'ctyun'),
    env: (dataDir, port) => ({
      PORT: String(port),
      CTYUN_DATA_DIR: dataDir,
      ECLOUD_CRED_FILE: path.join(dataDir, 'ecloud_credentials.json'),
      ECLOUD_SESSION_FILE: path.join(dataDir, 'ecloud_sessions.json'),
      ECLOUD_LOGIN_RATE_LIMIT_FILE: path.join(dataDir, 'ecloud_login_rate_limit.json'),
      ECLOUD_PYTHON: process.env.ECLOUD_PYTHON || '/usr/bin/python3',
    }),
  },
  {
    name: 'cmcc',
    label: '中国移动云手机',
    port: Number(process.env.CMCC_PORT || 8577),
    script: path.join(CMCC_DIR, 'src', 'server.js'),
    cwd: CMCC_DIR,
    dataDir: path.join(DATA_ROOT, 'cmcc'),
    env: (dataDir, port) => ({
      PORT: String(port),
      DATA_DIR: dataDir,
      HOST: '0.0.0.0',
    }),
  },
];

const children = new Map();
let shuttingDown = false;

function log(app, line, isErr) {
  const text = String(line).replace(/\r/g, '');
  const stream = isErr ? process.stderr : process.stdout;
  for (const piece of text.split('\n')) {
    if (piece.trim().length === 0) continue;
    stream.write(`[${app}] ${piece}\n`);
  }
}

function pipeLines(stream, app, isErr) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const p of parts) log(app, p, isErr);
  });
  stream.on('end', () => {
    if (buffer) {
      log(app, buffer, isErr);
      buffer = '';
    }
  });
}

function startApp(app, priorFailures = 0) {
  if (shuttingDown) return;

  if (!fs.existsSync(app.script)) {
    log(app.name, `启动失败：找不到入口文件 ${app.script}`, true);
    return scheduleRestart(app, { failures: priorFailures + 1, startedAt: 0 });
  }

  fs.mkdirSync(app.dataDir, { recursive: true });

  const child = spawn(process.execPath, [app.script], {
    cwd: app.cwd,
    env: {
      ...process.env,
      ...app.env(app.dataDir, app.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state = { child, startedAt: Date.now(), failures: priorFailures };
  children.set(app.name, state);

  pipeLines(child.stdout, app.name, false);
  pipeLines(child.stderr, app.name, true);

  log(app.name, `进程已启动 (pid=${child.pid}, 端口 ${app.port}, 数据目录 ${app.dataDir})`);

  child.on('exit', (code, signal) => {
    children.delete(app.name);
    log(app.name, `进程退出 code=${code} signal=${signal || '-'}`, true);
    if (!shuttingDown) scheduleRestart(app, state);
  });

  child.on('error', (err) => {
    log(app.name, `进程启动异常: ${err.message}`, true);
  });
}

function scheduleRestart(app, state) {
  if (shuttingDown) return;
  // 稳定运行超过 60 秒后再挂，视为新故障，退避从头开始
  const healthyRun = state && state.startedAt && Date.now() - state.startedAt > 60000;
  const failures = healthyRun ? 0 : ((state && state.failures) || 0) + 1;
  const delay = Math.min(30000, 2000 * Math.pow(2, Math.max(0, failures - 1)));
  log(app.name, `${Math.round(delay / 1000)} 秒后自动重启（第 ${failures} 次）`);
  setTimeout(() => startApp(app, failures), delay);
}

// ---------------------------------------------------------------- 健康检查
function probe(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve({ up: res.statusCode < 500, status: res.statusCode });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ up: false, status: 0 }); });
    req.on('error', () => resolve({ up: false, status: 0 }));
    req.end();
  });
}

function collectHealth() {
  return Promise.all(
    APPS.map(async (app) => {
      const r = await probe(app.port);
      return { name: app.name, label: app.label, port: app.port, up: r.up, status: r.status };
    })
  );
}

// ---------------------------------------------------------------- 入口页
const PORTAL_HTML = path.join(__dirname, 'portal', 'index.html');

const portal = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    const apps = await collectHealth();
    const body = JSON.stringify({
      ok: apps.every((a) => a.up),
      time: Date.now(),
      apps,
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(PORTAL_HTML, (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('入口页缺失: ' + err.message);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  if (url.pathname === '/api/ports') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(APPS.map((a) => ({ name: a.name, label: a.label, port: a.port }))));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

portal.on('error', (err) => {
  console.error(`[portal] 入口页服务异常: ${err.message}`);
});

// ---------------------------------------------------------------- 生命周期
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[boot] 收到 ${signal}，正在停止所有子进程…`);
  for (const [, state] of children) {
    try { state.child.kill('SIGTERM'); } catch (_) { /* ignore */ }
  }
  portal.close(() => {});
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[boot] 未捕获异常（继续运行）:', err && err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[boot] 未处理 Promise 拒绝（继续运行）:', reason && reason.message);
});

fs.mkdirSync(DATA_ROOT, { recursive: true });
portal.listen(PORTAL_PORT, '0.0.0.0', () => {
  console.log(`[boot] 统一入口页已就绪: http://127.0.0.1:${PORTAL_PORT}`);
});
for (const app of APPS) startApp(app);
