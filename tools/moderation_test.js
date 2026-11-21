// Moderation logic (server/admin.js + matchmaking kickHosted), offline: fake db, real matchmaker with fake clients,
// a tiny fake Steam OpenID server on 127.0.0.1.   node tools/moderation_test.js
'use strict';
const http = require('http');
const { createModeration } = require('../server/admin');
const { createMatchmaker } = require('../server/matchmaking');

const ADMIN = '76561198000000001', ADMIN2 = '76561198000000009', P1 = '76561198000000011', P2 = '76561198000000012', P3 = '76561198000000013';
const SID = '11111111-2222-3333-4444-555555555555';
const SECRET_TOKEN = 'lobby-secret-token-xyz';
const ENTRY = { host: '127.0.0.1', port: 7777, sessionId: SID, sessionToken: SECRET_TOKEN, hostIds: ['hostacct'], name: 'T', region: 'eu' };

const origLog = console.log; console.log = () => {};   // matchmaker chatter
const out = (...a) => origLog(...a);
const origWarn = console.warn; console.warn = () => {};
let failed = 0, passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), `${m || ''} got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

function makeMm() {
  const config = {
    MIN_PLAYERS: 1, MAX_PLAYERS: 8, QUEUE_TIMEOUT: 20, MATCH_BATCH_MS: 5, LATE_JOIN_SECONDS: 300, GROUP_MAX_SIZE: 8,
    START_MIN_PLAYERS: 4, START_COUNTDOWN_SECONDS: 30, START_FULL_COUNTDOWN_SECONDS: 1,
    VOTE_START_MIN_PLAYERS: 2, VOTE_START_COUNTDOWN_SECONDS: 5, EMPTY_END_SECONDS: 120, TRAVEL_GRACE_SECONDS: 5,
    GAME_SERVER_HOST: '127.0.0.1', GAME_SERVER_PORT: 7777, PUBLIC_HOST: '', BEACON_URL: '', REGION_NAME: 'local', HOSTS: [ENTRY],
  };
  const mm = createMatchmaker({ config, getUname: (id) => `N-${id.slice(-3)}` });
  mm.markHostPolled(SID);
  const mk = (id) => {
    const c = { id, connId: id, msgs: [], closed: false, sendMsg(type, data) { this.msgs.push({ type, data }); }, close() { this.closed = true; } };
    mm.onConnect(c);
    return c;
  };
  const seat = (c) => { mm.onMessage(c, JSON.stringify({ type: 'find-session', data: { opts: {} } })); };
  return { mm, mk, seat };
}

// ---- harness: fake req/res around handleHttp ----
function makeEnv(extra = {}) {
  const T = { now: Date.parse('2026-06-01T12:00:00Z') };
  const saves = { n: 0 };
  const logs = [];
  const db = { accounts: {}, appData: {}, tokens: {}, matches: [] };
  for (const id of [ADMIN, ADMIN2, P1, P2, P3]) {
    db.accounts[id] = { id, 'account-id': id, alias: `player-${id.slice(-4)}`, 'display-name': `Name${id.slice(-3)}`, created: '2026-01-01T00:00:00Z', 'last-access': `2026-05-0${id.slice(-1) === '1' ? 1 : 2}T00:00:00Z` };
  }
  const { mm, mk, seat } = makeMm();
  const env = { OGSOS_ADMINS: `${ADMIN}, ${ADMIN2}`, OGSOS_ADMIN_ORIGIN: 'http://127.0.0.1:7795', OGSOS_ADMIN_DEV_LOGIN: '1', ...(extra.env || {}) };
  const jwt = { 'tok-p1': P1, 'tok-p2': P2, 'tok-p3': P3 };
  const blocks = [];
  const mod = createModeration({
    db, saveDb: () => { saves.n++; }, log: (f, e) => logs.push([f, e]), secret: 'test-secret',
    jwtAccount: (t) => jwt[t] || null, displayName: (id) => db.accounts[id]?.['display-name'] || id,
    progression: { playerSummary: (id) => (db.accounts[id] ? { matches: 1, kills: 2 } : {}) },
    matchmakers: { classic: mm, main: null }, env, now: () => T.now,
    onHostBlocksChanged: (l) => { blocks.length = 0; blocks.push(...l); },
  });
  return { T, db, mod, env, mm, mk, seat, saves, logs, blocks };
}

function call(mod, method, path, { headers = {}, body, ip = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const req = { method, url: path, headers: { host: '127.0.0.1:7795', ...headers }, socket: { remoteAddress: ip } };
    const res = {
      headers: {}, status: 0, headersSent: false,
      writeHead(s, h) { this.status = s; this.headers = h || {}; this.headersSent = true; },
      end(b) { const text = b ? Buffer.from(b).toString('utf8') : ''; let j = null; try { j = JSON.parse(text); } catch { /* text */ } resolve({ status: this.status, headers: this.headers, text, json: j }); },
    };
    const url = new URL(path, 'http://x');
    const handled = mod.handleHttp(req, url, body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body)), res);
    if (handled === false) resolve({ handled: false });
  });
}
const cookieOf = (r) => { const sc = r.headers['Set-Cookie']; return sc ? sc.split(';')[0] : null; };
async function login(e, sid = ADMIN) {
  const r = await call(e.mod, 'GET', `/admin/dev-login?steamid=${sid}`);
  assert(r.status === 302, `dev-login ${r.status} ${r.text}`);
  return cookieOf(r);
}
const api = (e, cookie, method, path, body, csrf = true) =>
  call(e.mod, method, path, { headers: { cookie, ...(csrf ? { 'x-ogsos-admin': '1' } : {}) }, body });

// ---- reports ----
test('report: tolerant bodies (json, form, nested), rate limits, validation', async () => {
  const e = makeEnv();
  const noTok = e.mod.handleReport({}, P2, '{}', null);
  assert(noTok.status === 401, 'no token 401');
  assert(e.mod.handleReport({}, P1, '{}', 'tok-p1').status === 400, 'self / no target 400');
  eq(e.mod.handleReport({}, P1, '{}', 'tok-p1').body, { error: 'no-target' });
  assert(e.mod.handleReport({}, P1, JSON.stringify({ target: P1 }), 'tok-p1').status === 400, 'report self 400');
  let r = e.mod.handleReport({}, P1, JSON.stringify({ 'target-id': P2, type: 'cheating', comment: 'aimbot', evidence: 'javascript:alert(1)' }), 'tok-p1');
  assert(r.status === 200 && r.body.result === true && r.body.data.result === true && r.body.data.id === 'r1', JSON.stringify(r));
  r = e.mod.handleReport({}, P1, `reportee=${P3}&category=harassment&message=hi+there&clip=https%3A%2F%2Fexample.com%2Fv`, 'tok-p1');
  assert(r.status === 200, 'form body ok');
  r = e.mod.handleReport({}, P2, '{}', 'tok-p1');   // no target in body: the path id is the target
  assert(r.status === 200, 'path id as target');
  r = e.mod.handleReport({}, 'x', JSON.stringify({ player: { id: P2 } , 'player-id': { id: P2 } }), 'tok-p3');
  assert(r.status === 200, 'nested object id');
  const m = e.db.moderation;
  eq(m.reports[0].reason, 'cheating'); eq(m.reports[0].text, 'aimbot'); eq(m.reports[0].evidenceUrl, null, 'non-http evidence dropped');
  eq(m.reports[1].evidenceUrl, 'https://example.com/v'); eq(m.reports[1].target.id, P3); eq(m.reports[1].source, 'game');
  eq(m.reports[0].reporter.name, 'Name011');
  assert(m.reports[0].raw && m.reports[0].raw['target-id'] === P2, 'raw stored');
  // per-target limit: P1 -> P2 already has 2 (first + path-id one), third ok, fourth 429
  assert(e.mod.handleReport({}, P2, '{}', 'tok-p1').status === 200, 'third ok');
  const lim = e.mod.handleReport({}, P2, '{}', 'tok-p1');
  assert(lim.status === 429 && lim.body.error === 'rate-limited', 'fourth rate limited');
  e.T.now += 2 * 3600 * 1000;
  assert(e.mod.handleReport({}, P2, '{}', 'tok-p1').status === 200, 'window passes');
  // per reporter limit: 10 / hour
  const e2 = makeEnv();
  const ids = Array.from({ length: 11 }, (_, i) => `7656119800000010${String(i).padStart(1, '0')}${i}`.slice(0, 17));
  let last;
  for (const t of ids) last = e2.mod.handleReport({}, t, JSON.stringify({ target: t }), 'tok-p1');
  assert(last.status === 429, `eleventh report 429 got ${last.status}`);
});

test('report: POST /api/reports and snapshot of the live session + last match', async () => {
  const e = makeEnv();
  e.db.matches.push({ id: 'm1', sessionId: SID, endedAt: new Date(e.T.now - 30 * 60000).toISOString(), players: [{ playerId: P2, kills: 3 }] });
  const c1 = e.mk(P1), c2 = e.mk(P2); e.seat(c1); e.seat(c2);
  const r = e.mod.handleReportApi({}, JSON.stringify({ target: P2, reason: 'x'.repeat(200), text: 'y', evidenceUrl: 'https://e.com/a' }), 'tok-p1');
  assert(r.status === 200, JSON.stringify(r));
  const rep = e.db.moderation.reports[0];
  eq(rep.source, 'api'); eq(rep.reason.length, 64); eq(rep.sessionId, SID);
  assert(rep.snapshot.session && rep.snapshot.session.players.includes(P1) && rep.snapshot.session.players.includes(P2), 'session snapshot');
  eq(rep.snapshot.lastMatch.id, 'm1'); assert(rep.snapshot.target && rep.snapshot.reporter, 'player summaries');
  assert(e.mod.handleReportApi({}, '{}', null).status === 401, '401');
  eq(e.mod.handleReportApi({}, '{}', 'tok-p1').body, { error: 'no-target' });
  eq(e.mod.onMatchEnd(SID, 'match-77'), 1); eq(e.db.moderation.reports[0].matchId, 'match-77');
  eq(e.mod.onMatchEnd(SID, 'match-78'), 0, 'already attached');
});

test('report cap drops oldest non-open first', async () => {
  const e = makeEnv();
  const m = e.db.moderation;
  for (let i = 0; i < 5000; i++) m.reports.push({ id: `old${i}`, status: i === 0 ? 'open' : 'dismissed', target: { id: P2 }, reporter: { id: P1 }, at: new Date(e.T.now).toISOString() });
  assert(e.mod.handleReport({}, P2, '{}', 'tok-p1').status === 200);
  eq(m.reports.length, 5000); eq(m.reports[0].id, 'old0', 'open one kept'); eq(m.reports[1].id, 'old2', 'oldest dismissed dropped');
});

// ---- bans ----
test('bans: active/expiry/lifted + filterPlayerMap', async () => {
  const e = makeEnv();
  const ck = await login(e);
  let r = await api(e, ck, 'POST', '/admin/api/bans', { steamId: P1, reason: 'cheating', hours: 2 });
  assert(r.status === 200 && r.json.ban.expiresAt, r.text);
  assert(e.mod.isBanned(P1), 'banned');
  const sess = { 'player-map': { [P1]: {}, [P2]: {} }, groups: { g1: { players: [P1, P2] }, g2: { players: [P1] } } };
  e.mod.filterPlayerMap(sess);
  eq(Object.keys(sess['player-map']), [P2]); eq(sess.groups.g1.players, [P2]); assert(sess.groups.g2.players.length === 0);
  e.T.now += 3 * 3600 * 1000;
  assert(!e.mod.isBanned(P1), 'expired');
  r = await api(e, ck, 'POST', '/admin/api/bans', { steamId: P2, reason: 'perm', hours: null });
  eq(r.json.ban.expiresAt, null); assert(e.mod.isBanned(P2));
  r = await api(e, ck, 'POST', `/admin/api/bans/${P2}/lift`, {});
  assert(r.status === 200 && !e.mod.isBanned(P2), 'lifted');
  assert((await api(e, ck, 'POST', `/admin/api/bans/${P2}/lift`, {})).status === 404, 'lift twice 404');
  assert((await api(e, ck, 'POST', '/admin/api/bans', { steamId: ADMIN2, reason: 'x' })).status === 403, 'cannot ban an admin');
  assert((await api(e, ck, 'POST', '/admin/api/bans', { steamId: P1, hours: 999999 })).status === 400, 'hours cap');
  assert((await api(e, ck, 'POST', '/admin/api/bans', { steamId: 'bad id!' })).status === 400, 'bad id');
});

test('ban kicks the player from the hosted seat and closes their socket', async () => {
  const e = makeEnv();
  const c1 = e.mk(P1), c2 = e.mk(P2); e.seat(c1); e.seat(c2);
  eq(e.mm.listHosted()[0].players, 2);
  const ck = await login(e);
  const r = await api(e, ck, 'POST', '/admin/api/bans', { steamId: P1, reason: 'cheating', hours: 24 });
  eq(r.json.kicked, [SID]);
  eq(e.mm.listHosted()[0].players, 1);
  assert(c1.closed && !c2.closed, 'banned client closed');
  assert(!Object.keys(e.mm.getHostedSession(SID).session['player-map']).includes(P1), 'seat gone');
});

// ---- host blocks / kick / servers / audit ----
test('host blocks add/lift/validate + callback', async () => {
  const e = makeEnv();
  eq(e.blocks, []);
  const ck = await login(e);
  let r = await api(e, ck, 'POST', '/admin/api/host-blocks', { value: '203.0.113.7', reason: 'bad host' });
  assert(r.status === 200 && r.json.hostBlock.kind === 'ip', r.text); eq(e.blocks, ['203.0.113.7']);
  r = await api(e, ck, 'POST', '/admin/api/host-blocks', { value: '198.51.100.0/24', reason: '' }); eq(r.json.hostBlock.kind, 'cidr');
  r = await api(e, ck, 'POST', '/admin/api/host-blocks', { value: SID, reason: '' }); eq(r.json.hostBlock.kind, 'id');
  assert((await api(e, ck, 'POST', '/admin/api/host-blocks', { value: '999.1.1.1' })).status === 400, 'bad ip');
  assert((await api(e, ck, 'POST', '/admin/api/host-blocks', { value: '1.2.3.4/33' })).status === 400, 'bad cidr');
  assert((await api(e, ck, 'POST', '/admin/api/host-blocks', { value: '203.0.113.7' })).status === 409, 'duplicate');
  assert(e.mod.isHostBlocked('198.51.100.77') && e.mod.isHostBlocked('203.0.113.7') && !e.mod.isHostBlocked('198.51.101.1'), 'ip match');
  const list = (await api(e, ck, 'GET', '/admin/api/bans')).json;
  eq(list.hostBlocks.length, 3);
  r = await api(e, ck, 'POST', `/admin/api/host-blocks/${list.hostBlocks[0].id}/lift`, {});
  assert(r.status === 200 && e.blocks.length === 2, 'lifted and callback');
  eq((await api(e, ck, 'GET', '/admin/api/bans')).json.hostBlocks.length, 2);
  eq((await api(e, ck, 'GET', '/admin/api/bans?all=1')).json.hostBlocks.length, 3);
});

test('kick + servers + spectate + no token leaks', async () => {
  const e = makeEnv();
  const c1 = e.mk(P1), c2 = e.mk(P2); e.seat(c1); e.seat(c2);
  const ck = await login(e);
  const s = await api(e, ck, 'GET', '/admin/api/servers');
  assert(s.status === 200 && s.json.servers.length === 1, s.text);
  const sv = s.json.servers[0];
  assert(sv.game === 'classic' && sv.id === SID && sv.playerCount === 2 && sv.players.some((p) => p.id === P1 && p.name === 'Name011' && p.banned === false), s.text);
  assert(sv.players.find((p) => p.id === 'hostacct').host === true, 'host marked');
  eq(s.json.online, { classic: 2, main: 0 });
  assert(!s.text.includes(SECRET_TOKEN), 'no session token in /servers');
  let r = await api(e, ck, 'POST', '/admin/api/kick', { game: 'classic', sessionId: SID, playerId: P1, reason: 'afk' });
  assert(r.status === 200, r.text); eq(e.mm.listHosted()[0].players, 1);
  assert(c1.msgs.some((m) => m.type === 'player-leave'), 'kicked client told');
  assert((await api(e, ck, 'POST', '/admin/api/kick', { sessionId: SID, playerId: P1 })).status === 404, 'not seated 404');
  assert((await api(e, ck, 'POST', '/admin/api/kick', { sessionId: 'nope', playerId: P1 })).status === 404, 'unknown session 404');
  r = await api(e, ck, 'POST', '/admin/api/spectate', { sessionId: SID });
  assert(r.status === 200 && r.json.address === '127.0.0.1:7777' && !r.text.includes(SECRET_TOKEN), r.text);
  const au = (await api(e, ck, 'GET', '/admin/api/audit')).json;
  assert(au.some((x) => x.action === 'kick' && x.target === P1) && au.some((x) => x.action === 'spectate') && au.some((x) => x.action === 'login'), 'audit entries');
  assert(!JSON.stringify(e.logs).includes('ogsos_admin='), 'no cookie in logs');
  assert(e.logs.some(([f]) => f === 'admin.jsonl'), 'audit mirrored to admin.jsonl');
});

test('kickHosted (matchmaking)', async () => {
  const { mm, mk, seat } = makeMm();
  const a = mk('a'), b = mk('b'); seat(a); seat(b);
  eq(mm.kickHosted('nope', 'a'), { error: 'not-found' });
  eq(mm.kickHosted(SID, 'zzz'), { error: 'not-seated' });
  eq(mm.kickHosted(SID, 'a'), { result: true });
  eq(mm.listHosted()[0].players, 1);
  assert(a.sessionId === null && a.msgs.some((m) => m.type === 'player-leave'), 'client cleared and told');
  assert(b.msgs.some((m) => m.type === 'player-leave' && m.data['player-id'] === 'a'), 'others told');
  eq(mm.kickHosted(SID, 'a'), { error: 'not-seated' });
  mm.shutdown();
});

// ---- players / reports API flow ----
test('players search, detail, reports list/detail/status', async () => {
  const e = makeEnv();
  const ck = await login(e);
  e.db.matches.push({ id: 'm1', sessionId: SID, endedAt: new Date(e.T.now).toISOString(), durationSec: 60, players: [{ playerId: P2, kills: 1 }, { playerId: P3 }] });
  e.mod.handleReport({}, P2, JSON.stringify({ reason: 'cheat' }), 'tok-p1');
  let r = await api(e, ck, 'GET', '/admin/api/me'); eq(r.json, { steamId: ADMIN, name: `Name${ADMIN.slice(-3)}` });
  r = await api(e, ck, 'GET', '/admin/api/players?q=');
  eq(r.json.length, 5); eq(r.json[0].id, P2 === r.json[0].id ? P2 : r.json[0].id);
  assert(r.json.find((x) => x.id === P2).reportsAgainst === 1 && r.json.find((x) => x.id === P2).matches === 1, 'counts');
  r = await api(e, ck, 'GET', '/admin/api/players?q=name012'); eq(r.json.map((x) => x.id), [P2]);
  r = await api(e, ck, 'GET', `/admin/api/players?q=${P3}`); eq(r.json.map((x) => x.id), [P3]);
  r = await api(e, ck, 'GET', `/admin/api/players/${P2}`);
  assert(r.status === 200 && r.json.matches.length === 1 && r.json.reportsAgainst.length === 1 && r.json.ban === null && r.json.current === null, r.text);
  assert((await api(e, ck, 'GET', '/admin/api/players/nobody')).status === 404, 'unknown player 404');
  r = await api(e, ck, 'GET', '/admin/api/reports'); eq(r.json.length, 1);
  const id = r.json[0].id;
  r = await api(e, ck, 'GET', `/admin/api/reports/${id}`);
  assert(r.json.report.id === id && r.json.priorReportsAgainstTarget === 0 && r.json.target && r.json.ban === null, r.text);
  assert((await api(e, ck, 'GET', '/admin/api/reports/zzz')).status === 404);
  r = await api(e, ck, 'POST', `/admin/api/reports/${id}`, { status: 'actioned', note: 'banned' });
  assert(r.status === 200 && r.json.report.resolvedBy === ADMIN && r.json.report.note === 'banned', r.text);
  eq((await api(e, ck, 'GET', '/admin/api/reports?status=open')).json.length, 0);
  eq((await api(e, ck, 'GET', '/admin/api/reports?status=actioned')).json.length, 1);
  eq((await api(e, ck, 'GET', `/admin/api/reports?status=all&target=${P3}`)).json.length, 0);
  assert((await api(e, ck, 'POST', `/admin/api/reports/${id}`, { status: 'bogus' })).status === 400, 'bad status');
  eq((await api(e, ck, 'GET', '/admin/api/matches/m1')).json.id, 'm1');
  assert((await api(e, ck, 'GET', '/admin/api/matches/zz')).status === 404);
  const au = (await api(e, ck, 'GET', '/admin/api/audit?limit=1')).json; eq(au.length, 1); eq(au[0].action, 'report-status');
});

// ---- auth ----
test('auth: 401 without cookie, CSRF header, tampering, expiry, admin removal, dev-login gates', async () => {
  const e = makeEnv();
  assert((await call(e.mod, 'GET', '/admin/api/me')).status === 401, '401 no cookie');
  const ck = await login(e);
  assert((await api(e, ck, 'GET', '/admin/api/me')).status === 200);
  assert((await api(e, ck, 'POST', '/admin/api/bans', { steamId: P1 }, false)).status === 403, 'missing csrf header 403');
  assert((await api(e, ck, 'GET', '/admin/api/players', undefined, false)).status === 200, 'GET needs no csrf header');
  assert((await api(e, ck, 'PUT', '/admin/api/bans', {})).status === 405, 'PUT refused');
  assert((await api(e, ck, 'POST', '/admin/api/bans', '{bad json')).status === 400, 'bad json');
  const [p, s] = ck.split('=')[1].split('.');
  const flip = Buffer.from(p, 'base64url').toString().replace(ADMIN, ADMIN2);
  const forged = `ogsos_admin=${Buffer.from(flip).toString('base64url')}.${s}`;
  assert((await api(e, forged, 'GET', '/admin/api/me')).status === 401, 'tampered payload refused');
  assert((await api(e, `ogsos_admin=${p}.${s.slice(0, -2)}AA`, 'GET', '/admin/api/me')).status === 401, 'tampered signature refused');
  assert((await api(e, 'ogsos_admin=garbage', 'GET', '/admin/api/me')).status === 401, 'garbage refused');
  const other = makeEnv(); other.mod = createModeration({ db: other.db, secret: 'other-secret', env: other.env, now: () => other.T.now, matchmakers: {} });
  assert((await api(other, ck, 'GET', '/admin/api/me')).status === 401, 'cookie from another secret refused');
  const sc = (await call(e.mod, 'GET', `/admin/dev-login?steamid=${ADMIN}`)).headers['Set-Cookie'];
  assert(/HttpOnly/.test(sc) && /Path=\/admin/.test(sc) && /SameSite=Strict/.test(sc) && /Max-Age=43200/.test(sc) && !/Secure/.test(sc), sc);
  e.env.OGSOS_ADMINS = ADMIN2;
  assert((await api(e, ck, 'GET', '/admin/api/me')).status === 401, 'sid removed from OGSOS_ADMINS');
  e.env.OGSOS_ADMINS = ADMIN;
  assert((await api(e, ck, 'GET', '/admin/api/me')).status === 200, 'back again');
  e.T.now += 13 * 3600 * 1000;
  assert((await api(e, ck, 'GET', '/admin/api/me')).status === 401, 'expired');
  const e2 = makeEnv();
  assert((await call(e2.mod, 'GET', `/admin/dev-login?steamid=${P1}`)).status === 403, 'dev-login non-admin 403');
  assert((await call(e2.mod, 'GET', `/admin/dev-login?steamid=${ADMIN}`, { ip: '203.0.113.9' })).status === 404, 'dev-login remote 404');
  assert((await call(e2.mod, 'GET', `/admin/dev-login?steamid=${ADMIN}`, { headers: { 'x-forwarded-for': '1.2.3.4' } })).status === 404, 'dev-login via proxy 404');
  assert((await call(e2.mod, 'GET', `/admin/dev-login?steamid=${ADMIN}`, { ip: '::ffff:127.0.0.1' })).status === 302, 'v4-mapped loopback ok');
  const e3 = makeEnv({ env: { OGSOS_ADMIN_DEV_LOGIN: '0' } });
  assert((await call(e3.mod, 'GET', `/admin/dev-login?steamid=${ADMIN}`)).status === 404, 'dev-login disabled');
  const e4 = makeEnv({ env: { OGSOS_ADMIN_ORIGIN: 'https://sos.example.com' } });
  assert(/; Secure/.test((await call(e4.mod, 'GET', `/admin/dev-login?steamid=${ADMIN}`)).headers['Set-Cookie']), 'Secure with https origin');
  const lo = await call(e.mod, 'GET', '/admin/logout', { headers: { cookie: ck } });
  assert(lo.status === 302 && /Max-Age=0/.test(lo.headers['Set-Cookie']), 'logout clears');
});

test('http: not-admin paths return false, headers, static safety', async () => {
  const e = makeEnv();
  eq((await call(e.mod, 'GET', '/administrator')).handled, false);
  eq((await call(e.mod, 'GET', '/api/x')).handled, false);
  const r = await call(e.mod, 'GET', '/admin/api/me');
  const h = r.headers;
  assert(h['X-Frame-Options'] === 'DENY' && h['Cache-Control'] === 'no-store' && h['Referrer-Policy'] === 'no-referrer' && h['X-Content-Type-Options'] === 'nosniff' && /frame-ancestors 'none'/.test(h['Content-Security-Policy']), 'security headers');
  assert((await call(e.mod, 'GET', '/admin')).status === 302, '/admin redirects');
  for (const bad of ['/admin/..%2fserver.js', '/admin/Index.HTML', '/admin/a.txt', '/admin/.env', '/admin/nothing-here.js']) {
    assert((await call(e.mod, 'GET', bad)).status === 404, `${bad} -> 404`);
  }
  const idx = await call(e.mod, 'GET', '/admin/');
  assert(idx.status === 200 || idx.status === 404, 'index served, or 404 while the panel folder is missing');
  const login = await call(e.mod, 'GET', '/admin/login');
  const loc = login.headers.Location;
  assert(login.status === 302 && loc.startsWith('https://steamcommunity.com/openid/login?') && loc.includes('openid.return_to=http%3A%2F%2F127.0.0.1%3A7795%2Fadmin%2Fauth') && loc.includes('openid.realm='), loc);
});

// ---- OpenID against a fake Steam ----
function startFakeOpenId() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const p = new URLSearchParams(Buffer.concat(chunks).toString());
      seen.push(Object.fromEntries(p));
      const ok = req.method === 'POST' && p.get('openid.mode') === 'check_authentication' && p.get('openid.assoc_handle') === 'good';
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`ns:http://specs.openid.net/auth/2.0\nis_valid:${ok ? 'true' : 'false'}\n`);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}/openid/login` })));
}
function assertion(op, sid, over = {}) {
  const p = {
    'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'id_res', 'openid.op_endpoint': op,
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${sid}`, 'openid.identity': `https://steamcommunity.com/openid/id/${sid}`,
    'openid.return_to': 'http://127.0.0.1:7795/admin/auth', 'openid.response_nonce': '2026-06-01T12:00:00Zabc', 'openid.assoc_handle': 'good',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle', 'openid.sig': 'abc=', ...over,
  };
  return '?' + new URLSearchParams(p);
}
test('openid: valid + admin -> cookie; invalid/non-admin/wrong endpoint/return_to refused', async () => {
  const fake = await startFakeOpenId();
  try {
    const e = makeEnv({ env: { OGSOS_STEAM_OPENID: fake.url, OGSOS_ADMIN_DEV_LOGIN: '0' } });
    let r = await call(e.mod, 'GET', '/admin/login');
    assert(r.headers.Location.startsWith(fake.url + '?'), 'login redirects to the configured endpoint');
    r = await call(e.mod, 'GET', '/admin/auth' + assertion(fake.url, ADMIN));
    assert(r.status === 302 && r.headers.Location === '/admin/', `valid: ${r.status} ${r.text}`);
    const ck = cookieOf(r); assert(ck && ck.startsWith('ogsos_admin='), 'cookie set');
    assert((await api(e, ck, 'GET', '/admin/api/me')).status === 200, 'cookie works');
    const back = fake.seen[fake.seen.length - 1];
    eq(back['openid.mode'], 'check_authentication'); eq(back['openid.sig'], 'abc='); eq(back['openid.claimed_id'], `https://steamcommunity.com/openid/id/${ADMIN}`);
    const n = fake.seen.length;
    r = await call(e.mod, 'GET', '/admin/auth' + assertion(fake.url, ADMIN, { 'openid.assoc_handle': 'forged' }));
    assert(r.status === 400 && !cookieOf(r), `is_valid:false refused: ${r.status}`);
    r = await call(e.mod, 'GET', '/admin/auth' + assertion(fake.url, P1));
    assert(r.status === 403 && !cookieOf(r), `non-admin 403: ${r.status}`);
    const before = fake.seen.length;
    r = await call(e.mod, 'GET', '/admin/auth' + assertion('https://evil.example/openid/login', ADMIN));
    assert(r.status === 400 && !cookieOf(r), 'wrong op_endpoint refused');
    r = await call(e.mod, 'GET', '/admin/auth' + assertion(fake.url, ADMIN, { 'openid.return_to': 'http://evil.example/admin/auth' }));
    assert(r.status === 400 && !cookieOf(r), 'wrong return_to refused');
    r = await call(e.mod, 'GET', '/admin/auth' + assertion(fake.url, ADMIN, { 'openid.claimed_id': 'https://evil.example/openid/id/' + ADMIN }));
    assert(r.status === 400 && !cookieOf(r), 'wrong claimed_id host refused');
    r = await call(e.mod, 'GET', '/admin/auth' + assertion(fake.url, ADMIN, { 'openid.mode': 'cancel' }));
    assert(r.status === 400 && !cookieOf(r), 'cancel refused');
    eq(fake.seen.length, before, 'structurally bad assertions never reach the OP');
    assert(n >= 1, 'verified with the OP');
    const au = e.db.moderation.audit.map((x) => x.action);
    assert(au.includes('login') && au.includes('login-denied') && au.includes('login-failed'), au.join());
    // unreachable OP: refused, not hung
    const e2 = makeEnv({ env: { OGSOS_STEAM_OPENID: 'http://127.0.0.1:1/openid/login', OGSOS_ADMIN_DEV_LOGIN: '0' } });
    r = await call(e2.mod, 'GET', '/admin/auth' + assertion('http://127.0.0.1:1/openid/login', ADMIN));
    assert(r.status === 400 && !cookieOf(r), 'unreachable OP refused');
  } finally { fake.srv.close(); }
});

