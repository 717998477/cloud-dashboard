'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MultiTenantStore } = require('./store');
const { CmccClient, generateDeviceFingerprint } = require('./cmccClient');
const { KeepaliveEngine } = require('./keepaliveEngine');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function parseCookies(cookieHeader = '') {
  const out = {};
  for (const pair of String(cookieHeader).split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new Error('无效的 JSON 请求格式'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function createApp({
  dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  publicDir = path.join(__dirname, '..', 'public'),
  cmccClient = new CmccClient(),
  engineOptions = {},
} = {}) {
  const store = new MultiTenantStore(dataDir);
  const engine = new KeepaliveEngine({ store, cmccClient, options: engineOptions });

  // Ephemeral captcha verification sessions scoped by platform user id
  // sessionId -> { ownerId, mobile, captchaToken, secretKey, fingerprint, smsSent, createdAt }
  const captchaSessions = new Map();

  function pruneCaptchaSessions() {
    const now = Date.now();
    for (const [id, sess] of captchaSessions.entries()) {
      if (now - sess.createdAt > 10 * 60 * 1000) {
        captchaSessions.delete(id);
      }
    }
  }

  function extractSessionToken(req) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      return auth.slice(7).trim();
    }
    const cookies = parseCookies(req.headers.cookie);
    return cookies.cmcc_sid || '';
  }

  function buildAuthCookie(token, maxAgeSec = 30 * 24 * 3600) {
    return `cmcc_sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
  }

  async function finalizeAccountBind(ownerId, loginData, remark = '') {
    const hydrated = store.upsertCmccAccount(ownerId, {
      mobile: loginData.mobile,
      remark,
      token: loginData.token,
      hwToken: loginData.hwToken,
      cmccUserId: loginData.cmccUserId,
      province: loginData.province,
      fingerprint: loginData.fingerprint,
    });

    store.appendLog(ownerId, {
      level: 'success',
      message: `官方账号 ${hydrated.mobile} 认证成功，正在同步云手机实例...`,
    });

    let syncedDevices = [];
    try {
      const remoteDevs = await cmccClient.listDevices(hydrated);
      syncedDevices = store.syncDevicesForAccount(ownerId, hydrated.id, remoteDevs);
      store.appendLog(ownerId, {
        level: 'info',
        message: `账号 ${hydrated.mobile} 同步完成，共发现 ${syncedDevices.length} 台云手机`,
      });
    } catch (err) {
      store.appendLog(ownerId, {
        level: 'warn',
        message: `账号 ${hydrated.mobile} 已保存，但首次拉取设备列表异常：${err.message}`,
      });
    }

    engine.reconcileAllDevices();
    return {
      account: store.sanitizeAccount(hydrated),
      deviceCount: syncedDevices.length,
    };
  }

  async function handleApi(req, res, pathname) {
    // Public health & bootstrap endpoints
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, time: Date.now() });
    }

    if (req.method === 'GET' && pathname === '/api/auth/bootstrap') {
      return sendJson(res, 200, {
        ok: true,
        hasAnyUser: store.hasAnyUser(),
        allowRegister: process.env.DISABLE_PUBLIC_REGISTER !== '1',
      });
    }

    if (req.method === 'POST' && pathname === '/api/auth/register') {
      if (store.hasAnyUser() && process.env.DISABLE_PUBLIC_REGISTER === '1') {
        return sendJson(res, 403, { ok: false, error: '管理员已关闭公开注册，请联系管理员开通账号' });
      }
      const body = await readJsonBody(req);
      const user = store.registerUser({
        username: body.username,
        password: body.password,
      });
      const auth = store.authenticateUser(body.username, body.password);
      return sendJson(
        res,
        200,
        { ok: true, user: auth.user, token: auth.token },
        { 'Set-Cookie': buildAuthCookie(auth.token) }
      );
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJsonBody(req);
      const auth = store.authenticateUser(body.username, body.password);
      return sendJson(
        res,
        200,
        { ok: true, user: auth.user, token: auth.token },
        { 'Set-Cookie': buildAuthCookie(auth.token) }
      );
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      const sid = extractSessionToken(req);
      store.revokeSession(sid);
      return sendJson(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': buildAuthCookie('', 0) }
      );
    }

    // ===== Authenticated Routes (Strict Multi-User Isolation) =====
    const sid = extractSessionToken(req);
    const currentUser = store.getUserBySessionToken(sid);
    if (!currentUser) {
      return sendJson(res, 401, { ok: false, error: '未登录或会话已过期，请先登录平台账号' });
    }

    if (req.method === 'GET' && pathname === '/api/auth/me') {
      return sendJson(res, 200, { ok: true, user: currentUser });
    }

    // ----- Admin User Management -----
    if (pathname === '/api/admin/users' && req.method === 'GET') {
      if (currentUser.role !== 'admin') {
        return sendJson(res, 403, { ok: false, error: '需要管理员权限' });
      }
      return sendJson(res, 200, { ok: true, users: store.listUsersForAdmin() });
    }

    if (pathname === '/api/admin/users' && req.method === 'POST') {
      if (currentUser.role !== 'admin') {
        return sendJson(res, 403, { ok: false, error: '需要管理员权限' });
      }
      const body = await readJsonBody(req);
      const created = store.registerUser({
        username: body.username,
        password: body.password,
        role: body.role === 'admin' ? 'admin' : 'user',
        maxAccounts: body.maxAccounts,
      });
      return sendJson(res, 200, { ok: true, user: created });
    }

    const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([a-f0-9-]+)$/i);
    if (adminUserMatch) {
      if (currentUser.role !== 'admin') {
        return sendJson(res, 403, { ok: false, error: '需要管理员权限' });
      }
      const targetUserId = adminUserMatch[1];
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        if (targetUserId === currentUser.id && body.disabled === true) {
          return sendJson(res, 400, { ok: false, error: '不能禁用当前正在使用的管理员账号' });
        }
        const updated = store.updateUserByAdmin(targetUserId, body);
        if (body.disabled === true) {
          const userDevs = store.listDevicesByOwner(targetUserId);
          for (const d of userDevs) {
            store.updateDeviceSettingsForOwner(targetUserId, d.id, { keepaliveEnabled: false });
          }
          engine.reconcileAllDevices();
        }
        return sendJson(res, 200, { ok: true, user: updated });
      }
      if (req.method === 'DELETE') {
        if (targetUserId === currentUser.id) {
          return sendJson(res, 400, { ok: false, error: '不能删除当前正在登录的管理员自身' });
        }
        store.deleteUserByAdmin(targetUserId);
        engine.reconcileAllDevices();
        return sendJson(res, 200, { ok: true });
      }
    }

    // ----- Dashboard Snapshot (Strictly Scoped to currentUser.id) -----
    if (req.method === 'GET' && pathname === '/api/dashboard') {
      const accounts = store.listAccountsByOwner(currentUser.id);
      const accountMap = new Map(accounts.map((a) => [a.id, a]));
      const devices = store.listDevicesByOwner(currentUser.id).map((d) => ({
        ...d,
        accountMobile: accountMap.get(d.accountId)?.mobile || '',
        accountRemark: accountMap.get(d.accountId)?.remark || '',
        accountAuthStatus: accountMap.get(d.accountId)?.authStatus || 'valid',
        runtime: engine.getRuntimeSnapshot(d.id),
      }));
      const logs = store.getLogsForOwner(currentUser.id, 100);
      return sendJson(res, 200, {
        ok: true,
        user: currentUser,
        accounts,
        devices,
        logs,
      });
    }

    // ----- Official CMCC SMS Login Flow -----
    if (req.method === 'POST' && pathname === '/api/cmcc/captcha/get') {
      pruneCaptchaSessions();
      const body = await readJsonBody(req);
      // Reuse existing fingerprint if user already bound this mobile before
      const existingAccs = store.getAllHydratedAccounts().filter(
        (a) => a.ownerId === currentUser.id && a.mobile === String(body.mobile || '').replace(/\s+/g, '')
      );
      const fp = existingAccs[0]?.fingerprint || generateDeviceFingerprint();
      const cap = await cmccClient.getCaptcha(body.mobile, fp);
      const captchaSessionId = crypto.randomUUID();
      captchaSessions.set(captchaSessionId, {
        ownerId: currentUser.id,
        mobile: cap.mobile,
        captchaToken: cap.captchaToken,
        secretKey: cap.secretKey,
        fingerprint: cap.fingerprint,
        smsSent: false,
        createdAt: Date.now(),
      });
      return sendJson(res, 200, {
        ok: true,
        captchaSessionId,
        mobile: cap.mobile,
        originalImageBase64: cap.originalImageBase64,
        jigsawImageBase64: cap.jigsawImageBase64,
      });
    }

    if (req.method === 'POST' && pathname === '/api/cmcc/captcha/send-sms') {
      const body = await readJsonBody(req);
      const sess = captchaSessions.get(body.captchaSessionId);
      if (!sess || sess.ownerId !== currentUser.id) {
        return sendJson(res, 400, { ok: false, error: '图形验证会话已失效，请重新获取滑块验证码' });
      }
      await cmccClient.verifyCaptchaAndSendSms({
        mobile: sess.mobile,
        captchaToken: sess.captchaToken,
        secretKey: sess.secretKey,
        moveX: body.moveX,
        fingerprint: sess.fingerprint,
      });
      sess.smsSent = true;
      return sendJson(res, 200, { ok: true, mobile: sess.mobile });
    }

    if (req.method === 'POST' && pathname === '/api/cmcc/login/sms') {
      const body = await readJsonBody(req);
      const cleanMobile = String(body.mobile || '').replace(/\s+/g, '');
      let fp = null;
      if (body.captchaSessionId) {
        const sess = captchaSessions.get(body.captchaSessionId);
        if (sess && sess.ownerId === currentUser.id && sess.mobile === cleanMobile) {
          fp = sess.fingerprint;
          captchaSessions.delete(body.captchaSessionId);
        }
      }
      if (!fp) {
        fp = generateDeviceFingerprint();
      }
      const loginData = await cmccClient.loginWithSmsCode({
        mobile: cleanMobile,
        code: body.code,
        fingerprint: fp,
      });
      const result = await finalizeAccountBind(currentUser.id, loginData, body.remark);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && pathname === '/api/cmcc/login/password') {
      const body = await readJsonBody(req);
      const loginData = await cmccClient.loginWithPassword({
        mobile: body.mobile,
        password: body.password,
      });
      const result = await finalizeAccountBind(currentUser.id, loginData, body.remark);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && pathname === '/api/cmcc/login/token') {
      const body = await readJsonBody(req);
      const cleanMobile = String(body.mobile || '').replace(/\s+/g, '');
      const rawToken = String(body.token || '').trim();
      if (!/^1\d{10}$/.test(cleanMobile) || !rawToken) {
        return sendJson(res, 400, { ok: false, error: '请填写完整的 11 位手机号和有效官方 Token' });
      }
      const fp = generateDeviceFingerprint();
      // Validate token by listing devices
      const tempAcc = { mobile: cleanMobile, token: rawToken, hwToken: body.hwToken || '', fingerprint: fp };
      await cmccClient.listDevices(tempAcc);
      const result = await finalizeAccountBind(
        currentUser.id,
        {
          mobile: cleanMobile,
          token: rawToken,
          hwToken: body.hwToken || '',
          cmccUserId: body.cmccUserId || '',
          province: '',
          fingerprint: fp,
        },
        body.remark
      );
      return sendJson(res, 200, { ok: true, ...result });
    }

    // ----- Account Operations (Owner Isolated) -----
    const accSyncMatch = pathname.match(/^\/api\/accounts\/([a-f0-9-]+)\/sync$/i);
    if (accSyncMatch && req.method === 'POST') {
      const acc = store.getHydratedAccountForOwner(currentUser.id, accSyncMatch[1]);
      if (!acc) return sendJson(res, 404, { ok: false, error: '未找到该账号或无权操作' });
      const tokenCheck = await cmccClient.checkAndRefreshToken(acc);
      if (tokenCheck.refreshed) {
        store.updateAccountTokens(acc.id, {
          token: tokenCheck.token,
          hwToken: tokenCheck.hwToken,
          authStatus: 'valid',
        });
      }
      const freshAcc = store.getHydratedAccountForOwner(currentUser.id, acc.id);
      const remoteDevs = await cmccClient.listDevices(freshAcc);
      const synced = store.syncDevicesForAccount(currentUser.id, acc.id, remoteDevs);
      engine.reconcileAllDevices();
      return sendJson(res, 200, { ok: true, deviceCount: synced.length });
    }

    const accDelMatch = pathname.match(/^\/api\/accounts\/([a-f0-9-]+)$/i);
    if (accDelMatch && req.method === 'DELETE') {
      store.deleteAccountForOwner(currentUser.id, accDelMatch[1]);
      engine.reconcileAllDevices();
      return sendJson(res, 200, { ok: true });
    }

    // ----- Device Operations & Web Display/Control Stream (Owner Isolated) -----
    const devSettingsMatch = pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/settings$/i);
    if (devSettingsMatch && req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const updated = store.updateDeviceSettingsForOwner(currentUser.id, devSettingsMatch[1], body);
      engine.reconcileDevice(updated.id);
      return sendJson(res, 200, {
        ok: true,
        device: { ...updated, runtime: engine.getRuntimeSnapshot(updated.id) },
      });
    }

    const devPowerMatch = pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/power$/i);
    if (devPowerMatch && req.method === 'POST') {
      const dev = store.getDeviceForOwner(currentUser.id, devPowerMatch[1]);
      if (!dev) return sendJson(res, 404, { ok: false, error: '未找到该云手机设备或无权访问' });
      const acc = store.getHydratedAccountForOwner(currentUser.id, dev.accountId);
      if (!acc) return sendJson(res, 404, { ok: false, error: '关联的移动账号不存在' });

      const body = await readJsonBody(req);
      let action = body.action;
      if (!['wakeup','reboot','shutdown'].includes(action)) return sendJson(res,400,{ok:false,error:'不支持的电源动作'});
      // 官方无真关机接口：关机动作统一按重启处理（2026-11-04 修改）
      if (action === 'shutdown') action = 'reboot';
      engine.pauseForPower(dev.id, 90000);
      if (action === 'wakeup') {
        await cmccClient.ensureDeviceReady(acc, dev.phoneId, dev.platformType, 45000);
        await cmccClient.waitForPowerState(acc, dev.phoneId, ['0'], 60000);
        store.updateDeviceSettingsForOwner(currentUser.id, dev.id, { keepaliveEnabled: true });
        engine.pauseForPower(dev.id, 0);
        store.appendLog(currentUser.id, {
          level: 'success',
          deviceId: dev.id,
          phoneName: dev.phoneName,
          message: '云手机唤醒就绪成功',
        });
      } else if (action === 'reboot') {
        await cmccClient.rebootDevice(acc, dev.phoneId, dev.platformType);
        store.appendLog(currentUser.id, {
          level: 'info',
          deviceId: dev.id,
          phoneName: dev.phoneName,
          message: '已下发重启指令，稍后保活引擎将自动重连',
        });
      } else if (action === 'shutdown') {
        // Turn off auto-wakeup / keepalive when user explicitly shuts down
        store.updateDeviceSettingsForOwner(currentUser.id, dev.id, { keepaliveEnabled: false });
        engine.reconcileDevice(dev.id);
        await cmccClient.shutdownDevice(acc, dev.phoneId, dev.platformType);
        await cmccClient.waitForPowerState(acc, dev.phoneId, ['31'], 60000);
        store.appendLog(currentUser.id, {
          level: 'info',
          deviceId: dev.id,
          phoneName: dev.phoneName,
          message: '已下发关机指令并暂停自动保活唤醒',
        });
      } else {
        return sendJson(res, 400, { ok: false, error: '不支持的电源动作' });
      }
      store.syncDevicesForAccount(currentUser.id, acc.id, await cmccClient.listDevices(acc));
      engine.reconcileDevice(dev.id);
      return sendJson(res, 200, { ok: true, message: action === 'wakeup' ? '已确认云机开机就绪' : action === 'shutdown' ? '已确认云机关闭 (状态31)' : '官方已接受重启指令，最终状态稍后同步' });
    }

    const devShotMatch = pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/screenshot$/i);
    if (devShotMatch && req.method === 'POST') {
      const dev = store.getDeviceForOwner(currentUser.id, devShotMatch[1]);
      if (!dev) return sendJson(res, 404, { ok: false, error: '未找到该云手机设备或无权访问' });
      const acc = store.getHydratedAccountForOwner(currentUser.id, dev.accountId);
      if (!acc) return sendJson(res, 404, { ok: false, error: '关联的移动账号不存在' });

      const shot = await cmccClient.captureScreenshot(acc, dev.phoneId, dev.platformType);
      const imgUrl = typeof shot === 'string' ? shot : shot?.pictUrl || shot?.url || '';
      if (imgUrl) {
        store.updateDeviceScreenshot(dev.id, imgUrl);
      }
      return sendJson(res, 200, { ok: true, screenshot: imgUrl });
    }

    const streamOpenMatch = pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/stream\/open$/i);
    if (streamOpenMatch && req.method === 'POST') {
      const dev = store.getDeviceForOwner(currentUser.id, streamOpenMatch[1]);
      if (!dev) return sendJson(res, 404, { ok: false, error: '未找到该云手机设备或无权访问' });
      const acc = store.getHydratedAccountForOwner(currentUser.id, dev.accountId);
      if (!acc) return sendJson(res, 404, { ok: false, error: '关联的移动账号不存在' });

      const body = await readJsonBody(req);
      // Pause background keepalive worker first so browser WebRTC gets clean master session
      engine.acquireWebControlLease(currentUser.id, dev.id, sid || 'web', 50000);
      try {
        await cmccClient.ensureDeviceReady(acc, dev.phoneId, dev.platformType, 45000);
        const streamConfig = await cmccClient.getStreamAuth(
          acc,
          dev.phoneId,
          dev.platformType,
          body.authId || ''
        );
        return sendJson(res, 200, {
          ok: true,
          device: {
            id: dev.id,
            phoneId: dev.phoneId,
            phoneName: dev.phoneName,
            platformType: dev.platformType,
          },
          stream: streamConfig,
        });
      } catch (err) {
        engine.releaseWebControlLease(currentUser.id, dev.id);
        throw err;
      }
    }

    const streamBeatMatch = pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/stream\/heartbeat$/i);
    if (streamBeatMatch && req.method === 'POST') {
      const lease = engine.renewWebControlLease(currentUser.id, streamBeatMatch[1], 50000);
      return sendJson(res, 200, { ok: true, ...lease });
    }

    const streamCloseMatch = pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/stream\/close$/i);
    if (streamCloseMatch && req.method === 'POST') {
      const rel = engine.releaseWebControlLease(currentUser.id, streamCloseMatch[1]);
      return sendJson(res, 200, { ok: true, ...rel });
    }

    return sendJson(res, 404, { ok: false, error: '未知的 API 接口路径' });
  }

  function serveStatic(req, res, pathname) {
    let relPath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
    const fullPath = path.join(publicDir, safePath);
    if (!fullPath.startsWith(path.resolve(publicDir))) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.js' && safePath.includes('vendor') ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(fullPath).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsed.pathname;
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname);
      } else {
        serveStatic(req, res, pathname);
      }
    } catch (err) {
      const status = err.code === 'CMCC_AUTH_EXPIRED' ? 401 : 400;
      sendJson(res, status, {
        ok: false,
        error: err.message || '服务器处理请求异常',
        code: err.code || undefined,
      });
    }
  });

  return { server, store, engine, cmccClient };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8680);
  const host = process.env.HOST || '0.0.0.0';
  const { server, engine } = createApp();
  engine.start();
  server.listen(port, host, () => {
    console.log(`[CMCC CloudPhone Manager] Listening on http://${host}:${port}`);
  });

  const shutdown = () => {
    engine.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
