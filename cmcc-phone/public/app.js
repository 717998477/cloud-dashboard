(function () {
  'use strict';

  const state = {
    authMode: 'login',
    user: null,
    accounts: [],
    devices: [],
    logs: [],
    pollTimer: null,

    // SMS Captcha
    captchaSessionId: '',
    smsCountdown: 0,
    smsTimer: null,

    // Active Remote Viewer
    activeDeviceId: '',
    activePlatformType: '1',
    yunPlayer: null,
    tPlayer: null,
    viewerMuted: true,
    leaseHeartbeatTimer: null,
  };

  const $ = (id) => document.getElementById(id);

  function showToast(msg, duration = 2400) {
    const box = $('toastBox');
    const el = document.createElement('div');
    el.className = 'toast-item';
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), duration);
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
      if (res.status === 401 && !path.startsWith('/api/auth/') && !path.startsWith('/api/cmcc/')) {
        switchToAuthView();
      }
      throw new Error(data.error || `请求异常 (${res.status})`);
    }
    return data;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDuration(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (d > 0) return `${d}天 ${h}时 ${m}分`;
    if (h > 0) return `${h}时 ${m}分 ${r}秒`;
    if (m > 0) return `${m}分 ${r}秒`;
    return `${r}秒`;
  }

  function formatTime(ts) {
    if (!ts) return '--:--';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // ===== 1. Initialize =====
  async function init() {
    bindAuthEvents();
    bindDashboardEvents();
    bindBindAccountEvents();
    bindSliderEvents();
    bindAdminEvents();
    bindViewerEvents();

    try {
      const me = await api('/api/auth/me');
      state.user = me.user;
      await enterDashboard();
    } catch (_) {
      await switchToAuthView();
    }
  }

  // ===== 2. Auth View =====

  async function switchToAuthView() {
    stopPolling();
    $('dashboardView').classList.add('hidden');
    $('authView').classList.remove('hidden');
    try {
      const boot = await api('/api/auth/bootstrap');
      setAuthMode(boot.hasAnyUser ? 'login' : 'register');
    } catch (_) {
    }
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    $('authTitle').textContent = mode === 'login' ? '账号登录' : '注册管理员账号';
    $('authSubmitBtn').textContent = mode === 'login' ? '进入控制中心' : '创建并进入';
    $('authToggleBtn').textContent = mode === 'login' ? '切换注册' : '切换登录';
  }

  function bindAuthEvents() {
    $('authToggleBtn').addEventListener('click', () => {
      setAuthMode(state.authMode === 'login' ? 'register' : 'login');
    });

    $('authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = $('authUsername').value.trim();
      const password = $('authPassword').value;
      const btn = $('authSubmitBtn');
      btn.disabled = true;
      try {
        const endpoint = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
        const res = await api(endpoint, {
          method: 'POST',
          body: {
            username,
            password,
          }
        });
        state.user = res.user;
        $('authPassword').value = '';
        showToast(`欢迎回来，${res.user.username}`);
        await enterDashboard();
      } catch (err) {
        showToast(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ===== 3. Dashboard =====
  async function enterDashboard() {
    const device = new URLSearchParams(location.search).get('device');
    if (location.pathname === '/control.html' && device) {
      $('authView').classList.add('hidden');
      $('dashboardView').classList.add('hidden');
      await refreshDashboard(true);
      await openWebViewer(device);
      return;
    }

    $('authView').classList.add('hidden');
    $('dashboardView').classList.remove('hidden');
    $('currentUserText').textContent = `${state.user.username} · ${state.user.role === 'admin' ? '系统管理员' : '独立租户'}`;
    $('adminBtn').classList.toggle('hidden', state.user.role !== 'admin');

    await refreshDashboard();
    stopPolling();
    state.pollTimer = setInterval(() => refreshDashboard(true).catch(() => {}), 5000);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function refreshDashboard(silent = false) {
    try {
      const data = await api('/api/dashboard');
      state.user = data.user;
      state.accounts = data.accounts || [];
      state.devices = data.devices || [];
      state.logs = data.logs || [];
      renderOverview();
      renderAccounts();
      renderDevices();
      renderLogs();
    } catch (err) {
      if (!silent) showToast(err.message);
    }
  }

  function renderOverview() {
    $('kpiAccounts').textContent = `${state.accounts.length} / ${state.user.maxAccounts}`;
    $('kpiDevices').textContent = String(state.devices.length);
    const keeping = state.devices.filter(
      (d) => d.runtime && (d.runtime.state === 'KEEPING' || d.runtime.state === 'WEB_CONTROL')
    ).length;
    $('kpiKeeping').textContent = String(keeping);
    const totalBeats = state.devices.reduce((acc, d) => acc + (d.runtime?.heartbeatCount || 0), 0);
    $('kpiHeartbeats').textContent = String(totalBeats);
  }

  function renderAccounts() {
    const list = $('accountList');
    if (state.accounts.length === 0) {
      list.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary);padding:8px 0;">未绑定移动云手机账号，请点击右上角绑定</div>`;
      return;
    }
    list.innerHTML = state.accounts
      .map((a) => {
        const isNormal = a.authStatus === 'valid';
        const badge = isNormal
          ? `<span class="badge badge-success"><span class="badge-dot"></span>有效</span>`
          : `<span class="badge badge-danger"><span class="badge-dot"></span>已过期</span>`;
        return `
          <div class="account-pill">
            <div class="account-info">
              <div class="account-phone">${escapeHtml(a.mobile)} ${badge}</div>
              <div class="account-desc">${escapeHtml(a.remark || '未设置备注')} · 省份: ${escapeHtml(a.province || '自动')}</div>
            </div>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-secondary btn-sm" data-act="sync-acc" data-id="${a.id}">同步</button>
              <button class="btn btn-danger btn-sm" data-act="del-acc" data-id="${a.id}" data-mobile="${escapeHtml(a.mobile)}">解绑</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function getStatusBadge(rt) {
    if (!rt) return `<span class="badge badge-neutral"><span class="badge-dot"></span>未启动</span>`;
    if (rt.state === 'KEEPING') return `<span class="badge badge-success"><span class="badge-dot"></span>保活中</span>`;
    if (rt.state === 'WEB_CONTROL') return `<span class="badge badge-warning"><span class="badge-dot"></span>正在控制</span>`;
    if (rt.state === 'SCHEDULE_WAIT') return `<span class="badge badge-neutral"><span class="badge-dot"></span>定时等待</span>`;
    if (rt.state === 'RECONNECTING') return `<span class="badge badge-warning"><span class="badge-dot"></span>重连中</span>`;
    if (rt.state === 'ERROR') return `<span class="badge badge-danger"><span class="badge-dot"></span>异常</span>`;
    return `<span class="badge badge-neutral"><span class="badge-dot"></span>${escapeHtml(rt.stateText || '空闲')}</span>`;
  }

  function renderDevices() {
    const grid = $('deviceGrid');
    if (state.devices.length === 0) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-tertiary);">名下暂无云手机实例，绑定账号后将自动拉取</div>`;
      return;
    }

    grid.innerHTML = state.devices
      .map((d) => {
        const rt = d.runtime || {};
        const plat = String(d.platformType) === '2' ? 'T版' : '云版';
        const scheduleDesc =
          d.keepaliveMode !== 'continuous'
            ? `循环模式：等待 ${d.waitMinutes || 5} 分钟 → 连接 ${d.connectMinutes || 5} 分钟${rt.nextConnectAt ? ` · 下次连接 ${formatTime(rt.nextConnectAt)}` : ''}`
            : '默认模式：持续长期长连接保活';

        return `
          <div class="device-card">
            <div class="device-top">
              <div>
                <div class="device-title">${escapeHtml(d.phoneName)}</div>
                <div class="device-subtitle">${escapeHtml(d.phoneId)} · ${plat}</div>
              </div>
              <div>${getStatusBadge(rt)}</div>
            </div>

            <div class="device-stats">
              <div class="device-stat-item">
                <span class="device-stat-label">连续在线</span>
                <span class="device-stat-val">${rt.state === 'KEEPING' && rt.connectedSince ? formatDuration((Date.now() - rt.connectedSince) / 1000) : '--'}</span>
              </div>
              <div class="device-stat-item">
                <span class="device-stat-label">心跳次数</span>
                <span class="device-stat-val">${rt.heartbeatCount || 0} 次</span>
              </div>
            </div>

            <div class="device-schedule-text">${scheduleDesc}</div>

            <div class="device-actions">
              <button class="btn btn-primary btn-sm" data-act="open-web" data-id="${d.id}">进入控制</button>
              <button class="btn btn-secondary btn-sm" data-act="keep-settings" data-id="${d.id}">保活策略</button>
              <button class="btn btn-secondary btn-sm" data-act="wakeup" data-id="${d.id}">开机</button>
              <button class="btn btn-secondary btn-sm" data-act="reboot" data-id="${d.id}">重启</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderLogs() {
    const list = $('logsContainer');
    if (state.logs.length === 0) {
      list.innerHTML = `<span style="color:var(--text-tertiary);">暂无运行日志</span>`;
      return;
    }
    list.innerHTML = state.logs
      .map((l) => {
        const color = l.level === 'error' ? 'var(--rose)' : l.level === 'warn' ? 'var(--amber)' : l.level === 'success' ? 'var(--emerald)' : 'var(--text-secondary)';
        return `
          <div style="display:flex;gap:8px;">
            <span style="color:var(--text-tertiary);">${formatTime(l.ts)}</span>
            <span style="color:${color};">${escapeHtml(l.message)}</span>
          </div>
        `;
      })
      .join('');
  }

  function bindDashboardEvents() {
    $('refreshBtn').addEventListener('click', () => refreshDashboard(false).then(() => showToast('已刷新')));
    $('logoutBtn').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      state.user = null;
      await switchToAuthView();
    });

    $('accountList').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      const id = btn.getAttribute('data-id');
      if (act === 'sync-acc') {
        btn.disabled = true;
        try {
          const r = await api(`/api/accounts/${id}/sync`, { method: 'POST' });
          showToast(`同步成功，发现 ${r.deviceCount} 台云机`);
          await refreshDashboard(true);
        } catch (err) {
          showToast(err.message);
        } finally {
          btn.disabled = false;
        }
      } else if (act === 'del-acc') {
        if (!confirm('确定解绑该移动账号并停止名下云手机的后台保活吗？')) return;
        try {
          await api(`/api/accounts/${id}`, { method: 'DELETE' });
          showToast('账号已解绑');
          await refreshDashboard(true);
        } catch (err) {
          showToast(err.message);
        }
      }
    });

    $('deviceGrid').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      const id = btn.getAttribute('data-id');

      if (act === 'open-web') {
        window.open('/control.html?device=' + encodeURIComponent(id), '_blank', 'noopener,noreferrer');
      } else if (act === 'keep-settings') {
        openKeepaliveSettings(id);
      } else if (act === 'wakeup' || act === 'reboot') {
        btn.disabled = true;
        try {
          const r = await api(`/api/devices/${id}/power`, { method: 'POST', body: { action: act } });
          showToast(r.message || '指令已下发');
          await refreshDashboard(true);
        } catch (err) {
          showToast(err.message);
        } finally {
          btn.disabled = false;
        }
      }
    });

    // Keepalive Settings Form
    for (const id of ['keepaliveModeSelect', 'keepaliveWaitInput', 'keepaliveDurationInput', 'keepaliveEnabledInput']) {
      $(id).addEventListener('input', updateKeepalivePreview);
    }
    $('keepaliveCancelBtn').addEventListener('click', () => $('keepaliveSettingsPanel').classList.add('hidden'));
    $('keepaliveSettingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('keepaliveSettingsPanel').dataset.deviceId;
      const body = {
        keepaliveEnabled: $('keepaliveEnabledInput').checked,
        keepaliveMode: $('keepaliveModeSelect').value,
      };
      if (body.keepaliveMode === 'cycle') {
        body.waitMinutes = Number($('keepaliveWaitInput').value);
        body.connectMinutes = Number($('keepaliveDurationInput').value);
      }
      try {
        await api(`/api/devices/${id}/settings`, { method: 'PATCH', body });
        $('keepaliveSettingsPanel').classList.add('hidden');
        showToast('保活策略已更新');
        await refreshDashboard(true);
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  function openKeepaliveSettings(id) {
    const dev = state.devices.find((d) => d.id === id);
    if (!dev) return;
    const panel = $('keepaliveSettingsPanel');
    panel.dataset.deviceId = id;
    $('keepaliveSettingsName').textContent = `${dev.phoneName} (${dev.phoneId})`;
    $('keepaliveModeSelect').value = dev.keepaliveMode || 'cycle';
    $('keepaliveWaitInput').value = dev.waitMinutes || 5;
    $('keepaliveDurationInput').value = dev.connectMinutes || 5;
    $('keepaliveEnabledInput').checked = dev.keepaliveEnabled !== false;
    updateKeepalivePreview();
    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function updateKeepalivePreview() {
    const cycle = $('keepaliveModeSelect').value === 'cycle';
    $('keepaliveCycleFields').classList.toggle('hidden', !cycle);
    const wait = Number($('keepaliveWaitInput').value || 5);
    const duration = Number($('keepaliveDurationInput').value || 5);
    $('keepaliveSchedulePreview').textContent = !$('keepaliveEnabledInput').checked
      ? '已暂停保活：服务不会主动建立长连接。'
      : cycle
      ? `定时策略：保存后等待 ${wait} 分钟 → 建立长连接 ${duration} 分钟 → 断开等待 ${wait} 分钟，循环执行。`
      : '持续策略：7×24 小时保持原生通道长连接；断线自动重连。进入 Web 控制时自动让位防互踢。';
  }

  // ===== 4. Bind Account (SMS / Password) =====
  function bindBindAccountEvents() {
    $('addAccountBtn').addEventListener('click', () => $('bindModal').classList.remove('hidden'));
    $('closeBindBtn').addEventListener('click', () => {
      $('bindModal').classList.add('hidden');
      $('sliderBox').classList.add('hidden');
    });

    document.querySelectorAll('.bind-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const mode = tab.dataset.mode;
        document.querySelectorAll('.bind-tab').forEach((t) => t.classList.toggle('active', t === tab));
        $('bindSmsBox').classList.toggle('hidden', mode !== 'sms');
        $('bindPwdBox').classList.toggle('hidden', mode !== 'pwd');
      });
    });

    $('getSmsBtn').addEventListener('click', loadCaptcha);
    $('reloadCaptchaBtn').addEventListener('click', loadCaptcha);

    $('submitSmsBtn').addEventListener('click', async () => {
      const mobile = $('bindMobile').value.trim();
      const code = $('bindSmsCode').value.trim();
      const remark = $('bindRemark').value.trim();
      try {
        const res = await api('/api/cmcc/login/sms', {
          method: 'POST',
          body: { mobile, code, remark, captchaSessionId: state.captchaSessionId },
        });
        showToast(`绑定成功！已同步 ${res.deviceCount} 台云手机`);
        $('bindModal').classList.add('hidden');
        $('bindSmsCode').value = '';
        await refreshDashboard(true);
      } catch (err) {
        showToast(err.message);
      }
    });

    $('submitPwdBtn').addEventListener('click', async () => {
      const mobile = $('pwdMobile').value.trim();
      const password = $('pwdPassword').value;
      const remark = $('pwdRemark').value.trim();
      try {
        const res = await api('/api/cmcc/login/password', {
          method: 'POST',
          body: { mobile, password, remark },
        });
        showToast(`登录成功！已同步 ${res.deviceCount} 台云机`);
        $('bindModal').classList.add('hidden');
        $('pwdPassword').value = '';
        await refreshDashboard(true);
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  async function loadCaptcha() {
    const mobile = $('bindMobile').value.replace(/\s+/g, '');
    if (!/^1\d{10}$/.test(mobile)) {
      showToast('请输入有效的 11 位手机号');
      return;
    }
    resetSlider();
    try {
      const res = await api('/api/cmcc/captcha/get', { method: 'POST', body: { mobile } });
      state.captchaSessionId = res.captchaSessionId;
      $('puzzleBg').src = 'data:image/png;base64,' + res.originalImageBase64;
      $('puzzleJigsaw').src = 'data:image/png;base64,' + res.jigsawImageBase64;
      $('sliderBox').classList.remove('hidden');
    } catch (err) {
      showToast(err.message);
    }
  }

  function resetSlider() {
    $('sliderHandle').style.left = '0px';
    $('puzzleJigsaw').style.left = '0px';
    $('sliderFill').style.width = '0px';
    $('sliderHint').textContent = '按住滑块向右拖动';
  }

  function bindSliderEvents() {
    const handle = $('sliderHandle');
    const jigsaw = $('puzzleJigsaw');
    const fill = $('sliderFill');
    const maxOffset = 300 - 44;
    let dragging = false;
    let startX = 0;
    let currentLeft = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (!state.captchaSessionId) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      dragging = true;
      startX = e.clientX;
      currentLeft = 0;
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const dx = Math.max(0, Math.min(maxOffset, e.clientX - startX));
      currentLeft = dx;
      handle.style.left = `${dx}px`;
      jigsaw.style.left = `${dx}px`;
      fill.style.width = `${dx + 22}px`;
    });

    const finish = async () => {
      if (!dragging) return;
      dragging = false;
      if (currentLeft < 5) {
        resetSlider();
        return;
      }
      $('sliderHint').textContent = '正在验证…';
      try {
        await api('/api/cmcc/captcha/send-sms', {
          method: 'POST',
          body: { captchaSessionId: state.captchaSessionId, moveX: Math.round(currentLeft) },
        });
        showToast('短信验证码已下发');
        $('sliderBox').classList.add('hidden');
        startCountdown();
        $('bindSmsCode').focus();
      } catch (err) {
        showToast(err.message);
        await loadCaptcha();
      }
    };

    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  function startCountdown() {
    state.smsCountdown = 60;
    const btn = $('getSmsBtn');
    btn.disabled = true;
    btn.textContent = `${state.smsCountdown}s`;
    if (state.smsTimer) clearInterval(state.smsTimer);
    state.smsTimer = setInterval(() => {
      state.smsCountdown -= 1;
      if (state.smsCountdown <= 0) {
        clearInterval(state.smsTimer);
        btn.disabled = false;
        btn.textContent = '获取验证码';
      } else {
        btn.textContent = `${state.smsCountdown}s`;
      }
    }, 1000);
  }

  // ===== 5. Admin Management =====
  function bindAdminEvents() {
    $('adminBtn').addEventListener('click', async () => {
      $('adminModal').classList.remove('hidden');
      await loadAdminUsers();
    });
    $('closeAdminBtn').addEventListener('click', () => $('adminModal').classList.add('hidden'));

    $('createAdminUserBtn').addEventListener('click', async () => {
      const username = $('newAdminUser').value.trim();
      const password = $('newAdminPass').value;
      const maxAccounts = Number($('newAdminQuota').value || 10);
      try {
        await api('/api/admin/users', { method: 'POST', body: { username, password, maxAccounts } });
        $('newAdminUser').value = '';
        $('newAdminPass').value = '';
        showToast('用户创建成功');
        await loadAdminUsers();
      } catch (err) {
        showToast(err.message);
      }
    });

    $('adminUsersTbody').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-uact]');
      if (!btn) return;
      const act = btn.dataset.uact;
      const uid = btn.dataset.uid;
      if (act === 'del-user') {
        if (!confirm('确定删除该用户吗？名下账号与云机保活将同步清理。')) return;
        try {
          await api(`/api/admin/users/${uid}`, { method: 'DELETE' });
          showToast('用户已删除');
          await loadAdminUsers();
        } catch (err) {
          showToast(err.message);
        }
      }
    });
  }

  async function loadAdminUsers() {
    try {
      const res = await api('/api/admin/users');
      $('adminUsersTbody').innerHTML = (res.users || [])
        .map((u) => {
          const isSelf = u.id === state.user.id;
          return `
            <tr style="border-bottom:1px solid var(--border-subtle);">
              <td style="padding:8px 6px;">${escapeHtml(u.username)}</td>
              <td style="padding:8px 6px;">${u.role === 'admin' ? '管理员' : '租户'}</td>
              <td style="padding:8px 6px;">${u.accountCount} / ${u.maxAccounts}</td>
              <td style="padding:8px 6px;">
                ${isSelf ? '<span style="color:var(--text-tertiary);">当前账号</span>' : `<button class="btn btn-danger btn-sm" data-uact="del-user" data-uid="${u.id}">删除</button>`}
              </td>
            </tr>
          `;
        })
        .join('');
    } catch (err) {
      showToast(err.message);
    }
  }

  // ===== 6. Web Remote Control Viewer =====
  async function openWebViewer(deviceId) {
    await destroyActivePlayers(true);
    state.activeDeviceId = deviceId;
    const dev = state.devices.find((d) => d.id === deviceId);
    $('viewerPhoneName').textContent = dev ? dev.phoneName : '移动云手机';
    $('viewerRtt').textContent = '-- ms';
    $('viewerOverlay').classList.remove('hidden');
    $('viewerStatusText').textContent = '正在准备串流环境…';
    $('viewerModal').classList.remove('hidden');

    state.leaseHeartbeatTimer = setInterval(() => {
      if (state.activeDeviceId) {
        api(`/api/devices/${state.activeDeviceId}/stream/heartbeat`, { method: 'POST' }).catch(() => {});
      }
    }, 20000);

    await connectViewerStream();
  }

  async function connectViewerStream() {
    if (!state.activeDeviceId) return;
    try {
      const res = await api(`/api/devices/${state.activeDeviceId}/stream/open`, { method: 'POST', body: {} });
      await refreshDashboard(true);
      state.activePlatformType = String(res.stream.platformType || '1');
      if (state.activePlatformType === '2') {
        startTCloudViewer(res.stream);
      } else {
        startYunViewer(res.stream);
      }
    } catch (err) {
      $('viewerStatusText').textContent = `连接失败：${err.message}`;
      showToast(err.message);
    }
  }

  function startYunViewer(stream) {
    if (!window.CloudPhoneClient) {
      $('viewerStatusText').textContent = '本地播放器组件未就绪';
      return;
    }
    const mount = $('player');
    mount.innerHTML = '';
    const player = window.CloudPhoneClient.createCloudPhonePlayer('player', {
      noOperationThreshold: 0,
      sessionKeepingTime: 60,
      disRotate: true,
      mode: 'screen_share',
      role: 'master',
      userToken: stream.hwToken || '',
      instanceId: stream.phoneId,
      enableAllAspect: true,
      enableClipboard: true,
      enableWheel2Touch: true,
      disableAutoReconnect: false,
    });
    state.yunPlayer = player;

    player.on('statechange', (ev) => {
      if (ev?.state === 'playing') {
        $('viewerOverlay').classList.add('hidden');
        player.setMuted(state.viewerMuted);
      }
    });
    player.on('qos', (q) => {
      if (q?.rtt != null) $('viewerRtt').textContent = `${q.rtt} ms`;
    });
    player.on('exit', () => {
      $('viewerOverlay').classList.remove('hidden');
      $('viewerStatusText').textContent = '串流已断开，可点击重连';
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
      profile: 2,
      muted: state.viewerMuted,
    });
  }

  function startTCloudViewer(stream) {
    const mount = $('player');
    const tp = new window.TCloudWebPlayer(mount, stream, {
      onState: (txt) => { $('viewerStatusText').textContent = txt; },
      onPlaying: () => {
        $('viewerOverlay').classList.add('hidden');
        tp.setMuted(state.viewerMuted);
      },
      onRtt: (rtt) => { $('viewerRtt').textContent = `${rtt} ms`; },
      onError: (msg) => {
        $('viewerOverlay').classList.remove('hidden');
        $('viewerStatusText').textContent = msg;
      },
    });
    state.tPlayer = tp;
    tp.start();
  }

  async function destroyActivePlayers(releaseServerLease = true) {
    if (state.leaseHeartbeatTimer) {
      clearInterval(state.leaseHeartbeatTimer);
      state.leaseHeartbeatTimer = null;
    }
    if (state.yunPlayer) {
      try { state.yunPlayer.close(); state.yunPlayer.destroy(); } catch (_) {}
      state.yunPlayer = null;
    }
    if (state.tPlayer) {
      try { state.tPlayer.destroy(); } catch (_) {}
      state.tPlayer = null;
    }
    $('player').innerHTML = '';

    const prevId = state.activeDeviceId;
    if (releaseServerLease && prevId) {
      state.activeDeviceId = '';
      await api(`/api/devices/${prevId}/stream/close`, { method: 'POST' }).catch(() => {});
      await refreshDashboard(true);
    }
  }

  function bindViewerEvents() {
    $('viewerCloseBtn').addEventListener('click', async () => {
      $('viewerModal').classList.add('hidden');
      await destroyActivePlayers(true);
      showToast('已退出控制，恢复后台保活');
      if (location.pathname === '/control.html') { window.close(); location.replace('/'); }
    });

    $('viewerReconnectBtn').addEventListener('click', async () => {
      const id = state.activeDeviceId;
      if (!id) return;
      await destroyActivePlayers(false);
      state.activeDeviceId = id;
      state.leaseHeartbeatTimer = setInterval(() => { if(state.activeDeviceId) api(`/api/devices/${state.activeDeviceId}/stream/heartbeat`, {method:'POST'}).catch(()=>{}); }, 20000);
      await connectViewerStream();
    });

    $('viewerMuteBtn').addEventListener('click', () => {
      state.viewerMuted = !state.viewerMuted;
      $('viewerMuteBtn').textContent = state.viewerMuted ? '静音' : '声音开';
      if (state.yunPlayer) state.yunPlayer.setMuted(state.viewerMuted);
      if (state.tPlayer) state.tPlayer.setMuted(state.viewerMuted);
    });

    $('navTaskBtn').addEventListener('click', () => {
      if (state.yunPlayer) state.yunPlayer.emitAppSwitch();
      if (state.tPlayer) state.tPlayer.emitAppSwitch();
    });

    $('navHomeBtn').addEventListener('click', () => {
      if (state.yunPlayer) state.yunPlayer.emitHome();
      if (state.tPlayer) state.tPlayer.emitHome();
    });

    $('navBackBtn').addEventListener('click', () => {
      if (state.yunPlayer) state.yunPlayer.emitBack();
      if (state.tPlayer) state.tPlayer.emitBack();
    });
  }

  window.addEventListener('pagehide', () => { if(state.activeDeviceId) navigator.sendBeacon(`/api/devices/${state.activeDeviceId}/stream/close`, '{}'); });
  document.addEventListener('DOMContentLoaded', init);
})();