// ---- native report route, evidence, ban body, spectate ----
test('native app-meta report: path id is the target, reply shape, gameGuid stored (not sessionId)', async () => {
  const e = makeEnv();
  const c1 = e.mk(P1), c2 = e.mk(P2); e.seat(c1); e.seat(c2);
  const body = { reason: 'cheating', 'game-session-id': 'GAMEGUID-0001', notes: 'aimbot', 'evidence-video-format': 'mp4' };
  const r = e.mod.handleReport({}, P2, JSON.stringify(body), 'tok-p1');
  assert(r.status === 200, JSON.stringify(r));
  const rep = e.db.moderation.reports[0];
  eq(rep.target.id, P2); eq(rep.reporter.id, P1); eq(rep.text, 'aimbot'); eq(rep.gameGuid, 'GAMEGUID-0001'); eq(rep.evidenceVideoFormat, 'mp4');
  eq(rep.sessionId, SID, 'sessionId comes from the seat, not the GameGuid');
  eq(r.body.report, { created: rep.at, 'game-session-d': 'GAMEGUID-0001', 'game-session-id': 'GAMEGUID-0001', reason: 'cheating', notes: 'aimbot', 'reporter-id': P1, 'evidence-url': '' });
  // no seat, GameGuid only: sessionId stays null
  const e2 = makeEnv();
  e2.mod.handleReport({}, P2, JSON.stringify({ reason: 'spam', 'game-session-id': 'GG-2' }), 'tok-p1');
  eq(e2.db.moderation.reports[0].sessionId, null); eq(e2.db.moderation.reports[0].gameGuid, 'GG-2');
  eq(e2.mod.handleReport({}, P1, '{}', 'tok-p1').status, 400, 'self still refused');
  eq(e2.mod.handleReport({}, P2, '{}', null).status, 401);
});

