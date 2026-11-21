// Matchmaking smoke test (no game, no dependencies).
//   node tools/mm_test.js [port]      (default 7791; the server must already be running there)
//
// Two modes, picked by the TEST's environment (OGSOS_HOSTS set or not):
//  1. OGSOS_HOSTS unset: the regular checks against the main matchmaker (non-hosted sessions). The server must run
//     WITHOUT OGSOS_HOSTS / OGSOS_PUBLIC_HOST (the checks expect host 127.0.0.1:7777). The hosted scenario prints SKIP.
//  2. OGSOS_HOSTS set: ONLY the hosted scenario (the regular checks are skipped because HOSTS changes find-session).
//     Start the server and run this test with the same values, e.g. (bash; use a free port such as 7796):
//       export OGSOS_HOSTS='[{"host":"127.0.0.1","port":7777,"sessionId":"11111111-2222-3333-4444-555555555555","sessionToken":"test-token-1","hostIds":["76561190000000000"]}]'
//       export OGSOS_PUBLIC_HOST=203.0.113.7 OGSOS_START_MIN_PLAYERS=3 OGSOS_START_COUNTDOWN_SECONDS=1 OGSOS_TRAVEL_GRACE_SECONDS=2
//       node server/server.js --port 7796      (then, with the same env in another shell)   node tools/mm_test.js 7796
//     The scenario needs START_MIN_PLAYERS=3 and a 1-2 s countdown; OGSOS_PUBLIC_HOST is optional (clients are then
//     expected to be told the entry's own host); OGSOS_TRAVEL_GRACE_SECONDS <= 5 enables the grace-expiry check.
//     It talks to the server over 127.0.0.1 (the start/reset routes need the session token).
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || 7791);
const HOST = '127.0.0.1';

