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

const WEB_DIR = path.join(__dirname, 'web', 'admin');
const COOKIE = 'ogsos_admin';
const COOKIE_TTL_SEC = 12 * 3600;
const MAX_REPORTS = 5000;
const MAX_AUDIT = 5000;
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
  const cookieKey = crypto.createHmac('sha256', String(opts.secret || 'ogsos-dev-secret')).update('ogsos-admin-cookie-v1').digest();

  const nowIso = () => new Date(now()).toISOString();
  const store = () => {
    const m = db.moderation = isObj(db.moderation) ? db.moderation : {};
    m.reports = Array.isArray(m.reports) ? m.reports : [];
    m.bans = isObj(m.bans) ? m.bans : {};
    m.hostBlocks = Array.isArray(m.hostBlocks) ? m.hostBlocks : [];
    m.audit = Array.isArray(m.audit) ? m.audit : [];
    m.seq = Number.isInteger(m.seq) ? m.seq : 0;
    return m;
  };
  store();
  const save = () => { try { saveDb(); } catch { /* keep serving */ } };
  const matches = () => (Array.isArray(db.matches) ? db.matches : []);
  const accounts = () => (isObj(db.accounts) ? db.accounts : {});
  const admins = () => new Set(String(env.OGSOS_ADMINS || '').split(/[\s,]+/).filter(Boolean));

  if (env.OGSOS_ADMIN_DEV_LOGIN === '1') console.warn('moderation: OGSOS_ADMIN_DEV_LOGIN=1, /admin/dev-login is enabled for loopback requests. Never set this in production.');

  // ---------- audit ----------
  function audit(by, byName, action, target, detail) {
    const m = store();
    const e = { at: nowIso(), by: by || '', byName: byName || '', action, target: target === undefined || target === null ? '' : String(target), detail: detail === undefined ? '' : clip(detail, 500) };
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
      snapshot: snap.snapshot, resolvedBy: null, resolvedAt: null, note: '', raw,
    };
    m.reports.push(report);
    while (m.reports.length > MAX_REPORTS) {
      const i = m.reports.findIndex((r) => r.status !== 'open');
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
    if (!admins().has(j.sid)) return null;
    return { steamId: j.sid, name: String(j.n || j.sid) };
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
    if (p['openid.mode'] !== 'id_res' || !(ret === `${origin}/admin/auth` || ret.startsWith(`${origin}/admin/auth?`))
      || p['openid.op_endpoint'] !== openidUrl() || !m || (p['openid.identity'] && p['openid.identity'] !== p['openid.claimed_id'])) {
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

  function apiGet(admin, sub, url, res) {
    const m = store();
    let r;
    if (sub === 'me') return json(res, 200, { steamId: admin.steamId, name: admin.name });

    if (sub === 'servers') {
      const servers = [];
      for (const x of hostedAll()) {
        const players = x.ids.map((id) => ({ id, name: nameOf(id), banned: !!isBanned(id), host: !accounts()[id] }));
        servers.push({
          game: x.game, id: x.h.id, name: x.h.name, region: x.h.region, online: x.h.online, state: x.h.state, map: x.h.map,
          address: `${x.h.publicHost || x.h.host}:${x.h.port}`, players, playerCount: x.h.players, maxPlayers: x.h.maxPlayers,
          startedAt: x.h.startedAt, watchers: x.watchers.map((id) => ({ id, name: nameOf(id) })),
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
        if (e) mine.push({ id: ms[i].id, sessionId: ms[i].sessionId, endedAt: ms[i].endedAt, durationSec: ms[i].durationSec, me: e, players: (ms[i].players || []).length });
      }
      const seat = seatOf(id);
      const history = m.audit.filter((e) => (e.action === 'ban' || e.action === 'unban') && e.target === id).reverse();
      return json(res, 200, {
        account: { id, name: String(a['display-name'] || a.alias || id), created: a.created || null, lastAccess: a['last-access'] || null },
        stats: summaryOf(id) || {}, matches: mine,
        reportsAgainst: listReportsAgainst(id).reverse().map(stripRaw), reportsBy: listReportsBy(id).reverse().map(stripRaw),
        ban: activeBanFor(id), banHistory: history,
        current: seat ? { game: seat.game, sessionId: seat.h.id, state: seat.h.state } : null,
      });
    }

    if (sub === 'reports') {
      const st = url.searchParams.get('status') || 'open';
      const target = url.searchParams.get('target');
      const out = [];
      for (let i = m.reports.length - 1; i >= 0 && out.length < 500; i--) {
        const rp = m.reports[i];
        if (st !== 'all' && rp.status !== st) continue;
        if (target && rp.target.id !== target) continue;
        out.push(stripRaw(rp));
      }
      return json(res, 200, out);
    }
    if ((r = sub.match(/^reports\/([^/]+)$/))) {
      const rp = m.reports.find((x) => x.id === decodeURIComponent(r[1]));
      if (!rp) return json(res, 404, { error: 'not-found' });
      const at = Date.parse(rp.at);
      const candidates = rp.sessionId ? matches().filter((mt) => mt.sessionId === rp.sessionId && Date.parse(mt.endedAt) >= at - 60000 && Date.parse(mt.endedAt) <= at + 4 * HOUR).slice(0, 5) : [];
      return json(res, 200, {
        report: rp, match: rp.matchId ? (matches().find((x) => x.id === rp.matchId) || null) : null, candidates,
        target: summaryOf(rp.target.id), reporter: summaryOf(rp.reporter.id),
        priorReportsAgainstTarget: m.reports.filter((x) => x.target.id === rp.target.id && x.id !== rp.id).length,
        ban: activeBanFor(rp.target.id),
      });
    }
    if ((r = sub.match(/^matches\/(.+)$/))) {
      const mt = matches().find((x) => x.id === decodeURIComponent(r[1]));
      return mt ? json(res, 200, mt) : json(res, 404, { error: 'not-found' });
    }
    if (sub === 'bans') {
      const all = url.searchParams.get('all') === '1';
      return json(res, 200, {
        bans: Object.values(m.bans).filter((b) => all || banActive(b)).sort((a, b) => String(b.at).localeCompare(String(a.at))),
        hostBlocks: m.hostBlocks.filter((h) => all || !h.lifted),
      });
    }
    if (sub === 'audit') {
      const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 200));
      return json(res, 200, m.audit.slice(-limit).reverse());
    }
    return json(res, 404, { error: 'not-found' });
  }

  function apiPost(admin, sub, b, res) {
    const m = store();
    let r;
    if ((r = sub.match(/^reports\/([^/]+)$/))) {
      const rp = m.reports.find((x) => x.id === decodeURIComponent(r[1]));
      if (!rp) return json(res, 404, { error: 'not-found' });
      if (!['open', 'actioned', 'dismissed'].includes(b.status)) return json(res, 400, { error: 'bad-status' });
      rp.status = b.status;
      rp.resolvedBy = b.status === 'open' ? null : admin.steamId;
      rp.resolvedAt = b.status === 'open' ? null : nowIso();
      if (typeof b.note === 'string') rp.note = clip(b.note, 1000);
      if (typeof b.matchId === 'string' && b.matchId) rp.matchId = clip(b.matchId, 64);
      audit(admin.steamId, admin.name, 'report-status', rp.id, `${b.status}${rp.note ? `: ${rp.note}` : ''}`);
      save();
      return json(res, 200, { ok: true, report: rp });
    }
    if (sub === 'bans') {
      const id = scalar(b.steamId);
      if (!ID_RE.test(id)) return json(res, 400, { error: 'bad-steam-id' });
      if (admins().has(id)) return json(res, 403, { error: 'cannot-ban-admin' });
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
      const ban = m.bans[id];
      if (!banActive(ban)) return json(res, 404, { error: 'no-active-ban' });
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

  return { isBanned, banBody, filterPlayerMap, handleReport, handleReportApi, handleEvidence, handleWatchApi, onMatchEnd, handleHttp, isHostBlocked, kickEverywhere };
}

module.exports = { createModeration };
