'use strict';

const crypto = require('crypto');
const { RawWebSocket, EngineIoV3Socket } = require('./wsClient');

const CMD_ACTION_PREPARE_CONNECT = 6056;
const CMD_ACTION_HEART = 100022;

class KeepaliveEngine {
  constructor({ store, cmccClient, options = {} }) {
    this.store = store;
    this.cmcc = cmccClient;
    this.tokenCheckIntervalMs = options.tokenCheckIntervalMs || 20 * 60 * 1000;
    this.leaseSweepIntervalMs = options.leaseSweepIntervalMs || 5000;
    this.yunRefreshPulseMs = options.yunRefreshPulseMs || 4 * 60 * 1000;
    this.socketFactory = options.socketFactory || null; // optional injection for unit tests

    // deviceId -> runtime session state
    this.sessions = new Map();
    // deviceId -> { ownerId, clientSessionId, expiresAt }
    this.webLeases = new Map();

    this._tokenTimer = null;
    this._leaseTimer = null;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;

    this._tokenTimer = setInterval(() => {
      this.checkAllAccountTokens().catch(() => {});
    }, this.tokenCheckIntervalMs);
    this._tokenTimer.unref?.();

    this._leaseTimer = setInterval(() => {
      this._sweepExpiredWebLeases();
      this.reconcileAllDevices();
    }, this.leaseSweepIntervalMs);
    this._leaseTimer.unref?.();

    // Reconcile all devices on startup
    this.reconcileAllDevices();
  }

  stop() {
    this._running = false;
    if (this._tokenTimer) {
      clearInterval(this._tokenTimer);
      this._tokenTimer = null;
    }
    if (this._leaseTimer) {
      clearInterval(this._leaseTimer);
      this._leaseTimer = null;
    }
    for (const deviceId of this.sessions.keys()) {
      this._stopDeviceWorker(deviceId, '服务停止');
    }
    this.webLeases.clear();
  }

  reconcileAllDevices() {
    if (!this._running) return;
    const allDevices = this.store.listAllDevicesInternal();
    const validIds = new Set(allDevices.map((d) => d.id));

    for (const existingId of Array.from(this.sessions.keys())) {
      if (!validIds.has(existingId)) {
        this._stopDeviceWorker(existingId, '设备已移除');
        this.sessions.delete(existingId);
      }
    }

    for (const dev of allDevices) {
      this.reconcileDevice(dev.id);
    }
  }

  reconcileDevice(deviceId) {
    if (!this._running) return;
    const dev = this.store.getDeviceInternal(deviceId);
    if (!dev) {
      this._stopDeviceWorker(deviceId, '设备不存在');
      this.sessions.delete(deviceId);
      return;
    }

    const acc = this.store.getHydratedAccountInternal(dev.accountId);
    if (!acc || acc.authStatus === 'expired' || dev.isExpired) {
      this._stopDeviceWorker(deviceId, acc?.authStatus === 'expired' ? '账号登录态已过期' : '云手机套餐已到期');
      return;
    }

    const lease = this.webLeases.get(deviceId);
    if (lease && lease.expiresAt > Date.now()) {
      this._pauseForWebControl(dev);
      return;
    }

    if (!dev.keepaliveEnabled) {
      this._stopDeviceWorker(deviceId, '用户已关闭保活');
      return;
    }

    const rt = this._ensureRuntime(dev);
    if (rt.powerHoldUntil > Date.now()) return;
    if (dev.keepaliveMode !== 'continuous') {
      const wait = (dev.waitMinutes || 5) * 60000;
      const connect = (dev.connectMinutes || 5) * 60000;
      const elapsed = Math.max(0, Date.now() - (dev.scheduleStartedAt || dev.updatedAt));
      const phase = elapsed % (wait + connect);
      if (phase < wait) {
        this._stopDeviceWorker(dev.id);
        rt.state = 'SCHEDULE_WAIT';
        rt.nextConnectAt = Date.now() + wait - phase;
        return;
      }
      rt.nextConnectAt = null;
    }
    if (['PREPARING', 'CONNECTING', 'KEEPING', 'RECONNECTING'].includes(rt.state) && rt.active) {
      return;
    }
    this._startDeviceWorker(dev, acc);
  }

