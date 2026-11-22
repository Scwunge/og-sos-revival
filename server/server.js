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
const net = require('net');
const { loadConfig, createMatchmaker, parseHosts, pickPublicHost, cleanLabel, readSessionJwt, DEFAULTS } = require('./matchmaking');
const { refreshPersona } = require('./persona');
const { createProgression } = require('./progression');
const { createCommunityRegistry, loadCommunityConfig } = require('./community');
const { createStream } = require('./stream');   // hero-tv
const { createFame } = require('./fame');       // hero-tv
const { createModeration } = require('./admin');   // moderation
const { limiter, envInt } = require('./ratelimit');
const { sanitize } = require('./logsafe');
const { badKey, nullProto, nullProtoDeep, STEAM_ID_RE } = require('./safe');

const ROOT = path.resolve(__dirname, '..');
// OGSOS_LOG_DIR / OGSOS_STATE_DIR move the writable files (logs; db.json + secret.key) out of the
// repo, e.g. onto a Docker volume. data/ itself (kv, cosmetics, config.json) stays read-only.
const LOG_DIR = process.env.OGSOS_LOG_DIR || path.join(ROOT, 'logs');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_DIR = process.env.OGSOS_STATE_DIR || DATA_DIR;
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

const argPort = process.argv.indexOf('--port');
const PORT = argPort > 0 ? Number(process.argv[argPort + 1]) : 7780;
// --public-host <ipv4>: address handed to clients in session/session-started (wins over env and config file, both builds).
const argPublic = process.argv.indexOf('--public-host');
const FLAG_PUBLIC_HOST = argPublic > 0 ? process.argv[argPublic + 1] : undefined;

// ---------- logging ----------
// Every entry passes through server/logsafe.js (credentials masked, strings cut to 2 KB). Files rotate at LOG_MAX_BYTES:
// <file> is renamed to <file>.1 (replacing the previous .1) and a fresh file starts. The size is checked every
// ~1000 writes or every 10 s per file, not on every write. log() never throws.
const LOG_MAX_BYTES = envInt('OGSOS_LOG_MAX_BYTES', 50 * 1024 * 1024);
const logState = new Map();   // file -> { writes, checked }
function rotateIfNeeded(full) {
  let st = logState.get(full);
  if (!st) logState.set(full, (st = { writes: 0, checked: 0 }));
  st.writes++;
  const t = Date.now();
  if (st.writes % 1000 !== 1 && t - st.checked < 10000) return;
  st.checked = t;
  try {
    if (fs.statSync(full).size > LOG_MAX_BYTES) {
      try { fs.unlinkSync(`${full}.1`); } catch { /* none yet */ }
      fs.renameSync(full, `${full}.1`);
    }
  } catch { /* no file yet */ }
}
function log(file, entry) {
  try {
    const e = sanitize(entry);
    e.t = new Date().toISOString();
    const full = path.join(LOG_DIR, file);
    rotateIfNeeded(full);
    fs.appendFileSync(full, JSON.stringify(e) + '\n');
  } catch { /* disk full, bad entry: never take the caller down */ }
}

