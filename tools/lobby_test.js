// Lobby / match lifecycle test for hosted sessions (docs/CLASSIC.md "Lobby and match lifecycle").
//   node tools/lobby_test.js        (standalone: drives createMatchmaker with fake clients, no server needed)
'use strict';
const { createMatchmaker, makeSessionJwt, readSessionJwt } = require('../server/matchmaking');

const SID = '11111111-2222-3333-4444-555555555555';
const ENTRY = { host: '127.0.0.1', port: 7777, sessionId: SID, sessionToken: 'lobby-test-token', hostIds: ['host1'], name: 'T', region: '' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const origLog = console.log; console.log = () => {};   // matchmaker chatter
function make(over = {}) {
  const config = {
    MIN_PLAYERS: 1, MAX_PLAYERS: 4, QUEUE_TIMEOUT: 20, MATCH_BATCH_MS: 5, LATE_JOIN_SECONDS: 300, GROUP_MAX_SIZE: 8,
    START_MIN_PLAYERS: 2, START_COUNTDOWN_SECONDS: 0.3, START_FULL_COUNTDOWN_SECONDS: 0.05,
    VOTE_START_MIN_PLAYERS: 2, VOTE_START_COUNTDOWN_SECONDS: 0.05, EMPTY_END_SECONDS: 120, TRAVEL_GRACE_SECONDS: 5,
    GAME_SERVER_HOST: '127.0.0.1', GAME_SERVER_PORT: 7777, PUBLIC_HOST: '', BEACON_URL: '', REGION_NAME: 'local',
    HOSTS: [ENTRY], ...over,
  };
  const mm = createMatchmaker({ config });
  const mk = (id) => {
    const c = { id, connId: id, msgs: [], sendMsg(type, data) { this.msgs.push({ type, data }); }, close() {} };
    c.has = (type) => c.msgs.some((m) => m.type === type);
    mm.onConnect(c);
    return c;
  };
  const find = (c) => mm.onMessage(c, JSON.stringify({ type: 'find-session', data: { opts: {} } }));
  const info = () => mm.listHosted()[0];
  return { mm, mk, find, info };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('auto-start at min after countdown', async () => {
  const { mm, mk, find, info } = make();
  const a = mk('a'), b = mk('b');
  find(a);
  assert(info().state === 'waiting' && info().countdownEndsAt === null, 'one player: waiting');
  find(b);
  assert(info().state === 'countdown' && info().countdownEndsAt > Date.now(), 'countdown at min');
  assert(!a.has('session-started'), 'not started yet');
  await sleep(450);
  assert(info().state === 'started' && a.has('session-started') && b.has('session-started'), 'started');
  assert(info().lateJoinOpen === true, 'late join open');
  mm.shutdown();
});

test('countdown cancelled when a player leaves', async () => {
  const { mm, mk, find, info } = make();
  const a = mk('a'), b = mk('b');
  find(a); find(b);
  assert(info().state === 'countdown');
  mm.onMessage(b, JSON.stringify({ type: 'leave-session', data: {} }));
  assert(info().state === 'waiting' && info().countdownEndsAt === null, 'back to waiting');
  await sleep(400);
  assert(info().state === 'waiting' && !a.has('session-started'), 'never started');
  mm.shutdown();
});

test('full server shortens the countdown', async () => {
  const { mm, mk, find, info } = make({ START_COUNTDOWN_SECONDS: 30 });
  const cs = ['a', 'b', 'c', 'd'].map(mk);
  find(cs[0]); find(cs[1]);
  assert(info().countdownEndsAt - Date.now() > 20000, 'long countdown running');
  find(cs[2]);
  assert(info().countdownEndsAt - Date.now() > 20000, 'not yet full');
  find(cs[3]);
  assert(info().countdownEndsAt - Date.now() <= 100, 'shortened');
  await sleep(150);
  assert(info().state === 'started' && cs.every((c) => c.has('session-started')), 'started with all four');
  mm.shutdown();
});

test('joiner during the countdown gets the same match', async () => {
  const { mm, mk, find, info } = make();
  const a = mk('a'), b = mk('b'), c = mk('c');
  find(a); find(b);
  const ends = info().countdownEndsAt;
  find(c);
  assert(info().players === 3 && info().countdownEndsAt === ends, 'same countdown, three seated');
  await sleep(450);
  const ids = [a, b, c].map((x) => x.msgs.find((m) => m.type === 'session-started').data.id);
  assert(new Set(ids).size === 1 && ids[0] === SID, 'same session id');
  mm.shutdown();
});

test('vote-start: 2 of 3 starts, 1 of 3 does not, outsiders rejected', async () => {
  const { mm, mk, find, info } = make({ START_MIN_PLAYERS: 4, START_COUNTDOWN_SECONDS: 30 });
  const cs = ['a', 'b', 'c'].map(mk), out = mk('out');
  cs.forEach(find);
  assert(info().state === 'waiting');
  let r = mm.voteStartHosted(SID, 'a');
  assert(r.votes === 1 && r.needed === 2 && r.players === 3 && r.state === 'waiting', JSON.stringify(r));
  assert(mm.voteStartHosted(SID, 'a').votes === 1, 'a vote counts once');
  assert(mm.voteStartHosted(SID, 'out').error === 'not-seated', 'not seated');
  assert(mm.voteStartHosted('nope-x', 'a').error === 'not-found');
  assert(info().votes === 1 && info().state === 'waiting', 'listHosted votes');
  r = mm.voteStartHosted(SID, 'b');
  assert(r.state === 'countdown' && r.votes === 2, JSON.stringify(r));
  await sleep(150);
  assert(info().state === 'started' && cs.every((c) => c.has('session-started')), 'started by vote');
  assert(mm.voteStartHosted(SID, 'c').error === 'closed', 'closed after start');
  assert(!out.has('session-started'));
  mm.shutdown();
});

test('vote is dropped when the voter leaves; needs VOTE_START_MIN_PLAYERS', async () => {
  const { mm, mk, find, info } = make({ START_MIN_PLAYERS: 4, START_COUNTDOWN_SECONDS: 30 });
  const a = mk('a'), b = mk('b'), c = mk('c');
  find(a);
  mm.voteStartHosted(SID, 'a');
  assert(info().state === 'waiting', 'one player cannot vote-start');
  find(b); find(c);
  mm.voteStartHosted(SID, 'a');
  assert(info().votes === 1);
  mm.onMessage(a, JSON.stringify({ type: 'leave-session', data: {} }));
  assert(info().votes === 0, 'vote cleared');
  mm.shutdown();
});

test('vote-start over the WebSocket message', async () => {
  const { mm, mk, find, info } = make({ START_MIN_PLAYERS: 4, START_COUNTDOWN_SECONDS: 30 });
  const a = mk('a'), b = mk('b');
  find(a); find(b);
  mm.onMessage(a, JSON.stringify({ type: 'vote-start', data: {} }));
  mm.onMessage(b, JSON.stringify({ type: 'vote-start', data: {} }));
  assert(info().state === 'countdown' && a.has('ack'), 'ws vote counted');
  mm.shutdown();
});

test('session JWT verification', async () => {
  const jwt = makeSessionJwt(ENTRY, 'p1');
  assert(readSessionJwt(ENTRY, jwt) === 'p1', 'valid');
  assert(readSessionJwt({ ...ENTRY, sessionToken: 'other' }, jwt) === null, 'wrong key');
  assert(readSessionJwt({ ...ENTRY, sessionId: 'x-y' }, jwt) === null, 'wrong session');
  assert(readSessionJwt(ENTRY, jwt.slice(0, -2) + 'xx') === null, 'tampered');
  assert(readSessionJwt(ENTRY, 'garbage') === null);
});

test('late join refused after LATE_JOIN_SECONDS, seated after reset', async () => {
  const { mm, mk, find, info } = make({ LATE_JOIN_SECONDS: 0.3, START_MIN_PLAYERS: 1, START_COUNTDOWN_SECONDS: 0 });
  const a = mk('a'), late = mk('late');
  find(a);
  assert(info().state === 'started' && info().lateJoinOpen === true);
  await sleep(400);
  assert(info().lateJoinOpen === false, 'window closed');
  find(late);
  assert(info().players === 1, 'late player not seated');
  assert(late.msgs.some((m) => m.type === 'summary' && m.data.players.waiting === 1), 'got the waiting summary');
  assert(!late.has('session'), 'no session sent');
  mm.resetHosted(SID);
  assert(info().players === 1 && late.has('session'), 'seated into the fresh lobby');
  mm.shutdown();
});

test('LATE_JOIN_SECONDS 0 never, -1 always', async () => {
  let t = make({ LATE_JOIN_SECONDS: 0, START_MIN_PLAYERS: 1, START_COUNTDOWN_SECONDS: 0 });
  t.find(t.mk('a'));
  assert(t.info().lateJoinOpen === false, '0 = never');
  t.mm.shutdown();
  t = make({ LATE_JOIN_SECONDS: -1, START_MIN_PLAYERS: 1, START_COUNTDOWN_SECONDS: 0 });
  t.find(t.mk('a'));
  await sleep(50);
  assert(t.info().lateJoinOpen === true, '-1 = always');
  t.mm.shutdown();
});

test('seated player keeps seat on reconnect within the travel grace', async () => {
  const { mm, mk, find, info } = make({ LATE_JOIN_SECONDS: 0, START_MIN_PLAYERS: 1, START_COUNTDOWN_SECONDS: 0 });
  const a = mk('a');
  find(a);
  mm.onClose(a);
  assert(info().players === 1, 'held');
  mk('a');
  assert(info().players === 1, 'still seated');
  mm.shutdown();
});

test('end clears seats; state stays ended (no seating) until reset', async () => {
  const { mm, mk, find, info } = make({ START_MIN_PLAYERS: 1, START_COUNTDOWN_SECONDS: 0 });
  const a = mk('a'), b = mk('b');
  find(a); find(b);
  assert(info().state === 'started');
  assert(mm.endHosted(SID) === 2);
  assert(info().state === 'ended' && info().players === 0 && info().endedAt, 'ended');
  assert(a.has('session-closed') && b.has('session-closed'), 'players told');
  const c = mk('c');
  find(c);
  assert(info().players === 0 && !c.has('session'), 'ended session refuses seats');
  mm.resetHosted(SID);
  assert(info().players === 1 && c.has('session'), 'queued player seated after reset');
  assert(info().endedAt === null);
  mm.shutdown();
});

test('auto end when a started session stays empty', async () => {
  const { mm, mk, find, info } = make({ START_MIN_PLAYERS: 1, START_COUNTDOWN_SECONDS: 0, EMPTY_END_SECONDS: 0.2, TRAVEL_GRACE_SECONDS: 0 });
  const a = mk('a');
  find(a);
  assert(info().state === 'started');
  mm.onClose(a);   // grace 0: seat removed at once
  assert(info().players === 0 && info().state === 'started');
  await sleep(300);
  assert(info().state === 'ended', 'auto ended');
  mm.resetHosted(SID);
  assert(info().state === 'waiting' && info().votes === 0 && info().startedAt === null, 'reset to waiting');
  mm.shutdown();
});

test('reset clears countdown, votes and seats', async () => {
  const { mm, mk, find, info } = make({ START_MIN_PLAYERS: 2, START_COUNTDOWN_SECONDS: 30 });
  const a = mk('a'), b = mk('b');
  find(a); find(b);
  mm.voteStartHosted(SID, 'a');
  assert(info().state === 'countdown' && info().votes === 1);
  mm.resetHosted(SID);
  assert(info().state === 'waiting' && info().players === 0 && info().votes === 0 && info().countdownEndsAt === null, 'cleared');
  assert(a.has('session-closed'));
  mm.shutdown();
});

test('pool: joins the fullest open lobby', async () => {
  const E2 = { ...ENTRY, port: 7778, sessionId: '22222222-2222-3333-4444-555555555555', sessionToken: 'tok2' };
  const { mm, mk, find } = make({ HOSTS: [ENTRY, E2], START_MIN_PLAYERS: 3, START_COUNTDOWN_SECONDS: 30 });
  const cs = ['a', 'b', 'c'].map(mk);
  find(cs[0]); find(cs[1]); find(cs[2]);
  const l = mm.listHosted();
  assert(l[0].players === 3 && l[1].players === 0, JSON.stringify(l.map((x) => x.players)));
  mm.shutdown();
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); origLog(`PASS  ${name}`); } catch (e) { failed++; origLog(`FAIL  ${name}: ${e.message}`); }
  }
  console.log = origLog;
  if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
  console.log('ALL OK');
  process.exit(0);
})();
