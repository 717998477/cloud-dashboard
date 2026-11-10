'use strict';

const crypto = require('crypto');

const CMCC_BASE_URL = 'https://cloudphoneh5.buy.139.com/uniphone';
const T_BASE_URL = 'https://api.cp.139.com';
const APP_ID = '3099801';
const APP_SECRET = 'esdkabncgfsfkmlondn';
const CLIENT_ID = 'X3qUAu6hA1yO6CegzcMSrQJknuZ7aEs1';
const CLIENT_KEY = 'AqXZ3iQtf713yN70ydXRZkCkxdeGo3jo';
const H5_VERSION = '6.6.8';

const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDWTcMq2b85z+Mmhe+gh4Y32M3EH/FZEGuEjDYEN/e0Ke+3emiQDIzF0l6+6BnSPDAykl5DIWeZ/rg7IQYvyKZPNxFd04Fw7/HnAvu7KyAlJKVObx6udtyLRnWJBFc71ZZZ7xMp+itV88ItkjbsY91ddnfgauZOnL+DYs448tWtoQIDAQAB
-----END PUBLIC KEY-----`;

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

function randomAlnum(len = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function generateDeviceFingerprint() {
  const now = Date.now();
  return {
    uuid: `${now}${randomAlnum(10)}`,
    deviceId: `202611${randomAlnum(56)}`,
    userAgent: DEFAULT_UA,
  };
}

function buildTimePrefix(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds()) +
    String(date.getTime())
  );
}

function rsaEncrypt(plainText) {
  return crypto
    .publicEncrypt(
      { key: RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(String(plainText), 'utf8')
    )
    .toString('base64');
}

function aesEcbEncryptBase64(plainText, keyStr) {
  const keyBuf = Buffer.from(String(keyStr), 'utf8');
  const alg = keyBuf.length === 24 ? 'aes-192-ecb' : keyBuf.length === 32 ? 'aes-256-ecb' : 'aes-128-ecb';
  const cipher = crypto.createCipheriv(alg, keyBuf, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]).toString('base64');
}

function decryptWorkKeyHex(hexStr, workKey) {
  const bytes = Buffer.from(hexStr, 'hex');
  if (bytes.length < 32) {
    throw new Error('Encrypted response payload too short');
  }
  const iv = bytes.subarray(0, 16);
  const authTag = bytes.subarray(bytes.length - 16);
  const ciphertext = bytes.subarray(16, bytes.length - 16);
  const keyBuf = Buffer.from(String(workKey), 'utf8');
  const alg = keyBuf.length === 32 ? 'aes-256-gcm' : keyBuf.length === 24 ? 'aes-192-gcm' : 'aes-128-gcm';
  const decipher = crypto.createDecipheriv(alg, keyBuf, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

function buildSignedHeaders({ token = '', fingerprint, extraHeaders = {} }) {
  const fp = fingerprint || generateDeviceFingerprint();
  const now = new Date();
  const timestamp = now.getTime();
  const requestId = buildTimePrefix(now) + randomAlnum(8);
  const sign = crypto
    .createHash('md5')
    .update(`${requestId}${APP_ID}${token || ''}${APP_SECRET}${timestamp}`)
    .digest('hex')
    .toLowerCase();
  const safeUa = (fp.userAgent || DEFAULT_UA).replace(/\|/g, '/');
  const deviceInfo = [
    '4g',
    '',
    'h5',
    H5_VERSION,
    '',
    '',
    safeUa,
    fp.uuid,
    '',
    'Android 13',
    '393X851',
    'zh',
    '',
    '',
    '',
    '',
    '',
  ].join('|') + '|';

  return {
    'Content-Type': 'application/json; charset=utf-8',
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://cloudphoneh5.buy.139.com',
    Referer: 'https://cloudphoneh5.buy.139.com/',
    'User-Agent': fp.userAgent || DEFAULT_UA,
    requestId,
    appId: APP_ID,
    sign,
    token: token || '',
    timestamp: String(timestamp),
    'x-kpcc-clientid': CLIENT_ID,
    'x-kpcc-clientkey': CLIENT_KEY,
    platform: 'h5',
    deviceId: fp.deviceId,
    'x-DeviceInfo': deviceInfo,
    'x-channelSrc': '',
    ...extraHeaders,
  };
}

class CmccClient {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.baseUrl = options.baseUrl || CMCC_BASE_URL;
    this.tBaseUrl = options.tBaseUrl || T_BASE_URL;
    this.timeoutMs = options.timeoutMs || 25000;
  }

  async request(path, { body = {}, token = '', fingerprint, extraHeaders = {}, baseUrl } = {}) {
    const url = (baseUrl || this.baseUrl).replace(/\/+$/, '') + path;
    const headers = buildSignedHeaders({ token, fingerprint, extraHeaders });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: body === null ? '' : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch (err) {
        throw new Error(`CMCC API non-JSON response (${res.status}): ${text.slice(0, 180)}`);
      }
      const workKey = res.headers.get('x-workkey');
      if (workKey && typeof payload.data === 'string' && payload.data.length >= 64) {
        payload.data = decryptWorkKeyHex(payload.data, workKey);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  static isAuthExpiredStatus(status) {
    return ['1024', '4001024', '4001025', '500022'].includes(String(status || ''));
  }

  /**
   * Step 1 of official SMS login: fetch slider puzzle captcha for mobile number.
   */
  async getCaptcha(mobile, fingerprint) {
    const cleanMobile = String(mobile || '').replace(/\s+/g, '');
    if (!/^1\d{10}$/.test(cleanMobile)) {
      throw new Error('请输入有效的 11 位中国大陆手机号');
    }
    const fp = fingerprint || generateDeviceFingerprint();
    const res = await this.request('/user/getCaptcha', {
      body: { mobile: rsaEncrypt(cleanMobile) },
      fingerprint: fp,
    });
    const status = String(res?.header?.status || '');
    if (status !== '0000' && status !== '200') {
      throw new Error(res?.header?.errMsg || `获取安全验证图形失败 (${status})`);
    }
    const data = res.data || {};
    if (!data.originalImageBase64 || !data.jigsawImageBase64 || !data.token) {
      throw new Error('官方验证码返回数据不完整');
    }
    return {
      mobile: cleanMobile,
      fingerprint: fp,
      captchaToken: data.token,
      secretKey: data.secretKey || '',
      originalImageBase64: data.originalImageBase64,
      jigsawImageBase64: data.jigsawImageBase64,
    };
  }

  /**
   * Step 2 of official SMS login: verify user's slider offset and trigger official SMS code.
   * `moveX` is in 300px container space (matching official H5 SliderCaptcha component).
   */
  async verifyCaptchaAndSendSms({ mobile, captchaToken, secretKey, moveX, fingerprint }) {
    const cleanMobile = String(mobile || '').replace(/\s+/g, '');
    const moveXNum = Number(moveX);
    if (!Number.isFinite(moveXNum) || moveXNum <= 0) {
      throw new Error('请先拖动滑块完成拼图验证');
    }
    // Official coordinate transform: 310 * parseInt(moveBlockLeft) / 300
    const rawPoint = JSON.stringify({
      x: (310 * Math.round(moveXNum)) / 300,
      y: 5,
    });
    const pointJson = secretKey ? aesEcbEncryptBase64(rawPoint, secretKey) : rawPoint;

    const checkRes = await this.request('/user/checkCaptcha', {
      body: {
        mobile: rsaEncrypt(cleanMobile),
        token: captchaToken,
        captchaType: 'blockPuzzle',
        pointJson,
      },
      fingerprint,
    });
    const checkStatus = String(checkRes?.header?.status || '');
    if (checkStatus !== '0000') {
      throw new Error(checkRes?.header?.errMsg || '拼图滑块位置不正确，请重试');
    }

    const sendRes = await this.request('/user/login/sendCode', {
      body: {
        mobile: rsaEncrypt(cleanMobile),
        verificateKey: secretKey,
        verifyCode: parseInt(String(Math.round(moveXNum)), 10),
      },
      fingerprint,
    });
    const sendStatus = String(sendRes?.header?.status || '');
    if (sendStatus !== '200' || !sendRes?.data?.ret) {
      throw new Error(sendRes?.header?.errMsg || `短信验证码下发失败 (${sendStatus})`);
    }
    return { sent: true };
  }

  /**
   * Step 3 of official SMS login: submit 6-digit SMS code and obtain official CMCC tokens.
   */
  async loginWithSmsCode({ mobile, code, fingerprint }) {
    const cleanMobile = String(mobile || '').replace(/\s+/g, '');
    const cleanCode = String(code || '').trim();
    if (!/^1\d{10}$/.test(cleanMobile)) {
      throw new Error('手机号格式不正确');
    }
    if (!/^\d{4,8}$/.test(cleanCode)) {
      throw new Error('请输入收到的数字短信验证码');
    }
    const fp = fingerprint || generateDeviceFingerprint();
    const res = await this.request('/user/login/validateCode', {
      body: {
        mobile: rsaEncrypt(cleanMobile),
        code: rsaEncrypt(cleanCode),
        deviceId: fp.deviceId,
      },
      fingerprint: fp,
      extraHeaders: { 'X-EncryptMode': '1' },
    });
    const status = String(res?.header?.status || '');
    const data = res?.data || {};
    if (status !== '200' || !data.token) {
      throw new Error(res?.header?.errMsg || `验证码登录失败 (${status})`);
    }
    return {
      mobile: cleanMobile,
      token: data.token,
      hwToken: data.hwToken || '',
      cmccUserId: data.userId || '',
      province: data.province || '',
      secretPhone: data.phone || cleanMobile,
      fingerprint: fp,
    };
  }

  /**
   * Optional password login fallback (`/uniphone/mobile/login`).
   */
  async loginWithPassword({ mobile, password, fingerprint }) {
    const cleanMobile = String(mobile || '').replace(/\s+/g, '');
    if (!/^1\d{10}$/.test(cleanMobile) || !password) {
      throw new Error('请输入正确的手机号和密码');
    }
    const fp = fingerprint || generateDeviceFingerprint();
    const res = await this.request('/mobile/login', {
      body: {
        mobile: rsaEncrypt(cleanMobile),
        password: rsaEncrypt(password),
        isEncrypt: true,
      },
      fingerprint: fp,
      extraHeaders: { 'X-EncryptMode': '1' },
    });
    const status = String(res?.header?.status || '');
    const data = res?.data || {};
    const token = data.accessToken || data.token;
    if (status !== '200' || !token) {
      throw new Error(res?.header?.errMsg || `密码登录失败 (${status})`);
    }
    const member = data.member || {};
    return {
      mobile: member.mobile || cleanMobile,
      token,
      hwToken: data.hwToken || '',
      cmccUserId: member.uid || data.userId || '',
      province: member.province || data.province || '',
      secretPhone: data.phone || cleanMobile,
      fingerprint: fp,
    };
  }

  async checkAndRefreshToken(account) {
    const checkRes = await this.request('/user/checkToken', {
      body: null,
      token: account.token,
      fingerprint: account.fingerprint,
    });
    const checkStatus = String(checkRes?.header?.status || '');
    if (CmccClient.isAuthExpiredStatus(checkStatus)) {
      const err = new Error(checkRes?.header?.errMsg || '移动云手机登录态已失效');
      err.code = 'CMCC_AUTH_EXPIRED';
      throw err;
    }

    // Attempt proactive token refresh if supported by session
    try {
      const refRes = await this.request('/user/getRefreshToken', {
        body: {},
        token: account.token,
        fingerprint: account.fingerprint,
      });
      if (String(refRes?.header?.status || '') === '200' && refRes?.data) {
        const d = refRes.data;
        const newToken = typeof d === 'string' ? d : d.token || d.accessToken || d.refreshToken || '';
        const newHwToken = typeof d === 'object' && d.hwToken ? d.hwToken : '';
        if (newToken && newToken.length > 12) {
          return { refreshed: true, token: newToken, hwToken: newHwToken || account.hwToken };
        }
      }
    } catch (_) {
      // Non-fatal if getRefreshToken is optional for current token type
    }
    return { refreshed: false, token: account.token, hwToken: account.hwToken };
  }

  async listDevices(account) {
    const res = await this.request('/device/bookRecord', {
      body: { pageNum: 1, pageSize: 50 },
      token: account.token,
      fingerprint: account.fingerprint,
    });
    const status = String(res?.header?.status || '');
    if (CmccClient.isAuthExpiredStatus(status)) {
      const err = new Error(res?.header?.errMsg || '移动云手机登录态已过期，请重新验证码登录');
      err.code = 'CMCC_AUTH_EXPIRED';
      throw err;
    }
    if (status !== '200') {
      throw new Error(res?.header?.errMsg || `查询云手机列表失败 (${status})`);
    }
    const list = Array.isArray(res?.data?.phoneInstanceList) ? res.data.phoneInstanceList : [];
    return list.map((item) => ({
      phoneId: String(item.phoneId || item.instanceId || ''),
      phoneName: item.phoneName || '移动云手机',
      platformType: String(item.platformType || '1'),
      instanceStatus: String(item.instanceStatus ?? '0'),
      validStatus: item.validStatus || 'VALID',
      lockStatus: Number(item.lockStatus || 0),
      isExpired: Boolean(item.isExpired),
      expireStr: item.expireStr || item.endTime || '',
      endTime: item.endTime || '',
      specName: item.specName || item.productName || '',
      raw: item,
    })).filter((d) => d.phoneId && d.phoneId !== 'fakephoneid');
  }

  async prepareDeviceV2(account, phoneId, platformType = '1') {
    const res = await this.request('/device/instancePrepareV2', {
      body: { instanceId: phoneId, platformType: String(platformType) },
      token: account.token,
      fingerprint: account.fingerprint,
    });
    const status = String(res?.header?.status || '');
    if (CmccClient.isAuthExpiredStatus(status)) {
      const err = new Error(res?.header?.errMsg || '登录态已失效');
      err.code = 'CMCC_AUTH_EXPIRED';
      throw err;
    }
    if (status !== '200') {
      throw new Error(res?.header?.errMsg || `云机准备失败 (${status})`);
    }
    const infos = res?.data?.devicePrepareInfos || [];
    const prepStatus = infos[0]?.status ?? 0;
    return { status: Number(prepStatus), raw: res.data };
  }

  async getPrepareProgress(account, phoneId, platformType = '1') {
    const res = await this.request('/device/prepareProgress', {
      body: { instanceId: phoneId, platformType: String(platformType) },
      token: account.token,
      fingerprint: account.fingerprint,
    });
    const status = String(res?.header?.status || '');
    if (status !== '200') {
      throw new Error(res?.header?.errMsg || `查询云机准备进度失败 (${status})`);
    }
    let st = Number(res?.data?.status ?? 0);
    if (String(platformType) === '2') {
      // Official filterTStatus mapping in chunk-cloudphone
      const map = { 0: 1, 1: 2, 2: 0, 3: 4, 4: 5, 5: 8, 6: 8, '-5': 9, '-6': 9 };
      if (Object.prototype.hasOwnProperty.call(map, st)) st = map[st];
    }
    return { status: st, raw: res.data };
  }

  async wakeUpCloudPhone(account, phoneId) {
    return this.request('/phone/operation/wakeUpSleepingCloudPhone', {
      body: { cloudId: phoneId },
      token: account.token,
      fingerprint: account.fingerprint,
    });
  }

  async ensureDeviceReady(account, phoneId, platformType = '1', maxWaitMs = 45000) {
    const prep = await this.prepareDeviceV2(account, phoneId, platformType);
    if (prep.status === 0) return { ready: true, status: 0 };

    if ([1, 2, 3].includes(prep.status)) {
      if (String(platformType) !== '1') {
        await this.wakeUpCloudPhone(account, phoneId).catch(() => {});
      }
      const deadline = Date.now() + maxWaitMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2500));
        const prog = await this.getPrepareProgress(account, phoneId, platformType);
        if (prog.status === 0) return { ready: true, status: 0 };
        if (![1, 2, 3, 8].includes(prog.status)) {
          throw new Error(`云机唤醒异常 (状态码: ${prog.status})`);
        }
      }
      throw new Error('等待云机唤醒就绪超时，请稍后重试');
    }

    throw new Error(`云机暂未就绪 (状态码: ${prep.status})，未确认开机成功`);
  }

  async waitForPowerState(account, phoneId, expected, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = '';
    do {
      const device = (await this.listDevices(account)).find(d => d.phoneId === phoneId);
      if (!device) throw new Error('官方设备列表中未找到目标云手机');
      lastStatus = String(device.instanceStatus);
      if (expected.includes(lastStatus)) return { confirmed: true, instanceStatus: lastStatus };
      await new Promise(resolve => setTimeout(resolve, 3000));
    } while (Date.now() < deadline);
    throw new Error(`官方已接受电源指令，但最终状态尚未确认 (最后状态: ${lastStatus})`);
  }

  async rebootDevice(account, phoneId, platformType = '1') {
    const res = await this.request('/device/reboot', {
      body: { phoneId, platformType: String(platformType) },
      token: account.token,
      fingerprint: account.fingerprint,
    });
    const status = String(res?.header?.status || '');
    if (status !== '200' || res.data !== true) {
      throw new Error(res?.header?.errMsg || `官方未确认接受重启指令 (status=${status}, result=${JSON.stringify(res.data)})`);
    }
    return { ok: true, data: res.data };
  }

  async shutdownDevice(account, phoneId, platformType = '1') {
    const res = await this.request('/device/shutdown', {
      body: { phoneId, platformType: String(platformType) },
      token: account.token,
      fingerprint: account.fingerprint,
    });
    const status = String(res?.header?.status || '');
    if (status !== '200' || res.data !== true) {
      throw new Error(res?.header?.errMsg || `官方未确认接受关机指令 (status=${status}, result=${JSON.stringify(res.data)})`);
    }
    return { ok: true, data: res.data };
  }

  async captureScreenshot(account, phoneId, platformType = '1') {
    if (String(platformType) === '1') {
      await this.request('/screencap/notification', {
        body: { platformType: '1', deviceId: phoneId },
        token: account.token,
        fingerprint: account.fingerprint,
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 700));
    }
    const res = await this.request('/screencap/pict', {
      body: { deviceId: phoneId, platformType: String(platformType) },
      token: account.token,
      fingerprint: account.fingerprint,
    });
    const status = String(res?.header?.status || '');
    if (status !== '200' || !res?.data) {
      throw new Error(res?.header?.errMsg || `获取云机截图失败 (${status})`);
    }
    return res.data;
  }

  /**
   * Obtain streaming & signaling credentials for either platformType="1" (Yun) or "2" (TCloud).
   */
  async getStreamAuth(account, phoneId, platformType = '1', authId = '') {
    if (String(platformType) === '2') {
      const res = await this.request('/into/v3', {
        baseUrl: this.baseUrl,
        body: { cloudId: phoneId, devicePwd: '' },
        token: account.token,
        fingerprint: account.fingerprint,
      });
      const status = String(res?.header?.status || '');
      if (CmccClient.isAuthExpiredStatus(status)) {
        const err = new Error(res?.header?.errMsg || '登录态已过期');
        err.code = 'CMCC_AUTH_EXPIRED';
        throw err;
      }
      if (status !== '200' || !res?.data?.cloudPhoneInto) {
        throw new Error(res?.header?.errMsg || `T版云机连接鉴权失败 (${status})`);
      }
      const into = res.data.cloudPhoneInto;
      const conn = into.connectedPhoneInfo || {};
      let rtcUrl = '';
      let cmdUrl = '';
      for (const item of conn.ipPortInfoResps || []) {
        if (item.listenPort === 10001) {
          const suffix = conn.signalRtcIpPort
            ? `wsscp/${conn.signalRtcIpPort}`
            : `wscp/${item.phoneIp}/${item.accessPort}`;
          rtcUrl = `wss://api.cp.139.com/${suffix}`;
        } else if (item.listenPort === 10002) {
          const suffix = conn.signalCmdIpPort
            ? `wsscp/${conn.signalCmdIpPort}`
            : `wscp/${item.phoneIp}/${item.accessPort}`;
          cmdUrl = `wss://api.cp.139.com/${suffix}`;
        }
      }
      const ti = into.tokenInfo || {};
      const tokenQueue = [ti.token3, ti.token2, ti.token1].filter(Boolean);
      if (!rtcUrl || !cmdUrl || tokenQueue.length === 0) {
        throw new Error('T版云机缺少 WebSocket 通道或连接 Token');
      }
      return {
        platformType: '2',
        cloudId: phoneId,
        internalPhoneId: into.phoneId || phoneId,
        resolution: into.resolution || '720x1280',
        rtcUrl,
        cmdUrl,
        tokenQueue,
        isMqttFailed: Boolean(conn.isMqttFailed),
        sdkPoint: into.sdkPoint,
        userToken: account.token,
        mobileEncrypted: account.mobile
          ? aesEcbEncryptBase64(account.mobile, 'enHclUpDoN==YSJM')
          : '',
      };
    }

    // platformType === "1" (Yun CloudPhoneClient)
    const body = {
      phoneId,
      streamType: 2,
      channelCode: '',
    };
    if (authId) body.authId = authId;

    const res = await this.request('/user/instance/auth', {
      body,
      token: account.token,
      fingerprint: account.fingerprint,
    });
    const status = String(res?.header?.status || '');
    if (CmccClient.isAuthExpiredStatus(status)) {
      const err = new Error(res?.header?.errMsg || '登录态已过期');
      err.code = 'CMCC_AUTH_EXPIRED';
      throw err;
    }
    if (status !== '200' || !res?.data) {
      throw new Error(res?.header?.errMsg || `云机串流鉴权失败 (${status})`);
    }
    const d = res.data;
    const boxid = d.resource?.deviceId;
    const signalingUrl = d.resource?.rtc?.iceSignaling?.signaling_url || 'https://cmi-dev.5gjoy.com';
    if (!boxid || !d.deviceToken) {
      throw new Error('云机串流凭证缺少 deviceId 或 deviceToken');
    }
    return {
      platformType: '1',
      phoneId,
      boxid,
      token: d.deviceToken,
      sessionid: d.deviceToken,
      roomsession: d.resource?.roomSession || '',
      signaling_url: signalingUrl,
      uuid: account.cmccUserId || account.fingerprint?.uuid || phoneId,
      platform: d.platform || 'cloudphone',
      env: d.env || 'phone580',
      hwToken: account.hwToken || '',
    };
  }
}

module.exports = {
  CmccClient,
  generateDeviceFingerprint,
  rsaEncrypt,
  aesEcbEncryptBase64,
  decryptWorkKeyHex,
  buildSignedHeaders,
};