  getRuntimeSnapshot(deviceId) {
    const rt = this.sessions.get(deviceId);
    const lease = this.webLeases.get(deviceId);
    const webControlled = Boolean(lease && lease.expiresAt > Date.now());
    if (!rt) {
      return {
        state: webControlled ? 'WEB_CONTROL' : 'IDLE',
        stateText: webControlled ? 'Web 实时控制中' : '未启动保活',
        connectedSince: null,
        uptimeSeconds: 0,
        heartbeatCount: 0,
        reconnectCount: 0,
        lastHeartbeatAt: null,
        lastError: '',
        webControlled,
      };
    }
    const uptimeSeconds =
      rt.connectedSince && rt.state === 'KEEPING'
        ? Math.max(0, Math.floor((Date.now() - rt.connectedSince) / 1000))
        : 0;
    const stateLabels = {
      IDLE: '未启动保活',
      SCHEDULE_WAIT: '按计划等待连接',
      PREPARING: '唤醒与环境准备中',
      CONNECTING: '正在建立长连接',
      KEEPING: '长期连接保活中',
      RECONNECTING: '断线重连等待中',
      WEB_CONTROL: 'Web 实时控制接管中',
      ERROR: '连接异常',
    };
    return {
      state: webControlled ? 'WEB_CONTROL' : rt.state,
      stateText: webControlled ? stateLabels.WEB_CONTROL : stateLabels[rt.state] || rt.state,
      connectedSince: rt.connectedSince,
      uptimeSeconds,
      heartbeatCount: rt.heartbeatCount,
      reconnectCount: rt.reconnectCount,
      lastHeartbeatAt: rt.lastHeartbeatAt,
      lastError: rt.lastError || '',
      nextConnectAt: rt.nextConnectAt || null,
      webControlled,
    };
  }

  acquireWebControlLease(ownerId, deviceId, clientSessionId = 'web', ttlMs = 45000) {
    const dev = this.store.getDeviceForOwner(ownerId, deviceId);
    if (!dev) {
      throw new Error('未找到该云手机设备或无权访问');
    }
    this.webLeases.set(deviceId, {
      ownerId,
      clientSessionId,
      expiresAt: Date.now() + ttlMs,
    });
    this._pauseForWebControl(dev);
    return { leased: true, expiresAt: Date.now() + ttlMs };
  }

  renewWebControlLease(ownerId, deviceId, ttlMs = 45000) {
    const dev = this.store.getDeviceForOwner(ownerId, deviceId);
    if (!dev) {
      throw new Error('未找到该云手机设备或无权访问');
    }
    const existing = this.webLeases.get(deviceId);
    const expiresAt = Date.now() + ttlMs;
    this.webLeases.set(deviceId, {
      ownerId,
      clientSessionId: existing?.clientSessionId || 'web',
      expiresAt,
    });
    return { leased: true, expiresAt };
  }

  releaseWebControlLease(ownerId, deviceId) {
    const dev = this.store.getDeviceForOwner(ownerId, deviceId);
    if (!dev) {
      throw new Error('未找到该云手机设备或无权访问');
    }
    const hadLease = this.webLeases.delete(deviceId);
    const rt = this.sessions.get(deviceId);
    if (rt && rt.state === 'WEB_CONTROL') {
      rt.state = 'IDLE';
      rt.active = false;
    }
    if (hadLease) {
      this.store.appendLog(ownerId, {
        level: 'info',
        deviceId: dev.id,
        phoneName: dev.phoneName,
        message: '已退出 Web 实时控制，恢复后台长期保活守护',
      });
    }
    this.reconcileDevice(deviceId);
    return { released: true };
  }

  _sweepExpiredWebLeases() {
    const now = Date.now();
    for (const [deviceId, lease] of Array.from(this.webLeases.entries())) {
      if (lease.expiresAt <= now) {
        this.webLeases.delete(deviceId);
        const dev = this.store.getDeviceInternal(deviceId);
        const rt = this.sessions.get(deviceId);
        if (rt && rt.state === 'WEB_CONTROL') {
          rt.state = 'IDLE';
          rt.active = false;
        }
        if (dev) {
          this.store.appendLog(dev.ownerId, {
            level: 'info',
            deviceId: dev.id,
            phoneName: dev.phoneName,
            message: 'Web 控制窗口租约已结束，自动恢复后台长期保活',
          });
          this.reconcileDevice(deviceId);
        }
      }
    }
  }

  _ensureRuntime(dev) {
    let rt = this.sessions.get(dev.id);
    if (!rt) {
      rt = {
        deviceId: dev.id,
        ownerId: dev.ownerId,
        state: 'IDLE',
        active: false,
        generation: 0,
        socket: null,
        pulseTimer: null,
        retryTimer: null,
        consecutiveFailures: 0,
        connectedSince: null,
        heartbeatCount: 0,
        reconnectCount: 0,
        lastHeartbeatAt: null,
        lastError: '',
        reqSeq: 1,
      };
      this.sessions.set(dev.id, rt);
    }
    return rt;
  }

