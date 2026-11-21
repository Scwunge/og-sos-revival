// End-to-end moderation test through a hosted Classic session (no game needed).
//   node tools/moderation_kick_test.js [port]
// The backend must run on 127.0.0.1:<port> (default 7795) with, for example (bash):
//   OGSOS_ADMINS=76561198000000001 OGSOS_ADMIN_DEV_LOGIN=1 \
//   OGSOS_CLASSIC_HOSTS='[{"host":"127.0.0.1","port":7777,"sessionId":"11111111-2222-3333-4444-555555555555","sessionToken":"testtoken123","name":"Test host"}]' \
//   OGSOS_STATE_DIR=<tmp>/state OGSOS_LOG_DIR=<tmp>/logs node server/server.js --port 7795
// Checks: a player seated over /ws shows in the host's session GET; a report filed while seated records the session
// and gets the matchId at match-end; an admin kick drops the player from the host's player-map (the game then kicks
// them, "Not In Session"); a ban closes their matchmaking socket, refuses a new one and a new login.
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || 7795);
const HOST = '127.0.0.1';
const SID = '11111111-2222-3333-4444-555555555555';
const HOST_TOKEN = 'testtoken123';
const ADMIN = '76561198000000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: HOST, port: PORT, path: p, method,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: s, json: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const login = async (steamId) => req('POST', '/api/access-token/steam', { 'steam-app-id': '802240', 'steam-id': steamId, 'session-auth-token': 'x', 'app-id': 'sostest' }, { 'app-id': 'sostest' });

class Ws {
  static connect(token) {
    return new Promise((resolve) => {
      const sock = net.connect(PORT, HOST);
      const ws = new Ws(sock);
      sock.write(`GET /ws HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n` +
        `Authorization: Token ${token}\r\napp-id: sostest\r\n\r\n`);
      ws.onHandshake = (status) => resolve({ ws, status });
      sock.on('error', () => {});
    });
  }
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.shook = false; this.msgs = []; this.closed = false;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    sock.on('close', () => { this.closed = true; });
  }
  pump() {
    if (!this.shook) {
      const i = this.buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = this.buf.subarray(0, i).toString();
      this.buf = this.buf.subarray(i + 4); this.shook = true;
      this.onHandshake(Number(head.split('\r\n')[0].split(' ')[1]));
    }
    while (this.buf.length >= 2) {
      const opcode = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (opcode === 1) this.msgs.push(JSON.parse(payload.toString()));
    }
  }
  send(type, data) {
    const payload = Buffer.from(JSON.stringify(data === undefined ? { type } : { type, data }));
    const mask = crypto.randomBytes(4);
    const head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
    this.sock.write(Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]));
  }
  async take(type, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const i = this.msgs.findIndex((m) => m.type === type);
      if (i >= 0) return this.msgs.splice(i, 1)[0];
      await sleep(25);
    }
    throw new Error(`timeout waiting for "${type}"`);
  }
  close() { try { this.sock.end(); } catch {} }
}

let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
}

