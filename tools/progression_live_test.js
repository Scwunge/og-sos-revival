// Progression end-to-end over HTTP against a running backend (docs/PROGRESSION.md, server/progression.js).
//   OGSOS_TEST_SESSION=<lobby sessionId> OGSOS_TEST_TOKEN=<its SESSION_TOKEN> node tools/progression_live_test.js <host> <port>
// Plays the game host's part (blob GET/POST with the session token, leaderboard POSTs, a DLL match-end) and a
// player's (login, blob read, leaderboard read). Uses test Steam ids 765611900000005xx only. Optional
// OGSOS_TEST_SEEDED=<accountId>:<version> checks that a blob written before the auth change still loads.
// The match-end POST ends that lobby (like a real match end), so run it on a test backend, not on prod.
'use strict';
const http = require('http');

const HOST = process.argv[2] || '127.0.0.1';
const PORT = Number(process.argv[3] || 7784);
const SID = process.env.OGSOS_TEST_SESSION;
const HTOK = process.env.OGSOS_TEST_TOKEN;
if (!SID || !HTOK) { console.error('Set OGSOS_TEST_SESSION and OGSOS_TEST_TOKEN (a configured lobby).'); process.exit(2); }

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { 'app-id': 'sostest' };
    if (token) headers.Authorization = `Token ${token}`;
    if (data !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: HOST, port: PORT, path, method, headers }, (res) => {
      let s = ''; res.on('data', (d) => (s += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* text */ } resolve({ status: res.statusCode, body: j, text: s }); });
    });
    r.on('error', reject); r.end(data ?? undefined);
  });
}
const login = async (steamId) => (await req('POST', '/api/access-token/steam',
  { 'steam-app-id': '802240', 'steam-id': steamId, 'session-auth-token': 'x', 'app-id': 'sostest' })).body['access-token'];

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '-', e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const A = '76561190000000501', B = '76561190000000502';
  const jwtA = await login(A); await login(B);
  const blob = `/api/account/${A}/app/sostest`;
  let v;

  await check('player reads a blob (version + object data)', async () => {
    const r = await req('GET', blob, undefined, jwtA);
    assert(r.status === 200 && Number.isInteger(r.body.version) && r.body.data && typeof r.body.data === 'object', r.status + r.text);
    v = r.body.version;
  });
  await check('no token: 401', async () => { assert((await req('GET', blob)).status === 401, 'expected 401'); });
  await check('player JWT cannot write a blob (host-only writes)', async () => {
    const r = await req('POST', blob, { version: v, data: { progression: { level: 99 } } }, jwtA);
    assert(r.status === 401, 'status ' + r.status);
  });
  await check('host writes with its session token; version bumps', async () => {
    const r = await req('POST', blob, { version: v, data: { version: 8, progression: { level: 2, levelProgress: 0.4167 } } }, HTOK);
    assert(r.status === 200 && r.body.version === v + 1, r.status + r.text);
  });
  await check('stale version: 409 with the stored blob (host merges and retries)', async () => {
    const r = await req('POST', blob, { version: v, data: { progression: { level: 1 } } }, HTOK);
    assert(r.status === 409 && r.body.version === v + 1 && r.body.data.progression.level === 2, r.status + r.text);
  });
  await check('host reads the saved blob', async () => {
    const r = await req('GET', blob, undefined, HTOK);
    assert(r.status === 200 && r.body.data.progression.level === 2, r.text);
  });
  if (process.env.OGSOS_TEST_SEEDED) {
    const [id, ver] = process.env.OGSOS_TEST_SEEDED.split(':');
    await check('a blob written before the auth change still loads', async () => {
      const r = await req('GET', `/api/account/${id}/app/sostest`, undefined, HTOK);
      assert(r.status === 200 && r.body.version === Number(ver) && Object.keys(r.body.data).length > 0, r.text);
    });
  }

  const board = `/api/leaderboard/sostest/survival_solo`;
  await check('leaderboard POST by a player: 401', async () => {
    assert((await req('POST', board, [{ member: A, score: 5 }], jwtA)).status === 401, 'expected 401');
  });
  await check('leaderboard POST by the host: ranked rows back', async () => {
    const r = await req('POST', board, [{ member: A, score: 1040 }, { member: B, score: 990 }], HTOK);
    assert(r.status === 200 && Array.isArray(r.body) && r.body.length === 2, r.text);
    const a = r.body.find((x) => x.member === A);
    assert(a && typeof a.rank === 'number' && a.score === 1040 && typeof a.uname === 'string', JSON.stringify(a));
  });
  await check('empty POST (nobody rated): 200 []', async () => {
    const r = await req('POST', '/api/leaderboard/sostest/fame_solo', [], HTOK);
    assert(r.status === 200 && Array.isArray(r.body) && r.body.length === 0, r.status + r.text);
  });
  await check('player reads the board: A above B, with names', async () => {
    const r = await req('GET', `${board}?start=0&limit=100`, undefined, jwtA);
    const ia = r.body.findIndex((x) => x.member === A), ib = r.body.findIndex((x) => x.member === B);
    assert(r.status === 200 && ia >= 0 && ib > ia, r.text);
  });
  await check('?surrounding around a member', async () => {
    const r = await req('GET', `${board}/${B}?surrounding=1`, undefined, jwtA);
    assert(r.status === 200 && r.body.some((x) => x.member === B), r.text);
  });

  await check('DLL match-end records stats for real accounts only', async () => {
    const before = (await req('GET', `/api/stats/player/${A}`)).body.matches || 0;
    const matchId = `live-test-${Date.now()}`;
    const ev = { type: 'match-end', matchId, reason: 'postgame', durationSec: 600,
      players: [{ playerId: A, kills: 2, escaped: true, placement: 1 }, { playerId: '76561190000000599', kills: 9 }] };
    const r = await req('POST', `/api/session/${SID}/events`, ev, HTOK);
    assert(r.status === 200, 'events ' + r.status + r.text);
    const st = (await req('GET', `/api/stats/player/${A}`)).body;
    assert(st.matches === before + 1 && st.escapes >= 1 && st.kills >= 2, JSON.stringify(st));
    const unknown = (await req('GET', '/api/stats/player/76561190000000599')).body;
    assert(!unknown.matches, 'stats recorded for an id without an account');
    const again = await req('POST', `/api/session/${SID}/events`, ev, HTOK);
    assert(again.status === 200 && (await req('GET', `/api/stats/player/${A}`)).body.matches === before + 1, 'duplicate counted');
    const recent = (await req('GET', '/api/stats/matches?limit=5')).body;
    assert(Array.isArray(recent) && recent[0].id === matchId, 'recent ' + JSON.stringify(recent[0]));
  });

  console.log(failed ? `${failed} FAILED` : 'ALL OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