  _pauseForWebControl(dev) {
    const rt = this._ensureRuntime(dev);
    if (rt.state === 'WEB_CONTROL') return;
    this._cleanupSocketAndTimers(rt);
    rt.generation += 1;
    rt.active = false;
    rt.state = 'WEB_CONTROL';
    this.store.appendLog(dev.ownerId, {
      level: 'info',
      deviceId: dev.id,
      phoneName: dev.phoneName,
      message: 'Web 实时显示与控制已接管，后台长连接暂时让位防互踢',
    });
  }

  pauseForPower(deviceId, holdMs = 90000) {
    this._stopDeviceWorker(deviceId);
    const dev = this.store.getDeviceInternal(deviceId);
    if (dev) this._ensureRuntime(dev).powerHoldUntil = Date.now() + holdMs;
  }

  _stopDeviceWorker(deviceId, reason = '') {
    const rt = this.sessions.get(deviceId);
    if (!rt) return;
    const wasActive = rt.active || rt.state === 'KEEPING' || rt.state === 'RECONNECTING';
    this._cleanupSocketAndTimers(rt);
    rt.generation += 1;
    rt.active = false;
    rt.state = 'IDLE';
    rt.connectedSince = null;
    if (wasActive && reason) {
      const dev = this.store.getDeviceInternal(deviceId);
      if (dev) {
        this.store.appendLog(dev.ownerId, {
          level: 'info',
          deviceId: dev.id,
          phoneName: dev.phoneName,
          message: `长期保活已停止：${reason}`,
        });
      }
    }
  }

  _cleanupSocketAndTimers(rt) {
    if (rt.pulseTimer) {
      clearInterval(rt.pulseTimer);
      rt.pulseTimer = null;
    }
    if (rt.retryTimer) {
      clearTimeout(rt.retryTimer);
      rt.retryTimer = null;
    }
    if (rt.socket) {
      const s = rt.socket;
      rt.socket = null;
      try {
        s.removeAllListeners?.();
        s.close();
      } catch (_) {}
    }
  }

  async _startDeviceWorker(dev, account) {
    const rt = this._ensureRuntime(dev);
    this._cleanupSocketAndTimers(rt);
    rt.generation += 1;
    const gen = rt.generation;
    rt.active = true;
    rt.state = 'PREPARING';
    rt.lastError = '';

    try {
      if (dev.autoWakeup !== false) {
        await this.cmcc.ensureDeviceReady(account, dev.phoneId, dev.platformType, 40000);
      }
      if (gen !== rt.generation || !this._running) return;

      rt.state = 'CONNECTING';
      const auth = await this.cmcc.getStreamAuth(account, dev.phoneId, dev.platformType);
      if (gen !== rt.generation || !this._running) return;

      if (String(dev.platformType) === '2') {
        this._connectTCloudKeepalive(dev, account, rt, gen, auth);
      } else {
        this._connectYunKeepalive(dev, account, rt, gen, auth);
      }
    } catch (err) {
      if (gen !== rt.generation) return;
      if (err && err.code === 'CMCC_AUTH_EXPIRED') {
        this.store.updateAccountTokens(account.id, { authStatus: 'expired' });
        rt.active = false;
        rt.state = 'ERROR';
        rt.lastError = err.message;
        this.store.appendLog(dev.ownerId, {
          level: 'error',
          deviceId: dev.id,
          phoneName: dev.phoneName,
          message: `账号 ${account.mobile} 登录态已失效，请重新使用手机验证码登录`,
        });
        return;
      }
      this._scheduleReconnect(dev, rt, gen, err.message || '保活初始化失败');
    }
  }