(async () => {
  const hostGet = () => req('GET', `/api/session/${SID}`, undefined, { Authorization: `Token ${HOST_TOKEN}` });
  await hostGet();   // the host is "online" after its first authenticated poll
  const dev = await req('GET', `/admin/dev-login?steamid=${ADMIN}`);
  const cookie = String((dev.headers['set-cookie'] || [])[0] || '').split(';')[0];
  const admin = (method, p, body) => req(method, `/admin/api/${p}`, body, { Cookie: cookie, 'X-OGSOS-Admin': '1' });
  const suffix = String(Date.now()).slice(-6);
  const P1 = `7656119800${suffix}1`, P2 = `7656119800${suffix}2`;
  let w1, w2, tok1, tok2, reportId;

  await check('two players log in and are seated in the hosted Classic session', async () => {
    assert(cookie.startsWith('ogsos_admin='), 'dev-login cookie (is OGSOS_ADMIN_DEV_LOGIN=1 set?)');
    tok1 = (await login(P1)).json['access-token']; tok2 = (await login(P2)).json['access-token'];
    ({ ws: w1 } = await Ws.connect(tok1)); ({ ws: w2 } = await Ws.connect(tok2));
    for (const w of [w1, w2]) { await w.take('ready'); w.send('find-session', { opts: {} }); await w.take('session'); }
    const pm = (await hostGet()).json['player-map'];
    assert(pm[P1] && pm[P2], `host player-map ${JSON.stringify(Object.keys(pm))}`);
  });

  await check('admin servers view lists both seated players', async () => {
    const s = (await admin('GET', 'servers')).json.servers.find((x) => x.id === SID);
    assert(s, 'session listed');
    const ids = s.players.map((p) => p.id);
    assert(ids.includes(P1) && ids.includes(P2), JSON.stringify(ids));
    assert(!JSON.stringify(s).includes(HOST_TOKEN), 'no host token in the admin view');
  });

  await check('a report filed while seated records the session and both players', async () => {
    const r = await req('POST', `/api/account/${P2}/report`, { reason: 'cheating', comment: 'aimbot e2e' }, { Authorization: `Bearer ${tok1}`, 'app-id': 'sostest' });
    assert(r.status === 200, `report ${r.status} ${r.body}`);
    reportId = r.json.data.id;
    const d = (await admin('GET', `reports/${reportId}`)).json;
    assert(d.report.sessionId === SID, `sessionId ${d.report.sessionId}`);
    assert(d.report.snapshot.session && d.report.snapshot.session.players.includes(P2), 'snapshot session players');
    assert(d.report.snapshot.session.game === 'classic', 'snapshot session game');
  });

  await check('admin kick drops the player from the host player-map', async () => {
    const k = await admin('POST', 'kick', { sessionId: SID, playerId: P2, reason: 'e2e kick' });
    assert(k.status === 200, `kick ${k.status} ${k.body}`);
    const pm = (await hostGet()).json['player-map'];
    assert(!pm[P2] && pm[P1], `after kick ${JSON.stringify(Object.keys(pm))}`);
    const again = await admin('POST', 'kick', { sessionId: SID, playerId: P2 });
    assert(again.status === 404, `second kick ${again.status}`);
  });

  await check('match-end from the host links the report to the match record', async () => {
    const e = await req('POST', `/session/${SID}/events`, { type: 'match-end', matchId: `e2e-${suffix}`, players: [{ playerId: P1, kills: 3, deaths: 1 }, { playerId: P2, kills: 9, deaths: 0 }] }, { Authorization: `Token ${HOST_TOKEN}` });
    assert(e.status === 200, `events ${e.status}`);
    const d = (await admin('GET', `reports/${reportId}`)).json;
    assert(d.report.matchId === `e2e-${suffix}`, `matchId ${d.report.matchId}`);
    assert(d.match && d.match.players.some((p) => p.playerId === P2 && p.kills === 9), 'match record attached');
  });

  await check('ban closes the socket, refuses /ws and login; lift restores login', async () => {
    w2.close();
    ({ ws: w2 } = await Ws.connect(tok2)); await w2.take('ready');
    const b = await admin('POST', 'bans', { steamId: P2, reason: 'e2e ban', hours: 1 });
    assert(b.status === 200, `ban ${b.status} ${b.body}`);
    await sleep(300);
    assert(w2.closed, 'matchmaking socket closed by the ban');
    const { status } = await Ws.connect(tok2);
    assert(status === 403, `ws after ban ${status}`);
    assert((await login(P2)).status === 403, 'login refused');
    assert((await admin('POST', `bans/${P2}/lift`, {})).status === 200, 'lift');
    assert((await login(P2)).status === 200, 'login after lift');
  });

  w1.close(); w2.close();
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
