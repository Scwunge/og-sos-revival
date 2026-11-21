// Moderation end-to-end over HTTP against a running backend (server/admin.js).
//   node tools/moderation_live_test.js [baseUrl]      (default http://127.0.0.1:7795)
// The backend must run on loopback with OGSOS_ADMINS=<admin steam id> and OGSOS_ADMIN_DEV_LOGIN=1, and a throwaway state dir
// (e.g. OGSOS_STATE_DIR / OGSOS_LOG_DIR in a temp folder), because this test bans and unbans test accounts.
// Optional: OGSOS_TEST_ADMIN (default 76561198000000001). Uses test Steam ids 765611980000009xx only.
'use strict';
const http = require('http');

const BASE = new URL(process.argv[2] || 'http://127.0.0.1:7795');
const ADMIN = process.env.OGSOS_TEST_ADMIN || '76561198000000001';
const REPORTER = '76561198000000901', TARGET = '76561198000000902', BLOCK_IP = '203.0.113.77';

function req(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (data !== null) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: BASE.hostname, port: BASE.port, path, method, headers: h }, (res) => {
      let s = ''; res.on('data', (d) => (s += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* text */ } resolve({ status: res.statusCode, headers: res.headers, body: j, text: s }); });
    });
    r.on('error', reject); r.end(data ?? undefined);
  });
}
const loginPlayer = (steamId) => req('POST', '/api/access-token/steam', { body: { 'steam-app-id': '1', 'steam-id': steamId, 'session-auth-token': 'x', roles: ['app-user'], 'app-id': 'sos' } });