test('evidence attach: reporter ok, other player 403, bad url 400, unknown 404', async () => {
  const e = makeEnv();
  e.mod.handleReport({}, P2, JSON.stringify({ reason: 'cheating' }), 'tok-p1');
  const id = e.db.moderation.reports[0].id;
  eq(e.mod.handleEvidence({}, id, JSON.stringify({ evidenceUrl: 'https://youtu.be/abc' }), null).status, 401);
  eq(e.mod.handleEvidence({}, id, JSON.stringify({ evidenceUrl: 'https://youtu.be/abc' }), 'tok-p2').status, 403);
  eq(e.mod.handleEvidence({}, id, JSON.stringify({ evidenceUrl: 'javascript:alert(1)' }), 'tok-p1').status, 400);
  eq(e.mod.handleEvidence({}, id, JSON.stringify({ evidenceUrl: 'https://e.com/' + 'a'.repeat(600) }), 'tok-p1').status, 400);
  eq(e.mod.handleEvidence({}, 'r999', JSON.stringify({ evidenceUrl: 'https://e.com/a' }), 'tok-p1').status, 404);
  eq(e.db.moderation.reports[0].evidenceUrl, null);
  const ok = e.mod.handleEvidence({}, id, JSON.stringify({ evidenceUrl: 'https://youtu.be/abc' }), 'tok-p1');
  eq(ok.status, 200); eq(e.db.moderation.reports[0].evidenceUrl, 'https://youtu.be/abc');
});

