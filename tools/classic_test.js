// Classic-specific checks (docs/CLASSIC.md) against a running server: node tools/classic_test.js <port>
// Run tools/mm_test.js too; this covers login roles, per-app KV, separate queues and custom matches.
//
// Environment:
//  * Without OGSOS_CLASSIC_HOSTS in the TEST env the hosted checks print SKIP; the server needs no special env.
//  * With it, start the server with the SAME OGSOS_CLASSIC_HOSTS plus short timers, and give the test the same values:
//      OGSOS_CLASSIC_HOSTS='[{"host":"127.0.0.1","port":7777,"sessionId":"22222222-3333-4444-5555-666666666666","sessionToken":"test-token-2","hostIds":["76561190000000000"]}]'
//      OGSOS_CLASSIC_START_MIN_PLAYERS=1 OGSOS_CLASSIC_START_COUNTDOWN_SECONDS=1 OGSOS_CLASSIC_TRAVEL_GRACE_SECONDS=1
//      (and optionally OGSOS_CLASSIC_PUBLIC_HOST=203.0.113.7, also exported to the test so it expects that host in session-started)
//    Classic inherits the main START_MIN_PLAYERS (e.g. OGSOS_START_MIN_PLAYERS=3 set for mm_test), so set the CLASSIC one to 1 here.
//    The test reads the three timer values and waits accordingly (countdown + grace).
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

// Hosted-session checks need the server started with the same OGSOS_CLASSIC_HOSTS value.
let HOST = null;
try { HOST = JSON.parse(process.env.OGSOS_CLASSIC_HOSTS || 'null')?.[0] || null; } catch { /* unset */ }
const CLASSIC_PUB = process.env.OGSOS_CLASSIC_PUBLIC_HOST || '';          // optional: address clients must be handed
const CD = Number(process.env.OGSOS_CLASSIC_START_COUNTDOWN_SECONDS ?? 10) * 1000;
const GRACE = Number(process.env.OGSOS_CLASSIC_TRAVEL_GRACE_SECONDS ?? 300) * 1000;
const hostGet = (id, token) => req('GET', `/api/session/${id}`, null, token === null ? {} : { Authorization: `Token ${token}` });
function verifyHs512(jwt, key) {
  const [h, c, sg] = jwt.split('.');
  const hdr = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert(hdr.alg === 'HS512' && hdr.typ === 'JWT', 'jwt header ' + JSON.stringify(hdr));
  assert(crypto.createHmac('sha512', key).update(`${h}.${c}`).digest('base64url') === sg, 'jwt signature');
  return JSON.parse(Buffer.from(c, 'base64url').toString());
}

