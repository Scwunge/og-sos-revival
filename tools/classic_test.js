// Classic-specific checks (docs/CLASSIC.md) against a running server: node tools/classic_test.js <port>
// Run tools/mm_test.js too; this covers login roles, per-app KV, separate queues and custom matches.
'use strict';
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const PORT = Number(process.argv[2] || 7791);
const assert = (c, m) => { if (!c) throw new Error(m); };

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
async function login(steamId, appId) {
  const r = await req('POST', '/api/access-token/steam', JSON.stringify({ 'steam-app-id': appId === 'sostest' ? '802240' : '619080', 'steam-id': steamId, 'session-auth-token': 'x', 'app-id': appId }));
  return JSON.parse(r.body);
}
function ws(token) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    const msgs = []; let buf = Buffer.alloc(0); let up = false;
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!up) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; up = true; buf = buf.subarray(i + 4); resolve(api); }
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) return;
        msgs.push(JSON.parse(buf.subarray(off, off + len).toString())); buf = buf.subarray(off + len);
      }
    });
    const api = {
      msgs,
      send(o) {
        const p = Buffer.from(JSON.stringify(o)); const mask = crypto.randomBytes(4);
        const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]);
        s.write(Buffer.concat([head, mask, Buffer.from(p.map((b, i) => b ^ mask[i % 4]))]));
      },
      close() { s.destroy(); },
    };
    s.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: wss,ws\r\nAuthorization: Token ${token}\r\n\r\n`);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await login('76561190000000101', 'sostest');
  const claims = JSON.parse(Buffer.from(c['access-token'].split('.')[1], 'base64url'));
  assert(claims['app-id'] === 'sostest', 'app-id ' + claims['app-id']);
  for (const r of ['app-user', 'user', 'testserver']) assert(claims.roles.includes(r) && c.roles.includes(r), 'missing role ' + r);
  console.log('PASS  classic login: app-id sostest, roles', claims.roles.join(' '));

  const m = await login('76561190000000102', 'sos');
  const mc = JSON.parse(Buffer.from(m['access-token'].split('.')[1], 'base64url'));
  assert(mc['app-id'] === 'sos' && !mc.roles.includes('testserver') && m.roles === undefined, 'main login changed');
  console.log('PASS  main login unchanged:', mc.roles.join(' '));

  const kc = await req('GET', '/kv/runtime-1.json', null, { 'app-id': 'sostest' });
  assert(kc.status === 200 && JSON.parse(kc.body).UE_CLIENT_TEST_SERVER_ENABLED === true, 'classic kv ' + kc.status);
  const km = await req('GET', '/kv/runtime-1.json', null, { 'app-id': 'sos' });
  assert(km.status === 200 && JSON.parse(km.body).UE_CLIENT_TEST_SERVER_ENABLED === undefined, 'main kv got classic keys');
  const kt = await req('GET', '/kv/..%2fdb.json', null, { 'app-id': 'sostest' });
  assert(kt.status === 404, 'traversal ' + kt.status);
  console.log('PASS  kv: classic gets data/kv-classic, main gets data/kv, no traversal');

  // Separate queues: a classic and a main player queueing together must not share a session.
  const a = await ws(c['access-token']); const b = await ws(m['access-token']);
  await wait(200);
  a.send({ type: 'find-session', data: { opts: { 'game-mode': '', map: '' } } });
  b.send({ type: 'find-session', data: { opts: { 'game-mode': 'solo', map: 'LaCuna/LaCuna_BR' } } });
  await wait(1500);
  const sa = a.msgs.find((x) => x.type === 'session'), sb = b.msgs.find((x) => x.type === 'session');
  assert(sa && sb, 'no session: ' + JSON.stringify([a.msgs, b.msgs]));
  assert(sa.data.session.id !== sb.data.session.id, 'classic and main share a session');
  assert(!sa.data.session['player-map'][m['user-id']] && !sb.data.session['player-map'][c['user-id']], 'cross-app players');
  console.log('PASS  classic and main queues are separate');

  // Custom match flow: create-session (solo, LaCuna) -> start-session -> session-started.
  a.msgs.length = 0;
  a.send({ type: 'create-session', data: { name: 'c', opts: { 'game-mode': 'solo', map: 'LaCuna' } } });
  await wait(200);
  const cs = a.msgs.find((x) => x.type === 'session');
  assert(cs && cs.data.session.opts.map === 'LaCuna', 'create-session ' + JSON.stringify(a.msgs));
  a.send({ type: 'start-session', data: { 'session-id': cs.data.session.id } });
  await wait(200);
  assert(a.msgs.some((x) => x.type === 'session-started'), 'no session-started');
  console.log('PASS  classic custom match create/start');
  a.close(); b.close();
  console.log('\nall classic checks passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL ', e.message); process.exit(1); });
