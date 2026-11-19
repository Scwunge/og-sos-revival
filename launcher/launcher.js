// OG SOS Revival launcher.
// Points your installed SOS at a revival server, then starts the game.
//
//   node launcher/launcher.js --server 127.0.0.1:7780     point at a server and launch
//   node launcher/launcher.js --server host:port --no-launch
//   node launcher/launcher.js --restore                   put the original settings back
//
// It only edits your own config file (%LOCALAPPDATA%\SOS\Saved\Config\WindowsClient\Engine.ini).
// The game files themselves are never touched. A backup is kept next to the file.

'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);

const INI = path.join(process.env.LOCALAPPDATA || '', 'SOS', 'Saved', 'Config', 'WindowsClient', 'Engine.ini');
const BACKUP = INI + '.ogsos-backup';
const GAME_DIR = opt('--game') || 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\SOS';
const EXE = path.join(GAME_DIR, 'SOS', 'Binaries', 'Win64', 'SOS-Win64-Shipping.exe');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

if (!fs.existsSync(INI)) die(`Config not found at ${INI}. Start SOS once through Steam so it creates it.`);

if (flag('--restore')) {
  if (!fs.existsSync(BACKUP)) die('No backup found; nothing to restore.');
  fs.copyFileSync(BACKUP, INI);
  console.log('Original settings restored.');
  process.exit(0);
}

const server = opt('--server');
if (!server) die('Pass --server host:port (for example --server 127.0.0.1:7780), or --restore.');
const [host, port = '7780'] = server.split(':');
const base = `http://${host}:${port}`;

// Section -> key -> value. Matches the sections the client reads.
const WANT = {
  OutpostKeyValueStore: {
    EndpointClient: `"${base}/kv/"`,
    EndpointClientFallback: `"${base}/kv/"`,
    EndpointServer: `"${base}/kv/"`,
  },
  OutpostIdentity: { Endpoint: `"${base}"` },
  OutpostAppPersistence: { Endpoint: `"${base}"` },
  OutpostIAP: { Endpoint: `"${base}"` },
  OutpostStorefront: { Endpoint: `"${base}"` },
  OutpostLeaderboards: { Endpoint: `"${base}"` },
  OutpostLogReceiver: { Endpoint: `"${base}"` },
  OutpostMatchmakingClient: {
    MatchmakingSSL: 'False',
    MatchmakingPort: port,
    MatchmakingEndpoint: host,
    MatchmakingApi: `"${base}/api"`,
  },
};

if (!fs.existsSync(BACKUP)) {
  fs.copyFileSync(INI, BACKUP);
  console.log(`Backed up original config to ${BACKUP}`);
}

// Line-based edit so everything else in the file is kept exactly as it was.
const lines = fs.readFileSync(INI, 'utf8').split(/\r?\n/);
const out = [];
let section = null;
const done = {};
const flushMissing = (sec) => {
  if (!sec || !WANT[sec]) return;
  for (const [k, v] of Object.entries(WANT[sec])) {
    if (!done[sec]?.has(k)) out.push(`${k}=${v}`);
  }
};
for (const line of lines) {
  const s = line.match(/^\s*\[(.+)\]\s*$/);
  if (s) {
    // Insert any keys the previous section lacked before its trailing blank line.
    const trailing = [];
    while (out.length && out[out.length - 1].trim() === '') trailing.push(out.pop());
    flushMissing(section);
    out.push(...trailing);
    section = s[1];
    done[section] = new Set();
    out.push(line);
    continue;
  }
  const kv = line.match(/^\s*([^=;]+?)\s*=/);
  if (section && WANT[section] && kv && kv[1] in WANT[section]) {
    out.push(`${kv[1]}=${WANT[section][kv[1]]}`);
    done[section].add(kv[1]);
    continue;
  }
  out.push(line);
}
flushMissing(section);
for (const sec of Object.keys(WANT)) {
  if (!done[sec]) {
    out.push('', `[${sec}]`);
    for (const [k, v] of Object.entries(WANT[sec])) out.push(`${k}=${v}`);
  }
}
fs.writeFileSync(INI, out.join('\r\n'));
console.log(`SOS now points at ${base}`);

if (flag('--no-launch')) process.exit(0);
if (!fs.existsSync(EXE)) die(`Game not found at ${EXE}. Pass --game "<SOS install folder>".`);
// Launch the game exe directly (no BattlEye launcher). Steam must be running.
const child = spawn(EXE, ['-log'], { cwd: path.dirname(EXE), detached: true, stdio: 'ignore' });
child.unref();
console.log('SOS started. Steam must be running and signed in.');
