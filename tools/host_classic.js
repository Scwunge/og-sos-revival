// One-command SOS: Classic internet playtest host (run on the host's PC).
//
//   node tools/host_classic.js [--public-host <IPv4>] [--port 7781] [--game-port 7777]
//        [--min-players N] [--countdown S] [--steam-id <id64>] [--sos-host-dir <dir>]
//        [--game "<Classic install folder>"] [--no-game-log] [--dry-run]
//   node tools/host_classic.js --cleanup     remove installed files / restore Engine.ini after a crash
//
// Test overrides: --win64 <dir>  --engine-ini <path>  --exe <path>  --exe-arg <arg> (repeatable)
//
// What it does: starts server/server.js with a fresh hosted session, points Classic's Engine.ini at it
// (via launcher/launcher.js), installs the sos_host DLL + ini into Win64, launches the listen server, and on
// exit (host closed, Ctrl+C, SIGTERM, server crash) removes everything it installed and restores Engine.ini.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { APPS, STEAM_DIR, findSteamApp } = require('../launcher/steam');
const { makeSessionJwt } = require('../server/matchmaking');

const REPO = path.resolve(__dirname, '..');
const APP_ID = APPS.classic.id; // 802240
const BACKUP_TAG = '.hostclassic-backup-';
const STATE_FILE = path.join(os.tmpdir(), 'ogsos_host_classic_state.json');

// Enforced [Host] keys (everything else in sos_host.ini is kept as shipped).
const HOST_INI_KEYS = {
  EnableListen: '1', UnfilterCommandLine: '1', SteamSockets: '0', FixJoinState: '1',
  MaxClientRate: '100000', ReplicateActors: '1', ReplicateStartupActors: '0', GameLog: '1',
};

// ---------- pure helpers (unit-testable) ----------

// Minimal Valve KeyValues parser: "key" "value" and "key" { ... } -> nested objects.
function parseVdf(text) {
  const tok = [];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
  let m;
  while ((m = re.exec(text))) tok.push(m[2] || m[1].replace(/\\(.)/g, '$1'));
  let i = 0;
  const block = () => {
    const o = {};
    while (i < tok.length && tok[i] !== '}') {
      const k = tok[i++];
      if (tok[i] === '{') { i++; o[k] = block(); } else o[k] = tok[i++];
    }
    i++; // closing brace
    return o;
  };
  return block();
}

// SteamID64 of the "MostRecent" "1" user in loginusers.vdf text; newer Steam builds omit that key, so fall
// back to the user with the highest "timestamp". Returns {id, name, how} or null.
function mostRecentSteamId(vdfText) {
  const users = (parseVdf(vdfText).users) || {};
  const list = Object.entries(users).filter(([id, u]) => /^\d{17}$/.test(id) && u && typeof u === 'object');
  const flagged = list.find(([, u]) => u.MostRecent === '1');
  if (flagged) return { id: flagged[0], name: flagged[1].AccountName, how: 'MostRecent=1' };
  const newest = list.sort((x, y) => Number(y[1].timestamp || 0) - Number(x[1].timestamp || 0))[0];
  return newest ? { id: newest[0], name: newest[1].AccountName, how: 'newest timestamp (no MostRecent key)' } : null;
}

