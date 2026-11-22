'use strict';
// Moderation: player reports, bans, host blocks, audit log, and the /admin panel backend (Steam OpenID login,
// cookie session, JSON API, static panel files from server/web/admin). Pure-ish module: the shared JSON db,
// matchmakers and progression are passed in by server.js. See the moderation spec in the repo history.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const https = require('https');
const { badKey, nullProto } = require('./safe');

const WEB_DIR = path.join(__dirname, 'web', 'admin');
const COOKIE = 'ogsos_admin';
const COOKIE_TTL_SEC = 12 * 3600;
const MAX_REPORTS = 5000;
const MAX_AUDIT = 20000;
const MAX_BODY = 16 * 1024;
const ID_RE = /^[\w.-]{1,64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const STEAM_CLAIMED_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(7656\d{13})$/;
const STATIC_RE = /^[a-z0-9_-]+\.(html|css|js|svg|png)$/;
const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', png: 'image/png' };
const HOUR = 3600 * 1000;
const BAN_CODES = ['cheating', 'harassment', 'spam', 'bad-username', 'toxicity', 'stream-sniping', 'ban-evasion', 'other'];
const PERMANENT_SECONDS = 315360000;   // the client words only 86400 (1 day) and 604800 (7 days); anything else reads as "permanently"
const WATCH_TTL_MS = 3 * HOUR;
const REPORT_STATUSES = ['open', 'investigating', 'resolved', 'dismissed'];
const LOBBY_ACTIONS = ['force-start', 'countdown', 'end', 'reset', 'lock', 'unlock', 'options'];
const RATING_PATHS = {   // adjust.ratings key -> path inside the blob (docs/PROGRESSION.md section 2)
  fameSolo: ['soloRatings', 'fame'], fameDuo: ['duoRatings', 'fame'], survivalSolo: ['soloRatings', 'survival'],
  survivalDuo: ['duoRatings', 'survival'], toxicity: ['toxicity'],
};
// Level curve (docs/PROGRESSION.md section 1): XP to the next level, linear between the keys, constant after 20.
const XP_KEYS = [[1, 500], [3, 1900], [6, 3400], [10, 5000], [20, 7000]];
function xpToNext(level) {
  if (level <= XP_KEYS[0][0]) return XP_KEYS[0][1];
  for (let i = 1; i < XP_KEYS.length; i++) {
    const [x1, y1] = XP_KEYS[i];
    if (level <= x1) { const [x0, y0] = XP_KEYS[i - 1]; return Math.round(y0 + ((y1 - y0) * (level - x0)) / (x1 - x0)); }
  }
  return XP_KEYS[XP_KEYS.length - 1][1];
}
// KV keys an owner may override (never auth, URL, role, director, test-server or matchmaking-gate keys).
// min/max apply to numbers; strings are capped at 500 characters.
const KV_ALLOW = {
  UE_CLIENT_MOTD: { description: 'Message of the day shown in the main menu' },
  UE_CLIENT_TEST_SERVER_MOTD: { description: 'Message of the day shown on the test server screen' },
  UE_CLIENT_INACTIVE_SERVER_TEXT: { description: 'Text shown when matchmaking is closed' },
  UE_CLIENT_DUOS_QUEUE_WARNING_TIME_SEC: { min: 0, max: 600, description: 'Seconds in the duos queue before the long-wait warning' },
  UE_CLIENT_VOTING_ENABLED: { description: 'Show the vote UI' },
  UE_CLIENT_SURVIVAL_REQUIRED_GAMES: { min: 0, max: 100, description: 'Games before a survival rating shows (instead of UNRATED)' },
  UE_CLIENT_SURVIVAL_SOLO_REQUIRED_GAMES: { min: 0, max: 100, description: 'Games before a solo survival rating shows' },
  UE_CLIENT_SURVIVAL_DUO_REQUIRED_GAMES: { min: 0, max: 100, description: 'Games before a duo survival rating shows' },
  UE_CLIENT_SURVIVAL_ELO_K_FACTOR: { min: 1, max: 200, description: 'Survival rating K factor' },
  UE_CLIENT_SURVIVAL_SOLO_ELO_K_FACTOR: { min: 1, max: 200, description: 'Solo survival rating K factor' },
  UE_CLIENT_SURVIVAL_DUO_ELO_K_FACTOR: { min: 1, max: 200, description: 'Duo survival rating K factor' },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const b64u = (b) => Buffer.from(b).toString('base64url');
const clip = (v, n) => [...String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')].slice(0, n).join('').trim();
// A scalar from a loosely shaped client body: string/number as is, {id|account-id|player-id} objects unwrapped.
function scalar(v) {
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (isObj(v)) return scalar(v.id ?? v['account-id'] ?? v['player-id'] ?? v['user-id'] ?? '');
  return '';
}
const firstOf = (o, keys) => { for (const k of keys) { const s = scalar(o[k]); if (s) return s; } return ''; };

function parseBody(text) {
  const t = String(text || '').trim();
  if (!t) return {};
  try { const j = JSON.parse(t); if (isObj(j)) return j; } catch { /* maybe a form */ }
  const o = {};
  for (const [k, v] of new URLSearchParams(t)) o[k] = v;
  return o;
}

function ipv4ToInt(s) { return s.split('.').reduce((a, x) => (a * 256 + Number(x)), 0); }

function postForm(urlStr, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = new URLSearchParams(params).toString();
    const r = lib.request(u, { method: 'POST', timeout: timeoutMs, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (d) => { size += d.length; if (size > 65536) res.destroy(new Error('too large')); else chunks.push(d); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end(data);
  });
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function createModeration(opts = {}) {
  const { db, saveDb = () => {}, progression = null } = opts;
  const log = opts.log || (() => {});
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const jwtAccount = opts.jwtAccount || (() => null);
  const displayName = opts.displayName || ((id) => String(id));
  const matchmakers = opts.matchmakers || {};
  const onHostBlocksChanged = opts.onHostBlocksChanged || null;
  const fame = opts.fame || null;               // server/fame.js instance: heroStats, applyToBlob, adjust
  const community = opts.community || null;     // server/community.js registry
  const kvDir = opts.kvDir || path.join(__dirname, '..', 'data', 'kv-classic');   // read-only base files of the Classic KV
  const cookieKey = crypto.createHmac('sha256', String(opts.secret || 'ogsos-dev-secret')).update('ogsos-admin-cookie-v1').digest();

  const nowIso = () => new Date(now()).toISOString();
  const store = () => {
    const m = db.moderation = isObj(db.moderation) ? db.moderation : {};
    m.reports = Array.isArray(m.reports) ? m.reports : [];
    m.bans = isObj(m.bans) ? nullProto(m.bans) : Object.create(null);   // id-keyed maps are prototype-free
    m.hostBlocks = Array.isArray(m.hostBlocks) ? m.hostBlocks : [];
    m.audit = Array.isArray(m.audit) ? m.audit : [];
    m.seq = Number.isInteger(m.seq) ? m.seq : 0;
    m.mods = isObj(m.mods) ? nullProto(m.mods) : Object.create(null);
    m.notes = isObj(m.notes) ? nullProto(m.notes) : Object.create(null);
    m.warnings = isObj(m.warnings) ? nullProto(m.warnings) : Object.create(null);
    m.lobbyOptions = isObj(m.lobbyOptions) ? nullProto(m.lobbyOptions) : Object.create(null);
    m.kv = isObj(m.kv) ? nullProto(m.kv) : Object.create(null);
    m.kvRev = Number.isInteger(m.kvRev) ? m.kvRev : 0;
    return m;
  };
  store();
  // Stored reports from before the v2 workflow: 'actioned' became 'resolved', the single note string became a notes list.
  for (const r of store().reports) {
    if (r.status === 'actioned') r.status = 'resolved';
    if (!Array.isArray(r.notes)) r.notes = [];
    if (typeof r.note === 'string') {
      if (r.note) r.notes.push({ at: r.resolvedAt || r.at, by: r.resolvedBy || '', byName: r.resolvedBy ? displayName(r.resolvedBy) : '', text: r.note });
      delete r.note;
    }
    if (r.assignee === undefined) r.assignee = null;
  }
  const save = () => { try { saveDb(); } catch { /* keep serving */ } };
  const matches = () => (Array.isArray(db.matches) ? db.matches : []);
  const accounts = () => (isObj(db.accounts) ? db.accounts : {});
  // Roles: owners come from env OGSOS_ADMINS, mods from the db (added by an owner in the panel).
  const owners = () => new Set(String(env.OGSOS_ADMINS || '').split(/[\s,]+/).filter(Boolean));
  const admins = () => new Set([...owners(), ...Object.keys(store().mods)]);
  const roleOf = (id) => { const s = String(id); return owners().has(s) ? 'owner' : Object.prototype.hasOwnProperty.call(store().mods, s) ? 'mod' : null; };
  const isAdmin = (id) => !!roleOf(id);

  if (env.OGSOS_ADMIN_DEV_LOGIN === '1') console.warn('moderation: OGSOS_ADMIN_DEV_LOGIN=1, /admin/dev-login is enabled for loopback requests. Never set this in production.');

  // ---------- audit ----------
  function audit(by, byName, action, target, detail) {
    const m = store();
    const e = { at: nowIso(), by: by || '', byName: byName || '', action, target: target === undefined || target === null ? '' : String(target), detail: detail === undefined ? '' : clip(detail, 2000) };
    m.audit.push(e);
    while (m.audit.length > MAX_AUDIT) m.audit.shift();
    try { log('admin.jsonl', { ...e }); } catch { /* keep serving */ }
    return e;
  }

  // ---------- bans ----------
  const banActive = (b) => !!b && !b.lifted && (b.expiresAt === null || b.expiresAt === undefined || Date.parse(b.expiresAt) > now());
  function isBanned(steamId) {
    const b = store().bans[String(steamId)];
    return banActive(b) ? b : null;
  }
  // The body the real client parses on a refused login (HTTP 403): error forbidden, metadata.cause app-banned.
  function banBody(b) {
    const created = b.at || nowIso();
    const duration = b.expiresAt ? Math.max(1, Math.round((Date.parse(b.expiresAt) - Date.parse(created)) / 1000)) : PERMANENT_SECONDS;
    const ban = { created, exp: b.expiresAt || null, reason: BAN_CODES.includes(b.code) ? b.code : 'other', duration, type: 'app' };
    const body = { error: 'forbidden', metadata: { cause: 'app-banned', ban } };
    return { ...body, version: 1, data: body };
  }
  function filterPlayerMap(session) {
    const m = store();
    if (!session || !isObj(session['player-map']) || !Object.keys(m.bans).length) return session;
    const bad = new Set();
    for (const id of Object.keys(session['player-map'])) if (isBanned(id)) bad.add(id);
    if (!bad.size) return session;
    for (const id of bad) delete session['player-map'][id];
    if (isObj(session.groups)) {
      for (const [gid, g] of Object.entries(session.groups)) {
        if (Array.isArray(g)) session.groups[gid] = g.filter((x) => !bad.has(x));
        else if (isObj(g) && Array.isArray(g.players)) g.players = g.players.filter((x) => !bad.has(x));
      }
    }
    return session;
  }

  // ---------- hosted sessions ----------
  function hostedAll() {
    const out = [];
    for (const [game, mmx] of Object.entries(matchmakers)) {
      if (!mmx || typeof mmx.listHosted !== 'function') continue;
      for (const h of mmx.listHosted()) {
        const g = mmx.getHostedSession(h.id);
        const w = new Set(g && Array.isArray(g.session['ogsos-watchers']) ? g.session['ogsos-watchers'] : []);   // watchers are never seated
        out.push({ game, mm: mmx, h, ids: g ? Object.keys(g.session['player-map'] || {}).filter((id) => !w.has(id)) : [], watchers: [...w] });
      }
    }
    return out;
  }
  function seatOf(playerId) {
    for (const x of hostedAll()) if (x.ids.includes(playerId)) return x;
    return null;
  }
  function kickEverywhere(playerId) {
    const kicked = [];
    for (const x of hostedAll()) {
      if (!x.ids.includes(playerId)) continue;
      try { const r = x.mm.kickHosted(x.h.id, playerId); if (r && r.result) kicked.push(x.h.id); } catch { /* ignore */ }
    }
    for (const mmx of Object.values(matchmakers)) {
      const c = mmx && mmx._state && mmx._state.clients && mmx._state.clients.get(playerId);
      if (c && typeof c.close === 'function') { try { c.close(); } catch { /* ignore */ } }
    }
    return kicked;
  }

  // ---------- reports ----------
  const rate = { byReporter: new Map(), byPair: new Map() };
  function rateOk(reporter, target) {
    const t = now();
    const prune = (map, key) => { const a = (map.get(key) || []).filter((x) => t - x < HOUR); map.set(key, a); return a; };
    const a = prune(rate.byReporter, reporter), b = prune(rate.byPair, `${reporter}>${target}`);
    if (a.length >= 10 || b.length >= 3) return false;
    a.push(t); b.push(t);
    return true;
  }
  const summaryOf = (id) => {
    try { const s = progression && progression.playerSummary(id); return s && Object.keys(s).length ? s : null; } catch { return null; }
  };
  function snapshotFor(reporterId, targetId, sessionId) {
    let seat = seatOf(reporterId) || seatOf(targetId);
    if (sessionId) seat = hostedAll().find((x) => x.h.id === sessionId) || seat;
    const session = seat ? { id: seat.h.id, game: seat.game, state: seat.h.state, players: seat.ids } : null;
    let lastMatch = null;
    const ms = matches();
    for (let i = ms.length - 1; i >= 0 && !lastMatch; i--) {
      const m = ms[i];
      if (Array.isArray(m.players) && m.players.some((p) => p.playerId === targetId) && now() - Date.parse(m.endedAt) <= 2 * HOUR) lastMatch = m;
    }
    return { sid: seat ? seat.h.id : null, snapshot: { reporter: summaryOf(reporterId), target: summaryOf(targetId), session, lastMatch } };
  }
  function addReport(source, reporterId, f, rawBody) {
    const target = f.target;
    if (!target) return { status: 400, body: { error: 'no-target' } };
    if (!ID_RE.test(target)) return { status: 400, body: { error: 'bad-target' } };
    if (target === reporterId) return { status: 400, body: { error: 'self-report' } };
    if (!rateOk(reporterId, target)) return { status: 429, body: { error: 'rate-limited' } };
    const m = store();
    const sessionIn = f.sessionId && SESSION_ID_RE.test(f.sessionId) ? f.sessionId : null;
    const snap = snapshotFor(reporterId, target, sessionIn);
    let raw = null;
    try { const t = JSON.stringify(rawBody ?? null); raw = t.length <= 2000 ? JSON.parse(t) : t.slice(0, 2000); } catch { /* none */ }
    m.seq += 1;
    const report = {
      id: `r${m.seq}`, at: nowIso(), source, status: 'open',
      reporter: { id: reporterId, name: displayName(reporterId) },
      target: { id: target, name: displayName(target) },
      reason: clip(f.reason, 64), text: clip(f.text, 1000),
      gameGuid: f.gameGuid ? clip(f.gameGuid, 64) : null,
      evidenceVideoFormat: f.evidenceVideoFormat ? clip(f.evidenceVideoFormat, 32) : null,
      sessionId: sessionIn || snap.sid,
      matchId: f.matchId && ID_RE.test(f.matchId) ? f.matchId : null,
      evidenceUrl: /^https?:\/\/\S+$/i.test(f.evidenceUrl || '') ? String(f.evidenceUrl).slice(0, 500) : null,
      snapshot: snap.snapshot, resolvedBy: null, resolvedAt: null, notes: [], assignee: null, raw,
    };
    m.reports.push(report);
    while (m.reports.length > MAX_REPORTS) {
      const i = m.reports.findIndex((r) => r.status === 'resolved' || r.status === 'dismissed');
      m.reports.splice(i >= 0 ? i : 0, 1);
    }
    save();
    try { log('admin.jsonl', { event: 'report', id: report.id, source, reporter: reporterId, target, reason: report.reason }); } catch { /* ignore */ }
    return { status: 200, body: { version: 1, result: true, data: { result: true, id: report.id } }, report };
  }
  function handleReport(req, pathId, bodyText, token) {
    const reporter = jwtAccount(token);
    if (!reporter) return { status: 401, body: { error: 'unauthorized' } };
    const b = parseBody(bodyText);
    // The native client posts /api/account/<TARGET id>/app-meta/<app>/report (or the older /api/account/<id>/report):
    // the path id is the target unless the body names one.
    let target = firstOf(b, ['target', 'target-id', 'account-id', 'reported-id', 'player-id', 'reportee', 'user-id']);
    if (!target && pathId && pathId !== reporter) target = String(pathId);
    const gameGuid = clip(firstOf(b, ['game-session-id']), 64);   // the GameState GameGuid, NOT our MMS session id
    const out = addReport('game', reporter, {
      target,
      reason: firstOf(b, ['reason', 'type', 'category', 'report-type']),
      text: firstOf(b, ['notes', 'text', 'comment', 'message', 'description', 'details']),
      sessionId: firstOf(b, ['session-id', 'sessionId', 'session', 'match-id']),
      evidenceUrl: firstOf(b, ['evidence', 'evidenceUrl', 'url', 'clip']),
      gameGuid, evidenceVideoFormat: firstOf(b, ['evidence-video-format']),
    }, b);
    if (out.status === 200 && out.report) {
      const rp = out.report;
      // The reply the client parses (its typo key "game-session-d" is real; "game-session-id" is added too). The
      // version/result/data keys are kept for older callers.
      out.body.report = { created: rp.at, 'game-session-d': rp.gameGuid || '', 'game-session-id': rp.gameGuid || '', reason: rp.reason, notes: rp.text, 'reporter-id': rp.reporter.id, 'evidence-url': rp.evidenceUrl || '' };
    }
    return out;
  }
  // POST /api/reports/<reportId>/evidence: the reporter attaches a clip link afterwards.
  function handleEvidence(req, reportId, bodyText, token) {
    const who = jwtAccount(token);
    if (!who) return { status: 401, body: { error: 'unauthorized' } };
    const rp = store().reports.find((x) => x.id === String(reportId));
    if (!rp) return { status: 404, body: { error: 'not-found' } };
    if (rp.reporter.id !== who) return { status: 403, body: { error: 'forbidden' } };
    const url = firstOf(parseBody(bodyText), ['evidenceUrl']);
    if (!/^https?:\/\/\S+$/i.test(url) || url.length > 500) return { status: 400, body: { error: 'bad-evidence-url' } };
    rp.evidenceUrl = url;
    save();
    try { log('admin.jsonl', { event: 'report-evidence', id: rp.id, reporter: who }); } catch { /* ignore */ }
    return { status: 200, body: { version: 1, result: true, data: { result: true, id: rp.id } } };
  }
  function handleReportApi(req, bodyText, token) {
    const reporter = jwtAccount(token);
    if (!reporter) return { status: 401, body: { error: 'unauthorized' } };
    const b = parseBody(bodyText);
    return addReport('api', reporter, {
      target: firstOf(b, ['target']), reason: firstOf(b, ['reason']), text: firstOf(b, ['text']),
      sessionId: firstOf(b, ['sessionId']), matchId: firstOf(b, ['matchId']), evidenceUrl: firstOf(b, ['evidenceUrl']),
    }, b);
  }
  function onMatchEnd(sessionId, matchId) {
    if (!sessionId || !matchId) return 0;
    let n = 0;
    for (const r of store().reports) {
      if (r.sessionId === sessionId && !r.matchId && now() - Date.parse(r.at) <= 4 * HOUR) { r.matchId = String(matchId).slice(0, 64); n++; }
    }
    if (n) save();
    return n;
  }

  // ---------- host blocks ----------
  const activeBlockValues = () => store().hostBlocks.filter((h) => !h.lifted).map((h) => h.value);
  const notifyBlocks = () => { if (onHostBlocksChanged) { try { onHostBlocksChanged(activeBlockValues()); } catch { /* ignore */ } } };
  notifyBlocks();
  function blockKind(v) {
    if (net.isIPv4(v)) return 'ip';
    const m = v.match(/^([\d.]+)\/(\d{1,2})$/);
    if (m && net.isIPv4(m[1]) && +m[2] >= 8 && +m[2] <= 32) return 'cidr';
    if (SESSION_ID_RE.test(v)) return 'id';
    return null;
  }
  // Also exposed for the future community.js wiring: does an IPv4 fall under an active ip/cidr block?
  function isHostBlocked(ip) {
    if (!net.isIPv4(String(ip))) return false;
    const x = ipv4ToInt(ip);
    for (const h of store().hostBlocks) {
      if (h.lifted) continue;
      if (h.kind === 'ip' && h.value === ip) return true;
      if (h.kind === 'cidr') {
        const [base, len] = h.value.split('/');
        const mask = len === '0' ? 0 : (0xffffffff << (32 - Number(len))) >>> 0;
        if (((x & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0)) return true;
      }
    }
    return false;
  }

  // ---------- cookie ----------
  const sign = (payload) => crypto.createHmac('sha256', cookieKey).update(payload).digest('base64url');
  function makeCookie(sid, name) {
    const iat = Math.floor(now() / 1000);
    const p = b64u(JSON.stringify({ sid, n: name, iat, exp: iat + COOKIE_TTL_SEC }));
    return `${p}.${sign(p)}`;
  }
  function readCookie(req) {
    const h = String(req.headers.cookie || '');
    for (const part of h.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return null;
  }
  function adminFrom(req) {
    const c = readCookie(req);
    if (!c) return null;
    const [p, s] = c.split('.');
    if (!p || !s) return null;
    const want = Buffer.from(sign(p)), got = Buffer.from(s);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    let j; try { j = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; }
    if (!j || typeof j.sid !== 'string' || !(j.exp > now() / 1000)) return null;
    const role = roleOf(j.sid);   // re-checked on every request: a removed mod loses access at once
    if (!role) return null;
    return { steamId: j.sid, name: String(j.n || j.sid), role };
  }

  // ---------- http helpers ----------
  const SEC_HEADERS = {
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https://avatars.steamstatic.com data:; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  function respond(res, status, body, type, extra) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': buf.length, ...SEC_HEADERS, ...(extra || {}) });
    res.end(buf);
  }
  const json = (res, status, body, extra) => respond(res, status, body, undefined, extra);
  const redirect = (res, loc, extra) => { res.writeHead(302, { Location: loc, 'Content-Length': 0, ...SEC_HEADERS, ...(extra || {}) }); res.end(); };
  const page = (res, status, title, msg) => respond(res, status, `<!doctype html><meta charset="utf-8"><title>${escHtml(title)}</title><body style="font-family:sans-serif;margin:2em"><h1>${escHtml(title)}</h1><p>${escHtml(msg)}</p><p><a href="/admin/">Back</a></p>`, 'text/html; charset=utf-8');

  function originOf(req) {
    const o = String(env.OGSOS_ADMIN_ORIGIN || '').trim().replace(/\/+$/, '');
    if (o) return o;
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() === 'https' ? 'https' : 'http';
    return `${proto}://${req.headers.host || 'localhost'}`;
  }
  const openidUrl = () => String(env.OGSOS_STEAM_OPENID || 'https://steamcommunity.com/openid/login');
  const setCookieHeader = (req, value, maxAge) =>
    `${COOKIE}=${value}; HttpOnly; Path=/admin; SameSite=Strict; Max-Age=${maxAge}${originOf(req).startsWith('https:') ? '; Secure' : ''}`;
  function startSession(req, res, sid) {
    const name = displayName(sid) || sid;
    audit(sid, name, 'login', sid, '');
    save();
    redirect(res, '/admin/', { 'Set-Cookie': setCookieHeader(req, makeCookie(sid, name), COOKIE_TTL_SEC) });
  }

  function handleLogin(req, res) {
    const origin = originOf(req);
    const q = new URLSearchParams({
      'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'checkid_setup',
      'openid.return_to': `${origin}/admin/auth`, 'openid.realm': origin,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    });
    const base = openidUrl();
    redirect(res, `${base}${base.includes('?') ? '&' : '?'}${q}`);
  }

  async function handleAuth(req, url, res) {
    const p = {};
    for (const [k, v] of url.searchParams) if (k.startsWith('openid.')) p[k] = v;
    const origin = originOf(req);
    const ret = p['openid.return_to'] || '';
    const m = String(p['openid.claimed_id'] || '').match(STEAM_CLAIMED_RE);
    // The signature must cover everything we rely on (OpenID 2.0 section 11.1), and the assertion must be recent.
    const signed = new Set(String(p['openid.signed'] || '').split(','));
    const signedOk = ['claimed_id', 'identity', 'return_to', 'response_nonce', 'op_endpoint'].every((f) => signed.has(f));
    const nonceAt = Date.parse((String(p['openid.response_nonce'] || '').match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)/) || [])[1] || '');
    const nonceFresh = Number.isFinite(nonceAt) && Math.abs(now() - nonceAt) <= 5 * 60 * 1000;
    if (p['openid.mode'] !== 'id_res' || !(ret === `${origin}/admin/auth` || ret.startsWith(`${origin}/admin/auth?`))
      || p['openid.op_endpoint'] !== openidUrl() || !m || (p['openid.identity'] && p['openid.identity'] !== p['openid.claimed_id'])
      || !signedOk || !nonceFresh) {
      audit('', '', 'login-failed', '', 'bad assertion');
      return page(res, 400, 'Sign-in failed', 'The Steam response was not valid.');
    }
    let valid = false;
    try {
      const back = { ...p, 'openid.mode': 'check_authentication' };
      const text = await postForm(openidUrl(), back, 10000);
      valid = text.split(/\r?\n/).some((l) => l.trim() === 'is_valid:true');
    } catch { valid = false; }
    if (!valid) {
      audit('', '', 'login-failed', m[1], 'steam did not validate');
      return page(res, 400, 'Sign-in failed', 'Steam did not validate the sign-in.');
    }
    const sid = m[1];
    if (!admins().has(sid)) {
      audit(sid, '', 'login-denied', sid, '');
      save();
      return page(res, 403, 'Not an admin', 'This Steam account is not on the admin list.');
    }
    startSession(req, res, sid);
  }

  function handleDevLogin(req, url, res) {
    const addr = req.socket && req.socket.remoteAddress;
    const loop = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    if (env.OGSOS_ADMIN_DEV_LOGIN !== '1' || !loop || req.headers['x-forwarded-for']) return json(res, 404, { error: 'not-found' });
    const sid = String(url.searchParams.get('steamid') || '');
    if (!admins().has(sid)) return json(res, 403, { error: 'not-an-admin' });
    startSession(req, res, sid);
  }

  function serveStatic(rel, res) {
    const name = rel === '' ? 'index.html' : rel;
    if (!STATIC_RE.test(name)) return json(res, 404, { error: 'not-found' });
    const f = path.join(WEB_DIR, name);
    let buf;
    try { buf = fs.readFileSync(f); } catch { return json(res, 404, { error: 'not-found' }); }
    return respond(res, 200, buf, TYPES[name.split('.').pop()]);
  }

  // ---------- admin API ----------
  const nameOf = (id) => displayName(id);
  const matchEntry = (mt, id) => (Array.isArray(mt.players) ? mt.players.find((p) => p.playerId === id) : null);
  const listReportsAgainst = (id) => store().reports.filter((r) => r.target.id === id);
  const listReportsBy = (id) => store().reports.filter((r) => r.reporter.id === id);
  const stripRaw = ({ raw, ...rest }) => rest;
  const activeBanFor = (id) => isBanned(id);
  const forbidOwnerOnly = (res) => json(res, 403, { error: 'owner-only' });

  // The lobby entry (listHosted shape) for a session id, plus its matchmaker.
  const findLobby = (sessionId, game) => hostedAll().find((y) => y.h.id === sessionId && (!game || y.game === game)) || null;
  const lobbyView = (x) => {
    const fresh = x.mm.listHosted().find((h) => h.id === x.h.id) || x.h;
    return { game: x.game, ...fresh };
  };
  const serverOf = (sessionId) => {
    const x = sessionId ? findLobby(sessionId) : null;
    return x ? { name: x.h.name, game: x.game, community: !!x.h.community } : null;
  };

  // ---- Classic player blob helpers ----
  const BLOB_APP = 'sostest';
  const blobKey = (id) => `${id}/${BLOB_APP}`;
  const rawBlob = (id) => { const b = isObj(db.appData) ? db.appData[blobKey(id)] : null; return b && isObj(b.data) ? b.data : null; };
  // What the game host sees on GET (the stored blob with Fame filled in).
  const seenBlob = (id) => {
    const d = rawBlob(id);
    if (!d) return null;
    try { const o = fame && typeof fame.applyToBlob === 'function' ? fame.applyToBlob(id, d) : d; return isObj(o) ? o : d; } catch { return d; }
  };
  const ratingOf = (d, key) => {
    let o = d && d.ratings;
    for (const k of RATING_PATHS[key]) o = isObj(o) ? o[k] : undefined;
    return isObj(o) && typeof o.rating === 'number' ? o.rating : null;
  };
  function profileOf(id) {
    const d = seenBlob(id);
    let heroStats = null;
    try { heroStats = fame && typeof fame.heroStats === 'function' ? fame.heroStats(id) : null; } catch { /* none */ }
    if (!d) return { level: null, levelProgress: null, ratings: {}, fame: heroStats };
    const prog = isObj(d.progression) ? d.progression : {};
    const level = Number.isFinite(prog.level) ? prog.level : null;
    const levelProgress = Number.isFinite(prog.levelProgress) ? prog.levelProgress : null;
    const out = { level, levelProgress, ratings: {}, fame: heroStats };
    if (level !== null && levelProgress !== null) { const need = xpToNext(level); out.xpToNext = need; out.xpIntoLevel = Math.round(levelProgress * need); }
    for (const k of Object.keys(RATING_PATHS)) out.ratings[k] = ratingOf(d, k);
    return out;
  }
  const watchedBy = (id) => hostedAll().find((x) => x.watchers.includes(id)) || null;

  // ---- lobby control ----
  function persistLobby(sessionId, view) {
    const m = store();
    const o = view.overrides || {};
    if (view.locked || Object.keys(o).length) m.lobbyOptions[sessionId] = { locked: !!view.locked, overrides: { ...o } };
    else delete m.lobbyOptions[sessionId];
  }
  // Re-apply the stored options (startup, and when a community host registers again with its old session id).
  function reapplyLobbyOptions(onlyId) {
    let n = 0;
    for (const [sid, o] of Object.entries(store().lobbyOptions)) {
      if (onlyId && sid !== onlyId) continue;
      for (const mmx of Object.values(matchmakers)) {
        if (!mmx || typeof mmx.setLobbyOptions !== 'function') continue;
        const ov = o.overrides || {};
        const r = mmx.setLobbyOptions(sid, { locked: !!o.locked, minPlayers: ov.minPlayers ?? null, countdownSec: ov.countdownSec ?? null, maxPlayers: ov.maxPlayers ?? null });
        if (!r.error) { n++; break; }
      }
    }
    return n;
  }
  reapplyLobbyOptions();

  function lobbyAction(admin, sessionId, action, b) {
    const x = findLobby(sessionId, b.game);
    if (!x) return { status: 404, body: { error: 'not-found' } };
    const mmx = x.mm, id = x.h.id;
    const view = () => lobbyView(x);
    const seated = x.h.players;
    const done = (detail) => { audit(admin.steamId, admin.name, `lobby-${action}`, id, detail); save(); return { status: 200, body: { ok: true, lobby: view() } }; };
    const opts = (o) => {
      const before = view();
      const r = mmx.setLobbyOptions(id, o);
      if (r.error) return { status: r.error === 'not-found' ? 404 : 400, body: { error: r.error } };
      persistLobby(id, r);
      const fmt = (v) => JSON.stringify({ locked: v.locked, ...v.overrides });
      return done(`${fmt(before)} -> ${fmt(r)}`);
    };
    if (action === 'force-start') {
      if (x.h.state !== 'waiting' && x.h.state !== 'countdown') return { status: 409, body: { error: 'closed', state: x.h.state } };
      if (!seated) return { status: 409, body: { error: 'no-players' } };
      mmx.forceStartHosted(id);
      return done(`${seated} seated`);
    }
    if (action === 'countdown') {
      let sec;
      if (b.sec !== undefined && b.sec !== null && b.sec !== '') {
        sec = typeof b.sec === 'string' ? Number(b.sec) : b.sec;
        if (!Number.isInteger(sec) || sec < 0 || sec > 600) return { status: 400, body: { error: 'bad-sec' } };
      }
      const r = mmx.countdownHosted(id, sec);
      if (r.error) return { status: r.error === 'not-found' ? 404 : 409, body: { error: r.error, ...(r.state ? { state: r.state } : {}) } };
      return done(sec === undefined ? 'default' : `${sec}s`);
    }
    if (action === 'end') {
      if (x.h.state === 'ended') return { status: 409, body: { error: 'closed', state: 'ended' } };
      const n = mmx.endHosted(id);
      return done(`${n} released`);
    }
    if (action === 'reset') {
      const n = mmx.resetHosted(id);
      return done(`${n} released`);
    }
    if (action === 'lock' || action === 'unlock') return opts({ locked: action === 'lock' });
    if (action === 'options') {
      const o = {};
      for (const k of ['minPlayers', 'countdownSec', 'maxPlayers']) if (b[k] !== undefined) o[k] = b[k];
      if (!Object.keys(o).length) return { status: 400, body: { error: 'no-options' } };
      return opts(o);
    }
    return { status: 404, body: { error: 'not-found' } };
  }

  // ---- announcements / KV overlay ----
  const readBaseRev = () => {
    try { const t = fs.readFileSync(path.join(kvDir, 'live-rev.txt'), 'utf8').trim(); return /^\d{1,9}$/.test(t) ? Number(t) : null; } catch { return null; }
  };
  const readBaseKv = (rev) => {
    if (rev === null) return null;
    try { const j = JSON.parse(fs.readFileSync(path.join(kvDir, `runtime-${rev}.json`), 'utf8')); return isObj(j) ? j : null; } catch { return null; }
  };
  // Does `value` keep the base value's JSON type and the key's limits? -> null when fine, else an error code.
  function kvCheck(key, base, value) {
    const spec = KV_ALLOW[key];
    if (!spec) return 'not-allowed';
    if (typeof base === 'string') return typeof value === 'string' && value.length <= 500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ? null : 'bad-value';
    if (typeof base === 'number') return typeof value === 'number' && Number.isFinite(value) && value >= (spec.min ?? -1e9) && value <= (spec.max ?? 1e9) ? null : 'bad-value';
    if (typeof base === 'boolean') return typeof value === 'boolean' ? null : 'bad-value';
    return 'bad-value';
  }
  function applyKv(obj) {
    const out = { ...obj };
    for (const [k, v] of Object.entries(store().kv)) if (k in out && !kvCheck(k, out[k], v)) out[k] = v;
    return out;
  }
  // The revision clients see: the base revision plus one step per overlay change. The file name depends on the revision
  // (runtime-<rev>.json), so a changed overlay needs a NEW revision or running clients keep their cached copy.
  const servedRev = () => { const b = readBaseRev(); return b === null ? null : b + store().kvRev; };
  // For server.js handleKv (Classic only): {body, type} to serve instead of the plain file, or null to fall through.
  function kvServe(rel) {
    const m = store();
    if (!m.kvRev) return null;
    const base = readBaseRev();
    if (base === null) return null;
    const served = base + m.kvRev;
    if (rel === 'live-rev.txt') return { body: String(served), type: 'text/plain' };
    const r = String(rel).match(/^runtime-(\d{1,9})\.json$/);
    if (!r) return null;
    const n = Number(r[1]);
    const file = n > base && n <= served ? base : n;   // every overlay revision served so far is the base file + the overlay
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(kvDir, `runtime-${file}.json`), 'utf8')); } catch { return null; }
    if (!isObj(j)) return null;
    return { body: JSON.stringify(applyKv(j), null, 2), type: 'application/json' };
  }

  // ---- audit filters / csv ----
  function auditFiltered(url, defLimit, maxLimit) {
    const by = url.searchParams.get('by') || '', action = url.searchParams.get('action') || '', target = url.searchParams.get('target') || '';
    const before = url.searchParams.get('before') || '';
    const limit = Math.min(maxLimit, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || defLimit));
    const out = [];
    const a = store().audit;
    for (let i = a.length - 1; i >= 0 && out.length < limit; i--) {
      const e = a[i];
      if (by && e.by !== by) continue;
      if (action && e.action !== action) continue;
      if (target && e.target !== target) continue;
      if (before && !(e.at < before)) continue;
      out.push(e);
    }
    return out;
  }
  const csvCell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;   // spreadsheet formula injection
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const toCsv = (rows) => ['at,by,byName,action,target,detail', ...rows.map((e) => [e.at, e.by, e.byName, e.action, e.target, e.detail].map(csvCell).join(','))].join('\r\n') + '\r\n';

  function apiGet(admin, sub, url, res) {
    const m = store();
    let r;
    if (sub === 'me') return json(res, 200, { steamId: admin.steamId, name: admin.name, role: admin.role });

    if (sub === 'admins') {
      return json(res, 200, {
        owners: [...owners()].map((id) => ({ steamId: id, name: nameOf(id) })),
        mods: Object.entries(m.mods).map(([id, v]) => ({ steamId: id, name: nameOf(id) || v.name || id, addedBy: v.addedBy, at: v.at })),
      });
    }

    if (sub === 'dashboard') {
      const t = now();
      const dayStart = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());
      let today = 0, week = 0;
      for (const mt of matches()) { const e = Date.parse(mt.endedAt); if (e >= dayStart) today++; if (e >= t - 7 * 24 * HOUR) week++; }
      const cnt = (k) => (matchmakers[k] && matchmakers[k]._state && matchmakers[k]._state.clients ? matchmakers[k]._state.clients.size : 0);
      const qn = (k) => (matchmakers[k] && matchmakers[k]._state && matchmakers[k]._state.queue ? matchmakers[k]._state.queue.length : 0);
      const lobbies = hostedAll().map((x) => ({
        id: x.h.id, game: x.game, name: x.h.name, state: x.h.state, players: x.h.players, maxPlayers: x.h.maxPlayers, online: x.h.online,
        lastSeenSec: x.h.lastSeenSec, locked: !!x.h.locked, community: !!x.h.community, verified: !!x.h.verified, countdownEndsAt: x.h.countdownEndsAt,
      }));
      return json(res, 200, {
        playersOnline: { classic: cnt('classic'), main: cnt('main') }, queue: { classic: qn('classic'), main: qn('main') },
        seated: lobbies.reduce((n, l) => n + (l.players || 0), 0), lobbies,
        hosts: { up: lobbies.filter((l) => l.online).length, down: lobbies.filter((l) => !l.online).length },
        matches: { today, week },
        reports: { open: m.reports.filter((x) => x.status === 'open').length, investigating: m.reports.filter((x) => x.status === 'investigating').length },
        bansActive: Object.values(m.bans).filter(banActive).length, generatedAt: new Date(t).toISOString(),
      });
    }

    if (sub === 'servers') {
      const servers = [];
      for (const x of hostedAll()) {
        const players = x.ids.map((id) => ({ id, name: nameOf(id), banned: !!isBanned(id), host: !accounts()[id] }));
        servers.push({
          game: x.game, id: x.h.id, name: x.h.name, region: x.h.region, online: x.h.online, state: x.h.state, map: x.h.map,
          address: `${x.h.publicHost || x.h.host}:${x.h.port}`, players, playerCount: x.h.players, maxPlayers: x.h.maxPlayers,
          startedAt: x.h.startedAt, watchers: x.watchers.map((id) => ({ id, name: nameOf(id) })),
          minPlayers: x.h.minPlayers, locked: !!x.h.locked, overrides: x.h.overrides || {}, effective: x.h.effective || null, maxCap: x.h.maxCap || null,
          community: !!x.h.community, verified: !!x.h.verified, countdownEndsAt: x.h.countdownEndsAt, lastSeenSec: x.h.lastSeenSec,
        });
      }
      const cnt = (k) => (matchmakers[k] && matchmakers[k]._state && matchmakers[k]._state.clients ? matchmakers[k]._state.clients.size : 0);
      const qn = (k) => (matchmakers[k] && matchmakers[k]._state && matchmakers[k]._state.queue ? matchmakers[k]._state.queue.length : 0);
      return json(res, 200, { servers, online: { classic: cnt('classic'), main: cnt('main') }, queue: { classic: qn('classic'), main: qn('main') } });
    }

    if (sub === 'players') {
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 50));
      const repAgainst = {}, repBy = {}, matchCount = {};
      for (const rp of m.reports) { repAgainst[rp.target.id] = (repAgainst[rp.target.id] || 0) + 1; repBy[rp.reporter.id] = (repBy[rp.reporter.id] || 0) + 1; }
      for (const mt of matches()) for (const p of mt.players || []) matchCount[p.playerId] = (matchCount[p.playerId] || 0) + 1;
      const out = [];
      for (const a of Object.values(accounts())) {
        const id = String(a.id ?? a['account-id'] ?? '');
        if (!id) continue;
        const name = String(a['display-name'] || a.alias || id);
        if (q && !(id.toLowerCase().startsWith(q) || name.toLowerCase().includes(q) || String(a.alias || '').toLowerCase().includes(q))) continue;
        out.push({
          id, name, lastAccess: a['last-access'] || null, created: a.created || null, banned: !!isBanned(id),
          reportsAgainst: repAgainst[id] || 0, reportsBy: repBy[id] || 0, matches: matchCount[id] || 0,
        });
      }
      out.sort((x, y) => String(y.lastAccess || '').localeCompare(String(x.lastAccess || '')));
      return json(res, 200, out.slice(0, limit));
    }
    if ((r = sub.match(/^players\/([^/]+)$/))) {
      const id = decodeURIComponent(r[1]);
      const a = accounts()[id];
      if (!a) return json(res, 404, { error: 'not-found' });
      const mine = [];
      const ms = matches();
      for (let i = ms.length - 1; i >= 0 && mine.length < 50; i--) {
        const e = matchEntry(ms[i], id);
        if (e) mine.push({ id: ms[i].id, matchId: ms[i].id, sessionId: ms[i].sessionId, server: (serverOf(ms[i].sessionId) || {}).name || null, endedAt: ms[i].endedAt, durationSec: ms[i].durationSec, me: e, players: (ms[i].players || []).length });
      }
      const seat = seatOf(id);
      const history = m.audit.filter((e) => (e.action === 'ban' || e.action === 'unban') && e.target === id).reverse();
      return json(res, 200, {
        account: { id, name: String(a['display-name'] || a.alias || id), created: a.created || null, lastAccess: a['last-access'] || null },
        stats: summaryOf(id) || {}, matches: mine, profile: profileOf(id),
        notes: [...(m.notes[id] || [])].reverse(), warnings: [...(m.warnings[id] || [])].reverse(),
        kicks: m.audit.filter((e) => e.action === 'kick' && e.target === id).reverse(),
        reportsAgainst: listReportsAgainst(id).reverse().map(stripRaw), reportsBy: listReportsBy(id).reverse().map(stripRaw),
        ban: activeBanFor(id), banHistory: history,
        current: seat ? { game: seat.game, sessionId: seat.h.id, state: seat.h.state } : null,
      });
    }

    if (sub === 'reports') {
      let st = url.searchParams.get('status') || 'open';
      if (st === 'actioned') st = 'resolved';
      const target = url.searchParams.get('target');
      let assignee = url.searchParams.get('assignee');
      if (assignee === 'me') assignee = admin.steamId;
      const out = [];
      for (let i = m.reports.length - 1; i >= 0 && out.length < 500; i--) {
        const rp = m.reports[i];
        if (st !== 'all' && rp.status !== st) continue;
        if (target && rp.target.id !== target) continue;
        if (assignee === 'none' ? rp.assignee : assignee && !(rp.assignee && rp.assignee.id === assignee)) continue;
        out.push(stripRaw(rp));
      }
      return json(res, 200, out);
    }
    if ((r = sub.match(/^reports\/([^/]+)$/))) {
      const rp = m.reports.find((x) => x.id === decodeURIComponent(r[1]));
      if (!rp) return json(res, 404, { error: 'not-found' });
      const at = Date.parse(rp.at);
      const candidates = rp.sessionId ? matches().filter((mt) => mt.sessionId === rp.sessionId && Date.parse(mt.endedAt) >= at - 60000 && Date.parse(mt.endedAt) <= at + 4 * HOUR).slice(0, 5) : [];
      const lobby = rp.sessionId ? findLobby(rp.sessionId) : null;
      return json(res, 200, {
        report: rp, match: rp.matchId ? (matches().find((x) => x.id === rp.matchId) || null) : null, candidates,
        target: summaryOf(rp.target.id), reporter: summaryOf(rp.reporter.id),
        priorReportsAgainstTarget: m.reports.filter((x) => x.target.id === rp.target.id && x.id !== rp.id).length,
        ban: activeBanFor(rp.target.id),
        links: { match: rp.matchId || null, target: rp.target.id, reporter: rp.reporter.id, spectate: { sessionId: rp.sessionId || null, live: !!lobby && lobby.h.state === 'started' } },
      });
    }

    if (sub === 'matches') {
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 50));
      const before = url.searchParams.get('before') || '', player = url.searchParams.get('player') || '', session = url.searchParams.get('session') || '';
      const ms = matches();
      const out = [];
      for (let i = ms.length - 1; i >= 0 && out.length < limit; i--) {
        const mt = ms[i];
        if (before && !(String(mt.endedAt) < before)) continue;
        if (session && mt.sessionId !== session) continue;
        if (player && !matchEntry(mt, player)) continue;
        let top = null;
        for (const p of mt.players || []) if (typeof p.kills === 'number' && (!top || p.kills > top.kills)) top = { kills: p.kills, name: p.name || nameOf(p.playerId), playerId: p.playerId };
        out.push({
          id: mt.id, sessionId: mt.sessionId, server: (serverOf(mt.sessionId) || {}).name || null, startedAt: mt.startedAt || null, endedAt: mt.endedAt,
          durationSec: mt.durationSec ?? null, players: (mt.players || []).length, top,
        });
      }
      return json(res, 200, out);
    }
    if ((r = sub.match(/^matches\/(.+)$/))) {
      const mt = matches().find((x) => x.id === decodeURIComponent(r[1]));
      if (!mt) return json(res, 404, { error: 'not-found' });
      const players = (mt.players || []).map((p) => ({ ...p, name: p.name || nameOf(p.playerId) || p.playerId }));
      return json(res, 200, { ...mt, players, server: serverOf(mt.sessionId), reports: m.reports.filter((x) => x.matchId === mt.id).map(stripRaw) });
    }
    if (sub === 'bans') {
      const all = url.searchParams.get('all') === '1';
      return json(res, 200, {
        bans: Object.values(m.bans).filter((b) => all || banActive(b)).sort((a, b) => String(b.at).localeCompare(String(a.at))),
        hostBlocks: m.hostBlocks.filter((h) => all || !h.lifted),
      });
    }
    if (sub === 'audit') return json(res, 200, auditFiltered(url, 500, 5000));
    if (sub === 'audit.csv') {
      const d = new Date(now()).toISOString().slice(0, 10).replace(/-/g, '');
      return respond(res, 200, toCsv(auditFiltered(url, 20000, 20000)), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="ogsos-audit-${d}.csv"` });
    }

    if (sub === 'kv') {
      const rev = readBaseRev();
      const base = readBaseKv(rev) || {};
      const keys = Object.entries(KV_ALLOW).filter(([k]) => k in base).map(([k, spec]) => {
        const ov = Object.prototype.hasOwnProperty.call(m.kv, k) && !kvCheck(k, base[k], m.kv[k]);
        return { key: k, base: base[k], value: ov ? m.kv[k] : base[k], overridden: ov, type: typeof base[k], description: spec.description, ...(spec.min !== undefined ? { min: spec.min, max: spec.max } : {}) };
      });
      return json(res, 200, { keys, baseRev: rev, servedRev: servedRev() });
    }

    if (sub === 'community') {
      const hostsMap = community ? community._hosts : new Map();
      const live = new Map();
      for (const mmx of Object.values(matchmakers)) if (mmx && typeof mmx.listHosted === 'function') for (const h of mmx.listHosted()) if (h.community) live.set(h.id, h);
      const active = m.hostBlocks.filter((h) => !h.lifted);
      const blockFor = (value) => { const b = active.find((h) => h.value === value); return b ? b.id : null; };
      const out = [];
      for (const h of hostsMap.values()) {
        const v = live.get(h.id) || {};
        const st = community.status(h.id) || {};
        out.push({
          id: h.id, name: h.name, ip: h.ip, port: h.port, verified: !!h.verified, listed: !!st.listed, probe: h.probe, online: !!v.online, state: v.state || 'waiting',
          players: v.players || 0, maxPlayers: v.maxPlayers || null, registeredAt: new Date(h.registeredAt).toISOString(),
          lastRenewSec: Math.max(0, Math.floor((now() - h.registeredAt) / 1000)),
          blocked: !!blockFor(h.id) || isHostBlocked(h.ip) || !!blockFor(h.ip), blockedBy: { id: blockFor(h.id), ip: blockFor(h.ip) },
        });
      }
      return json(res, 200, { enabled: community ? !!community._cfg.enabled : false, hosts: out });
    }
    return json(res, 404, { error: 'not-found' });
  }

  function changeReport(admin, rp, b, res) {
    const before = { status: rp.status, assignee: rp.assignee ? rp.assignee.id : null };
    const status = b.status === 'actioned' ? 'resolved' : b.status;
    if (status !== undefined && !REPORT_STATUSES.includes(status)) return json(res, 400, { error: 'bad-status' });
    let assignee;   // undefined = unchanged
    if (b.assignee !== undefined) {
      if (b.assignee === null || b.assignee === '') assignee = null;
      else {
        const id = b.assignee === 'me' ? admin.steamId : scalar(b.assignee);
        if (!ID_RE.test(id) || !isAdmin(id)) return json(res, 400, { error: 'bad-assignee' });
        assignee = { id, name: nameOf(id) };
      }
    }
    const noteText = typeof b.note === 'string' ? clip(b.note, 1000) : '';
    const matchId = typeof b.matchId === 'string' && b.matchId ? clip(b.matchId, 64) : null;
    if (status === undefined && assignee === undefined && !noteText && !matchId) return json(res, 400, { error: 'bad-status' });
    if (status !== undefined && status !== rp.status) {
      rp.status = status;
      const closed = status === 'resolved' || status === 'dismissed';
      rp.resolvedBy = closed ? admin.steamId : null;
      rp.resolvedAt = closed ? nowIso() : null;
      audit(admin.steamId, admin.name, 'report-status', rp.id, `${before.status} -> ${status}`);
    }
    if (assignee !== undefined && (assignee ? assignee.id : null) !== before.assignee) {
      rp.assignee = assignee;
      audit(admin.steamId, admin.name, 'report-assign', rp.id, `${before.assignee || 'none'} -> ${assignee ? assignee.id : 'none'}`);
    }
    if (noteText) {
      rp.notes.push({ at: nowIso(), by: admin.steamId, byName: admin.name, text: noteText });
      audit(admin.steamId, admin.name, 'report-note', rp.id, noteText);
    }
    if (matchId) rp.matchId = matchId;
    save();
    return json(res, 200, { ok: true, report: rp });
  }

  // Player adjust / reset-stats. The game host holds a player's blob during a match and writes it back at the end, so
  // nobody seated (or watching) may be edited. The edit bumps the blob version like a host write does.
  function editPlayer(admin, id, b, reset, res) {
    if (!accounts()[id]) return json(res, 404, { error: 'not-found' });
    const busy = seatOf(id) || watchedBy(id);
    if (busy) return json(res, 409, { error: 'player-in-lobby', sessionId: busy.h.id });
    const old = {}, nu = {};
    const set = (k, from, to) => { old[k] = from; nu[k] = to; };
    db.appData = isObj(db.appData) ? db.appData : {};
    const key = blobKey(id);
    const cur = db.appData[key];
    const version = cur && Number.isInteger(cur.version) ? cur.version : 1;
    const data = cur && isObj(cur.data) ? JSON.parse(JSON.stringify(cur.data)) : {};
    const ratingEntry = (name) => {
      data.ratings = isObj(data.ratings) ? data.ratings : {};
      let o = data.ratings;
      for (const k of RATING_PATHS[name]) { o[k] = isObj(o[k]) ? o[k] : {}; o = o[k]; }
      return o;
    };
    const intIn = (v, lo, hi) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
    const fameWanted = {};
    if (reset) {
      const prog = isObj(data.progression) ? data.progression : {};
      set('progression', { level: prog.level ?? null, levelProgress: prog.levelProgress ?? null }, { level: 1, levelProgress: 0 });
      data.progression = { ...prog, level: 1, levelProgress: 0 };
      const zero = (o) => { if (!isObj(o)) return o; const c = {}; for (const [k, v] of Object.entries(o)) c[k] = typeof v === 'number' ? 0 : isObj(v) ? zero(v) : v; return c; };
      if (data.stats !== undefined) { set('stats', 'cleared', 'zeroed'); data.stats = zero(data.stats); }
      if (data.badges !== undefined) data.badges = zero(data.badges);
      for (const name of Object.keys(RATING_PATHS)) {
        let e = data.ratings;
        for (const k of RATING_PATHS[name]) e = isObj(e) ? e[k] : undefined;
        if (!isObj(e)) continue;   // never create rating entries the game did not write
        if (e.rating || e.matchesPlayed) { old[name] = { rating: e.rating ?? null, matchesPlayed: e.matchesPlayed ?? null }; nu[name] = { rating: 0, matchesPlayed: 0 }; }
        e.rating = 0; e.matchesPlayed = 0;
      }
      Object.assign(fameWanted, { soloFameRating: 0, fameWins: 0, matches: 0, anger: 0, applause: 0, laughter: 0, love: 0, shock: 0 });
      if (db.playerStats && db.playerStats[id]) { set('playerStats', db.playerStats[id], 'cleared'); delete db.playerStats[id]; }
    } else {
      const progOld = isObj(data.progression) ? data.progression : {};
      const prog = { ...progOld };
      if (b.level !== undefined) {
        const v = intIn(b.level, 1, 200); if (v === null) return json(res, 400, { error: 'bad-level' });
        prog.level = v; set('level', progOld.level ?? null, v);
      }
      if (b.levelProgress !== undefined) {
        const v = b.levelProgress;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= 1) return json(res, 400, { error: 'bad-levelProgress' });
        prog.levelProgress = v; set('levelProgress', progOld.levelProgress ?? null, v);
      }
      if (b.ratings !== undefined) {
        if (!isObj(b.ratings)) return json(res, 400, { error: 'bad-ratings' });
        for (const [name, val] of Object.entries(b.ratings)) {
          if (!RATING_PATHS[name]) return json(res, 400, { error: 'bad-rating-key' });
          const v = intIn(val, -1000000, 1000000); if (v === null) return json(res, 400, { error: `bad-${name}` });
          const e = ratingEntry(name);
          set(`ratings.${name}`, e.rating ?? null, v);
          e.rating = v;
          if (name === 'fameSolo') fameWanted.soloFameRating = v;   // the Fame module overwrites the blob's solo Fame rating on every read
        }
      }
      if (b.fame !== undefined) {
        if (!isObj(b.fame)) return json(res, 400, { error: 'bad-fame' });
        const FAME_ALIAS = { totalFameWins: 'fameWins', fameMatches: 'matches', newSoloFameRating: 'soloFameRating' };   // the heroStats names the panel shows
        for (const [k0, val] of Object.entries(b.fame)) {
          const k = FAME_ALIAS[k0] || k0;
          if (!['soloFameRating', 'fameWins', 'matches'].includes(k)) return json(res, 400, { error: 'bad-fame-key' });
          const v = intIn(val, k === 'soloFameRating' ? -1000000 : 0, 1000000); if (v === null) return json(res, 400, { error: `bad-${k}` });
          fameWanted[k] = v;
        }
      }
      if (b.level !== undefined || b.levelProgress !== undefined) data.progression = prog;
      if (!Object.keys(nu).length && !Object.keys(fameWanted).length) return json(res, 400, { error: 'nothing-to-change' });
    }
    if (Object.keys(fameWanted).length && fame && typeof fame.adjust === 'function') {
      // Only an account that already has Fame stats, or an explicit fame{} block, gets a Fame record created/changed.
      const explicit = reset ? false : isObj(b.fame) && Object.keys(b.fame).length > 0;
      let d = null;
      try { d = fame.adjust(id, fameWanted, { create: explicit }); } catch { d = null; }
      if (d && Object.keys(d.new || {}).length) { old.fame = d.old; nu.fame = d.new; }
    }
    db.appData[key] = { version: version + 1, data };
    audit(admin.steamId, admin.name, reset ? 'reset-stats' : 'adjust', id, JSON.stringify({ old, new: nu }));
    save();
    return json(res, 200, { ok: true, version: version + 1, old, new: nu, profile: profileOf(id) });
  }

  function apiPost(admin, sub, b, res) {
    const m = store();
    let r;
    if (sub === 'admins') {
      if (admin.role !== 'owner') return forbidOwnerOnly(res);
      const id = scalar(b.steamId);
      if (!/^\d{5,20}$/.test(id)) return json(res, 400, { error: 'bad-steam-id' });
      if (isAdmin(id)) return json(res, 409, { error: 'already-admin' });
      m.mods[id] = { addedBy: admin.steamId, at: nowIso(), name: nameOf(id) };
      audit(admin.steamId, admin.name, 'mod-add', id, '');
      save();
      return json(res, 200, { ok: true, mod: { steamId: id, ...m.mods[id] } });
    }
    if ((r = sub.match(/^admins\/([^/]+)\/remove$/))) {
      if (admin.role !== 'owner') return forbidOwnerOnly(res);
      const id = decodeURIComponent(r[1]);
      if (owners().has(id)) return json(res, 400, { error: 'cannot-remove-owner' });
      if (!Object.prototype.hasOwnProperty.call(m.mods, id)) return json(res, 404, { error: 'not-found' });
      delete m.mods[id];
      audit(admin.steamId, admin.name, 'mod-remove', id, '');
      save();
      return json(res, 200, { ok: true });
    }
    if ((r = sub.match(/^lobbies\/([^/]+)\/([a-z-]+)$/))) {
      const action = r[2];
      if (!LOBBY_ACTIONS.includes(action)) return json(res, 404, { error: 'not-found' });
      const out = lobbyAction(admin, decodeURIComponent(r[1]), action, b);
      return json(res, out.status, out.body);
    }
    if (sub === 'kv') {
      if (admin.role !== 'owner') return forbidOwnerOnly(res);
      const key = typeof b.key === 'string' ? b.key : '';
      if (!KV_ALLOW[key]) return json(res, 400, { error: 'not-allowed' });
      const base = readBaseKv(readBaseRev());
      if (!base || !(key in base)) return json(res, 400, { error: 'not-in-base' });
      const bad = kvCheck(key, base[key], b.value);
      if (bad) return json(res, 400, { error: bad });
      const old = Object.prototype.hasOwnProperty.call(m.kv, key) ? m.kv[key] : base[key];
      m.kv[key] = b.value;
      m.kvRev += 1;
      audit(admin.steamId, admin.name, 'kv-set', key, `${JSON.stringify(old)} -> ${JSON.stringify(b.value)}`);
      save();
      return json(res, 200, { ok: true, key, value: b.value, servedRev: servedRev() });
    }
    if ((r = sub.match(/^kv\/([A-Z0-9_]+)\/clear$/))) {
      if (admin.role !== 'owner') return forbidOwnerOnly(res);
      const key = r[1];
      if (!KV_ALLOW[key]) return json(res, 400, { error: 'not-allowed' });
      if (!Object.prototype.hasOwnProperty.call(m.kv, key)) return json(res, 404, { error: 'not-overridden' });
      const old = m.kv[key];
      delete m.kv[key];
      m.kvRev += 1;   // clients holding the overlaid file must refetch the plain one
      audit(admin.steamId, admin.name, 'kv-clear', key, `${JSON.stringify(old)} -> base`);
      save();
      return json(res, 200, { ok: true, key, servedRev: servedRev() });
    }
    if ((r = sub.match(/^players\/([^/]+)\/(notes|warn|adjust|reset-stats)$/))) {
      const id = decodeURIComponent(r[1]);
      if (r[2] === 'adjust' || r[2] === 'reset-stats') return editPlayer(admin, id, b, r[2] === 'reset-stats', res);
      if (!accounts()[id]) return json(res, 404, { error: 'not-found' });
      if (r[2] === 'notes') {
        const text = clip(b.text, 1000);
        if (!text) return json(res, 400, { error: 'empty' });
        m.seq += 1;
        const note = { id: `n${m.seq}`, at: nowIso(), by: admin.steamId, byName: admin.name, text };
        (m.notes[id] = m.notes[id] || []).push(note);
        audit(admin.steamId, admin.name, 'note', id, text);
        save();
        return json(res, 200, { ok: true, note });
      }
      const reason = clip(b.reason, 200);
      if (!reason) return json(res, 400, { error: 'empty' });
      m.seq += 1;
      const w = { id: `w${m.seq}`, at: nowIso(), by: admin.steamId, byName: admin.name, reason };
      (m.warnings[id] = m.warnings[id] || []).push(w);
      audit(admin.steamId, admin.name, 'warn', id, reason);
      save();
      return json(res, 200, { ok: true, warning: w });
    }
    if ((r = sub.match(/^reports\/([^/]+)$/))) {
      const rp = m.reports.find((x) => x.id === decodeURIComponent(r[1]));
      if (!rp) return json(res, 404, { error: 'not-found' });
      return changeReport(admin, rp, b, res);
    }
    if (sub === 'bans') {
      const id = scalar(b.steamId);
      if (!ID_RE.test(id) || badKey(id)) return json(res, 400, { error: 'bad-steam-id' });
      const role = roleOf(id);
      if (role === 'owner' || (role === 'mod' && admin.role !== 'owner')) return json(res, 403, { error: 'cannot-ban-admin' });
      let hours = b.hours === null || b.hours === undefined || b.hours === '' ? 0 : Number(b.hours);
      if (!Number.isFinite(hours) || hours < 0 || hours > 87600) return json(res, 400, { error: 'bad-hours' });
      const ban = {
        steamId: id, name: nameOf(id), reason: clip(b.reason, 200), code: BAN_CODES.includes(b.code) ? b.code : 'other',
        by: admin.steamId, at: nowIso(),
        expiresAt: hours > 0 ? new Date(now() + hours * HOUR).toISOString() : null, lifted: false,
      };
      m.bans[id] = ban;
      const kicked = kickEverywhere(id);
      audit(admin.steamId, admin.name, 'ban', id, `${hours > 0 ? `${hours}h` : 'permanent'} [${ban.code}]: ${ban.reason}`);
      save();
      return json(res, 200, { ok: true, ban, kicked });
    }
    if ((r = sub.match(/^bans\/([^/]+)\/lift$/))) {
      const id = decodeURIComponent(r[1]);
      if (badKey(id)) return json(res, 400, { error: 'bad-steam-id' });
      const ban = m.bans[id];
      if (!banActive(ban)) return json(res, 404, { error: 'no-active-ban' });
      if (isAdmin(id) && admin.role !== 'owner') return forbidOwnerOnly(res);
      ban.lifted = { by: admin.steamId, at: nowIso() };
      audit(admin.steamId, admin.name, 'unban', id, '');
      save();
      return json(res, 200, { ok: true, ban });
    }
    if (sub === 'host-blocks') {
      const value = clip(b.value, 64);
      const kind = blockKind(value);
      if (!kind) return json(res, 400, { error: 'bad-value' });
      if (m.hostBlocks.some((h) => !h.lifted && h.value === value)) return json(res, 409, { error: 'already-blocked' });
      m.seq += 1;
      const hb = { id: `h${m.seq}`, value, kind, reason: clip(b.reason, 200), by: admin.steamId, at: nowIso(), lifted: false };
      m.hostBlocks.push(hb);
      audit(admin.steamId, admin.name, 'host-block', value, hb.reason);
      save(); notifyBlocks();
      return json(res, 200, { ok: true, hostBlock: hb });
    }
    if ((r = sub.match(/^host-blocks\/([^/]+)\/lift$/))) {
      const hb = m.hostBlocks.find((h) => h.id === decodeURIComponent(r[1]) && !h.lifted);
      if (!hb) return json(res, 404, { error: 'not-found' });
      hb.lifted = { by: admin.steamId, at: nowIso() };
      audit(admin.steamId, admin.name, 'host-unblock', hb.value, '');
      save(); notifyBlocks();
      return json(res, 200, { ok: true, hostBlock: hb });
    }
    if (sub === 'kick') {
      const sessionId = String(b.sessionId || ''), playerId = scalar(b.playerId);
      const owners = Object.entries(matchmakers).filter(([k, x]) => x && (!b.game || b.game === k));
      let result = { error: 'not-found' };
      for (const [, x] of owners) {
        const out = x.kickHosted(sessionId, playerId);
        if (out.result) { result = out; break; }
        if (out.error === 'not-seated') result = out;
      }
      if (!result.result) return json(res, 404, { error: result.error });
      audit(admin.steamId, admin.name, 'kick', playerId, `${sessionId}${b.reason ? `: ${clip(b.reason, 200)}` : ''}`);
      save();
      return json(res, 200, { ok: true });
    }
    if (sub === 'spectate' || sub === 'spectate/stop') {
      const out = watch(admin, String(b.sessionId || ''), b.game, b.mode, b.steamId, sub === 'spectate/stop');
      return json(res, out.status, out.body);
    }
    return json(res, 404, { error: 'not-found' });
  }

  // Spectate / director join for an admin (panel and the client mod's JWT route). Returns {status, body}.
  function watch(admin, sessionId, game, modeIn, steamIdIn, stop) {
    const x = hostedAll().find((y) => y.h.id === sessionId && (!game || y.game === game));
    if (!x) return { status: 404, body: { error: 'not-found' } };
    const steamId = steamIdIn === undefined || steamIdIn === null || steamIdIn === '' ? admin.steamId : scalar(steamIdIn);
    if (!ID_RE.test(steamId) || !admins().has(steamId)) return { status: 403, body: { error: 'not-an-admin' } };
    if (stop) {
      const removed = x.mm.removeWatcher(sessionId, steamId);
      audit(admin.steamId, admin.name, 'spectate-stop', sessionId, steamId);
      save();
      return { status: 200, body: { ok: true, removed } };
    }
    const mode = modeIn === 'director' ? 'director' : (modeIn === 'spectator' || modeIn === undefined) ? 'spectator' : null;
    if (!mode) return { status: 400, body: { error: 'bad-mode' } };
    const w = x.mm.addWatcher(sessionId, steamId, WATCH_TTL_MS);
    const authToken = w && x.mm.watchToken(sessionId, steamId);
    if (!authToken) return { status: 500, body: { error: 'watch-failed' } };
    const address = `${x.h.publicHost || x.h.host}:${x.h.port}`;
    const joinUrl = `${address}?SpectatorOnly=1${mode === 'director' ? '&DirectorOnly=1' : ''}&AuthToken=${authToken}`;
    audit(admin.steamId, admin.name, 'spectate', sessionId, `${mode} as ${steamId}`);   // never the token
    save();
    return { status: 200, body: {
      address, sessionId, mode, expiresAt: new Date(w.expiresAt).toISOString(), authToken, joinUrl, command: `open ${joinUrl}`,
      instructions: "Join with the in-game console (`open` + the join URL) if your build has it, or the client mod's Spectate button. A spectator has no body in the world, but may still show in player lists (untested). The link works for 3 hours; Stop watching removes it sooner.",
    } };
  }
  // POST /api/servers/<id>/watch from the client mod: game JWT whose account is in OGSOS_ADMINS. Body {mode, stop?}.
  function handleWatchApi(req, sessionId, bodyText, token) {
    // Off unless OGSOS_ADMIN_GAME_WATCH=1: game logins are not Steam-verified yet, so anyone can claim an admin's
    // Steam id and get a game JWT. Turn it on only once logins verify the Steam ticket (docs/ADMIN.md section 7).
    if (env.OGSOS_ADMIN_GAME_WATCH !== '1') return { status: 404, body: { error: 'disabled' } };
    const id = jwtAccount(token);
    if (!id) return { status: 401, body: { error: 'unauthorized' } };
    if (!admins().has(id)) return { status: 403, body: { error: 'not-an-admin' } };
    const b = parseBody(bodyText);
    return watch({ steamId: id, name: displayName(id) || id }, String(sessionId), b.game, b.mode, id, b.stop === true || b.stop === 'true');
  }

  function handleApi(req, url, bodyText, res) {
    const admin = adminFrom(req);
    if (!admin) return json(res, 401, { error: 'unauthorized' });
    const sub = url.pathname.slice('/admin/api/'.length);
    if (req.method === 'GET') return apiGet(admin, sub, url, res);
    if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' });
    if (req.headers['x-ogsos-admin'] !== '1') return json(res, 403, { error: 'csrf' });
    if (Buffer.byteLength(bodyText || '') > MAX_BODY) return json(res, 413, { error: 'too-large' });
    let b = {};
    if (String(bodyText || '').trim()) { try { b = JSON.parse(bodyText); } catch { return json(res, 400, { error: 'bad-json' }); } }
    if (!isObj(b)) return json(res, 400, { error: 'bad-json' });
    return apiPost(admin, sub, b, res);
  }

  function handleHttp(req, url, bodyText, res) {
    const p = url.pathname;
    if (p !== '/admin' && !p.startsWith('/admin/')) return false;
    try {
      if (p === '/admin') redirect(res, '/admin/');
      else if (p === '/admin/login' && req.method === 'GET') handleLogin(req, res);
      else if (p === '/admin/auth' && req.method === 'GET') {
        handleAuth(req, url, res).catch(() => { if (!res.headersSent) page(res, 500, 'Error', 'Sign-in failed.'); });
      } else if (p === '/admin/dev-login' && req.method === 'GET') handleDevLogin(req, url, res);
      else if (p === '/admin/logout' && (req.method === 'GET' || req.method === 'POST')) {
        const a = adminFrom(req);
        if (a) { audit(a.steamId, a.name, 'logout', a.steamId, ''); save(); }
        redirect(res, '/admin/', { 'Set-Cookie': setCookieHeader(req, '', 0) });
      } else if (p.startsWith('/admin/api/')) handleApi(req, url, bodyText, res);
      else if ((req.method === 'GET' || req.method === 'HEAD') && p === '/admin/') serveStatic('', res);
      else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(p.slice('/admin/'.length), res);
      else json(res, 405, { error: 'method-not-allowed' });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: 'internal' });
      try { log('admin.jsonl', { event: 'error', path: p, error: String(e && e.message || e) }); } catch { /* ignore */ }
    }
    return true;
  }

  return { isBanned, banBody, filterPlayerMap, handleReport, handleReportApi, handleEvidence, handleWatchApi, onMatchEnd, handleHttp, isHostBlocked, kickEverywhere, isAdmin, roleOf, kvServe, reapplyLobbyOptions };
}

module.exports = { createModeration };