function login(steamId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ 'steam-app-id': '1', 'steam-id': steamId, 'session-auth-token': 'x', roles: ['app-user'], 'app-id': 'sos' });
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
        (token ? `Authorization: Token ${token}\r\n` : '') + 'app-id: sos\r\n\r\n');
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
          if (m.type === 'summary' || m.type === 'player-leave') continue;
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

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- hosted-session scenario (needs OGSOS_HOSTS, see the header) ----------
function httpReq(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: HOST, port: PORT, path: p, method, headers }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
function verifyHs512(jwt, key) {
  const [h, c, sg] = jwt.split('.');
  const hdr = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert(hdr.alg === 'HS512' && hdr.typ === 'JWT', 'jwt header ' + JSON.stringify(hdr));
  assert(crypto.createHmac('sha512', key).update(`${h}.${c}`).digest('base64url') === sg, 'jwt signature');
  return JSON.parse(Buffer.from(c, 'base64url').toString());
}
// take(): wait for a message of `type` anywhere in the buffer, leaving other messages alone.
Ws.prototype.take = function (type, ms = 5000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const i = this.msgs.findIndex((m) => m.type === type);
      if (i >= 0) { cleanup(); resolve(this.msgs.splice(i, 1)[0]); }
    };
    const t = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for "${type}"`)); }, ms);
    const cleanup = () => { clearTimeout(t); this.waiters = this.waiters.filter((w) => w !== check); };
    this.waiters.push(check); check();
  });
};
// Resolves if no message of `type` shows up for `ms`.
Ws.prototype.never = async function (type, ms) {
  await sleep(ms);
  assert(!this.msgs.some((m) => m.type === type), `unexpected "${type}": ${JSON.stringify(this.msgs.filter((m) => m.type === type))}`);
};

async function hostedScenario() {
  const H = HOSTS[0];
  const auth = { Authorization: `Token ${H.sessionToken}` };
  const PUB = process.env.OGSOS_PUBLIC_HOST || H.host;                       // what clients must be told
  const MIN = Number(process.env.OGSOS_START_MIN_PLAYERS || 1);
  const CD = Number(process.env.OGSOS_START_COUNTDOWN_SECONDS ?? 10) * 1000;
  const GRACE = Number(process.env.OGSOS_TRAVEL_GRACE_SECONDS ?? 300) * 1000;
  assert(MIN === 3, 'the scenario needs OGSOS_START_MIN_PLAYERS=3 (got ' + MIN + ')');
  assert(CD >= 800 && CD <= 3000, 'use OGSOS_START_COUNTDOWN_SECONDS=1 or 2');
  const get = async () => JSON.parse((await httpReq('GET', `/api/session/${H.sessionId}`, null, auth)).body);
  const post = (suffix, headers = auth) => httpReq('POST', `/api/session/${H.sessionId}${suffix}`, '{}', headers);
  const ids = ['76561190000080101', '76561190000080102', '76561190000080103', '76561190000080104', '76561190000080105'];
  const toks = []; for (const i of ids) toks.push(await login(i));
  const opts = { opts: { language: 'en', map: '', 'game-mode': '', 'auto-group': false, regions: { local: { ping: 1 } }, 'user-data': { set: 's', char: 'c', outfit: 'o', var: 'v' } } };
  const open = async (tok) => { const r = await Ws.connect(tok); assert(r.status === 101, 'ws ' + r.status); await r.ws.take('ready'); return r.ws; };
  const find = async (ws) => { ws.send('find-session', opts); await ws.take('ack'); return ws.take('session'); };

  assert((await post('/reset')).status === 200, 'initial reset');
  const hostIds = H.hostIds || [];
  const listed = async () => Object.keys((await get())['player-map']).filter((k) => !hostIds.includes(k)).sort();
  const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

  await check('hosted: empty session, min-players = START_MIN_PLAYERS, host view keeps the entry host', async () => {
    const g = await get();
    assert(g.id === H.sessionId && g.opts['min-players'] === MIN && g.host === H.host, JSON.stringify(g.opts) + g.host);
    assert((await listed()).length === 0, 'player-map not empty');
  });

  const w = []; const sess = [];
  await check('hosted: 3 staggered find-sessions share the session; no session-started before the 3rd', async () => {
    w[0] = await open(toks[0]);
    sess[0] = await find(w[0]);
    await sleep(400);
    w[1] = await open(toks[1]);
    sess[1] = await find(w[1]);
    await w[0].never('session-started', 700); await w[1].never('session-started', 10);
    for (const s of sess.slice(0, 2)) assert(s.data.session.id === H.sessionId && s.data.session.host === PUB && s.data.session.port === H.port, JSON.stringify(s.data.session));
    assert(sameSet(await listed(), ids.slice(0, 2)), 'GET lists first two');
    await w[0].take('player-join');
    const t0 = Date.now();
    w[2] = await open(toks[2]);
    sess[2] = await find(w[2]);
    assert(sess[2].data.session.id === H.sessionId, 'third session id');
    assert(!w[2].msgs.some((m) => m.type === 'session-started'), 'third got session-started early');
    // Countdown now runs; every one of the three gets session-started with the same id and the public host.
    for (const x of w) {
      const st = await x.take('session-started', CD + 3000);
      assert(st.data.id === H.sessionId && st.data.host === PUB && st.data.port === H.port, JSON.stringify(st));
    }
    const dt = Date.now() - t0;
    assert(dt >= CD * 0.7, `session-started after only ${dt}ms (countdown ${CD}ms)`);
  });

  await check('hosted: host GET lists all 3 (+hostIds); tokens distinct and verify (sub/roles/id)', async () => {
    const g = await get();
    for (const i of ids.slice(0, 3)) assert(g['player-map'][i], 'missing ' + i);
    for (const h of hostIds) assert(g['player-map'][h], 'hostId missing ' + h);
    assert(g.host === H.host, 'host view host ' + g.host);
    const claims = sess.map((s) => verifyHs512(s.data['access-token'], H.sessionToken));
    assert(new Set(sess.map((s) => s.data['access-token'])).size === 3, 'tokens not distinct');
    claims.forEach((c, n) => assert(c.sub === H.sessionId && c.roles.includes('user+session') && c.id === ids[n], 'claims ' + JSON.stringify(c)));
    assert(new Set(claims.map((c) => c.id)).size === 3, 'ids not distinct');
  });

  await check('hosted: WS close keeps the seat (grace); reconnect reattaches silently', async () => {
    w[1].close(); await sleep(600);
    assert(sameSet(await listed(), ids.slice(0, 3)), 'listed after close');
    w[1] = await open(toks[1]);
    await sleep(300);
    assert(sameSet(await listed(), ids.slice(0, 3)), 'listed after reconnect');
    assert(!w[1].msgs.some((m) => m.type === 'session-started' || m.type === 'session'), 'unexpected resend ' + JSON.stringify(w[1].msgs));
    w[1].send('get-session'); const gs = await w[1].take('session');
    assert(gs.data.session.id === H.sessionId && gs.data.session.host === PUB && gs.data['access-token'], 'get-session ' + JSON.stringify(gs));
    assert(!w[0].msgs.some((m) => m.type === 'player-leave'), 'others were told about the grace disconnect');
  });

  await check('hosted: join in progress gets session + session-started at once', async () => {
    w[3] = await open(toks[3]);
    const s = await find(w[3]);
    const st = await w[3].take('session-started', 1500);
    assert(s.data.session.id === H.sessionId && st.data.id === H.sessionId && st.data.host === PUB, 'late join');
    assert(sameSet(await listed(), ids.slice(0, 4)), 'listed 4');
  });

  if (GRACE <= 5000) {
    await check(`hosted: seat is released after the grace (${GRACE} ms)`, async () => {
      w[3].close(); await sleep(GRACE / 2);
      assert((await listed()).includes(ids[3]), 'removed too early');
      await sleep(GRACE / 2 + 1500);
      assert(!(await listed()).includes(ids[3]), 'still listed after grace');
      await w[0].take('player-leave', 1000);
    });
  } else console.log('SKIP  grace expiry (set OGSOS_TRAVEL_GRACE_SECONDS<=5)');

  await check('hosted: explicit leave-session removes at once; reset clears players and the started flag', async () => {
    w[2].send('leave-session', { 'session-id': H.sessionId }); await w[2].take('ack');
    assert(sameSet(await listed(), ids.slice(0, 2)), 'listed after leave');
    const r = await post('/reset');
    assert(r.status === 200 && JSON.parse(r.body).result === true, 'reset ' + r.status + r.body);
    assert((await listed()).length === 0, 'player-map not cleared');
    await w[0].take('session-closed', 1500);
    for (const h of hostIds) assert((await get())['player-map'][h], 'hostId dropped after reset');
  });

  await check('hosted: force start works on a reset session with 1 player; auth enforced on the host routes', async () => {
    const e = await open(toks[4]);
    await find(e);
    await e.never('session-started', 600);
    const bad = await httpReq('POST', `/api/session/${H.sessionId}/events`, '{}', { Authorization: 'Token nope' });
    assert(bad.status === 401, 'events with wrong token ' + bad.status);
    const ev = await post('/events'); assert(ev.status === 200 && JSON.parse(ev.body).result === true, 'events');
    const r = await post('/start');
    const j = JSON.parse(r.body);
    assert(r.status === 200 && j.result === true && j.players === 1, 'start ' + r.body);
    const st = await e.take('session-started', 1500);
    assert(st.data.id === H.sessionId && st.data.host === PUB, JSON.stringify(st));
    assert((await httpReq('POST', '/api/session/99999999-0000-0000-0000-000000000000/start', '{}', auth)).status === 404, 'unknown id');
    e.close();
  });

  await check('hosted: cancel-find-session below the minimum cancels the countdown', async () => {
    await post('/reset');
    await get();   // a reset lobby is offline until the host polls again (HOST_ONLINE_SECONDS gating)
    const x = []; for (let i = 0; i < 3; i++) { x[i] = await open(toks[i]); await find(x[i]); }
    x[2].send('cancel-find-session'); await x[2].take('ack');
    await x[0].never('session-started', CD + 800);
    assert(sameSet(await listed(), ids.slice(0, 2)), 'cancel should have removed the third');
    x.forEach((c) => c.close());
    await post('/reset');
  });

  w.forEach((c) => c && c.close());
}

let HOSTS = null;
try { HOSTS = JSON.parse(process.env.OGSOS_HOSTS || 'null'); } catch { /* unset */ }
if (Array.isArray(HOSTS) && !HOSTS.length) HOSTS = null;

(async () => {
  if (HOSTS) {
    await hostedScenario();
    console.log('SKIP  non-hosted checks (OGSOS_HOSTS is set)');
    console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
    process.exit(failed ? 1 : 0);
  }
  console.log('SKIP  hosted scenario (OGSOS_HOSTS not set in the test environment)');
  const idA = '76561190000080001', idB = '76561190000080002';
  const tokA = await login(idA), tokB = await login(idB);
  const opts = { opts: { language: 'en', map: '', 'game-mode': 'Deathmatch', 'auto-group': false, regions: { local: { ping: 1 } }, 'user-data': { set: 's', char: 'c', outfit: 'o', var: 'v' } } };
  let a, b;

  await check('bad token is refused (HTTP 401)', async () => {
    const bad = await Ws.connect('not.a.token'); assert(bad.status === 401, `status ${bad.status}`); bad.ws.close();
    const none = await Ws.connect(null); assert(none.status === 401, `status ${none.status}`); none.ws.close();
  });

  await check('valid token upgrades, subprotocol echoed', async () => {
    const r = await Ws.connect(tokA); a = r.ws;
    assert(r.status === 101, `status ${r.status}`);
    assert(r.headers['sec-websocket-protocol'] === 'wss,ws', 'subprotocol ' + r.headers['sec-websocket-protocol']);
  });

  await check('ready arrives first', async () => {
    // The first message in the buffer must be `ready` (before anything is requested).
    for (let i = 0; i < 50 && !a.msgs.length; i++) await sleep(20);
    assert(a.msgs[0] && a.msgs[0].type === 'ready', JSON.stringify(a.msgs[0]));
    a.msgs.shift();
  });

  await check('ping -> pong', async () => { await a.req('ping', undefined, 'pong'); });

  await check('get-regions -> regions', async () => {
    const m = await a.req('get-regions', undefined, 'regions');
    const keys = Object.keys(m.data);
    assert(keys.length === 1, 'one region expected');
    assert(typeof m.data[keys[0]]['beacon-url'] === 'string' && m.data[keys[0]]['beacon-url'], 'beacon-url');
  });

  await check('create-group -> group, get-group, leave-all-groups', async () => {
    const m = await a.req('create-group', { opts: opts.opts, 'group-opts': { map: '', language: 'en', 'group-type': 'squad', 'game-mode': 'Deathmatch', 'auto-group': false } }, 'group');
    const g = m.data.group;
    assert(g.id && g['owner-id'] === idA && g.players[idA] && g.players[idA].user.uname, JSON.stringify(g));
    assert(g.players[idA].opts.char === 'c', 'user-data kept');
    const g2 = await a.req('get-group', undefined, 'group'); assert(g2.data.group.id === g.id, 'get-group id');
    const left = await a.req('leave-all-groups', undefined, 'ack'); assert(left.type === 'ack', 'leave-all-groups acks');
  });

  await check('unknown request -> nak not-found', async () => {
    const m = await a.req('bogus-type', {}, 'nak'); assert(m.data.error === 'not-found', JSON.stringify(m));
  });

  await check('find-session -> ack, session (host filled, hyphenated id), session-started', async () => {
    await a.req('find-session', opts, 'ack');
    const s = await a.next('session');
    assert(s.data.session.id && s.data.session.id.includes('-') && s.data.session.host === '127.0.0.1' && s.data.session.port === 7777 && s.data['access-token'], JSON.stringify(s));
    assert(s.data.session['player-map'][idA], 'player in player-map');
    const st = await a.next('session-started');
    assert(st.data.id === s.data.session.id, 'id matches');
    assert(/^\d+\.\d+\.\d+\.\d+$/.test(st.data.host) && Number.isInteger(st.data.port), JSON.stringify(st));
    a.sessionId = st.data.id;
  });

  await check('second client joins the same session; first gets player-join', async () => {
    const r = await Ws.connect(tokB); b = r.ws;
    await b.next('ready');
    await b.req('find-session', opts, 'ack');
    const s = await b.next('session'); assert(s.data.session.id === a.sessionId, 'same session id');
    const st = await b.next('session-started'); assert(st.data.id === a.sessionId, 'session-started id');
    const pj = await a.next('player-join');
    assert(pj.data['player-id'] === idB && pj.data.id === a.sessionId && pj.data.uname, JSON.stringify(pj));
  });

  await check('two clients queued at the same time share one session', async () => {
    const c1 = (await Ws.connect(await login('76561190000080011'))).ws, c2 = (await Ws.connect(await login('76561190000080012'))).ws;
    await c1.next('ready'); await c2.next('ready');
    // Leave the first match so we are not placed in an open session.
    await a.req('leave-session', { 'session-id': a.sessionId }, 'ack'); await b.req('leave-session', { 'session-id': a.sessionId }, 'ack');
    await sleep(100);
    c1.send('find-session', opts); c2.send('find-session', opts);
    await c1.next('ack'); await c2.next('ack');
    const s1 = await c1.next('session'), s2 = await c2.next('session');
    assert(s1.data.session.id === s2.data.session.id, 'same id');
    assert(Object.keys(s1.data.session['player-map']).length === 2, 'two players in map');
    c1.close(); c2.close(); await sleep(300);
  });

  await check('cancel-find-session -> ack, and no session follows', async () => {
    const cfg = (await Ws.connect(await login('76561190000080021'))).ws; await cfg.next('ready');
    // Expire open sessions' late-join so the player really queues is not needed: just cancel immediately.
    cfg.send('find-session', opts); cfg.send('cancel-find-session');
    await cfg.next('ack'); await cfg.next('ack');
    await sleep(700);
    assert(!cfg.msgs.filter((m) => m.type !== 'summary').length, 'unexpected: ' + JSON.stringify(cfg.msgs));
    cfg.close(); await sleep(300);
  });

  await check('group-find-session -> ack; cancel -> ack; member gets queue-cancel event', async () => {
    const g1 = (await Ws.connect(await login('76561190000080031'))).ws, g2 = (await Ws.connect(await login('76561190000080032'))).ws;
    await g1.next('ready'); await g2.next('ready');
    const grp = (await g1.req('create-group', { opts: opts.opts, 'group-opts': { 'game-mode': 'Deathmatch' } }, 'group')).data.group;
    const j = await g2.req('join-group', { 'group-id': grp.id, opts: opts.opts }, 'group');
    assert(Object.keys(j.data.group.players).length === 2, 'two players');
    const ev = await g1.next('group-event'); assert(ev.data.event === 'join' && ev.data['player-id'] === '76561190000080032', JSON.stringify(ev));
    // Fill/expire nothing: cancel quickly, before the batch timer fires.
    g1.send('group-find-session', { opts: {} }); g1.send('cancel-group-find-session');
    await g1.next('ack'); await g1.next('ack');
    const q = await g2.next('group-event'); assert(q.data.event === 'queue', JSON.stringify(q));
    const qc = await g2.next('group-event'); assert(qc.data.event === 'queue-cancel', JSON.stringify(qc));
    await g1.req('leave-group', { 'group-id': grp.id }, 'group');
    const d = await g2.next('group-event'); assert(d.data.event === 'destroy', 'owner leaving destroys: ' + JSON.stringify(d));
    g1.close(); g2.close(); await sleep(300);
  });

  a.close(); b.close();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(2); });