// Set key=value pairs in [section], keeping all other lines and the file's line ending.
function setIniKeys(text, section, kv) {
  const eol = /\r\n/.test(text) || !text.includes('\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const remaining = { ...kv };
  const lower = Object.fromEntries(Object.keys(kv).map((k) => [k.toLowerCase(), k]));
  let cur = null;
  let sectionEnd = -1; // index just after the last non-blank line of the target section
  const out = [];
  for (const line of lines) {
    const s = line.match(/^\s*\[(.+)\]\s*$/);
    if (s) cur = s[1];
    else if (cur && cur.toLowerCase() === section.toLowerCase()) {
      const k = line.match(/^\s*([^=;#\s][^=]*?)\s*=/);
      const canon = k && lower[k[1].toLowerCase()];
      if (canon && canon in remaining) { out.push(`${canon}=${kv[canon]}`); delete remaining[canon]; sectionEnd = out.length; continue; }
      if (canon) continue; // duplicate of a key we already set: drop it
    }
    out.push(line);
    if (cur && cur.toLowerCase() === section.toLowerCase() && line.trim() !== '') sectionEnd = out.length;
  }
  const add = Object.entries(remaining).map(([k, v]) => `${k}=${v}`);
  if (add.length) {
    if (sectionEnd >= 0) out.splice(sectionEnd, 0, ...add);
    else out.push(`[${section}]`, ...add);
  }
  return out.join(eol) + eol;
}

// Command-line args for the listen server. The URL is ONE argv entry; child_process quotes it for Windows.
function buildGameArgs({ jwt, sessionId, sessionToken }) {
  return [`LaCuna?game=SUR?listen?AuthToken=${jwt}`, `-SESSION_ID=${sessionId}`, `-SESSION_TOKEN=${sessionToken}`, '-log', '-windowed'];
}
function redactArgs(args, secrets) {
  return args.map((a) => secrets.reduce((s, x) => (x ? s.split(x).join('<redacted>') : s), a));
}

// Files this tool may delete from Win64 (never anything else).
function isOurFile(name, { appIdCreated = false } = {}) {
  const n = name.toLowerCase();
  return n === 'version.dll' || n === 'sos_host.ini' || n === 'sos_host.log'
    || /^sos_game_.*\.log$/.test(n) || /^version_old.*\.dll$/.test(n)
    || (appIdCreated && n === 'steam_appid.txt');
}
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function parseArgs(argv) {
  const o = { exeArgs: [] };
  const valued = { '--public-host': 'publicHost', '--port': 'port', '--game-port': 'gamePort', '--min-players': 'minPlayers',
    '--countdown': 'countdown', '--steam-id': 'steamId', '--sos-host-dir': 'sosHostDir', '--game': 'game',
    '--win64': 'win64', '--engine-ini': 'engineIni', '--exe': 'exe' };
  const bool = { '--no-game-log': 'noGameLog', '--dry-run': 'dryRun', '--cleanup': 'cleanup', '--help': 'help' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued[a]) { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); o[valued[a]] = argv[++i]; }
    else if (a === '--exe-arg') { if (i + 1 >= argv.length) throw new Error('--exe-arg needs a value'); o.exeArgs.push(argv[++i]); }
    else if (bool[a]) o[bool[a]] = true;
    else throw new Error(`unknown option ${a}`);
  }
  const num = (k, lo, hi) => { if (o[k] !== undefined && !(Number.isInteger(+o[k]) && +o[k] >= lo && +o[k] <= hi)) throw new Error(`bad --${k}`); };
  num('port', 1, 65535); num('gamePort', 1, 65535); num('minPlayers', 1, 1000);
  if (o.countdown !== undefined && !(Number.isFinite(+o.countdown) && +o.countdown >= 0)) throw new Error('bad --countdown');
  if (o.publicHost && !require('net').isIPv4(o.publicHost)) throw new Error('--public-host must be an IPv4 literal (the client does no DNS)');
  if (o.steamId && !/^\d{17}$/.test(o.steamId)) throw new Error('--steam-id must be a 17-digit SteamID64');
  return o;
}

// ---------- filesystem / process helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);

function resolveConfig(o) {
  const installDir = o.game || findSteamApp(APPS.classic);
  const win64 = o.win64 || path.join(installDir, 'SOS', 'Binaries', 'Win64');
  const sosHostDir = o.sosHostDir || path.join(REPO, 'mod', 'sos_host');
  return {
    port: Number(o.port || 7781), gamePort: Number(o.gamePort || 7777),
    installDir, win64,
    exe: o.exe || path.join(win64, 'SOS-Win64-Shipping.exe'), exeArgs: o.exeArgs,
    sosHostDir,
    dllSrc: path.join(sosHostDir, 'build', 'version.dll'), iniSrc: path.join(sosHostDir, 'sos_host.ini'),
    engineIni: o.engineIni || path.join(process.env.LOCALAPPDATA || '', 'SOS', 'Saved', 'Config', 'WindowsClient', 'Engine.ini'),
    steamId: o.steamId || null,
  };
}

function readSteamId() {
  const f = path.join(STEAM_DIR, 'config', 'loginusers.vdf');
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { throw new Error(`cannot read ${f} (${e.code}); pass --steam-id <SteamID64>`); }
  const r = mostRecentSteamId(text);
  if (!r) throw new Error(`no users found in ${f}; pass --steam-id <SteamID64>`);
  console.log(`[host_classic] Steam user from loginusers.vdf: ${r.name} (${r.how}); use --steam-id to override`);
  return r.id;
}

function newSession() {
  return { sessionId: crypto.randomUUID(), sessionToken: crypto.randomBytes(24).toString('hex') };
}

function buildServerSpawn(cfg, o, session) {
  const args = [path.join(REPO, 'server', 'server.js'), '--port', String(cfg.port)];
  if (o.publicHost) args.push('--public-host', o.publicHost);
  const env = { ...process.env, OGSOS_CLASSIC_HOSTS: JSON.stringify([{ host: '127.0.0.1', port: cfg.gamePort, ...session, hostIds: [cfg.steamId] }]) };
  if (o.minPlayers !== undefined) env.OGSOS_CLASSIC_START_MIN_PLAYERS = String(o.minPlayers);
  if (o.countdown !== undefined) env.OGSOS_CLASSIC_START_COUNTDOWN_SECONDS = String(o.countdown);
  return { cmd: process.execPath, args, env, cwd: REPO };
}

function launcherArgs(cfg, o) {
  const a = [path.join(REPO, 'launcher', 'launcher.js'), '--classic', '--server', `127.0.0.1:${cfg.port}`, '--no-launch'];
  if (o.engineIni) a.push('--ini', cfg.engineIni);
  return a;
}

function probe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/kv/live-rev.txt', timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitForServer(port, child, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    if (await probe(port)) return;
    await sleep(250);
  }
  throw new Error(`server did not answer on port ${port} within ${timeoutMs / 1000}s`);
}