let failed = 0, passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '-', e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  let cookie = '', jwt = '', jwtTarget = '';
  const A = (method, path, body, extra = {}) => req(method, path, { body, headers: { Cookie: cookie, 'X-OGSOS-Admin': '1', ...extra } });

  await check('players log in', async () => {
    const r = await loginPlayer(REPORTER); assert(r.status === 200 && r.body['access-token'], r.text); jwt = r.body['access-token'];
    const t = await loginPlayer(TARGET); assert(t.status === 200, t.text); jwtTarget = t.body['access-token'];
  });
  await check('report via the native route POST /api/account/<id>/report', async () => {
    const r = await req('POST', `/api/account/${TARGET}/report`, { body: { reason: 'cheating', comment: 'live test', evidence: 'https://example.com/clip' }, headers: { Authorization: `Token ${jwt}` } });
    assert(r.status === 200 && r.body.result === true && /^r\d+$/.test(r.body.data.id), r.status + r.text);
  });
  await check('native report without a token: 401; unknown target: 400', async () => {
    assert((await req('POST', `/api/account/${TARGET}/report`, { body: {} })).status === 401, 'expected 401');
    const r = await req('POST', `/api/account/${REPORTER}/report`, { body: {}, headers: { Authorization: `Token ${jwt}` } });
    assert(r.status === 400, 'reporting yourself: ' + r.status);
  });
  await check('POST /api/reports (mod/API route)', async () => {
    const r = await req('POST', '/api/reports', { body: { target: TARGET, reason: 'harassment', text: 'via api' }, headers: { Authorization: `Bearer ${jwt}` } });
    assert(r.status === 200 && r.body.data.result === true, r.status + r.text);
    assert((await req('POST', '/api/reports', { body: { target: TARGET } })).status === 401, 'no token 401');
  });

  await check('admin: 401 without a cookie, dev-login sets the cookie', async () => {
    assert((await req('GET', '/admin/api/me')).status === 401, 'expected 401');
    const r = await req('GET', `/admin/dev-login?steamid=${ADMIN}`);
    assert(r.status === 302 && r.headers['set-cookie'], 'dev-login ' + r.status + r.text);
    cookie = r.headers['set-cookie'][0].split(';')[0];
    assert(/HttpOnly/.test(r.headers['set-cookie'][0]), 'HttpOnly');
  });
  await check('/admin/api/me', async () => {
    const r = await A('GET', '/admin/api/me'); assert(r.status === 200 && r.body.steamId === ADMIN, r.text);
  });
  await check('cookie tampering refused', async () => {
    const v = cookie.split('=')[1];
    const [p, s] = v.split('.');
    const flipped = s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA');
    assert((await req('GET', '/admin/api/me', { headers: { Cookie: `ogsos_admin=${p}.${flipped}` } })).status === 401, 'bad signature');
    assert((await req('GET', '/admin/api/me', { headers: { Cookie: `ogsos_admin=${Buffer.from('{"sid":"1","exp":9999999999}').toString('base64url')}.${s}` } })).status === 401, 'forged payload');
  });
  await check('CSRF: POST without X-OGSOS-Admin is refused', async () => {
    const r = await req('POST', '/admin/api/bans', { body: { steamId: TARGET, reason: 'x' }, headers: { Cookie: cookie } });
    assert(r.status === 403, 'expected 403 got ' + r.status);
  });
  await check('players search finds the target', async () => {
    const r = await A('GET', `/admin/api/players?q=${TARGET}`);
    assert(r.status === 200 && r.body.length === 1 && r.body[0].id === TARGET && r.body[0].reportsAgainst >= 2 && r.body[0].banned === false, r.text);
    const d = await A('GET', `/admin/api/players/${TARGET}`); assert(d.status === 200 && d.body.reportsAgainst.length >= 2, d.text);
  });

  let rid;
  await check('reports list, detail, status change', async () => {
    const l = await A('GET', `/admin/api/reports?status=open&target=${TARGET}`);
    assert(l.status === 200 && l.body.length >= 2, l.text);
    rid = l.body[0].id;
    const d = await A('GET', `/admin/api/reports/${rid}`); assert(d.status === 200 && d.body.report.id === rid && d.body.target !== undefined, d.text);
    const u = await A('POST', `/admin/api/reports/${rid}`, { status: 'actioned', note: 'live test' });
    assert(u.status === 200 && u.body.report.status === 'actioned' && u.body.report.resolvedBy === ADMIN, u.text);
    const a = await A('GET', '/admin/api/reports?status=actioned'); assert(a.body.some((x) => x.id === rid), 'now actioned');
  });

  await check('ban -> login refused 403 -> lift -> login ok', async () => {
    const b = await A('POST', '/admin/api/bans', { steamId: TARGET, reason: 'live test', hours: 1 });
    assert(b.status === 200 && b.body.ban.steamId === TARGET, b.text);
    const l = await loginPlayer(TARGET);
    assert(l.status === 403 && l.body.error === 'banned' && l.body.reason === 'live test', 'login while banned: ' + l.status + l.text);
    const list = await A('GET', '/admin/api/bans'); assert(list.body.bans.some((x) => x.steamId === TARGET), 'listed');
    assert((await A('POST', '/admin/api/bans', { steamId: ADMIN, reason: 'x' })).status === 403, 'admin not bannable');
    const lift = await A('POST', `/admin/api/bans/${TARGET}/lift`, {}); assert(lift.status === 200, lift.text);
    const ok = await loginPlayer(TARGET); assert(ok.status === 200 && ok.body['access-token'], 'login after lift: ' + ok.status);
  });

  await check('host block add / list / lift', async () => {
    const a = await A('POST', '/admin/api/host-blocks', { value: BLOCK_IP, reason: 'live test' });
    assert(a.status === 200 && a.body.hostBlock.kind === 'ip', a.text);
    assert((await A('GET', '/admin/api/bans')).body.hostBlocks.some((h) => h.value === BLOCK_IP), 'listed');
    assert((await A('POST', '/admin/api/host-blocks', { value: 'not an ip' })).status === 400, 'bad value');
    const l = await A('POST', `/admin/api/host-blocks/${a.body.hostBlock.id}/lift`, {}); assert(l.status === 200, l.text);
    assert(!(await A('GET', '/admin/api/bans')).body.hostBlocks.some((h) => h.value === BLOCK_IP), 'gone after lift');
  });

  await check('servers endpoint has no tokens', async () => {
    const r = await A('GET', '/admin/api/servers');
    assert(r.status === 200 && Array.isArray(r.body.servers) && r.body.online && r.body.queue, r.text);
    assert(!/sessionToken|access-token|"token"/i.test(r.text), 'token-like field present');
  });

  await check('audit has the actions', async () => {
    const r = await A('GET', '/admin/api/audit?limit=100');
    const acts = r.body.map((x) => x.action);
    for (const want of ['login', 'report-status', 'ban', 'unban', 'host-block']) assert(acts.includes(want), `missing ${want} in ${acts.join()}`);
    assert(r.body[0].by === ADMIN && r.body[0].at, 'entry shape');
  });

  await check('static panel path and unsafe names', async () => {
    const r = await req('GET', '/admin/');
    assert(r.status === 200 || r.status === 404, 'index ' + r.status);
    assert((await req('GET', '/admin/..%2f..%2fserver.js')).status === 404, 'traversal 404');
    assert((await req('GET', '/admin/db.json')).status === 404, 'json not served');
  });

  await check('logout clears the cookie', async () => {
    const r = await req('GET', '/admin/logout', { headers: { Cookie: cookie } });
    assert(r.status === 302 && /Max-Age=0/.test(r.headers['set-cookie'][0]), 'cleared');
  });

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
