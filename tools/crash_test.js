// Hostile-input crash test, no setup:  node tools/crash_test.js
// Spawns a backend on a free port and throws malformed request lines, bad percent-encoding, odd upgrades and broken
// WebSocket frames at it. After every probe the process must still answer GET /servers, and it must never exit.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http'), crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function raw(port, data, waitMs = 400) {   // write bytes as is, collect whatever comes back
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1'); const c = [];
    s.on('connect', () => s.write(data));
    s.on('data', (d) => c.push(d)); s.on('error', () => {});
    setTimeout(() => { s.destroy(); const t = Buffer.concat(c).toString('latin1'); resolve({ status: Number((t.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0), text: t }); }, waitMs);
  });
}
function alive(port) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/servers?local=1', timeout: 2000 }, (r) => { r.resume(); resolve(r.statusCode === 200); })
      .on('error', () => resolve(false)).on('timeout', function () { this.destroy(); resolve(false); });
  });
}
function login(port, steamId) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ 'steam-app-id': '802240', 'steam-id': steamId, 'session-auth-token': 'x', 'app-id': 'sostest' });
    const q = http.request({ host: '127.0.0.1', port, path: '/api/access-token/steam', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
      let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { resolve(JSON.parse(s)['access-token']); } catch { resolve(null); } });
    });
    q.on('error', () => resolve(null)); q.end(body);
  });
}
const upgrade = (p, extra = '') => `GET ${p} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ogsos-crash-'));
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js'), '--port', String(port)], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, OGSOS_STATE_DIR: path.join(tmp, 'state'), OGSOS_LOG_DIR: path.join(tmp, 'logs'), OGSOS_PERSONA_DISABLE: '1', OGSOS_CLASSIC_HOSTS: '', OGSOS_HOSTS: '' },
  });
  let exited = null; srv.on('exit', (c) => { exited = c; });
  try {
    for (let i = 0; i < 50 && !(await alive(port)); i++) await sleep(100);
    ok(await alive(port), 'backend up');
    const tok = await login(port, '76561190000000777');
    const http1 = (line, extra = '') => `${line} HTTP/1.1\r\nHost: x\r\n${extra}Connection: close\r\n\r\n`;
    const probes = [
      ['GET //', http1('GET //')],
      ['GET //evil.example/x', http1('GET //evil.example/x')],
      ['GET ///', http1('GET ///')],
      ['GET // with a body', `POST // HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`],
      ['GET *', http1('GET *')],
      ['GET absolute-form', http1('GET http://other.example/servers')],
      ['GET /%', http1('GET /%')],
      ['GET /%zz', http1('GET /%zz')],
      ['GET /api/account/%E0%A4%A/app/sostest', http1('GET /api/account/%E0%A4%A/app/sostest', tok ? `Authorization: Token ${tok}\r\n` : '')],
      ['GET /api/leaderboard/%ff/%zz', http1('GET /api/leaderboard/%ff/%zz')],
      ['GET /api/stats/%', http1('GET /api/stats/%')],
      ['GET /api/session/%zz', http1('GET /api/session/%zz', 'Authorization: Token x\r\n')],
      ['POST /api/account/%zz/app-meta/sostest/report', `POST /api/account/%zz/app-meta/sostest/report HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`],
      ['GET /admin/api/players/%E0%A4%A', http1('GET /admin/api/players/%E0%A4%A')],
      ['GET /admin/%2e%2e%2fserver.js', http1('GET /admin/%2e%2e%2fserver.js')],
      ['GET /kv/%zz', http1('GET /kv/%zz')],
      ['GET /mod/%zz', http1('GET /mod/%zz')],
      ['GET /embed/%zz', http1('GET /embed/%zz')],
      ['POST /api/access-token/steam bad json', `POST /api/access-token/steam HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 5\r\nConnection: close\r\n\r\n{"a":`],
      ['POST /api/access-token/steam array', `POST /api/access-token/steam HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]`],
      ['POST /api/access-token/steam null', `POST /api/access-token/steam HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnull`],
      ['garbage request line', 'NOT HTTP AT ALL\r\n\r\n'],
      ['upgrade //', upgrade('//')],
      ['upgrade /%zz', upgrade('/%zz')],
      ['upgrade //ws?token=%zz', upgrade('//ws?token=%zz')],
      ['upgrade /ws/stream?token=%E0%A4%A', upgrade('/ws/stream?token=%E0%A4%A')],
      ['upgrade without a key', 'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'],
    ];
    for (const [name, data] of probes) {
      await raw(port, data);
      ok(await alive(port) && exited === null, `still serving after ${name}`);
    }
    const r = await raw(port, http1('GET //'));
    ok(r.status >= 200 && r.status < 500, `GET // gets a normal reply (got ${r.status})`);
    // broken frames on an open stream socket (stream sockets accept anonymous clients)
    const frames = [
      ['64-bit length 2^63', Buffer.from([0x81, 0xff, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1, 2, 3, 4])],
      ['invalid UTF-8 / JSON', Buffer.concat([Buffer.from([0x81, 0x84, 0, 0, 0, 0]), Buffer.from([0xff, 0xfe, 0x7b, 0x22])])],
      ['unmasked frame', Buffer.from([0x81, 0x02, 0x7b, 0x7d])],
      ['reserved opcode', Buffer.from([0x83, 0x80, 0, 0, 0, 0])],
      ['ping with a payload', Buffer.from([0x89, 0x82, 0, 0, 0, 0, 0x61, 0x62])],
    ];
    for (const [name, f] of frames) {
      await raw(port, Buffer.concat([Buffer.from(upgrade('/ws/stream')), f]));
      ok(await alive(port) && exited === null, `still serving after a WS frame: ${name}`);
      if (tok) {
        await raw(port, Buffer.concat([Buffer.from(upgrade('/ws', `Authorization: Token ${tok}\r\napp-id: sostest\r\n`)), f]));
        ok(await alive(port) && exited === null, `still serving after a matchmaking WS frame: ${name}`);
      }
    }
  } finally {
    srv.kill();
    setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 300);
  }
  ok(exited === null, 'process never exited on its own');
  console.log(fail ? `${pass} passed, ${fail} failed` : `ALL OK (${pass})`);
  process.exitCode = fail ? 1 : 0;
})();
