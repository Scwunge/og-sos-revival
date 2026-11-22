// Backend hardening checks, no setup:  node tools/hardening_test.js
// Spawns its own backends (free ports, temp state and log dirs) and checks the limits and refusals described in
// docs/SECURITY.md: body caps, login validation and rate limit, WebSocket frame/rate/connection limits, log redaction,
// atomic db saves and corrupt-db handling, prototype pollution, app-data / search authorisation, stream session
// ownership and JWT validation. Test ids are 76561190000xxxxxx style; no network access beyond loopback.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http'), crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ogsos-hard-'));
const kids = [];

// ---------- helpers ----------
async function startBackend(name, env = {}, { seed } = {}) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  if (seed) seed(dir);
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js'), '--port', String(port)], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, OGSOS_STATE_DIR: dir, OGSOS_LOG_DIR: dir, OGSOS_PERSONA_DISABLE: '1', OGSOS_CLASSIC_HOSTS: '', OGSOS_HOSTS: '', ...env },
  });
  const b = { name, dir, port, proc, exited: null };
  proc.on('exit', (c) => { b.exited = c === null ? 'signal' : c; });
  kids.push(proc);
  return b;
}
async function waitUp(b) { for (let i = 0; i < 60; i++) { if (b.exited !== null) return false; if ((await req(b, 'GET', '/servers?local=1').catch(() => ({ status: 0 }))).status === 200) return true; await sleep(100); } return false; }
function req(b, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (data !== null) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: b.port, path: p, method, headers: h, agent: false }, (res) => {
      let s = ''; res.on('data', (d) => (s += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* text */ } resolve({ status: res.statusCode, headers: res.headers, body: j, text: s }); });
    });
    r.on('error', reject); r.end(data ?? undefined);
  });
}
// raw bytes in, whatever comes back out (status + text)
function raw(b, data, waitMs = 500) {
  return new Promise((resolve) => {
    const s = net.connect(b.port, '127.0.0.1'); const c = [];
    s.on('connect', () => s.write(data));
    s.on('data', (d) => c.push(d)); s.on('error', () => {});
    setTimeout(() => { s.destroy(); const t = Buffer.concat(c).toString('latin1'); resolve({ status: Number((t.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0), text: t }); }, waitMs);
  });
}
let idSeq = 0;
const newId = (tag = 0) => `76561190${String(tag).padStart(2, '0')}${String(Date.now() % 100000).padStart(5, '0')}${String(++idSeq).padStart(2, '0')}`.slice(0, 17);
async function login(b, steamId, extra = {}, headers = {}) {
  const r = await req(b, 'POST', '/api/access-token/steam', { body: { 'steam-app-id': '802240', 'steam-id': steamId, 'session-auth-token': 'x', 'app-id': 'sostest', ...extra }, headers });
  return { ...r, token: r.body && r.body['access-token'] };
}
const bearer = (t) => ({ Authorization: `Token ${t}` });

// ---------- minimal WebSocket client ----------
const maskFrame = (opcode, payload, { fin = true, mask = true, rsv = 0 } = {}) => {
  const len = payload.length;
  const head = [(fin ? 0x80 : 0) | rsv | opcode];
  if (len < 126) head.push((mask ? 0x80 : 0) | len);
  else if (len < 65536) head.push((mask ? 0x80 : 0) | 126, len >> 8, len & 255);
  else { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); head.push((mask ? 0x80 : 0) | 127, ...b); }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = crypto.randomBytes(4);
  const body = Buffer.from(payload); for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from(head), key, body]);
};
function wsConnect(b, p, headers = {}) {
  return new Promise((resolve) => {
    const s = net.connect(b.port, '127.0.0.1');
    const c = { socket: s, status: 0, msgs: [], closeCode: null, closed: false, buf: Buffer.alloc(0), head: '', open: false };
    c.pings = 0;
    c.sendText = (t) => s.write(maskFrame(1, Buffer.from(t)));
    c.sendJson = (o) => c.sendText(JSON.stringify(o));
    c.waitFor = async (pred, ms = 2500) => { const end = Date.now() + ms; while (Date.now() < end) { const m = c.msgs.find(pred); if (m) return m; await sleep(25); } return null; };
    c.waitClosed = async (ms = 2500) => { const end = Date.now() + ms; while (Date.now() < end && !c.closed) await sleep(25); return c.closed; };
    s.on('error', () => {});
    s.on('close', () => { c.closed = true; });
    s.on('connect', () => s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`));
    let headDone = false;
    s.on('data', (d) => {
      c.buf = Buffer.concat([c.buf, d]);
      if (!headDone) {
        const i = c.buf.indexOf('\r\n\r\n'); if (i < 0) return;
        c.head = c.buf.subarray(0, i).toString('latin1'); c.status = Number((c.head.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0);
        c.buf = c.buf.subarray(i + 4); headDone = true; c.open = c.status === 101;
        resolve(c);
      }
      while (c.buf.length >= 2) {
        const op = c.buf[0] & 15; let len = c.buf[1] & 0x7f, off = 2;
        if (len === 126) { if (c.buf.length < 4) break; len = c.buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (c.buf.length < 10) break; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
        if (c.buf.length < off + len) break;
        const pl = c.buf.subarray(off, off + len); c.buf = c.buf.subarray(off + len);
        if (op === 9) c.pings++;
        if (op === 8) c.closeCode = pl.length >= 2 ? pl.readUInt16BE(0) : 1005;
        else if (op === 1) { try { c.msgs.push(JSON.parse(pl.toString())); } catch { c.msgs.push({ raw: pl.toString() }); } }
      }
    });
    setTimeout(() => { if (!headDone) resolve(c); }, 3000);
  });
}

(async () => {
  // ===================== backend A: everything except rate limits =====================
  const ADMIN = '76561190000090001';
  const A = await startBackend('a', { OGSOS_RATE_LOGIN: '1000', OGSOS_RATE_WS: '500', OGSOS_MAX_WS_PER_IP: '4', OGSOS_WS_MSG_MAX: '20', OGSOS_ADMINS: ADMIN, OGSOS_ADMIN_DEV_LOGIN: '1' },
    { seed: (dir) => fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ accounts: {}, appData: {} })) });
  ok(await waitUp(A), 'backend A up');

  // ---- A1: body caps ----
  let r = await raw(A, `POST /api/log HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 70000\r\nConnection: close\r\n\r\n{"a":1}`);
  ok(r.status === 413 && /too-large/.test(r.text), 'Content-Length over 64 KB: 413 too-large before the body arrives', r.text.slice(0, 120));
  {
    // chunked: stream 80 KB in 8 KB chunks without a Content-Length
    const s = net.connect(A.port, '127.0.0.1'); const out = [];
    s.on('data', (d) => out.push(d)); s.on('error', () => {});
    await new Promise((res) => s.on('connect', res));
    s.write('POST /api/log HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n');
    for (let i = 0; i < 10 && !s.destroyed; i++) { s.write(`2000\r\n${'a'.repeat(8192)}\r\n`); await sleep(20); }
    await sleep(300); s.destroy();
    const t = Buffer.concat(out).toString('latin1');
    ok(/^HTTP\/1\.1 413/.test(t) && /too-large/.test(t), 'chunked body over 64 KB: 413 too-large');
  }
  r = await raw(A, `POST /api/community/register HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 5000\r\nConnection: close\r\n\r\n{}`);
  ok(r.status === 413, 'community register keeps its 4 KB cap (413)');
  r = await raw(A, `POST /api/account/76561190000000001/app/sostest HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 200000\r\nConnection: close\r\n\r\n{}`, 300);
  ok(r.status !== 413, 'Classic blob route allows up to 300 KB (no 413 for 200 KB)', r.status);
  r = await raw(A, `POST /api/session/abc/events HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 200000\r\nConnection: close\r\n\r\n{}`, 300);
  ok(r.status !== 413, 'match-end events route allows up to 300 KB', r.status);
  const logText = () => fs.readFileSync(path.join(A.dir, 'http.jsonl'), 'utf8');

  // ---- C1: login validation ----
  const bad = ['', 'abc', '1234', '76561190000000000000', '../../x', '__proto__', 'constructor', '7656119000000000x', '76561190000000001\nfoo'];
  let allBad = true; const badOut = [];
  for (const id of bad) { const x = await login(A, id); if (x.status !== 400 || !x.body || x.body.error !== 'bad-steam-id') { allBad = false; badOut.push([id, x.status]); } }
  ok(allBad, 'login refuses non-SteamID64 ids with 400 bad-steam-id', badOut);
  r = await req(A, 'POST', '/api/access-token/steam', { body: { hello: 'world' } });
  ok(r.status === 400, 'login without a steam-id is refused (no sha1(body) account)', r.status);
  const P1 = newId(1), P2 = newId(2), P3 = newId(3);
  const l1 = await login(A, P1, { roles: ['admin', 'dev', 'testserver'] });
  ok(l1.status === 200 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(l1.token || ''), 'valid SteamID64 logs in and gets a JWT-shaped token');
  const claims1 = JSON.parse(Buffer.from(l1.token.split('.')[1], 'base64url').toString());
  ok(!claims1.roles.includes('admin') && claims1.roles.includes('app-user'), 'client-chosen roles (admin) are ignored for Classic', claims1.roles);
  const lSos = await login(A, P2, { 'app-id': 'sos', roles: ['admin', 'user', 'app-user', 'dev'] });
  const claimsS = JSON.parse(Buffer.from(lSos.token.split('.')[1], 'base64url').toString());
  ok(JSON.stringify(claimsS.roles.sort()) === JSON.stringify(['app-user', 'user']), 'non-Classic roles are limited to app-user/user', claimsS.roles);
  const l3 = await login(A, P3);

  // ---- C2: readJwt ----
  const secret = fs.readFileSync(path.join(A.dir, 'secret.key'), 'utf8');
  ok(secret.length >= 32, 'secret.key holds at least 32 characters');
  const mk = (header, claims, key = secret, alg = 'sha256') => {
    const h = Buffer.from(JSON.stringify(header)).toString('base64url'), c = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${c}.${key === null ? '' : crypto.createHmac(alg, key).update(`${h}.${c}`).digest('base64url')}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const good = { id: P1, 'account-id': P1, sub: P1, exp: now + 600, iat: now };
  const crack = async (t) => (await req(A, 'GET', `/api/access-token/${encodeURIComponent(t)}`)).status;
  ok(await crack(mk({ alg: 'HS256', typ: 'JWT' }, good)) === 200, 'a correctly signed token is accepted');
  ok(await crack(mk({ alg: 'none' }, good, null)) === 401, 'alg none is rejected');
  ok(await crack(mk({ alg: 'none' }, good)) === 401, 'alg none with a signature is rejected');
  ok(await crack(mk({ alg: 'HS512' }, good, secret, 'sha512')) === 401, 'a different alg is rejected');
  ok(await crack(mk({ alg: 'HS256' }, { ...good, exp: now - 5 })) === 401, 'an expired token is rejected');
  ok(await crack(mk({ alg: 'HS256' }, { id: P1 })) === 401, 'a token without exp is rejected');
  ok(await crack(mk({ alg: 'HS256' }, good, 'not-the-secret-not-the-secret-not-the-secret')) === 401, 'a token signed with another key is rejected');
  const t0 = mk({ alg: 'HS256', typ: 'JWT' }, good); const tp = t0.split('.');
  ok(await crack(`${tp[0]}.${tp[1]}.${tp[2].slice(0, -2)}AA`) === 401, 'a tampered signature is rejected');
  ok(await crack(`${tp[0]}.${Buffer.from(JSON.stringify({ ...good, id: 'x' })).toString('base64url')}.${tp[2]}`) === 401, 'tampered claims are rejected');
  ok(await crack(`${t0}.extra`) === 401, 'a token with four parts is rejected');

  // ---- A6 / C1: log redaction ----
  const TICKET = 'TICKET-SECRET-VALUE-0123456789abcdef';
  const lr = await login(A, newId(4), { 'session-auth-token': TICKET });
  await req(A, 'GET', '/api/account', { headers: bearer(lr.token) });
  const ws0 = await wsConnect(A, '/ws', { Authorization: `Token ${lr.token}`, 'app-id': 'sostest' });
  await sleep(300); ws0.socket.destroy(); await sleep(200);
  const logs = logText() + fs.readFileSync(path.join(A.dir, 'ws.jsonl'), 'utf8');
  ok(!logs.includes(TICKET), 'logs never contain the Steam ticket (session-auth-token)');
  ok(!logs.includes(lr.token), 'logs never contain a full JWT');
  ok(!logs.includes(lr.token.split('.')[2]), 'logs never contain a token signature');
  ok(/"authorization":"Token eyJhbG\.\.\."/.test(logs), 'Authorization headers are logged as scheme + 6 chars + ...');
  {
    // truncation: a 40 KB body logs at most ~2 KB
    await req(A, 'POST', '/api/log', { body: JSON.stringify({ pad: 'x'.repeat(40000) }) });
    const lines = logText().trim().split('\n');
    const biggest = Math.max(...lines.map((l) => l.length));
    ok(biggest < 8000, 'log lines are truncated (largest line under 8 KB)', biggest);
  }

  // ---- C4: non-Classic app data ----
  const APP = 'sos';
  r = await req(A, 'POST', `/api/account/${P2}/app/${APP}`, { body: { data: { hi: 1 } } });
  ok(r.status === 401, 'non-Classic app-data write without a token: 401', r.status);
  r = await req(A, 'POST', `/api/account/${P2}/app/${APP}`, { body: { data: { hi: 1 } }, headers: bearer(l3.token) });
  ok(r.status === 401, 'non-Classic app-data write with another account\'s token: 401', r.status);
  r = await req(A, 'POST', `/api/account/${P2}/app/${APP}`, { body: { data: { hi: 1 } }, headers: bearer(lSos.token) });
  ok(r.status === 200 && r.body.data.hi === 1, 'non-Classic app-data write by the owner works', r.status);
  r = await req(A, 'GET', `/api/account/${P2}/app/${APP}`);
  ok(r.status === 401, 'non-Classic app-data read without a token: 401', r.status);
  r = await req(A, 'GET', `/api/account/${P2}/app/${APP}`, { headers: bearer(l3.token) });
  ok(r.status === 200 && r.body.data.hi === 1, 'non-Classic app-data read with any valid token works', r.status);
  r = await req(A, 'POST', `/api/account/${P2}/app/${APP}`, { body: 'x'.repeat(70000), headers: bearer(lSos.token) });
  ok(r.status === 413, 'non-Classic app-data over 64 KB: 413', r.status);
  let last = 0;
  for (let i = 0; i < 17; i++) last = (await req(A, 'POST', `/api/account/${P2}/app/app${i}`, { body: { data: { i } }, headers: bearer(lSos.token) })).status;
  ok(last === 409, 'more than 16 app keys per account: 409', last);
  r = await req(A, 'POST', `/api/account/${P2}/app/__proto__`, { body: { data: {} }, headers: bearer(lSos.token) });
  ok(r.status === 400, 'app id __proto__ is refused', r.status);

  // ---- C5: search / account view ----
  r = await req(A, 'GET', '/api/search/account');
  ok(r.status === 401, '/api/search/account needs a token', r.status);
  for (let i = 0; i < 55; i++) await login(A, newId(5));
  r = await req(A, 'GET', '/api/search/account', { headers: bearer(l3.token) });
  const rows = r.body && r.body.data;
  ok(r.status === 200 && Array.isArray(rows) && rows.length === 50, 'search returns at most 50 accounts in the array shape', rows && rows.length);
  const fields = new Set(); (rows || []).forEach((x) => Object.keys(x).forEach((k) => fields.add(k)));
  ok(!fields.has('last-access') && !fields.has('created') && !fields.has('persona-checked') && !fields.has('identities') && fields.has('id') && fields.has('display-name'), 'search rows carry only id/alias/display-name fields', [...fields]);
  r = await req(A, 'GET', `/api/account/${P1}`, { headers: bearer(l3.token) });
  ok(r.status === 200 && r.body.id === P1 && r.body['last-access'] === undefined && r.body.created === undefined, 'another account\'s view has no last-access/created', Object.keys(r.body || {}));
  r = await req(A, 'GET', `/api/account/${P1}`, { headers: bearer(l1.token) });
  ok(r.status === 200 && r.body['last-access'] !== undefined, 'the account itself sees its full object');
  r = await req(A, 'GET', '/api/account', { headers: bearer(l1.token) });
  ok(r.status === 200 && r.body.id === P1, 'GET /api/account with a JWT (no stored tokens) resolves the caller');

  // ---- C6: stream auth, ownership, pollution ----
  const ST = '/ws/stream';
  const anon = await wsConnect(A, ST);
  ok(anon.status === 101, 'anonymous /ws/stream socket still connects (read-only use)');
  anon.sendJson({ type: 'ping', nonce: 'a' });
  ok(!!(await anon.waitFor((m) => m.type === 'pong')), 'anonymous ping works');
  anon.sendJson({ type: 'session', nonce: 's', data: { players: [{ id: P1 }] } });
  ok(!!(await anon.waitFor((m) => m.type === 'nak' && m.data && m.data.error === 'unauthorized')), 'anonymous session create is refused');
  anon.sendJson({ type: 'feedback', nonce: 'f', data: { target: P1, counts: { applause: 3 } } });
  ok(!!(await anon.waitFor((m) => m.type === 'nak' && m.nonce === 'f')), 'anonymous feedback is refused');
  const owner = await wsConnect(A, `${ST}?token=${encodeURIComponent(l1.token)}`);
  const other = await wsConnect(A, ST, bearer(l3.token));
  ok(owner.status === 101 && other.status === 101, 'authenticated stream sockets connect (?token= and Authorization)');
  owner.sendJson({ type: 'session', nonce: 'c', data: { players: [{ id: P1 }, { id: '__proto__' }, { id: 'constructor' }, { id: 'not-a-steam-id' }, { id: P3 }] } });
  const created = await owner.waitFor((m) => m.type === 'session');
  const sid = created && created.data && created.data['session-id'];
  ok(!!sid, 'authenticated session create works');
  ok(created && created.data.players.length === 2 && created.data.players.every((p) => /^7656\d{13}$/.test(p.id)), 'non-SteamID64 player ids are dropped from a session', created && created.data.players);
  other.sendJson({ type: 'session-end', nonce: 'e1', data: { 'session-id': sid } });
  ok(!!(await other.waitFor((m) => m.type === 'nak' && m.nonce === 'e1')), 'session-end from another connection is refused');
  other.sendJson({ type: 'feedback', nonce: 'fb', data: { target: '__proto__', counts: { applause: 5, love: 5 } } });
  await other.waitFor((m) => m.nonce === 'fb');
  for (let i = 0; i < 3; i++) other.sendJson({ type: 'feedback', data: { target: P3, counts: { applause: 5 } } });
  await sleep(1300);
  owner.sendJson({ type: 'session-end', nonce: 'e2', data: { 'session-id': sid } });
  ok(!!(await owner.waitFor((m) => m.type === 'ack' && m.nonce === 'e2')), 'session-end from the creating connection works');
  await sleep(300);
  r = await req(A, 'GET', '/api/account/fame');
  ok(r.status === 200 && r.body.id === 'fame', 'no prototype pollution after __proto__ ids on the stream (GET /api/account/fame stays normal)', r.body && r.body.id);
  r = await req(A, 'GET', '/api/stream/fame');
  ok(r.status === 200 && Array.isArray(r.body.fame), '/api/stream/fame still answers');
  for (const s of [anon, owner, other]) s.socket.destroy();

  // ---- C8: admin ban ids ----
  const dev = await req(A, 'GET', `/admin/dev-login?steamid=${ADMIN}`);
  const cookie = dev.headers['set-cookie'] && dev.headers['set-cookie'][0].split(';')[0];
  ok(dev.status === 302 && !!cookie, 'admin dev login works (test setup)');
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    r = await req(A, 'POST', '/admin/api/bans', { body: { steamId: id, hours: 1, reason: 'test' }, headers: { Cookie: cookie, 'X-Ogsos-Admin': '1' } });
    ok(r.status === 400, `admin ban of "${id}" is refused`, r.status);
  }
  r = await req(A, 'POST', '/admin/api/bans', { body: { steamId: newId(6), hours: 1, reason: 'test' }, headers: { Cookie: cookie, 'X-Ogsos-Admin': '1' } });
  ok(r.status === 200, 'admin ban of a normal id still works', r.status);
  r = await login(A, '76561190000000001');
  ok(r.status === 200, 'login still fine after the ban attempts on prototype names');

  // ---- A5: WebSockets ----
  let w = await wsConnect(A, '/nope');
  ok(w.status === 404, 'upgrade on a path other than /ws or /ws/stream: 404', w.status);
  w = await wsConnect(A, ST);
  w.socket.write(maskFrame(1, Buffer.from('{"type":"ping"}'), { mask: false }));
  ok(await w.waitClosed() && w.closeCode === 1002, 'unmasked client frame: close 1002', w.closeCode);
  w = await wsConnect(A, ST);
  w.socket.write(maskFrame(1, Buffer.from('{"type":"ping"}'), { rsv: 0x40 }));
  ok(await w.waitClosed() && w.closeCode === 1002, 'RSV bit set: close 1002', w.closeCode);
  w = await wsConnect(A, ST);
  w.socket.write(Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 5, 0, 0, 1, 2, 3, 4]));   // masked, declared length 327680 (> 256 KB)
  ok(await w.waitClosed() && w.closeCode === 1009, 'frame declaring more than 256 KB: close 1009', w.closeCode);
  w = await wsConnect(A, ST);
  w.socket.write(Buffer.from([0x81, 0xff, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1, 2, 3, 4]));
  ok(await w.waitClosed() && w.closeCode === 1009, 'frame declaring 2^63 bytes: close 1009', w.closeCode);
  w = await wsConnect(A, ST);
  w.socket.write(maskFrame(9, Buffer.alloc(200)));
  ok(await w.waitClosed() && w.closeCode === 1002, 'ping frame over 125 bytes: close 1002', w.closeCode);
  w = await wsConnect(A, ST);
  w.socket.write(maskFrame(0x3, Buffer.from('x')));
  ok(await w.waitClosed() && w.closeCode === 1002, 'reserved opcode: close 1002', w.closeCode);
  w = await wsConnect(A, ST);
  {
    const text = Buffer.from(JSON.stringify({ type: 'ping', nonce: 'frag' }));
    w.socket.write(maskFrame(1, text.subarray(0, 9), { fin: false }));
    await sleep(80);
    w.socket.write(maskFrame(0, text.subarray(9)));
    ok(!!(await w.waitFor((m) => m.type === 'pong' && m.nonce === 'frag')), 'a message split into two frames (FIN=0 + continuation) is assembled and answered');
    // split further, with the second frame arriving byte by byte
    const f = maskFrame(1, Buffer.from(JSON.stringify({ type: 'ping', nonce: 'bytes' })));
    for (const byte of f) { w.socket.write(Buffer.from([byte])); }
    ok(!!(await w.waitFor((m) => m.type === 'pong' && m.nonce === 'bytes')), 'a frame arriving one byte at a time is parsed');
    w.socket.write(maskFrame(0, Buffer.from('x')));
    ok(await w.waitClosed() && w.closeCode === 1002, 'continuation frame without a started message: close 1002', w.closeCode);
  }
  w = await wsConnect(A, ST);
  {
    const big = Buffer.alloc(200 * 1024, 0x61);
    w.socket.write(maskFrame(1, big, { fin: false }));
    w.socket.write(maskFrame(0, big, { fin: false }));
    ok(await w.waitClosed() && w.closeCode === 1009, 'reassembled message over 256 KB: close 1009', w.closeCode);
  }
  w = await wsConnect(A, ST);
  for (let i = 0; i < 30; i++) w.sendJson({ type: 'ping', nonce: `m${i}` });
  ok(await w.waitClosed() && w.closeCode === 1008, 'more than the per-socket message rate (20 in this test): close 1008', w.closeCode);
  // per-IP concurrent cap (4 in this backend)
  const held = [];
  for (let i = 0; i < 4; i++) held.push(await wsConnect(A, ST));
  const over = await wsConnect(A, ST);
  ok(held.every((x) => x.status === 101) && over.status === 429, 'fifth concurrent WebSocket from one address: 429', [held.map((x) => x.status), over.status]);
  held[0].socket.destroy(); await sleep(300);
  const again = await wsConnect(A, ST);
  ok(again.status === 101, 'a slot frees up when a socket closes');
  [...held, again].forEach((x) => x.socket.destroy());

  // ---- B: atomic save + backup ----
  await sleep(1500);
  let dbOk = false; try { JSON.parse(fs.readFileSync(path.join(A.dir, 'db.json'), 'utf8')); dbOk = true; } catch { /* corrupt */ }
  ok(dbOk, 'db.json is valid JSON after many logins');
  ok(fs.existsSync(path.join(A.dir, 'db.json.bak')), 'db.json.bak exists after the first save');
  ok(!fs.existsSync(path.join(A.dir, 'db.json.tmp')), 'no db.json.tmp left behind');
  const dbj = JSON.parse(fs.readFileSync(path.join(A.dir, 'db.json'), 'utf8'));
  ok(dbj.tokens === undefined || Object.keys(dbj.tokens).length === 0, 'db.json does not store JWTs');
  ok(Object.keys(dbj.accounts).length > 50, 'accounts were persisted');
  ok(!(fs.statSync(path.join(A.dir, 'secret.key')).mode & 0o077) || process.platform === 'win32', 'secret.key is not group/world readable');
  A.proc.kill(); await sleep(300);

  // ===================== backend B: rate limits =====================
  const HOST_SID = '55555555-6666-7777-8888-999999999999', HOST_TOKEN = 'hardening-test-host-token-0123456789';
  const B = await startBackend('b', {
    OGSOS_RATE_LOGIN: '5', OGSOS_RATE_WS: '3', OGSOS_RATE_SEARCH: '2', OGSOS_RATE_ADMIN: '2', OGSOS_RATE_GLOBAL: '5',
    OGSOS_CLASSIC_HOSTS: JSON.stringify([{ host: '127.0.0.1', port: 7777, sessionId: HOST_SID, sessionToken: HOST_TOKEN, hostIds: [] }]),
  });
  ok(await waitUp(B), 'backend B up');
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await login(B, newId(7))).status);
  ok(JSON.stringify(codes) === JSON.stringify([200, 200, 200, 200, 200, 429, 429]), 'login: 429 after the limit (OGSOS_RATE_LOGIN=5)', codes);
  r = await login(B, newId(7));
  ok(r.status === 429 && r.body.error === 'rate-limited' && Number(r.headers['retry-after']) > 0, '429 carries {error:"rate-limited"} and Retry-After', [r.status, r.headers['retry-after']]);
  r = await login(B, newId(7), {}, { 'X-Forwarded-For': '198.51.100.7' });
  ok(r.status === 200, 'behind the local proxy the last X-Forwarded-For entry is the client (own bucket)', r.status);
  const spoof = [];
  for (let i = 0; i < 6; i++) spoof.push((await login(B, newId(7), {}, { 'X-Forwarded-For': `${i}.${i}.${i}.${i}, 198.51.100.8` })).status);
  ok(spoof[5] === 429, 'a client-chosen first X-Forwarded-For entry does not dodge the limit', spoof);
  const tokB = (await login(B, newId(8), {}, { 'X-Forwarded-For': '198.51.100.9' })).token;
  const sc = [];
  for (let i = 0; i < 3; i++) sc.push((await req(B, 'GET', '/api/search/account', { headers: { ...bearer(tokB), 'X-Forwarded-For': '198.51.100.10' } })).status);
  ok(sc[0] === 200 && sc[2] === 429, 'search: 429 after the limit (OGSOS_RATE_SEARCH=2)', sc);
  const ad = [];
  for (let i = 0; i < 3; i++) ad.push((await req(B, 'GET', '/admin/login', { headers: { 'X-Forwarded-For': '198.51.100.11' } })).status);
  ok(ad[0] === 302 && ad[2] === 429, '/admin/login: 429 after the limit (OGSOS_RATE_ADMIN=2)', ad);
  const gl = [], gh = [];
  for (let i = 0; i < 8; i++) gl.push((await req(B, 'GET', '/api/log', { headers: { 'X-Forwarded-For': '198.51.100.12' } })).status);
  ok(gl[4] === 200 && gl[5] === 429, 'global limit: 429 after OGSOS_RATE_GLOBAL requests per address', gl);
  for (let i = 0; i < 8; i++) gh.push((await req(B, 'GET', `/api/session/${HOST_SID}`, { headers: { 'X-Forwarded-For': '198.51.100.12', Authorization: `Token ${HOST_TOKEN}` } })).status);
  ok(gh.every((x) => x === 200), 'a request with a valid host session token is exempt from the global limit', gh);
  const ws3 = [];
  for (let i = 0; i < 4; i++) ws3.push((await wsConnect(B, '/ws/stream')).status);
  ok(JSON.stringify(ws3) === JSON.stringify([101, 101, 101, 429]), 'WebSocket upgrades: 429 after the limit (OGSOS_RATE_WS=3)', ws3);
  B.proc.kill(); await sleep(200);

  // ===================== C3 / unit: cleanLabel =====================
  const { cleanLabel } = require('../server/matchmaking');
  ok(cleanLabel('  My​  Ser‮ver﻿   One ', 48) === 'My Server One', 'cleanLabel strips zero-width/bidi characters and collapses whitespace', cleanLabel('  My​  Ser‮ver﻿   One ', 48));
  ok(cleanLabel('OFF​ICIAL', 48) === 'OFFICIAL', 'zero-width characters cannot hide "official" from the name rule');

  // ===================== corrupt db handling =====================
  const goodDb = { accounts: { '76561190000000042': { id: '76561190000000042', alias: 'from-backup', 'display-name': 'from-backup', identities: [] } }, appData: {} };
  const C = await startBackend('c', { OGSOS_WS_PING_MS: '400', OGSOS_WS_IDLE_MS: '1500' }, { seed: (dir) => { fs.writeFileSync(path.join(dir, 'db.json'), '{"accounts":{"76561190000000042":{"id":'); fs.writeFileSync(path.join(dir, 'db.json.bak'), JSON.stringify(goodDb)); } });
  ok(await waitUp(C), 'a corrupt db.json with a valid db.json.bak starts');
  r = await login(C, '76561190000000042');
  ok(r.status === 200 && r.body['display-name'] === 'from-backup', 'the account from db.json.bak was loaded', r.body && r.body['display-name']);
  {
    const idle = await wsConnect(C, '/ws/stream');   // says nothing and never answers pings
    await sleep(900);
    ok(idle.pings >= 1, 'the server pings an open WebSocket');
    ok(await idle.waitClosed(2500), 'a WebSocket that sends nothing is dropped after the idle limit');
  }
  C.proc.kill(); await sleep(200);
  const D = await startBackend('d', {}, { seed: (dir) => { fs.writeFileSync(path.join(dir, 'db.json'), 'not json at all'); fs.writeFileSync(path.join(dir, 'db.json.bak'), '{{{'); } });
  for (let i = 0; i < 40 && D.exited === null; i++) await sleep(100);
  ok(D.exited !== null && D.exited !== 0, 'corrupt db.json and corrupt .bak: the process exits non-zero', D.exited);
  ok(fs.readFileSync(path.join(D.dir, 'db.json'), 'utf8') === 'not json at all', 'the corrupt db.json was left untouched (not replaced by an empty db)');
  const E = await startBackend('e', {}, { seed: (dir) => { fs.writeFileSync(path.join(dir, 'secret.key'), 'tooshort'); } });
  for (let i = 0; i < 40 && E.exited === null; i++) await sleep(100);
  ok(E.exited !== null && E.exited !== 0, 'a secret.key under 32 characters stops the backend');

  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  setTimeout(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } }, 500);
  console.log(fail ? `${pass} passed, ${fail} failed` : `ALL OK (${pass})`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); for (const k of kids) { try { k.kill(); } catch { /* gone */ } } process.exitCode = 1; });
