// Post-deploy smoke test for a live Classic backend (no queueing, so no lobby is touched):
//   node tools/smoke_test.js <ipv4|host> <port> [expectedLobbies=3]
// Checks /servers (lobbies online), KV live revision, a Classic Steam login (test account
// 76561190000000042), the account fetch, and the matchmaking WebSocket handshake ("ready").
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');

const HOST = process.argv[2] || '127.0.0.1';
const PORT = Number(process.argv[3] || 7781);
const WANT = Number(process.argv[4] || 3);
function login(steamId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ 'steam-app-id': '802240', 'steam-id': steamId, 'session-auth-token': 'x', 'app-id': 'sostest' });
    const req = http.request({ host: HOST, port: PORT, path: '/api/access-token/steam', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d));
      res.on('end', () => { try { resolve(JSON.parse(s)['access-token']); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end(body);
  });
}

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

function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: HOST, port: PORT, path: p, headers }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, body: s }));
    }).on('error', reject);
  });
}
const assert = (c, m) => { if (!c) throw new Error(m); };
(async () => {
  const sv = JSON.parse((await get('/servers?local=1')).body).servers.filter((s) => s.game === 'classic');
  const on = sv.filter((s) => s.online).length;
  console.log('lobbies:', sv.map((s) => `${s.name} ${s.address} ${s.state} online=${s.online} players=${s.players} min=${s.minPlayers}`).join(' | '));
  assert(on >= WANT, `${on}/${WANT} lobbies online`);
  console.log(`PASS  ${on} lobbies online`);
  const rev = await get('/kv/live-rev.txt', { 'app-id': 'sostest' });
  assert(rev.status === 200 && rev.body.trim(), 'kv live-rev ' + rev.status);
  console.log(`PASS  kv live-rev ${rev.body.trim()}`);
  const tok = await login('76561190000000042');
  assert(tok && tok.split('.').length === 3, 'login gave no JWT');
  console.log('PASS  Classic Steam login');
  const acc = await get('/api/account/76561190000000042', { Authorization: `Token ${tok}`, 'app-id': 'sostest' });
  assert(acc.status === 200 && JSON.parse(acc.body).identities, 'account ' + acc.status);
  console.log('PASS  account fetch');
  const r = await Ws.connect(tok);
  assert(r.status === 101, 'ws ' + r.status);
  await r.ws.next('ready', 5000);
  r.ws.close();
  console.log('PASS  matchmaking WebSocket ready');
  console.log('ALL OK');
  process.exit(0);
})().catch((e) => { console.error('FAIL ', e.message); process.exit(1); });
