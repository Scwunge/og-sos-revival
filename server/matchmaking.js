// Matchmaking protocol (see docs/MATCHMAKING.md). No dependencies, no I/O of its own:
// server.js owns the sockets and hands each connection in as a "client" object:
//   { id: accountId, connId, sendMsg(type, data?), close() }
// Everything here is synchronous, so replies leave in exactly the order requests arrive
// (the game client matches replies to requests FIFO, there are no ids).
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

// Every key can be set in data/config.json or via env var OGSOS_<KEY>. See data/config.example.json.
const DEFAULTS = {
  REGION_NAME: 'local',        // name of the single region offered in `regions`
  BEACON_URL: '',              // ping target for the region ('' = use PUBLIC_HOST, else GAME_SERVER_HOST)
  PUBLIC_HOST: '',             // IPv4 literal clients are told to connect to (replaces the host in session/session-started); '' = off
  GAME_SERVER_HOST: '127.0.0.1', // IPv4 literal handed to clients in session-started
  GAME_SERVER_PORT: 7777,
  MIN_PLAYERS: 1,              // queued players needed to start a match immediately
  MAX_PLAYERS: 16,             // players per session
  QUEUE_TIMEOUT: 20,           // seconds; after this a match starts with whoever is queued (>= 1 player)
  MATCH_BATCH_MS: 300,         // wait this long after the queue becomes matchable so near-simultaneous players share a session
  LATE_JOIN_SECONDS: 300,      // seconds after a session started during which new players are still seated (hosted: 0 = never, -1 = always)
  GROUP_MAX_SIZE: 8,           // players per group
  START_MIN_PLAYERS: 1,        // hosted sessions only: seated players needed before the start countdown begins
  START_COUNTDOWN_SECONDS: 10, // hosted sessions only: countdown before session-started is sent (0 = start at once)
  START_FULL_COUNTDOWN_SECONDS: 10, // hosted sessions only: a running countdown is cut to at most this once the session is full
  VOTE_START_MIN_PLAYERS: 2,   // hosted sessions only: seated players needed before a vote-start can count
  VOTE_START_COUNTDOWN_SECONDS: 10, // hosted sessions only: countdown once a majority voted to start
  HOST_ONLINE_SECONDS: 90,     // hosted sessions only: a host counts as online this long after its last poll (pool seating + GET /servers)
  EMPTY_END_SECONDS: 120,      // hosted sessions only: a started session with no seated players this long is ended (0 = off)
  TRAVEL_GRACE_SECONDS: 300,   // hosted sessions only: a seated player whose WS closed keeps their seat this long
  HOSTS: [],                   // fixed game hosts: [{host, port, sessionId, sessionToken, hostIds, name?, region?}], see docs/CLASSIC.md
};

// Public server-list labels (name/region): a string without control characters, trimmed and cut to max.
const DEFAULT_SERVER_NAME = 'OG SOS server';
function cleanLabel(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, max) : '';
}

// Validate a HOSTS value (array or JSON string). Bad entries are warned about and skipped.
function parseHosts(raw, warn = console.warn, defaultPort = 7777) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { warn(`HOSTS ignored: not valid JSON (${e.message})`); return []; }
  }
  if (!Array.isArray(raw)) { warn('HOSTS ignored: not an array'); return []; }
  const out = [];
  raw.forEach((h, i) => {
    const o = h && typeof h === 'object' ? h : {};
    const port = o.port === undefined || o.port === '' ? defaultPort : Number(o.port);
    const problem = !net.isIPv4(String(o.host)) ? 'host must be an IPv4 literal'
      : !Number.isInteger(port) || port < 1 || port > 65535 ? 'bad port'
      : typeof o.sessionId !== 'string' || !o.sessionId.includes('-') ? 'sessionId must be a string containing "-"'
      : typeof o.sessionToken !== 'string' || o.sessionToken.length <= 1 ? 'sessionToken must be a string longer than 1 character'
      : null;
    if (problem) { warn(`HOSTS[${i}] skipped: ${problem}`); return; }
    out.push({
      host: o.host, port, sessionId: o.sessionId, sessionToken: o.sessionToken,
      hostIds: Array.isArray(o.hostIds) ? o.hostIds.map(String).filter(Boolean) : [],
      name: cleanLabel(o.name, 48) || DEFAULT_SERVER_NAME, region: cleanLabel(o.region, 16),
    });
  });
  return out;
}

const b64u = (v) => Buffer.from(v).toString('base64url');
// Access token a listen server accepts: HS512 keyed with its SESSION_TOKEN, sub = session id.
function makeSessionJwt(entry, playerId) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'HS512' }));
  const claims = b64u(JSON.stringify({
    sub: entry.sessionId, id: String(playerId), 'user-id': String(playerId), 'account-id': String(playerId),
    roles: ['user+session'], iat: now, exp: now + 24 * 3600,
  }));
  const sig = crypto.createHmac('sha512', entry.sessionToken).update(`${head}.${claims}`).digest('base64url');
  return `${head}.${claims}.${sig}`;
}

// Verify a per-player access token made by makeSessionJwt (HS512 keyed with the session token, sub = session id).
// Returns the player id or null.
function readSessionJwt(entry, tok) {
  const parts = String(tok).split('.');
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (!head || head.alg !== 'HS512') return null;
    const want = Buffer.from(crypto.createHmac('sha512', entry.sessionToken).update(`${parts[0]}.${parts[1]}`).digest('base64url'));
    const got = Buffer.from(parts[2]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!c || c.sub !== entry.sessionId || (c.exp && c.exp < Date.now() / 1000)) return null;
    const id = String(c['account-id'] || c.id || '');
    return id || null;
  } catch { return null; }
}

// First valid IPv4 literal of [{src, v}] candidates (highest precedence first); invalid ones are warned about.
function pickPublicHost(cands, warn = console.warn) {
  for (const { src, v } of cands) {
    if (v === undefined || v === null || v === '') continue;
    if (net.isIPv4(String(v))) return String(v);
    warn(`PUBLIC_HOST from ${src} ignored: "${v}" is not an IPv4 literal (the client does no DNS)`);
  }
  return '';
}