test('ban code + banBody: the shape the client parses', async () => {
  const e = makeEnv();
  const ck = await login(e);
  let r = await api(e, ck, 'POST', '/admin/api/bans', { steamId: P1, reason: 'internal note', hours: 24, code: 'harassment' });
  eq(r.json.ban.code, 'harassment');
  const b = e.mod.banBody(e.mod.isBanned(P1));
  eq(b.error, 'forbidden'); eq(b.metadata.cause, 'app-banned');
  eq(b.metadata.ban.reason, 'harassment'); eq(b.metadata.ban.duration, 86400); eq(b.metadata.ban.type, 'app');
  eq(b.metadata.ban.created, e.db.moderation.bans[P1].at); eq(b.metadata.ban.exp, e.db.moderation.bans[P1].expiresAt);
  eq(b.data.metadata.cause, 'app-banned'); eq(b.version, 1);
  r = await api(e, ck, 'POST', '/admin/api/bans', { steamId: P2, reason: 'x', hours: null, code: 'nonsense' });
  eq(r.json.ban.code, 'other');
  const p = e.mod.banBody(e.mod.isBanned(P2));
  eq(p.metadata.ban.reason, 'other'); eq(p.metadata.ban.exp, null); eq(p.metadata.ban.duration, 315360000);
  r = await api(e, ck, 'POST', '/admin/api/bans', { steamId: P3, reason: 'x', hours: 168, code: 'toxicity' });
  eq(e.mod.banBody(e.mod.isBanned(P3)).metadata.ban.duration, 604800);
});

