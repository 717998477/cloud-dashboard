(function (global) {
  'use strict';

  const CMD_GET_KEY_FRAME = 4001;
  const CMD_ACTION_PREPARE_CONNECT = 6056;
  const CMD_ACTION_SHELL = 100019;
  const CMD_ACTION_HEART = 100022;
  const CMD_ACTION_TOUCH = 100023;
  const CMD_ACTION_IME_INPUT_TEXT = 120005;

  class TCloudWebPlayer {
    constructor(containerEl, streamAuth, callbacks = {}) {
      this.container = containerEl;
      this.auth = streamAuth;
      this.cb = callbacks;
      this.videoEl = null;
      this.rtcWs = null;
      this.cmdWs = null;
      this.pc = null;
      this.heartbeatTimer = null;
      this.statsTimer = null;
      this.reqSeq = 1;
      this.destroyed = false;
      this.isMuted = true;
      this.pointerDown = false;
      this.remoteStream = new MediaStream();
      this.pendingCandidates = [];
      this.firstFrameShown = false;
      this.controlReady = false;
      this.controlPacketsSent = 0;

      const [rw, rh] = String(streamAuth.resolution || '720x1280')
        .split('x')
        .map((n) => parseInt(n, 10) || 0);
      this.phoneWidth = rw || 720;
      this.phoneHeight = rh || 1280;
      this.token = (streamAuth.tokenQueue && streamAuth.tokenQueue[0]) || '';
      this.msgId = `${streamAuth.internalPhoneId}-${Math.floor(Math.random() * 1e6)}-${Date.now()}`;
    }

    start() {
      this.container.innerHTML = '';
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = this.isMuted;
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.objectFit = 'contain';
      video.style.background = '#000';
      video.style.touchAction = 'none';
      video.style.userSelect = 'none';
      this.container.appendChild(video);
      this.videoEl = video;

      this._bindPointerEvents(video);
      this._connectCmdChannel();
      this._connectRtcSignal();
    }

    _sendCmdPacket(code, payloadObj) {
      if (!this.cmdWs || this.cmdWs.readyState !== WebSocket.OPEN) return;
      this.controlPacketsSent += 1;
      this.cmdWs.send(
        JSON.stringify({
          code,
          msg: JSON.stringify(payloadObj),
        })
      );
    }

    cmd(type, messageObjOrStr) {
      this.reqSeq += 1;
      const message =
        typeof messageObjOrStr === 'object' && messageObjOrStr !== null
          ? JSON.stringify(messageObjOrStr)
          : String(messageObjOrStr ?? '');
      this._sendCmdPacket(10013, {
        type,
        reqid: this.reqSeq,
        time: Date.now(),
        message,
        device: 6,
        t: this.token,
        msgid: this.msgId,
        version: 0,
      });
    }

    touch(cmdType, dataObjOrStr) {
      this.reqSeq += 1;
      const data =
        cmdType === CMD_ACTION_SHELL
          ? String(dataObjOrStr)
          : JSON.stringify(dataObjOrStr);
      this._sendCmdPacket(10014, {
        cmdType,
        reqid: this.reqSeq,
        data,
        device: 6,
        t: this.token,
        msgid: this.msgId,
        version: 0,
        time: Date.now(),
      });
    }

    _connectCmdChannel() {
      const ws = new WebSocket(this.auth.cmdUrl);
      ws.binaryType = 'arraybuffer';
      this.cmdWs = ws;

      ws.onopen = () => {
        if (this.destroyed) return;
        const prepare = {
          packageName: '',
          capbility: 7,
          definition: 1,
          density: 320,
          width: this.phoneWidth,
          height: this.phoneHeight,
          machineType: 0,
          userToken: this.auth.userToken || '',
          cloudId: this.auth.cloudId,
          phoneId: this.auth.internalPhoneId,
          isMqttFailed: Boolean(this.auth.isMqttFailed),
        };
        // Official sendByCmd(..., true) wraps AND flattens message fields.
        this.cmd(CMD_ACTION_PREPARE_CONNECT, {
          type: CMD_ACTION_PREPARE_CONNECT, message: prepare, ...prepare,
        });

        this.heartbeatTimer = setInterval(() => {
          this.cmd(CMD_ACTION_HEART, '');
          this.touch(CMD_ACTION_HEART, '');
        }, 15000);
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          const msg = JSON.parse(ev.data);
          if (Number(msg.type || msg.code) === CMD_ACTION_PREPARE_CONNECT) {
            if (msg.isSuccess !== true) {
              if (this.cb.onError) this.cb.onError('T版控制握手被拒绝，请重新连接');
              return;
            }
            const dims = typeof msg.message === 'string' ? JSON.parse(msg.message) : msg.message;
            if (dims?.width > 0) this.phoneWidth = dims.width;
            if (dims?.height > 0) this.phoneHeight = dims.height;
            const config = {
              token: this.auth.userToken, cloudId: this.auth.cloudId,
              cloud_model: 'basic', mobile: this.auth.mobileEncrypted || '',
              platform: 'h5', platformVersion: 'COMBINE',
              'controller.login.mode': 2, 'controller.auth.version': 2,
              timestamp: Date.now(), app_version: '4.4.0',
              resolution: { real_width: this.phoneWidth, real_height: this.phoneHeight,
                real_status_bar: 84, real_navigation_bar: 126 },
              notch: { status_bar_height: 84, is_status_bar_visible: false,
                notchSize: { left: 449, top: 0, right: 631, bottom: 73 } },
            };
            this.cmd(6001, { type: 6001, message: { config }, config });
            this.controlReady = true;
          }
        } catch (_) {}
      };
      ws.onclose = () => {
        this.controlReady = false;
        if (!this.destroyed && this.cb.onError) this.cb.onError('T版控制通道已断开，请点击重连');
      };
      ws.onerror = () => {
        if (!this.destroyed && this.cb.onError) this.cb.onError('T版控制通道连接异常');
      };
    }

    _connectRtcSignal() {
      const ws = new WebSocket(this.auth.rtcUrl);
      this.rtcWs = ws;

      const pc = new RTCPeerConnection({
        sdpSemantics: 'unified-plan',
      });
      this.pc = pc;
      pc.onconnectionstatechange = () => {
        if (this.cb.onState && !this.firstFrameShown) this.cb.onState('WebRTC: ' + pc.connectionState + ' / ICE: ' + pc.iceConnectionState);
        if (pc.connectionState === 'failed' && this.cb.onError) this.cb.onError('WebRTC 媒体链路失败，信令已连接但 UDP 媒体未连通，请重连或更换网络');
      };

      pc.ontrack = (ev) => {
        if (this.destroyed) return;
        if (!this.remoteStream.getTracks().some(t => t.id === ev.track.id)) {
          this.remoteStream.addTrack(ev.track);
        }
        this.videoEl.srcObject = this.remoteStream;
        this.videoEl.play().catch(err => {
          if (this.cb.onState) this.cb.onState('自动播放受限，请点击画面播放: ' + err.message);
        });
        // ontrack only means negotiation succeeded, not that any frame was decoded.
        this.videoEl.onplaying = () => {
          if (this.videoEl.videoWidth > 0 && !this.firstFrameShown) {
            this.firstFrameShown = true;
            if (this.cb.onPlaying) this.cb.onPlaying();
          }
        };
        this.videoEl.onclick = () => this.videoEl.play().catch(() => {});
        if (ev.track.kind === 'video') {
          setTimeout(() => {
            if (!this.destroyed) this.cmd(CMD_GET_KEY_FRAME, { requestKeyFrame: true });
          }, 1500);
        }
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              id: this.auth.internalPhoneId,
              msgid: this.msgId,
              peerid: this.auth.internalPhoneId,
              candidate: ev.candidate.candidate,
              mid: ev.candidate.sdpMid,
              sdpMLineIndex: ev.candidate.sdpMLineIndex,
              type: 'candidate',
            })
          );
        }
      };

      ws.onopen = () => {
        if (this.destroyed) return;
        if (this.cb.onState) this.cb.onState('信令已连接，正在协商视频流...');
        const signalOpt = {
          cameraDataType: 1,
          clienttype: 'h5',
          cloudid: this.auth.cloudId,
          deviceid: 'web-' + Math.random().toString(36).slice(2, 12),
          msgid: this.msgId,
          packetization_mode: 1,
          peerid: this.auth.internalPhoneId,
          id: this.auth.internalPhoneId,
          physical_resolution: { width: this.phoneWidth, height: this.phoneHeight },
          supporth265: false,
          capbility: 7,
          token: this.token,
          type: 'request',
          isroommgr: 1,
          version: 1,
          virtual_resolution: { width: this.phoneWidth, height: this.phoneHeight, density: 320 },
          sdkPoint: this.auth.sdkPoint || undefined,
          deviceInfo: {
            clientinfo: 'Web',
            network: 'WIFI',
            browser_type: 'Chrome',
            browser_version: '120.0',
          },
        };
        ws.send(JSON.stringify(signalOpt));
      };

      ws.onmessage = async (ev) => {
        if (this.destroyed || typeof ev.data !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        if (msg.type === 'offer') {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            for (const candidate of this.pendingCandidates.splice(0)) {
              await pc.addIceCandidate(candidate).catch(() => {});
            }
            ws.send(
              JSON.stringify({
                id: this.auth.internalPhoneId,
                msgid: this.msgId,
                peerid: this.auth.internalPhoneId,
                type: answer.type,
                sdp: answer.sdp,
              })
            );
          } catch (err) {
            if (this.cb.onError) this.cb.onError('WebRTC 媒体协商失败: ' + err.message);
          }
        } else if (msg.type === 'candidate' && msg.candidate) {
          try {
            const candidate = new RTCIceCandidate({
                candidate: msg.candidate.startsWith('a=') ? msg.candidate.slice(2) : msg.candidate,
                sdpMid: msg.mid ?? msg.sdpMid ?? '0',
                sdpMLineIndex: msg.sdpMLineIndex ?? 0,
              });
            if (pc.remoteDescription) await pc.addIceCandidate(candidate);
            else this.pendingCandidates.push(candidate);
          } catch (_) {}
        }
      };

      ws.onerror = () => {
        if (!this.destroyed && this.cb.onError) {
          this.cb.onError('T版视频信令连接失败');
        }
      };

      this.statsTimer = setInterval(async () => {
        if (!this.pc || this.destroyed) return;
        try {
          const stats = await this.pc.getStats();
          stats.forEach((report) => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
              if (this.cb.onRtt) this.cb.onRtt(Math.round(report.currentRoundTripTime * 1000));
            }
          });
        } catch (_) {}
      }, 2000);
    }

    _mapCoords(clientX, clientY) {
      const rect = this.videoEl.getBoundingClientRect();
      const vw = this.videoEl.videoWidth || this.phoneWidth;
      const vh = this.videoEl.videoHeight || this.phoneHeight;
      const containerRatio = rect.width / rect.height;
      const videoRatio = vw / vh;
      let renderW = rect.width;
      let renderH = rect.height;
      let offsetX = 0;
      let offsetY = 0;
      if (containerRatio > videoRatio) {
        renderW = rect.height * videoRatio;
        offsetX = (rect.width - renderW) / 2;
      } else {
        renderH = rect.width / videoRatio;
        offsetY = (rect.height - renderH) / 2;
      }
      const relX = Math.max(0, Math.min(1, (clientX - rect.left - offsetX) / renderW));
      const relY = Math.max(0, Math.min(1, (clientY - rect.top - offsetY) / renderH));
      return {
        // Official T SDK sends normalized coordinates (0..1), not video pixels.
        // T SDK viewResize calls userControl.resize(..., true):
        // command coordinates are in the rotated control plane.
        x: relY,
        y: 1 - relX,
      };
    }

    _bindPointerEvents(el) {
      const sendTouch = (action, e) => {
        const pt = this._mapCoords(e.clientX, e.clientY);
        if (!this.controlReady) return;
        this.touch(CMD_ACTION_TOUCH, {
          action,
          actionIndex: 0,
          count: 1,
          points: [{ x: pt.x, y: pt.y, pId: 0 }],
        });
      };

      el.style.pointerEvents = 'auto';
      el.addEventListener('contextmenu', e => e.preventDefault());
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        this.pointerDown = true;
        sendTouch(0, e); // STATUS_DOWN
      });

      el.addEventListener('pointermove', (e) => {
        if (!this.pointerDown) return;
        e.preventDefault();
        sendTouch(2, e); // STATUS_MOVE
      });

      const upHandler = (e) => {
        if (!this.pointerDown) return;
        e.preventDefault();
        this.pointerDown = false;
        sendTouch(1, e); // STATUS_UP
      };
      el.addEventListener('pointerup', upHandler);
      el.addEventListener('pointercancel', upHandler);
    }

    emitHome() {
      this.touch(CMD_ACTION_SHELL, '3');
    }

    emitBack() {
      this.touch(CMD_ACTION_SHELL, '4');
    }

    emitAppSwitch() {
      this.touch(CMD_ACTION_SHELL, '187');
    }

    sendText(text) {
      if (!text) return;
      this.cmd(CMD_ACTION_IME_INPUT_TEXT, String(text));
    }

    getDiagnostics() {
      return { controlReady: this.controlReady, controlPacketsSent: this.controlPacketsSent, secureContext: window.isSecureContext, rtc: this.rtcWs?.readyState,
        cmd: this.cmdWs?.readyState, connection: this.pc?.connectionState,
        ice: this.pc?.iceConnectionState, videoWidth: this.videoEl?.videoWidth,
        videoHeight: this.videoEl?.videoHeight, currentTime: this.videoEl?.currentTime };
    }

    setMuted(muted) {
      this.isMuted = Boolean(muted);
      if (this.videoEl) {
        this.videoEl.muted = this.isMuted;
      }
    }

    destroy() {
      this.destroyed = true;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.statsTimer) clearInterval(this.statsTimer);
      try {
        if (this.cmdWs) this.cmdWs.close(1000);
      } catch (_) {}
      try {
        if (this.rtcWs) this.rtcWs.close(1000);
      } catch (_) {}
      try {
        if (this.pc) this.pc.close();
      } catch (_) {}
      if (this.container) this.container.innerHTML = '';
    }
  }

  global.TCloudWebPlayer = TCloudWebPlayer;
})(window);