// overrides: { PUBLIC_HOST } from the command line (wins over env and file).
function loadConfig(dataDir, env = process.env, warn = console.warn, overrides = {}) {
  const cfg = { ...DEFAULTS };
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') warn(`data/config.json ignored: ${e.message}`); }
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'HOSTS' || key === 'PUBLIC_HOST') continue;
    let v = env[`OGSOS_${key}`] !== undefined ? env[`OGSOS_${key}`] : file[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof DEFAULTS[key] === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) { warn(`config ${key}: not a number, using default`); continue; }
    } else v = String(v);
    cfg[key] = v;
  }
  cfg.HOSTS = parseHosts(env.OGSOS_HOSTS !== undefined ? env.OGSOS_HOSTS : file.HOSTS, warn, cfg.GAME_SERVER_PORT);
  if (!net.isIPv4(cfg.GAME_SERVER_HOST)) {
    warn(`config GAME_SERVER_HOST "${cfg.GAME_SERVER_HOST}" is not an IPv4 literal (the client does no DNS); using 127.0.0.1`);
    cfg.GAME_SERVER_HOST = '127.0.0.1';
  }
  cfg.PUBLIC_HOST = pickPublicHost([
    { src: '--public-host', v: overrides.PUBLIC_HOST },
    { src: 'env OGSOS_PUBLIC_HOST', v: env.OGSOS_PUBLIC_HOST },
    { src: 'data/config.json', v: file.PUBLIC_HOST },
  ], warn);
  cfg.MIN_PLAYERS = Math.max(1, Math.floor(cfg.MIN_PLAYERS));
  cfg.MAX_PLAYERS = Math.max(cfg.MIN_PLAYERS, Math.floor(cfg.MAX_PLAYERS));
  return cfg;
}

