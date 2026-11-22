// Moderation logic (server/admin.js + matchmaking kickHosted), offline: fake db, real matchmaker with fake clients,
// a tiny fake Steam OpenID server on 127.0.0.1.   node tools/moderation_test.js
'use strict';
const http = require('http');
const { createModeration } = require('../server/admin');
const { createMatchmaker } = require('../server/matchmaking');

const ADMIN = '76561190000080001', ADMIN2 = '76561190000080009', P1 = '76561190000080011', P2 = '76561190000080012', P3 = '76561190000080013';
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
  const db = extra.db || { accounts: {}, appData: {}, tokens: {}, matches: [] };
  for (const id of (extra.db ? [] : [ADMIN, ADMIN2, P1, P2, P3])) {
    db.accounts[id] = { id, 'account-id': id, alias: `player-${id.slice(-4)}`, 'display-name': `Name${id.slice(-3)}`, created: '2026-01-01T00:00:00Z', 'last-access': `2026-05-0${id.slice(-1) === '1' ? 1 : 2}T00:00:00Z` };
  }
  const { mm, mk, seat } = extra.mmx || makeMm();
  const env = { OGSOS_ADMINS: `${ADMIN}, ${ADMIN2}`, OGSOS_ADMIN_ORIGIN: 'http://127.0.0.1:7795', OGSOS_ADMIN_DEV_LOGIN: '1', ...(extra.env || {}) };
  const jwt = { 'tok-p1': P1, 'tok-p2': P2, 'tok-p3': P3 };
  const blocks = [];
  const mod = createModeration({
    db, saveDb: () => { saves.n++; }, log: (f, e) => logs.push([f, e]), secret: 'test-secret',
    jwtAccount: (t) => jwt[t] || null, displayName: (id) => db.accounts[id]?.['display-name'] || id,
    progression: { playerSummary: (id) => (db.accounts[id] ? { matches: 1, kills: 2 } : {}) },
    matchmakers: { classic: mm, main: null }, env, now: () => T.now,
    onHostBlocksChanged: (l) => { blocks.length = 0; blocks.push(...l); },
    ...(extra.modOpts || {}),
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
  const ids = Array.from({ length: 11 }, (_, i) => `7656119000008010${String(i).padStart(1, '0')}${i}`.slice(0, 17));
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
  let r = await api(e, ck, 'GET', '/admin/api/me'); eq(r.json, { steamId: ADMIN, name: `Name${ADMIN.slice(-3)}`, role: 'owner' });
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
  assert(r.status === 200 && r.json.report.resolvedBy === ADMIN && r.json.report.status === 'resolved' && r.json.report.notes[0].text === 'banned', r.text);   // 'actioned' is accepted as 'resolved'
  eq((await api(e, ck, 'GET', '/admin/api/reports?status=open')).json.length, 0);
  eq((await api(e, ck, 'GET', '/admin/api/reports?status=resolved')).json.length, 1);
  eq((await api(e, ck, 'GET', '/admin/api/reports?status=actioned')).json.length, 1);
  eq((await api(e, ck, 'GET', `/admin/api/reports?status=all&target=${P3}`)).json.length, 0);
  assert((await api(e, ck, 'POST', `/admin/api/reports/${id}`, { status: 'bogus' })).status === 400, 'bad status');
  eq((await api(e, ck, 'GET', '/admin/api/matches/m1')).json.id, 'm1');
  assert((await api(e, ck, 'GET', '/admin/api/matches/zz')).status === 404);
  const au = (await api(e, ck, 'GET', '/admin/api/audit?limit=1')).json; eq(au.length, 1); eq(au[0].action, 'report-note');
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
  assert((await call(e.mod, 'GET', '/admin/logout', { headers: { cookie: ck } })).status === 405, 'GET logout refused');
  assert((await call(e.mod, 'POST', '/admin/logout', { headers: { cookie: ck } })).status === 403, 'POST logout needs the CSRF header');
  const lo = await call(e.mod, 'POST', '/admin/logout', { headers: { cookie: ck, 'x-ogsos-admin': '1' } });
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

// ================= admin v2 =================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFame } = require('../server/fame');
const { createCommunityRegistry } = require('../server/community');
const MOD = '76561190000000002', MOD2 = '76561190000000003';
const post = (e, ck, p, body) => api(e, ck, 'POST', `/admin/api/${p}`, body);
const get = (e, ck, p) => api(e, ck, 'GET', `/admin/api/${p}`);
const lobbyState = (e) => e.mm.listHosted()[0].state;
const newOwner = async (e) => login(e, ADMIN);
async function addMod(e, ck, id = MOD) {
  const r = await post(e, ck, 'admins', { steamId: id });
  assert(r.status === 200, `add mod ${r.status} ${r.text}`);
  return login(e, id);
}

// ---- roles ----
test('roles: owner adds a mod, the mod logs in, owner-only endpoints 403, mod can lobby-control, owner removes the mod', async () => {
  const e = makeEnv();
  const ck = await newOwner(e);
  eq((await get(e, ck, 'me')).json.role, 'owner');
  // not yet an admin: dev-login refused
  assert((await call(e.mod, 'GET', `/admin/dev-login?steamid=${MOD}`)).status === 403, 'not yet admin');
  const mk = await addMod(e, ck);
  eq((await get(e, mk, 'me')).json, { steamId: MOD, name: MOD, role: 'mod' });
  assert(e.mod.isAdmin(MOD) && e.mod.roleOf(MOD) === 'mod' && e.mod.roleOf(ADMIN) === 'owner' && e.mod.roleOf(P1) === null, 'roleOf / isAdmin');
  eq((await get(e, mk, 'admins')).json.mods.map((x) => x.steamId), [MOD]);
  eq((await get(e, mk, 'admins')).json.owners.map((x) => x.steamId).sort(), [ADMIN, ADMIN2].sort());
  assert((await post(e, ck, 'admins', { steamId: MOD })).status === 409, 'duplicate');
  assert((await post(e, ck, 'admins', { steamId: ADMIN2 })).status === 409, 'owner already admin');
  assert((await post(e, ck, 'admins', { steamId: 'abc' })).status === 400, 'bad id');
  // owner-only for a mod
  let r = await post(e, mk, 'admins', { steamId: MOD2 }); eq([r.status, r.json], [403, { error: 'owner-only' }]);
  r = await post(e, mk, `admins/${MOD}/remove`, {}); eq(r.status, 403);
  r = await post(e, mk, 'kv', { key: 'UE_CLIENT_MOTD', value: 'x' }); eq([r.status, r.json], [403, { error: 'owner-only' }]);
  r = await post(e, mk, 'kv/UE_CLIENT_MOTD/clear', {}); eq(r.status, 403);
  // mod can ban a normal player and lobby-control; cannot ban owners or mods
  r = await post(e, mk, 'bans', { steamId: P1, hours: 1, code: 'spam', reason: 'x' }); eq(r.status, 200);
  r = await post(e, mk, 'bans', { steamId: ADMIN2, hours: 1 }); eq([r.status, r.json.error], [403, 'cannot-ban-admin']);
  await post(e, ck, 'admins', { steamId: MOD2 });
  r = await post(e, mk, 'bans', { steamId: MOD2, hours: 1 }); eq([r.status, r.json.error], [403, 'cannot-ban-admin']);
  r = await post(e, ck, 'bans', { steamId: ADMIN2 }); eq([r.status, r.json.error], [403, 'cannot-ban-admin']);   // owners are never bannable
  r = await post(e, ck, 'bans', { steamId: MOD2, hours: 1, code: 'other' }); eq(r.status, 200);                 // an owner can ban a mod
  r = await post(e, mk, `bans/${MOD2}/lift`, {}); eq([r.status, r.json.error], [403, 'owner-only']);
  e.mm.markHostPolled(SID);
  r = await post(e, mk, `lobbies/${SID}/lock`, {}); eq(r.status, 200);
  assert((await get(e, mk, 'audit?action=lobby-lock')).json[0].by === MOD, 'audited as the mod');
  // remove: the mod's existing cookie stops working at once
  eq((await post(e, ck, `admins/${MOD}/remove`, {})).status, 200);
  eq((await get(e, mk, 'me')).status, 401);
  eq((await post(e, ck, `admins/${MOD}/remove`, {})).status, 404);
  eq((await post(e, ck, `admins/${ADMIN2}/remove`, {})).status, 400);
  eq(e.db.moderation.audit.filter((x) => x.action === 'mod-add' || x.action === 'mod-remove').map((x) => x.action), ['mod-add', 'mod-add', 'mod-remove']);
});

// ---- lobby control ----
test('lobby control: force-start, countdown, options, lock/unlock, end, reset, validation, audit', async () => {
  const e = makeEnv();
  const ck = await newOwner(e);
  const c1 = e.mk(P1); e.seat(c1);
  const url = (a) => `lobbies/${SID}/${a}`;
  eq(lobbyState(e), 'waiting');
  let r = await get(e, ck, 'servers');
  const sv = r.json.servers[0];
  eq([sv.locked, sv.overrides, sv.effective, sv.playerCount], [false, {}, { minPlayers: 4, countdownSec: 30, maxPlayers: 8 }, 1]);
  // csrf + unknown
  eq((await api(e, ck, 'POST', `/admin/api/${url('lock')}`, {}, false)).status, 403);
  eq((await post(e, ck, 'lobbies/zzzzzzzz-nope/lock', {})).status, 404);
  eq((await post(e, ck, url('explode'), {})).status, 404);
  // countdown with an explicit time
  r = await post(e, ck, url('countdown'), { sec: 20 });
  assert(r.status === 200 && r.json.ok && r.json.lobby.state === 'countdown', r.text);
  const ms = r.json.lobby.countdownEndsAt - Date.now();
  assert(ms > 15000 && ms <= 20500, `countdownEndsAt ${r.json.lobby.countdownEndsAt}`);
  eq((await post(e, ck, url('countdown'), { sec: 601 })).json.error, 'bad-sec');
  eq((await post(e, ck, url('countdown'), { sec: 1.5 })).status, 400);
  // force start with 1 seated
  r = await post(e, ck, url('force-start'), {});
  assert(r.status === 200 && r.json.lobby.state === 'started' && r.json.lobby.players === 1, r.text);
  assert(c1.msgs.some((m) => m.type === 'session-started'), 'seated player got session-started');
  r = await post(e, ck, url('force-start'), {}); eq([r.status, r.json.error], [409, 'closed']);
  r = await post(e, ck, url('countdown'), {}); eq([r.status, r.json.error], [409, 'closed']);
  // end -> ended, again -> 409
  r = await post(e, ck, url('end'), {}); eq([r.status, r.json.lobby.state], [200, 'ended']);
  r = await post(e, ck, url('end'), {}); eq(r.status, 409);
  // reset -> waiting, nobody seated: force-start / countdown refuse (409 no-players)
  r = await post(e, ck, url('reset'), {}); eq([r.status, r.json.lobby.state], [200, 'waiting']);
  e.mm.markHostPolled(SID);
  r = await post(e, ck, url('force-start'), {}); eq([r.status, r.json.error], [409, 'no-players']);
  eq(lobbyState(e), 'waiting', 'matchmaker unchanged');
  r = await post(e, ck, url('countdown'), {}); eq([r.status, r.json.error], [409, 'no-players']);
  // options: lowering the minimum triggers the countdown (4 needed, 1 seated)
  const c2 = e.mk(P2); e.seat(c1); e.seat(c2);
  eq(lobbyState(e), 'waiting');
  eq(e.mm.listHosted()[0].players, 2);
  r = await post(e, ck, url('options'), { minPlayers: 2, countdownSec: 15 });
  assert(r.status === 200 && r.json.lobby.state === 'countdown', r.text);
  eq(r.json.lobby.overrides, { minPlayers: 2, countdownSec: 15 });
  eq(r.json.lobby.effective, { minPlayers: 2, countdownSec: 15, maxPlayers: 8 });
  assert(r.json.lobby.countdownEndsAt - Date.now() <= 15500 && r.json.lobby.countdownEndsAt - Date.now() > 10000, 'uses the override countdown');
  // raising it back (clearing) cancels the countdown again
  r = await post(e, ck, url('options'), { minPlayers: null, countdownSec: '' });
  eq([r.json.lobby.state, r.json.lobby.overrides], ['waiting', {}]);
  eq(e.db.moderation.lobbyOptions[SID], undefined, 'nothing stored when nothing is overridden');
  // validation
  eq((await post(e, ck, url('options'), { minPlayers: 0 })).json.error, 'bad-minPlayers');
  eq((await post(e, ck, url('options'), { minPlayers: 9 })).json.error, 'bad-minPlayers');
  eq((await post(e, ck, url('options'), { maxPlayers: 9 })).json.error, 'bad-maxPlayers');
  eq((await post(e, ck, url('options'), { countdownSec: -1 })).json.error, 'bad-countdownSec');
  eq((await post(e, ck, url('options'), { minPlayers: 'x' })).json.error, 'bad-minPlayers');
  eq((await post(e, ck, url('options'), {})).json.error, 'no-options');
  r = await post(e, ck, url('options'), { maxPlayers: 3, minPlayers: 3 });
  eq(r.json.lobby.effective.maxPlayers, 3); eq(r.json.lobby.maxPlayers, 3);
  r = await post(e, ck, url('options'), { maxPlayers: 2 });
  eq([r.status, r.json.lobby.effective.minPlayers, r.json.lobby.effective.maxPlayers], [200, 2, 2], 'the minimum is clamped to the maximum');
  await post(e, ck, url('options'), { maxPlayers: null, minPlayers: null });
  // lock / unlock
  r = await post(e, ck, url('lock'), {}); eq([r.status, r.json.lobby.locked, r.json.lobby.lateJoinOpen], [200, true, false]);
  const c3 = e.mk(P3); e.seat(c3);
  assert(!c3.msgs.some((m) => m.type === 'session'), 'locked: find-session is not seated here');
  eq(e.mm.listHosted()[0].players, 2);
  eq(e.mm.setJoinHint(SID, P3).error, 'closed');
  r = await post(e, ck, url('unlock'), {}); eq([r.json.lobby.locked, r.json.lobby.lateJoinOpen], [false, true]);
  assert(!e.mm.setJoinHint(SID, P3).error, 'join hint works after unlock');
  eq(e.db.moderation.lobbyOptions[SID], undefined);
  // audit
  const acts = e.db.moderation.audit.filter((x) => x.action.startsWith('lobby-')).map((x) => x.action);
  for (const a of ['lobby-countdown', 'lobby-force-start', 'lobby-end', 'lobby-reset', 'lobby-options', 'lobby-lock', 'lobby-unlock']) assert(acts.includes(a), `audit ${a}`);
  const od = e.db.moderation.audit.find((x) => x.action === 'lobby-options');
  assert(od.target === SID && od.detail.includes('->') && od.detail.includes('minPlayers'), od.detail);
});

test('lobby overrides persist in the db and are re-applied after a restart', async () => {
  const e = makeEnv();
  const ck = await newOwner(e);
  assert((await post(e, ck, `lobbies/${SID}/options`, { minPlayers: 2, countdownSec: 7, maxPlayers: 5 })).status === 200);
  assert((await post(e, ck, `lobbies/${SID}/lock`, {})).status === 200);
  eq(e.db.moderation.lobbyOptions[SID], { locked: true, overrides: { minPlayers: 2, countdownSec: 7, maxPlayers: 5 } });
  // "restart": a fresh matchmaker and a new moderation over the same db
  const e2 = makeEnv({ db: JSON.parse(JSON.stringify(e.db)) });
  const l = e2.mm.listHosted()[0];
  eq([l.locked, l.overrides, l.effective, l.lateJoinOpen], [true, { minPlayers: 2, countdownSec: 7, maxPlayers: 5 }, { minPlayers: 2, countdownSec: 7, maxPlayers: 5 }, false]);
  // re-applied for a session that appears later (community host re-register)
  const e3 = makeEnv({ db: JSON.parse(JSON.stringify(e.db)) });
  e3.db.moderation.lobbyOptions['aaaaaaaa-0000-4000-8000-000000000009'] = { locked: true, overrides: { minPlayers: 1 } };
  eq(e3.mod.reapplyLobbyOptions('aaaaaaaa-0000-4000-8000-000000000009'), 0, 'unknown session: nothing applied, entry kept');
  assert(e3.db.moderation.lobbyOptions['aaaaaaaa-0000-4000-8000-000000000009'], 'entry kept');
});

// ---- dashboard ----
test('dashboard: counts', async () => {
  const e = makeEnv();
  const ck = await newOwner(e);
  const c1 = e.mk(P1); e.seat(c1); e.mk(P2);
  const iso = (ms) => new Date(e.T.now - ms).toISOString();
  e.db.matches.push({ id: 'old', sessionId: SID, endedAt: iso(20 * 86400e3), players: [] }, { id: 'wk', sessionId: SID, endedAt: iso(3 * 86400e3), players: [] },
    { id: 'td', sessionId: SID, endedAt: iso(1000), players: [] });   // e.T.now is 12:00 UTC: 1 s ago is today
  e.mod.handleReport({}, P2, '{}', 'tok-p1'); e.mod.handleReport({}, P3, '{}', 'tok-p1');
  await post(e, ck, 'reports/r2', { status: 'investigating' });
  await post(e, ck, 'bans', { steamId: P3, hours: 1 });
  const d = (await get(e, ck, 'dashboard')).json;
  eq(d.playersOnline, { classic: 2, main: 0 }); eq(d.seated, 1); eq(d.queue.main, 0);
  eq(d.matches, { today: 1, week: 2 }); eq(d.reports, { open: 1, investigating: 1 }); eq(d.bansActive, 1);
  eq(d.hosts, { up: 1, down: 0 });
  eq(d.lobbies.length, 1);
  const l = d.lobbies[0];
  eq([l.id, l.game, l.name, l.state, l.players, l.maxPlayers, l.online, l.locked, l.community, l.verified, l.countdownEndsAt], [SID, 'classic', 'T', 'waiting', 1, 8, true, false, false, false, null]);
  assert(typeof l.lastSeenSec === 'number' && d.generatedAt, 'lastSeenSec, generatedAt');
});

// ---- players ----
const mkBlob = () => ({ version: 8, permissions: { allowCheats: false }, social: { mutedPlayers: [] },
  stats: { objectives: { classic: { totalGamesPlayed: 9, totalEscapes: 3 } }, social: { totalFameWins: 2 }, hero: { totalLoveFeedbackReceived: 4 } },
  progression: { level: 4, levelProgress: 0.5 }, badges: { amusing: 3 },
  ratings: { soloRatings: { fame: { leaderboardId: 'fame_solo', matchesPlayed: 5, rating: 11 }, survival: { leaderboardId: 'survival_solo', matchesPlayed: 5, rating: 22 } }, toxicity: { leaderboardId: 'toxicity', matchesPlayed: 5, rating: 33 } } });

test('players: profile, notes, warnings, kicks; adjust refused while seated, version bump, audit old/new; reset-stats', async () => {
  const fameDb = { heroStats: { [P1]: { anger: 1, applause: 2, laughter: 0, love: 4, shock: 0, fame: 9, fameWins: 2, matches: 5, soloFameRating: 11, prevSoloFameRating: 6 } } };
  const db = { accounts: {}, appData: {}, tokens: {}, matches: [], ...fameDb };
  for (const id of [ADMIN, ADMIN2, P1, P2, P3]) db.accounts[id] = { id, alias: `a${id.slice(-3)}`, 'display-name': `Name${id.slice(-3)}` };
  const fame = createFame({ db, saveDb: () => {}, displayName: (id) => id });
  const e = makeEnv({ db, modOpts: { fame } });
  const ck = await newOwner(e);
  db.appData[`${P1}/sostest`] = { version: 5, data: mkBlob() };
  db.appData[`${P3}/sostest`] = { version: 2, data: mkBlob() };
  db.playerStats = { [P1]: { matches: 3, kills: 4 } };
  let r = await get(e, ck, `players/${P1}`);
  const pf = r.json.profile;
  eq([pf.level, pf.levelProgress, pf.xpToNext, pf.xpIntoLevel], [4, 0.5, 2400, 1200]);   // level 4 needs 2400 XP
  eq(pf.ratings, { fameSolo: 11, fameDuo: null, survivalSolo: 22, survivalDuo: null, toxicity: 33 });
  eq(pf.fame.soloFameRating, 11);
  eq((await get(e, ck, `players/${P2}`)).json.profile.level, null, 'no blob: nulls');
  // notes / warn
  eq((await post(e, ck, `players/${P1}/notes`, { text: '' })).status, 400);
  r = await post(e, ck, `players/${P1}/notes`, { text: 'n'.repeat(1500) });
  assert(r.status === 200 && r.json.note.text.length === 1000 && r.json.note.by === ADMIN && r.json.note.id, r.text);
  await post(e, ck, `players/${P1}/notes`, { text: 'second' });
  eq((await post(e, ck, `players/${P1}/warn`, { reason: '' })).status, 400);
  r = await post(e, ck, `players/${P1}/warn`, { reason: 'w'.repeat(300) });
  assert(r.status === 200 && r.json.warning.reason.length === 200, r.text);
  eq((await post(e, ck, 'players/nobody/notes', { text: 'x' })).status, 404);
  const d = (await get(e, ck, `players/${P1}`)).json;
  eq(d.notes.map((x) => x.text.length > 10 ? 'long' : x.text), ['second', 'long']);
  eq(d.warnings.length, 1); eq(d.warnings[0].byName, `Name${ADMIN.slice(-3)}`);
  assert(e.db.moderation.audit.some((x) => x.action === 'note') && e.db.moderation.audit.some((x) => x.action === 'warn'), 'audited');
  // adjust refused while seated, and while watching
  e.mm.markHostPolled(SID);
  const c1 = e.mk(P1); e.seat(c1);
  r = await post(e, ck, `players/${P1}/adjust`, { level: 9 });
  eq([r.status, r.json.error, r.json.sessionId], [409, 'player-in-lobby', SID]);
  eq((await post(e, ck, `players/${P1}/reset-stats`, {})).status, 409);
  eq(db.appData[`${P1}/sostest`].version, 5, 'untouched');
  assert((await post(e, ck, 'spectate', { sessionId: SID, steamId: ADMIN2 })).status === 200);
  eq((await post(e, ck, `players/${ADMIN2}/adjust`, { level: 3 })).json.error, 'player-in-lobby');
  await post(e, ck, 'spectate/stop', { sessionId: SID, steamId: ADMIN2 });
  assert((await post(e, ck, 'kick', { sessionId: SID, playerId: P1, reason: 'kicked for test' })).status === 200);
  eq((await get(e, ck, `players/${P1}`)).json.kicks.length, 1);
  // adjust
  for (const [b, err] of [[{ level: 0 }, 'bad-level'], [{ level: 1.5 }, 'bad-level'], [{ level: '5' }, 'bad-level'], [{ levelProgress: 1 }, 'bad-levelProgress'],
    [{ levelProgress: -0.1 }, 'bad-levelProgress'], [{ ratings: { bogus: 1 } }, 'bad-rating-key'], [{ ratings: { toxicity: 'x' } }, 'bad-toxicity'], [{ ratings: [] }, 'bad-ratings'], [{ fame: { nope: 1 } }, 'bad-fame-key'], [{}, 'nothing-to-change']]) {
    r = await post(e, ck, `players/${P1}/adjust`, b); eq([r.status, r.json.error], [400, err], JSON.stringify(b));
  }
  eq(db.appData[`${P1}/sostest`].version, 5, 'failed edits changed nothing');
  r = await post(e, ck, `players/${P1}/adjust`, { level: 10, levelProgress: 0.25, ratings: { toxicity: 40, survivalSolo: 50, fameSolo: 60 } });
  assert(r.status === 200 && r.json.version === 6, r.text);
  const blob = db.appData[`${P1}/sostest`];
  eq(blob.version, 6);
  eq([blob.data.progression, blob.data.ratings.toxicity.rating, blob.data.ratings.soloRatings.survival.rating, blob.data.ratings.soloRatings.fame.rating], [{ level: 10, levelProgress: 0.25 }, 40, 50, 60]);
  eq(blob.data.permissions, { allowCheats: false }, 'rest of the blob kept');
  eq(db.heroStats[P1].soloFameRating, 60, 'Fame module source adjusted (it overwrites the blob rating on every read)');
  // what the game host reads on GET is what we set
  eq(fame.applyToBlob(P1, blob.data).ratings.soloRatings.fame.rating, 60);
  const ad = e.db.moderation.audit.filter((x) => x.action === 'adjust').pop();
  const det = JSON.parse(ad.detail);
  eq(ad.target, P1); eq(det.old.level, 4); eq(det.new.level, 10); eq(det.old['ratings.toxicity'], 33); eq(det.new['ratings.fameSolo'], 60); eq(det.old.fame.soloFameRating, 11);
  eq(r.json.profile.level, 10);
  // a player with no Fame stats: only the blob changes, no hero stats record is created
  r = await post(e, ck, `players/${P3}/adjust`, { ratings: { fameSolo: 7 } });
  eq(r.status, 200); eq(db.appData[`${P3}/sostest`].data.ratings.soloRatings.fame.rating, 7); eq(db.heroStats[P3], undefined);
  r = await post(e, ck, `players/${P3}/adjust`, { fame: { soloFameRating: 70, fameWins: 1, matches: 2 } });
  eq(r.status, 200); eq(db.heroStats[P3].soloFameRating, 70, 'explicit fame block creates the record');
  // reset-stats
  r = await post(e, ck, `players/${P1}/reset-stats`, {});
  assert(r.status === 200 && r.json.version === 7, r.text);
  const z = db.appData[`${P1}/sostest`].data;
  eq(z.progression, { level: 1, levelProgress: 0 });
  eq([z.stats.objectives.classic.totalGamesPlayed, z.stats.hero.totalLoveFeedbackReceived, z.badges.amusing, z.ratings.soloRatings.fame.rating, z.ratings.soloRatings.fame.matchesPlayed, z.ratings.toxicity.rating], [0, 0, 0, 0, 0, 0]);
  eq(z.ratings.soloRatings.fame.leaderboardId, 'fame_solo');
  eq(z.permissions, { allowCheats: false }); eq(z.social, { mutedPlayers: [] }, 'permissions and social kept');
  eq(db.playerStats[P1], undefined, 'db.playerStats cleared');
  eq(db.heroStats[P1].soloFameRating, 0); eq(db.heroStats[P1].fameWins, 0);
  eq(fame.applyToBlob(P1, z).ratings.soloRatings.fame.rating, 0, 'no stale Fame comes back through the blob');
  assert(JSON.parse(e.db.moderation.audit.filter((x) => x.action === 'reset-stats').pop().detail).old.progression.level === 10, 'reset audited with old level');
  eq((await post(e, ck, 'players/nobody/adjust', { level: 2 })).status, 404);
  // no blob yet: adjust creates one (version 2, like a first host write after the default version 1)
  r = await post(e, ck, `players/${P2}/adjust`, { level: 3 });
  eq([r.status, db.appData[`${P2}/sostest`].version], [200, 2]);
  // a mod may adjust too
  const mk = await addMod(e, ck);
  eq((await post(e, mk, `players/${P2}/adjust`, { level: 4 })).status, 200);
  eq((await post(e, mk, `players/${P2}/reset-stats`, {})).status, 200);
});

// ---- matches ----
test('matches: list with filters, detail with server and linked reports', async () => {
  const e = makeEnv();
  const ck = await newOwner(e);
  const t0 = Date.parse('2026-05-30T10:00:00Z');
  for (let i = 0; i < 5; i++) {
    e.db.matches.push({ id: `m${i}`, sessionId: i < 4 ? SID : 'other-session-1', startedAt: new Date(t0 + i * 3600e3).toISOString(), endedAt: new Date(t0 + i * 3600e3 + 600e3).toISOString(), durationSec: 600,
      players: [{ playerId: P1, kills: i, deaths: 1, damageDealt: 10 * i, survivalSec: 5, escaped: false }, ...(i % 2 ? [{ playerId: P2, kills: 9, name: 'Bob' }] : [])] });
  }
  let r = await get(e, ck, 'matches');
  eq(r.json.map((x) => x.id), ['m4', 'm3', 'm2', 'm1', 'm0']);
  eq(r.json[0], { id: 'm4', sessionId: 'other-session-1', server: null, startedAt: new Date(t0 + 4 * 3600e3).toISOString(), endedAt: new Date(t0 + 4 * 3600e3 + 600e3).toISOString(), durationSec: 600, players: 1, top: { kills: 4, name: `Name${P1.slice(-3)}`, playerId: P1 } });
  eq(r.json[1].server, 'T'); eq(r.json[1].top, { kills: 9, name: 'Bob', playerId: P2 }); eq(r.json[1].players, 2);
  eq((await get(e, ck, 'matches?limit=2')).json.map((x) => x.id), ['m4', 'm3']);
  eq((await get(e, ck, `matches?player=${P2}`)).json.map((x) => x.id), ['m3', 'm1']);
  eq((await get(e, ck, `matches?session=${SID}`)).json.map((x) => x.id), ['m3', 'm2', 'm1', 'm0']);
  eq((await get(e, ck, `matches?before=${encodeURIComponent(e.db.matches[2].endedAt)}`)).json.map((x) => x.id), ['m1', 'm0']);
  // detail + reports linking the match
  e.mod.handleReport({}, P2, JSON.stringify({ sessionId: SID }), 'tok-p1');
  await post(e, ck, 'reports/r1', { matchId: 'm3' });
  r = await get(e, ck, 'matches/m3');
  assert(r.status === 200 && r.json.id === 'm3' && r.json.server.name === 'T' && r.json.server.game === 'classic' && r.json.server.community === false, r.text);
  eq(r.json.reports.map((x) => x.id), ['r1']);
  eq(r.json.players[1].kills, 9); assert(r.json.players[0].damageDealt === 30, 'numeric fields kept');
  eq((await get(e, ck, 'matches/m0')).json.reports, []);
  eq((await get(e, ck, 'matches/m4')).json.server, null);
  eq((await get(e, ck, 'players/' + P2)).json.matches[0].matchId, 'm3');
  eq((await get(e, ck, 'players/' + P2)).json.matches[0].server, 'T');
});

// ---- reports workflow ----
test('reports: statuses, assignee, notes thread, filters, links; stored actioned/note migrate on load', async () => {
  const e = makeEnv();
  const ck = await newOwner(e);
  e.mod.handleReport({}, P2, JSON.stringify({ reason: 'cheat' }), 'tok-p1');
  e.mod.handleReport({}, P3, JSON.stringify({ reason: 'rude' }), 'tok-p1');
  let r = await get(e, ck, 'reports/r1');
  eq(r.json.report.notes, []); eq(r.json.report.assignee, null);
  eq(r.json.links, { match: null, target: P2, reporter: P1, spectate: { sessionId: null, live: false } });
  eq((await post(e, ck, 'reports/r1', { status: 'bogus' })).json.error, 'bad-status');
  eq((await post(e, ck, 'reports/r1', {})).status, 400);
  r = await post(e, ck, 'reports/r1', { status: 'investigating', assignee: 'me', note: 'looking' });
  assert(r.status === 200 && r.json.report.status === 'investigating' && r.json.report.assignee.id === ADMIN && r.json.report.notes.length === 1 && r.json.report.resolvedBy === null, r.text);
  eq(r.json.report.notes[0].by, ADMIN); eq(r.json.report.notes[0].text, 'looking'); assert(r.json.report.notes[0].at && r.json.report.notes[0].byName, 'note fields');
  eq((await get(e, ck, 'reports?status=investigating')).json.map((x) => x.id), ['r1']);
  eq((await get(e, ck, 'reports?status=all&assignee=me')).json.map((x) => x.id), ['r1']);
  eq((await get(e, ck, 'reports?status=all&assignee=none')).json.map((x) => x.id), ['r2']);
  eq((await get(e, ck, `reports?status=all&assignee=${ADMIN2}`)).json.length, 0);
  eq((await post(e, ck, 'reports/r1', { assignee: P1 })).json.error, 'bad-assignee');
  r = await post(e, ck, 'reports/r1', { assignee: ADMIN2 }); eq(r.json.report.assignee, { id: ADMIN2, name: `Name${ADMIN2.slice(-3)}` });
  r = await post(e, ck, 'reports/r1', { assignee: null }); eq(r.json.report.assignee, null);
  r = await post(e, ck, 'reports/r1', { status: 'dismissed', note: 'not enough' });
  eq([r.json.report.status, r.json.report.resolvedBy, r.json.report.notes.length], ['dismissed', ADMIN, 2]);
  r = await post(e, ck, 'reports/r1', { status: 'open' }); eq([r.json.report.resolvedBy, r.json.report.resolvedAt], [null, null]);
  r = await post(e, ck, 'reports/r2', { status: 'resolved' }); eq(r.json.report.status, 'resolved');
  eq((await get(e, ck, 'reports?status=resolved')).json.map((x) => x.id), ['r2']);
  const au = e.db.moderation.audit;
  const st = au.filter((x) => x.action === 'report-status').map((x) => x.detail);
  eq(st, ['open -> investigating', 'investigating -> dismissed', 'dismissed -> open', 'open -> resolved']);
  eq(au.filter((x) => x.action === 'report-assign').map((x) => x.detail), [`none -> ${ADMIN}`, `${ADMIN} -> ${ADMIN2}`, `${ADMIN2} -> none`]);
  eq(au.filter((x) => x.action === 'report-note').map((x) => x.detail), ['looking', 'not enough']);
  // links with a live session
  e.mm.markHostPolled(SID);
  const c1 = e.mk(P1); e.seat(c1);
  e.mod.handleReport({}, P2, JSON.stringify({ sessionId: SID }), 'tok-p1');
  await post(e, ck, `lobbies/${SID}/force-start`, {});
  eq((await get(e, ck, 'reports/r3')).json.links.spectate, { sessionId: SID, live: true });
  // migration: an old db with 'actioned' + a single note string
  const old = { accounts: {}, appData: {}, tokens: {}, matches: [], moderation: { reports: [
    { id: 'r1', at: '2026-01-01T00:00:00Z', status: 'actioned', reporter: { id: P1 }, target: { id: P2 }, resolvedBy: ADMIN, resolvedAt: '2026-01-02T00:00:00Z', note: 'banned them' },
    { id: 'r2', at: '2026-01-01T00:00:00Z', status: 'open', reporter: { id: P1 }, target: { id: P2 }, resolvedBy: null, resolvedAt: null, note: '' }], seq: 2 } };
  for (const id of [ADMIN, P1, P2]) old.accounts[id] = { id, 'display-name': `Name${id.slice(-3)}` };
  const e2 = makeEnv({ db: old });
  const ck2 = await login(e2);
  const [a, b] = old.moderation.reports;
  eq([a.status, a.assignee, a.notes.length, a.notes[0].text, a.notes[0].by, 'note' in a], ['resolved', null, 1, 'banned them', ADMIN, false]);
  eq([b.notes, b.assignee, 'note' in b], [[], null, false]);
  eq((await get(e2, ck2, 'reports?status=resolved')).json.map((x) => x.id), ['r1']);
});

// ---- KV overlay ----
function kvTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ogsos-kv-'));
  const src = path.join(__dirname, '..', 'data', 'kv-classic');
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(d, f));
  return d;
}
test('kv overlay: owner-only writes, allowlist, type checks, served with a new revision, clear restores, survives restart', async () => {
  const dir = kvTmp();
  const baseRev = Number(fs.readFileSync(path.join(dir, 'live-rev.txt'), 'utf8').trim());
  const baseFile = JSON.parse(fs.readFileSync(path.join(dir, `runtime-${baseRev}.json`), 'utf8'));
  const e = makeEnv({ modOpts: { kvDir: dir } });
  const ck = await newOwner(e);
  const mk = await addMod(e, ck);
  eq(e.mod.kvServe('live-rev.txt'), null, 'no overlay: the plain files are served by server.js');
  let r = await get(e, mk, 'kv');   // any admin can view
  assert(r.status === 200 && r.json.keys.length >= 5, r.text);
  const motd = r.json.keys.find((k) => k.key === 'UE_CLIENT_MOTD');
  eq([motd.base, motd.value, motd.overridden, motd.type], [baseFile.UE_CLIENT_MOTD, baseFile.UE_CLIENT_MOTD, false, 'string']);
  assert(motd.description, 'description');
  assert(!r.json.keys.some((k) => /TEST_SERVER_ENABLED|DIRECTOR|ROLES|ENDPOINT|URL/.test(k.key)), 'no gate/auth keys offered');
  // validation
  eq((await post(e, ck, 'kv', { key: 'UE_CLIENT_TEST_SERVER_ENABLED', value: false })).status, 400);
  eq((await post(e, ck, 'kv', { key: 'UE_CLIENT_DIRECTOR_USERS', value: ['x'] })).json.error, 'not-allowed');
  eq((await post(e, ck, 'kv', { key: 'NOPE', value: 1 })).json.error, 'not-allowed');
  eq((await post(e, ck, 'kv', { key: 'UE_CLIENT_MOTD', value: 5 })).json.error, 'bad-value');
  eq((await post(e, ck, 'kv', { key: 'UE_CLIENT_MOTD', value: 'x'.repeat(501) })).json.error, 'bad-value');
  eq((await post(e, ck, 'kv', { key: 'UE_CLIENT_DUOS_QUEUE_WARNING_TIME_SEC', value: '30' })).json.error, 'bad-value');
  eq((await post(e, ck, 'kv', { key: 'UE_CLIENT_DUOS_QUEUE_WARNING_TIME_SEC', value: 99999 })).json.error, 'bad-value');
  eq((await post(e, ck, 'kv', { key: 'UE_CLIENT_VOTING_ENABLED', value: 'yes' })).json.error, 'bad-value');
  eq((await post(e, ck, 'kv/UE_CLIENT_MOTD/clear', {})).json.error, 'not-overridden');
  eq((await post(e, ck, 'kv/UE_CLIENT_TEST_SERVER_ENABLED/clear', {})).json.error, 'not-allowed');
  // set
  r = await post(e, ck, 'kv', { key: 'UE_CLIENT_MOTD', value: 'Server maintenance at 20:00' });
  assert(r.status === 200 && r.json.servedRev === baseRev + 1, r.text);
  eq((await post(e, ck, 'kv', { key: 'UE_CLIENT_DUOS_QUEUE_WARNING_TIME_SEC', value: 90 })).json.servedRev, baseRev + 2);
  eq((await post(e, ck, 'kv', { key: 'UE_CLIENT_VOTING_ENABLED', value: true })).status, 200);
  eq(e.mod.kvServe('live-rev.txt'), { body: String(baseRev + 3), type: 'text/plain' }, 'a changed overlay is a NEW revision');
  for (const rel of [`runtime-${baseRev + 3}.json`, `runtime-${baseRev}.json`]) {   // the new name falls back to the base file; the old name is overlaid too
    const o = e.mod.kvServe(rel);
    const j = JSON.parse(o.body);
    eq([o.type, j.UE_CLIENT_MOTD, j.UE_CLIENT_DUOS_QUEUE_WARNING_TIME_SEC, j.UE_CLIENT_VOTING_ENABLED], ['application/json', 'Server maintenance at 20:00', 90, true], rel);
    eq(j.UE_CLIENT_TEST_SERVER_ENABLED, baseFile.UE_CLIENT_TEST_SERVER_ENABLED, 'other keys untouched');
    eq(Object.keys(j), Object.keys(baseFile), 'same keys, same order');
  }
  eq(e.mod.kvServe('runtime-999.json'), null, 'unknown file: fall through to the 404 in server.js');
  eq(e.mod.kvServe('../secret.txt'), null);
  r = await get(e, mk, 'kv');
  const m2 = r.json.keys.find((k) => k.key === 'UE_CLIENT_MOTD');
  eq([m2.value, m2.base, m2.overridden], ['Server maintenance at 20:00', baseFile.UE_CLIENT_MOTD, true]);
  eq(r.json.servedRev, baseRev + 3);
  // survives a restart (stored in the db, never in data/kv-classic)
  const e2 = makeEnv({ db: JSON.parse(JSON.stringify(e.db)), modOpts: { kvDir: dir } });
  eq(JSON.parse(e2.mod.kvServe(`runtime-${baseRev + 3}.json`).body).UE_CLIENT_MOTD, 'Server maintenance at 20:00');
  eq(fs.readFileSync(path.join(dir, 'live-rev.txt'), 'utf8').trim(), String(baseRev), 'base files untouched');
  // clear restores the base value under yet another revision
  r = await post(e, ck, 'kv/UE_CLIENT_MOTD/clear', {});
  assert(r.status === 200 && r.json.servedRev === baseRev + 4, r.text);
  eq(JSON.parse(e.mod.kvServe(`runtime-${baseRev + 4}.json`).body).UE_CLIENT_MOTD, baseFile.UE_CLIENT_MOTD);
  const au = e.db.moderation.audit.filter((x) => x.action.startsWith('kv-'));
  eq(au.map((x) => x.action), ['kv-set', 'kv-set', 'kv-set', 'kv-clear']);
  assert(au[0].detail.includes('->') && au[0].detail.includes('Server maintenance') && au[0].target === 'UE_CLIENT_MOTD', au[0].detail);
});

