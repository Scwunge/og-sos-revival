// Community host registration checks (server/community.js + the community parts of server/matchmaking.js and server.js).
//   node tools/community_test.js        (no setup: the HTTP part spawns its own backend on a free port and kills it)
// Unit tests use a fake clock and a fake UDP probe; the HTTP test registers a host, polls, lists, hints, seats and unregisters.
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createMatchmaker, DEFAULTS } = require('../server/matchmaking');
const { createCommunityRegistry, loadCommunityConfig } = require('../server/community');

const assert = require('assert');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POOL = { host: '127.0.0.1', port: 7777, sessionId: '11111111-0000-4000-8000-000000000001', sessionToken: 'a'.repeat(40), hostIds: [], name: 'Official 1' };

// ---------- harness ----------
// mmOver: matchmaker config overrides; cfgOver: registry config overrides.
function mkEnv({ pool = false, mmOver = {}, cfgOver = {} } = {}) {
  const clock = { t: Date.now() };
  const results = new Map();   // "host:port" -> bool (default true)
  const probes = [];
  const probe = async (h, p) => { probes.push(`${h}:${p}`); return results.has(`${h}:${p}`) ? results.get(`${h}:${p}`) : true; };
  const config = { ...DEFAULTS, START_COUNTDOWN_SECONDS: 0, TRAVEL_GRACE_SECONDS: 0, HOSTS: pool ? [POOL] : [], ...mmOver };
  const mm = createMatchmaker({ config });
  const reg = createCommunityRegistry({ mm, config: { allowPrivate: false, ...cfgOver }, now: () => clock.t, probe });
  const logs = [];
  return { clock, results, probes, mm, reg, config, logs, done: () => mm.shutdown() };
}
function client(id) {
  const c = { id, msgs: [], sendMsg(type, data) { c.msgs.push({ type, data }); }, close() {} };
  c.types = () => c.msgs.map((m) => m.type);
  c.last = (t) => [...c.msgs].reverse().find((m) => m.type === t);
  return c;
}
const body = (over = {}) => ({ name: 'Cool Server', port: 7777, ...over });
const PUB = '203.0.113.10', PUB2 = '198.51.100.20', PUB3 = '192.0.2.30';
const mark = (env, id) => { env.mm.markHostPolled(id); return env.reg.whenIdle(); };
// registered + polled + probed host that is listed
async function listed(env, ip = PUB, over = {}) {
  const r = env.reg.register(ip, body(over));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await mark(env, r.body.sessionId);
  assert.ok(env.reg.isListed(r.body.sessionId), 'host should be listed');
  return r.body;
}
function hintAndFind(env, c, id, { group = false } = {}) {
  assert.ok(!env.mm.setJoinHint(id, c.id).error);
  c.msgs.length = 0;
  env.mm.onMessage(c, JSON.stringify({ type: 'find-session', data: { opts: {} } }));
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------- registration ----------
test('register ok: id, 48-hex token, not listed yet, defaults', async () => {
  const env = mkEnv();
  const r = env.reg.register(PUB, body());
  assert.strictEqual(r.status, 200);
  assert.ok(UUID.test(r.body.sessionId));
  assert.ok(/^[0-9a-f]{48}$/.test(r.body.sessionToken));
  assert.deepStrictEqual([r.body.result, r.body.verified, r.body.listed, r.body.heartbeatSec, r.body.probe], [true, false, false, 30, 'pending']);
  assert.strictEqual(r.body.expireSec, 600); assert.strictEqual(r.body.firstPollSec, 600);
  assert.ok(env.mm.isCommunityHost(r.body.sessionId));
  assert.ok(env.mm.getHostedSession(r.body.sessionId).session['player-map']['0'], 'default hostIds ["0"] is in player-map');
  env.done();
});
test('renew keeps id and token; wrong token 401; other ip 403; host mismatch 400', async () => {
  const env = mkEnv();
  const a = env.reg.register(PUB, body()).body;
  const again = env.reg.register(PUB, body({ sessionId: a.sessionId, sessionToken: a.sessionToken, name: 'Renamed Server', maxPlayers: 8 }));
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.sessionId, a.sessionId); assert.strictEqual(again.body.sessionToken, a.sessionToken);
  const l = env.mm.listHosted().find((x) => x.id === a.sessionId);
  assert.strictEqual(l.name, 'Renamed Server'); assert.strictEqual(l.maxPlayers, 8);
  assert.strictEqual(env.reg.register(PUB, body({ sessionId: a.sessionId, sessionToken: 'f'.repeat(48) })).status, 401);
  const other = env.reg.register(PUB2, body({ sessionId: a.sessionId, sessionToken: a.sessionToken }));
  assert.deepStrictEqual([other.status, other.body.error], [403, 'ip-mismatch']);
  const mis = env.reg.register(PUB, body({ host: PUB2 }));
  assert.deepStrictEqual([mis.status, mis.body.error], [400, 'host-mismatch']);
  assert.strictEqual(env.reg.register(PUB, body({ host: PUB, port: 7800 })).status, 200, 'host equal to the source ip is fine');
  env.done();
});
test('same ip:port without credentials is 409 (no hijack)', async () => {
  const env = mkEnv();
  env.reg.register(PUB, body());
  const r = env.reg.register(PUB, body());
  assert.deepStrictEqual([r.status, r.body.error], [409, 'already-registered']);
  env.done();
});
test('private / loopback / CGNAT refused, allowed with ALLOW_PRIVATE', async () => {
  const env = mkEnv();
  for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.1.5', '172.20.0.1', '100.64.1.1', '169.254.1.1', '224.0.0.1', '0.1.2.3', '240.0.0.1', '::1']) {
    const r = env.reg.register(ip, body());
    assert.deepStrictEqual([r.status, r.body.error], [400, 'address-not-public'], ip);
  }
  env.done();
  const e2 = mkEnv({ cfgOver: { allowPrivate: true } });
  assert.strictEqual(e2.reg.register('192.168.1.5', body()).status, 200);
  e2.done();
});
test('bad port, bad name, official name (verified key allowed)', async () => {
  const env = mkEnv({ cfgOver: { keys: ['k-secret'], ratePerIp: 1000 } });
  const err = (b, code) => { const r = env.reg.register(PUB, b); assert.deepStrictEqual([r.status, r.body.error], [400, code], JSON.stringify(b)); };
  err(body({ port: 80 }), 'bad-port'); err(body({ port: 70000 }), 'bad-port'); err(body({ port: '7777' }), 'bad-port'); err(body({ port: 1023 }), 'bad-port');
  err(body({ name: '' }), 'bad-name'); err(body({ name: 'ab' }), 'bad-name'); err(body({ name: '   \u0001  ' }), 'bad-name'); err({ port: 7777 }, 'bad-name');
  err(body({ name: 'The OFFICIAL server' }), 'bad-name'); err(body({ name: 'my og   sos box' }), 'bad-name'); err(body({ name: 'OG SOS' }), 'bad-name');
  err(body({ maxPlayers: 1 }), 'bad-max-players'); err(body({ maxPlayers: 17 }), 'bad-max-players');
  err(body({ hostIds: ['abc'] }), 'bad-host-ids'); err(body({ hostIds: ['1', '2', '3', '4', '5'] }), 'bad-host-ids');
  const ok = env.reg.register(PUB, body({ name: '  Spaced    out   name ', hostIds: ['76561190000000000'] }));
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(env.mm.listHosted()[0].name, 'Spaced out name');
  const v = env.reg.register(PUB2, body({ name: 'Official Friend', key: 'k-secret' }));
  assert.strictEqual(v.status, 200); assert.strictEqual(v.body.verified, true);
  env.done();
});
test('per-IP cap (renewals do not count) and 409 on same port', async () => {
  const env = mkEnv({ cfgOver: { maxPerIp: 2, ratePerIp: 100 } });
  const a = env.reg.register(PUB, body({ port: 7001 })).body;
  assert.strictEqual(env.reg.register(PUB, body({ port: 7002 })).status, 200);
  const third = env.reg.register(PUB, body({ port: 7003 }));
  assert.strictEqual(third.status, 429); assert.strictEqual(third.body.error, 'too-many-for-ip');
  assert.strictEqual(env.reg.register(PUB, body({ port: 7001, sessionId: a.sessionId, sessionToken: a.sessionToken })).status, 200, 'renewal still fine at the cap');
  assert.strictEqual(env.reg.register(PUB2, body({ port: 7003 })).status, 200, 'other ip unaffected');
  env.done();
});
test('rate limit per ip per 10 minutes', async () => {
  const env = mkEnv({ cfgOver: { ratePerIp: 3, maxPerIp: 100 } });
  for (let i = 0; i < 3; i++) assert.strictEqual(env.reg.register(PUB, body({ port: 7000 + i })).status, 200);
  const r = env.reg.register(PUB, body({ port: 7100 }));
  assert.deepStrictEqual([r.status, r.body.error], [429, 'rate-limited']);
  assert.strictEqual(env.reg.register(PUB2, body()).status, 200, 'other ip');
  env.clock.t += 11 * 60 * 1000;
  assert.strictEqual(env.reg.register(PUB, body({ port: 7100 })).status, 200, 'window passed');
  env.done();
});
test('MAX_TOTAL', async () => {
  const env = mkEnv({ cfgOver: { maxTotal: 2 } });
  assert.strictEqual(env.reg.register(PUB, body()).status, 200);
  assert.strictEqual(env.reg.register(PUB2, body()).status, 200);
  const r = env.reg.register(PUB3, body());
  assert.strictEqual(r.status, 503); assert.strictEqual(r.body.error, 'registry-full');
  env.done();
});
test('bans: ip, CIDR, session id (and removal of an already registered host)', async () => {
  const env = mkEnv();
  const a = env.reg.register(PUB, body()).body, b = env.reg.register(PUB2, body()).body;
  env.reg._cfg.bans.push(PUB, '198.51.100.0/24');
  for (const ip of [PUB, PUB2, '198.51.100.99']) { const r = env.reg.register(ip, body({ port: 7900 })); assert.deepStrictEqual([r.status, r.body.error], [403, 'banned'], ip); }
  assert.strictEqual(env.reg.register(PUB3, body()).status, 200, 'unrelated ip fine');
  await env.reg.sweep();
  assert.strictEqual(env.mm.isCommunityHost(a.sessionId), null); assert.strictEqual(env.mm.isCommunityHost(b.sessionId), null);
  assert.strictEqual(env.reg.status(a.sessionId), null);
  // by id
  const e2 = mkEnv();
  const c = e2.reg.register(PUB, body()).body;
  e2.reg._cfg.bans.push(c.sessionId);
  const r = e2.reg.register(PUB, body({ sessionId: c.sessionId, sessionToken: c.sessionToken }));
  assert.deepStrictEqual([r.status, r.body.error], [403, 'banned']);
  await e2.reg.sweep();
  assert.strictEqual(e2.mm.isCommunityHost(c.sessionId), null);
  env.done(); e2.done();
});
test('kill switch: register 503 and every host removed at once', async () => {
  const env = mkEnv();
  const a = env.reg.register(PUB, body()).body;
  env.reg._cfg.enabled = false;
  const r = env.reg.register(PUB2, body());
  assert.deepStrictEqual([r.status, r.body.error], [503, 'disabled']);
  await env.reg.sweep();
  assert.strictEqual(env.mm.isCommunityHost(a.sessionId), null);
  assert.strictEqual(loadCommunityConfig({ OGSOS_COMMUNITY_ENABLED: '0' }).enabled, false);
  assert.strictEqual(loadCommunityConfig({}).enabled, true);
  env.done();
});
test('require-key: refused without a valid key, verified with one', async () => {
  const env = mkEnv({ cfgOver: { requireKey: true, keys: ['k1', 'k2'] } });
  assert.deepStrictEqual([env.reg.register(PUB, body()).status, env.reg.register(PUB, body({ key: 'nope' })).body.error], [403, 'key-required']);
  const ok = env.reg.register(PUB, body({ key: 'k2' }));
  assert.strictEqual(ok.status, 200); assert.strictEqual(ok.body.verified, true);
  assert.strictEqual(env.mm.listHosted()[0].verified, true);
  assert.strictEqual(env.reg.isVerifiedToken(ok.body.sessionToken), true);
  assert.strictEqual(env.reg.communityIdForToken(ok.body.sessionToken), ok.body.sessionId);
  assert.strictEqual(env.reg.isVerifiedToken('x'.repeat(48)), false);
  env.done();
  const e2 = mkEnv({ cfgOver: { keys: ['k1'] } });   // open registration: no key -> unverified, still accepted
  const u = e2.reg.register(PUB, body());
  assert.strictEqual(u.body.verified, false);
  assert.strictEqual(e2.reg.isVerifiedToken(u.body.sessionToken), false);
  assert.strictEqual(e2.reg.communityIdForToken(u.body.sessionToken), u.body.sessionId);
  assert.deepStrictEqual(e2.reg.communityInfo(u.body.sessionId), { community: true, verified: false, listed: false });
  assert.strictEqual(e2.reg.communityInfo('nope'), null);
  e2.done();
});