(async () => {
  if (HOST) {
    const r0 = await hostGet(HOST.sessionId, HOST.sessionToken);
    assert(r0.status === 200, 'initial GET ' + r0.status);
    const o0 = JSON.parse(r0.body);
    assert(o0.id === HOST.sessionId && !('data' in o0) && !('version' in o0 && o0.version === 1 && o0.data), 'not bare: ' + r0.body);
    assert(o0.owner === 'system' && o0.host === HOST.host && o0.port === HOST.port, 'host/owner ' + r0.body);
    const ids = Object.keys(o0['player-map']).sort();
    assert(JSON.stringify(ids) === JSON.stringify([...(HOST.hostIds || [])].sort()), 'initial player-map ' + ids);
    for (const k of ['opts', 'groups', 'name', 'description']) assert(k in o0, 'missing ' + k);
    assert((await hostGet(HOST.sessionId, 'wrong')).status === 401, 'wrong token not 401');
    assert((await hostGet(HOST.sessionId, null)).status === 401, 'no token not 401');
    assert((await hostGet('99999999-0000-0000-0000-000000000000', HOST.sessionToken)).status === 404, 'unknown id not 404');
    console.log('PASS  host GET /api/session/<id>: bare object with hostIds only, 401 bad token, 404 unknown id');
  } else console.log('SKIP  hosted-session checks (OGSOS_CLASSIC_HOSTS not set in the test environment)');

  const c = await login('76561190000000101', 'sostest');
  const claims = JSON.parse(Buffer.from(c['access-token'].split('.')[1], 'base64url'));
  assert(claims['app-id'] === 'sostest', 'app-id ' + claims['app-id']);
  for (const r of ['app-user', 'user', 'testserver']) assert(claims.roles.includes(r) && c.roles.includes(r), 'missing role ' + r);
  console.log('PASS  classic login: app-id sostest, roles', claims.roles.join(' '));

  const m = await login('76561190000000102', 'sos');
  const mc = JSON.parse(Buffer.from(m['access-token'].split('.')[1], 'base64url'));
  assert(mc['app-id'] === 'sos' && !mc.roles.includes('testserver') , 'main login changed');
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
  if (HOST) {
    const sid = HOST.sessionId, tok = HOST.sessionToken;
    // The earlier queue checks already seated players in the hosted session; start from a clean one.
    assert((await req('POST', `/api/session/${sid}/reset`, '{}', { Authorization: `Token ${tok}` })).status === 200, 'reset');
    await req('GET', `/api/session/${sid}`, null, { Authorization: `Token ${tok}` });   // the restarted host polls: back online
    const d = await login('76561190000000103', 'sostest');
    const dw = await ws(d['access-token']);
    await wait(200);
    dw.send({ type: 'find-session', data: { opts: { 'game-mode': '', map: '' } } });
    await wait(500);
    assert(dw.msgs.some((x) => x.type === 'session'), 'no session at once');
    if (CD > 600) assert(!dw.msgs.some((x) => x.type === 'session-started'), 'session-started before the countdown ended');
    await wait(CD + 1000);
    const ds = dw.msgs.find((x) => x.type === 'session');
    assert(ds && dw.msgs.some((x) => x.type === 'session-started'), 'hosted: no session/session-started ' + JSON.stringify(dw.msgs));
    const so = ds.data.session;
    assert(so.id === sid && so.host === (CLASSIC_PUB || HOST.host) && so.port === HOST.port, 'hosted session fields ' + JSON.stringify(so));
    assert(so.opts.map === '' && so.opts['game-mode'] === '' && so.owner === 'system', 'hosted opts/owner ' + JSON.stringify(so.opts));
    const jc = verifyHs512(ds.data['access-token'], tok);
    assert(jc.sub === sid && jc.roles.includes('user+session') && jc.id === d['user-id'], 'jwt claims ' + JSON.stringify(jc));
    const started = dw.msgs.find((x) => x.type === 'session-started');
    assert(started.data.id === sid && started.data.host === (CLASSIC_PUB || HOST.host) && started.data.port === HOST.port, 'session-started');
    console.log('PASS  hosted match: fixed session id, host/port from config, HS512 access-token verifies');

    const g1 = JSON.parse((await hostGet(sid, tok)).body);
    assert(g1['player-map'][d['user-id']], 'player not in player-map');
    for (const hid of HOST.hostIds || []) assert(g1['player-map'][hid], 'hostId dropped ' + hid);
    console.log('PASS  host GET lists joined player (and hostIds)');

    const pe = await req('POST', `/api/session/${sid}/events`, JSON.stringify({ type: 'match-start' }), { Authorization: `Token ${tok}` });
    assert(pe.status === 200 && JSON.parse(pe.body).result === true, 'events ' + pe.status + pe.body);
    assert((await req('POST', `/api/session/${sid}/events`, '{}', { Authorization: 'Token nope' })).status === 401, 'events wrong token');
    console.log('PASS  host POST events -> {"result":true}');

    dw.close();
    await wait(Math.min(300, GRACE / 3));
    const g2 = JSON.parse((await hostGet(sid, tok)).body);
    if (GRACE > 600) assert(g2['player-map'][d['user-id']], 'player removed before the travel grace expired');
    await wait(GRACE + 1200);
    const g3 = JSON.parse((await hostGet(sid, tok)).body);
    assert(!g3['player-map'][d['user-id']], 'player still listed after the travel grace');
    for (const hid of HOST.hostIds || []) assert(g3['player-map'][hid], 'hostId dropped after close');
    console.log('PASS  player kept during the travel grace after WS close, removed once it expires');

    // Explicit leave-session removes at once (no grace), and the session start flag survives for late joiners.
    const e = await login('76561190000000104', 'sostest');
    const ew = await ws(e['access-token']);
    await wait(200);
    ew.send({ type: 'find-session', data: { opts: { 'game-mode': '', map: '' } } });
    await wait(500);
    assert(ew.msgs.some((x) => x.type === 'session') && ew.msgs.some((x) => x.type === 'session-started'), 'late join: ' + JSON.stringify(ew.msgs));
    ew.send({ type: 'leave-session', data: { 'session-id': sid } });
    await wait(300);
    assert(!JSON.parse((await hostGet(sid, tok)).body)['player-map'][e['user-id']], 'still listed after leave-session');
    ew.close();
    console.log('PASS  join in progress gets session-started at once; leave-session removes immediately');
  }
  console.log('\nall classic checks passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL ', e.message); process.exit(1); });
