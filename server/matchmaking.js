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
  BEACON_URL: '',              // ping target for the region ('' = use GAME_SERVER_HOST)
  GAME_SERVER_HOST: '127.0.0.1', // IPv4 literal handed to clients in session-started
  GAME_SERVER_PORT: 7777,
  MIN_PLAYERS: 1,              // queued players needed to start a match immediately
  MAX_PLAYERS: 16,             // players per session
  QUEUE_TIMEOUT: 20,           // seconds; after this a match starts with whoever is queued (>= 1 player)
  MATCH_BATCH_MS: 300,         // wait this long after the queue becomes matchable so near-simultaneous players share a session
  LATE_JOIN_SECONDS: 60,       // a matchmade session accepts newly queued players for this long
  GROUP_MAX_SIZE: 8,           // players per group
};

function loadConfig(dataDir, env = process.env, warn = console.warn) {
  const cfg = { ...DEFAULTS };
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') warn(`data/config.json ignored: ${e.message}`); }
  for (const key of Object.keys(DEFAULTS)) {
    let v = env[`OGSOS_${key}`] !== undefined ? env[`OGSOS_${key}`] : file[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof DEFAULTS[key] === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) { warn(`config ${key}: not a number, using default`); continue; }
    } else v = String(v);
    cfg[key] = v;
  }
  if (!net.isIPv4(cfg.GAME_SERVER_HOST)) {
    warn(`config GAME_SERVER_HOST "${cfg.GAME_SERVER_HOST}" is not an IPv4 literal (the client does no DNS); using 127.0.0.1`);
    cfg.GAME_SERVER_HOST = '127.0.0.1';
  }
  if (!cfg.BEACON_URL) cfg.BEACON_URL = cfg.GAME_SERVER_HOST;
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

  const uname = (id) => getUname(id) || id;
  const newId = () => crypto.randomBytes(6).toString('hex');
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
  function sessionObj(s, withHost) {
    const playerMap = {};
    for (const [pid, p] of s.players) playerMap[pid] = { uname: p.uname, 'auto-group': false };
    const grp = {};
    for (const [gid, list] of Object.entries(s.groups)) grp[gid] = { players: list.slice() };
    return {
      id: s.id, version: '1', name: s.name, description: s.description,
      host: withHost ? s.host : '', port: withHost ? s.port : 0,
      opts: {
        'game-mode': s.opts.gameMode, 'game-mode-params': s.opts.gameModeParams,
        'min-players': config.MIN_PLAYERS, 'max-players': config.MAX_PLAYERS,
        map: s.opts.map, language: s.opts.language, 'has-auth': !!s.pass,
      },
      'player-map': playerMap, groups: grp, owner: s.owner,
    };
  }

  const sendSession = (c, s, withHost = false) => c.sendMsg('session', { session: sessionObj(s, withHost), 'access-token': s.token });
  const sendStarted = (c, s) => c.sendMsg('session-started', { id: s.id, host: s.host, port: s.port });

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

  function addPlayerToSession(s, c, groupId, notifyIds = s.players.keys()) {
    // Tell the players already inside (notifyIds) before adding the newcomer.
    for (const pid of [...notifyIds]) {
      const o = clients.get(pid);
      if (o && o !== c) o.sendMsg('player-join', { id: s.id, 'player-id': c.id, uname: uname(c.id) });
    }
    s.players.set(c.id, { uname: uname(c.id) });
    c.sessionId = s.id;
    if (groupId) (s.groups[groupId] ??= []).push(c.id);
  }

  function leaveSession(c) {
    const s = sessions.get(c.sessionId);
    c.sessionId = null;
    if (!s || !s.players.delete(c.id)) return;
    for (const [gid, list] of Object.entries(s.groups)) {
      s.groups[gid] = list.filter((p) => p !== c.id);
      if (!s.groups[gid].length) delete s.groups[gid];
    }
    if (!s.players.size) { sessions.delete(s.id); return; }
    if (s.owner === c.id) s.owner = s.players.keys().next().value;
    for (const pid of s.players.keys()) clients.get(pid)?.sendMsg('player-leave', { id: s.id, 'player-id': c.id });
  }

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
    for (const c of joined) { sendSession(c, s); sendStarted(c, s); }
  }

  function createMatch(batch) {
    const first = obj(batch[0].opts);
    const s = newSession({
      name: 'Match', matchmade: true, started: true,
      opts: { gameMode: str(first['game-mode']), gameModeParams: '', map: str(first.map), language: str(first.language) },
    });
    seat(s, batch);
    console.log(`mm session ${s.id} created with ${s.players.size} player(s) -> ${s.host}:${s.port}`);
    return s;
  }

  // A matchmade session that is still young and has room takes newly queued players straight away.
  function findOpenSession(count) {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.matchmade && now - s.createdAt < config.LATE_JOIN_SECONDS * 1000 && s.players.size + count <= config.MAX_PLAYERS) return s;
    }
    return null;
  }

  function pumpQueue() {
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
    const open = findOpenSession(count);
    if (open) { seat(open, [entry]); return; }
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
  }

  function onClose(c) {
    if (c.gone) return;
    c.gone = true;
    unqueueClient(c);
    leaveGroup(c);
    leaveSession(c);
    if (clients.get(c.id) === c) clients.delete(c.id);
    sendSummary();
  }

  // ---------- request handlers ----------
  const handlers = {
    ping: (c) => c.sendMsg('pong'),

    'get-regions': (c) => c.sendMsg('regions', { [config.REGION_NAME]: { 'beacon-url': config.BEACON_URL } }),

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
      c.sendMsg('group', emptyGroup(g ? g.id : ''));
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

    'cancel-find-session': (c) => { unqueueClient(c); sendSummary(); c.sendMsg('ack'); },

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
      if (g) queue = queue.filter((e) => e.groupId !== g.id);
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
        if (s.players.size >= config.MAX_PLAYERS) return nak(c, 'other');
        unqueueClient(c);
        leaveSession(c);
        addPlayerToSession(s, c, null);
      }
      c.sendMsg('ack');
      sendSession(c, s, false);
      if (s.started) sendStarted(c, s);
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

  function shutdown() { clearInterval(tick); clearTimeout(batchTimer); }

  return { onConnect, onMessage, onClose, shutdown, _state: { clients, groups, sessions, get queue() { return queue; } } };
}

module.exports = { loadConfig, createMatchmaker, DEFAULTS };