function prefixPipe(stream, prefix) {
  readline.createInterface({ input: stream }).on('line', (l) => console.log(`${prefix} ${l}`));
}

function runLauncher(cfg, o) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, launcherArgs(cfg, o), { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    prefixPipe(c.stdout, '[launcher]'); prefixPipe(c.stderr, '[launcher]');
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`launcher exited with code ${code}`))));
    c.on('error', reject);
  });
}

// Engine.ini backups made by this script, newest first.
function listBackups(engineIni) {
  const dir = path.dirname(engineIni), base = path.basename(engineIni) + BACKUP_TAG;
  try { return fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort().reverse().map((f) => path.join(dir, f)); } catch { return []; }
}
function restoreEngineIni(engineIni, log) {
  const [newest, ...older] = listBackups(engineIni);
  if (!newest) { log('Engine.ini: no backup from this script to restore'); return; }
  // The oldest backup is the true original (a crashed earlier run may have left newer ones of an edited file).
  const original = older.length ? older[older.length - 1] : newest;
  fs.copyFileSync(original, engineIni);
  for (const b of [newest, ...older]) { try { fs.unlinkSync(b); } catch { /* ignore */ } }
  log(`Engine.ini restored from ${path.basename(original)}`);
}

// Copy src over dst; if dst is locked (loaded DLL), rename it to version_old<ts>.dll first.
function installFile(src, dst, { keepOld = false } = {}) {
  try { fs.copyFileSync(src, dst); return null; } catch (e) {
    if (!keepOld || !LOCKED.has(e.code)) throw e;
  }
  const old = path.join(path.dirname(dst), `version_old${stamp()}.dll`);
  fs.renameSync(dst, old);
  fs.copyFileSync(src, dst);
  return old;
}

function installDll(cfg, o, log) {
  const iniText = setIniKeys(fs.readFileSync(cfg.iniSrc, 'utf8'), 'Host', { ...HOST_INI_KEYS, ...(o.noGameLog ? { GameLog: '0' } : {}) });
  const dll = path.join(cfg.win64, 'version.dll');
  const old = installFile(cfg.dllSrc, dll, { keepOld: true });
  if (old) log(`version.dll was locked; moved it to ${path.basename(old)}`);
  fs.writeFileSync(path.join(cfg.win64, 'sos_host.ini'), iniText);
  const appId = path.join(cfg.win64, 'steam_appid.txt');
  let appIdCreated = false;
  if (!fs.existsSync(appId)) { fs.writeFileSync(appId, APP_ID); appIdCreated = true; }
  return { appIdCreated };
}

async function removeOne(file, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try { fs.unlinkSync(file); return true; } catch (e) {
      if (e.code === 'ENOENT') return true;
      if (!LOCKED.has(e.code)) return false;
      await sleep(400);
    }
  }
  return false;
}

// Delete our files from Win64. Returns names that could not be removed.
async function cleanupWin64(win64, { appIdCreated }, log) {
  let names;
  try { names = fs.readdirSync(win64); } catch { return []; }
  const left = [];
  for (const n of names.filter((x) => isOurFile(x, { appIdCreated }))) {
    const f = path.join(win64, n);
    if (await removeOne(f)) { log(`removed ${n}`); continue; }
    if (n.toLowerCase() === 'version.dll') {
      try { const old = path.join(win64, `version_old${stamp()}.dll`); fs.renameSync(f, old); log(`${n} is in use; renamed to ${path.basename(old)}`); left.push(path.basename(old)); continue; } catch { /* fall through */ }
    }
    left.push(n);
  }
  return left;
}

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const writeState = (s) => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch { /* ignore */ } };
const clearState = () => { try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ } };

async function doCleanup(cfg, appIdCreated, log) {
  const left = await cleanupWin64(cfg.win64, { appIdCreated }, log);
  try { restoreEngineIni(cfg.engineIni, log); } catch (e) { log(`Engine.ini restore failed: ${e.message}`); }
  if (left.length) {
    log(`STILL IN ${cfg.win64}: ${left.join(', ')} (locked by a running SOS process).`);
    log('Close the game, then run: node tools/host_classic.js --cleanup');
    writeState({ win64: cfg.win64, appIdCreated });
  } else clearState();
  return left;
}

// ---------- dry run ----------

function printPlan(cfg, o, session, jwt) {
  const L = (s) => console.log(s);
  const srv = buildServerSpawn(cfg, o, session);
  const secrets = [session.sessionToken, jwt];
  L('DRY RUN: nothing will be started, copied or written.');
  L(`Classic install : ${cfg.installDir}`);
  L(`Win64           : ${cfg.win64}  (${fs.existsSync(cfg.win64) ? 'exists' : 'MISSING'})`);
  L(`Host exe        : ${cfg.exe}  (${fs.existsSync(cfg.exe) ? 'exists' : 'MISSING'})`);
  L(`Host SteamID64  : ${cfg.steamId}`);
  L(`sos_host dir    : ${cfg.sosHostDir}`);
  L(`  version.dll   : ${cfg.dllSrc}  (${fs.existsSync(cfg.dllSrc) ? 'exists' : 'MISSING, pass --sos-host-dir or merge the host-dll branch'})`);
  L(`  sos_host.ini  : ${cfg.iniSrc}  (${fs.existsSync(cfg.iniSrc) ? 'exists' : 'MISSING'})`);
  L(`Engine.ini      : ${cfg.engineIni}  (${fs.existsSync(cfg.engineIni) ? 'exists' : 'MISSING'}); backup -> ${cfg.engineIni}${BACKUP_TAG}<timestamp>`);
  L(`Session         : id ${session.sessionId}, token <redacted>`);
  L(`1. server: ${srv.cmd} ${srv.args.join(' ')}  (cwd ${srv.cwd})`);
  L(`   env OGSOS_CLASSIC_HOSTS=${redactArgs([srv.env.OGSOS_CLASSIC_HOSTS], secrets)[0]}`);
  for (const k of ['OGSOS_CLASSIC_START_MIN_PLAYERS', 'OGSOS_CLASSIC_START_COUNTDOWN_SECONDS']) if (srv.env[k]) L(`   env ${k}=${srv.env[k]}`);
  L(`2. wait for GET http://127.0.0.1:${cfg.port}/kv/live-rev.txt`);
  L(`3. launcher: ${process.execPath} ${launcherArgs(cfg, o).join(' ')}`);
  L(`4. install into Win64: version.dll, sos_host.ini [Host] ${Object.entries({ ...HOST_INI_KEYS, ...(o.noGameLog ? { GameLog: '0' } : {}) }).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  L(`   steam_appid.txt (${APP_ID}) ${fs.existsSync(path.join(cfg.win64, 'steam_appid.txt')) ? 'already present, left alone' : 'will be created'}`);
  L(`5. host: ${cfg.exe} ${redactArgs([...cfg.exeArgs, ...buildGameArgs({ jwt, ...session })], secrets).join(' ')}`);
  L(`   cwd ${cfg.win64}; env SteamAppId=${APP_ID} SteamGameId=${APP_ID}`);
  L('6. on exit: kill host+server, delete version.dll, sos_host.ini, sos_host.log, sos_game_*.log, version_old*.dll (+ steam_appid.txt if created), restore Engine.ini');
}

function printBanner(cfg, o) {
  const pub = o.publicHost || '<YOUR-PUBLIC-IPv4>';
  const bar = '='.repeat(72);
  console.log(['', bar, ' SOS: Classic playtest host is up', bar,
    ` Friends run:   node launcher/launcher.js --classic --server ${pub}:${cfg.port}`,
    ` Open on your router/firewall:  TCP ${cfg.port}  (backend)   UDP ${cfg.gamePort}  (game)`,
    o.publicHost ? '' : ' (pass --public-host <your IPv4> so clients are told the right game address)',
    ' Force-start the match:  type  start  and press Enter in this window',
    ' Stop everything:        Ctrl+C (files are removed and Engine.ini restored)',
    bar, ''].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'));
}

// ---------- main ----------

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  const cfg = resolveConfig(o);
  const log = (m) => console.log(`[host_classic] ${m}`);

  if (o.cleanup) {
    const st = readState();
    const code = (await doCleanup(cfg, st.win64 === cfg.win64 && st.appIdCreated, log)).length ? 1 : 0;
    return code;
  }

  cfg.steamId = cfg.steamId || readSteamId();
  const session = newSession();
  const jwt = makeSessionJwt(session, cfg.steamId);
  if (o.dryRun) { printPlan(cfg, o, session, jwt); return 0; }

  const need = [[cfg.win64, 'Win64 folder'], [cfg.exe, 'game exe'], [cfg.engineIni, 'Engine.ini (start Classic once through Steam so it exists)']];
  if (!fs.existsSync(cfg.dllSrc) || !fs.existsSync(cfg.iniSrc)) {
    throw new Error(`sos_host files not found (${cfg.dllSrc}, ${cfg.iniSrc}). Pass --sos-host-dir <mod/sos_host folder> or merge the host-dll branch.`);
  }
  for (const [p, what] of need) if (!fs.existsSync(p)) throw new Error(`${what} not found: ${p}`);
  if (await probe(cfg.port)) throw new Error(`something already answers on port ${cfg.port}; pick another --port`);

  let server = null, host = null, shuttingDown = false, installed = false, appIdCreated = false, backedUp = false;
  let resolveDone; const done = new Promise((r) => { resolveDone = r; });
  let exitCode = 0;

  const shutdown = async (why, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true; exitCode = code;
    log(`stopping (${why})`);
    for (const c of [host, server]) if (c && c.exitCode === null) { try { c.kill(); } catch { /* gone */ } }
    for (const c of [host, server]) if (c && c.exitCode === null) await Promise.race([new Promise((r) => c.once('exit', r)), sleep(5000)]);
    const left = await doCleanup(cfg, appIdCreated, log);
    if (left.length) exitCode = exitCode || 1;
    resolveDone();
  };
  process.on('SIGINT', () => shutdown('Ctrl+C'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('Ctrl+Break'));

  try {
    // A crashed earlier run may have left a modified Engine.ini; put the original back before backing up again.
    if (listBackups(cfg.engineIni).length) restoreEngineIni(cfg.engineIni, log);
    fs.copyFileSync(cfg.engineIni, `${cfg.engineIni}${BACKUP_TAG}${stamp()}`); backedUp = true;

    const srv = buildServerSpawn(cfg, o, session);
    server = spawn(srv.cmd, srv.args, { cwd: srv.cwd, env: srv.env, stdio: ['pipe', 'pipe', 'pipe'] });
    prefixPipe(server.stdout, '[server]'); prefixPipe(server.stderr, '[server]');
    server.stdin.on('error', () => {});
    server.on('exit', (c) => { if (!shuttingDown) shutdown(`server exited (code ${c})`, 1); });
    await waitForServer(cfg.port, server);
    log(`backend answering on port ${cfg.port}`);
    // Forward typed lines (e.g. "start") to the backend.
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (l) => { if (server.exitCode === null) server.stdin.write(l + '\n'); });

    await runLauncher(cfg, o);
    writeState({ win64: cfg.win64, appIdCreated: false });
    ({ appIdCreated } = installDll(cfg, o, log)); installed = true;
    writeState({ win64: cfg.win64, appIdCreated });

    const env = { ...process.env, SteamAppId: APP_ID, SteamGameId: APP_ID };
    host = spawn(cfg.exe, [...cfg.exeArgs, ...buildGameArgs({ jwt, ...session })], { cwd: cfg.win64, env, stdio: 'ignore' });
    host.on('error', (e) => shutdown(`host failed to start: ${e.message}`, 1));
    host.on('exit', (c) => shutdown(`host exited (code ${c})`));
    log(`host started (pid ${host.pid})`);
    printBanner(cfg, o);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    await shutdown('startup failed', 1);
  }
  await done;
  return exitCode;
}

module.exports = { parseVdf, mostRecentSteamId, setIniKeys, buildGameArgs, redactArgs, isOurFile, parseArgs, HOST_INI_KEYS, cleanupWin64, installFile };

if (require.main === module) {
  main().then((c) => process.exit(c), (e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}