// ---------- listing, probe, expiry ----------
test('not listed before first poll; listed after poll + probe ok', async () => {
  const env = mkEnv();
  const r = env.reg.register(PUB, body()).body;
  await env.reg.whenIdle();
  assert.strictEqual(env.reg.isListed(r.sessionId), false, 'probe ok but never polled');
  assert.strictEqual(env.reg.status(r.sessionId).probe, 'ok');
  assert.strictEqual(env.reg.status(r.sessionId).lastSeenSec, null);
  env.mm.markHostPolled(r.sessionId);
  assert.strictEqual(env.reg.isListed(r.sessionId), true);
  assert.deepStrictEqual(env.reg.communityInfo(r.sessionId), { community: true, verified: false, listed: true });
  env.done();
});
test('status is flat and works for unlisted hosts', async () => {
  const env = mkEnv();
  const r = env.reg.register(PUB, body({ hostIds: ['5'] })).body;
  let s = env.reg.status(r.sessionId);
  assert.deepStrictEqual(Object.keys(s).sort(), ['id', 'lastSeenSec', 'listed', 'online', 'players', 'probe', 'state', 'verified']);
  assert.deepStrictEqual([s.id, s.listed, s.online, s.state, s.players, s.lastSeenSec, s.verified], [r.sessionId, false, false, 'waiting', 0, null, false]);
  await mark(env, r.sessionId);
  s = env.reg.status(r.sessionId);
  assert.deepStrictEqual([s.listed, s.online, s.probe, typeof s.lastSeenSec], [true, true, 'ok', 'number']);
  assert.strictEqual(env.reg.status('missing'), null);
  env.done();
});
test('probe fails -> unlisted, retried at most once per 60 s, relisted on success', async () => {
  const env = mkEnv({ cfgOver: { expireSec: 100000 } });   // the fake clock runs ahead of the matchmaker's real poll times
  env.results.set(`${PUB}:7777`, false);
  const r = env.reg.register(PUB, body()).body;
  await mark(env, r.sessionId);
  assert.strictEqual(env.reg.status(r.sessionId).probe, 'failed');
  assert.strictEqual(env.reg.isListed(r.sessionId), false);
  const n = env.probes.length;
  env.clock.t += 30000; await env.reg.sweep();
  assert.strictEqual(env.probes.length, n, 'no retry inside 60 s');
  env.results.set(`${PUB}:7777`, true);
  env.clock.t += 31000; await env.reg.sweep();
  assert.strictEqual(env.probes.length, n + 1);
  assert.strictEqual(env.reg.isListed(r.sessionId), true);
  // listed hosts are re-probed every 10 minutes; a failure unlists
  env.mm.markHostPolled(r.sessionId);
  env.results.set(`${PUB}:7777`, false);
  env.clock.t += 9 * 60000; env.mm.markHostPolled(r.sessionId); await env.reg.sweep();
  assert.strictEqual(env.reg.isListed(r.sessionId), true, 'not due yet');
  env.clock.t += 2 * 60000; env.mm.markHostPolled(r.sessionId); await env.reg.sweep();
  assert.strictEqual(env.reg.status(r.sessionId).probe, 'failed');
  assert.strictEqual(env.reg.isListed(r.sessionId), false);
  env.done();
});
test('probe disabled: listed after the first poll, probe "off"', async () => {
  const env = mkEnv({ cfgOver: { probe: false } });
  const r = env.reg.register(PUB, body());
  assert.strictEqual(r.body.probe, 'off');
  env.mm.markHostPolled(r.body.sessionId);
  assert.strictEqual(env.reg.isListed(r.body.sessionId), true);
  assert.strictEqual(env.probes.length, 0);
  env.done();
});
test('expiry: never polled -> removed after FIRST_POLL; polled hosts expire after EXPIRE; renewal postpones', async () => {
  const env = mkEnv({ cfgOver: { firstPollSec: 100 } });
  const a = env.reg.register(PUB, body()).body, b = env.reg.register(PUB2, body()).body;
  await mark(env, b.sessionId);
  env.clock.t += 101 * 1000; await env.reg.sweep();
  assert.strictEqual(env.mm.isCommunityHost(a.sessionId), null, 'never polled');
  assert.ok(env.mm.isCommunityHost(b.sessionId), 'b: last poll is "now" in real time');
  // b: pretend its last poll is old (clock far ahead), renew first
  env.clock.t += 3600 * 1000;
  env.reg.register(PUB2, body({ sessionId: b.sessionId, sessionToken: b.sessionToken }));
  await env.reg.sweep();
  assert.ok(env.mm.isCommunityHost(b.sessionId), 'renewal refreshed registeredAt');
  env.clock.t += 601 * 1000; await env.reg.sweep();
  assert.strictEqual(env.mm.isCommunityHost(b.sessionId), null, 'no poll and no renewal for EXPIRE seconds');
  env.done();
});
test('expiry releases seated players with session-closed', async () => {
  const env = mkEnv();
  const l = await listed(env);
  const c = client('p1');
  env.mm.onConnect(c);
  hintAndFind(env, c, l.sessionId);
  assert.ok(c.types().includes('session'), 'seated: ' + c.types());
  env.clock.t += 3600 * 1000; await env.reg.sweep();
  assert.strictEqual(env.mm.isCommunityHost(l.sessionId), null);
  assert.ok(c.types().includes('session-closed'), 'got ' + c.types());
  assert.strictEqual(env.mm._state.sessions.has(l.sessionId), false);
  assert.strictEqual(env.mm.listHosted().length, 0);
  // the closed lobby is gone: a stale hint is dropped and the next find-session does not fail
  env.mm.onClose(c);
  env.done();
});
test('unregister removes (token checked) and releases players', async () => {
  const env = mkEnv();
  const l = await listed(env);
  const c = client('p1'); env.mm.onConnect(c); hintAndFind(env, c, l.sessionId);
  assert.strictEqual(env.reg.unregister(l.sessionId, 'x'.repeat(48)).status, 401);
  assert.strictEqual(env.reg.unregister('nope', l.sessionToken).status, 404);
  const r = env.reg.unregister(l.sessionId, l.sessionToken);
  assert.deepStrictEqual([r.status, r.body.result, r.body.released], [200, true, 1]);
  assert.ok(c.types().includes('session-closed'));
  assert.strictEqual(env.reg.status(l.sessionId), null);
  env.done();
});

