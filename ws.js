// ws.js — Minimal zero-dependency WebSocket implementation for Node.js.
// Supports server (accept upgrades) and client (connect outbound) roles.

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-5AB5DC65C487';

export const OPCODES = {
  CONTINUATION: 0x00,
  TEXT: 0x01,
  BINARY: 0x02,
  CLOSE: 0x08,
  PING: 0x09,
  PONG: 0x0a,
};

// ── Frame encoding ──────────────────────────────────────────────────────────

function encodeFrame(opcode, payload, masked = false, fin = true) {
  if (typeof payload === 'string') payload = Buffer.from(payload, 'utf8');
  if (!Buffer.isBuffer(payload)) payload = Buffer.alloc(0);

  const len = payload.length;
  let hdrLen = 2;
  if (len >= 65536) hdrLen += 8;
  else if (len >= 126) hdrLen += 2;
  if (masked) hdrLen += 4;

  const hdr = Buffer.alloc(hdrLen);
  hdr[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);

  let off = 2;
  if (len < 126) {
    hdr[1] = len;
  } else if (len < 65536) {
    hdr[1] = 126;
    hdr.writeUInt16BE(len, 2);
    off = 4;
  } else {
    hdr[1] = 127;
    hdr.writeUInt32BE(0, 2);
    hdr.writeUInt32BE(len, 6);
    off = 10;
  }

  if (masked) {
    hdr[1] |= 0x80;
    const mask = crypto.randomBytes(4);
    mask.copy(hdr, off);
    off += 4;
    const mp = Buffer.alloc(len);
    for (let i = 0; i < len; i++) mp[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([hdr, mp]);
  }
  return Buffer.concat([hdr, payload]);
}

// ── Frame parsing ───────────────────────────────────────────────────────────

function parseFrame(buf) {
  if (buf.length < 2) return null;

  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let pLen = buf[1] & 0x7f;
  let off = 2;

  if (pLen === 126) {
    if (buf.length < 4) return null;
    pLen = buf.readUInt16BE(2);
    off = 4;
  } else if (pLen === 127) {
    if (buf.length < 10) return null;
    if (buf.readUInt32BE(2) !== 0) return null; // >4 GB — reject
    pLen = buf.readUInt32BE(6);
    off = 10;
  }

  let maskKey = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    maskKey = buf.slice(off, off + 4);
    off += 4;
  }

  const total = off + pLen;
  if (buf.length < total) return null;

  let payload = buf.slice(off, total);
  if (masked && maskKey) {
    const u = Buffer.alloc(pLen);
    for (let i = 0; i < pLen; i++) u[i] = payload[i] ^ maskKey[i % 4];
    payload = u;
  }

  return { fin, opcode, payload, totalLength: total };
}

// ── WSConnection ────────────────────────────────────────────────────────────

export class WSConnection extends EventEmitter {
  constructor(socket, isClient) {
    super();
    this.socket = socket;
    this.isClient = isClient;
    this._buf = Buffer.alloc(0);
    this._closed = false;

    socket.on('data', (c) => this._feed(c));
    socket.on('close', () => this._handleClose());
    socket.on('error', (e) => this.emit('error', e));
    socket.on('end', () => this._handleClose());
  }

  send(data, opcode) {
    if (this._closed) return;
    if (typeof data === 'string') opcode = opcode ?? OPCODES.TEXT;
    else if (Buffer.isBuffer(data)) opcode = opcode ?? OPCODES.BINARY;
    else { data = JSON.stringify(data); opcode = OPCODES.TEXT; }
    try { this.socket.write(encodeFrame(opcode, data, this.isClient)); }
    catch (e) { this.emit('error', e); }
  }

  close(code = 1000, reason = '') {
    if (this._closed) return;
    this._closed = true;
    try {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      if (reason) body.write(reason, 2, 'utf8');
      this.socket.write(encodeFrame(OPCODES.CLOSE, body, this.isClient));
    } catch {}
    try { this.socket.end(); } catch {}
  }

  _handleClose() { if (!this._closed) { this._closed = true; this.emit('close'); } }

  _feed(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= 2) {
      const f = parseFrame(this._buf);
      if (!f) break;
      this._buf = this._buf.slice(f.totalLength);
      switch (f.opcode) {
        case OPCODES.TEXT:   this.emit('message', f.payload.toString('utf8'), false); break;
        case OPCODES.BINARY: this.emit('message', f.payload, true); break;
        case OPCODES.PING:   this.send(f.payload, OPCODES.PONG); break;
        case OPCODES.PONG:   this.emit('pong', f.payload); break;
        case OPCODES.CLOSE:  this.close(1000); break;
      }
    }
  }
}

// ── Public helpers ──────────────────────────────────────────────────────────

/** Accept an incoming HTTP Upgrade and return a WSConnection. */
export function handleUpgrade(req, socket, head) {
  return new Promise((resolve, reject) => {
    const key = req.headers['sec-websocket-key'];
    console.log('[ws] handleUpgrade called, key:', key ? key.slice(0,10)+'...' : 'MISSING');
    if (!key) { socket.destroy(); return reject(new Error('Missing Sec-WebSocket-Key')); }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    const resp = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
    console.log('[ws] writing upgrade response...');
    socket.write(resp);
    console.log('[ws] upgrade response written, creating connection');
    const conn = new WSConnection(socket, false);
    if (head?.length) conn._feed(head);
    resolve(conn);
  });
}

/** Open an outbound WebSocket connection (client role). */
export function connect(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const tls = u.protocol === 'wss:';
    const port = u.port || (tls ? 443 : 80);
    const key = crypto.randomBytes(16).toString('base64');

    const req = (tls ? https : http).request({
      hostname: u.hostname, port,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Upgrade: 'websocket', Connection: 'Upgrade',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        ...headers,
      },
    });

    req.on('upgrade', (_res, socket, head) => {
      const conn = new WSConnection(socket, true);
      if (head?.length) conn._feed(head);
      resolve(conn);
    });
    req.on('error', reject);
    req.end();
  });
}
