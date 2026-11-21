'use strict';
// Exercises the loader's update rules with stub cores. Needs build\xinput1_3.dll (build.ps1) and the signing key
// at %USERPROFILE%\.ogsos\update-signing.key (the loader only accepts manifests signed with it).
//   node mod/sos_client/test/update_test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const tool = path.join(__dirname, '..', '..', '..', 'tools', 'mod_update.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updtest-'));
const loader = path.join(root, 'build', 'xinput1_3.dll');
let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL: ' + m); } else console.log('ok:   ' + m); };

const stub = (v) => { const o = path.join(tmp, `stub_v${v}.dll`); execFileSync('gcc', ['-shared', '-O2', `-DSTUB_VER=${v}`, '-o', o, path.join(__dirname, 'stub_core.c'), '-s']); return o; };
const loadit = path.join(tmp, 'loadit.exe');
execFileSync('gcc', ['-O2', '-o', loadit, path.join(__dirname, 'loadit.c')]);
const signed = (core, ver, name) => {
  const d = path.join(tmp, name);
  execFileSync('node', [tool, 'sign', core, String(ver), d], { stdio: 'pipe' });
  return d;
};
let n = 0;
function fresh(installedVer, stubVer) {
  const d = path.join(tmp, 'game' + (++n));
  fs.mkdirSync(d);
  fs.copyFileSync(loader, path.join(d, 'xinput1_3.dll'));
  if (installedVer) {
    const s = signed(stub(stubVer), installedVer, 'rel' + n);
    fs.copyFileSync(stub(stubVer), path.join(d, 'sos_client_core.dll'));
    fs.copyFileSync(path.join(s, 'manifest.json'), path.join(d, 'sos_client_core.manifest'));
    fs.copyFileSync(path.join(s, 'manifest.sig'), path.join(d, 'sos_client_core.sig'));
  }
  return d;
}
function stage(d, coreFile, ver, mutate) {
  const s = signed(coreFile, ver, 'stage' + (++n));
  let bin = fs.readFileSync(path.join(s, `core-${ver}.dll`));
  let man = fs.readFileSync(path.join(s, 'manifest.json'));
  let sig = fs.readFileSync(path.join(s, 'manifest.sig'));
  if (mutate) ({ bin, man, sig } = mutate({ bin, man, sig }));
  fs.writeFileSync(path.join(d, 'sos_client_core.new'), bin);
  fs.writeFileSync(path.join(d, 'sos_client_core.new.manifest'), man);
  fs.writeFileSync(path.join(d, 'sos_client_core.new.sig'), sig);
}
const run = (d) => execFileSync(loadit, [d]).toString().trim();
const started = (d) => { try { return fs.readFileSync(path.join(d, 'started.txt'), 'utf8').trim().split(/\s+/); } catch { return []; } };
const has = (d, f) => fs.existsSync(path.join(d, f));

// A: valid higher version is applied, previous core kept
let d = fresh(1, 1); stage(d, stub(2), 2);
ok(run(d) === 'loaded' && started(d).join() === 'v2', 'A valid v2 applied and started');
ok(has(d, 'sos_client_core.prev') && !has(d, 'sos_client_core.new'), 'A previous core kept, staged files consumed');

// B: tampered signature rejected
d = fresh(1, 1); stage(d, stub(2), 2, (x) => { const s = Buffer.from(x.sig.toString()); s[5] = s[5] === 48 ? 49 : 48; return { ...x, sig: s }; });
run(d);
ok(started(d).join() === 'v1' && !has(d, 'sos_client_core.new'), 'B bad signature rejected, v1 still runs');

// C: same / lower version rejected
d = fresh(2, 2); stage(d, stub(1), 1);
run(d);
ok(started(d).join() === 'v2', 'C downgrade (v1 over v2) refused');
d = fresh(2, 2); stage(d, stub(3), 2);
run(d);
ok(started(d).join() === 'v2', 'C same version refused');

// D: file does not match the signed hash
d = fresh(1, 1); stage(d, stub(2), 2, (x) => { const b = Buffer.from(x.bin); b[b.length - 1] ^= 1; return { ...x, bin: b }; });
run(d);
ok(started(d).join() === 'v1', 'D tampered core file rejected');

// D2: manifest edited after signing (e.g. to raise the version) rejected
d = fresh(1, 1); stage(d, stub(2), 2, (x) => ({ ...x, man: Buffer.from(x.man.toString().replace('"version":2', '"version":9')) }));
run(d);
ok(started(d).join() === 'v1', 'D2 edited manifest rejected');

// E: a new core that never clears the trial marker is rolled back on the third launch
d = fresh(1, 1); stage(d, stub(2), 2);
run(d); run(d);
ok(started(d).join() === 'v2,v2', 'E v2 runs under trial for two launches');
run(d);
ok(started(d).pop() === 'v1' && has(d, 'sos_client_core.dll') && !has(d, 'sos_client_core.trial'), 'E third launch rolled back to v1');

// E2: a core that stays up (trial removed) is kept
d = fresh(1, 1); stage(d, stub(2), 2);
run(d); fs.unlinkSync(path.join(d, 'sos_client_core.trial')); run(d); run(d); run(d);
ok(started(d).join() === 'v2,v2,v2,v2', 'E2 stable core kept');

// F: signed but unloadable core falls back to the previous one
d = fresh(1, 1);
const junk = path.join(tmp, 'junk.dll'); fs.writeFileSync(junk, 'not a dll at all');
stage(d, junk, 3);
ok(run(d) === 'loaded' && started(d).join() === 'v1', 'F unloadable core rolled back to previous');

// G: no core present
d = fresh(0, 1);
ok(run(d) === 'loaded', 'G loader alone is a plain XInput passthrough');

console.log(`\n${checks} checks, ${fails} failures`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