const str = (v) => (typeof v === 'string' ? v : '');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function createMatchmaker({ config, getUname = (id) => id, log = () => {} }) {
  const clients = new Map();   // accountId -> client
  const groups = new Map();    // groupId -> group
  const sessions = new Map();  // sessionId -> session
  let queue = [];              // { kind: 'solo'|'group', client?, groupId?, opts, since }
  let batchTimer = null;
  const hostEntries = Array.isArray(config.HOSTS) ? config.HOSTS : [];
  const hostedById = new Map(); // sessionId -> { s, entry }; one persistent live session per host

  const numCfg = (k) => (Number.isFinite(Number(config[k])) ? Number(config[k]) : DEFAULTS[k]);
  const startMin = Math.min(Math.max(1, Math.floor(numCfg('START_MIN_PLAYERS'))), Math.max(1, config.MAX_PLAYERS));
  const countdownMs = Math.max(0, numCfg('START_COUNTDOWN_SECONDS')) * 1000;
  const graceMs = Math.max(0, numCfg('TRAVEL_GRACE_SECONDS')) * 1000;
  const fullCountdownMs = Math.max(0, numCfg('START_FULL_COUNTDOWN_SECONDS')) * 1000;
  const voteMin = Math.max(1, Math.floor(numCfg('VOTE_START_MIN_PLAYERS')));
  const voteCountdownMs = Math.max(0, numCfg('VOTE_START_COUNTDOWN_SECONDS')) * 1000;
  const hostOnlineMs = Math.max(0.01, numCfg('HOST_ONLINE_SECONDS')) * 1000;
  const emptyEndMs = Math.max(0, numCfg('EMPTY_END_SECONDS')) * 1000;
  const lateJoinMs = numCfg('LATE_JOIN_SECONDS') * 1000;   // hosted: 0 = never after the start, < 0 = always
  const publicHost = net.isIPv4(String(config.PUBLIC_HOST || '')) ? String(config.PUBLIC_HOST) : '';
  // What clients are told to connect to. A community host is always reached at its own address
  // (PUBLIC_HOST is the official pool's address).
  const hostFor = (s) => (s.hosted && s.hosted.community ? s.host : publicHost || s.host);
  // Per-host player cap (community hosts choose their own) and the matching start minimum.
  const maxFor = (s) => (s.hosted && s.hosted.maxPlayers) || config.MAX_PLAYERS;
  const minFor = (s) => Math.min(startMin, Math.max(1, maxFor(s)));
  const beaconUrl = () => config.BEACON_URL || publicHost || config.GAME_SERVER_HOST;

  const uname = (id) => getUname(id) || id;
  const newId = () => crypto.randomUUID(); // the client's JoinSession rejects ids without a hyphen
  const nak = (c, error) => c.sendMsg('nak', { error });

  // ---------- snapshots ----------
  function userData(opts) {
    const u = obj(obj(opts)['user-data']);
    return { set: str(u.set), char: str(u.char), outfit: str(u.outfit), var: str(u.var) };
  }

  function groupSnapshot(g) {
    const players = {};
    for (const [pid, p] of g.players) players[pid] = { user: { uname: p.uname }, connected: p.connected, opts: p.opts };
    return { group: { id: g.id, 'owner-id': g.ownerId, opts: g.opts, players } };
  }
  const emptyGroup = (id) => ({ group: { id: id || '', 'owner-id': '', opts: {}, players: {} } });

  // withHost=false gives the "found, waiting for session-started" form used by the find/join flows.
  // forHost=true is the game host's own view (GET /api/session/<id>): the configured host, not PUBLIC_HOST.
  function sessionObj(s, withHost, forHost = false) {
    const playerMap = {};
    for (const [pid, p] of s.players) playerMap[pid] = { uname: p.uname, 'auto-group': false };
    const grp = {};
    for (const [gid, list] of Object.entries(s.groups)) grp[gid] = { players: list.slice() };
    return {
      id: s.id, version: '1', name: s.name, description: s.description,
      host: withHost ? (forHost ? s.host : hostFor(s)) : '', port: withHost ? s.port : 0,
      opts: {
        'game-mode': s.opts.gameMode, 'game-mode-params': s.opts.gameModeParams,
        'min-players': s.hosted ? minFor(s) : config.MIN_PLAYERS, 'max-players': maxFor(s),
        map: s.opts.map, language: s.opts.language, 'has-auth': !!s.pass,
      },
      'player-map': playerMap, groups: grp, owner: s.owner,
    };
  }

  const tokenFor = (s, c) => (s.hosted ? makeSessionJwt(s.hosted, c.id) : s.token);
  const sendSession = (c, s, withHost = false) => c.sendMsg('session', { session: sessionObj(s, withHost), 'access-token': tokenFor(s, c) });
  const sendStarted = (c, s) => c.sendMsg('session-started', { id: s.id, host: hostFor(s), port: s.port });

  // ---------- groups ----------
  const groupOf = (c) => groups.get(c.groupId);
  function broadcastGroup(g, data, exceptId) {
    for (const pid of g.players.keys()) {
      if (pid !== exceptId && clients.has(pid)) clients.get(pid).sendMsg('group-event', { 'group-id': g.id, ...data });
    }
  }

  function dropGroup(g) {
    groups.delete(g.id);
    queue = queue.filter((e) => e.groupId !== g.id);
    for (const pid of g.players.keys()) { const c = clients.get(pid); if (c && c.groupId === g.id) c.groupId = null; }
  }

  // The doc has no "owner changed" event, so an owner leaving disbands the group (destroy);
  // a non-owner leaving is a plain leave.
  function leaveGroup(c) {
    const g = groupOf(c);
    c.groupId = null;
    if (!g) return null;
    if (g.ownerId === c.id) {
      g.players.delete(c.id);
      broadcastGroup(g, { event: 'destroy' });
      dropGroup(g);
    } else {
      g.players.delete(c.id);
      broadcastGroup(g, { event: 'leave', 'player-id': c.id });
    }
    return g;
  }

  function addToGroup(g, c, opts) {
    g.players.set(c.id, { uname: uname(c.id), connected: true, opts: userData(opts) });
    c.groupId = g.id;
  }

  // ---------- sessions ----------
  const sessionPlayers = (s) => s.players.size;

  function newSession(over) {
    const s = {
      id: newId(), name: 'SOS', description: '', host: config.GAME_SERVER_HOST, port: config.GAME_SERVER_PORT,
      opts: { gameMode: '', gameModeParams: '', map: '', language: '' },
      players: new Map(), groups: {}, owner: '', pass: '', public: false, matchmade: false, started: false,
      token: crypto.randomBytes(16).toString('hex'), createdAt: Date.now(), ...over,
    };
    sessions.set(s.id, s);
    return s;
  }

  // Public server list data (GET /servers): label overrides from /announce and the time of the host's last poll.
  // lastPollAny is never cleared by a reset (lastPoll is): the community registry uses it to expire silent hosts.
  const hostedMeta = new Map();
  // One persistent hosted session per entry (static pool entry or registered community host).
  function addHostedEntry(entry) {
    const s = newSession({
      id: entry.sessionId, name: 'Match', host: entry.host, port: entry.port, owner: 'system',
      matchmade: true, started: false, hosted: entry, token: entry.sessionToken,
    });
    s.countdownTimer = null; s.countdownEndsAt = null; s.countdownVote = false; s.countdownHeld = false; s.emptyTimer = null;
    s.state = 'waiting'; s.startedAt = null; s.endedAt = null; s.votes = new Set();
    hostedById.set(entry.sessionId, { s, entry });
    hostedMeta.set(entry.sessionId, { name: entry.name || DEFAULT_SERVER_NAME, region: entry.region || '', lastPoll: null, lastPollAny: null });
    return s;
  }
  for (const entry of hostEntries) addHostedEntry(entry);
  const hostedSession = () => (hostEntries.length ? hostedById.get(hostEntries[0].sessionId).s : null);

  // For the host's own GET /api/session/<id>: the live session plus the host's configured player ids
  // (every GET kicks players missing from player-map, including the host's own).
  function getHostedSession(id) {
    const h = hostedById.get(String(id));
    if (!h) return null;
    const session = sessionObj(h.s, true, true);
    for (const hid of h.entry.hostIds) session['player-map'][hid] ??= { uname: uname(hid), 'auto-group': false };
    // moderation: spectators/directors are allow-listed in player-map (the host kicks anyone missing) but never seated.
    const wlist = listWatchers(id);
    for (const wid of wlist) session['player-map'][wid] ??= { uname: uname(wid), 'auto-group': false };
    session['ogsos-watchers'] = wlist;
    return { session, token: h.entry.sessionToken };
  }

  // moderation: watchers (admin spectators) per hosted session, with an expiry; kept across match end, pruned when expired.
  const watchers = new Map();   // sessionId -> Map(playerId -> expiresAtMs)
  function addWatcher(id, playerId, ttlMs = 3 * 3600 * 1000) {
    if (!hostedById.has(String(id)) || !playerId) return null;
    const m = watchers.get(String(id)) || new Map();
    watchers.set(String(id), m);
    const expiresAt = Date.now() + ttlMs;
    m.set(String(playerId), expiresAt);
    return { expiresAt };
  }
  function removeWatcher(id, playerId) {
    const m = watchers.get(String(id));
    return !!m && m.delete(String(playerId));
  }
  function listWatchers(id) {
    const m = watchers.get(String(id));
    if (!m) return [];
    const t = Date.now();
    for (const [pid, exp] of m) if (exp <= t) m.delete(pid);
    return [...m.keys()];
  }
  function watcherExpiry(id, playerId) {
    const m = watchers.get(String(id));
    const e = m && m.get(String(playerId));
    return e && e > Date.now() ? e : null;
  }
  function watchToken(id, playerId) {
    const h = hostedById.get(String(id));
    if (!h || !watcherExpiry(id, playerId)) return null;
    return makeSessionJwt(h.entry, playerId);
  }

  // The host's authenticated GET /api/session/<id> poll (called by server.js after the token check).
  // A host is online while its last authenticated poll is within HOST_ONLINE_SECONDS (reset forgets the poll).
  function hostOnline(id, now = Date.now()) {
    const m = hostedMeta.get(String(id));
    return !!m && m.lastPoll !== null && now - m.lastPoll <= hostOnlineMs;
  }
  function markHostPolled(id) {
    const m = hostedMeta.get(String(id));
    if (!m) return false;
    const wasOnline = hostOnline(id);
    m.lastPoll = m.lastPollAny = Date.now();
    if (!wasOnline) {
      // Offline -> online: finish a countdown that was held while the host was away, then seat waiting players.
      const s = hostedById.get(String(id)).s;
      if (s.countdownHeld) setCountdown(s, fullCountdownMs, 'host back online');
      if (pumpHosted()) sendSummary();
    }
    return true;
  }
  // POST /announce: override name and/or region in memory (invalid or empty values are ignored).
  function announceHosted(id, { name, region } = {}) {
    const m = hostedMeta.get(String(id));
    if (!m) return null;
    const n = cleanLabel(name, 48), r = cleanLabel(region, 16);
    if (n) m.name = n;
    if (typeof region === 'string') m.region = r;   // an explicit empty region clears it
    return { name: m.name, region: m.region };
  }
  // Public view of every hosted session; never contains a token.
  function listHosted() {
    const now = Date.now();
    return [...hostedById.values()].map(({ s, entry }) => {
      const m = hostedMeta.get(entry.sessionId);
      const last = m.lastPoll;
      return {
        id: entry.sessionId, name: m.name, region: m.region, host: entry.host, port: entry.port,
        online: hostOnline(entry.sessionId, now),
        lastSeenSec: last === null ? null : Math.floor((now - last) / 1000),
        players: [...s.players.keys()].filter((pid) => !entry.hostIds.includes(pid)).length,
        minPlayers: minFor(s), maxPlayers: maxFor(s),
        state: s.state, countdownEndsAt: s.countdownTimer ? s.countdownEndsAt : null,
        votes: s.votes.size, lateJoinOpen: hostedOpen(s),
        startedAt: s.startedAt, endedAt: s.endedAt,
        map: s.opts.map || '',
        publicHost: entry.community ? '' : publicHost,
        community: !!entry.community, verified: !!entry.verified,
      };
    });
  }

  // ---------- community hosts (registered at runtime, see server/community.js) ----------
  const isCommunityHost = (id) => { const h = hostedById.get(String(id)); return h && h.entry.community ? h.entry : null; };
  const lastPollOf = (id) => { const m = hostedMeta.get(String(id)); return m ? m.lastPollAny : null; };

  function addCommunityHost({ host, port, sessionId, sessionToken, hostIds, name, region, maxPlayers, verified }) {
    if (hostedById.has(String(sessionId)) || sessions.has(String(sessionId))) throw new Error('session id exists');
    const entry = {
      host, port, sessionId, sessionToken, hostIds: Array.isArray(hostIds) ? hostIds.map(String) : [],
      name: cleanLabel(name, 48) || DEFAULT_SERVER_NAME, region: cleanLabel(region, 16),
      community: true, verified: !!verified, maxPlayers: clampMax(maxPlayers),
    };
    addHostedEntry(entry);
    log(`community host ${sessionId} added (${host}:${port})`);
    return sessionId;
  }
  const clampMax = (v) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(config.MAX_PLAYERS, Math.max(2, n)) : config.MAX_PLAYERS;
  };
  // Re-registration: new address / labels / limits, session state and seated players are kept.
  function updateCommunityHost(id, { host, port, name, region, maxPlayers, verified, hostIds } = {}) {
    const h = hostedById.get(String(id));
    if (!h || !h.entry.community) return false;
    const e = h.entry, m = hostedMeta.get(e.sessionId);
    if (host !== undefined) { e.host = host; h.s.host = host; }
    if (port !== undefined) { e.port = port; h.s.port = port; }
    if (name !== undefined) { e.name = m.name = cleanLabel(name, 48) || DEFAULT_SERVER_NAME; }
    if (region !== undefined) { e.region = m.region = cleanLabel(region, 16); }
    if (maxPlayers !== undefined) e.maxPlayers = clampMax(maxPlayers);
    if (verified !== undefined) e.verified = !!verified;
    if (Array.isArray(hostIds)) e.hostIds = hostIds.map(String);
    return true;
  }
  // Remove a community host: seated players get session-closed (as in endSession), timers and join hints go too.
  function removeCommunityHost(id, why = 'removed') {
    const h = hostedById.get(String(id));
    if (!h || !h.entry.community) return null;
    const s = h.s;
    cancelCountdown(s);
    if (s.emptyTimer) { clearTimeout(s.emptyTimer); s.emptyTimer = null; }
    const ids = [...s.players.keys()];
    for (const pid of ids) {
      const p = s.players.get(pid);
      if (p.graceTimer) clearTimeout(p.graceTimer);
      const c = clients.get(pid);
      if (c && c.sessionId === s.id) { c.sessionId = null; c.sendMsg('session-closed', { id: s.id }); }
    }
    s.players.clear(); s.groups = {}; s.votes.clear();
    s.started = false; s.state = 'ended'; s.endedAt = Date.now();
    for (const [pid, hint] of joinHints) if (hint.id === s.id) joinHints.delete(pid);
    hostedById.delete(s.id); hostedMeta.delete(s.id); sessions.delete(s.id);
    const msg = `mm community host ${s.id} removed (${why}, ${ids.length} player(s) released)`;
    console.log(msg); log(msg);
    return ids.length;
  }

  function addPlayerToSession(s, c, groupId, notifyIds = s.players.keys()) {
    // Tell the players already inside (notifyIds) before adding the newcomer.
    for (const pid of [...notifyIds]) {
      const o = clients.get(pid);
      if (o && o !== c) o.sendMsg('player-join', { id: s.id, 'player-id': c.id, uname: uname(c.id) });
    }
    s.players.set(c.id, { uname: uname(c.id), graceTimer: null });
    c.sessionId = s.id;
    if (groupId) (s.groups[groupId] ??= []).push(c.id);
  }

  // Remove a player (by account id) from a session and tell the others. Timers of a hosted seat are cleared.
  function removeSeat(s, pid) {
    const p = s.players.get(pid);
    if (!p) return false;
    if (p.graceTimer) clearTimeout(p.graceTimer);
    s.players.delete(pid);
    for (const [gid, list] of Object.entries(s.groups)) {
      s.groups[gid] = list.filter((x) => x !== pid);
      if (!s.groups[gid].length) delete s.groups[gid];
    }
    if (s.hosted) {
      s.votes.delete(pid);
      for (const o of s.players.keys()) clients.get(o)?.sendMsg('player-leave', { id: s.id, 'player-id': pid });
      afterSeatChange(s);   // may cancel the countdown; the fixed session outlives its players
      return true;
    }
    if (!s.players.size) { sessions.delete(s.id); return true; }
    if (s.owner === pid) s.owner = s.players.keys().next().value;
    for (const o of s.players.keys()) clients.get(o)?.sendMsg('player-leave', { id: s.id, 'player-id': pid });
    return true;
  }

  function leaveSession(c) {
    const s = sessions.get(c.sessionId);
    c.sessionId = null;
    if (!s) return;
    removeSeat(s, c.id);
  }

  // ---------- hosted-session start gate ----------
  // Players seated before the start only get `session`; session-started goes out to everyone when the
  // countdown (begun once START_MIN_PLAYERS are seated) ends, or on a forced start. Later joiners get both.
  function sendWaitingSummary(s) {
    const data = { players: { playing: 0, waiting: s.players.size } };
    for (const pid of s.players.keys()) clients.get(pid)?.sendMsg('summary', data);
  }

  function cancelCountdown(s) {
    s.countdownVote = false; s.countdownEndsAt = null; s.countdownHeld = false;
    if (s.countdownTimer) { clearTimeout(s.countdownTimer); s.countdownTimer = null; log(`session ${s.id}: start countdown cancelled`); }
  }

  // Start (or shorten) the start countdown; a running countdown is never lengthened.
  // A countdown that ends while the host is offline is held (state stays 'countdown') until the host polls again.
  function setCountdown(s, ms, why) {
    if (ms <= 0) {
      if (!hostOnline(s.id)) { s.countdownHeld = true; s.state = 'countdown'; return; }
      startSession(s, why); return;
    }
    s.countdownHeld = false;
    const end = Date.now() + ms;
    if (s.countdownTimer && s.countdownEndsAt <= end) return;
    if (s.countdownTimer) clearTimeout(s.countdownTimer);
    s.countdownEndsAt = end;
    s.state = 'countdown';
    s.countdownTimer = setTimeout(() => {
      s.countdownTimer = null;
      if (!hostOnline(s.id)) { s.countdownHeld = true; log(`session ${s.id}: countdown ended while the host is offline, holding`); return; }
      startSession(s, 'countdown ended');
    }, ms);
    s.countdownTimer.unref();
    const msg = `mm hosted session ${s.id}: ${s.players.size}/${startMin} players, starting in ${ms / 1000}s (${why})`;
    console.log(msg); log(msg);
  }

  // A started session with nobody seated for EMPTY_END_SECONDS is over.
  function updateEmptyTimer(s) {
    const need = s.state === 'started' && !s.players.size && emptyEndMs > 0;
    if (!need) { if (s.emptyTimer) { clearTimeout(s.emptyTimer); s.emptyTimer = null; } return; }
    if (s.emptyTimer) return;
    s.emptyTimer = setTimeout(() => {
      s.emptyTimer = null;
      if (s.state === 'started' && !s.players.size) endSession(s, 'empty');
    }, emptyEndMs);
    s.emptyTimer.unref();
  }

  function startSession(s, why) {
    if (s.state === 'ended') return 0;
    cancelCountdown(s);
    if (s.started) return s.players.size;
    s.started = true; s.state = 'started'; s.startedAt = Date.now(); s.votes.clear();
    for (const pid of s.players.keys()) { const c = clients.get(pid); if (c) sendStarted(c, s); }
    updateEmptyTimer(s);
    const msg = `mm hosted session ${s.id} started (${why}) with ${s.players.size} player(s) -> ${hostFor(s)}:${s.port}`;
    console.log(msg); log(msg);
    return s.players.size;
  }

  // Match over: tell the seated players (session-closed, as a reset does) and refuse new seats until reset.
  function endSession(s, why) {
    if (s.state === 'ended') return 0;
    cancelCountdown(s);
    if (s.emptyTimer) { clearTimeout(s.emptyTimer); s.emptyTimer = null; }
    const ids = [...s.players.keys()];
    for (const pid of ids) {
      const p = s.players.get(pid);
      if (p.graceTimer) clearTimeout(p.graceTimer);
      const c = clients.get(pid);
      if (c && c.sessionId === s.id) { c.sessionId = null; c.sendMsg('session-closed', { id: s.id }); }
    }
    s.players.clear(); s.groups = {}; s.votes.clear();
    s.started = false; s.state = 'ended'; s.endedAt = Date.now();
    const msg = `mm hosted session ${s.id} ended (${why}, ${ids.length} player(s) released)`;
    console.log(msg); log(msg);
    return ids.length;
  }

  // Majority of seated players voted to start (needs VOTE_START_MIN_PLAYERS seated).
  const voteNeeded = (s) => Math.floor(s.players.size / 2) + 1;
  const voteOk = (s) => s.players.size >= voteMin && s.votes.size >= voteNeeded(s);

  function afterSeatChange(s) {
    if (!s.hosted) return;
    if (s.state === 'ended') return;
    updateEmptyTimer(s);
    if (s.started) return;
    const n = s.players.size;
    const auto = n >= minFor(s);
    const vote = voteOk(s);
    if (vote) { s.countdownVote = true; setCountdown(s, voteCountdownMs, 'vote'); }
    if (s.state === 'ended' || s.started) return;
    if (auto) {
      setCountdown(s, countdownMs, 'minimum players reached');
      if (s.started) return;
      if (n >= maxFor(s) && s.countdownTimer) setCountdown(s, fullCountdownMs, 'session full');
    } else if (!vote && !(s.countdownVote && n >= voteMin)) cancelCountdown(s);
    if (s.started) return;
    if (!s.countdownTimer && !s.countdownHeld) s.state = 'waiting';
    sendWaitingSummary(s);
  }

  // Vote to start the match. Returns { error } (not-found | not-seated | closed) or { votes, needed, players, state }.
  function voteStartHosted(id, playerId) {
    const h = hostedById.get(String(id));
    if (!h) return { error: 'not-found' };
    const s = h.s, pid = String(playerId);
    if (!s.players.has(pid)) return { error: 'not-seated' };
    if (s.state !== 'waiting' && s.state !== 'countdown') return { error: 'closed', state: s.state };
    s.votes.add(pid);
    log(`${pid} voted to start ${s.id} (${s.votes.size}/${voteNeeded(s)})`);
    afterSeatChange(s);
    return { votes: s.votes.size, needed: voteNeeded(s), players: s.players.size, state: s.state };
  }


  // Seat of a hosted session whose WS closed: keep it for the grace period (see onClose).
  function holdSeat(s, c) {
    const p = s.players.get(c.id);
    if (!p) return;
    if (p.graceTimer) clearTimeout(p.graceTimer);
    p.graceTimer = setTimeout(() => {
      p.graceTimer = null;
      if (s.players.get(c.id) === p) { log(`travel grace expired for ${c.id} in ${s.id}`); removeSeat(s, c.id); }
    }, graceMs);
    p.graceTimer.unref();
  }

  // A reconnecting account silently takes its seat back (nothing is resent; get-session returns the session).
  function reattach(c) {
    for (const { s } of hostedById.values()) {
      const p = s.players.get(c.id);
      if (!p) continue;
      if (p.graceTimer) { clearTimeout(p.graceTimer); p.graceTimer = null; }
      c.sessionId = s.id;
      log(`${c.id} reattached to hosted session ${s.id}`);
      return;
    }
  }

  function resetHosted(id) {
    const h = hostedById.get(String(id));
    if (!h) return null;
    const s = h.s;
    cancelCountdown(s);
    if (s.emptyTimer) { clearTimeout(s.emptyTimer); s.emptyTimer = null; }
    const ids = [...s.players.keys()];
    for (const pid of ids) {
      const p = s.players.get(pid);
      if (p.graceTimer) clearTimeout(p.graceTimer);
      const c = clients.get(pid);
      if (c && c.sessionId === s.id) { c.sessionId = null; c.sendMsg('session-closed', { id: s.id }); }
    }
    s.players.clear(); s.groups = {}; s.started = false; s.votes.clear();
    s.state = 'waiting'; s.startedAt = null; s.endedAt = null;
    hostedMeta.get(s.id).lastPoll = null;   // the game restarts: offline until its next poll
    log(`hosted session ${s.id} reset (${ids.length} player(s) cleared)`);
    // Players who were kept waiting (late joiners) go into the fresh lobby.
    if (pumpHosted()) sendSummary();
    return ids.length;
  }
  // Moderation kick: take a player's seat in a hosted session. The host's next session poll no longer lists them,
  // so the game removes them ("Not In Session"). Returns { result: true } or { error: 'not-found' | 'not-seated' }.
  function kickHosted(id, playerId) {
    const h = hostedById.get(String(id));
    if (!h) return { error: 'not-found' };
    const s = h.s, pid = String(playerId);
    if (!s.players.has(pid)) return { error: 'not-seated' };
    removeSeat(s, pid);
    const c = clients.get(pid);
    if (c && c.sessionId === s.id) {
      c.sessionId = null;
      c.sendMsg('player-leave', { id: s.id, 'player-id': pid });
    }
    sendSummary();
    log(`kicked ${pid} from hosted session ${s.id}`);
    return { result: true };
  }
  const endHosted = (id) => { const h = hostedById.get(String(id)); return h ? endSession(h.s, 'host') : null; };
  const forceStartHosted = (id) => { const h = hostedById.get(String(id)); return h ? startSession(h.s, 'forced') : null; };
  const forceStartAll = () => [...hostedById.values()].map(({ s }) => ({ id: s.id, players: startSession(s, 'forced') }));

  // ---------- queue / matching ----------
  const entryClients = (e) => {
    if (e.kind === 'solo') return [e.client];
    const g = groups.get(e.groupId);
    return g ? [...g.players.keys()].map((p) => clients.get(p)).filter(Boolean) : [];
  };
  const entryCount = (e) => Math.max(1, entryClients(e).length);
  const queuePlayers = () => queue.reduce((n, e) => n + entryClients(e).length, 0);
  const playingCount = () => [...sessions.values()].reduce((n, s) => n + sessionPlayers(s), 0);

  function sendSummary() {
    const data = { players: { playing: playingCount(), waiting: queuePlayers() } };
    for (const e of queue) for (const c of entryClients(e)) c.sendMsg('summary', data);
  }

  // Add everyone first so every snapshot is complete, then tell the newcomers.
  function seat(s, entries) {
    const joined = [];
    const before = [...s.players.keys()];  // only these get player-join
    for (const entry of entries) {
      for (const c of entryClients(entry)) {
        leaveSession(c);
        addPlayerToSession(s, c, entry.kind === 'group' ? entry.groupId : null, before);
        joined.push(c);
      }
    }
    for (const c of joined) { sendSession(c, s, true); if (!s.hosted || s.started) sendStarted(c, s); }
    if (s.hosted) afterSeatChange(s);
  }

  function createMatch(batch, target) {
    const first = obj(batch[0].opts);
    const live = target || (hostEntries.length ? pickHosted(batch.reduce((n, e) => n + entryCount(e), 0), batch.length === 1 ? batch[0] : null) : null);
    if (live) {
      if (!live.players.size) live.opts = { gameMode: str(first['game-mode']), gameModeParams: '', map: str(first.map), language: str(first.language) };
      seat(live, batch);
      console.log(`mm hosted session ${live.id} now has ${live.players.size} player(s) -> ${live.host}:${live.port}`);
      return live;
    }
    const s = newSession({
      name: 'Match', matchmade: true, started: true,
      opts: { gameMode: str(first['game-mode']), gameModeParams: '', map: str(first.map), language: str(first.language) },
    });
    seat(s, batch);
    console.log(`mm session ${s.id} created with ${s.players.size} player(s) -> ${s.host}:${s.port}`);
    return s;
  }

  // A matchmade session that is still young and has room takes newly queued players straight away.
  function findOpenSession(count, entry) {
    // A join hint (client mod server list) works with or without a static pool, and is the only way into a community lobby.
    const hinted = hintTarget(count, entry);
    if (hinted) { dropHints(entry); return hinted; }
    const want = hintFor(entry);
    if (want) { const w = hostedById.get(want); if (!w || w.entry.community) dropHints(entry); }   // full/closed community lobby: normal behaviour
    if (hostEntries.length) return pickHosted(count, entry);
    const now = Date.now();
    for (const s of sessions.values()) {
      if (!s.hosted && s.matchmade && now - s.createdAt < config.LATE_JOIN_SECONDS * 1000 && s.players.size + count <= config.MAX_PLAYERS) return s;
    }
    return null;
  }

  // Can new players be seated into this hosted session right now? (not ended; after the start only inside LATE_JOIN_SECONDS)
  function hostedOpen(s) {
    if (s.state === 'ended') return false;
    if (s.state !== 'started') return true;
    return lateJoinMs < 0 || (lateJoinMs > 0 && Date.now() - s.startedAt < lateJoinMs);
  }

  // Pool choice (online lobbies only): the fullest open lobby (waiting/countdown) that has room, else an idle waiting one,
  // else a started session still inside its late-join window (fullest first).
  // Join hints: a player picked a lobby in the client mod's server list (POST /api/servers/<id>/join-hint).
  // pid -> { id, until }; used by pickHosted for that player's next find-session, then dropped.
  const JOIN_HINT_MS = 120000;
  const joinHints = new Map();
  function setJoinHint(id, playerId) {
    const h = hostedById.get(String(id));
    if (!h) return { error: 'not-found' };
    const s = h.s;
    if (!hostOnline(s.id)) return { error: 'offline' };
    if (!hostedOpen(s)) return { error: 'closed', state: s.state };
    joinHints.set(String(playerId), { id: s.id, until: Date.now() + JOIN_HINT_MS });
    log(`${playerId} picked hosted session ${s.id}`);
    return { id: s.id, state: s.state, players: s.players.size, maxPlayers: maxFor(s) };
  }
  function hintFor(e) {
    if (!e) return null;
    for (const c of entryClients(e)) {
      const hint = joinHints.get(String(c.id));
      if (!hint) continue;
      if (hint.until < Date.now()) { joinHints.delete(String(c.id)); continue; }
      return hint.id;
    }
    return null;
  }

  // The hinted hosted session when it is online, open and has room for `count` more, else null.
  function hintTarget(count, entry) {
    const want = hintFor(entry);
    const h = want && hostedById.get(want);
    return h && hostOnline(h.s.id) && hostedOpen(h.s) && h.s.players.size + count <= maxFor(h.s) ? h.s : null;
  }
  const dropHints = (entry) => { for (const c of entryClients(entry)) joinHints.delete(String(c.id)); };

  function pickHosted(count, entry) {
    const hinted = hintTarget(count, entry);
    if (hinted) { dropHints(entry); return hinted; }
    let best = null, bestRank = -1;
    for (const { s, entry: he } of hostedById.values()) {
      if (he.community) continue;   // community lobbies are never auto-seated, only reached through a join hint
      if (!hostOnline(s.id) || !hostedOpen(s) || s.players.size + count > maxFor(s)) continue;
      const rank = s.state === 'started' ? 1 + s.players.size / 1000
        : s.players.size > 0 ? 10 + s.players.size : 5;
      if (rank > bestRank) { best = s; bestRank = rank; }
    }
    return best;
  }

  // Seat queued players into whichever hosted sessions are open. Returns true if anyone was seated.
  function pumpHosted() {
    let matched = false;
    for (const e of [...queue]) {
      const target = pickHosted(entryCount(e), e);
      if (!target) continue;
      queue = queue.filter((x) => x !== e);
      createMatch([e], target);
      matched = true;
    }
    return matched;
  }

  function pumpQueue() {
    if (hostEntries.length) { if (pumpHosted()) sendSummary(); return; }   // the host's own start gate is the lobby
    let matched = false;
    while (queue.length) {
      const oldest = Date.now() - queue[0].since;
      if (!(queuePlayers() >= config.MIN_PLAYERS || oldest >= config.QUEUE_TIMEOUT * 1000)) break;
      const batch = []; let n = 0;
      for (const e of queue) {
        const k = entryCount(e);
        if (n > 0 && n + k > config.MAX_PLAYERS) continue;
        batch.push(e); n += k;
        if (n >= config.MAX_PLAYERS) break;
      }
      queue = queue.filter((e) => !batch.includes(e));
      createMatch(batch);
      matched = true;
    }
    if (matched) sendSummary();
  }

  function scheduleMatch() {
    if (batchTimer) return;
    batchTimer = setTimeout(() => { batchTimer = null; pumpQueue(); }, config.MATCH_BATCH_MS);
  }
  const tick = setInterval(pumpQueue, 1000);
  tick.unref();

  function enqueue(entry, count) {
    const open = findOpenSession(count, entry);
    if (open) { if (open.hosted) createMatch([entry], open); else seat(open, [entry]); return; }
    queue.push(entry);
    sendSummary();
    if (queuePlayers() >= config.MIN_PLAYERS) scheduleMatch();
  }

  function unqueueClient(c) { queue = queue.filter((e) => e.client !== c); }

  // ---------- lifecycle ----------
  function onConnect(c) {
    const old = clients.get(c.id);
    if (old) { nak(old, 'concurrent-client-connection'); onClose(old); old.close(); }
    clients.set(c.id, c);
    c.groupId = null; c.sessionId = null; c.gone = false;
    c.sendMsg('ready');
    reattach(c);
  }

  function onClose(c) {
    if (c.gone) return;
    c.gone = true;
    unqueueClient(c);
    leaveGroup(c);
    const hs = sessions.get(c.sessionId);
    if (hs && hs.hosted && graceMs > 0) { c.sessionId = null; holdSeat(hs, c); }
    else leaveSession(c);
    if (clients.get(c.id) === c) clients.delete(c.id);
    sendSummary();
  }

  // ---------- request handlers ----------
  const handlers = {
    ping: (c) => c.sendMsg('pong'),

    'get-regions': (c) => c.sendMsg('regions', { [config.REGION_NAME]: { 'beacon-url': beaconUrl() } }),

    'create-group': (c, d) => {
      if (c.groupId) return nak(c, 'in-other-group');
      const go = obj(d['group-opts']), po = obj(d.opts);
      const g = {
        id: newId(), ownerId: c.id, players: new Map(), queued: false,
        opts: {
          map: str(go.map) || str(po.map), language: str(go.language) || str(po.language),
          'group-type': str(go['group-type']), 'game-mode': str(go['game-mode']) || str(po['game-mode']),
          'auto-group': !!(go['auto-group'] ?? po['auto-group']),
        },
      };
      groups.set(g.id, g);
      addToGroup(g, c, po);
      c.sendMsg('group', groupSnapshot(g));
    },

    'join-group': (c, d) => {
      const g = groups.get(str(d['group-id']));
      if (!g) return nak(c, 'not-found');
      if (c.groupId === g.id) return c.sendMsg('group', groupSnapshot(g));
      if (c.groupId) return nak(c, 'in-other-group');
      if (g.players.size >= config.GROUP_MAX_SIZE) return nak(c, 'group-full');
      addToGroup(g, c, d.opts);
      broadcastGroup(g, { event: 'join', 'player-id': c.id, uname: uname(c.id) }, c.id);
      c.sendMsg('group', groupSnapshot(g));
    },

    'get-group': (c) => {
      const g = groupOf(c);
      return g ? c.sendMsg('group', groupSnapshot(g)) : nak(c, 'not-found');
    },

    'leave-group': (c, d) => {
      const wanted = str(d['group-id']);
      if (wanted && c.groupId && wanted !== c.groupId) return c.sendMsg('group', emptyGroup(wanted));
      const g = leaveGroup(c);
      c.sendMsg('group', emptyGroup(g ? g.id : wanted));
    },

    'leave-all-groups': (c) => {
      const g = leaveGroup(c);
      c.sendMsg('ack'); // the client expects ack here; a group reply logs "unexpected packet"
    },

    'kick-from-group': (c, d) => {
      const g = groups.get(str(d['group-id'])) || groupOf(c);
      const pid = str(d['player-id']);
      if (!g || !g.players.has(pid)) return nak(c, 'not-found');
      if (g.ownerId !== c.id) return nak(c, 'unauthorized');
      if (pid === c.id) return nak(c, 'other');
      const target = clients.get(pid);
      g.players.delete(pid);
      if (target) { target.groupId = null; target.sendMsg('group-event', { 'group-id': g.id, event: 'leave', 'player-id': pid }); }
      broadcastGroup(g, { event: 'leave', 'player-id': pid });
      c.sendMsg('ack');
    },

    'find-session': (c, d) => {
      unqueueClient(c);
      leaveSession(c);
      c.sendMsg('ack');
      enqueue({ kind: 'solo', client: c, opts: obj(d.opts), since: Date.now() }, 1);
    },

    'cancel-find-session': (c) => {
      unqueueClient(c);
      const s = sessions.get(c.sessionId);
      if (s && s.hosted) leaveSession(c);   // seated in the hosted session, waiting for the start
      sendSummary(); c.sendMsg('ack');
    },

    'group-find-session': (c, d) => {
      const g = groupOf(c);
      if (!g) return nak(c, 'not-found');
      const wasQueued = queue.some((e) => e.groupId === g.id);
      queue = queue.filter((e) => e.groupId !== g.id);
      c.sendMsg('ack');
      if (!wasQueued) broadcastGroup(g, { event: 'queue' }, c.id);
      enqueue({ kind: 'group', groupId: g.id, opts: { ...g.opts, ...obj(d.opts) }, since: Date.now() }, g.players.size);
    },

    'cancel-group-find-session': (c) => {
      const g = groupOf(c);
      const wasQueued = !!g && queue.some((e) => e.groupId === g.id);
      if (g) {
        queue = queue.filter((e) => e.groupId !== g.id);
        for (const pid of g.players.keys()) {
          const m = clients.get(pid), ms = m && sessions.get(m.sessionId);
          if (ms && ms.hosted && !ms.started) leaveSession(m);
        }
      }
      sendSummary();
      c.sendMsg('ack');
      if (wasQueued) broadcastGroup(g, { event: 'queue-cancel' }, c.id);
    },

    // Sessions are returned with a real host so the op completes at once.
    'get-session': (c) => {
      const s = sessions.get(c.sessionId);
      return s ? sendSession(c, s, true) : nak(c, 'not-found');
    },

    sessions: (c) => {
      const list = [...sessions.values()].filter((s) => s.public && s.players.size < config.MAX_PLAYERS).map((s) => sessionObj(s, true));
      c.sendMsg('session-list', list);
    },

    'create-session': (c, d) => {
      const o = obj(d.opts);
      leaveSession(c);
      const s = newSession({
        name: str(d.name) || 'Custom', description: str(d.description), pass: str(d.pass), public: !!o.public,
        owner: c.id, opts: { gameMode: str(o['game-mode']), gameModeParams: str(o['game-mode-params']), map: str(o.map), language: str(o.language) },
      });
      addPlayerToSession(s, c, null);
      sendSession(c, s, false);   // create-session only accepts `session`
    },

    'join-session': (c, d) => {
      const s = sessions.get(str(d['session-id']));
      if (!s) return nak(c, 'not-found');
      if (s.pass && s.pass !== str(d.pass)) return nak(c, 'unauthorized');
      if (c.sessionId !== s.id) {
        if (s.players.size >= maxFor(s) || (s.hosted && !hostedOpen(s))) return nak(c, 'other');
        unqueueClient(c);
        leaveSession(c);
        addPlayerToSession(s, c, null);
      }
      c.sendMsg('ack');
      sendSession(c, s, false);
      if (s.started) sendStarted(c, s);
    },

    // Vote to start the match (hosted sessions); same rule as POST /api/session/<id>/vote-start.
    'vote-start': (c) => {
      const s = sessions.get(c.sessionId);
      if (!s || !s.hosted) return nak(c, 'not-found');
      const r = voteStartHosted(s.id, c.id);
      if (r.error) return nak(c, r.error === 'not-seated' ? 'unauthorized' : 'other');
      c.sendMsg('ack');
    },

    'leave-session': (c, d) => {
      const id = str(d['session-id']);
      if (id && c.sessionId && id !== c.sessionId) return nak(c, 'not-found');
      leaveSession(c);
      sendSummary();
      c.sendMsg('ack');
    },

    'kick-from-session': (c, d) => {
      const s = sessions.get(str(d['session-id'])) || sessions.get(c.sessionId);
      const pid = str(d['player-id']);
      if (!s || !s.players.has(pid)) return nak(c, 'not-found');
      if (s.owner !== c.id) return nak(c, 'unauthorized');
      const target = clients.get(pid);
      if (target) { leaveSession(target); target.sendMsg('session-closed', { id: s.id }); }
      c.sendMsg('ack');
    },

    'start-session': (c, d) => {
      const s = sessions.get(str(d['session-id'])) || sessions.get(c.sessionId);
      if (!s || !s.players.has(c.id)) return nak(c, 'not-found');
      if (s.owner && s.owner !== c.id) return nak(c, 'unauthorized');
      c.sendMsg('ack');
      const first = !s.started;
      s.started = true;
      const targets = first ? [...s.players.keys()].map((p) => clients.get(p)).filter(Boolean) : [c];
      for (const t of targets) sendStarted(t, s);
    },
  };

  function onMessage(c, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { msg = null; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      log(`unparseable message from ${c.id}: ${String(text).slice(0, 200)}`);
      return nak(c, 'other');
    }
    const h = Object.prototype.hasOwnProperty.call(handlers, msg.type) ? handlers[msg.type] : null;
    if (!h) {
      log(`unknown request type "${msg.type}" from ${c.id}: ${String(text).slice(0, 200)}`);
      return nak(c, 'not-found');
    }
    try { h(c, obj(msg.data)); }
    catch (e) { log(`handler ${msg.type} threw: ${e.stack || e}`); nak(c, 'other'); }
  }

  function shutdown() {
    clearInterval(tick); clearTimeout(batchTimer);
    for (const { s } of hostedById.values()) { cancelCountdown(s); clearTimeout(s.emptyTimer); for (const p of s.players.values()) clearTimeout(p.graceTimer); }
  }

  return { onConnect, onMessage, onClose, shutdown, getHostedSession, addWatcher, removeWatcher, listWatchers, watcherExpiry, watchToken, kickHosted, hostOnline, addCommunityHost, updateCommunityHost, removeCommunityHost, isCommunityHost, lastPollOf, markHostPolled, announceHosted, listHosted, resetHosted, endHosted, voteStartHosted, setJoinHint, forceStartHosted, forceStartAll, publicHost, _state: { clients, groups, sessions, get queue() { return queue; } } };
}

module.exports = { cleanLabel, parseHosts, pickPublicHost, makeSessionJwt, readSessionJwt, loadConfig, createMatchmaker, DEFAULTS };