// ---- community hosts ----
test('community: list, block by id removes the host from the registry, block by ip, env bans kept, unblock', async () => {
  const e0 = makeMm();
  const reg = createCommunityRegistry({ mm: e0.mm, config: { probe: false, allowPrivate: false, bans: ['198.51.100.99'] } });
  const ENV_BANS = ['198.51.100.99'];
  const e = makeEnv({ mmx: e0, modOpts: { community: reg, onHostBlocksChanged: (vals) => { reg._cfg.bans = [...ENV_BANS, ...vals]; reg.sweep(); } } });
  const ck = await newOwner(e);
  let r = reg.register('203.0.113.10', { name: 'Cool Server', port: 7777 });
  assert(r.status === 200, JSON.stringify(r));
  const id = r.body.sessionId;
  const r2 = reg.register('203.0.113.11', { name: 'Other Server', port: 7777 });
  e0.mm.markHostPolled(id);
  r = await get(e, ck, 'community');
  eq(r.json.enabled, true);
  const h = r.json.hosts.find((x) => x.id === id);
  eq([h.name, h.ip, h.port, h.verified, h.listed, h.probe, h.online, h.state, h.players, h.maxPlayers, h.blocked], ['Cool Server', '203.0.113.10', 7777, false, true, 'off', true, 'waiting', 0, 8, false]);
  assert(h.registeredAt && typeof h.lastRenewSec === 'number', 'times');
  eq(r.json.hosts.find((x) => x.id === r2.body.sessionId).listed, false, 'not polled: not listed');
  eq(r.json.hosts.length, 2);
  // block by id: gone from the registry at once
  r = await post(e, ck, 'host-blocks', { value: id, reason: 'bad host' });
  eq(r.status, 200);
  assert(!reg._hosts.has(id), 'blocked host removed from the registry');
  assert(reg._hosts.has(r2.body.sessionId), 'the other host stays');
  assert(!e0.mm.listHosted().some((x) => x.id === id), 'and from the matchmaker');
  eq(reg._cfg.bans, ['198.51.100.99', id], 'env bans kept next to the panel blocks');
  // a blocked id cannot register again
  eq(reg.register('203.0.113.10', { name: 'Cool Server', port: 7777, sessionId: id, sessionToken: 'a'.repeat(40) }).status, 403);
  // block by ip
  r = await post(e, ck, 'host-blocks', { value: '203.0.113.11' });
  assert(!reg._hosts.has(r2.body.sessionId), 'ip block removes the other host');
  eq(reg.register('203.0.113.11', { name: 'Other Server', port: 7777 }).status, 403);
  eq(reg.register('198.51.100.99', { name: 'Env Banned', port: 7777 }).status, 403, 'env ban still applies');
  // unblock the ip -> can register again; the blocks list shows up in /bans
  const hb = e.db.moderation.hostBlocks.find((x) => x.value === '203.0.113.11');
  eq((await post(e, ck, `host-blocks/${hb.id}/lift`, {})).status, 200);
  eq(reg._cfg.bans, ['198.51.100.99', id]);
  eq(reg.register('203.0.113.11', { name: 'Other Server', port: 7777 }).status, 200);
  // blocked flag in the list for a still-registered host, with the block id for the unblock button
  const r3 = reg.register('203.0.113.12', { name: 'Third Server', port: 7777 });
  e.db.moderation.hostBlocks.push({ id: 'hX', value: r3.body.sessionId, kind: 'id', reason: '', by: ADMIN, at: '', lifted: false });
  const l = (await get(e, ck, 'community')).json.hosts.find((x) => x.id === r3.body.sessionId);
  eq([l.blocked, l.blockedBy.id], [true, 'hX']);
});

