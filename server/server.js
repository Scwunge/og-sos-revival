// OG SOS Revival - replacement backend for the original SOS client.
// No dependencies: run with `node server/server.js [--port 7780]`.
//
// Stage 1 goal: answer every call the client makes with something plausible
// and LOG IT, so we can learn the exact formats the client expects.
// Every request lands in logs/http.jsonl, every WebSocket frame in logs/ws.jsonl.

'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadConfig, createMatchmaker } = require('./matchmaking');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const argPort = process.argv.indexOf('--port');
const PORT = argPort > 0 ? Number(process.argv[argPort + 1]) : 7780;

// ---------- logging ----------
function log(file, entry) {
  entry.t = new Date().toISOString();
  fs.appendFileSync(path.join(LOG_DIR, file), JSON.stringify(entry) + '\n');
}

// ---------- tiny JSON "database" ----------
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { accounts: {}, appData: {}, tokens: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* first run */ }
function saveDb() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

function newToken(accountId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.tokens[token] = accountId;
  saveDb();
  return token;
}
// JWT-shaped token: base64url(header).base64url(claims).base64url(HMAC-SHA256).
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'));
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8');
const b64u = (s) => Buffer.from(s).toString('base64url');
function makeJwt(accountId, steamId, roles, appId) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({
    id: accountId, 'account-id': accountId, 'user-id': accountId, sub: accountId,
    'steam-id': steamId, roles, 'app-id': appId, iat: now, exp: now + 30 * 24 * 3600,
  }));
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${claims}`).digest('base64url');
  return `${header}.${claims}.${sig}`;
}
function readJwt(tok) {
  const [h, c, s] = String(tok).split('.');
  if (!s) return null;
  const want = crypto.createHmac('sha256', SECRET).update(`${h}.${c}`).digest('base64url');
  if (want !== s) return null;
  try { return JSON.parse(Buffer.from(c, 'base64url').toString()); } catch { return null; }
}
function accountFromAuth(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.replace(/^Token\s+/i, '').trim();
  return db.tokens[tok];
}

// The original wraps responses as {"version": ..., "data": {...}}
// (from the client's error strings: 'Failed to get "data"', 'Failed to get "version"').
function wrap(data, version = 1) { return { version, data }; }

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
  return { status, out: buf.length < 4000 ? buf.toString() : `<${buf.length} bytes>` };
}

// ---------- key/value store (live game config) ----------
// The client asks for <EndpointClient>/live-rev.txt, then per-key files under
// that revision. Put files in data/kv/ to serve them; anything missing is logged.
const KV_DIR = path.join(DATA_DIR, 'kv');
fs.mkdirSync(KV_DIR, { recursive: true });
function handleKv(rel, res) {
  if (rel === 'live-rev.txt') {
    const f = path.join(KV_DIR, 'live-rev.txt');
    return send(res, 200, fs.existsSync(f) ? fs.readFileSync(f) : '1', 'text/plain');
  }
  const f = path.normalize(path.join(KV_DIR, rel));
  if (f.startsWith(KV_DIR) && fs.existsSync(f) && fs.statSync(f).isFile()) {
    return send(res, 200, fs.readFileSync(f), f.endsWith('.json') ? 'application/json' : 'application/octet-stream');
  }
  return send(res, 404, 'not found', 'text/plain');
}

// ---------- everything-unlocked app account ----------
let COSMETICS = { items: [], grantableCategories: [] };
try { COSMETICS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cosmetics.json'), 'utf8')); } catch { console.warn('data/cosmetics.json missing: inventory will be empty'); }
// Shape confirmed from the client's parser (docs/INVENTORY_FORMAT.md): read from the top level,
// owned ids are strings in inventory.licenses, wallet is inventory.wallet {coins_paid, coins_free}.
// Wrong-typed fields are skipped silently by the client, so types matter (season-id is a number).
function appAccount() {
  const licenses = COSMETICS.items
    .filter((i) => ['outfit', 'gesture', 'icon', 'license', 'pass'].includes(i.category))
    .map((i) => i.id);
  return {
    inventory: {
      wallet: { coins_paid: 0, coins_free: 999999 },
      licenses,
    },
    season: {
      sp: 0, xp: 0, 'free-tier': 50, 'premium-tier': 50, 'season-id': 1, level: 50,
      'xp-boost': 0, 'has-premium': true,
      'start-date': '2018-01-01T00:00:00Z', 'end-date': '2030-01-01T00:00:00Z',
      'current-level-xp': 0, 'current-free-tier-sp': 0, 'next-level-xp': 1, 'next-free-tier-sp': 1,
    },
    gifts: [],
  };
}

// ---------- REST API ----------
// Routes come from the paths baked into SOS-Win64-Shipping.exe.
function handleApi(req, url, body, res) {
  const p = url.pathname;
  const m = (re) => p.match(re);
  let r;

  // Login. The client posts {"steam-app-id","steam-id","session-auth-token","roles","app-id"}
  // to /api/access-token/steam and expects a JWT-shaped token (it rejects anything not
  // "xxx.yyy.zzz" and reads "claims" from it). Field names are still guesses, so the
  // account id is given under several names until the logs tell us which one it reads.
  // TODO(stage 2): verify session-auth-token with Steam's ISteamUserAuth so ids can't be spoofed.
  if (req.method === 'POST' && (r = m(/^\/api\/access-token(?:\/([^/]+))?$/)) && (r[1] === undefined || r[1] === 'steam')) {
    let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
    const steamId = String(j['steam-id'] || j.steamId || '');
    const accountId = steamId || crypto.createHash('sha1').update(body || '').digest('hex').slice(0, 16);
    db.accounts[accountId] ??= {
      id: accountId, 'account-id': accountId, alias: `player-${accountId.slice(-4)}`,
      'display-name': `player-${accountId.slice(-4)}`, created: new Date().toISOString(),
      identities: steamId ? [{ provider: 'steam', 'provider-data': steamId }] : [],
    };
    db.accounts[accountId]['last-access'] = new Date().toISOString();
    const jwt = makeJwt(accountId, steamId, j.roles || ['app-user'], j['app-id'] || 'sos');
    db.tokens[jwt] = accountId;
    saveDb();
    const payload = { ...db.accounts[accountId], 'user-id': accountId, 'access-token': jwt, token: jwt };
    // Give the fields both at top level and under "data" until we know which the client reads.
    return send(res, 200, { ...payload, version: 1, data: payload });
  }
  // "Crack" a token: the client can ask the server what a token contains.
  if (req.method === 'GET' && (r = m(/^\/api\/access-token\/([^/]+)$/)) && r[1] !== 'once-code') {
    const claims = readJwt(decodeURIComponent(r[1]));
    return claims ? send(res, 200, { ...claims, version: 1, data: claims }) : send(res, 401, wrap({ error: 'unauthorized' }));
  }
  if (p.startsWith('/api/access-token') || p.endsWith('/once-code')) {
    return send(res, 200, wrap({ code: crypto.randomBytes(8).toString('hex') }));
  }

  // Per-game saved data (GetAccountAppData / SetAccountAppData).
  if ((r = m(/^\/api\/account\/([^/]+)\/app\/([^/]+)$/))) {
    const key = `${r[1]}/${r[2]}`;
    if (req.method === 'GET') return send(res, 200, wrap(db.appData[key]?.data ?? {}, db.appData[key]?.version ?? 1));
    let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
    const version = (db.appData[key]?.version ?? 0) + 1;
    db.appData[key] = { version, data: j.data ?? j };
    saveDb();
    return send(res, 200, wrap(db.appData[key].data, version));
  }
  if ((r = m(/^\/api\/account\/([^/]+)$/)) || p === '/api/account') {
    const id = r ? r[1] : accountFromAuth(req);
    const acct = db.accounts[id] ?? { id, 'account-id': id };
    // Same trick as login: fields at top level and under "data" until we know which is read.
    return send(res, 200, { ...acct, version: 1, data: acct });
  }
  if (p.startsWith('/api/account/')) return send(res, 200, wrap({}));   // tos, language, report, identity, accept-ban

  // Inventory: everyone owns every cosmetic (ids from data/cosmetics.json, see docs/INVENTORY_FORMAT.md).
  if (m(/^\/api\/app\/[^/]+\/inventory\//) || m(/^\/api\/app\/[^/]+\/reconcile\//)) {
    return send(res, 200, appAccount());
  }
  // GetAppRewards: {changes:{wallet-delta, new-licenses}, last-level-up}. Nothing new to hand out.
  if (m(/^\/api\/app\/[^/]+\/season\//)) {
    return send(res, 200, { changes: { 'wallet-delta': { coins_paid: 0, coins_free: 0 }, 'new-licenses': [] } });
  }
  // Store: purchases return the (already complete) account; the shop list is empty since everything is owned.
  if (m(/^\/api\/app\/[^/]+\/store\/items\/purchase$/)) return send(res, 200, appAccount());
  if (m(/^\/api\/app\/[^/]+\/store\//)) return send(res, 200, { 'store-view': [] });

  if (p === '/api/log') return send(res, 200, wrap({}));
  if (p.startsWith('/api/leaderboard/')) return send(res, 200, []);
  if (p.startsWith('/api/search/account')) return send(res, 200, wrap(Object.values(db.accounts)));

  return null;
}

// ---------- HTTP server ----------
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://x');
    let result;
    let handled = true;
    try {
      if (url.pathname.startsWith('/kv/')) result = handleKv(url.pathname.slice(4), res);
      else result = handleApi(req, url, body, res);
      if (!result) {
        handled = false;
        result = send(res, 200, wrap({}));   // keep the client moving; flag it in the log
      }
    } catch (e) {
      result = send(res, 500, wrap({ error: String(e) }));
    }
    const entry = { method: req.method, path: req.url, host: req.headers.host, headers: req.headers, body, ...result, handled };
    log('http.jsonl', entry);
    console.log(`${handled ? '   ' : '?? '}${req.method} ${req.url} -> ${result.status}`);
  });
});

// ---------- WebSocket (matchmaking at /ws) ----------
// Minimal RFC 6455: handshake, text/binary frames, ping/pong, close. The matchmaking protocol
// itself lives in server/matchmaking.js (see docs/MATCHMAKING.md); every frame is logged.
const CONFIG = loadConfig(DATA_DIR);
const mm = createMatchmaker({
  config: CONFIG,
  getUname: (id) => db.accounts[id]?.['display-name'] || db.accounts[id]?.alias || id,
  log: (m) => { log('ws.jsonl', { event: 'mm', text: m }); console.log(`mm ${m}`); },
});

function wsAccount(req) {
  const tok = String(req.headers['authorization'] || '').replace(/^Token\s+/i, '').trim();
  const claims = tok && readJwt(tok);
  if (!claims || (claims.exp && claims.exp < Date.now() / 1000)) return null;
  return String(claims['account-id'] || claims.id || '') || null;
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  socket.on('error', () => {});
  const isMm = new URL(req.url, 'http://x').pathname === '/ws';
  const accountId = isMm ? wsAccount(req) : null;
  if (isMm && !accountId) {
    log('ws.jsonl', { event: 'rejected', path: req.url, reason: 'missing or invalid token', headers: req.headers });
    console.log(`ws rejected ${req.url} (401)`);
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const proto = req.headers['sec-websocket-protocol'];
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` + (proto ? `Sec-WebSocket-Protocol: ${proto.split(',')[0].trim()}\r\n` : '') + '\r\n');
  const id = crypto.randomBytes(4).toString('hex');
  log('ws.jsonl', { id, event: 'open', path: req.url, account: accountId, headers: req.headers });
  console.log(`ws ${id} open ${req.url}${accountId ? ` account ${accountId}` : ''}`);

  const sendFrame = (opcode, payload) => {
    if (socket.destroyed || !socket.writable) return;
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | opcode, len])
      : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
    socket.write(Buffer.concat([head, payload]));
  };

  // Matchmaking client for this connection. Non-/ws paths (e.g. stream client) are log-only.
  let client = null;
  if (isMm) {
    client = {
      id: accountId, connId: id,
      sendMsg(type, data) {
        const text = JSON.stringify(data === undefined ? { type } : { type, data });
        sendFrame(0x1, Buffer.from(text));
        log('ws.jsonl', { id, event: 'sent', text });
        console.log(`ws ${id} -> ${text.slice(0, 200)}`);
      },
      close() { sendFrame(0x8, Buffer.alloc(0)); socket.end(); },
    };
    mm.onConnect(client);
  }

  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      }
      buf = buf.subarray(need);

      if (opcode === 0x8) { sendFrame(0x8, Buffer.alloc(0)); socket.end(); return; }
      if (opcode === 0x9) { sendFrame(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      const text = payload.toString('utf8');
      log('ws.jsonl', { id, event: 'msg', opcode, text });
      console.log(`ws ${id} <- ${text.slice(0, 200)}`);
      if (client) mm.onMessage(client, text);
    }
  });
  socket.on('close', () => {
    if (client) mm.onClose(client);
    log('ws.jsonl', { id, event: 'close' });
    console.log(`ws ${id} closed`);
  });
});

server.listen(PORT, () => {
  console.log(`OG SOS Revival backend listening on http://0.0.0.0:${PORT}`);
  console.log(`Logs: ${LOG_DIR}   ("??" lines = calls we don't handle yet)`);
});