  _connectYunKeepalive(dev, account, rt, gen, auth) {
    const query = {
      authtype: 'token',
      boxid: auth.boxid,
      token: auth.token,
      platform: auth.platform || 'cloudphone',
      env: auth.env || 'phone580',
      sessionid: auth.sessionid || auth.token,
      streamingid: crypto.randomUUID(),
    };

    const sock = this.socketFactory
      ? this.socketFactory('yun', auth.signaling_url, query)
      : new EngineIoV3Socket(auth.signaling_url, query);

    rt.socket = sock;
    let authorized = false;

    sock.on('connect', () => {
      if (gen !== rt.generation) return;
      // Wait for `authorize` event or treat Socket.IO connect as connected if gateway skips explicit authorize
      setTimeout(() => {
        if (gen === rt.generation && sock.connected && !authorized) {
          authorized = true;
          this._markKeeping(dev, rt, '云版信令长连接已建立');
        }
      }, 2000).unref?.();
    });

    sock.on('event', (eventName, payload) => {
      if (gen !== rt.generation) return;
      if (eventName === 'authorize') {
        if (payload && payload.authorized) {
          authorized = true;
          this._markKeeping(dev, rt, `云版信令鉴权成功 (boxId: ${auth.boxid})`);
          // Send initial room touch pulse to reset cloud phone idle timer
          sock.sendEvent('start', { room: auth.boxid, times: 1 });
        } else {
          sock.close();
          this._scheduleReconnect(dev, rt, gen, `云版信令鉴权未通过 (code: ${payload?.code})`);
        }
      }
    });

    sock.on('pong', () => {
      if (gen !== rt.generation) return;
      rt.heartbeatCount += 1;
      rt.lastHeartbeatAt = Date.now();
    });

    sock.on('error', (err) => {
      if (gen !== rt.generation) return;
      rt.lastError = err.message || '信令通道错误';
    });

    sock.on('close', (code, reason) => {
      if (gen !== rt.generation) return;
      this._cleanupSocketAndTimers(rt);
      // Session rotation after being authorized is normal in CMCC signaling; reconnect smoothly
      const smoothRotate = authorized && rt.consecutiveFailures === 0;
      this._scheduleReconnect(
        dev,
        rt,
        gen,
        smoothRotate ? '信令会话周期轮转续接' : `信令通道断开 (${code} ${reason || ''})`.trim(),
        smoothRotate ? 1500 : undefined,
        smoothRotate
      );
    });

    // Periodic activity pulse so both signaling & cloud instance stay awake
    rt.pulseTimer = setInterval(async () => {
      if (gen !== rt.generation || !this._running) return;
      try {
        if (sock.connected) {
          sock.sendEvent('start', { room: auth.boxid, times: 1 });
        }
        const freshAcc = this.store.getHydratedAccountInternal(account.id) || account;
        await this.cmcc.prepareDeviceV2(freshAcc, dev.phoneId, dev.platformType);
        rt.heartbeatCount += 1;
        rt.lastHeartbeatAt = Date.now();
      } catch (_) {}
    }, this.yunRefreshPulseMs);
    rt.pulseTimer.unref?.();

    sock.open();
  }