// Probe log: requests that look like scanning (unhandled paths, known probe paths, 4xx/429) WITH their client IP, one
// file per UTC day (probes-YYYY-MM-DD.jsonl), files older than OGSOS_PROBE_LOG_DAYS (14) deleted. This is the one log
// that keeps addresses (owner-only, on the server; see docs/SECURITY.md); http.jsonl stays IP-redacted.
const PROBE_PATH = /(\/\.(git|svn|hg|env|aws|ssh|DS_Store)|wp-|\.php|\/cgi-bin|phpmyadmin|\/actuator|\/server-status|\/vendor\/|\/backup|\.\.\/|\.\.%2f)/i;
const PROBE_DAYS = envInt('OGSOS_PROBE_LOG_DAYS', 14);
let probePruned = 0;
function logProbe(req, ip, status, handled) {
  const p = String(req.url || '');
  if (handled && !PROBE_PATH.test(p) && ![400, 401, 403, 405, 413, 429].includes(status)) return;
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const ua = String(req.headers['user-agent'] || '').slice(0, 200);
    fs.appendFileSync(path.join(LOG_DIR, `probes-${day}.jsonl`), JSON.stringify({ t: now.toISOString(), ip, method: String(req.method).slice(0, 16), path: p.slice(0, 300), host: String(req.headers.host || '').slice(0, 100), status, handled, ua }) + '\n');
    if (Date.now() - probePruned > 3600e3) {
      probePruned = Date.now();
      const cutoff = new Date(Date.now() - PROBE_DAYS * 86400e3).toISOString().slice(0, 10);
      for (const f of fs.readdirSync(LOG_DIR)) {
        const m = /^probes-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (m && m[1] < cutoff) try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* never take the caller down */ }
}

// ---------- tiny JSON "database" ----------
// Saves are atomic (db.json.tmp then rename) and debounced (1 s, coalesced); SIGTERM/SIGINT flush. The first save of a
// process keeps the previous db.json as db.json.bak. A db.json that exists but does not parse is never replaced by an
// empty db: the .bak is tried, and if that fails too the process exits with code 1.
const DB_FILE = path.join(STATE_DIR, 'db.json');
const DB_TMP = `${DB_FILE}.tmp`;
const DB_BAK = `${DB_FILE}.bak`;
function loadDb() {
  let raw;
  try { raw = fs.readFileSync(DB_FILE, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { accounts: {}, appData: {} };   // first run
    console.error(`FATAL: cannot read ${DB_FILE}: ${e && e.message}`); process.exit(1);
  }
  try { const j = JSON.parse(raw); if (j && typeof j === 'object' && !Array.isArray(j)) return j; throw new Error('not an object'); } catch (e) {
    console.error(`ERROR: ${DB_FILE} is corrupt (${e && e.message}); trying ${DB_BAK}`);
  }
  try {
    const j = JSON.parse(fs.readFileSync(DB_BAK, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object');
    console.error(`WARNING: loaded the backup ${DB_BAK}; changes since that backup are lost`);
    return j;
  } catch (e) {
    console.error(`FATAL: ${DB_FILE} is corrupt and ${DB_BAK} is missing or corrupt (${e && e.message}). Refusing to start with an empty database; restore a backup into ${STATE_DIR} (see docs/SECURITY.md).`);
    process.exit(1);
  }
}
let db = loadDb();
// Prototype-free id-keyed maps: an id such as "__proto__" or "constructor" can never hit Object.prototype.
db.accounts = nullProto(db.accounts && typeof db.accounts === 'object' ? db.accounts : {});
db.appData = nullProto(db.appData && typeof db.appData === 'object' ? db.appData : {});
db.leaderboards = nullProtoDeep(db.leaderboards && typeof db.leaderboards === 'object' ? db.leaderboards : {}, 2);
db.heroStats = nullProto(db.heroStats && typeof db.heroStats === 'object' ? db.heroStats : {});
db.playerStats = nullProto(db.playerStats && typeof db.playerStats === 'object' ? db.playerStats : {});
db.fameMatches = nullProtoDeep(db.fameMatches && typeof db.fameMatches === 'object' ? db.fameMatches : {}, 1);
for (const k of Object.keys(db.leaderboards)) { const b = db.leaderboards[k]; if (b && typeof b === 'object') b.scores = nullProto(b.scores && typeof b.scores === 'object' ? b.scores : {}); }
if (db.moderation && typeof db.moderation === 'object') {
  for (const k of ['bans', 'notes', 'warnings', 'mods', 'lobbyOptions', 'kv']) if (db.moderation[k] && typeof db.moderation[k] === 'object' && !Array.isArray(db.moderation[k])) db.moderation[k] = nullProto(db.moderation[k]);
}
delete db.tokens;   // JWTs are verified by signature (readJwt); they are no longer stored

let dbTimer = null, dbBackedUp = false;
function writeDb() {
  if (!dbBackedUp) {
    dbBackedUp = true;
    try { JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); fs.copyFileSync(DB_FILE, DB_BAK); } catch { /* no db.json yet, or unparseable: keep the older .bak */ }
  }
  fs.writeFileSync(DB_TMP, JSON.stringify(db));
  fs.renameSync(DB_TMP, DB_FILE);
}
function saveDbNow() {
  if (dbTimer) { clearTimeout(dbTimer); dbTimer = null; }
  try { writeDb(); } catch (e) { console.error(`!! saveDb: ${e && e.message}`); try { log('errors.jsonl', { saveDb: true, error: String(e && e.message) }); } catch { /* ignore */ } }
}
function saveDb() {
  if (dbTimer) return;
  dbTimer = setTimeout(() => { dbTimer = null; saveDbNow(); }, 1000);
}
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { if (shuttingDown) return; shuttingDown = true; saveDbNow(); process.exit(0); });
}

// JWT-shaped token: base64url(header).base64url(claims).base64url(HMAC-SHA256).
const SECRET_FILE = path.join(STATE_DIR, 'secret.key');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8');
if (SECRET.trim().length < 32) { console.error(`FATAL: ${SECRET_FILE} holds fewer than 32 characters; refusing to sign tokens with a weak key. Delete it to generate a new one (this signs every player out).`); process.exit(1); }
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
// Verifies the HS256 signature (header alg pinned, constant-time compare) and the numeric exp claim. Null when invalid or expired.
function readJwt(tok) {
  const parts = String(tok).split('.');
  if (parts.length !== 3 || !parts[2]) return null;
  const [h, c, s] = parts;
  try {
    const head = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (!head || typeof head !== 'object' || head.alg !== 'HS256') return null;
    const want = Buffer.from(crypto.createHmac('sha256', SECRET).update(`${h}.${c}`).digest('base64url'));
    const got = Buffer.from(s);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    if (!claims || typeof claims !== 'object' || typeof claims.exp !== 'number' || !(claims.exp > Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}
// ---------- SOS: Classic (Steam app 802240, see docs/CLASSIC.md) ----------
// Classic logs in with app-id "sostest" and sends an `app-id` header on every HTTP request.
// It has no inventory/store, reads its own live-config keys, and gates matchmaking on the
// `testserver` role (or KV UE_CLIENT_TEST_SERVER_ENABLED). Options live under "classic" in
// data/config.json (see data/config.example.json).
const CLASSIC_APP = 'sostest';
const isClassic = (appId) => appId === CLASSIC_APP;
function readClassicOptions() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')).classic || {}; } catch { /* none */ }
  const list = (v) => (Array.isArray(v) ? v.map(String) : []);
  return {
    extraRoles: list(file.EXTRA_ROLES),
    devAccounts: list(file.DEV_ACCOUNTS),   // account ids or Steam ids that also get the `dev` role
    mm: file,                               // matchmaking overrides (GAME_SERVER_PORT etc.), merged below
  };
}
const CLASSIC = readClassicOptions();
// Classic cosmetics have no inventory: an outfit part is shown if its Status is Released, its
// numeric `Entitlement` (a Steam DLC id) is owned, and its `AppRole` is one of the player's roles.
// `alpha-beta` is the only AppRole on any cosmetic (the two Alpha/Beta T-shirts on all 12
// characters, docs/CLASSIC_CONTENT.md), so granting it unlocks everything the backend can.
const CLASSIC_COSMETIC_ROLES = ['alpha-beta'];
// AppRoles is matched as a space-separated list; `user` keeps the GrantApp step a no-op,
// `testserver` opens matchmaking even if the KV switch is off.
// Roles are computed here; whatever roles the client asks for in the login body are ignored.
function classicRoles(accountId, steamId) {
  const roles = new Set(['app-user', 'user', 'testserver', ...CLASSIC_COSMETIC_ROLES, ...CLASSIC.extraRoles]);
  if (CLASSIC.devAccounts.includes(accountId) || (steamId && CLASSIC.devAccounts.includes(steamId))) roles.add('dev');
  // moderation: admins get the dev role (Director button and server browser in Classic); env read each time
  // (owners from OGSOS_ADMINS plus the mods an owner added in the panel)
  if (moderation.isAdmin(accountId) || (steamId && moderation.isAdmin(steamId))) roles.add('dev');
  return [...roles];
}

// The fields of an account that anyone may see (same names as the full object, just fewer of them).
function publicAccount(a) {
  const o = obj(a);
  const id = String(o.id ?? o['account-id'] ?? '');
  return { id, 'account-id': id, alias: o.alias ?? id, 'display-name': o['display-name'] ?? o.alias ?? id };
}
function accountFromAuth(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.replace(/^(?:Token|Bearer)\s+/i, '').trim();
  const c = tok && readJwt(tok);
  return c ? String(c['account-id'] || c.id || '') || undefined : undefined;
}

// The original wraps responses as {"version": ..., "data": {...}}
// (from the client's error strings: 'Failed to get "data"', 'Failed to get "version"').
function wrap(data, version = 1) { return { version, data }; }

// Request URLs come straight off the wire: "//", "//host", "%zz" or a bare "*" must never throw out of a handler.
// Prefixing the origin keeps "//x" a path (new URL('//x', base) would read it as a host). null = unparseable.
function parseReqUrl(raw) {
  try { return new URL('http://x' + (String(raw || '').startsWith('/') ? raw : '/' + raw)); } catch { return null; }
}
// Last line of defence: a bug in any route answers 500 (or drops the socket) and is logged, the process keeps running.
function failRequest(res, req, e) {
  console.error(`!! ${req.method} ${String(req.url).slice(0, 200)} -> 500: ${e && e.stack || e}`);
  try { log('errors.jsonl', { method: req.method, path: String(req.url).slice(0, 500), error: String(e && e.stack || e).slice(0, 2000) }); } catch { /* disk full etc. */ }
  try {
    if (!res.headersSent) return send(res, 500, wrap({ error: 'internal' }));
    res.destroy();
  } catch { /* socket already gone */ }
  return { status: 500 };
}

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
// Both clients share one Engine.ini (so one KV endpoint); Classic is told apart by its
// `app-id: sostest` request header and gets data/kv-classic/ instead (its keys differ).
const KV_DIR = path.join(DATA_DIR, 'kv');
const KV_DIR_CLASSIC = path.join(DATA_DIR, 'kv-classic');
fs.mkdirSync(KV_DIR, { recursive: true });
function handleKv(rel, res, req) {
  const dir = isClassic(req.headers['app-id']) ? KV_DIR_CLASSIC : KV_DIR;
  if (dir === KV_DIR_CLASSIC) {   // moderation: the owner's announcement/config overlay (new revision per change, docs/ADMIN.md)
    const o = moderation.kvServe(rel);
    if (o) return send(res, 200, o.body, o.type);
  }
  if (rel === 'live-rev.txt') {
    const f = path.join(dir, 'live-rev.txt');
    return send(res, 200, fs.existsSync(f) ? fs.readFileSync(f) : '1', 'text/plain');
  }
  const f = path.normalize(path.join(dir, rel));
  if (f.startsWith(dir + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
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
// Account JSON as the client parses it (FUN_141a57160, top level only). "identities" is an OBJECT keyed by
// provider ({steam:{id,created,updated,display-name}}); the Steam id is read from identities.steam.id. With it
// missing, OnGetAccountInfoComplete logs "empty Steam ID" and a player joining a match waits minutes in LoginPending.
// The top-level "id" must be non-empty ("Missing user id"). The db keeps the older array form.
function accountView(base) {
  const id = String(base.id ?? base['account-id'] ?? '');
  const ids = Array.isArray(base.identities) ? base.identities : [];
  const steamId = /^7656\d{13}$/.test(id) ? id : (ids.find((x) => x.provider === 'steam')?.['provider-data'] ?? id);
  const name = base['display-name'] ?? base.alias ?? id;
  return {
    ...base, id,
    user: { uname: base.alias ?? id, fname: '', lname: '', email: '' },
    identities: { steam: { id: steamId, created: '0', updated: '0', 'display-name': name } },
    roles: base.roles ?? ['app-user'],
  };
}

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

// ---------- public server list (GET /servers) ----------
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const isIpPort = (v) => { const m = String(v).match(/^([^:]+):(\d{1,5})$/); return !!m && net.isIPv4(m[1]) && +m[2] >= 1 && +m[2] <= 65535; };
// PUBLIC_BACKEND / DIRECTORY: env OGSOS_<KEY> wins over data/config.json.
let CONFIG_FILE = {};
try { CONFIG_FILE = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')); } catch { /* none or invalid: loadConfig warned */ }
let PUBLIC_BACKEND_ENV = String(process.env.OGSOS_PUBLIC_BACKEND || CONFIG_FILE.PUBLIC_BACKEND || '');
if (PUBLIC_BACKEND_ENV && !isIpPort(PUBLIC_BACKEND_ENV)) { console.warn(`OGSOS_PUBLIC_BACKEND ignored: "${PUBLIC_BACKEND_ENV}" is not <IPv4>:<port>`); PUBLIC_BACKEND_ENV = ''; }
// Other backends whose lists are merged into ours (OGSOS_DIRECTORY = JSON array of "ip:port").
const DIRECTORY = (() => {
  const raw = process.env.OGSOS_DIRECTORY || CONFIG_FILE.DIRECTORY;
  if (!raw) return [];
  let a = raw;
  if (typeof raw === 'string') { try { a = JSON.parse(raw); } catch (e) { console.warn(`OGSOS_DIRECTORY ignored: not valid JSON (${e.message})`); return []; } }
  if (!Array.isArray(a)) { console.warn('OGSOS_DIRECTORY ignored: not an array'); return []; }
  return a.map(String).filter((x) => { if (isIpPort(x)) return true; console.warn(`OGSOS_DIRECTORY entry "${x}" skipped: not <IPv4>:<port>`); return false; });
})();
const ourBackend = (publicHost) => PUBLIC_BACKEND_ENV || (publicHost ? `${publicHost}:${PORT}` : null);
function localServers() {
  const out = [];
  for (const [game, m, cfg] of [['classic', mmClassic, CLASSIC_CONFIG], ['main', mm, CONFIG]]) {
    for (const h of m.listHosted()) {
      if (h.community && !(game === 'classic' && community.isListed(h.id))) continue;   // unlisted community hosts stay hidden
      out.push({
        id: h.id, game, name: h.name, region: h.region, online: h.online, players: h.players,
        minPlayers: h.minPlayers, maxPlayers: h.maxPlayers, state: h.state, map: h.map,
        countdownEndsAt: h.countdownEndsAt, votes: h.votes, lateJoinOpen: h.lateJoinOpen,
        address: `${h.publicHost || h.host}:${h.port}`, backend: ourBackend(cfg.PUBLIC_HOST), lastSeenSec: h.lastSeenSec,
        community: !!h.community, verified: !!h.verified,
      });
    }
  }
  // official first, then verified community, then other community (stable inside each group)
  const grp = (x) => (!x.community ? 0 : x.verified ? 1 : 2);
  return out.map((x, i) => [x, i]).sort((a, b) => grp(a[0]) - grp(b[0]) || a[1] - b[1]).map((e) => e[0]);
}
// Peer lists: cached 15 s (failures too), 2 s timeout, always asked with ?local=1 so lists never recurse.
const peerCache = new Map();   // "ip:port" -> { at, promise }
function fetchPeer(addr) {
  const hit = peerCache.get(addr);
  if (hit && Date.now() - hit.at < 15000) return hit.promise;
  const [host, port] = addr.split(':');
  const promise = new Promise((resolve) => {
    const r = http.get({ host, port: Number(port), path: '/servers?local=1', timeout: 2000 }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (d) => { size += d.length; if (size > 1 << 20) res.destroy(); else chunks.push(d); });
      res.on('end', () => {
        try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(res.statusCode === 200 && Array.isArray(j.servers) ? j.servers : []); } catch { resolve([]); }
      });
      res.on('error', () => resolve([]));
    });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve([]));
  });
  peerCache.set(addr, { at: Date.now(), promise });
  return promise;
}
// Whitelist the fields of a peer's entry, so nothing else (a token, say) is ever passed on.
function cleanPeerServer(x) {
  const o = obj(x);
  const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    id: String(o.id ?? '').slice(0, 64), game: o.game === 'main' ? 'main' : 'classic',
    name: cleanLabel(o.name, 48), region: cleanLabel(o.region, 16), online: o.online === true,
    players: n(o.players), minPlayers: n(o.minPlayers), maxPlayers: n(o.maxPlayers),
    state: ['waiting', 'countdown', 'started', 'ended'].includes(o.state) ? o.state : 'waiting', map: cleanLabel(o.map, 64),
    countdownEndsAt: o.countdownEndsAt === null || o.countdownEndsAt === undefined ? null : n(o.countdownEndsAt),
    votes: n(o.votes), lateJoinOpen: o.lateJoinOpen === true,
    address: cleanLabel(o.address, 64), backend: isIpPort(o.backend) ? String(o.backend) : null,
    lastSeenSec: o.lastSeenSec === null || o.lastSeenSec === undefined ? null : n(o.lastSeenSec),
    community: o.community === true, verified: o.verified === true,
  };
}
async function allServers(localOnly) {
  const servers = localServers();
  if (localOnly || !DIRECTORY.length) return servers;
  const ours = new Set(servers.map((x) => x.backend).filter(Boolean));
  const seen = new Set(servers.map((x) => `${x.backend}|${x.id}`));
  for (const list of await Promise.all(DIRECTORY.map(fetchPeer))) {
    for (const raw of list) {
      const x = cleanPeerServer(raw);
      if (!x.id || (x.backend && ours.has(x.backend))) continue;
      const key = `${x.backend}|${x.id}`;
      if (seen.has(key)) continue;
      seen.add(key); servers.push(x);
    }
  }
  return servers;
}

// ---------- REST API ----------
// Routes come from the paths baked into SOS-Win64-Shipping.exe.
function handleApi(req, url, body, res) {
  const p = url.pathname;
  const m = (re) => p.match(re);
  let r;

  // Community host registry (server/community.js). Open registration with limits; JSON bodies up to 4 KB.
  if (p.startsWith('/api/community/')) {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
    let j; try { j = JSON.parse(body || '{}'); } catch { j = null; }
    let out = null;
    if (req.method === 'POST' && p === '/api/community/register') {
      out = j && typeof j === 'object' && !Array.isArray(j) ? community.register(ip, j, authToken(req)) : { status: 400, body: { error: 'bad-json' } };
    } else if (req.method === 'POST' && p === '/api/community/unregister') {
      out = j && typeof j.sessionId === 'string' ? community.unregister(j.sessionId, authToken(req)) : { status: 400, body: { error: 'bad-json' } };
    } else if (req.method === 'GET' && (r = m(/^\/api\/community\/status\/([^/]+)$/))) {
      const st = community.status(decodeURIComponent(r[1]));
      out = st ? { status: 200, body: st } : { status: 404, body: { error: 'not-found' } };
    }
    if (out && out.status === 200 && out.body && out.body.sessionId) moderation.reapplyLobbyOptions(out.body.sessionId);   // moderation: lock/overrides survive a re-register
    if (out) return send(res, out.status, out.body);
  }
  // moderation: an admin's spectate/director join link from the client mod (game JWT; OGSOS_ADMINS only), docs/ADMIN.md
  if (req.method === 'POST' && (r = m(/^\/api\/servers\/([^/]+)\/watch$/))) {
    const out = moderation.handleWatchApi(req, decodeURIComponent(r[1]), body, authToken(req));
    return send(res, out.status, out.body);
  }

  // Vote to start: authorised by the PLAYER's bearer token (the per-player session access token from the
  // backend, or the account JWT), not the host's. The player must be seated in the session.
  if (req.method === 'POST' && (r = m(/^\/api\/session\/([^/]+)\/vote-start$/))) {
    const id = decodeURIComponent(r[1]);
    const owner = mmClassic.getHostedSession(id) ? mmClassic : mm;
    const found = owner.getHostedSession(id);
    if (!found) return send(res, 404, { error: 'not-found' });
    const tok = String(req.headers['authorization'] || '').replace(/^(Bearer|Token)\s+/i, '').trim();
    let pid = null;
    const claims = tok && readJwt(tok);
    if (claims && !(claims.exp && claims.exp < Date.now() / 1000)) pid = String(claims['account-id'] || claims.id || '') || null;
    if (!pid && tok) pid = readSessionJwt({ sessionId: id, sessionToken: found.token }, tok);
    if (!pid) return send(res, 401, { error: 'unauthorized' });
    moderation.recordIp(pid, clientIp(req));
    const v = owner.voteStartHosted(id, pid);
    if (v.error === 'not-seated') return send(res, 403, { error: 'not-seated' });
    if (v.error === 'closed') return send(res, 409, { error: 'closed', state: v.state });
    if (v.error) return send(res, 404, { error: v.error });
    return send(res, 200, { result: true, ...v });
  }

  // Join hint from the client mod's server list: the player's next find-session goes to this lobby if it is
  // still open (2 min). Authorised by the player's account JWT, like vote-start.
  if (req.method === 'POST' && (r = m(/^\/api\/servers\/([^/]+)\/join-hint$/))) {
    const id = decodeURIComponent(r[1]);
    const owner = mmClassic.getHostedSession(id) ? mmClassic : mm;
    if (!owner.getHostedSession(id)) return send(res, 404, { error: 'not-found' });
    const cinfo = community.communityInfo(id);
    if (cinfo && !cinfo.listed) return send(res, 409, { error: 'unlisted' });
    const tok = String(req.headers['authorization'] || '').replace(/^(Bearer|Token)\s+/i, '').trim();
    const claims = tok && readJwt(tok);
    const pid = claims && !(claims.exp && claims.exp < Date.now() / 1000) ? String(claims['account-id'] || claims.id || '') : '';
    if (!pid) return send(res, 401, { error: 'unauthorized' });
    const ipBan = moderation.ipBanned(clientIp(req));
    if (ipBan) return send(res, 403, moderation.banBody(ipBan));
    moderation.recordIp(pid, clientIp(req));
    const v = owner.setJoinHint(id, pid);
    if (v.error === 'not-found') return send(res, 404, { error: v.error });
    if (v.error) return send(res, 409, { error: v.error, state: v.state });
    return send(res, 200, { result: true, ...v });
  }

  // Routes the game host (a listen server) calls on its MMS, authorised by `Token <SESSION_TOKEN>`.
  // POST .../start and .../reset are for whoever runs the server (same token; or type `start` in the console).
  // Also without the /api prefix: the sos_host DLL posts match-end to <backend>/session/<id>/events.
  if ((r = m(/^\/(?:api\/)?session\/([^/]+?)(\/events|\/start|\/reset|\/end|\/announce)?$/)) && ((r[2] && req.method === 'POST') || (!r[2] && req.method === 'GET'))) {
    const id = decodeURIComponent(r[1]);
    const owner = mmClassic.getHostedSession(id) ? mmClassic : mm;
    const found = owner.getHostedSession(id);
    if (!found) return send(res, 404, { error: 'not-found' });
    const given = Buffer.from(String(req.headers['authorization'] || '').replace(/^Token\s+/i, '').trim());
    const want = Buffer.from(found.token);
    const tokenOk = given.length === want.length && crypto.timingSafeEqual(given, want);
    // Token only, no loopback bypass: behind a tunnel (playit etc.) remote callers arrive as loopback.
    if (!tokenOk) return send(res, 401, { error: 'unauthorized' });
    if (r[2] === '/announce') {
      let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
      // Community hosts follow the registry's naming rules here too (an unverified host cannot call itself official).
      const cinfo = community.communityInfo(id), askedName = cleanLabel(obj(j).name, 48);
      if (cinfo && askedName && community.badName(askedName, cinfo.verified)) return send(res, 400, { error: 'bad-name' });
      const now = owner.announceHosted(id, obj(j));
      console.log(`announce for hosted session ${id}: "${now.name}" [${now.region}]`);
      return send(res, 200, { result: true });
    }
    if (r[2] === '/start') {
      const players = owner.forceStartHosted(id);
      console.log(`forced start of hosted session ${id} via HTTP (${players} player(s))`);
      return send(res, 200, { result: true, players });
    }
    if (r[2] === '/reset') {
      const cleared = owner.resetHosted(id);
      console.log(`reset hosted session ${id} via HTTP (${cleared} player(s) cleared)`);
      return send(res, 200, { result: true, cleared });
    }
    if (r[2] === '/end') {
      const released = owner.endHosted(id);
      console.log(`end of hosted session ${id} via HTTP (${released} player(s) released)`);
      return send(res, 200, { result: true, released });
    }
    if (r[2]) {
      let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
      console.log(`host event for session ${id}: ${j.type}`);
      if (j.type === 'match-end') {
        // Per-player stats from the sos_host DLL (before endHosted releases the seats). Only real accounts count.
        // Unverified community hosts never feed progression.
        const cinfo = community.communityInfo(id);
        if (!cinfo || cinfo.verified) {
          const players = (Array.isArray(j.players) ? j.players : []).filter((pl) => pl && db.accounts[String(pl.playerId)]);
          const rec = progression.recordMatchEnd(id, { ...j, players }, null);
          moderation.onMatchEnd(id, rec.matchId);   // moderation
          console.log(`match-end stats for session ${id}: ${rec.duplicate ? 'duplicate' : `${rec.accepted} player(s)`} (${rec.matchId})`);
        } else console.log(`match-end stats for session ${id} ignored (unverified community host)`);
      }
      if (j.type === 'match-end' || j.type === 'session-end') owner.endHosted(id);
      if (j.type === 'match-start') console.log(`host reported match-start for session ${id}`);
      log('ws.jsonl', { event: 'host-event', session: id, type: j.type, body });
      return send(res, 200, { result: true });
    }
    owner.markHostPolled(id);   // an authenticated poll = the game host is alive (see GET /servers)
    return send(res, 200, moderation.filterPlayerMap(found.session));   // moderation: banned ids are dropped from player-map
  }

  // Login. The client posts {"steam-app-id","steam-id","session-auth-token","roles","app-id"}
  // to /api/access-token/steam and expects a JWT-shaped token (it rejects anything not
  // "xxx.yyy.zzz" and reads "claims" from it). Field names are still guesses, so the
  // account id is given under several names until the logs tell us which one it reads.
  // TODO(stage 2): verify session-auth-token with Steam's ISteamUserAuth so ids can't be spoofed.
  if (req.method === 'POST' && (r = m(/^\/api\/access-token(?:\/([^/]+))?$/)) && (r[1] === undefined || r[1] === 'steam')) {
    let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
    if (!j || typeof j !== 'object' || Array.isArray(j)) j = {};
    // Only real-looking SteamID64s become accounts (no free-form ids, no sha1(body) fallback). The ticket itself is still
    // not verified (design item, see docs/SECURITY.md) and is never logged.
    const steamId = String(j['steam-id'] || j.steamId || '');
    if (!STEAM_ID_RE.test(steamId)) return send(res, 400, { error: 'bad-steam-id' });
    const accountId = steamId;
    // moderation: a banned account gets no token. The exact client ban shape may change after RE.
    const ban = moderation.isBanned(accountId) || moderation.ipBanned(clientIp(req));   // account ban, else a ban on the client address (owner-set, docs/SECURITY.md)
    if (ban) {
      log('http.jsonl', { event: 'login-refused-banned', account: accountId });
      return send(res, 403, moderation.banBody(ban));   // the shape the client's login error handler parses (app-banned)
    }
    moderation.recordIp(accountId, clientIp(req));   // owner-only IP history
    db.accounts[accountId] ??= {
      id: accountId, 'account-id': accountId, alias: `player-${accountId.slice(-4)}`,
      'display-name': `player-${accountId.slice(-4)}`, created: new Date().toISOString(),
      identities: steamId ? [{ provider: 'steam', 'provider-data': steamId }] : [],
    };
    db.accounts[accountId]['last-access'] = new Date().toISOString();
    const appId = String(j['app-id'] || req.headers['app-id'] || 'sos').slice(0, 64);
    if (badKey(appId)) return send(res, 400, { error: 'bad-app-id' });
    // Roles are decided here: Classic gets the server-side set; other apps may ask for app-user / user only (max 4).
    const askedRoles = (Array.isArray(j.roles) ? j.roles : []).map(String).filter((x) => x === 'app-user' || x === 'user');
    const roles = isClassic(appId) ? classicRoles(accountId, steamId) : [...new Set(askedRoles)].slice(0, 4);
    if (!roles.length) roles.push('app-user');
    const jwt = makeJwt(accountId, steamId, roles, appId);
    saveDb();
    const reply = () => {
      const payload = { ...accountView(db.accounts[accountId]), 'user-id': accountId, 'access-token': jwt, token: jwt };
      if (isClassic(appId)) payload.roles = roles;
      // Give the fields both at top level and under "data" until we know which the client reads.
      return send(res, 200, { ...payload, version: 1, data: payload });
    };
    // Steam persona as the in-game name (the client joins with ?Name=<display-name>); see server/persona.js.
    // An account never looked up waits up to 2.5 s, so even the first launch shows the real name.
    const acc = db.accounts[accountId];
    if (steamId && !acc['persona-checked']) {
      refreshPersona(acc, steamId, { save: saveDb, waitMs: 2500 }).then(reply, reply).catch(() => {});
      return { status: 200, out: '<deferred until the Steam persona lookup>' };
    }
    refreshPersona(acc, steamId, { save: saveDb }).catch(() => {});
    return reply();
  }
  // "Crack" a token: the client can ask the server what a token contains.
  if (req.method === 'GET' && (r = m(/^\/api\/access-token\/([^/]+)$/)) && r[1] !== 'once-code') {
    const claims = readJwt(decodeURIComponent(r[1]));
    return claims ? send(res, 200, { ...claims, version: 1, data: claims }) : send(res, 401, wrap({ error: 'unauthorized' }));
  }
  if (p.startsWith('/api/access-token') || p.endsWith('/once-code')) {
    return send(res, 200, wrap({ code: crypto.randomBytes(8).toString('hex') }));
  }

  // Per-game saved data (GetAccountAppData / SetAccountAppData). Classic: server/progression.js (auth, CAS).
  if ((r = m(/^\/api\/account\/([^/]+)\/app\/([^/]+)$/)) && isClassic(decodeURIComponent(r[2]))) {
    const out = progression.handleAppData(req.method, decodeURIComponent(r[1]), decodeURIComponent(r[2]), body, authToken(req));
    if (out.status !== 200) log('http.jsonl', { event: 'app-data-refused', status: out.status, method: req.method, path: p });
    return send(res, out.status, out.body);
  }
  // Other apps: GET needs any valid JWT, POST needs the owner's JWT (account === <id>); 64 KB, 16 app keys per account.
  if ((r = m(/^\/api\/account\/([^/]+)\/app\/([^/]+)$/))) {
    const acctId = decodeURIComponent(r[1]), appKey = decodeURIComponent(r[2]);
    if (badKey(acctId) || badKey(appKey) || !/^[\w.-]{1,64}$/.test(appKey) || !/^[\w.-]{1,64}$/.test(acctId)) return send(res, 400, { error: 'bad-id' });
    const caller = jwtAccount(authToken(req));
    if (!caller || (req.method !== 'GET' && caller !== acctId)) return send(res, 401, wrap({ error: 'unauthorized' }));
    const key = `${acctId}/${appKey}`;
    if (req.method === 'GET') return send(res, 200, wrap(db.appData[key]?.data ?? {}, db.appData[key]?.version ?? 1));
    if (Buffer.byteLength(body || '') > BODY_CAP) return send(res, 413, { error: 'too-large' });
    if (!db.appData[key]) {
      const prefix = `${acctId}/`;
      let n = 0; for (const k of Object.keys(db.appData)) if (k.startsWith(prefix)) n++;
      if (n >= 16) return send(res, 409, { error: 'too-many-apps' });
    }
    let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
    const version = (db.appData[key]?.version ?? 0) + 1;
    db.appData[key] = { version, data: j.data ?? j };
    saveDb();
    return send(res, 200, wrap(db.appData[key].data, version));
  }
  if ((r = m(/^\/api\/account\/([^/]+)$/)) || p === '/api/account') {
    const id = r ? decodeURIComponent(r[1]) : accountFromAuth(req);
    if (id !== undefined && badKey(id)) return send(res, 400, { error: 'bad-id' });
    const full = db.accounts[id] ?? { id, 'account-id': id };
    // The account itself gets everything; anyone else only the public fields (no last-access, created, identity records).
    const acct = accountView(accountFromAuth(req) === id ? full : publicAccount(full));
    return send(res, 200, { ...acct, version: 1, data: acct });
  }
  // moderation: native client report (POST /api/account/<id>/report) and the mod/API report route
  if (req.method === 'POST' && (r = m(/^\/api\/account\/([^/]+)\/app-meta\/([^/]+)\/report$/))) {   // the id is the TARGET, Token auth is the reporter
    const out = moderation.handleReport(req, decodeURIComponent(r[1]), body, authToken(req));
    return send(res, out.status, out.body);
  }
  if (req.method === 'POST' && (r = m(/^\/api\/account\/([^/]+)\/report$/))) {
    const out = moderation.handleReport(req, decodeURIComponent(r[1]), body, authToken(req));
    return send(res, out.status, out.body);
  }
  if (req.method === 'POST' && p === '/api/reports') {
    const out = moderation.handleReportApi(req, body, authToken(req));
    return send(res, out.status, out.body);
  }
  if (req.method === 'POST' && (r = m(/^\/api\/reports\/([^/]+)\/evidence$/))) {   // moderation: attach a clip link afterwards
    const out = moderation.handleEvidence(req, decodeURIComponent(r[1]), body, authToken(req));
    return send(res, out.status, out.body);
  }
  // tos, language, identity, and app-meta/<app>/accept-ban (the client's ban acknowledgement; nothing to record): 200 empty
  if (p.startsWith('/api/account/')) return send(res, 200, wrap({}));

  // Inventory: everyone owns every cosmetic (ids from data/cosmetics.json, see docs/INVENTORY_FORMAT.md).
  if (m(/^\/api\/app\/[^/]+\/inventory\//) || m(/^\/api\/app\/[^/]+\/reconcile\//)) {
    return send(res, 200, appAccount());
  }
  // GetAppRewards: {changes:{wallet-delta, new-licenses}, last-level-up}. Nothing new to hand out.
  // GET season/<id> (no further path) is the season state, not the rewards call.
  if (req.method === 'GET' && m(/^\/api\/app\/[^/]+\/season\/[^/]+$/)) {
    const a = appAccount();
    return send(res, 200, { ...a.season, season: a.season, data: a.season });
  }
  if (m(/^\/api\/app\/[^/]+\/season\//)) {
    return send(res, 200, { changes: { 'wallet-delta': { coins_paid: 0, coins_free: 0 }, 'new-licenses': [] } });
  }
  // Store: purchases return the (already complete) account; the shop list is empty since everything is owned.
  if (m(/^\/api\/app\/[^/]+\/store\/items\/purchase$/)) return send(res, 200, appAccount());
  if (m(/^\/api\/app\/[^/]+\/store\//)) return send(res, 200, { 'store-view': [] });

  if (p === '/api/log') return send(res, 200, wrap({}));
  // Classic leaderboards (server/progression.js): the game host POSTs scores, clients read rankings.
  if ((r = m(/^\/api\/leaderboard\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/)) && isClassic(decodeURIComponent(r[1]))) {
    const q = url.searchParams;
    const out = progression.handleLeaderboard(req.method, decodeURIComponent(r[1]), decodeURIComponent(r[2]),
      r[3] ? decodeURIComponent(r[3]) : null,
      { start: q.get('start') ?? undefined, limit: q.get('limit') ?? undefined, surrounding: q.get('surrounding') ?? undefined },
      body, authToken(req));
    if (out.status !== 200) log('http.jsonl', { event: 'leaderboard-refused', status: out.status, method: req.method, path: p });
    return send(res, out.status, out.body);
  }
  if (p.startsWith('/api/leaderboard/')) return send(res, 200, []);
  // Match stats from our host DLL's match-end (public, read-only).
  if (req.method === 'GET' && (r = m(/^\/api\/stats\/player\/([^/]+)$/))) {
    return send(res, 200, progression.playerSummary(decodeURIComponent(r[1])) || {});
  }
  if (req.method === 'GET' && p === '/api/stats/matches') return send(res, 200, progression.recentMatches(Number(url.searchParams.get('limit')) || 20));
  if (p.startsWith('/api/search/account')) {
    if (!jwtAccount(authToken(req))) return send(res, 401, wrap({ error: 'unauthorized' }));
    const q = String(url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim().toLowerCase().slice(0, 64);
    const out = [];
    for (const a of Object.values(db.accounts)) {
      if (out.length >= 50) break;
      if (q && !(String(a.id).toLowerCase().includes(q) || String(a['display-name'] || a.alias || '').toLowerCase().includes(q))) continue;
      out.push(publicAccount(a));
    }
    return send(res, 200, wrap(out));
  }

  return null;
}

// ---------- HTTP server ----------
// Client mod self-update (docs/CLIENT_MOD.md): serves manifest.json, manifest.sig and core-<n>.dll from data/mod
// (OGSOS_MOD_DIR overrides). Only those names; the files are signed offline by tools/mod_update.js, so this
// route holds no secret and the client trusts the signature, not this server.
const MOD_DIR = process.env.OGSOS_MOD_DIR || path.join(DATA_DIR, 'mod');
function serveMod(url, res) {
  const name = url.pathname.slice(5);
  if (!/^(manifest\.json|manifest\.sig|core-\d{1,6}\.dll)$/.test(name)) { res.writeHead(404); return res.end(); }
  fs.readFile(path.join(MOD_DIR, name), (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': name.endsWith('.dll') ? 'application/octet-stream' : 'text/plain', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}
function serveServers(req, url, res) {
  allServers(url.searchParams.get('local') === '1').catch(() => localServers()).then((servers) => {
    const buf = Buffer.from(JSON.stringify({ servers }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(buf);
    log('http.jsonl', { method: 'GET', path: req.url, host: req.headers.host, status: 200, out: `<${servers.length} server(s)>`, handled: true });
    console.log(`   GET ${req.url} -> 200 (${servers.length})`);
  });
}
// HERO streaming panel: the client's in-game browser loads [OutpostStreams] EmbedEndpoint + /embed/account/<id>/performer.
// hero.tv is a parked domain now, so the launcher points EmbedEndpoint here and this serves an empty page.
function serveEmbedBlank(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:transparent"></body></html>');
}

// hero-tv: real panels live in server/web/ (plain ES5 pages: the game's CEF is UE 4.12's old Chromium). Each page gets
// its settings as `var CFG = {...}` in place of the /*CFG*/null marker. URL formats: HERO_TV.md section 2.
//   /embed/{account|none}/<id>/performer?token=&skip-brand=&hide-view-count=1   performer's own panel
//   /embed/{account|none}/<id>/feedback?viewer=1[&site=1]                       spectator meters (meter-0..4)
//   /embed/{account|none}/<id>/connect/twitch?token=                            not built yet
//   /embed/_/meter?n=<0-4>                                                      one meter iframe (#button)
// Anything else under /embed/ stays blank so no parked-domain page can show up in a match.
const WEB_DIR = path.join(__dirname, 'web');
function servePage(res, file, cfg) {
  let html;
  try { html = fs.readFileSync(path.join(WEB_DIR, file), 'utf8'); } catch { return serveEmbedBlank(res); }
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
  html = html.replace('/*CFG*/null', json);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
function serveEmbed(url, res) {
  const parts = url.pathname.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return ''; } });
  const q = (k) => url.searchParams.get(k) || '';
  if (parts[1] === '_' && parts[2] === 'meter') return servePage(res, 'meter.html', { n: Number(q('n')) || 0 });
  const kind = parts[1], id = parts[2] || '', page = parts.slice(3).join('/');
  if ((kind === 'account' || kind === 'none') && id) {
    const base = { target: id, token: kind === 'account' ? q('token') : '' };
    if (page === 'performer') return servePage(res, 'performer.html', { ...base, skipBrand: q('skip-brand') === '1', hideViewCount: q('hide-view-count') === '1' });
    if (page === 'feedback') return servePage(res, 'feedback.html', { ...base, viewer: q('viewer') === '1', site: q('site') === '1', name: displayName(id) });
    if (page === 'connect/twitch') return servePage(res, 'twitch.html', base);
  }
  return serveEmbedBlank(res);
}
const displayName = (id) => db.accounts[id]?.['display-name'] || db.accounts[id]?.alias || id;
const fame = createFame({ db, saveDb, displayName, log: (e) => log('ws.jsonl', { stream: true, ...e }) });
// Read-only JSON for the spectator site.
function handleStreamApi(url, res) {
  if (url.pathname === '/api/stream/sessions') {
    const snap = stream.snapshot();
    for (const s of snap.sessions) for (const p of s.players) { p.name = displayName(p.id); p.fame = fame.heroStats(p.id)?.soloFameRating || 0; }
    return send(res, 200, snap);
  }
  if (url.pathname === '/api/stream/fame') {
    // The same rows the game's FameLeaderboard gets (one source of truth).
    return send(res, 200, { fame: fame.fameLeaderboard('solo', { limit: 100 }) });
  }
  return null;
}

// ---------- limits: client address, request size, rate (docs/SECURITY.md) ----------
// clientIp(): the TCP peer, except when the peer is the local reverse proxy (loopback, a Docker bridge address
// 172.16.0.0/12, or an address listed in OGSOS_TRUSTED_PROXIES): then the LAST X-Forwarded-For entry, which is the one the
// proxy appended (earlier entries are whatever the client sent). Community registration keeps the raw socket address.
const stripV4 = (a) => String(a || '').replace(/^::ffff:/i, '');
const isLoopbackAddr = (a) => { a = stripV4(a); return a === '::1' || /^127\./.test(a); };
const isDockerAddr = (a) => { const m = stripV4(a).match(/^172\.(\d{1,3})\./); return !!m && +m[1] >= 16 && +m[1] <= 31; };
const TRUSTED_PROXIES = new Set(String(process.env.OGSOS_TRUSTED_PROXIES || '').split(',').map((x) => stripV4(x.trim())).filter(Boolean));
function clientIp(req) {
  const peer = stripV4(req.socket && req.socket.remoteAddress);
  if (isLoopbackAddr(peer) || isDockerAddr(peer) || TRUSTED_PROXIES.has(peer)) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const last = stripV4(String(Array.isArray(xff) ? xff.join(',') : xff).split(',').pop().trim());
      if (last && net.isIP(last)) return last;
    }
  }
  return peer || 'unknown';
}
const MIN_MS = 60000, HOUR_MS = 3600000;
const LIMITS = {   // max requests per window and client address; every max can be lowered or raised with OGSOS_RATE_<NAME>
  login: limiter('login', envInt('OGSOS_RATE_LOGIN', 60), 10 * MIN_MS),
  report: limiter('report', envInt('OGSOS_RATE_REPORT', 20), HOUR_MS),
  search: limiter('search', envInt('OGSOS_RATE_SEARCH', 30), MIN_MS),
  kv: limiter('kv', envInt('OGSOS_RATE_KV', 300), MIN_MS),
  hint: limiter('hint', envInt('OGSOS_RATE_HINT', 60), MIN_MS),
  admin: limiter('admin', envInt('OGSOS_RATE_ADMIN', 20), 10 * MIN_MS),
  global: limiter('global', envInt('OGSOS_RATE_GLOBAL', 1200), MIN_MS),
  ws: limiter('ws', envInt('OGSOS_RATE_WS', 30), MIN_MS),
};
function rateClass(req, url) {
  const p = url.pathname, post = req.method === 'POST';
  if (post && /^\/api\/access-token(?:\/|$)/.test(p)) return 'login';
  if (post && (p === '/api/reports' || /^\/api\/reports\/[^/]+\/evidence$/.test(p) || /^\/api\/account\/[^/]+\/(?:app-meta\/[^/]+\/)?report$/.test(p))) return 'report';
  if (p.startsWith('/api/search/')) return 'search';
  if (p.startsWith('/kv/')) return 'kv';
  if (post && (/^\/api\/servers\/[^/]+\/join-hint$/.test(p) || /^\/api\/session\/[^/]+\/vote-start$/.test(p))) return 'hint';
  if (p === '/admin/login' || p === '/admin/auth') return 'admin';
  return 'global';
}
// Pool and community hosts poll /api/session/<id> every few seconds and post blobs: a valid host session token is exempt from the global limit.
function hostTokenRequest(req, url) {
  const tok = authToken(req);
  if (!tok) return false;
  const r = url.pathname.match(/^\/(?:api\/)?session\/([^/]+)/);
  if (r) {
    let id; try { id = decodeURIComponent(r[1]); } catch { return false; }
    const found = (mmClassic.getHostedSession(id) ? mmClassic : mm).getHostedSession(id);
    if (found) {
      const given = Buffer.from(tok), want = Buffer.from(String(found.token));
      if (given.length === want.length && crypto.timingSafeEqual(given, want)) return true;
    }
  }
  return !!isHostToken(tok) || !!community.communityIdForToken(tok);
}
// null when allowed, else the Retry-After seconds. Loopback callers (local tools) are exempt from the global limit only.
function rateGate(req, url, ip) {
  const cls = rateClass(req, url);
  if (cls !== 'global') return LIMITS[cls](ip) ? null : LIMITS[cls].retryAfter(ip);
  if (isLoopbackAddr(ip) || LIMITS.global(ip)) return null;
  return hostTokenRequest(req, url) ? null : LIMITS.global.retryAfter(ip);
}
const BODY_CAP = 64 * 1024, BODY_CAP_BLOB = 300 * 1024, BODY_CAP_COMMUNITY = 4096;
const BLOB_PATH_RE = new RegExp(`^/api/account/[^/]+/app/${CLASSIC_APP}$|^/(?:api/)?session/[^/]+/events$`);
function bodyCap(req) {
  const u = String(req.url || '');
  const q = u.indexOf('?');
  const p = q < 0 ? u : u.slice(0, q);
  if (p.startsWith('/api/community/')) return BODY_CAP_COMMUNITY;
  return BLOB_PATH_RE.test(p) ? BODY_CAP_BLOB : BODY_CAP;
}
// Answer and drop the connection once the response is out; whatever body the client is still sending is never buffered.
function refuse(req, res, status, body, headers = {}) {
  try {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, Connection: 'close', ...headers });
    res.on('finish', () => { try { req.destroy(); } catch { /* gone */ } });
    res.end(buf);
  } catch { try { req.destroy(); } catch { /* gone */ } }
}

const server = http.createServer((req, res) => {
  try {
    const url = parseReqUrl(req.url);
    if (!url) { refuse(req, res, 400, wrap({ error: 'bad-url' })); log('http.jsonl', { method: req.method, path: String(req.url).slice(0, 500), status: 400, handled: true }); logProbe(req, clientIp(req), 400, true); return; }
    const ip = clientIp(req);
    const wait = rateGate(req, url, ip);
    if (wait) {
      refuse(req, res, 429, { error: 'rate-limited' }, { 'Retry-After': String(wait) });
      log('http.jsonl', { method: req.method, path: req.url, ip, status: 429, handled: true });
      logProbe(req, ip, 429, true);
      return;
    }
    const cap = bodyCap(req);
    const chunks = [];
    let size = 0, tooBig = false;
    const reject413 = () => {
      tooBig = true; chunks.length = 0;
      refuse(req, res, 413, { error: 'too-large' });
      log('http.jsonl', { method: req.method, path: req.url, ip, status: 413, out: 'too-large', handled: true });   // never the body
      logProbe(req, ip, 413, true);
    };
    if (Number(req.headers['content-length']) > cap) { reject413(); return; }
    req.on('data', (c) => { if (tooBig) return; size += c.length; if (size > cap) reject413(); else chunks.push(c); });
    req.on('error', () => {});
    req.on('end', () => { try {
      if (tooBig) return;
      const body = Buffer.concat(chunks).toString('utf8');
      let result;
      let handled = true;
      try {
        if (url.pathname.startsWith('/kv/')) result = handleKv(url.pathname.slice(4), res, req);
        else if (url.pathname === '/servers' && req.method === 'GET') return serveServers(req, url, res);
        else if (url.pathname.startsWith('/mod/') && req.method === 'GET') return serveMod(url, res);   // client mod self-update files
        else if (url.pathname.startsWith('/embed/') && req.method === 'GET') return serveEmbed(url, res);   // hero-tv
        else if ((url.pathname === '/' || url.pathname === '/watch') && req.method === 'GET') return servePage(res, 'watch.html', {});   // hero-tv
        else if (url.pathname.startsWith('/api/stream/') && req.method === 'GET') result = handleStreamApi(url, res);   // hero-tv
        else if ((url.pathname === '/admin' || url.pathname.startsWith('/admin/')) && moderation.handleHttp(req, url, body, res)) return;   // moderation: no http.jsonl entry (cookies)
        else result = handleApi(req, url, body, res);
        if (!result) {
          handled = false;
          result = send(res, 200, wrap({}));   // keep the client moving; flag it in the log
        }
      } catch (e) {
        result = failRequest(res, req, e);
      }
      const entry = { method: req.method, path: req.url, host: req.headers.host, ip, headers: req.headers, body, ...result, handled };
      log('http.jsonl', entry);
      logProbe(req, ip, result.status, handled);
      console.log(`${handled ? '   ' : '?? '}${req.method} ${String(req.url).slice(0, 200)} -> ${result.status}`);
    } catch (e) { failRequest(res, req, e); } });
  } catch (e) { failRequest(res, req, e); }
});
// Slow-client and flood limits (upgraded WebSockets have their own idle handling in handleUpgrade).
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;
server.maxConnections = 4000;
server.on('clientError', (err, socket) => {
  try {
    if (err && err.code !== 'ECONNRESET' && socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
    else socket.destroy();
  } catch { try { socket.destroy(); } catch { /* gone */ } }
  setTimeout(() => { try { socket.destroy(); } catch { /* gone */ } }, 2000).unref();
});

// ---------- WebSocket (matchmaking at /ws) ----------
// Minimal RFC 6455: handshake, text/binary frames, ping/pong, close. The matchmaking protocol
// itself lives in server/matchmaking.js (see docs/MATCHMAKING.md); every frame is logged.
const CONFIG = loadConfig(DATA_DIR, process.env, console.warn, { PUBLIC_HOST: FLAG_PUBLIC_HOST });
const mm = createMatchmaker({
  config: CONFIG,
  getUname: (id) => db.accounts[id]?.['display-name'] || db.accounts[id]?.alias || id,
  log: (m) => { log('ws.jsonl', { event: 'mm', text: m }); console.log(`mm ${m}`); },
});

// Classic gets its own matchmaker: the two builds cannot share a match (different maps and
// game versions), and Classic hosts may run on another port. Overrides come from the "classic"
// object in data/config.json, or env OGSOS_CLASSIC_<KEY>.
function classicMmConfig() {
  const cfg = { ...CONFIG };
  // HOSTS is never inherited from the main config (it would put both builds in one host's session).
  cfg.HOSTS = parseHosts(process.env.OGSOS_CLASSIC_HOSTS ?? CLASSIC.mm.HOSTS, console.warn, cfg.GAME_SERVER_PORT);
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'HOSTS' || key === 'PUBLIC_HOST') continue;
    let v = process.env[`OGSOS_CLASSIC_${key}`] ?? CLASSIC.mm[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof DEFAULTS[key] === 'number') { v = Number(v); if (!Number.isFinite(v)) continue; } else v = String(v);
    cfg[key] = v;
  }
  // PUBLIC_HOST: flag > OGSOS_CLASSIC_PUBLIC_HOST > classic.PUBLIC_HOST > the main value (inherited via the copy above).
  cfg.PUBLIC_HOST = pickPublicHost([
    { src: '--public-host', v: FLAG_PUBLIC_HOST },
    { src: 'env OGSOS_CLASSIC_PUBLIC_HOST', v: process.env.OGSOS_CLASSIC_PUBLIC_HOST },
    { src: 'data/config.json classic.PUBLIC_HOST', v: CLASSIC.mm.PUBLIC_HOST },
  ], console.warn) || CONFIG.PUBLIC_HOST;
  return cfg;
}
const CLASSIC_CONFIG = classicMmConfig();
const mmClassic = createMatchmaker({
  config: CLASSIC_CONFIG,
  getUname: (id) => db.accounts[id]?.['display-name'] || db.accounts[id]?.alias || id,
  log: (m) => { log('ws.jsonl', { event: 'mm-classic', text: m }); console.log(`mm[classic] ${m}`); },
});

// Third-party Classic hosts register here (docs/COMMUNITY_HOSTS.md); only the Classic matchmaker takes them.
const COMMUNITY_CFG = loadCommunityConfig(process.env);
const ENV_COMMUNITY_BANS = [...COMMUNITY_CFG.bans];   // moderation: panel host blocks are added to these
const community = createCommunityRegistry({
  mm: mmClassic, config: COMMUNITY_CFG,
  log: (m) => { log('ws.jsonl', { event: 'community', text: m }); console.log(`community ${m}`); },
});
setInterval(() => { try { community.sweep(); } catch (e) { console.warn(`community sweep: ${e}`); } }, 15000).unref();

// ---------- progression (docs/PROGRESSION.md, server/progression.js) ----------
// The Classic game host computes XP, level, stats and ratings itself and saves them in the player blob; this only
// stores blobs and leaderboards and records our host DLL's match-end stats. Host calls carry `Token <SESSION_TOKEN>`
// of a configured lobby, players their JWT. Blob writes are host-only: logins don't verify the Steam ticket yet.
function authToken(req) {
  return String(req.headers['authorization'] || '').replace(/^(Token|Bearer)\s+/i, '').trim() || null;
}
function isHostToken(tok) {
  if (!tok) return false;
  const given = Buffer.from(String(tok));
  for (const owner of [mmClassic, mm]) {
    for (const h of owner.listHosted()) {
      if (h.community && !h.verified) continue;   // unverified community hosts have no progression writes
      const want = Buffer.from(owner.getHostedSession(h.id)?.token || '');
      if (want.length && given.length === want.length && crypto.timingSafeEqual(given, want)) return h.id;   // truthy: the lobby's session id
    }
  }
  return false;
}
function jwtAccount(tok) {
  const c = tok && readJwt(tok);
  if (!c || (c.exp && c.exp < Date.now() / 1000)) return null;
  return String(c['account-id'] || c.id || '') || null;
}
// Fame (hero-tv, server/fame.js) plugs in by setting fameHooks to its instance; until then fame boards use the
// scores the game host posts, and blobs pass through untouched.
let fameHooks = null;
fameHooks = fame;   // hero-tv: server/fame.js plugs in here (docs/PROGRESSION.md section 7)
const progression = createProgression({
  db, saveDb, isHostToken, jwtAccount,
  // host write scope: only players seated in that host's session now or within 30 min (docs/SECURITY.md)
  wasSeated: (sid, pid, ms) => mmClassic.wasSeated(sid, pid, ms) || mm.wasSeated(sid, pid, ms),
  canReadToken: (tok) => !!community.communityIdForToken(tok),
  displayName: (id) => db.accounts[id]?.['display-name'] || db.accounts[id]?.alias || id,
  fame: {
    applyToBlob: (id, d) => (fameHooks?.applyToBlob ? fameHooks.applyToBlob(id, d) : d),
    isFameBoard: (b) => !!fameHooks?.isFameBoard?.(b),
    fameLeaderboard: (b, o) => fameHooks?.fameLeaderboard?.(b, o) || [],
    fameAround: (b, m, n) => fameHooks?.fameAround?.(b, m, n) || [],
    fameForMatch: (id) => fameHooks?.fameForMatch?.(id) ?? null,
  },
});

// hero-tv: HERO Stream service (server/stream.js). When a stream session ends, its feedback becomes Fame (server/fame.js).
const stream = createStream({
  log: (e) => { log('ws.jsonl', { stream: true, ...e }); if (e.event !== 'stream-feedback') console.log(`stream ${e.event} ${e.type || e.session || e.vote || ''}`); },
  createReply: process.env.OGSOS_STREAM_CREATE_REPLY || 'typed',
  adoptUnknown: process.env.OGSOS_STREAM_ADOPT_UNKNOWN === '1',
  onSessionEnd: (match) => fame.recordMatch(match),
});

// moderation: reports, bans, host blocks, /admin panel (server/admin.js)
const moderation = createModeration({
  db, saveDb, log, secret: SECRET, jwtAccount,
  clientIp, trustedProxies: [...TRUSTED_PROXIES],   // owner-only IP tracking and IP bans (server/iptrack.js)
  displayName: (id) => db.accounts[id]?.['display-name'] || db.accounts[id]?.alias || id,
  progression, matchmakers: { classic: mmClassic, main: mm }, env: process.env,
  fame, community, kvDir: KV_DIR_CLASSIC,
  onHostBlocksChanged: (vals) => { community._cfg.bans = [...ENV_COMMUNITY_BANS, ...vals]; try { community.sweep(); } catch { /* next sweep */ } },
});

function wsAccount(req, token) {   // hero-tv: optional token (stream sockets from our embed pages)
  const tok = token || String(req.headers['authorization'] || '').replace(/^Token\s+/i, '').trim();
  const claims = tok && readJwt(tok);
  if (!claims || (claims.exp && claims.exp < Date.now() / 1000)) return null;
  const id = String(claims['account-id'] || claims.id || '');
  return id ? { id, appId: String(claims['app-id'] || req.headers['app-id'] || 'sos') } : null;
}

// ---------- WebSocket limits (docs/SECURITY.md) ----------
const WS_MAX_FRAME = 256 * 1024;                              // one frame, and one reassembled (fragmented) message
const WS_MAX_PER_IP = envInt('OGSOS_MAX_WS_PER_IP', 16);      // concurrent sockets per client address
const WS_MAX_TOTAL = envInt('OGSOS_MAX_WS_TOTAL', 3000);
const WS_PING_MS = envInt('OGSOS_WS_PING_MS', 30000);         // server ping interval
const WS_IDLE_MS = envInt('OGSOS_WS_IDLE_MS', 300000);        // nothing received (a pong counts) for this long: drop the socket
const WS_MSG_MAX = envInt('OGSOS_WS_MSG_MAX', 50);            // data messages per socket per WS_MSG_WINDOW_MS, then close 1008
const WS_MSG_WINDOW_MS = 10000;
const wsByIp = new Map();
let wsTotal = 0;
function wsReject(socket, status, extra = '') {
  try { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n${extra}Content-Length: 0\r\n\r\n`); } catch { /* gone */ }
  setTimeout(() => { try { socket.destroy(); } catch { /* gone */ } }, 1000).unref();
}

server.on('upgrade', (req, socket) => {
  socket.on('error', () => {});
  try { handleUpgrade(req, socket); } catch (e) {
    console.error(`!! upgrade ${String(req.url).slice(0, 200)}: ${e && e.stack || e}`);
    try { log('errors.jsonl', { upgrade: true, path: String(req.url).slice(0, 500), error: String(e && e.stack || e).slice(0, 2000) }); } catch { /* ignore */ }
    socket.destroy();
  }
});
function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const u = parseReqUrl(req.url);
  if (!key || !u) return socket.destroy();
  const wsPath = u.pathname;
  const isMm = wsPath === '/ws';
  const isStream = wsPath === '/ws/stream';   // HERO "Stream" service ([OutpostStreamClient], see docs/HERO_TV.md)
  if (!isMm && !isStream) return wsReject(socket, '404 Not Found');
  const ip = clientIp(req);
  if (!LIMITS.ws(ip)) { log('ws.jsonl', { event: 'rejected', path: req.url, ip, reason: 'rate-limited' }); return wsReject(socket, '429 Too Many Requests', `Retry-After: ${LIMITS.ws.retryAfter(ip)}\r\n`); }
  if (wsTotal >= WS_MAX_TOTAL) return wsReject(socket, '503 Service Unavailable');
  if ((wsByIp.get(ip) || 0) >= WS_MAX_PER_IP) { log('ws.jsonl', { event: 'rejected', path: req.url, ip, reason: 'too many sockets' }); return wsReject(socket, '429 Too Many Requests'); }
  if (moderation.ipBanned(ip)) {   // an owner-set IP ban: no matchmaking or stream sockets
    log('ws.jsonl', { event: 'rejected', path: req.url, reason: 'ip-banned' });
    return wsReject(socket, '403 Forbidden');
  }
  const wsQuery = u.searchParams;
  // hero-tv: stream sockets may connect anonymously (read-only use: view/sub/viewers); anything that creates or changes
  // state needs an account (Authorization header, or ?token= from our embed pages), see server/stream.js.
  const who = isMm ? wsAccount(req) : wsAccount(req, wsQuery.get('token') || '');
  const accountId = who ? who.id : null;
  const mmFor = who && isClassic(who.appId) ? mmClassic : mm;
  if (isMm && !accountId) {
    log('ws.jsonl', { event: 'rejected', path: req.url, reason: 'missing or invalid token', headers: req.headers });
    console.log(`ws rejected ${String(req.url).slice(0, 200)} (401)`);
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  if (accountId && moderation.isBanned(accountId)) {   // moderation
    log('ws.jsonl', { event: 'rejected', path: req.url, reason: 'banned', account: accountId });
    console.log(`ws rejected ${String(req.url).slice(0, 200)} (403 banned ${accountId})`);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  if (accountId) moderation.recordIp(accountId, ip);   // owner-only IP history (matchmaking and stream sockets with an account)
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const proto = req.headers['sec-websocket-protocol'];
  wsTotal++; wsByIp.set(ip, (wsByIp.get(ip) || 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true; wsTotal--;
    const n = (wsByIp.get(ip) || 1) - 1;
    if (n > 0) wsByIp.set(ip, n); else wsByIp.delete(ip);
  };
  socket.once('close', release);
  socket.setTimeout(0);
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` + (proto ? `Sec-WebSocket-Protocol: ${String(proto).trim().replace(/[\r\n]/g, '')}\r\n` : '') /* the client's lws registers one protocol literally named "wss,ws" and rejects a reply naming only "wss" */ + '\r\n');
  const id = crypto.randomBytes(4).toString('hex');
  log('ws.jsonl', { id, event: 'open', path: req.url, ip, account: accountId, headers: req.headers });
  console.log(`ws ${id} open ${String(req.url).slice(0, 200)}${accountId ? ` account ${accountId}${mmFor === mmClassic ? ' (classic)' : ''}` : ''}`);

  const sendFrame = (opcode, payload) => {
    if (socket.destroyed || !socket.writable) return;
    if (socket.writableLength > 4 * 1024 * 1024) { socket.destroy(); return; }   // a peer that never reads
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
    mmFor.onConnect(client);
  }
  // hero-tv: Stream service, `ready` on connect like matchmaking, then server/stream.js. Every frame both ways is
  // logged to ws.jsonl with stream:true so the real HERO shapes can be read off the live logs.
  let streamConn = null;
  if (isStream) {
    const web = wsQuery.get('client') === 'web' ? { role: String(wsQuery.get('role') || ''), target: String(wsQuery.get('target') || '') } : null;
    streamConn = stream.connect({
      id, account: accountId || '', web,
      send(obj) {
        const text = JSON.stringify(obj);
        sendFrame(0x1, Buffer.from(text));
        if (!web || obj.type !== 'message') log('ws.jsonl', { id, event: 'sent', stream: true, text });   // skip web topic spam
      },
    });
    streamConn.send({ type: 'ready' });
  }

  // ---- frame parser (RFC 6455, client side frames only) ----
  // Client frames must be masked, RSV bits clear, opcodes 0-2 and 8-10 only; control frames are FIN and <= 125 bytes;
  // one frame and one reassembled message are capped at WS_MAX_FRAME (close 1009). Pending bytes are kept as a chunk
  // list and joined once per frame (never re-joined per chunk), so a slow trickle costs O(total) not O(total^2).
  let pend = [], pendLen = 0;
  let frag = null;                      // { opcode, parts, len } while a fragmented message is being assembled
  let closing = false;
  let lastRx = Date.now();
  let msgWinStart = Date.now(), msgCount = 0;
  const closeWith = (code) => {
    if (closing) return;
    closing = true;
    pend = []; pendLen = 0; frag = null;
    try { sendFrame(0x8, Buffer.from([code >> 8, code & 255])); socket.end(); } catch { /* gone */ }
    setTimeout(() => { try { socket.destroy(); } catch { /* gone */ } }, 1000).unref();
  };
  const joined = () => { if (pend.length > 1) pend = [Buffer.concat(pend, pendLen)]; return pend[0]; };
  function onMessage(opcode, payload) {
    const now = Date.now();
    if (now - msgWinStart >= WS_MSG_WINDOW_MS) { msgWinStart = now; msgCount = 0; }
    if (++msgCount > WS_MSG_MAX) return closeWith(1008);
    const text = payload.toString('utf8');
    if (!(streamConn && streamConn.web)) log('ws.jsonl', isStream ? { id, event: 'msg', stream: true, opcode, text } : { id, event: 'msg', opcode, text });
    if (!isStream) console.log(`ws ${id} <- ${text.slice(0, 200)}`);
    if (client) mmFor.onMessage(client, text);
    else if (streamConn) stream.message(streamConn, text);   // hero-tv
  }
  function onWsData(d) {
    if (closing) return;
    lastRx = Date.now();
    pend.push(d); pendLen += d.length;
    while (!closing && pendLen >= 2) {
      const head = pend.length === 1 || pend[0].length >= 14 ? pend[0] : joined();
      const b0 = head[0], b1 = head[1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      if ((b0 & 0x70) || !masked) return closeWith(1002);
      if ((opcode > 2 && opcode < 8) || opcode > 10) return closeWith(1002);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (head.length < 4) return; len = head.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (head.length < 10) return;
        const big = head.readBigUInt64BE(2);
        if (big > BigInt(WS_MAX_FRAME)) return closeWith(1009);
        len = Number(big); off = 10;
      }
      if (opcode >= 8 && (!fin || len > 125)) return closeWith(1002);
      if (len > WS_MAX_FRAME) return closeWith(1009);
      const need = off + 4 + len;
      if (pendLen < need) return;   // wait for the rest of the frame (bounded by WS_MAX_FRAME)
      const buf = joined();
      const payload = Buffer.allocUnsafe(len);
      const m0 = buf[off], m1 = buf[off + 1], m2 = buf[off + 2], m3 = buf[off + 3];
      const base = off + 4;
      for (let i = 0; i + 3 < len; i += 4) {
        payload[i] = buf[base + i] ^ m0; payload[i + 1] = buf[base + i + 1] ^ m1;
        payload[i + 2] = buf[base + i + 2] ^ m2; payload[i + 3] = buf[base + i + 3] ^ m3;
      }
      const mk = [m0, m1, m2, m3];
      for (let i = len & ~3; i < len; i++) payload[i] = buf[base + i] ^ mk[i & 3];
      if (need < buf.length) { pend = [buf.subarray(need)]; pendLen = buf.length - need; } else { pend = []; pendLen = 0; }

      if (opcode === 0x8) { closing = true; sendFrame(0x8, Buffer.alloc(0)); socket.end(); return; }
      if (opcode === 0x9) { sendFrame(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0) {   // continuation
        if (!frag) return closeWith(1002);
        frag.len += len;
        if (frag.len > WS_MAX_FRAME) return closeWith(1009);
        frag.parts.push(payload);
        if (fin) { const whole = Buffer.concat(frag.parts, frag.len), op = frag.opcode; frag = null; onMessage(op, whole); }
        continue;
      }
      if (frag) return closeWith(1002);   // a new data frame while a fragmented message is open
      if (!fin) { frag = { opcode, parts: [payload], len }; continue; }
      onMessage(opcode, payload);
    }
  }
  socket.on('data', (d) => { try { onWsData(d); } catch (e) {
    console.error(`!! ws ${id} frame: ${e && e.stack || e}`);
    try { log('errors.jsonl', { ws: id, error: String(e && e.stack || e).slice(0, 2000) }); } catch { /* ignore */ }
    socket.destroy();
  } });
  // Keepalive: ping every WS_PING_MS; a socket that has sent nothing (a pong counts) for WS_IDLE_MS is dropped, so a dead
  // peer or a client that upgraded and never spoke cannot hold a seat forever.
  const keepalive = setInterval(() => {
    try {
      if (Date.now() - lastRx > WS_IDLE_MS) { socket.destroy(); return; }
      sendFrame(0x9, Buffer.alloc(0));
    } catch { /* socket gone */ }
  }, WS_PING_MS);
  keepalive.unref();
  // The http server leaves upgraded sockets half-open, so a client that just drops the TCP connection
  // (no close frame) would otherwise never reach 'close' and keep its seat in a session.
  socket.on('end', () => socket.end());
  socket.on('close', () => {
    clearInterval(keepalive);
    try {
      if (client) mmFor.onClose(client);
      if (streamConn) stream.disconnect(streamConn);   // hero-tv
    } catch (e) { console.error(`!! ws ${id} close: ${e && e.stack || e}`); }
    log('ws.jsonl', { id, event: 'close' });
    console.log(`ws ${id} closed`);
  });
}

// Never let one bad request or socket take every lobby down: log and keep serving (the container still restarts
// if the process dies some other way, restart: unless-stopped).
process.on('uncaughtException', (e) => { console.error(`!! uncaughtException: ${e && e.stack || e}`); try { log('errors.jsonl', { uncaught: true, error: String(e && e.stack || e).slice(0, 2000) }); } catch { /* ignore */ } });
process.on('unhandledRejection', (e) => { console.error(`!! unhandledRejection: ${e && e.stack || e}`); try { log('errors.jsonl', { unhandledRejection: true, error: String(e && e.stack || e).slice(0, 2000) }); } catch { /* ignore */ } });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OG SOS Revival backend listening on http://0.0.0.0:${PORT}`);
  console.log(`Logs: ${LOG_DIR}   ("??" lines = calls we don't handle yet)`);
  const shown = (cfg) => (cfg.PUBLIC_HOST ? `${cfg.PUBLIC_HOST} (PUBLIC_HOST)` : `not set, clients get ${cfg.GAME_SERVER_HOST} (GAME_SERVER_HOST) or the host entry's host`);
  console.log(`Public address handed to clients: main ${shown(CONFIG)}; classic ${shown(CLASSIC_CONFIG)}`);
});

// Typing `start` + Enter force-starts every hosted session. Harmless when stdin is closed or not a terminal.
try {
  const rl = require('readline').createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (line.trim().toLowerCase() !== 'start') return;
    const all = [...mmClassic.forceStartAll(), ...mm.forceStartAll()];
    console.log(all.length ? `forced start: ${all.map((x) => `${x.id} (${x.players} player(s))`).join(', ')}` : 'no hosted sessions configured');
  });
  rl.on('error', () => {});
  process.stdin.on('error', () => {});
} catch { /* no usable stdin */ }
