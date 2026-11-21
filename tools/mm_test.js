// Matchmaking smoke test (no game, no dependencies).
//   node tools/mm_test.js [port]      (default 7791; the server must already be running there)
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

(async () => {
  const idA = '76561198000000001', idB = '76561198000000002';
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
    const c1 = (await Ws.connect(await login('76561198000000011'))).ws, c2 = (await Ws.connect(await login('76561198000000012'))).ws;
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
    const cfg = (await Ws.connect(await login('76561198000000021'))).ws; await cfg.next('ready');
    // Expire open sessions' late-join so the player really queues is not needed: just cancel immediately.
    cfg.send('find-session', opts); cfg.send('cancel-find-session');
    await cfg.next('ack'); await cfg.next('ack');
    await sleep(700);
    assert(!cfg.msgs.filter((m) => m.type !== 'summary').length, 'unexpected: ' + JSON.stringify(cfg.msgs));
    cfg.close(); await sleep(300);
  });

  await check('group-find-session -> ack; cancel -> ack; member gets queue-cancel event', async () => {
    const g1 = (await Ws.connect(await login('76561198000000031'))).ws, g2 = (await Ws.connect(await login('76561198000000032'))).ws;
    await g1.next('ready'); await g2.next('ready');
    const grp = (await g1.req('create-group', { opts: opts.opts, 'group-opts': { 'game-mode': 'Deathmatch' } }, 'group')).data.group;
    const j = await g2.req('join-group', { 'group-id': grp.id, opts: opts.opts }, 'group');
    assert(Object.keys(j.data.group.players).length === 2, 'two players');
    const ev = await g1.next('group-event'); assert(ev.data.event === 'join' && ev.data['player-id'] === '76561198000000032', JSON.stringify(ev));
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