// ---------- matchmaking ----------
test('never auto-seated without a hint: no static pool', async () => {
  const env = mkEnv({ mmOver: { MIN_PLAYERS: 1, MATCH_BATCH_MS: 5 } });
  const l = await listed(env);
  const c = client('p1'); env.mm.onConnect(c);
  env.mm.onMessage(c, JSON.stringify({ type: 'find-session', data: { opts: {} } }));
  await wait(60);
  const s = c.last('session-started');
  assert.ok(s, 'player was matched somewhere: ' + c.types());
  assert.notStrictEqual(c.last('session').data.session.id, l.sessionId);
  assert.strictEqual(s.data.host, '127.0.0.1', 'default game server, not the community host');
  assert.strictEqual(env.mm.listHosted()[0].players, 0);
  env.done();
});
test('never auto-seated without a hint: static pool present', async () => {
  const env = mkEnv({ pool: true, mmOver: { PUBLIC_HOST: '203.0.113.7' } });
  env.mm.markHostPolled(POOL.sessionId);
  const l = await listed(env);
  const c = client('p1'); env.mm.onConnect(c);
  env.mm.onMessage(c, JSON.stringify({ type: 'find-session', data: { opts: {} } }));
  assert.strictEqual(c.last('session').data.session.id, POOL.sessionId, 'pool lobby, not the community one');
  assert.strictEqual(env.mm.listHosted().find((x) => x.id === l.sessionId).players, 0);
  env.done();
});
for (const withPool of [false, true]) {
  test(`join hint seats into the community lobby, address is the host's own despite PUBLIC_HOST (pool=${withPool})`, async () => {
    const env = mkEnv({ pool: withPool, mmOver: { PUBLIC_HOST: '203.0.113.7' } });
    if (withPool) env.mm.markHostPolled(POOL.sessionId);
    const l = await listed(env, PUB, { port: 7788 });
    const c = client('p1'); env.mm.onConnect(c);
    hintAndFind(env, c, l.sessionId);
    const sess = c.last('session').data.session;
    assert.deepStrictEqual([sess.id, sess.host, sess.port], [l.sessionId, PUB, 7788]);
    const st = c.last('session-started');
    assert.ok(st, 'START_COUNTDOWN 0 starts at once: ' + c.types());
    assert.deepStrictEqual([st.data.host, st.data.port], [PUB, 7788]);
    // the host's own view and the list entry
    assert.strictEqual(env.mm.getHostedSession(l.sessionId).session.host, PUB);
    const ent = env.mm.listHosted().find((x) => x.id === l.sessionId);
    assert.deepStrictEqual([ent.publicHost, ent.community, ent.verified, ent.players], ['', true, false, 1]);
    // a pool listing still shows the pool's public host
    if (withPool) assert.strictEqual(env.mm.listHosted().find((x) => x.id === POOL.sessionId).publicHost, '203.0.113.7');
    env.done();
  });
}
test('join hint works for a group too', async () => {
  const env = mkEnv();
  const l = await listed(env);
  const a = client('a'), b = client('b'); env.mm.onConnect(a); env.mm.onConnect(b);
  env.mm.onMessage(a, JSON.stringify({ type: 'create-group', data: {} }));
  const gid = a.last('group').data.group.id;
  env.mm.onMessage(b, JSON.stringify({ type: 'join-group', data: { 'group-id': gid } }));
  env.mm.setJoinHint(l.sessionId, 'a');
  env.mm.onMessage(a, JSON.stringify({ type: 'group-find-session', data: {} }));
  assert.strictEqual(a.last('session').data.session.id, l.sessionId);
  assert.strictEqual(b.last('session').data.session.id, l.sessionId);
  env.done();
});
test('per-host maxPlayers: listing, session opts, full lobby falls back and drops the hint', async () => {
  const env = mkEnv({ mmOver: { MIN_PLAYERS: 1, MATCH_BATCH_MS: 5 } });
  const l = await listed(env, PUB, { maxPlayers: 2 });
  assert.strictEqual(env.mm.listHosted()[0].maxPlayers, 2);
  const ps = ['p1', 'p2', 'p3'].map((id) => { const c = client(id); env.mm.onConnect(c); return c; });
  hintAndFind(env, ps[0], l.sessionId); hintAndFind(env, ps[1], l.sessionId);
  assert.strictEqual(ps[0].last('session').data.session.opts['max-players'], 2);
  assert.strictEqual(env.mm.listHosted()[0].players, 2);
  // join-session respects the cap
  env.mm.onMessage(ps[2], JSON.stringify({ type: 'join-session', data: { 'session-id': l.sessionId } }));
  assert.strictEqual(ps[2].last('nak').data.error, 'other');
  // hinted find-session into the full lobby: normal behaviour (a new generic session), hint dropped
  assert.ok(!env.mm.setJoinHint(l.sessionId, 'p3').error);
  env.mm.onMessage(ps[2], JSON.stringify({ type: 'find-session', data: { opts: {} } }));
  await wait(60);
  assert.notStrictEqual(ps[2].last('session').data.session.id, l.sessionId);
  assert.strictEqual(env.mm.listHosted()[0].players, 2);
  assert.strictEqual(env.mm._state.sessions.get(l.sessionId).players.size, 2);
  env.done();
});
test('maxPlayers is clamped to the matchmaker MAX_PLAYERS; registry cap applies', async () => {
  const env = mkEnv({ mmOver: { MAX_PLAYERS: 6 }, cfgOver: { maxPlayers: 6 } });
  const r = env.reg.register(PUB, body()).body;
  assert.strictEqual(env.mm.listHosted()[0].maxPlayers, 6);
  assert.strictEqual(env.reg.register(PUB2, body({ maxPlayers: 7 })).status, 400);
  assert.strictEqual(env.mm.addCommunityHost({ host: PUB3, port: 7777, sessionId: crypto.randomUUID(), sessionToken: 'a'.repeat(48), hostIds: [], name: 'x', maxPlayers: 99 }) !== undefined, true);
  assert.strictEqual(env.mm.listHosted().find((x) => x.host === PUB3).maxPlayers, 6);
  assert.throws(() => env.mm.addCommunityHost({ host: PUB3, port: 7777, sessionId: r.sessionId, sessionToken: 'a'.repeat(48) }));
  env.done();
});
test('a hint for an unlisted/offline community host is refused by setJoinHint (offline)', async () => {
  const env = mkEnv();
  const r = env.reg.register(PUB, body()).body;
  assert.strictEqual(env.mm.setJoinHint(r.sessionId, 'p1').error, 'offline');
  env.done();
});
test('removeCommunityHost only touches community hosts and clears hints', async () => {
  const env = mkEnv({ pool: true });
  assert.strictEqual(env.mm.removeCommunityHost(POOL.sessionId), null);
  assert.ok(env.mm.getHostedSession(POOL.sessionId));
  const l = await listed(env);
  env.mm.setJoinHint(l.sessionId, 'p1');
  assert.strictEqual(env.mm.removeCommunityHost(l.sessionId, 'test'), 0);
  assert.strictEqual(env.mm.getHostedSession(l.sessionId), null);
  assert.strictEqual(env.mm.lastPollOf(l.sessionId), null);
  env.done();
});