// ---- audit ----
test('audit: filters and CSV export with escaping and formula-injection protection', async () => {
  const e = makeEnv();
  const ck = await newOwner(e);
  const ck2 = await login(e, ADMIN2);
  await post(e, ck, `players/${P1}/notes`, { text: '=HYPERLINK("http://x","click"),a' });
  await post(e, ck, `players/${P2}/notes`, { text: '+1 plus' });
  await post(e, ck2, `players/${P1}/notes`, { text: 'line1\nline2 "q"' });
  await post(e, ck2, `players/${P3}/warn`, { reason: '-cmd' });
  await post(e, ck2, `players/${P3}/notes`, { text: '@sum' });
  await post(e, ck, `players/${P3}/notes`, { text: '\tTab' });
  eq((await get(e, ck, 'audit')).json.length, 8);   // 2 logins + 6 entries
  eq((await get(e, ck, `audit?by=${ADMIN2}`)).json.every((x) => x.by === ADMIN2), true);
  eq((await get(e, ck, `audit?action=note&target=${P1}`)).json.length, 2);
  eq((await get(e, ck, 'audit?action=warn')).json.map((x) => x.target), [P3]);
  eq((await get(e, ck, `audit?by=${ADMIN}&action=note&limit=1`)).json.length, 1);
  const all = (await get(e, ck, 'audit')).json;
  eq(all[0].action, 'note'); assert(all[0].at >= all[all.length - 1].at, 'newest first');
  const before = all[2].at;
  assert((await get(e, ck, `audit?before=${encodeURIComponent(before)}`)).json.every((x) => x.at < before), 'before filter');
  // csv
  const r = await api(e, ck, 'GET', `/admin/api/audit.csv?action=note`);
  eq(r.status, 200);
  eq(r.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert(/^attachment; filename="ogsos-audit-20260601\.csv"$/.test(r.headers['Content-Disposition']), r.headers['Content-Disposition']);
  const lines = r.text.split('\r\n');
  eq(lines[0], 'at,by,byName,action,target,detail,ip');   // owners get the ip column
  assert(r.text.includes(`,${P1},"'=HYPERLINK(""http://x"",""click""),a"`), 'quotes doubled, formula neutralised: ' + r.text);
  assert(r.text.includes(`,${P2},'+1 plus`), '+ prefixed');
  assert(r.text.includes(`"line1 line2 ""q"""`), 'newline flattened by the audit, quotes doubled: ' + r.text);
  assert(r.text.includes(`,${P3},'@sum`), '@ prefixed');
  const rows = lines.slice(1).filter(Boolean);
  eq(rows.length, 5);
  const w = await api(e, ck, 'GET', '/admin/api/audit.csv?action=warn');
  assert(w.text.includes(`,warn,${P3},'-cmd`), '- prefixed: ' + w.text);
  eq((await call(e.mod, 'GET', '/admin/api/audit.csv')).status, 401, 'needs a cookie');
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
