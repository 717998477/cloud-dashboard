'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');

/**
 * Zero-dependency RFC 6455 WebSocket client supporting custom headers, TLS,
 * text/binary frames, ping/pong frames, and clean teardown.
 */
class RawWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(urlStr, options = {}) {
    super();
    this.url = new URL(urlStr);
    this.options = options;
    this.readyState = RawWebSocket.CONNECTING;
    this._socket = null;
    this._req = null;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;
    this._closedEmitted = false;
    this._connect();
  }

  _connect() {
    const isSecure = this.url.protocol === 'wss:' || this.url.protocol === 'https:';
    const mod = isSecure ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const port = this.url.port ? Number(this.url.port) : (isSecure ? 443 : 80);
    const pathWithQuery = (this.url.pathname || '/') + (this.url.search || '');

    const headers = {
      Host: this.url.host,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      Origin: this.options.origin || 'https://cloudphoneh5.buy.139.com',
      'User-Agent':
        this.options.userAgent ||
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      ...(this.options.headers || {}),
    };

    const req = mod.request({
      hostname: this.url.hostname,
      port,
      path: pathWithQuery,
      method: 'GET',
      headers,
      timeout: this.options.timeout || 15000,
      rejectUnauthorized: this.options.rejectUnauthorized !== false,
    });
    this._req = req;

    req.on('upgrade', (res, socket, head) => {
      const expectedAccept = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      if (res.headers['sec-websocket-accept'] !== expectedAccept) {
        socket.destroy();
        this._fail(new Error('Invalid Sec-WebSocket-Accept header'));
        return;
      }

      this._socket = socket;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 15000);
      this.readyState = RawWebSocket.OPEN;

      if (head && head.length > 0) {
        this._buffer = Buffer.concat([this._buffer, head]);
      }

      socket.on('data', (chunk) => {
        this._buffer = Buffer.concat([this._buffer, chunk]);
        this._drainFrames();
      });

      socket.on('error', (err) => {
        this._fail(err);
      });

      socket.on('close', () => {
        this._emitClose(1006, 'Socket closed');
      });

      this.emit('open');
      if (this._buffer.length > 0) {
        this._drainFrames();
      }
    });

    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (body.length < 512) body += c;
      });
      res.on('end', () => {
        this._fail(new Error(`Unexpected HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('WebSocket handshake timeout'));
    });

    req.on('error', (err) => {
      this._fail(err);
    });

    req.end();
  }

  _drainFrames() {
    while (this._buffer.length >= 2) {
      const first = this._buffer[0];
      const second = this._buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLen = second & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        const bigLen = this._buffer.readBigUInt64BE(2);
        payloadLen = Number(bigLen);
        offset = 10;
      }

      let maskKey = null;
      if (masked) {
        if (this._buffer.length < offset + 4) return;
        maskKey = this._buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this._buffer.length < offset + payloadLen) return;

      const payload = Buffer.from(this._buffer.subarray(offset, offset + payloadLen));
      this._buffer = this._buffer.subarray(offset + payloadLen);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x8) {
        // Close frame
        let code = 1000;
        let reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString('utf8');
        }
        if (this.readyState === RawWebSocket.OPEN) {
          this.readyState = RawWebSocket.CLOSING;
          try {
            const reply = Buffer.alloc(2);
            reply.writeUInt16BE(code, 0);
            this._writeFrame(0x8, reply);
          } catch (_) {}
        }
        if (this._socket) this._socket.end();
        this._emitClose(code, reason);
        return;
      } else if (opcode === 0x9) {
        // Ping -> Pong
        if (this.readyState === RawWebSocket.OPEN) {
          this._writeFrame(0xA, payload);
        }
        this.emit('ping', payload);
      } else if (opcode === 0xA) {
        this.emit('pong', payload);
      } else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) {
          this._fragmentOpcode = opcode;
          this._fragments = [payload];
        } else {
          this._fragments.push(payload);
        }
        if (fin) {
          const full = Buffer.concat(this._fragments);
          const msgOpcode = this._fragmentOpcode;
          this._fragments = [];
          this._fragmentOpcode = 0;
          if (msgOpcode === 0x1) {
            this.emit('message', full.toString('utf8'), false);
          } else {
            this.emit('message', full, true);
          }
        }
      }
    }
  }

  _writeFrame(opcode, dataBuf) {
    if (!this._socket || this._socket.destroyed) return false;
    const len = dataBuf.length;
    let headerLen = 2;
    if (len >= 126 && len < 65536) headerLen = 4;
    else if (len >= 65536) headerLen = 10;

    const frame = Buffer.allocUnsafe(headerLen + 4 + len);
    frame[0] = 0x80 | (opcode & 0x0f);
    let offset = 2;
    if (len < 126) {
      frame[1] = 0x80 | len;
    } else if (len < 65536) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(len, 2);
      offset = 4;
    } else {
      frame[1] = 0x80 | 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
      offset = 10;
    }

    const mask = crypto.randomBytes(4);
    mask.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      frame[offset + i] = dataBuf[i] ^ mask[i & 3];
    }
    this._socket.write(frame);
    return true;
  }

  send(data) {
    if (this.readyState !== RawWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
      return this._writeFrame(0x2, Buffer.from(data));
    }
    return this._writeFrame(0x1, Buffer.from(String(data), 'utf8'));
  }

  ping(data = '') {
    if (this.readyState === RawWebSocket.OPEN) {
      this._writeFrame(0x9, Buffer.from(data));
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === RawWebSocket.CLOSED || this.readyState === RawWebSocket.CLOSING) return;
    this.readyState = RawWebSocket.CLOSING;
    if (this._req && !this._socket) {
      this._req.destroy();
      this._emitClose(code, reason);
      return;
    }
    try {
      const reasonBuf = Buffer.from(String(reason), 'utf8');
      const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      this._writeFrame(0x8, payload);
    } catch (_) {}
    const sock = this._socket;
    setTimeout(() => {
      if (sock && !sock.destroyed) sock.destroy();
    }, 1500).unref?.();
  }

  _fail(err) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
    if (this._socket && !this._socket.destroyed) {
      this._socket.destroy();
    }
    this._emitClose(1006, err.message || 'WebSocket error');
  }

  _emitClose(code, reason) {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this.readyState = RawWebSocket.CLOSED;
    this.emit('close', code, reason);
  }
}

/**
 * Engine.IO v3 + Socket.IO v2 client tailored for CMCC CloudPhone (Yun platformType=1)
 * signaling gateway (`cloudphone-client-1.2.36.8.js` compatible).
 */
class EngineIoV3Socket extends EventEmitter {
  constructor(signalingUrl, queryParams = {}, options = {}) {
    super();
    this.signalingUrl = signalingUrl;
    this.queryParams = queryParams;
    this.options = options;
    this.ws = null;
    this.sid = null;
    this.pingInterval = 25000;
    this.pingTimeout = 60000;
    this._pingTimer = null;
    this._pongTimeoutTimer = null;
    this.connected = false;
    this.destroyed = false;
  }

  open() {
    if (this.destroyed) return;
    const u = new URL(this.signalingUrl);
    u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
    if (!u.pathname || u.pathname === '/') {
      u.pathname = '/socket.io/';
    } else if (!u.pathname.endsWith('/socket.io/')) {
      u.pathname = u.pathname.replace(/\/+$/, '') + '/socket.io/';
    }
    for (const [k, v] of Object.entries(this.queryParams)) {
      if (v !== undefined && v !== null && v !== '') {
        u.searchParams.set(k, String(v));
      }
    }
    u.searchParams.set('EIO', '3');
    u.searchParams.set('transport', 'websocket');

    this.ws = new RawWebSocket(u.toString(), this.options);

    this.ws.on('message', (data, isBinary) => {
      if (isBinary || typeof data !== 'string' || data.length === 0) return;
      const eioType = data[0];
      const payload = data.slice(1);
      if (eioType === '0') {
        // Engine.IO OPEN handshake
        try {
          const info = JSON.parse(payload);
          this.sid = info.sid;
          if (info.pingInterval) this.pingInterval = Number(info.pingInterval);
          if (info.pingTimeout) this.pingTimeout = Number(info.pingTimeout);
        } catch (_) {}
        this._schedulePing();
        this.emit('eio_open', this.sid);
      } else if (eioType === '1') {
        // Engine.IO CLOSE
        this.close();
      } else if (eioType === '2') {
        // Server ping -> reply pong '3'
        this._sendRaw('3' + payload);
      } else if (eioType === '3') {
        // Pong
        this._clearPongTimeout();
        this.emit('pong');
        this._schedulePing();
      } else if (eioType === '4') {
        // Socket.IO packet
        this._handleSioPacket(payload);
      }
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });

    this.ws.on('close', (code, reason) => {
      this.connected = false;
      this._clearTimers();
      this.emit('close', code, reason);
    });
  }

  _handleSioPacket(pkt) {
    if (!pkt) return;
    const sioType = pkt[0];
    const body = pkt.slice(1);
    if (sioType === '0') {
      // Socket.IO CONNECT
      this.connected = true;
      this.emit('connect');
    } else if (sioType === '1') {
      // Socket.IO DISCONNECT
      this.connected = false;
      this.emit('sio_disconnect');
      this.close();
    } else if (sioType === '2') {
      // Socket.IO EVENT: 42["eventName", data]
      const bracketIdx = body.indexOf('[');
      if (bracketIdx !== -1) {
        try {
          const arr = JSON.parse(body.slice(bracketIdx));
          if (Array.isArray(arr) && arr.length >= 1) {
            this.emit('event', arr[0], arr[1]);
          }
        } catch (_) {}
      }
    } else if (sioType === '4') {
      this.emit('error', new Error(`Socket.IO error: ${body}`));
    }
  }

  sendEvent(name, payload) {
    if (!this.ws || this.ws.readyState !== RawWebSocket.OPEN) return false;
    return this._sendRaw('42' + JSON.stringify([name, payload]));
  }

  _sendRaw(str) {
    if (!this.ws || this.ws.readyState !== RawWebSocket.OPEN) return false;
    try {
      this.ws.send(str);
      return true;
    } catch (_) {
      return false;
    }
  }

  _schedulePing() {
    this._clearTimers();
    if (this.destroyed) return;
    this._pingTimer = setTimeout(() => {
      if (this.destroyed || !this.ws || this.ws.readyState !== RawWebSocket.OPEN) return;
      this._sendRaw('2');
      this.emit('ping_sent');
      this._pongTimeoutTimer = setTimeout(() => {
        this.emit('error', new Error('Engine.IO pong timeout'));
        this.close();
      }, this.pingTimeout);
      this._pongTimeoutTimer.unref?.();
    }, this.pingInterval);
    this._pingTimer.unref?.();
  }

  _clearPongTimeout() {
    if (this._pongTimeoutTimer) {
      clearTimeout(this._pongTimeoutTimer);
      this._pongTimeoutTimer = null;
    }
  }

  _clearTimers() {
    if (this._pingTimer) {
      clearTimeout(this._pingTimer);
      this._pingTimer = null;
    }
    this._clearPongTimeout();
  }

  close() {
    this.destroyed = true;
    this.connected = false;
    this._clearTimers();
    if (this.ws) {
      this.ws.close(1000, 'Normal closure');
      this.ws = null;
    }
  }
}

module.exports = {
  RawWebSocket,
  EngineIoV3Socket,
};
