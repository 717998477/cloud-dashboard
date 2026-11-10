(function () {
  'use strict';

  const deviceId = new URLSearchParams(location.search).get('id') || '';
  const state = {
    platformType: '1',
    yunPlayer: null,
    tPlayer: null,
    muted: true,
    heartbeatTimer: null,
    closing: false,
  };

  const $ = (id) => document.getElementById(id);

  function toast(msg, ms = 2800) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('toastWrap').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && typeof options.body === 'object') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `请求失败 (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function setStatus(text) {
    $('vStatus').textContent = text;
    $('vOverlay').classList.remove('hidden');
  }
  function hideOverlay() {
    $('vOverlay').classList.add('hidden');
  }

  async function init() {
    bindUi();
    if (!deviceId) {
      setStatus('缺少设备参数，请从工作台重新打开控制页面');
      return;
    }
    try {
      await api('/api/auth/me');
    } catch (err) {
      setStatus('登录状态已失效，请先回工作台登录，再重新打开控制页面');
      $('vHomeLink').classList.remove('hidden');
      return;
    }
    // 设备名（拿不到也不阻塞连接）
    try {
      const dash = await api('/api/dashboard');
      const dev = (dash.devices || []).find((d) => d.id === deviceId);
      if (dev) {
        $('vName').textContent = dev.phoneName;
        document.title = `${dev.phoneName} · 云手机控制`;
        state.platformType = String(dev.platformType || '1');
      }
    } catch (_) {}

    // 保活租约心跳：控制期间后台保活让位
    state.heartbeatTimer = setInterval(() => {
      api(`/api/devices/${deviceId}/stream/heartbeat`, { method: 'POST' }).catch(() => {});
    }, 20000);

    await connect();
  }

  async function connect() {
    setStatus('正在获取官方串流凭证并协商视频通道…');
    $('vRtt').textContent = '-- ms';
    try {
      const res = await api(`/api/devices/${deviceId}/stream/open`, { method: 'POST', body: {} });
      const stream = res.stream;
      if (res.device && res.device.phoneName) {
        $('vName').textContent = res.device.phoneName;
        document.title = `${res.device.phoneName} · 云手机控制`;
      }
      state.platformType = String(stream.platformType || (res.device && res.device.platformType) || state.platformType || '1');
      $('vQuality').classList.toggle('hidden', state.platformType === '2');
      if (state.platformType === '2') {
        startTPlayer(stream);
      } else {
        startYunPlayer(stream);
      }
    } catch (err) {
      setStatus(`连接云手机失败：${err.message}。可点击「重连」重试`);
    }
  }

  /* ---------- 云版（官方 SDK） ---------- */
  function startYunPlayer(stream) {
    if (!window.CloudPhoneClient) {
      setStatus('云版播放器 SDK 未加载成功，请刷新页面重试');
      return;
    }
    const mount = $('player');
    mount.innerHTML = '';

    const player = window.CloudPhoneClient.createCloudPhonePlayer('player', {
      noOperationThreshold: 0,
      sessionKeepingTime: 60,
      countdownTime: 60,
      disRotate: true,
      disGps: true,
      mode: 'screen_share',
      role: 'master',
      disStats: false,
      syncSensorsOrientation: true,
      userToken: stream.hwToken || '',
      instanceId: stream.phoneId,
      enableAllAspect: true,
      enableClipboard: true,
      enableWheel2Touch: true,
      disableAutoReconnect: false,
      logLevel: 2,
    });
    state.yunPlayer = player;

    if (!player.isSupport()) {
      setStatus('当前浏览器不支持 WebRTC H.264 硬解，请使用最新版 Chrome / Edge / Safari');
      return;
    }

    player.on('statechange', (ev) => {
      const st = ev && ev.state;
      const map = {
        signal_connecting: '正在连接移动云信令网关 (20%)…',
        signal_connected: '信令网关已连接，正在鉴权 (40%)…',
        authorized: '云机鉴权通过，正在请求画面流 (60%)…',
        peer_connecting: '正在建立 WebRTC 媒体流 (85%)…',
        peer_connected: '媒体流已连通，即将渲染画面…',
      };
      if (map[st]) setStatus(map[st]);
      if (st === 'playing') {
        hideOverlay();
        try {
          player.setMuted(state.muted);
          const rect = mount.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            player.setCloudScreenAspect(rect.height, rect.width);
          }
        } catch (_) {}
      }
    });

    player.on('qos', (q) => {
      if (q && q.rtt != null) $('vRtt').textContent = `${q.rtt} ms`;
    });

    player.on('exit', (ev) => {
      setStatus(`串流已断开 (${(ev && (ev.reason || ev.code)) || '会话结束'})，可点击「重连」继续控制`);
    });

    player.disableBeforeunload(true);
    player.open({
      boxid: stream.boxid,
      token: stream.token,
      roomsession: stream.roomsession || '',
      signaling_url: stream.signaling_url,
      uuid: stream.uuid,
      sessionid: stream.sessionid || stream.token,
      platform: stream.platform || 'cloudphone',
      env: stream.env || 'phone580',
      profile: Number($('vQuality').value || 2),
      muted: state.muted,
      ipv6_timeout: 2000,
      prefer_ipv6: false,
    });
  }

  /* ---------- T 版（WebRTC 播放器） ---------- */
  function startTPlayer(stream) {
    const mount = $('player');
    mount.innerHTML = '';
    const tp = new window.TCloudWebPlayer(mount, stream, {
      onState: (txt) => setStatus(txt),
      onPlaying: () => {
        hideOverlay();
        tp.setMuted(state.muted);
      },
      onRtt: (rtt) => { $('vRtt').textContent = `${rtt} ms`; },
      onError: (msg) => setStatus(msg),
    });
    state.tPlayer = tp;
    window.cmccVideoDiagnostics = () => tp.getDiagnostics();
    tp.start();
  }

  function destroyPlayers() {
    if (state.yunPlayer) {
      try { state.yunPlayer.close(); state.yunPlayer.destroy(); } catch (_) {}
      state.yunPlayer = null;
    }
    if (state.tPlayer) {
      try { state.tPlayer.destroy(); } catch (_) {}
      state.tPlayer = null;
    }
    $('player').innerHTML = '';
  }

  async function closeViewer() {
    if (state.closing) return;
    state.closing = true;
    if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
    destroyPlayers();
    await api(`/api/devices/${deviceId}/stream/close`, { method: 'POST' }).catch(() => {});
    window.close();
    setTimeout(() => { location.href = '/'; }, 350);
  }

  function bindUi() {
    $('vClose').addEventListener('click', closeViewer);

    $('vReconnect').addEventListener('click', async () => {
      destroyPlayers();
      await connect();
    });

    $('vMute').addEventListener('click', () => {
      state.muted = !state.muted;
      $('vMute').textContent = state.muted ? '静音中' : '声音开';
      if (state.yunPlayer) state.yunPlayer.setMuted(state.muted);
      if (state.tPlayer) state.tPlayer.setMuted(state.muted);
    });

    $('vQuality').addEventListener('change', (e) => {
      if (state.yunPlayer) {
        state.yunPlayer.setProfile(Number(e.target.value));
        toast('画质切换指令已发送');
      }
    });

    $('navTask').addEventListener('click', () => {
      if (state.yunPlayer) state.yunPlayer.emitAppSwitch();
      if (state.tPlayer) state.tPlayer.emitAppSwitch();
    });
    $('navHome').addEventListener('click', () => {
      if (state.yunPlayer) state.yunPlayer.emitHome();
      if (state.tPlayer) state.tPlayer.emitHome();
    });
    $('navBack').addEventListener('click', () => {
      if (state.yunPlayer) state.yunPlayer.emitBack();
      if (state.tPlayer) state.tPlayer.emitBack();
    });

    const sendText = async () => {
      const text = $('vText').value;
      if (!text) return;
      if (state.tPlayer) {
        state.tPlayer.sendText(text);
        $('vText').value = '';
        toast('文字已发送至云手机输入框');
      } else if (state.yunPlayer) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
          }
          if (typeof state.yunPlayer._sendDcMessage === 'function') {
            state.yunPlayer._sendDcMessage({ type: 'clipboard', data: btoa(unescape(encodeURIComponent(text))) });
          }
          $('vText').value = '';
          toast('已同步至云手机剪贴板，可在云机内粘贴');
        } catch (_) {
          toast('剪贴板同步已发送');
        }
      } else {
        toast('画面尚未连接，无法发送文字');
      }
    };
    $('vSendText').addEventListener('click', sendText);
    $('vText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });

    window.addEventListener('beforeunload', () => {
      if (deviceId && !state.closing && navigator.sendBeacon) {
        navigator.sendBeacon(`/api/devices/${deviceId}/stream/close`, '{}');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
