// Test for host_classic.js --backend (remote) mode: starts server/server.js with a fixed hosted session, then runs
// host_classic.js --dry-run against it (probe ok, wrong token, wrong SteamID). Run: node tools/host_classic_remote_test.js
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const STEAM = '76561190000000001';
const SESSION = { sessionId: '11111111-2222-3333-4444-555555555555', sessionToken: 'test-token-aaaaaaaaaaaaaaaaaaaaaaaa' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(want) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => resolve(p)); }); });
    s.listen(want, '0.0.0.0', () => s.close(() => resolve(want)));
  });
}

function runHost(args) {
  return spawnSync(process.execPath, [path.join(REPO, 'tools', 'host_classic.js'), ...args], { cwd: REPO, encoding: 'utf8', timeout: 30000 });
}

async function main() {
  const port = await freePort(7799);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc_remote_'));
  const win64 = path.join(tmp, 'Win64'); fs.mkdirSync(win64);
  const ini = path.join(tmp, 'Engine.ini'); fs.writeFileSync(ini, '[Test]\r\nA=1\r\n');
  const exe = path.join(tmp, 'dummy.exe'); fs.writeFileSync(exe, '');
  const hosts = [{ host: '127.0.0.1', port: 7777, ...SESSION, hostIds: [STEAM] }];
  const server = spawn(process.execPath, [path.join(REPO, 'server', 'server.js'), '--port', String(port)], {
    cwd: REPO, env: { ...process.env, OGSOS_CLASSIC_HOSTS: JSON.stringify(hosts) }, stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/kv/live-rev.txt`)).status === 200) break; } catch { /* not up */ }
      if (server.exitCode !== null) throw new Error('server exited early');
      await sleep(250);
    }
    const base = (id, token, steam) => ['--dry-run', '--backend', `127.0.0.1:${port}`, '--session-id', id, '--session-token', token, '--steam-id', steam,
      '--win64', win64, '--game', tmp, '--engine-ini', ini, '--exe', exe];

    let r = runHost(base(SESSION.sessionId, SESSION.sessionToken, STEAM));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert(/REMOTE CHECK OK/.test(r.stdout), 'probe passes');
    assert(/REMOTE backend/.test(r.stdout) && !/spawn|server\.js/.test(r.stdout.split('\n').filter((l) => /^1\./.test(l)).join('')), 'remote plan, no local server');
    assert(!r.stdout.includes(SESSION.sessionToken), 'token redacted in the plan');
    assert(r.stdout.includes(`--server 127.0.0.1:${port}`), 'launcher points at the remote backend');
    console.log('ok  remote probe passes, token redacted, launcher targets backend');

    r = runHost(base(SESSION.sessionId, 'wrong-token-bbbbbbbbbbbbbbbbbbbbbbbb', STEAM));
    assert.notStrictEqual(r.status, 0);
    assert(/session token does not match the backend/.test(r.stderr), r.stderr);
    console.log('ok  wrong token -> "session token does not match the backend"');

    r = runHost(base(SESSION.sessionId, SESSION.sessionToken, '76561190000000002'));
    assert.notStrictEqual(r.status, 0);
    assert(/hostIds/.test(r.stderr) && r.stderr.includes('76561190000000002'), r.stderr);
    console.log('ok  wrong steam id -> hostIds message naming the SteamID');

    r = runHost(['--dry-run', '--backend', `127.0.0.1:${port}`, '--steam-id', STEAM, '--win64', win64, '--game', tmp, '--engine-ini', ini, '--exe', exe]);
    assert.notStrictEqual(r.status, 0);
    assert(/needs a session id and token/.test(r.stderr), r.stderr);
    console.log('ok  missing session id/token rejected in remote mode');
    console.log('ALL OK');
  } finally {
    try { server.kill(); } catch { /* gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
main().then(() => process.exit(0), (e) => { console.error('FAIL:', e.message); process.exit(1); });
