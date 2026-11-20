// Tests the double-click join file (tools/join_classic.template.cmd) without the real game or config.
//   node tools/join_file_test.js
// 1. Its config edit matches launcher/launcher.js on the same input.
// 2. With a stand-in exe that exits at once, the config is restored and the backup removed.
// 3. A stale backup (last run never restored) is kept as the original.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ogsos-join-'));
const SERVER = '203.0.113.5:7781';
const SAMPLE = [
  '[Core.System]', 'Paths=../../../Engine/Content', '',
  '[OutpostIdentity]', 'Endpoint="https://old.example/"', 'Other=1', '',
  '[OutpostMatchmakingClient]', 'MatchmakingSSL=True', '',
  '[/Script/Engine.Engine]', 'bSmoothFrameRate=true', '',
].join('\r\n');

let failed = 0;
const ok = (cond, name) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`); if (!cond) failed++; };

const cmd = path.join(tmp, 'Join OG SOS Classic.cmd');
execFileSync(process.execPath, [path.join(__dirname, 'make_join_file.js'), '--server', SERVER, '--out', cmd]);
const fakeExe = path.join(tmp, 'fake.exe');
fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), fakeExe); // '-log' is a bad arg: exits at once

function runJoin(ini, extra = {}) {
  const env = { ...process.env, OGSOS_INI: ini, OGSOS_GAME_DIR: tmp, OGSOS_EXE: fakeExe, OGSOS_TEST: '1', ...extra };
  return execFileSync('cmd.exe', ['/c', cmd], { env, encoding: 'utf8', input: '' });
}

try {
  // 1. Same edit as the Node launcher.
  const iniA = path.join(tmp, 'a.ini'); fs.writeFileSync(iniA, SAMPLE);
  const iniB = path.join(tmp, 'b.ini'); fs.writeFileSync(iniB, SAMPLE);
  runJoin(iniA, { OGSOS_NO_LAUNCH: '1' });
  execFileSync(process.execPath, [path.join(repo, 'launcher', 'launcher.js'), '--classic', '--server', SERVER, '--no-launch', '--ini', iniB]);
  const a = fs.readFileSync(iniA, 'utf8'), b = fs.readFileSync(iniB, 'utf8');
  ok(a === b, 'config edit matches launcher/launcher.js');
  ok(a.includes('MatchmakingEndpoint=203.0.113.5') && a.includes('Endpoint="http://203.0.113.5:7781"') && a.includes('Other=1') && a.includes('bSmoothFrameRate=true'), 'server keys set, other keys kept');
  if (a !== b) console.log('--- join file:\n' + a + '\n--- launcher:\n' + b);
  fs.rmSync(iniA + '.ogsos-join-backup', { force: true });

  // 2. Launch + wait + restore.
  const iniC = path.join(tmp, 'c.ini'); fs.writeFileSync(iniC, SAMPLE);
  const outC = runJoin(iniC);
  ok(fs.readFileSync(iniC, 'utf8') === SAMPLE, 'config restored byte for byte after the game exits');
  ok(!fs.existsSync(iniC + '.ogsos-join-backup'), 'backup removed');
  ok(/settings are restored/.test(outC), 'tells the player it restored');

  // 3. Stale backup from a crashed run is treated as the original.
  const iniD = path.join(tmp, 'd.ini'); fs.writeFileSync(iniD, 'pointed-elsewhere'); fs.writeFileSync(iniD + '.ogsos-join-backup', SAMPLE);
  runJoin(iniD);
  ok(fs.readFileSync(iniD, 'utf8') === SAMPLE, 'stale backup wins over the half-edited config');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'ALL OK');
process.exit(failed ? 1 : 0);
