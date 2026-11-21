// Client mod update route (GET /mod/...), no setup:  node tools/mod_route_test.js
// Spawns a backend on a free port with OGSOS_MOD_DIR in a temp folder, checks that the fixed names are served byte for
// byte, that a missing manifest is 404, that traversal never leaks a file, then runs tools/smoke_test.js against it with
// OGSOS_SMOKE_MOD=present and =absent.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ogsos-mod-'));
const modDir = path.join(tmp, 'mod');
fs.mkdirSync(modDir);
const SENTINEL = 'SENTINEL-' + Date.now();
fs.writeFileSync(path.join(tmp, 'secret.txt'), SENTINEL);
fs.writeFileSync(path.join(modDir, 'secret.txt'), SENTINEL);   // in the dir but not an allowed name
const manifest = Buffer.from(JSON.stringify({ version: 1, core: 'core-1.dll', sha256: 'x' }));
const dll = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4, 0xff]);
fs.writeFileSync(path.join(modDir, 'manifest.json'), manifest);
fs.writeFileSync(path.join(modDir, 'manifest.sig'), 'sig');
fs.writeFileSync(path.join(modDir, 'core-1.dll'), dll);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
function raw(port, p) {   // raw request line, so "../" reaches the server unnormalized
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1'); const c = [];
    s.on('data', (d) => c.push(d)); s.on('end', () => { const t = Buffer.concat(c).toString('latin1'); resolve({ status: Number(t.split(' ')[1]), text: t }); });
    s.on('error', () => resolve({ status: 0, text: '' }));
    s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  });
}
function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c), headers: res.headers })); }).on('error', reject);
  });
}

(async () => {
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js'), '--port', String(port)], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, OGSOS_MOD_DIR: modDir, OGSOS_STATE_DIR: path.join(tmp, 'state'), OGSOS_LOG_DIR: path.join(tmp, 'logs'), OGSOS_PERSONA_DISABLE: '1', OGSOS_CLASSIC_HOSTS: '', OGSOS_HOSTS: '' },
  });
  try {
    for (let i = 0; i < 50; i++) { try { await get(port, '/servers?local=1'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const m = await get(port, '/mod/manifest.json');
    ok(m.status === 200 && m.body.equals(manifest) && m.headers['cache-control'] === 'no-store', 'manifest.json served as is, no-store');
    ok((await get(port, '/mod/manifest.sig')).body.toString() === 'sig', 'manifest.sig served');
    const d = await get(port, '/mod/core-1.dll');
    ok(d.status === 200 && d.body.equals(dll) && d.headers['content-type'] === 'application/octet-stream', 'core-1.dll served byte for byte');
    ok((await get(port, '/mod/core-2.dll')).status === 404, 'missing core-2.dll is 404');
    ok((await get(port, '/mod/secret.txt')).status === 404, 'other names in the mod dir are 404');
    let leaked = false;
    for (const p of ['/mod/../secret.txt', '/mod/..%2Fsecret.txt', '/mod/%2e%2e/secret.txt', '/mod/%2e%2e%2fsecret.txt', '/mod/..%5Csecret.txt',
      '/mod/core-1.dll/../../secret.txt', '/mod//secret.txt', '/mod/manifest.json%00', '/mod/./manifest.json/../secret.txt']) {
      const r = await raw(port, p);
      if (r.text.includes(SENTINEL)) { leaked = true; console.log('  leaked via ' + p); }
    }
    ok(!leaked, 'traversal attempts never return a file outside the allowed names');
    const smoke = (mode) => spawnSync(process.execPath, [path.join(__dirname, 'smoke_test.js'), '127.0.0.1', String(port), '0'], { env: { ...process.env, OGSOS_SMOKE_MOD: mode, OGSOS_SMOKE_ADMIN_COOKIE: '' }, encoding: 'utf8' });
    let s = smoke('present');
    ok(s.status === 0 && /manifest\.json is 200/.test(s.stdout), 'smoke_test passes with OGSOS_SMOKE_MOD=present');
    if (s.status !== 0) console.log(s.stdout + s.stderr);
    ok(smoke('absent').status !== 0, 'smoke_test fails with OGSOS_SMOKE_MOD=absent while the manifest exists');
    fs.unlinkSync(path.join(modDir, 'manifest.json'));
    ok((await get(port, '/mod/manifest.json')).status === 404, 'manifest.json is 404 once removed');
    s = smoke('absent');
    ok(s.status === 0 && /manifest\.json is 404/.test(s.stdout), 'smoke_test passes with OGSOS_SMOKE_MOD=absent');
    ok(smoke('present').status !== 0, 'smoke_test fails with OGSOS_SMOKE_MOD=present when nothing is published');
  } finally {
    srv.kill();
    setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 300);
  }
  console.log(fail ? `${pass} passed, ${fail} failed` : `ALL OK (${pass})`);
  process.exitCode = fail ? 1 : 0;
})();
