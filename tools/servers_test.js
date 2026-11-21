// Public server list checks (GET /servers, POST /api/session/<id>/announce, federation): no game, no dependencies.
//   node tools/servers_test.js [portA] [portB]      (defaults 7793 and 7794; both servers must already be running)
//
// Start two servers from the repo root (bash; separate state/log dirs so they do not share db.json/secret.key):
//   export A_HOSTS='[{"host":"127.0.0.1","port":7777,"sessionId":"22222222-3333-4444-5555-666666666666","sessionToken":"test-token-A","hostIds":["76561190000000000"]}]'
//   export A_MAIN='[{"host":"127.0.0.1","port":7778,"sessionId":"44444444-3333-4444-5555-666666666666","sessionToken":"test-token-M","name":"Main one","region":"NA"}]'
//   export B_HOSTS='[{"host":"127.0.0.1","port":7779,"sessionId":"33333333-3333-4444-5555-666666666666","sessionToken":"test-token-B","hostIds":[],"name":"Server B","region":"EU"}]'
//   # server A (lists B through OGSOS_DIRECTORY; Classic needs 2 players, 1 s countdown):
//   OGSOS_CLASSIC_HOSTS="$A_HOSTS" OGSOS_HOSTS="$A_MAIN" OGSOS_CLASSIC_START_MIN_PLAYERS=2 OGSOS_CLASSIC_START_COUNTDOWN_SECONDS=1 \
//   OGSOS_CLASSIC_PUBLIC_HOST=203.0.113.7 OGSOS_PUBLIC_BACKEND=127.0.0.1:7793 OGSOS_DIRECTORY='["127.0.0.1:7794"]' \
//   OGSOS_STATE_DIR=/tmp/sl_a OGSOS_LOG_DIR=/tmp/sl_a node server/server.js --port 7793
//   # server B (points back at A, to prove lists never loop):
//   OGSOS_CLASSIC_HOSTS="$B_HOSTS" OGSOS_PUBLIC_BACKEND=127.0.0.1:7794 OGSOS_DIRECTORY='["127.0.0.1:7793"]' \
//   OGSOS_STATE_DIR=/tmp/sl_b OGSOS_LOG_DIR=/tmp/sl_b node server/server.js --port 7794
//   node tools/servers_test.js 7793 7794
// Run it against freshly started servers (it expects the Classic session unpolled and empty at the start).
'use strict';
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const PA = Number(process.argv[2] || 7793), PB = Number(process.argv[3] || 7794);
const A = { id: '22222222-3333-4444-5555-666666666666', token: 'test-token-A' };
const M = { id: '44444444-3333-4444-5555-666666666666', token: 'test-token-M' };
const B = { id: '33333333-3333-4444-5555-666666666666', token: 'test-token-B' };
const assert = (c, m) => { if (!c) throw new Error(m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, body: s, headers: res.headers }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const auth = (t) => ({ Authorization: `Token ${t}` });
async function servers(port, q = '') {
  const r = await req(port, 'GET', `/servers${q}`);
  assert(r.status === 200, `GET /servers${q} on ${port}: ${r.status}`);
  return { raw: r.body, headers: r.headers, list: JSON.parse(r.body).servers };
}
async function login(steamId) {
  const r = await req(PA, 'POST', '/api/access-token/steam', JSON.stringify({ 'steam-app-id': '802240', 'steam-id': steamId, 'session-auth-token': 'x', 'app-id': 'sostest' }));
  return JSON.parse(r.body);
}
function ws(token) {
  return new Promise((resolve) => {
    const s = net.connect(PA, '127.0.0.1');
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
const find = (list, id) => list.find((x) => x.id === id);

(async () => {
  // 1. Listed, offline before any host poll.
  let r = await servers(PA, '?local=1');
  assert(r.headers['access-control-allow-origin'] === '*', 'CORS header missing');
  let a = find(r.list, A.id);
  assert(a, 'classic session not listed: ' + r.raw);
  assert(a.game === 'classic' && a.online === false && a.lastSeenSec === null, 'before poll ' + JSON.stringify(a));
  assert(a.name === 'OG SOS server' && a.region === '' && a.players === 0 && a.state === 'waiting', 'defaults ' + JSON.stringify(a));
  assert(a.minPlayers === 2 && a.maxPlayers === 16 && a.map === '', 'limits ' + JSON.stringify(a));
  assert(a.address === '203.0.113.7:7777' && a.backend === `127.0.0.1:${PA}`, 'address/backend ' + JSON.stringify(a));
  const m0 = find(r.list, M.id);
  assert(m0 && m0.game === 'main' && m0.name === 'Main one' && m0.region === 'NA' && m0.address === '127.0.0.1:7778', 'main entry ' + JSON.stringify(m0));
  assert(!find(r.list, B.id), '?local=1 must not list peers');
  console.log('PASS  GET /servers: classic + main hosted sessions listed, offline before any poll, CORS *, defaults');

  // 2. Online right after an authenticated host poll; a bad token does not count.
  assert((await req(PA, 'GET', `/api/session/${A.id}`, null, auth('wrong'))).status === 401, 'wrong token not 401');
  assert(find((await servers(PA, '?local=1')).list, A.id).online === false, 'bad poll marked online');
  assert((await req(PA, 'GET', `/api/session/${A.id}`, null, auth(A.token))).status === 200, 'host poll');
  a = find((await servers(PA, '?local=1')).list, A.id);
  assert(a.online === true && a.lastSeenSec !== null && a.lastSeenSec <= 2, 'after poll ' + JSON.stringify(a));
  console.log('PASS  online after an authenticated poll (lastSeenSec', a.lastSeenSec + '), a wrong token does not count');

  // 3. No token anywhere.
  for (const q of ['', '?local=1']) {
    const raw = (await servers(PA, q)).raw;
    for (const t of [A.token, M.token, B.token]) assert(!raw.includes(t), `token ${t} leaked in /servers${q}`);
    assert(!/token/i.test(raw), 'the word "token" appears in /servers' + q);
  }
  console.log('PASS  no session token anywhere in the /servers JSON');

  // 4. announce.
  const ann = (id, tok, body) => req(PA, 'POST', `/api/session/${id}/announce`, JSON.stringify(body), tok === null ? {} : auth(tok));
  assert((await ann(A.id, null, { name: 'hax' })).status === 401, 'announce without token not 401');
  assert((await ann(A.id, 'wrong', { name: 'hax' })).status === 401, 'announce wrong token not 401');
  assert((await ann(A.id, M.token, { name: 'hax' })).status === 401, 'announce with another session\'s token not 401');
  assert((await ann('99999999-0000-0000-0000-000000000000', A.token, { name: 'x' })).status === 404, 'unknown id not 404');
  assert(find((await servers(PA, '?local=1')).list, A.id).name === 'OG SOS server', 'unauthenticated announce changed the name');
  let ar = await ann(A.id, A.token, { name: 'Test\u0000 Arena\n\u0007', region: 'EU' });
  assert(ar.status === 200 && JSON.parse(ar.body).result === true, 'announce ' + ar.status + ar.body);
  a = find((await servers(PA, '?local=1')).list, A.id);
  assert(a.name === 'Test Arena' && a.region === 'EU', 'name/region after announce ' + JSON.stringify(a));
  await ann(A.id, A.token, { name: 'n'.repeat(100), region: 'r'.repeat(40) });
  a = find((await servers(PA, '?local=1')).list, A.id);
  assert(a.name.length === 48 && a.region.length === 16, 'length limits ' + a.name.length + '/' + a.region.length);
  await ann(A.id, A.token, { name: 'Test Arena' });
  a = find((await servers(PA, '?local=1')).list, A.id);
  assert(a.name === 'Test Arena' && a.region === 'r'.repeat(16), 'partial announce ' + JSON.stringify(a));
  console.log('PASS  announce: 401 without/with a wrong token, 404 unknown id; with the token name/region change, control chars stripped, lengths capped');

  // 5. Players and state through the WS matchmaking flow (min 2 players, 1 s countdown).
  const p1 = await login('76561190000000201'), p2 = await login('76561190000000202');
  const w1 = await ws(p1['access-token']); await wait(150);
  w1.send({ type: 'find-session', data: { opts: { 'game-mode': '', map: '' } } });
  await wait(800);
  assert(w1.msgs.some((x) => x.type === 'session'), 'player 1 not seated: ' + JSON.stringify(w1.msgs));
  a = find((await servers(PA, '?local=1')).list, A.id);
  assert(a.players === 1 && a.state === 'waiting', 'one player ' + JSON.stringify(a));
  const w2 = await ws(p2['access-token']); await wait(150);
  w2.send({ type: 'find-session', data: { opts: { 'game-mode': '', map: '' } } });
  await wait(500);
  a = find((await servers(PA, '?local=1')).list, A.id);
  assert(a.players === 2 && a.state === 'countdown', 'two players ' + JSON.stringify(a));
  await wait(1500);
  a = find((await servers(PA, '?local=1')).list, A.id);
  assert(a.players === 2 && a.state === 'started', 'after countdown ' + JSON.stringify(a));
  console.log('PASS  players 0 -> 1 -> 2 after fake clients join; state waiting -> countdown -> started');
  w1.close(); w2.close();

  // 6. Federation: A lists B once, B lists A's two once, ?local=1 never recurses.
  // B has not been polled: it is listed but offline (the list shows servers whether or not they are online).
  const fa = (await servers(PA)).list;
  const bs = fa.filter((x) => x.id === B.id);
  assert(bs.length === 1, `A should list B's session once, got ${bs.length}: ` + JSON.stringify(fa.map((x) => x.id)));
  assert(bs[0].name === 'Server B' && bs[0].region === 'EU' && bs[0].backend === `127.0.0.1:${PB}` && bs[0].address === '127.0.0.1:7779', 'B entry ' + JSON.stringify(bs[0]));
  assert(fa.filter((x) => x.id === A.id).length === 1 && fa.filter((x) => x.id === M.id).length === 1, 'own servers duplicated: ' + JSON.stringify(fa.map((x) => x.id)));
  assert(fa.length === 3, 'A total ' + fa.length);
  const fb = (await servers(PB)).list;
  assert(fb.length === 3 && [B.id, A.id, M.id].every((id) => fb.filter((x) => x.id === id).length === 1), 'B list ' + JSON.stringify(fb.map((x) => x.id)));
  assert(find(fb, A.id).name === 'Test Arena' && find(fb, A.id).backend === `127.0.0.1:${PA}`, 'A entry as seen by B ' + JSON.stringify(find(fb, A.id)));
  assert((await servers(PB, '?local=1')).list.length === 1, 'B ?local=1 should list only itself');
  for (const l of [fa, fb]) for (const t of [A.token, M.token, B.token]) assert(!JSON.stringify(l).includes(t), 'token leaked via federation');
  console.log('PASS  federation: A lists B once, B (pointing back at A) lists A once, no loop, ?local=1 stays local, no tokens');

  // 7. B's host polls: after the 15 s peer cache the online flag follows; checked only on B itself (cache-independent).
  assert((await req(PB, 'GET', `/api/session/${B.id}`, null, auth(B.token))).status === 200, 'B poll');
  assert(find((await servers(PB, '?local=1')).list, B.id).online === true, 'B not online after its poll');
  console.log('PASS  second server reports online after its own host poll');

  console.log('\nall server-list checks passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL ', e.message); process.exit(1); });
