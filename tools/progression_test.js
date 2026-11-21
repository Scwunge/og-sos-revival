// Progression logic (server/progression.js) with a fake db and tokens, no network:  node tools/progression_test.js
'use strict';
const { createProgression } = require('../server/progression');

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '-', e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), `${m || ''} got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const A = '76561190000000001', B = '76561190000000002';
const HOST = 'hosttoken', JA = 'jwt-a', JB = 'jwt-b';
const mk = (o = {}) => {
  const db = o.db || {};
  const saves = { n: 0 };
  const p = createProgression({
    db, saveDb: () => { saves.n++; },
    displayName: (id) => 'N' + id.slice(-3),
    isHostToken: (t) => t === HOST,
    jwtAccount: (t) => ({ [JA]: A, [JB]: B })[t] || null,
    leaderboardOpen: false, ...o,
  });
  return { p, db, saves };
};
const post = (p, acct, data, tok = HOST, version) => p.handleAppData('POST', acct, 'sostest', JSON.stringify({ version, data }), tok);

check('GET empty blob', () => {
  const { p } = mk();
  const r = p.handleAppData('GET', A, 'sostest', '', HOST);
  assert(r.status === 200); eq(r.body, { version: 1, data: {} });
});
check('401 without token, other appId returns null', () => {
  const { p } = mk();
  assert(p.handleAppData('GET', A, 'sostest', '', null).status === 401);
  assert(p.handleAppData('GET', A, 'other', '', HOST) === null);
  assert(p.handleAppData('GET', 'bad id!', 'sostest', '', HOST).status === 400);
});
check('player can read others', () => {
  const { p } = mk();
  post(p, A, { x: 1 });
  eq(p.handleAppData('GET', A, 'sostest', '', JB).body.data, { x: 1 });
});
check('POST host-only by default', () => {
  const { p } = mk();
  const r = post(p, A, { x: 1 }, JA);
  assert(r.status === 401); eq(r.body, { version: 1, data: { error: 'unauthorized' } });
});
check('allowOwnerWrite: owner own only, host any', () => {
  const { p } = mk({ allowOwnerWrite: true });
  assert(post(p, A, { x: 1 }, JA).status === 200);
  assert(post(p, A, { x: 1 }, JB).status === 401);
  assert(post(p, B, { x: 1 }, HOST).status === 200);
});
check('version bump and saveDb', () => {
  const { p, saves } = mk();
  eq(post(p, A, { a: 1 }).body.version, 2);
  eq(post(p, A, { a: 2 }, HOST, 2).body.version, 3);
  assert(saves.n === 2);
});
check('409 on stale version with current body', () => {
  const { p } = mk();
  post(p, A, { a: 1 }); post(p, A, { a: 2 }, HOST, 2);
  const r = post(p, A, { a: 3 }, HOST, 1);
  assert(r.status === 409); eq(r.body, { version: 3, data: { a: 2 } });
});
check('413 oversize, 400 bad json / non-object data', () => {
  const { p } = mk();
  assert(p.handleAppData('POST', A, 'sostest', JSON.stringify({ data: { s: 'x'.repeat(300000) } }), HOST).status === 413);
  assert(p.handleAppData('POST', A, 'sostest', '{nope', HOST).status === 400);
  assert(p.handleAppData('POST', A, 'sostest', '{"data":[1]}', HOST).status === 400);
});
check('legacy body without data key', () => {
  const { p } = mk();
  const r = p.handleAppData('POST', A, 'sostest', JSON.stringify({ progression: { level: 2 } }), HOST);
  assert(r.status === 200); eq(r.body.data, { progression: { level: 2 } });
});
check('fame.applyToBlob applied on GET and POST; throwing fame is harmless', () => {
  const fame = { applyToBlob: (id, d) => ({ ...d, fameSeen: id }) };
  const { p } = mk({ fame });
  eq(post(p, A, { a: 1 }).body.data, { a: 1, fameSeen: A });
  eq(p.handleAppData('GET', A, 'sostest', '', HOST).body.data.fameSeen, A);
  const { p: q } = mk({ fame: { applyToBlob() { throw new Error('boom'); }, isFameBoard() { throw new Error('x'); } } });
  assert(post(q, A, { a: 1 }).status === 200);
  assert(q.handleAppData('GET', A, 'sostest', '', HOST).status === 200);
  assert(q.handleLeaderboard('GET', 'sostest', 'fame_solo', null, {}, '', JA).status === 200);
});

const lbPost = (p, board, arr, tok = HOST) => p.handleLeaderboard('POST', 'sostest', board, null, undefined, JSON.stringify(arr), tok);
check('leaderboard POST auth', () => {
  const { p } = mk();
  assert(lbPost(p, 'b1', [{ member: A, score: 1 }], JA).status === 401);
  assert(lbPost(p, 'b1', [{ member: A, score: 1 }]).status === 200);
  const { p: o } = mk({ leaderboardOpen: true });
  assert(lbPost(o, 'b1', [{ member: A, score: 1 }], JA).status === 200);
});
check('empty array POST is 200 [] and changes nothing; non-array is 400', () => {
  const { p, db, saves } = mk();
  const r = lbPost(p, 'b1', []);
  assert(r.status === 200); eq(r.body, []);
  assert(saves.n === 0 && !db.leaderboards['sostest/b1'], 'changed something');
  assert(lbPost(p, 'b1', { member: A, score: 1 }).status === 400);
  assert(lbPost(p, 'b1', [], JA).status === 401, 'auth still required');
});
check('upsert, ranks, uname, tie order, validation', () => {
  const { p } = mk();
  lbPost(p, 'trending_solo_2026_11_21', [{ member: A, score: 10 }, { member: B, score: 10.6 }]);
  const r = lbPost(p, 'trending_solo_2026_11_21', [{ member: A, score: 50 }, { member: 'bad id', score: 1 }, { member: B, score: 'x' }]);
  eq(r.body, [{ member: A, rank: 1, score: 50, uname: 'N001' }]);
  const g = p.handleLeaderboard('GET', 'sostest', 'trending_solo_2026_11_21', null, {}, '', JA).body;
  eq(g.map((x) => [x.member, x.rank, x.score]), [[A, 1, 50], [B, 2, 11]]);
  assert(lbPost(p, 'b', [{ member: 'bad id', score: 1 }]).status === 400);
  const big = lbPost(p, 'b', [{ member: A, score: 1e12 }]);
  assert(big.body[0].score === 1e9, 'clamp');
});
check('GET start/limit and rankBase', () => {
  const { p } = mk({ rankBase: 0 });
  const arr = []; for (let i = 0; i < 10; i++) arr.push({ member: 'm' + i, score: 100 - i });
  lbPost(p, 'b', arr);
  const g = p.handleLeaderboard('GET', 'sostest', 'b', null, { start: '2', limit: '3' }, '', JA).body;
  eq(g.map((x) => [x.member, x.rank]), [['m2', 2], ['m3', 3], ['m4', 4]]);
  eq(p.handleLeaderboard('GET', 'sostest', 'empty', null, {}, '', JA).body, []);
});
check('surrounding', () => {
  const { p } = mk();
  const arr = []; for (let i = 0; i < 10; i++) arr.push({ member: 'm' + i, score: 100 - i });
  lbPost(p, 'b', arr);
  const g = p.handleLeaderboard('GET', 'sostest', 'b', 'm5', { surrounding: '2' }, '', JA).body;
  eq(g.map((x) => x.member), ['m3', 'm4', 'm5', 'm6', 'm7']);
  eq(p.handleLeaderboard('GET', 'sostest', 'b', 'nobody', { surrounding: '2' }, '', JA).body, []);
  eq(p.handleLeaderboard('GET', 'sostest', 'b', 'm0', {}, '', JA).body.length, 1);
});
check('fame board delegation and fallback on []', () => {
  let mode = 'rows';
  const fame = {
    isFameBoard: (b) => b === 'fame_solo',
    fameLeaderboard: () => (mode === 'rows' ? [{ member: 'F', rank: 1, score: 9, uname: 'F' }] : []),
    fameAround: () => (mode === 'rows' ? [{ member: 'F', rank: 1, score: 9, uname: 'F' }] : []),
  };
  const { p } = mk({ fame });
  lbPost(p, 'fame_solo', [{ member: A, score: 5 }]);
  eq(p.handleLeaderboard('GET', 'sostest', 'fame_solo', null, {}, '', JA).body[0].member, 'F');
  eq(p.handleLeaderboard('GET', 'sostest', 'fame_solo', A, {}, '', JA).body[0].member, 'F');
  mode = 'empty';
  eq(p.handleLeaderboard('GET', 'sostest', 'fame_solo', null, {}, '', JA).body[0].member, A);
  eq(p.handleLeaderboard('GET', 'sostest', 'fame_solo', A, {}, '', JA).body[0].member, A);
});
check('board pruning, invalid board, methods', () => {
  let t = 1000;
  const { p, db } = mk({ now: () => (t += 1000) });
  for (let i = 0; i < 305; i++) lbPost(p, 'b' + i, [{ member: A, score: i }]);
  assert(Object.keys(db.leaderboards).length === 300, 'count');
  assert(!db.leaderboards['sostest/b0'] && db.leaderboards['sostest/b304'], 'oldest dropped');
  assert(p.handleLeaderboard('GET', 'sostest', 'bad/board', null, {}, '', JA).status === 400);
  assert(p.handleLeaderboard('DELETE', 'sostest', 'b1', null, {}, '', HOST).status === 405);
});

const S1 = '76561190000000011', S2 = '76561190000000012';
const payload = (extra = {}) => ({ type: 'match-end', matchId: 'm-1', startedAt: '2026-11-21T10:00:00Z', reason: 'postgame', durationSec: 1234, players: [
  { playerId: S1, name: 'One', kills: 2, deaths: 1, damageDealt: 350.5, escaped: true, placement: 2, survivalSec: 1100, relics: 1 },
  { playerId: S2, name: 'Two', kills: 1 }], ...extra });
check('match-end records, dedupes, saves once', () => {
  const { p, saves } = mk({ now: () => Date.parse('2026-11-21T11:00:00Z') });
  const r = p.recordMatchEnd('sess', payload());
  eq(r, { accepted: 2, duplicate: false, matchId: 'm-1' });
  assert(saves.n === 1);
  eq(p.recordMatchEnd('sess', payload()), { accepted: 0, duplicate: true, matchId: 'm-1' });
  assert(saves.n === 1 && p.recentMatches().length === 1);
  assert(p.matchById('m-1').sessionId === 'sess' && p.matchById('zz') === null);
});
check('matchId fallbacks', () => {
  const { p } = mk({ now: () => 5 });
  eq(p.recordMatchEnd('s', { startedAt: 'T', players: [] }).matchId, 's:T');
  eq(p.recordMatchEnd('s', { players: [] }).matchId, 's:5');
  assert(p.recordMatchEnd('s', { matchId: 'x'.repeat(100), players: [] }).matchId.length === 64);
});
check('seatedIds filter and invalid player ids', () => {
  const { p } = mk();
  const r = p.recordMatchEnd('s', payload({ players: [{ playerId: S1 }, { playerId: S2 }, { playerId: 'abc' }] }), new Set([S1]));
  assert(r.accepted === 1);
  assert(p.playerStats(S2) === null && p.playerStats(S1).matches === 1);
  assert(mk().p.recordMatchEnd('s2', payload({ matchId: 'q', players: [{ playerId: S1 }, { playerId: S2 }] }), []).accepted === 2, 'empty seated = no filter');
});
check('clamping and wrong types dropped', () => {
  const { p } = mk();
  p.recordMatchEnd('s', payload({ players: [{ playerId: S1, name: 'x'.repeat(50), kills: 9999, deaths: -5, damageDealt: 1e9, survivalSec: 99999, placement: 0, relics: 'a', fame: -1e9, teamId: 300, escaped: 'yes', aliveAtEnd: false, connected: true }] }));
  const pl = p.matchById('m-1').players[0];
  assert(pl.name.length === 32 && pl.kills === 200 && pl.deaths === 0 && pl.damageDealt === 1e6 && pl.survivalSec === 14400, JSON.stringify(pl));
  assert(pl.placement === 1 && pl.fame === -1e6 && pl.teamId === 255, JSON.stringify(pl));
  assert(!('relics' in pl) && !('escaped' in pl) && pl.aliveAtEnd === false && pl.connected === true, JSON.stringify(pl));
});
check('missing stats are not zero; totals accumulate over 2 matches', () => {
  const { p } = mk();
  p.recordMatchEnd('s', payload());
  let s = p.playerStats(S2);
  assert(s.matches === 1 && s.kills === 1 && s.deaths === 0 && s.escapes === 0 && s.bestPlacement === undefined, JSON.stringify(s));
  p.recordMatchEnd('s', payload({ matchId: 'm-2', players: [{ playerId: S1, kills: 3, escaped: true, placement: 1, relics: 2, survivalSec: 100, damageDealt: 10 }] }));
  s = p.playerStats(S1);
  assert(s.matches === 2 && s.escapes === 2 && s.kills === 5 && s.deaths === 1 && s.relics === 3 && s.totalSurvivalSec === 1200, JSON.stringify(s));
  assert(s.damageDealt === 360.5 && s.bestPlacement === 1 && s.lastMatchId === 'm-2', JSON.stringify(s));
  eq(p.recentMatches(1).map((m) => m.id), ['m-2']);
  eq(p.recentMatches().map((m) => m.id), ['m-2', 'm-1']);
});
check('fameForMatch stored; zero players still recorded; ring buffer cap 500', () => {
  const { p, db } = mk({ fame: { fameForMatch: (sid) => ({ sid }) } });
  assert(p.recordMatchEnd('s', { matchId: 'z', players: [] }).accepted === 0);
  eq(p.matchById('z').fame, { sid: 's' });
  for (let i = 0; i < 510; i++) p.recordMatchEnd('s', { matchId: 'k' + i, players: [] });
  assert(db.matches.length === 500 && p.matchById('z') === null && p.matchById('k509'), 'cap');
});

if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log('\nALL OK');
