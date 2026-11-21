// OG SOS Revival launcher.
// Points your installed SOS at a revival server, then starts the game.
//
//   node launcher/launcher.js --server 127.0.0.1:7780     point at a server and launch
//   node launcher/launcher.js --server host:port --no-launch
//   node launcher/launcher.js --restore                   put the original settings back
//   node launcher/launcher.js --classic --server ...      same, for SOS: Classic (Steam app 802240)
//
// Other options: --game "<install folder>" (default: found from Steam's library manifests),
// --ini "<Engine.ini path>" (default below).
//
// It only edits your own config file (%LOCALAPPDATA%\SOS\Saved\Config\WindowsClient\Engine.ini).
// SOS: Classic uses the SAME file (both builds are project "SOS"), so pointing one client at a
// server points both, and --restore restores both. The game files themselves are never touched.
// A backup is kept next to the file.

'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);

const { APPS, findSteamApp } = require('./steam');

// Classic if asked for, or if --game points at the Classic install folder.
const CLASSIC = flag('--classic') || /SOS Test Server/i.test(opt('--game') || '');
const APP = CLASSIC ? APPS.classic : APPS.main;
const INI = opt('--ini') || path.join(process.env.LOCALAPPDATA || '', 'SOS', 'Saved', 'Config', 'WindowsClient', 'Engine.ini');
const BACKUP = INI + '.ogsos-backup';
const GAME_DIR = opt('--game') || findSteamApp(APP);
const EXE = path.join(GAME_DIR, 'SOS', 'Binaries', 'Win64', 'SOS-Win64-Shipping.exe');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

if (!fs.existsSync(INI)) die(`Config not found at ${INI}. Start ${APP.name} once through Steam so it creates it.`);

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

// Section -> key -> value. Matches the sections the client reads. Classic reads the same
// sections minus IAP/Storefront; they stay because the file is shared with the main client.
// The server tells the two clients apart by their app-id (sos / sostest).
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
  OutpostStreams: { EmbedEndpoint: `"${base}"` },   // HERO panel (hero.tv is parked); server.js serves a blank /embed/
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
console.log(`${APP.name} now points at ${base}${CLASSIC ? ' (shared config: the main client does too)' : ''}`);

if (flag('--no-launch')) process.exit(0);
if (!fs.existsSync(EXE)) die(`Game not found at ${EXE}. Pass --game "<${APP.name} install folder>".`);
// Launch the game exe directly (no BattlEye launcher). Steam must be running.
// SteamAppId/SteamGameId tell SteamAPI_Init which app this is. The Classic install ships no
// steam_appid.txt, so without them Steam auth fails ("LoadingSteamClientAuth" Success=false).
const env = { ...process.env, SteamAppId: APP.id, SteamGameId: APP.id };
const child = spawn(EXE, ['-log'], { cwd: path.dirname(EXE), env, detached: true, stdio: 'ignore' });
child.unref();
console.log(`${APP.name} started from ${GAME_DIR}. Steam must be running and signed in.`);