// ---------- restart re-claim ----------
test('re-claim after a backend restart keeps id and token', async () => {
  const e1 = mkEnv();
  const a = e1.reg.register(PUB, body()).body;
  e1.done();
  const e2 = mkEnv();   // fresh matchmaker + registry = restarted backend
  const r = e2.reg.register(PUB, body({ sessionId: a.sessionId, sessionToken: a.sessionToken }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.sessionId, a.sessionId); assert.strictEqual(r.body.sessionToken, a.sessionToken);
  assert.ok(e2.mm.isCommunityHost(a.sessionId));
  assert.strictEqual(e2.mm.getHostedSession(a.sessionId).token, a.sessionToken);
  assert.strictEqual(e2.reg.communityIdForToken(a.sessionToken), a.sessionId);
  // known id, wrong token stays 401; known id from another ip stays 403
  assert.strictEqual(e2.reg.register(PUB, body({ sessionId: a.sessionId, sessionToken: 'e'.repeat(48) })).status, 401);
  assert.strictEqual(e2.reg.register(PUB2, body({ sessionId: a.sessionId, sessionToken: a.sessionToken })).body.error, 'ip-mismatch');
  e2.done();
});
test('re-claim runs the normal checks (bans, name, address, caps)', async () => {
  const id = crypto.randomUUID(), tok = 'ab'.repeat(24);
  const env = mkEnv({ cfgOver: { maxPerIp: 1, bans: [id] } });
  let r = env.reg.register(PUB, body({ sessionId: id, sessionToken: tok }));
  assert.deepStrictEqual([r.status, r.body.error], [403, 'banned']);
  env.reg._cfg.bans.length = 0;
  r = env.reg.register(PUB, body({ sessionId: id, sessionToken: tok, name: 'x' }));
  assert.strictEqual(r.body.error, 'bad-name');
  r = env.reg.register('10.0.0.1', body({ sessionId: id, sessionToken: tok }));
  assert.strictEqual(r.body.error, 'address-not-public');
  assert.strictEqual(env.reg.register(PUB, body({ sessionId: id, sessionToken: tok })).status, 200);
  assert.strictEqual(env.reg.register(PUB, body({ port: 7900, sessionId: crypto.randomUUID(), sessionToken: tok })).body.error, 'too-many-for-ip');
  env.done();
});
test('re-claim is refused for a static pool host id (and malformed ids/tokens just register fresh)', async () => {
  const env = mkEnv({ pool: true });
  const r = env.reg.register(PUB, body({ sessionId: POOL.sessionId, sessionToken: POOL.sessionToken }));
  assert.deepStrictEqual([r.status, r.body.error], [409, 'id-in-use']);
  assert.strictEqual(env.mm.isCommunityHost(POOL.sessionId), null);
  assert.strictEqual(env.mm.getHostedSession(POOL.sessionId).token, POOL.sessionToken, 'pool host untouched');
  const odd = env.reg.register(PUB, body({ sessionId: 'not-a-uuid', sessionToken: 'zz' }));
  assert.strictEqual(odd.status, 200);
  assert.ok(UUID.test(odd.body.sessionId) && odd.body.sessionId !== 'not-a-uuid');
  const short = env.reg.register(PUB, body({ port: 7801, sessionId: crypto.randomUUID(), sessionToken: 'abc' }));
  assert.strictEqual(short.status, 200); assert.notStrictEqual(short.body.sessionToken, 'abc');
  env.done();
});

// ---------- HTTP ----------
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function httpTest(PORT) {
  const HOST = '127.0.0.1';
  const req = (method, p, b, headers = {}) => new Promise((resolve, reject) => {
    const data = b === undefined ? '' : typeof b === 'string' ? b : JSON.stringify(b);
    const r = http.request({ host: HOST, port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'app-id': 'sostest', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* not json */ } resolve({ status: res.statusCode, json: j, text: s }); });
    });
    r.on('error', reject); r.end(data);
  });
  class Ws {
    static connect(token) {
      return new Promise((resolve) => {
        const sock = net.connect(PORT, HOST);
        const ws = new Ws(sock);
        sock.write(`GET /ws HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: wss,ws\r\n` +
          `Authorization: Token ${token}\r\napp-id: sostest\r\n\r\n`);
        ws.onHandshake = (status) => resolve({ ws, status });
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
        this.buf = this.buf.subarray(i + 4); this.shook = true;
        this.onHandshake(Number(head.split('\r\n')[0].split(' ')[1]));
      }
      while (this.buf.length >= 2) {
        const opcode = this.buf[0] & 0x0f;
        let len = this.buf[1] & 0x7f, off = 2;
        if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
        if (this.buf.length < off + len) return;
        const payload = this.buf.subarray(off, off + len);
        this.buf = this.buf.subarray(off + len);
        if (opcode === 1) { this.msgs.push(JSON.parse(payload.toString())); for (const w of this.waiters.slice()) w(); }
      }
    }
    send(type, data) {
      const payload = Buffer.from(JSON.stringify(data === undefined ? { type } : { type, data }));
      const mask = crypto.randomBytes(4), len = payload.length;
      const head = len < 126 ? Buffer.from([0x81, 0x80 | len]) : Buffer.from([0x81, 0x80 | 126, len >> 8, len & 255]);
      this.sock.write(Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]));
    }
    next(type, ms = 5000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          while (this.msgs.length) {
            const m = this.msgs.shift();
            if (m.type === type) { cleanup(); return resolve(m); }
            if (m.type === 'summary' || m.type === 'player-leave' || m.type === 'player-join') continue;
            cleanup(); return reject(new Error(`expected "${type}" but got ${JSON.stringify(m)}`));
          }
        };
        const t = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for "${type}"`)); }, ms);
        const cleanup = () => { clearTimeout(t); this.waiters = this.waiters.filter((w) => w !== check); };
        this.waiters.push(check); check();
      });
    }
    close() { try { this.sock.destroy(); } catch { /* gone */ } }
  }
  return { req, Ws, HOST };
}

async function runHttp() {
  const PORT = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogsos_community_'));
  const OFFICIAL = { host: '203.0.113.50', port: 7777, sessionId: '11111111-0000-4000-8000-0000000000aa', sessionToken: 'official-token-1', hostIds: [], name: 'Official lobby' };
  const env = {
    ...process.env, OGSOS_STATE_DIR: dir, OGSOS_LOG_DIR: dir, OGSOS_COMMUNITY_ALLOW_PRIVATE: '1', OGSOS_COMMUNITY_PROBE: '0',
    OGSOS_CLASSIC_HOSTS: JSON.stringify([OFFICIAL]), OGSOS_CLASSIC_PUBLIC_HOST: '203.0.113.7', OGSOS_CLASSIC_START_COUNTDOWN_SECONDS: '0',
  };
  delete env.OGSOS_COMMUNITY_KEYS; delete env.OGSOS_COMMUNITY_REQUIRE_KEY; delete env.OGSOS_COMMUNITY_BANS; delete env.OGSOS_PUBLIC_BACKEND; delete env.OGSOS_DIRECTORY;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js'), '--port', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
  const { req, Ws } = httpTest(PORT);
  let w = null;
  try {
    for (let i = 0; i < 80; i++) { try { await req('GET', '/servers'); break; } catch { await wait(100); } }
    // register (source ip is loopback, allowed by ALLOW_PRIVATE)
    let r = await req('POST', '/api/community/register', { name: 'HTTP Community', region: 'EU', port: 7790 });
    assert.strictEqual(r.status, 200, r.text);
    const { sessionId: id, sessionToken: tok } = r.json;
    assert.ok(UUID.test(id) && /^[0-9a-f]{48}$/.test(tok)); assert.strictEqual(r.json.probe, 'off'); assert.strictEqual(r.json.listed, false);
    assert.strictEqual((await req('POST', '/api/community/register', { name: 'x', host: '8.8.8.8' })).json.error, 'host-mismatch');
    assert.strictEqual((await req('POST', '/api/community/register', 'not json')).status, 400);
    assert.strictEqual((await req('POST', '/api/community/register', JSON.stringify({ name: 'A'.repeat(5000) }))).status, 413);
    // before the first poll: not in /servers, join-hint refused (unlisted), status says so
    let list = (await req('GET', '/servers')).json.servers;
    assert.ok(!list.find((x) => x.id === id), 'unlisted before the first poll');
    let st = await req('GET', `/api/community/status/${id}`);
    assert.deepStrictEqual([st.status, st.json.listed, st.json.online, st.json.lastSeenSec, st.json.state, st.json.players, st.json.probe], [200, false, false, null, 'waiting', 0, 'off']);
    assert.strictEqual((await req('GET', '/api/community/status/nope')).status, 404);
    const login = await req('POST', '/api/access-token/steam', { 'steam-app-id': '802240', 'steam-id': '76561190000000123', 'session-auth-token': 'x', 'app-id': 'sostest' });
    const jwt = login.json['access-token'];
    const hint = (t) => req('POST', `/api/servers/${id}/join-hint`, '', { Authorization: `Bearer ${t}` });
    let h = await hint(jwt);
    assert.deepStrictEqual([h.status, h.json.error], [409, 'unlisted']);
    // the game polls with the host token
    assert.strictEqual((await req('GET', `/api/session/${id}`, undefined, { Authorization: `Token ${tok}` })).status, 200, 'host poll');
    assert.strictEqual((await req('GET', `/api/session/${id}`, undefined, { Authorization: 'Token nope' })).status, 401);
    list = (await req('GET', '/servers')).json.servers;
    const mine = list.find((x) => x.id === id);
    assert.ok(mine, 'listed after the poll');
    assert.deepStrictEqual([mine.community, mine.verified, mine.game, mine.name, mine.region, mine.address, mine.online, mine.maxPlayers], [true, false, 'classic', 'HTTP Community', 'EU', '127.0.0.1:7790', true, 16]);
    assert.ok(list.findIndex((x) => x.id === OFFICIAL.sessionId) < list.findIndex((x) => x.id === id), 'official entries first');
    assert.strictEqual(list.find((x) => x.id === OFFICIAL.sessionId).community, false);
    assert.ok(!JSON.stringify(list).includes(tok), 'token never in the list');
    st = await req('GET', `/api/community/status/${id}`);
    assert.deepStrictEqual([st.json.listed, st.json.online, st.json.verified], [true, true, false]);
    // player: join hint, then find-session seats in the community lobby with the host's own address
    h = await hint(jwt);
    assert.strictEqual(h.status, 200, h.text);
    assert.strictEqual((await req('POST', `/api/servers/${id}/join-hint`, '', {})).status, 401);
    const conn = await Ws.connect(jwt); assert.strictEqual(conn.status, 101); w = conn.ws;
    await w.next('ready');
    w.send('find-session', { opts: { language: 'en', map: '', 'game-mode': '', 'auto-group': false, regions: { NA: { ping: 1 } }, 'user-data': {} } });
    await w.next('ack');
    const sess = await w.next('session');
    assert.deepStrictEqual([sess.data.session.id, sess.data.session.host, sess.data.session.port], [id, '127.0.0.1', 7790]);
    const started = await w.next('session-started');
    assert.deepStrictEqual([started.data.host, started.data.port], ['127.0.0.1', 7790]);
    // progression safety: an unverified community token can read blobs but not write them or post scores
    const acct = '76561190000000123';
    const w1 = await req('POST', `/api/account/${acct}/app/sostest`, { data: { xp: 999999 } }, { Authorization: `Token ${tok}` });
    assert.strictEqual(w1.status, 401, 'blob write: ' + w1.text);
    assert.strictEqual((await req('GET', `/api/account/${acct}/app/sostest`, undefined, { Authorization: `Token ${tok}` })).status, 200, 'blob read allowed');
    assert.strictEqual((await req('GET', `/api/account/${acct}/app/sostest`, undefined, {})).status, 401, 'no token still 401');
    assert.strictEqual((await req('POST', '/api/leaderboard/sostest/xp', [{ member: acct, score: 5 }], { Authorization: `Token ${tok}` })).status, 401, 'leaderboard post');
    // the official host token still writes
    assert.strictEqual((await req('POST', `/api/account/${acct}/app/sostest`, { data: { xp: 1 } }, { Authorization: `Token ${OFFICIAL.sessionToken}` })).status, 200, 'official host write');
    // unverified match-end still ends the session but records nothing
    const ev = await req('POST', `/api/session/${id}/events`, { type: 'match-end', matchId: 'm1', players: [{ playerId: acct, kills: 3 }] }, { Authorization: `Token ${tok}` });
    assert.strictEqual(ev.status, 200);
    await w.next('session-closed');
    assert.strictEqual((await req('GET', '/api/stats/matches')).json.length, 0, 'no stats from an unverified host');
    // renewal over HTTP, then unregister
    r = await req('POST', '/api/community/register', { name: 'HTTP Community', region: 'EU', port: 7790, sessionId: id, sessionToken: tok });
    assert.deepStrictEqual([r.status, r.json.sessionId, r.json.sessionToken], [200, id, tok]);
    assert.strictEqual((await req('POST', '/api/community/unregister', { sessionId: id }, { Authorization: 'Token wrong' })).status, 401);
    r = await req('POST', '/api/community/unregister', { sessionId: id }, { Authorization: `Token ${tok}` });
    assert.strictEqual(r.status, 200, r.text);
    list = (await req('GET', '/servers')).json.servers;
    assert.ok(!list.find((x) => x.id === id), 'gone from /servers after unregister');
    assert.strictEqual((await req('GET', `/api/session/${id}`, undefined, { Authorization: `Token ${tok}` })).status, 404);
    assert.strictEqual((await req('GET', `/api/community/status/${id}`)).status, 404);
  } catch (e) {
    console.log('--- backend output ---\n' + out.split('\n').slice(-40).join('\n'));
    throw e;
  } finally {
    if (w) w.close();
    srv.kill();
  }
}
test('HTTP: register, poll, list, hint, seat, progression safety, unregister (spawned backend)', runHttp);

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); }
    catch (e) { failed++; console.log(`FAIL  ${name}\n      ${(e && e.stack ? e.stack : e).toString().split('\n').slice(0, 6).join('\n      ')}`); }
  }
  console.log(failed ? `\n${failed} FAILED of ${tests.length}` : `\nALL OK (${tests.length})`);
  process.exit(failed ? 1 : 0);
})();
