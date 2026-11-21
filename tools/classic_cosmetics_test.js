// Classic cosmetics unlock (docs/CLASSIC_CONTENT.md): a Classic login must carry the `alpha-beta`
// app role, the only AppRole on any Classic cosmetic, in both the JWT and the login reply's roles.
// The main (BR) login must not get it. Starts its own server. Run: node tools/classic_cosmetics_test.js
'use strict';
const net = require('net');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

async function main() {
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(REPO, 'server', 'server.js'), '--port', String(port)], { cwd: REPO, stdio: 'ignore' });
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/kv/live-rev.txt`)).status === 200) break; } catch { /* not up */ }
      if (server.exitCode !== null) throw new Error('server exited early');
      await sleep(250);
    }
    const login = async (appId, steamAppId, steamId) => (await fetch(`http://127.0.0.1:${port}/api/access-token/steam`, {
      method: 'POST', body: JSON.stringify({ 'steam-app-id': steamAppId, 'steam-id': steamId, 'session-auth-token': 'x', 'app-id': appId }),
    })).json();

    const c = await login('sostest', '802240', '76561190000000101');
    const cc = claims(c['access-token'] || c.token || c.jwt || Object.values(c).find((v) => typeof v === 'string' && v.split('.').length === 3));
    assert(cc.roles.includes('alpha-beta'), 'classic JWT roles lack alpha-beta: ' + cc.roles);
    assert(Array.isArray(c.roles) && c.roles.includes('alpha-beta'), 'classic login reply roles lack alpha-beta: ' + JSON.stringify(c.roles));
    for (const r of ['app-user', 'user', 'testserver']) assert(cc.roles.includes(r), 'classic lost role ' + r);
    console.log('PASS  classic login grants alpha-beta:', cc.roles.join(' '));

    const m = await login('sos', '619080', '76561190000000102');
    const mc = claims(m['access-token'] || m.token || m.jwt || Object.values(m).find((v) => typeof v === 'string' && v.split('.').length === 3));
    assert(!mc.roles.includes('alpha-beta'), 'main login got alpha-beta');
    console.log('PASS  main login unchanged:', mc.roles.join(' '));
  } finally {
    server.kill();
  }
}
main().catch((e) => { console.error('FAIL ', e.message); process.exitCode = 1; });
