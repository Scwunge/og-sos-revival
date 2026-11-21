// Live check that a player can be seated into a listed server through the client mod's join hint.
//   node tools/community_join_check.js <backend ip:port> [server id]
// Logs in a throwaway Classic account (no Steam id), lists GET /servers, posts the join hint for the given server (default:
// the first community server), then find-session over /ws and prints the session it was seated in (address handed to the
// player). Leaves the session again at the end. Exit 0 when seated in the requested server.
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');

const [HOST, PORT] = (process.argv[2] || '127.0.0.1:7781').split(':');
const WANT = process.argv[3] || '';

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const r = http.request({ host: HOST, port: Number(PORT), path: p, method, timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'app-id': 'sostest', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject); r.end(data);
  });
}

function wsConnect(token) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(PORT), HOST);
    let buf = Buffer.alloc(0), shook = false;
    const msgs = [], waiters = [];
    const api = {
      send(type, data) {
        const payload = Buffer.from(JSON.stringify(data === undefined ? { type } : { type, data }));
        const mask = crypto.randomBytes(4), len = payload.length;
        const head = len < 126 ? Buffer.from([0x81, 0x80 | len]) : Buffer.from([0x81, 0x80 | 126, len >> 8, len & 255]);
        sock.write(Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]));
      },
      next(type, ms = 8000) {
        return new Promise((res, rej) => {
          const check = () => {
            while (msgs.length) { const m = msgs.shift(); if (m.type === type) { done(); return res(m); } if (m.type === 'nak') { done(); return rej(new Error(`nak ${JSON.stringify(m.data)}`)); } }
          };
          const t = setTimeout(() => { done(); rej(new Error(`timeout waiting for ${type}`)); }, ms);
          const done = () => { clearTimeout(t); waiters.splice(waiters.indexOf(check), 1); };
          waiters.push(check); check();
        });
      },
      close() { sock.end(); sock.destroy(); },
    };
    sock.on('error', reject);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!shook) {
        const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
        const status = Number(buf.subarray(0, i).toString().split(' ')[1]);
        buf = buf.subarray(i + 4); shook = true;
        if (status !== 101) return reject(new Error(`ws handshake HTTP ${status}`));
        resolve(api);
      }
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) return;
        const op = buf[0] & 0x0f, payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 1) { msgs.push(JSON.parse(payload.toString())); for (const w of waiters.slice()) w(); }
      }
    });
    sock.write(`GET /ws HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: wss,ws\r\n` +
      `Authorization: Token ${token}\r\napp-id: sostest\r\n\r\n`);
  });
}

(async () => {
  const list = (await req('GET', '/servers')).json.servers || [];
  console.log(`GET /servers: ${list.map((s) => `${s.name}${s.community ? ' [community]' : ''} ${s.state} ${s.players}/${s.maxPlayers}`).join(' | ') || '(empty)'}`);
  const target = WANT ? list.find((s) => s.id === WANT) : list.find((s) => s.community);
  if (!target) throw new Error('target server not in the list');
  const login = await req('POST', '/api/access-token/steam', { 'steam-app-id': '802240', 'steam-id': '', 'session-auth-token': crypto.randomBytes(8).toString('hex'), 'app-id': 'sostest' });
  const jwt = login.json && login.json['access-token'];
  if (!jwt) throw new Error(`login failed: HTTP ${login.status}`);
  const hint = await req('POST', `/api/servers/${encodeURIComponent(target.id)}/join-hint`, {}, { Authorization: `Bearer ${jwt}` });
  console.log(`join-hint: HTTP ${hint.status} ${JSON.stringify(hint.json)}`);
  if (hint.status !== 200) throw new Error('join hint refused');
  const ws = await wsConnect(jwt);
  await ws.next('ready');
  ws.send('find-session', { opts: { 'game-mode': '', map: '' } });
  await ws.next('ack');
  const s = (await ws.next('session')).data.session;
  console.log(`seated: session ${s.id === target.id ? '= target' : `${s.id} (NOT the target)`}, address handed to player ${s.host}:${s.port}, players ${Object.keys(s['player-map']).length}`);
  const after = ((await req('GET', '/servers')).json.servers || []).find((x) => x.id === target.id);
  console.log(`listing after seat: ${after ? `${after.state} ${after.players}/${after.maxPlayers}` : 'gone'}`);
  ws.send('leave-session', { 'session-id': s.id });
  await ws.next('ack');
  ws.close();
  console.log(s.id === target.id && `${s.host}:${s.port}` === target.address ? 'OK' : 'MISMATCH');
  process.exit(s.id === target.id ? 0 : 1);
})().catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
