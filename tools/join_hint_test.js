// Join-hint check (POST /api/servers/<id>/join-hint, used by the client mod's server list). Starts its own backend.
//   node tools/join_hint_test.js [port]     (default 7796; needs nothing else running on that port)
// Two online, empty Classic lobbies. Player A queues with no hint and gets the first lobby (the pool's pick).
// Player B picks the SECOND lobby first, then queues: the pool alone would seat B with A (fullest open
// lobby), so landing in the second lobby proves the hint. Also checks 401 (no token) and 404 (unknown lobby).
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.argv[2] || 7796);
const L1 = { id: '11111111-0000-4000-8000-000000000001', token: 'tok-l1', port: 7777 };
const L2 = { id: '11111111-0000-4000-8000-000000000002', token: 'tok-l2', port: 7778 };
const assert = (c, m) => { if (!c) throw new Error(m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const r = http.request({ host: HOST, port: PORT, path: p, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'app-id': 'sostest', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject); r.end(data);
  });
}
const login = async (steamId) => (await req('POST', '/api/access-token/steam',
  { 'steam-app-id': '802240', 'steam-id': steamId, 'session-auth-token': 'x', 'app-id': 'sostest' })).json['access-token'];

// Minimal WebSocket client: handshake + masked text frames.
class Ws {
  static connect(token) {
    return new Promise((resolve) => {
      const sock = net.connect(PORT, HOST);
      const ws = new Ws(sock);
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(`GET /ws HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: wss,ws\r\n` +
        (token ? `Authorization: Token ${token}\r\n` : '') + 'app-id: sostest\r\n\r\n');
      ws.onHandshake = (status, headers) => resolve({ ws, status, headers });
      sock.on('error', () => {});
    });
  }
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.shook = false; this.msgs = []; this.waiters = [];
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
  }
  pump() {
    if (!this.shook) {
      const i = this.buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = this.buf.subarray(0, i).toString();
      this.buf = this.buf.subarray(i + 4);
      this.shook = true;
      const lines = head.split('\r\n');
      const headers = {};
      for (const l of lines.slice(1)) { const k = l.indexOf(':'); headers[l.slice(0, k).toLowerCase()] = l.slice(k + 1).trim(); }
      this.onHandshake(Number(lines[0].split(' ')[1]), headers);
    }
    while (this.buf.length >= 2) {
      const opcode = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (opcode === 1) { this.msgs.push(JSON.parse(payload.toString())); this.flush(); }
    }
  }
  flush() { for (const w of this.waiters.slice()) w(); }
  send(type, data) {
    const payload = Buffer.from(JSON.stringify(data === undefined ? { type } : { type, data }));
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x81, 0x80 | len]) : Buffer.from([0x81, 0x80 | 126, len >> 8, len & 255]);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    this.sock.write(Buffer.concat([head, mask, masked]));
  }
  // Wait for the next message of `type`, discarding unrelated ones (summary) but remembering order.
  next(type, ms = 5000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        while (this.msgs.length) {
          const m = this.msgs.shift();
          if (m.type === type) { cleanup(); return resolve(m); }
          if (m.type === 'summary' || m.type === 'player-leave' || m.type === 'player-join') continue;
          cleanup(); return reject(new Error(`expected "${type}" but got ${JSON.stringify(m)}`));
        }
      };
      const t = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for "${type}"`)); }, ms);
      const cleanup = () => { clearTimeout(t); this.waiters = this.waiters.filter((w) => w !== check); };
      this.waiters.push(check); check();
    });
  }
  async req(type, data, expect) { this.send(type, data); return this.next(expect); }
  close() { try { this.sock.write(Buffer.from([0x88, 0x80, 1, 2, 3, 4])); } catch {} this.sock.end(); }
}


(async () => {
  const dir = path.join(os.tmpdir(), `ogsos_join_hint_${process.pid}`);
  const env = { ...process.env, OGSOS_STATE_DIR: dir, OGSOS_LOG_DIR: dir,
    OGSOS_CLASSIC_HOSTS: JSON.stringify([L1, L2].map((l, i) => ({ host: '127.0.0.1', port: l.port, sessionId: l.id, sessionToken: l.token, hostIds: [], name: `Lobby ${i + 1}` }))),
    OGSOS_CLASSIC_START_MIN_PLAYERS: '3' };
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js'), '--port', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
  const done = (code, msg) => { if (msg) console.log(msg); if (code) console.log('--- backend output ---\n' + out); srv.kill(); process.exit(code); };
  try {
    for (let i = 0; i < 50; i++) { try { await req('GET', '/servers'); break; } catch { await wait(100); } }
    for (const l of [L1, L2]) assert((await req('GET', `/api/session/${l.id}`, undefined, { Authorization: `Token ${l.token}` })).status === 200, 'host poll');
    const opts = { opts: { language: 'en', map: '', 'game-mode': '', 'auto-group': false, regions: { NA: { ping: 1 } }, 'user-data': {} } };
    const queue = async (tok) => {
      const r = await Ws.connect(tok); assert(r.status === 101, 'ws ' + r.status);
      await r.ws.next('ready');
      r.ws.send('find-session', opts); await r.ws.next('ack');
      const s = await r.ws.next('session', 10000);
      return { ws: r.ws, port: s.data.session.port };
    };
    const ta = await login('76561190000000401'), tb = await login('76561190000000402');
    assert(ta && tb, 'login failed');

    let r = await req('POST', `/api/servers/${L2.id}/join-hint`, {});
    assert(r.status === 401, `no token: want 401, got ${r.status}`);
    r = await req('POST', '/api/servers/nope-1/join-hint', {}, { Authorization: `Token ${tb}` });
    assert(r.status === 404, `unknown lobby: want 404, got ${r.status}`);
    console.log('PASS  401 without a token, 404 for an unknown lobby');

    const a = await queue(ta);
    assert(a.port === L1.port, `A (no hint) went to ${a.port}, expected the pool's pick ${L1.port}`);
    console.log(`PASS  A without a hint goes to the pool's pick (port ${a.port})`);

    r = await req('POST', `/api/servers/${L2.id}/join-hint`, {}, { Authorization: `Token ${tb}` });
    assert(r.status === 200 && r.json.id === L2.id, `hint: ${r.status} ${JSON.stringify(r.json)}`);
    const b = await queue(tb);
    assert(b.port === L2.port, `B picked lobby 2 but was seated on ${b.port}`);
    console.log(`PASS  B with a hint for lobby 2 is seated there (port ${b.port}), not with A`);
    a.ws.close(); b.ws.close();
    done(0, 'ALL OK');
  } catch (e) { done(1, 'FAIL  ' + e.message); }
})();
