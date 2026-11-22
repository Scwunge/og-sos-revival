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
function req(b, method, p, { body, headers = {}, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (data !== null) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host, port: b.port, path: p, method, headers: h, agent: false }, (res) => {
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

  // ===================== pass 2: host write scope (unit: the 30 minute window) =====================
  {
    const { createMatchmaker, DEFAULTS } = require('../server/matchmaking');
    const SID = '12121212-3434-4545-5656-787878787878';
    const mm = createMatchmaker({
      config: { ...DEFAULTS, START_MIN_PLAYERS: 9, START_COUNTDOWN_SECONDS: 30, TRAVEL_GRACE_SECONDS: 5, HOSTS: [{ host: '127.0.0.1', port: 7777, sessionId: SID, sessionToken: 'unit-token', hostIds: ['76561190000001999'] }] },
      log: () => {},
    });
    const origLog = console.log; console.log = () => {};
    mm.markHostPolled(SID);
    const mkc = (id) => { const c = { id, connId: id, msgs: [], sendMsg(type, data) { this.msgs.push({ type, data }); }, close() {} }; mm.onConnect(c); return c; };
    const SEATED = '76561190000001901', NEVER = '76561190000001902';
    const c1 = mkc(SEATED); mkc(NEVER);
    mm.onMessage(c1, JSON.stringify({ type: 'find-session', data: { opts: {} } }));
    const w = (pid, ms) => mm.wasSeated(SID, pid, ms);
    ok(w(SEATED) === true, 'wasSeated: a player seated now');
    ok(w(NEVER) === false && w('76561190000001903') === false, 'wasSeated: a player never seated in that session is false');
    ok(mm.wasSeated('99999999-0000-0000-0000-000000000000', SEATED) === false, 'wasSeated: unknown session is false');
    ok(w('76561190000001999') === true, 'wasSeated: the host\'s own configured ids are in its player-map');
    mm.resetHosted(SID);
    ok(w(SEATED) === true, 'wasSeated: still true right after the seats were cleared (end-of-match saves)');
    const realNow = Date.now;
    Date.now = () => realNow() + 29 * 60 * 1000; const in29 = w(SEATED);
    Date.now = () => realNow() + 31 * 60 * 1000; const in31 = w(SEATED), in31wide = w(SEATED, 99 * 60 * 60 * 1000);
    Date.now = realNow;
    ok(in29 === true && in31 === false && in31wide === false, 'wasSeated: true within 30 minutes, false after (a longer window argument cannot extend it)', [in29, in31, in31wide]);
    mm.markHostPolled(SID);
    mm.shutdown(); console.log = origLog;
  }

  // ===================== pass 2: one backend for scope, reports, logout, IPs, IP bans =====================
  const OWNER = '76561190000090001', MOD = '76561190000090002';
  const F_SID = '66666666-7777-8888-9999-aaaaaaaaaaaa', F_TOK = 'pass2-host-token-0123456789abcdef';
  const PROXY_TEST = '192.0.2.200';
  const F = await startBackend('f', {
    OGSOS_RATE_LOGIN: '1000', OGSOS_RATE_WS: '1000', OGSOS_RATE_REPORT: '1000', OGSOS_RATE_HINT: '1000', OGSOS_RATE_GLOBAL: '100000', OGSOS_MAX_WS_PER_IP: '200',
    OGSOS_ADMINS: OWNER, OGSOS_ADMIN_DEV_LOGIN: '1', OGSOS_MAX_REPORTS: '6', OGSOS_TRUSTED_PROXIES: PROXY_TEST,
    OGSOS_CLASSIC_HOSTS: JSON.stringify([{ host: '127.0.0.1', port: 7777, sessionId: F_SID, sessionToken: F_TOK, hostIds: [] }]),
    OGSOS_CLASSIC_START_MIN_PLAYERS: '9', OGSOS_CLASSIC_START_COUNTDOWN_SECONDS: '60',
  });
  ok(await waitUp(F), 'backend F up');
  const XFF = (ip) => ({ 'X-Forwarded-For': ip });
  const adminCookie = async (id) => { const d = await req(F, 'GET', `/admin/dev-login?steamid=${id}`); return d.headers['set-cookie'] && d.headers['set-cookie'][0].split(';')[0]; };
  const ownerCk = await adminCookie(OWNER);
  const aget = (ck, p) => req(F, 'GET', `/admin/api/${p}`, { headers: { Cookie: ck } });
  const apost = (ck, p, body) => req(F, 'POST', `/admin/api/${p}`, { body: body === undefined ? {} : body, headers: { Cookie: ck, 'X-OGSOS-Admin': '1' } });
  r = await apost(ownerCk, 'admins', { steamId: MOD });
  const modCk = await adminCookie(MOD);
  ok(r.status === 200 && !!ownerCk && !!modCk, 'owner and a mod have panel sessions (test setup)', r.status);

  // ---- 1c: logout is POST only, with the CSRF header ----
  r = await req(F, 'GET', '/admin/logout', { headers: { Cookie: ownerCk } });
  ok(r.status === 405, 'GET /admin/logout: 405 (a link or image cannot sign anyone out)', r.status);
  r = await req(F, 'POST', '/admin/logout', { headers: { Cookie: ownerCk } });
  ok(r.status === 403, 'POST /admin/logout without X-OGSOS-Admin: 403', r.status);
  {
    const tmpCk = await adminCookie(OWNER);
    r = await req(F, 'POST', '/admin/logout', { headers: { Cookie: tmpCk, 'X-OGSOS-Admin': '1' } });
    ok(r.status === 302 && /Max-Age=0/.test(String(r.headers['set-cookie'])), 'POST /admin/logout with the header clears the cookie', r.status);
  }
  ok((await aget(ownerCk, 'me')).status === 200, 'the cookie from the refused logouts still works');

  // ---- 1a: host write scope over HTTP ----
  const hostH = { Authorization: `Token ${F_TOK}` };
  const PA = '76561190000002001', PB = '76561190000002002', PN = '76561190000002003';
  const tokA = (await login(F, PA, {}, XFF('203.0.113.101'))).token, tokB2 = (await login(F, PB, {}, XFF('203.0.113.102'))).token;
  await login(F, PN, {}, XFF('203.0.113.103'));
  await req(F, 'GET', `/api/session/${F_SID}`, { headers: hostH });   // the host is up
  const seatWs = [];
  for (const t of [tokA, tokB2]) {
    const c = await wsConnect(F, '/ws', { Authorization: `Token ${t}`, 'app-id': 'sostest' });
    c.sendJson({ type: 'find-session', data: { opts: { 'game-mode': '', map: '' } } });
    ok(!!(await c.waitFor((m) => m.type === 'session', 4000)), 'a player is seated in the hosted session through the WebSocket');
    seatWs.push(c);
  }
  const putBlob = (pid, lvl) => req(F, 'POST', `/api/account/${pid}/app/sostest`, { body: { data: { progression: { level: lvl } } }, headers: hostH });
  r = await putBlob(PA, 2);
  ok(r.status === 200 && r.body.version >= 2, 'host writes the blob of a player seated in its session', r.status);
  r = await putBlob(PN, 30);
  ok(r.status === 403 && r.body && r.body.error === 'not-seated', 'host writing the blob of a player never seated: 403 not-seated', [r.status, r.body]);
  r = await req(F, 'GET', `/api/account/${PN}/app/sostest`, { headers: hostH });
  ok(r.status === 200 && !(r.body.data && r.body.data.progression), 'the refused blob write changed nothing');
  r = await req(F, 'POST', '/api/leaderboard/sostest/scope_test', { body: [{ member: PA, score: 7 }], headers: hostH });
  ok(r.status === 200 && Array.isArray(r.body) && r.body.length === 1, 'leaderboard row of a seated player is accepted', r.status);
  r = await req(F, 'POST', '/api/leaderboard/sostest/scope_test', { body: [{ member: PA, score: 8 }, { member: PN, score: 99 }], headers: hostH });
  ok(r.status === 403 && r.body && r.body.error === 'not-seated', 'a leaderboard post naming a never-seated player: 403 not-seated', [r.status, r.body]);
  r = await req(F, 'GET', '/api/leaderboard/sostest/scope_test');
  ok(r.status === 200 && Array.isArray(r.body) && r.body.length === 1 && r.body[0].score === 7, 'the refused leaderboard post changed nothing', r.body);
  r = await req(F, 'POST', `/api/session/${F_SID}/reset`, { body: {}, headers: hostH });   // seats cleared (as at the end of a match)
  r = await putBlob(PB, 3);
  ok(r.status === 200, 'seated then left (seats cleared): the end-of-match save is still accepted within 30 minutes', r.status);
  r = await req(F, 'POST', '/api/leaderboard/sostest/scope_test', { body: [{ member: PB, score: 5 }], headers: hostH });
  ok(r.status === 200, 'seated then left: the end-of-match leaderboard row is still accepted', r.status);
  r = await putBlob(PN, 31);
  ok(r.status === 403, 'a never-seated player stays refused after the reset', r.status);
  seatWs.forEach((c) => c.socket.destroy());

  // ---- 1b: report queue ----
  const mkRep = async (n) => {
    const reporter = `76561190000003${String(n).padStart(3, '0')}`, target = `76561190000004${String(n).padStart(3, '0')}`;
    const t = (await login(F, reporter, {}, XFF(`198.51.100.${n}`))).token;
    return req(F, 'POST', '/api/reports', { body: { target, reason: 'cheating', text: `rq ${n}` }, headers: { ...bearer(t), ...XFF(`198.51.100.${n}`) } });
  };
  const ids = [];
  for (let n = 1; n <= 6; n++) { r = await mkRep(n); ids.push(r.body && r.body.data && r.body.data.id); }
  ok(ids.every(Boolean), 'six reports fill the queue (OGSOS_MAX_REPORTS=6)', ids);
  r = await mkRep(7);
  ok(r.status === 429 && r.body.error === 'report-queue-full', 'a full queue of open reports refuses the new one: 429 report-queue-full', [r.status, r.body]);
  r = await mkRep(8);
  ok(r.status === 429 && r.body.error === 'report-queue-full', 'still refused (and nothing was evicted)', r.status);
  r = await aget(ownerCk, 'reports?status=all');
  ok(r.status === 200 && r.body.length === 6 && r.body.every((x) => x.status === 'open'), 'all six open reports are still stored', r.body && r.body.length);
  r = await aget(ownerCk, 'audit?action=report-queue-full');
  ok(r.status === 200 && r.body.length === 1, 'report-queue-full is audited once per hour at most (two refusals, one entry)', r.body && r.body.length);
  await apost(ownerCk, `reports/${ids[1]}`, { status: 'investigating' });
  await apost(ownerCk, `reports/${ids[2]}`, { status: 'resolved' });
  r = await mkRep(9);
  ok(r.status === 200, 'with one resolved report the queue makes room: the new report is accepted', [r.status, r.body]);
  r = await aget(ownerCk, 'reports?status=all');
  const stored = (r.body || []).map((x) => x.id);
  ok(r.body.length === 6 && !stored.includes(ids[2]) && stored.includes(ids[0]) && stored.includes(ids[1]), 'the resolved report was evicted, the open and the investigating ones were kept', stored);
  r = await mkRep(10);
  ok(r.status === 429 && r.body.error === 'report-queue-full', 'then the queue is full of open/investigating reports again: refused', r.status);
  await apost(ownerCk, `reports/${ids[3]}`, { status: 'dismissed' });
  r = await mkRep(11);
  ok(r.status === 200, 'a dismissed report is also evicted first', r.status);

  // ---- 2: IP tracking ----
  const ipsOf = async (ck, id) => { const x = await aget(ck, `players/${id}`); return x; };
  const listOf = (x) => ((x.body && x.body.ips && x.body.ips.list) || []).map((e) => e.ip);
  const X1 = '76561190000005001';
  r = await login(F, X1, {}, XFF('203.0.113.10'));
  const tokX = r.token;
  r = await ipsOf(ownerCk, X1);
  ok(r.status === 200 && listOf(r).includes('203.0.113.10') && r.body.ips.last.ip === '203.0.113.10' && r.body.ips.first.ip === '203.0.113.10', 'login from a trusted proxy (loopback peer) records the last X-Forwarded-For entry', r.body && r.body.ips);
  await login(F, X1, {}, { 'X-Forwarded-For': '192.0.2.250, 203.0.113.16' });
  r = await ipsOf(ownerCk, X1);
  ok(listOf(r).includes('203.0.113.16') && !listOf(r).includes('192.0.2.250') && r.body.ips.list.find((e) => e.ip === '203.0.113.16').count === 1, 'only the last X-Forwarded-For entry counts (client-chosen earlier entries are ignored)', listOf(r));
  r = await login(F, X1);   // no proxy header: a loopback peer is never stored as a player's address
  r = await ipsOf(ownerCk, X1);
  ok(listOf(r).every((ip) => !/^127\./.test(ip)), 'loopback addresses are not recorded', listOf(r));
  r = await login(F, X1, {}, XFF('172.20.1.2'));
  r = await ipsOf(ownerCk, X1);
  ok(!listOf(r).includes('172.20.1.2'), 'Docker/private addresses are not recorded', listOf(r));
  // untrusted peer: connect through a non-loopback local address; the spoofed header must be ignored
  {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal && !/^(127\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address));
    if (lan) {
      const Y = '76561190000005002';
      const ry = await req(F, 'POST', '/api/access-token/steam', { host: lan.address, body: { 'steam-app-id': '802240', 'steam-id': Y, 'session-auth-token': 'x', 'app-id': 'sostest' }, headers: XFF('203.0.113.99') });
      const py = await ipsOf(ownerCk, Y);
      ok(ry.status === 200 && !listOf(py).includes('203.0.113.99'), 'X-Forwarded-For from an untrusted (non-loopback, non-proxy) peer is ignored', [ry.status, listOf(py).length]);
    } else console.log('SKIP  untrusted-peer X-Forwarded-For check (no non-loopback IPv4 interface on this machine)');
  }
  // other recording sites
  const X2 = '76561190000005003';
  const tokX2 = (await login(F, X2, {}, XFF('203.0.113.20'))).token;
  const wsx = await wsConnect(F, '/ws', { Authorization: `Token ${tokX2}`, 'app-id': 'sostest', ...XFF('203.0.113.21') });
  const sx = await wsConnect(F, `/ws/stream?token=${encodeURIComponent(tokX2)}`, XFF('203.0.113.22'));
  r = await req(F, 'POST', `/api/servers/${F_SID}/join-hint`, { body: {}, headers: { ...bearer(tokX2), ...XFF('203.0.113.23') } });
  r = await req(F, 'POST', `/api/session/${F_SID}/vote-start`, { body: {}, headers: { ...bearer(tokX2), ...XFF('203.0.113.24') } });
  const sharedTarget = '76561190000005004';
  r = await req(F, 'POST', '/api/reports', { body: { target: sharedTarget, reason: 'cheating' }, headers: { ...bearer(tokX2), ...XFF('203.0.113.25') } });
  await sleep(100);
  r = await ipsOf(ownerCk, X2);
  const got = listOf(r);
  ok(wsx.status === 101 && sx.status === 101, 'matchmaking and stream sockets with the account connect (test setup)');
  ok(['203.0.113.20', '203.0.113.21', '203.0.113.22', '203.0.113.23', '203.0.113.24'].every((ip) => got.includes(ip)),
    'login, matchmaking WS, stream WS, join-hint and vote-start each record the address', got);
  wsx.socket.destroy(); sx.socket.destroy();
  const anonStream = await wsConnect(F, '/ws/stream', XFF('203.0.113.26'));   // anonymous: no account, nothing to record
  anonStream.socket.destroy();

  // shared addresses
  const SA = '76561190000005010', SB = '76561190000005011', SC = '76561190000005012';
  await login(F, SA, {}, XFF('203.0.113.30')); await login(F, SB, {}, XFF('203.0.113.30')); await login(F, SC, {}, XFF('203.0.113.31'));
  r = await ipsOf(ownerCk, SA);
  const sh = r.body && r.body.sharedIp;
  ok(Array.isArray(sh) && sh.length === 1 && sh[0].ip === '203.0.113.30' && sh[0].accounts.length === 1 && sh[0].accounts[0].id === SB && typeof sh[0].accounts[0].name === 'string', 'sharedIp lists the other account seen on the same address', sh);
  r = await aget(ownerCk, 'ip/203.0.113.30');
  ok(r.status === 200 && r.body.accounts.map((a) => a.id).sort().join() === [SA, SB].join() && r.body.banned === false && r.body.accounts[0].first && r.body.accounts[0].last, 'GET /admin/api/ip/<ip> lists the accounts seen there (id, name, first, last) and the ban state', r.body);
  r = await aget(ownerCk, 'ip/not-an-ip');
  ok(r.status === 400, 'a malformed address is refused (400)', r.status);

  // report snapshot
  const RS_T = '76561190000005020', RS_R = '76561190000005021';
  await login(F, RS_T, {}, XFF('203.0.113.40')); await login(F, RS_T, {}, XFF('203.0.113.41')); await login(F, SB, {}, XFF('203.0.113.41'));
  const tokRR = (await login(F, RS_R, {}, XFF('203.0.113.42'))).token;
  // make room in the queue: the report cap is small in this backend
  for (const rid of (await aget(ownerCk, 'reports?status=all')).body.map((x) => x.id)) await apost(ownerCk, `reports/${rid}`, { status: 'resolved' });
  r = await req(F, 'POST', '/api/reports', { body: { target: RS_T, reason: 'harassment', text: 'snapshot' }, headers: { ...bearer(tokRR), ...XFF('203.0.113.43') } });
  const repId = r.body && r.body.data && r.body.data.id;
  ok(r.status === 200 && !!repId, 'the report with address snapshot was filed', [r.status, r.body]);
  r = await aget(ownerCk, `reports/${repId}`);
  const snapIps = r.body && r.body.report && r.body.report.ips;
  ok(snapIps && snapIps.target.last === '203.0.113.41' && snapIps.target.recent.some((e) => e.ip === '203.0.113.40') && snapIps.target.recent.length <= 10 && snapIps.reporter.last === '203.0.113.43', 'a new report stores the target\'s last/recent addresses and the reporter\'s address', snapIps);
  ok(Array.isArray(r.body.sharedIp) && r.body.sharedIp.some((x) => x.ip === '203.0.113.41' && x.accounts.some((a) => a.id === SB)), 'report detail includes sharedIp for the target', r.body.sharedIp);
  ok(listOf(await ipsOf(ownerCk, RS_R)).includes('203.0.113.43'), 'filing a report records the reporting account address');
  const lastOf = (await aget(ownerCk, 'reports?status=all')).body.find((x) => x.id === repId);
  ok(lastOf && lastOf.ips === undefined, 'report lists never carry the address snapshot');

  // ---- 2c: owner sees addresses, mods see none ----
  r = await ipsOf(modCk, RS_T);
  ok(r.status === 200 && !('ips' in r.body) && !('sharedIp' in r.body) && !/203\.0\.113\./.test(r.text), 'a mod\'s player profile has no ip fields at all', Object.keys(r.body || {}));
  r = await aget(modCk, `reports/${repId}`);
  ok(r.status === 200 && !('sharedIp' in r.body) && !('ips' in r.body.report) && !/203\.0\.113\./.test(r.text), 'a mod\'s report detail has no address snapshot and no sharedIp');
  r = await aget(modCk, 'reports?status=all');
  ok(r.status === 200 && !/203\.0\.113\./.test(r.text) && !/"ips"/.test(r.text), 'a mod\'s report list has no addresses');
  r = await apost(modCk, `reports/${repId}`, { note: 'mod note' });
  ok(r.status === 200 && !('ips' in r.body.report) && !/203\.0\.113\./.test(r.text), 'a mod\'s report edit response has no addresses');
  ok((await aget(modCk, 'ip/203.0.113.41')).status === 403 && (await aget(modCk, 'ip-bans')).status === 403, 'mods cannot use the address lookup or list IP bans (403)');
  ok((await apost(modCk, 'ip-bans', { ip: '203.0.113.200', reason: 'x' })).status === 403 && (await apost(modCk, 'ip-bans/i1/lift')).status === 403, 'mods cannot create or lift IP bans (403)');
  // ip-view audit: once per admin and target per 10 minutes
  const viewsBefore = (await aget(ownerCk, `audit?action=ip-view&target=${RS_T}`)).body.length;
  for (let i = 0; i < 3; i++) await ipsOf(ownerCk, RS_T);
  r = await aget(ownerCk, `audit?action=ip-view&target=${RS_T}`);
  ok(r.status === 200 && viewsBefore === 0 && r.body.length === 1, 'viewing a player\'s addresses writes one ip-view audit entry (not one per view)', [viewsBefore, r.body.length]);
  await aget(ownerCk, `reports/${repId}`); await aget(ownerCk, `reports/${repId}`);
  r = await aget(ownerCk, `audit?action=ip-view&target=${repId}`);
  ok(r.body.length === 1, 'report detail views are audited once per 10 minutes too', r.body.length);
  await aget(ownerCk, 'ip/203.0.113.41'); await aget(ownerCk, 'ip/203.0.113.41');
  r = await aget(ownerCk, 'audit?action=ip-view&target=ip');
  ok(r.body.length >= 1 && r.body.filter((e) => e.ip === '203.0.113.41').length === 1 && r.body[0].detail === '', 'the address lookup is audited once, the address in the separate ip field', r.body);

  // ---- 2d: IP bans ----
  const BAN_IP = '203.0.113.50', BV = '76561190000006001';
  r = await apost(ownerCk, 'ip-bans', { ip: BAN_IP, reason: 'pass2 test', hours: 1 });
  const ipBanId = r.body && r.body.ipBan && r.body.ipBan.id;
  ok(r.status === 200 && !!ipBanId && r.body.ipBan.value === BAN_IP, 'owner creates an IP ban', [r.status, r.body]);
  r = await login(F, BV, {}, XFF(BAN_IP));
  ok(r.status === 403 && r.body.error === 'forbidden' && r.body.metadata && r.body.metadata.cause === 'app-banned', 'login from a banned address: 403 in the same shape as an account ban', [r.status, r.body]);
  r = await login(F, BV, {}, XFF('203.0.113.51'));
  ok(r.status === 200, 'login from another address is fine');
  const tokBV = r.token;
  let wsb = await wsConnect(F, '/ws', { Authorization: `Token ${tokBV}`, 'app-id': 'sostest', ...XFF(BAN_IP) });
  ok(wsb.status === 403, 'matchmaking WebSocket from a banned address: 403', wsb.status);
  wsb = await wsConnect(F, '/ws/stream', XFF(BAN_IP));
  ok(wsb.status === 403, 'stream WebSocket from a banned address: 403', wsb.status);
  r = await req(F, 'POST', `/api/servers/${F_SID}/join-hint`, { body: {}, headers: { ...bearer(tokBV), ...XFF(BAN_IP) } });
  ok(r.status === 403, 'join-hint from a banned address: 403', r.status);
  r = await req(F, 'POST', '/api/reports', { body: { target: RS_T, reason: 'x' }, headers: { ...bearer(tokBV), ...XFF(BAN_IP) } });
  ok(r.status === 403, 'report filing from a banned address: 403', r.status);
  r = await req(F, 'GET', '/api/account', { headers: { ...bearer(tokBV), ...XFF(BAN_IP) } });
  ok(r.status === 200, 'plain reads are not blocked by an IP ban (only login, sockets, join-hint and reports)', r.status);
  r = await aget(ownerCk, 'ip/' + BAN_IP);
  ok(r.body.banned === true && r.body.ban && r.body.ban.id === ipBanId, 'the address lookup says it is banned');
  r = await apost(ownerCk, 'ip-bans', { ip: BAN_IP, reason: 'again' });
  ok(r.status === 409, 'the same address cannot be banned twice while active (409)', r.status);
  // CIDR
  r = await apost(ownerCk, 'ip-bans', { ip: '198.51.100.77/24', reason: 'range', hours: 1 });
  ok(r.status === 200 && r.body.ipBan.value === '198.51.100.0/24' && r.body.ipBan.kind === 'cidr', 'an IPv4 CIDR ban is stored as its network', r.body.ipBan);
  const cidrId = r.body.ipBan.id;
  r = await login(F, BV, {}, XFF('198.51.100.200'));
  ok(r.status === 403, 'login from inside the banned CIDR: 403', r.status);
  r = await login(F, BV, {}, XFF('203.0.113.201'));
  ok(r.status === 200, 'login from an address outside the CIDR is fine', r.status);
  // IPv6
  r = await apost(ownerCk, 'ip-bans', { ip: '2001:DB8::99', reason: 'v6', hours: 1 });
  ok(r.status === 200 && r.body.ipBan.value === '2001:db8::99', 'an IPv6 address can be banned (normalized)', r.body);
  r = await login(F, BV, {}, XFF('2001:db8:0:0:0:0:0:99'));
  ok(r.status === 403, 'the ban matches the other spelling of the same IPv6 address', r.status);
  // refusals
  const refused = [];
  for (const v of ['127.0.0.1', '10.0.0.0/16', '10.1.2.3', '172.20.0.5', '172.16.0.0/16', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '0.0.0.0', PROXY_TEST, '192.0.2.0/24', '203.0.113.0/8', '203.0.113.0/15', 'nonsense', '', '1.2.3.4/33', '1.2.3.4/abc', '203.0.113.1/']) {
    const x = await apost(ownerCk, 'ip-bans', { ip: v, reason: 'must fail' });
    if (x.status !== 400) refused.push([v, x.status]);
  }
  ok(refused.length === 0, 'banning loopback/private ranges, the trusted proxy, ranges covering it, or malformed targets is refused (400)', refused);
  r = await apost(ownerCk, `ip-bans/${ipBanId}/lift`);
  ok(r.status === 200, 'owner lifts the IP ban', r.status);
  r = await login(F, BV, {}, XFF(BAN_IP));
  ok(r.status === 200, 'login from the lifted address works again', r.status);
  wsb = await wsConnect(F, '/ws', { Authorization: `Token ${r.token}`, 'app-id': 'sostest', ...XFF(BAN_IP) });
  ok(wsb.status === 101, 'matchmaking WebSocket works again after the lift', wsb.status);
  wsb.socket.destroy();
  r = await apost(ownerCk, `ip-bans/${ipBanId}/lift`);
  ok(r.status === 404, 'lifting twice: 404', r.status);
  await apost(ownerCk, `ip-bans/${cidrId}/lift`);
  r = await aget(ownerCk, 'ip-bans');
  ok(r.status === 200 && Array.isArray(r.body.bans) && r.body.bans.length === 1 && r.body.bans[0].value === '2001:db8::99', 'GET /admin/api/ip-bans lists the active bans', r.body);
  r = await aget(ownerCk, 'ip-bans?all=1');
  ok(r.body.bans.length === 3 && r.body.bans.filter((b) => b.lifted).length === 2, 'all=1 includes the lifted ones', r.body.bans.length);

  // audit: the ip field for owners, never for mods
  r = await aget(ownerCk, 'audit?limit=500');
  const ipEntries = r.body.filter((e) => e.action === 'ip-ban' || e.action === 'ip-unban');
  ok(ipEntries.length >= 5 && ipEntries.every((e) => typeof e.ip === 'string' && e.ip) && ipEntries.every((e) => !/\d+\.\d+\.\d+\.\d+/.test(e.detail) && !/\d+\.\d+\.\d+\.\d+/.test(e.target)), 'owner audit: ip-ban / ip-unban entries carry the address in the ip field only', ipEntries.length);
  r = await aget(modCk, 'audit?limit=500');
  ok(r.status === 200 && r.body.some((e) => e.action === 'ip-ban') && r.body.every((e) => !('ip' in e)) && !/\d+\.\d+\.\d+\.\d+/.test(r.text), 'mod audit: same entries, no ip field, no address anywhere', r.status);
  r = await req(F, 'GET', '/admin/api/audit.csv?limit=500', { headers: { Cookie: modCk } });
  ok(r.status === 200 && r.text.split('\r\n')[0] === 'at,by,byName,action,target,detail' && !/\d+\.\d+\.\d+\.\d+/.test(r.text) && /ip-ban/.test(r.text), 'mod audit.csv: no ip column and no address', r.text.split('\r\n')[0]);
  r = await req(F, 'GET', '/admin/api/audit.csv?limit=500', { headers: { Cookie: ownerCk } });
  ok(r.status === 200 && r.text.split('\r\n')[0] === 'at,by,byName,action,target,detail,ip' && /,ip-ban,[^,]*,[^,]*,203\.0\.113\.50/.test(r.text), 'owner audit.csv: ip column with the address', r.text.split('\r\n')[0]);

  // ---- 2g: no IP literals in any log file ----
  await sleep(300);
  {
    const lit = /(?:\d{1,3}\.){3}\d{1,3}/, v6 = { test: (l) => (l.match(/[0-9a-f:.]{3,}/gi) || []).some((t) => (t.match(/:/g) || []).length >= 2 && net.isIPv6(t)) };
    const bad = [];
    let xffLogged = false;
    for (const f of fs.readdirSync(F.dir).filter((n) => /\.jsonl(\.1)?$/.test(n))) {
      for (const line of fs.readFileSync(path.join(F.dir, f), 'utf8').split('\n')) {
        if (!line) continue;
        if (lit.test(line) || v6.test(line)) bad.push([f, line.slice(0, 160)]);
        if (/"x-forwarded-for":"ip-redacted"/.test(line)) xffLogged = true;
      }
    }
    ok(bad.length === 0, 'log files (http, ws, admin, errors) contain no IPv4/IPv6 literals after the whole run', bad.slice(0, 3));
    ok(xffLogged, 'X-Forwarded-For headers are logged as ip-redacted');
    const secretsInDb = fs.readFileSync(path.join(F.dir, 'db.json'), 'utf8');
    ok(/ipHistory/.test(secretsInDb), 'sanity: the addresses themselves are kept in db.json (owner-only data)');
  }
  F.proc.kill(); await sleep(200);

  // ---- 1b: per-reporter / per-address caps on open reports ----
  const G = await startBackend('g', { OGSOS_RATE_LOGIN: '1000', OGSOS_RATE_REPORT: '1000', OGSOS_RATE_GLOBAL: '100000' }, {
    seed: (dir) => {
      const RSEED = '76561190000007000';
      const reports = [];
      for (let i = 1; i <= 20; i++) reports.push({ id: `r${i}`, at: new Date().toISOString(), source: 'api', status: 'open', reporter: { id: RSEED, name: 'seed' }, target: { id: `76561190000007${String(100 + i)}`, name: 'x' }, reason: 'x', text: '', snapshot: {}, notes: [], assignee: null });
      fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ accounts: {}, appData: {}, moderation: { reports, seq: 20 } }));
    },
  });
  ok(await waitUp(G), 'backend G up');
  {
    const tk = (await login(G, '76561190000007000', {}, XFF('203.0.113.60'))).token;
    r = await req(G, 'POST', '/api/reports', { body: { target: '76561190000007900', reason: 'x' }, headers: { ...bearer(tk), ...XFF('203.0.113.60') } });
    ok(r.status === 429 && r.body.error === 'too-many-open-reports', 'a reporter with 20 open reports cannot file more (429)', [r.status, r.body]);
    const codes2 = [];
    for (let a = 0; a < 4; a++) {
      const rid = `7656119000000710${a}`;
      const t2 = (await login(G, rid, {}, XFF('203.0.113.61'))).token;
      for (let k = 0; k < 8; k++) codes2.push((await req(G, 'POST', '/api/reports', { body: { target: `7656119000000720${a}${k}`, reason: 'x' }, headers: { ...bearer(t2), ...XFF('203.0.113.61') } })).status);
    }
    ok(codes2.slice(0, 30).every((x) => x === 200) && codes2[30] === 429, 'one client address can hold 30 open reports (across accounts); the 31st is refused (429)', codes2.join(''));
    const t3 = (await login(G, '76561190000007200', {}, XFF('203.0.113.62'))).token;
    r = await req(G, 'POST', '/api/reports', { body: { target: '76561190000007901', reason: 'x' }, headers: { ...bearer(t3), ...XFF('203.0.113.62') } });
    ok(r.status === 200, 'another address is unaffected', r.status);
  }
  G.proc.kill(); await sleep(200);

  // ---- 2f: retention ----
  {
    const DAY = 86400000, agoIso = (d) => new Date(Date.now() - d * DAY).toISOString();
    const row = (d) => ({ first: agoIso(d + 1), last: agoIso(d), count: 3 });
    const ent = (map) => { const ips = Object.create(null); let lastIp = null, firstIp = null, lastD = 1e9, firstD = -1; for (const [ip, d] of Object.entries(map)) { ips[ip] = row(d); if (d < lastD) { lastD = d; lastIp = ip; } if (d > firstD) { firstD = d; firstIp = ip; } } return { first: { ip: firstIp, at: agoIso(firstD + 1) }, last: { ip: lastIp, at: agoIso(lastD) }, ips }; };
    const A_OLD = '76561190000008001', A_REP = '76561190000008002', A_BAN = '76561190000008003', A_NEW = '76561190000008004', A_MIX = '76561190000008005', A_LIFT = '76561190000008006';
    const accounts = {};
    for (const id of [A_OLD, A_REP, A_BAN, A_NEW, A_MIX, A_LIFT, OWNER]) accounts[id] = { id, 'account-id': id, alias: `p-${id.slice(-4)}`, 'display-name': `p-${id.slice(-4)}`, created: agoIso(200), identities: [] };
    const ipHistory = {
      [A_OLD]: ent({ '203.0.113.70': 100 }), [A_REP]: ent({ '203.0.113.71': 100 }), [A_BAN]: ent({ '203.0.113.72': 100 }), [A_NEW]: ent({ '203.0.113.73': 10 }),
      [A_MIX]: ent({ '203.0.113.74': 100, '203.0.113.75': 5 }), [A_LIFT]: ent({ '203.0.113.76': 120 }),
    };
    const report = { id: 'r1', at: agoIso(95), source: 'api', status: 'open', reporter: { id: A_NEW, name: 'x' }, target: { id: A_REP, name: 'x' }, reason: 'x', text: '', snapshot: {}, notes: [], assignee: null, ips: { target: { last: '203.0.113.71', recent: [{ ip: '203.0.113.71', last: agoIso(100) }] }, reporter: { last: null } } };
    const bans = [{ id: 'i2', kind: 'ip', value: '203.0.113.72', reason: 'old', code: 'other', by: OWNER, at: agoIso(110), expiresAt: null, lifted: false },
      { id: 'i3', kind: 'ip', value: '203.0.113.76', reason: 'lifted', code: 'other', by: OWNER, at: agoIso(130), expiresAt: null, lifted: { by: OWNER, at: agoIso(125) } }];
    const Hn = await startBackend('h', { OGSOS_ADMINS: OWNER, OGSOS_ADMIN_DEV_LOGIN: '1' }, { seed: (dir) => fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ accounts, appData: {}, ipHistory, moderation: { reports: [report], ipBans: bans, seq: 5 } })) });
    ok(await waitUp(Hn), 'backend H (retention) up');
    const d = await req(Hn, 'GET', `/admin/dev-login?steamid=${OWNER}`);
    const ck = d.headers['set-cookie'][0].split(';')[0];
    const prof = async (id) => { const x = await req(Hn, 'GET', `/admin/api/players/${id}`, { headers: { Cookie: ck } }); return ((x.body && x.body.ips && x.body.ips.list) || []).map((e) => e.ip); };
    ok((await prof(A_OLD)).length === 0, 'retention: an address last seen 100 days ago is dropped at startup (and the empty account entry with it)');
    ok((await prof(A_REP)).join() === '203.0.113.71', 'retention: an old address that is in a stored report snapshot is kept');
    ok((await prof(A_BAN)).join() === '203.0.113.72', 'retention: an old address with an active IP ban record is kept');
    ok((await prof(A_LIFT)).join() === '203.0.113.76', 'retention: an old address with a lifted IP ban record is kept');
    ok((await prof(A_NEW)).join() === '203.0.113.73', 'retention: a recent address is kept');
    ok((await prof(A_MIX)).join() === '203.0.113.75', 'retention: of two addresses only the old unprotected one goes (last/first are repaired)');
    const x = await req(Hn, 'GET', `/admin/api/players/${A_MIX}`, { headers: { Cookie: ck } });
    ok(x.body.ips.last.ip === '203.0.113.75' && x.body.ips.first.ip === '203.0.113.75', 'retention: first/last point at an address that still exists', x.body.ips);
    Hn.proc.kill(); await sleep(200);
  }

  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  setTimeout(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } }, 500);
  console.log(fail ? `${pass} passed, ${fail} failed` : `ALL OK (${pass})`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); for (const k of kids) { try { k.kill(); } catch { /* gone */ } } process.exitCode = 1; });