  _connectTCloudKeepalive(dev, account, rt, gen, auth) {
    const connToken = auth.tokenQueue[0];
    const ws = this.socketFactory
      ? this.socketFactory('tcloud', auth.cmdUrl, { token: connToken })
      : new RawWebSocket(auth.cmdUrl);

    rt.socket = ws;
    const sendCmd = (code, innerObj) => {
      if (ws.readyState !== RawWebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          code,
          msg: JSON.stringify(innerObj),
        })
      );
    };

    ws.on('open', () => {
      if (gen !== rt.generation) return;
      this._markKeeping(dev, rt, 'T版命令长连接通道已建立');

      // Official CMD_ACTION_PREPARE_CONNECT (6056)
      rt.reqSeq += 1;
      sendCmd(10013, {
        type: CMD_ACTION_PREPARE_CONNECT,
        reqid: rt.reqSeq,
        time: Date.now(),
        message: JSON.stringify({
          packageName: '',
          capbility: 7,
          definition: 1,
          density: 320,
          width: 720,
          height: 1280,
          machineType: 0,
          userToken: auth.userToken || '',
          cloudId: auth.cloudId,
          phoneId: auth.internalPhoneId,
          isMqttFailed: auth.isMqttFailed,
        }),
        device: 6,
        t: connToken,
        version: 0,
      });

      const sendHeartbeats = () => {
        if (gen !== rt.generation || ws.readyState !== RawWebSocket.OPEN) return;
        rt.reqSeq += 1;
        sendCmd(10013, {
          type: CMD_ACTION_HEART,
          reqid: rt.reqSeq,
          time: Date.now(),
          message: '',
          device: 6,
          t: connToken,
          version: 0,
        });
        rt.reqSeq += 1;
        sendCmd(10014, {
          cmdType: CMD_ACTION_HEART,
          reqid: rt.reqSeq,
          data: '""',
          device: 6,
          t: connToken,
          version: 0,
          time: Date.now(),
        });
        rt.heartbeatCount += 1;
        rt.lastHeartbeatAt = Date.now();
      };

      sendHeartbeats();
      rt.pulseTimer = setInterval(sendHeartbeats, 15000);
      rt.pulseTimer.unref?.();
    });

    ws.on('message', (data) => {
      if (gen !== rt.generation) return;
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (parsed && (parsed.code === 19009 || parsed.type === 6105)) {
            rt.lastError = '云机在其他终端登录或被服务端断开';
          }
        } catch (_) {}
      }
    });

    ws.on('error', (err) => {
      if (gen !== rt.generation) return;
      rt.lastError = err.message || 'T版命令通道异常';
    });

    ws.on('close', (code, reason) => {
      if (gen !== rt.generation) return;
      this._cleanupSocketAndTimers(rt);
      this._scheduleReconnect(dev, rt, gen, `T版通道断开 (${code} ${reason || ''})`.trim());
    });
  }

  _markKeeping(dev, rt, logMsg) {
    rt.state = 'KEEPING';
    rt.consecutiveFailures = 0;
    rt.lastError = '';
    if (!rt.connectedSince) {
      rt.connectedSince = Date.now();
    }
    rt.lastHeartbeatAt = Date.now();
    this.store.appendLog(dev.ownerId, {
      level: 'success',
      deviceId: dev.id,
      phoneName: dev.phoneName,
      message: logMsg,
    });
  }

  _scheduleReconnect(dev, rt, gen, reason, customDelayMs, keepConnectedSince = false) {
    if (!this._running || gen !== rt.generation) return;
    const latestDev = this.store.getDeviceInternal(dev.id);
    if (!latestDev || !latestDev.keepaliveEnabled) {
      rt.active = false;
      rt.state = 'IDLE';
      rt.connectedSince = null;
      return;
    }
    const lease = this.webLeases.get(dev.id);
    if (lease && lease.expiresAt > Date.now()) {
      this._pauseForWebControl(latestDev);
      return;
    }

    if (!keepConnectedSince) {
      rt.consecutiveFailures += 1;
      rt.reconnectCount += 1;
      rt.connectedSince = null;
    }
    rt.state = 'RECONNECTING';
    rt.lastError = reason;

    const delayMs =
      customDelayMs !== undefined
        ? customDelayMs
        : Math.min(60000, 3000 * Math.pow(1.6, Math.min(rt.consecutiveFailures - 1, 6)));

    this.store.appendLog(dev.ownerId, {
      level: keepConnectedSince ? 'info' : 'warn',
      deviceId: dev.id,
      phoneName: dev.phoneName,
      message: `${reason}，将在 ${Math.round(delayMs / 1000)}s 后自动重连保活`,
    });

    rt.retryTimer = setTimeout(() => {
      if (gen !== rt.generation || !this._running) return;
      const freshDev = this.store.getDeviceInternal(dev.id);
      const freshAcc = freshDev ? this.store.getHydratedAccountInternal(freshDev.accountId) : null;
      if (!freshDev || !freshAcc || !freshDev.keepaliveEnabled) return;
      rt.active = false; rt.state = 'IDLE';
      this.reconcileDevice(freshDev.id);
    }, delayMs);
    rt.retryTimer.unref?.();
  }

  async checkAllAccountTokens() {
    const accounts = this.store.getAllHydratedAccounts();
    for (const acc of accounts) {
      if (!acc || acc.authStatus === 'expired') continue;
      try {
        const res = await this.cmcc.checkAndRefreshToken(acc);
        if (res.refreshed) {
          this.store.updateAccountTokens(acc.id, {
            token: res.token,
            hwToken: res.hwToken,
            authStatus: 'valid',
          });
          this.store.appendLog(acc.ownerId, {
            level: 'info',
            message: `账号 ${acc.mobile} 官方 Token 已自动无感续期`,
          });
        } else {
          this.store.updateAccountTokens(acc.id, { authStatus: 'valid' });
        }
        const freshAcc = this.store.getHydratedAccountInternal(acc.id);
        const remoteDevs = await this.cmcc.listDevices(freshAcc);
        this.store.syncDevicesForAccount(acc.ownerId, acc.id, remoteDevs);
      } catch (err) {
        if (err && err.code === 'CMCC_AUTH_EXPIRED') {
          this.store.updateAccountTokens(acc.id, { authStatus: 'expired' });
          this.store.appendLog(acc.ownerId, {
            level: 'error',
            message: `账号 ${acc.mobile} 登录态已过期，请重新获取短信验证码登录`,
          });
          this.reconcileAllDevices();
        }
      }
    }
  }
}

module.exports = { KeepaliveEngine };