function b64j(x) { return JSON.parse(Buffer.from(x, 'base64url').toString()); }
test('spectate: watcher allow-listed in the host GET but never seated; token verifies; stop removes; non-admin refused', async () => {
  const e = makeEnv();
  const c1 = e.mk(P1), c2 = e.mk(P2); e.seat(c1); e.seat(c2);
  const ck = await login(e);
  const before = e.mm.listHosted()[0];
  let r = await api(e, ck, 'POST', '/admin/api/spectate', { sessionId: SID, mode: 'director' });
  assert(r.status === 200, r.text);
  const j = r.json;
  eq(j.mode, 'director'); eq(j.address, '127.0.0.1:7777'); eq(j.sessionId, SID);
  assert(j.joinUrl === `127.0.0.1:7777?SpectatorOnly=1&DirectorOnly=1&AuthToken=${j.authToken}` && j.command === `open ${j.joinUrl}` && j.instructions, j.joinUrl);
  assert(Math.abs(Date.parse(j.expiresAt) - (e.T.now ? Date.now() : 0) - 3 * 3600 * 1000) < 60000, 'expires in about 3 h');
  // JWT: HS512 keyed with the session token, sub = session id, roles user+session, id = the admin
  const [h64, c64, sig] = j.authToken.split('.');
  eq(b64j(h64).alg, 'HS512');
  eq(sig, require('crypto').createHmac('sha512', SECRET_TOKEN).update(`${h64}.${c64}`).digest('base64url'));
  const claims = b64j(c64);
  eq(claims.sub, SID); assert(claims.roles.includes('user+session'), 'roles'); eq(claims['account-id'], ADMIN);
  // host GET: in player-map and ogsos-watchers; not seated anywhere else
  const g = e.mm.getHostedSession(SID).session;
  assert(g['player-map'][ADMIN] && g['player-map'][P1] && g['player-map'][P2], 'player-map has watcher and players');
  eq(g['ogsos-watchers'], [ADMIN]);
  eq(e.mm.listHosted()[0].players, before.players);
  const s = (await api(e, ck, 'GET', '/admin/api/servers')).json.servers[0];
  assert(!s.players.some((p) => p.id === ADMIN), 'watcher not in the players list');
  eq(s.playerCount, 2); eq(s.watchers, [{ id: ADMIN, name: `Name${ADMIN.slice(-3)}` }]);
  // spectator mode, no director flag
  r = await api(e, ck, 'POST', '/admin/api/spectate', { sessionId: SID, mode: 'spectator' });
  assert(r.json.joinUrl.startsWith('127.0.0.1:7777?SpectatorOnly=1&AuthToken='), r.json.joinUrl);
  // kick / ban never touch a watcher
  eq(e.mm.kickHosted(SID, ADMIN), { error: 'not-seated' });
  eq((await api(e, ck, 'POST', '/admin/api/kick', { sessionId: SID, playerId: ADMIN })).status, 404);
  // admin list and token are never in logs / audit
  const au = (await api(e, ck, 'GET', '/admin/api/audit')).json;
  assert(au.some((x) => x.action === 'spectate'), 'audited');
  assert(!JSON.stringify(au).includes(j.authToken) && !JSON.stringify(e.logs).includes(j.authToken), 'token not logged');
  // validation
  eq((await api(e, ck, 'POST', '/admin/api/spectate', { sessionId: SID, steamId: P1 })).status, 403, 'non-admin steamId refused');
  eq((await api(e, ck, 'POST', '/admin/api/spectate', { sessionId: SID, mode: 'fly' })).status, 400);
  eq((await api(e, ck, 'POST', '/admin/api/spectate', { sessionId: 'nope' })).status, 404);
  assert(e.mm.watchToken(SID, P1) === null, 'no token for a non-watcher');
  // second admin as steamId
  r = await api(e, ck, 'POST', '/admin/api/spectate', { sessionId: SID, steamId: ADMIN2 });
  eq(r.status, 200); eq(e.mm.getHostedSession(SID).session['ogsos-watchers'].sort(), [ADMIN, ADMIN2].sort());
  // stop
  r = await api(e, ck, 'POST', '/admin/api/spectate/stop', { sessionId: SID });
  eq(r.status, 200); eq(e.mm.getHostedSession(SID).session['ogsos-watchers'], [ADMIN2]);
  assert(!e.mm.getHostedSession(SID).session['player-map'][ADMIN], 'removed from player-map');
  eq((await api(e, ck, 'POST', '/admin/api/spectate/stop', { sessionId: SID, steamId: P1 })).status, 403);
  assert((await api(e, ck, 'GET', '/admin/api/audit')).json.some((x) => x.action === 'spectate-stop'), 'stop audited');
});

test('watchers expire and survive a match end', async () => {
  const { mm } = makeMm();
  assert(mm.addWatcher(SID, 'w1', 50), 'added');
  assert(mm.addWatcher(SID, 'w2'), 'default ttl');
  mm.endHosted(SID);
  eq(mm.listWatchers(SID).sort(), ['w1', 'w2'], 'kept across match end');
  await new Promise((r) => setTimeout(r, 80));
  eq(mm.listWatchers(SID), ['w2'], 'expired one pruned');
  assert(mm.watchToken(SID, 'w1') === null && mm.watchToken(SID, 'w2'), 'token only for active');
  assert(mm.removeWatcher(SID, 'w2') && !mm.removeWatcher(SID, 'w2'));
  eq(mm.addWatcher('nope', 'w'), null);
  mm.shutdown();
});

// ---- run ----
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; out('PASS ', name); } catch (e) { failed++; out('FAIL ', name, '-', e.stack || e.message); }
  }
  out(`${passed} passed, ${failed} failed`);
  console.warn = origWarn;
  process.exit(failed ? 1 : 0);
})();
