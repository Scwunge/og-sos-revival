// HERO "Stream" service replacement ([OutpostStreamClient] -> /ws/stream). See docs/HERO_TV.md sections 4 to 6.
//
// The real hero.tv wire format was never captured, so every shape here is built from the exe's serializer
// literals (HERO_TV.md section 5) and kept tolerant:
//  * fields are read as kebab-case, camelCase, snake_case or PascalCase;
//  * a nonce is echoed where the request put it (top level and/or inside data);
//  * unknown request types get an ack and are logged as `stream-unknown`, so they show up in ws.jsonl.
// Create-type requests (session, session-view, create-vote) answer with the typed packet by default;
// OGSOS_STREAM_CREATE_REPLY=ack|ack+typed switches that without a code change.
//
// The same socket also serves our own embed pages (?client=web): they `sub` with a `target` account id,
// send `feedback` and may `cast-vote`. Game clients and web pages share topics, so a web spectator's
// feedback reaches the performer's in-game views and panel.

'use strict';
const crypto = require('crypto');
const { badKey, STEAM_ID_RE } = require('./safe');

const SENTIMENTS = ['anger', 'applause', 'laughter', 'love', 'shock'];
const FEEDBACK_PER_SEC = 5;        // per connection and sentiment; extra presses are dropped
const VOTE_DEFAULT_SECONDS = 20;
const SESSION_GRACE_MS = 120000;   // owner socket gone: keep the session this long for a reconnect
const VIEW_GRACE_MS = 30000;
const MAX_SESSIONS = 200;
const MAX_VIEWS = 4000;
const MAX_SESSIONS_PER_CONN = 3;   // one socket cannot fill the table (and FIFO-evict other people's sessions)
const MAX_VIEWS_PER_CONN = 20;
const MAX_VOTES_PER_CONN = 2;
// Requests that create or change state need an account (a valid JWT on the socket); anonymous sockets stay read-only
// (ping, session-view, sub, unsub, vote-status, viewers).
const AUTH_TYPES = new Set(['session', 'session-end', 'feedback', 'feedback-batch', 'create-vote', 'cast-vote', 'vote']);

// Read a field under any of the usual spellings: 'session-id', sessionId, session_id, SessionId.
function f(obj, name) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[name] !== undefined) return obj[name];
  const parts = name.split('-');
  const camel = parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join('');
  const variants = [camel, parts.join('_'), camel[0].toUpperCase() + camel.slice(1)];
  for (const v of variants) if (obj[v] !== undefined) return obj[v];
  return undefined;
}
const str = (v) => (v === undefined || v === null ? '' : String(v));

function playerId(p) {
  if (p === null || p === undefined) return '';
  if (typeof p !== 'object') return String(p);
  return str(f(p, 'id') ?? f(p, 'player-id') ?? f(p, 'account-id') ?? f(p, 'user-id') ?? f(p, 'unique-id') ?? f(p, 'uid'));
}
function normPlayers(v) {
  if (v === undefined || v === null) return null;   // "not given" (keep existing) vs [] (clear)
  const arr = Array.isArray(v) ? v : (typeof v === 'object' ? Object.keys(v) : [v]);
  return [...new Set(arr.map(playerId).filter((id) => STEAM_ID_RE.test(id)))];   // real SteamID64s only; ids like __proto__ never get in
}
function normTopics(d) {
  let t = f(d, 'topics');
  if (t === undefined) t = f(d, 'topic');
  if (t === undefined) return [];
  return (Array.isArray(t) ? t : [t]).map((x) => str(x).toLowerCase()).filter(Boolean);
}
function normSentiment(s) {
  s = str(s).toLowerCase();
  if (s === 'joy') return 'love';
  if (s === 'surprise') return 'shock';
  return SENTIMENTS.includes(s) ? s : '';
}

function createStream(opts) {
  const log = opts.log || (() => {});
  const replyMode = opts.createReply || 'typed';
  const adoptUnknown = !!opts.adoptUnknown;
  const onSessionEnd = opts.onSessionEnd || (() => {});

  const conns = new Map();      // connId -> conn
  const sessions = new Map();   // session-id -> session
  const views = new Map();      // view-id -> view
  const votes = new Map();      // vote-id -> vote
  const pending = new Map();    // account -> {sentiment: n}, flushed every second as feedback-batch
  const fbWindows = new Map();  // ACCOUNT -> { t, n: {sentiment: n} }: the per-second feedback cap is per account, not per socket
  let countsDirty = false;

  // ---------- sending ----------
  function reply(conn, req, type, data) {
    const out = { type, data: data || {} };
    if (req.nonce !== undefined) out.nonce = req.nonce;
    if (req.data && typeof req.data === 'object' && req.data.nonce !== undefined) out.data.nonce = req.data.nonce;
    conn.send(out);
  }
  const ack = (conn, req, data) => reply(conn, req, 'ack', data);
  const nak = (conn, req, error) => { reply(conn, req, 'nak', { error }); log({ event: 'stream-nak', conn: conn.id, type: req.type, error }); };
  // Answer to a create-type request: typed packet, ack, or both (OGSOS_STREAM_CREATE_REPLY).
  function created(conn, req, type, data) {
    if (replyMode === 'ack' || replyMode === 'ack+typed') ack(conn, req, data);
    if (replyMode !== 'ack') reply(conn, req, type, data);
  }

  // ---------- audience ----------
  // Who is watching `acc`: in-game views on a live session whose targets include acc (minus views the
  // performer owns), plus web feedback pages aimed at acc. Returns a Set of watcher keys.
  function watchersOf(acc) {
    const set = new Set();
    for (const v of views.values()) {
      if (!v.players.includes(acc)) continue;
      const s = sessions.get(v.sessionId);
      if (!s || s.ended) continue;
      const owner = v.viewer || (conns.get(v.connId) || {}).account || '';
      if (owner && owner === acc) continue;
      set.add(owner ? `acc:${owner}` : `view:${v.id}`);
    }
    for (const c of conns.values()) {
      if (c.web && c.web.role === 'feedback' && c.web.target === acc) set.add(c.account ? `acc:${c.account}` : `web:${c.id}`);
    }
    return set;
  }
  function audienceCount(players) {
    const all = new Set();
    for (const p of players) for (const w of watchersOf(p)) all.add(w);
    return all.size;
  }
  // Which players a subscription is about.
  function subPlayers(sub) {
    if (sub.target) return [sub.target];
    if (sub.viewId) { const v = views.get(sub.viewId); return v ? v.players : []; }
    if (sub.sessionId) { const s = sessions.get(sub.sessionId); return s ? s.players : []; }
    return [];
  }
  function pushViewerCounts() {
    countsDirty = false;
    for (const c of conns.values()) {
      for (const sub of c.subs.values()) {
        if (sub.topic !== 'viewers') continue;
        const count = audienceCount(subPlayers(sub));
        if (sub.last === count) continue;
        sub.last = count;
        c.send(topicMessage(sub, 'viewers', { count }));
      }
    }
  }
  const markCounts = () => { countsDirty = true; };
  function topicMessage(sub, topic, message) {
    const data = { topic };
    if (sub.viewId) data['view-id'] = sub.viewId;
    if (sub.sessionId) data['session-id'] = sub.sessionId;
    if (sub.target) data.target = sub.target;
    data.message = message;
    return { type: 'message', data };
  }

  // ---------- feedback ----------
  function addFeedback(conn, target, counts) {
    if (!target || badKey(target) || !conn.account) return 0;
    const now = Date.now();
    let win = fbWindows.get(conn.account);
    if (!win || now - win.t >= 1000) { win = { t: now, n: {} }; fbWindows.set(conn.account, win); }
    let added = 0;
    const p = pending.get(target) || {};
    for (const [k, v] of Object.entries(counts)) {
      const s = normSentiment(k);
      if (!s) continue;
      const room = FEEDBACK_PER_SEC - (win.n[s] || 0);
      const n = Math.max(0, Math.min(room, Math.floor(Number(v) || 0)));
      if (!n) continue;
      win.n[s] = (win.n[s] || 0) + n;
      p[s] = (p[s] || 0) + n;
      added += n;
    }
    if (added) pending.set(target, p);
    return added;
  }
  function flushFeedback() {
    if (!pending.size) return;
    const batch = [...pending.entries()];
    pending.clear();
    for (const [acc, counts] of batch) {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      // Per-session tally (for Fame at session-end) on every live session the performer is in.
      for (const s of sessions.values()) {
        if (s.ended || !s.players.includes(acc)) continue;
        const t = s.feedback[acc] || (s.feedback[acc] = Object.create(null));
        for (const [k, n] of Object.entries(counts)) t[k] = (t[k] || 0) + n;
      }
      const message = {
        'player-id': acc,
        feedback: Object.entries(counts).map(([sentiment, count]) => ({ sentiment, count })),
        counts, total,
      };
      for (const c of conns.values()) {
        for (const sub of c.subs.values()) {
          if (sub.topic !== 'feedback-batch' || !subPlayers(sub).includes(acc)) continue;
          c.send(topicMessage(sub, 'feedback-batch', message));
        }
      }
      log({ event: 'stream-feedback', target: acc, counts });
    }
  }

  // ---------- sessions and views ----------
  function endSession(s, why) {
    if (s.ended) return;
    s.ended = true;
    clearTimeout(s.expire);
    for (const v of votes.values()) if (v.sessionId === s.id && !v.final) finishVote(v);
    for (const vid of s.views) views.delete(vid);
    sessions.delete(s.id);
    // Fame is computed from these counts in server/fame.js (onSessionEnd -> fame.recordMatch).
    log({ event: 'stream-session-end', session: s.id, why, players: s.players, feedback: s.feedback });
    try { onSessionEnd({ id: s.id, players: s.players, feedback: s.feedback }); } catch (e) { log({ event: 'stream-error', where: 'onSessionEnd', error: String(e) }); }
    markCounts();
  }
  function deleteView(v) {
    clearTimeout(v.expire);
    views.delete(v.id);
    const s = sessions.get(v.sessionId);
    if (s) s.views.delete(v.id);
    markCounts();
  }
  function prune() {
    // Hard caps so a misbehaving client cannot grow the tables forever: drop the oldest first.
    while (sessions.size > MAX_SESSIONS) endSession(sessions.values().next().value, 'cap');
    while (views.size > MAX_VIEWS) deleteView(views.values().next().value);
  }
  const sessionData = (s) => ({ 'session-id': s.id, players: s.players.map((id) => ({ id })), views: [...s.views] });
  const viewData = (v) => ({ 'session-id': v.sessionId, 'view-id': v.id, players: v.players.map((id) => ({ id })) });

  // Unknown session id: nak session-not-found (client recovers), or adopt it if OGSOS_STREAM_ADOPT_UNKNOWN=1.
  function findSession(conn, req, sid) {
    const s = sessions.get(sid);
    if (s) return s;
    if (adoptUnknown && sid) { log({ event: 'stream-adopt-session', session: sid }); return newSession(conn, sid, []); }
    nak(conn, req, 'session-not-found');
    return null;
  }
  function newSession(conn, sid, players) {
    const s = { id: sid || crypto.randomUUID(), connId: conn.id, owner: conn.account || '', players, views: new Set(), feedback: Object.create(null), created: Date.now(), ended: false };
    sessions.set(s.id, s);
    prune();
    return s;
  }

  // ---------- votes ----------
  function voteAudience(v) {
    const out = new Set();
    const s = sessions.get(v.sessionId);
    if (v.connId) out.add(v.connId);
    if (s) {
      if (s.connId) out.add(s.connId);
      for (const vid of s.views) { const w = views.get(vid); if (w) out.add(w.connId); }
      for (const c of conns.values()) if (c.web && c.web.target && s.players.includes(c.web.target)) out.add(c.id);
    }
    return [...out].map((id) => conns.get(id)).filter(Boolean);
  }
  function tally(v) {
    const t = {};
    for (const o of v.options) t[o.id] = 0;
    for (const opt of v.ballots.values()) t[opt] = (t[opt] || 0) + 1;
    return t;
  }
  function voteStatus(v) {
    const t = tally(v);
    const total = v.ballots.size;
    const blind = v.tallyType === 'blind' && !v.final;
    return {
      'vote-id': v.id, 'session-id': v.sessionId,
      ttl: Math.max(0, Math.ceil((v.endsAt - Date.now()) / 1000)),
      final: v.final, winner: v.final ? v.winner : null,
      total, tally: blind ? {} : t, 'tally-type': v.tallyType,
    };
  }
  function voteInfo(v) {
    return {
      'vote-id': v.id, 'session-id': v.sessionId, title: v.title, description: v.description,
      options: v.options, actors: v.actors, config: v.config, ttl: voteStatus(v).ttl,
    };
  }
  function broadcastVote(v, type, data) { for (const c of voteAudience(v)) c.send({ type, data }); }
  function finishVote(v) {
    if (v.final) return;
    v.final = true;
    const t = tally(v);
    let best = null;
    for (const o of v.options) if (t[o.id] > 0 && (best === null || t[o.id] > t[best])) best = o.id;   // tie: earliest option
    v.winner = best;
    const st = voteStatus(v);
    log({ event: 'stream-vote-final', vote: v.id, session: v.sessionId, winner: best, tally: t, total: v.ballots.size });
    broadcastVote(v, 'vote-status', st);
    setTimeout(() => votes.delete(v.id), 60000).unref();
  }

  // ---------- request handlers ----------
  const handlers = {
    ping(conn, req) { reply(conn, req, 'pong'); },

    session(conn, req, d) {
      const sid = str(f(d, 'session-id'));
      const players = normPlayers(f(d, 'players'));
      let s;
      if (sid) {
        s = findSession(conn, req, sid);
        if (!s) return;
        if (s.owner && s.owner !== conn.account) return nak(conn, req, 'forbidden');   // only the owner's account re-attaches
        if (players) s.players = players;
        s.connId = conn.id;                 // reconnecting owner re-attaches
        clearTimeout(s.expire);
      } else {
        if ([...conn.sessions].filter((x) => sessions.has(x)).length >= MAX_SESSIONS_PER_CONN) return nak(conn, req, 'too-many-sessions');
        s = newSession(conn, '', players || []);
      }
      conn.sessions.add(s.id);
      created(conn, req, 'session', sessionData(s));
      markCounts();
    },

    'session-end'(conn, req, d) {
      const s = findSession(conn, req, str(f(d, 'session-id')));
      if (!s) return;
      if (s.connId !== conn.id) return nak(conn, req, 'forbidden');   // only the connection that owns the session may end it
      endSession(s, 'session-end');
      conn.sessions.delete(s.id);
      ack(conn, req, { 'session-id': s.id });
    },

    'session-view'(conn, req, d) {
      const s = findSession(conn, req, str(f(d, 'session-id')));
      if (!s) return;
      const vid = str(f(d, 'view-id'));
      const players = normPlayers(f(d, 'players'));
      const viewer = str(f(d, 'viewer-id') ?? f(d, 'player-id') ?? f(d, 'owner'));
      let v = vid && views.get(vid);
      if (v && v.sessionId !== s.id) { deleteView(v); v = null; }
      if (!v) {
        if ([...conn.views].filter((x) => views.has(x)).length >= MAX_VIEWS_PER_CONN) return nak(conn, req, 'too-many-views');
        v = { id: vid || crypto.randomUUID(), sessionId: s.id, connId: conn.id, viewer: viewer || conn.account || '', players: players || [], created: Date.now() };
        views.set(v.id, v);
        s.views.add(v.id);
        prune();
      } else {
        if (players) v.players = players;
        if (viewer) v.viewer = viewer;
        v.connId = conn.id;
        clearTimeout(v.expire);
      }
      conn.views.add(v.id);
      created(conn, req, 'session-view', viewData(v));
      markCounts();
    },

    'session-delete-view'(conn, req, d) {
      const sid = str(f(d, 'session-id'));
      if (sid && !sessions.has(sid)) return nak(conn, req, 'session-not-found');
      const vid = str(f(d, 'view-id'));
      const v = views.get(vid);
      if (v) deleteView(v);
      conn.views.delete(vid);
      ack(conn, req, { 'view-id': vid });
    },

    sub(conn, req, d) {
      const key = subKey(conn, req, d);
      if (!key) return;
      for (const topic of key.topics) {
        const sub = { topic, viewId: key.viewId, sessionId: key.sessionId, target: key.target, last: undefined };
        conn.subs.set(`${topic}|${key.viewId}|${key.sessionId}|${key.target}`, sub);
      }
      ack(conn, req, { topics: key.topics, 'view-id': key.viewId || undefined, 'session-id': key.sessionId || undefined });
      markCounts();
      // Web spectators also get the current vote, if their target's session has one running.
      if (conn.web && key.target) {
        for (const v of votes.values()) {
          const s = sessions.get(v.sessionId);
          if (!v.final && s && s.players.includes(key.target)) conn.send({ type: 'vote', data: voteInfo(v) });
        }
      }
    },

    unsub(conn, req, d) {
      const key = subKey(conn, req, d);
      if (!key) return;
      for (const topic of key.topics) conn.subs.delete(`${topic}|${key.viewId}|${key.sessionId}|${key.target}`);
      ack(conn, req, { topics: key.topics });
    },

    'create-vote'(conn, req, d) {
      const s = findSession(conn, req, str(f(d, 'session-id')));
      if (!s) return;
      const config = f(d, 'config') || {};
      const seconds = Number(f(config, 'duration') ?? f(config, 'ttl') ?? f(config, 'time-limit') ?? f(d, 'duration') ?? f(d, 'ttl')) || VOTE_DEFAULT_SECONDS;
      const rawOpts = f(d, 'options') || [];
      const options = (Array.isArray(rawOpts) ? rawOpts : []).map((o, i) => (o && typeof o === 'object'
        ? { id: str(f(o, 'id') ?? i), label: str(f(o, 'label')), description: str(f(o, 'description')), image: str(f(o, 'image')) }
        : { id: str(o), label: str(o), description: '', image: '' }));
      if (!options.length) return nak(conn, req, 'other');
      let mine = 0; for (const x of votes.values()) if (x.connId === conn.id && !x.final) mine++;
      if (mine >= MAX_VOTES_PER_CONN) return nak(conn, req, 'too-many-votes');
      const v = {
        id: crypto.randomUUID(), sessionId: s.id, connId: conn.id, config,
        type: str(f(config, 'type') || 'single-mutable').toLowerCase(),
        tallyType: str(f(config, 'tally-type') || 'total').toLowerCase(),
        actors: Array.isArray(f(d, 'actors')) ? f(d, 'actors') : [],
        options, title: str(f(d, 'title')), description: str(f(d, 'description')),
        ballots: new Map(), endsAt: Date.now() + Math.min(Math.max(seconds, 3), 300) * 1000, final: false, winner: null,
      };
      votes.set(v.id, v);
      log({ event: 'stream-vote-create', vote: v.id, session: s.id, options: options.map((o) => o.id), seconds });
      created(conn, req, 'vote', voteInfo(v));
      for (const c of voteAudience(v)) if (c !== conn) c.send({ type: 'vote', data: voteInfo(v) });
    },

    'cast-vote'(conn, req, d) {
      const v = votes.get(str(f(d, 'vote-id')));
      if (!v) return nak(conn, req, 'vote-not-found');
      if (v.final) return nak(conn, req, 'vote-closed');
      const opt = str(f(d, 'option-id') ?? f(d, 'option'));
      if (!v.options.some((o) => o.id === opt)) return nak(conn, req, 'invalid-option');
      const voter = str(f(d, 'voter-id')) || conn.account || `conn:${conn.id}`;
      if (v.type === 'single-immutable' && v.ballots.has(voter)) return nak(conn, req, 'already-voted');
      v.ballots.set(voter, opt);
      ack(conn, req, { 'vote-id': v.id, 'option-id': opt });
      v.changed = true;
    },

    'vote-status'(conn, req, d) {
      const v = votes.get(str(f(d, 'vote-id')));
      if (!v) return nak(conn, req, 'vote-not-found');
      reply(conn, req, 'vote-status', voteStatus(v));
    },

    // Our embed pages: {"type":"feedback","data":{"target":"<account>","counts":{"applause":2}}}
    // (also accepts {"sentiment":"applause","count":1}). Game clients may send the same if they turn out to.
    feedback(conn, req, d) {
      const target = str(f(d, 'target') ?? f(d, 'player-id')) || (conn.web && conn.web.target) || '';
      let counts = f(d, 'counts');
      if (!counts || typeof counts !== 'object') counts = { [str(f(d, 'sentiment'))]: f(d, 'count') ?? 1 };
      const added = addFeedback(conn, target, counts);
      if (!conn.web) ack(conn, req, { added });
    },
  };

  function subKey(conn, req, d) {
    const topics = normTopics(d);
    const viewId = str(f(d, 'view-id'));
    const sessionId = str(f(d, 'session-id'));
    const target = str(f(d, 'target')) || (conn.web && !viewId && !sessionId ? conn.web.target : '');
    if (viewId && !views.has(viewId)) { nak(conn, req, 'session-not-found'); return null; }
    if (sessionId && !sessions.has(sessionId)) { nak(conn, req, 'session-not-found'); return null; }
    return { topics: topics.length ? topics : ['viewers'], viewId, sessionId, target };
  }

  // ---------- connection lifecycle ----------
  function connect({ id, account, web, send }) {
    const conn = { id, account: account || '', web: web || null, send, subs: new Map(), sessions: new Set(), views: new Set() };
    conns.set(id, conn);
    if (web) markCounts();
    return conn;
  }
  function message(conn, text) {
    let req;
    try { req = JSON.parse(text); } catch { req = null; }
    if (!req || typeof req !== 'object' || Array.isArray(req)) {
      log({ event: 'stream-unknown', conn: conn.id, reason: 'not a JSON object', text: String(text).slice(0, 500) });
      return conn.send({ type: 'nak', data: { error: 'other' } });
    }
    const type = str(req.type);
    const d = req.data && typeof req.data === 'object' ? req.data : req;
    if (AUTH_TYPES.has(type) && !conn.account) return nak(conn, req, 'unauthorized');
    const h = Object.prototype.hasOwnProperty.call(handlers, type) ? handlers[type] : null;
    if (!h) {
      log({ event: 'stream-unknown', conn: conn.id, type, text: String(text).slice(0, 2000) });
      return ack(conn, req, {});
    }
    try { h(conn, req, d); } catch (e) {
      log({ event: 'stream-error', conn: conn.id, type, error: String(e && e.stack || e) });
      nak(conn, req, 'other');
    }
  }
  function disconnect(conn) {
    conns.delete(conn.id);
    for (const sid of conn.sessions) {
      const s = sessions.get(sid);
      if (s && s.connId === conn.id) s.expire = setTimeout(() => endSession(s, 'owner-gone'), SESSION_GRACE_MS);
    }
    for (const vid of conn.views) {
      const v = views.get(vid);
      if (v && v.connId === conn.id) v.expire = setTimeout(() => deleteView(v), VIEW_GRACE_MS);
    }
    markCounts();
  }

  // Once a second: vote countdowns, feedback batches, changed viewer counts.
  const tick = setInterval(() => {
    const now = Date.now();
    for (const v of votes.values()) {
      if (v.final) continue;
      if (now >= v.endsAt) finishVote(v);
      else if (v.changed || (Math.floor((v.endsAt - now) / 1000) % 5 === 0)) { v.changed = false; broadcastVote(v, 'vote-status', voteStatus(v)); }
    }
    flushFeedback();
    if (fbWindows.size > 500) for (const [k, w] of fbWindows) if (now - w.t > 5000) fbWindows.delete(k);
    if (countsDirty) pushViewerCounts();
  }, 1000);
  tick.unref();

  // For the spectator site and /api/stream/*.
  function snapshot() {
    return {
      sessions: [...sessions.values()].map((s) => ({
        id: s.id, created: new Date(s.created).toISOString(), owner: s.owner || null, live: sessions.get(s.id) === s && !s.ended,
        players: s.players.map((p) => ({ id: p, viewers: watchersOf(p).size, feedback: s.feedback[p] || {} })),
        views: s.views.size,
        votes: [...votes.values()].filter((v) => v.sessionId === s.id).map((v) => ({ ...voteInfo(v), status: voteStatus(v) })),
      })),
      connections: { game: [...conns.values()].filter((c) => !c.web).length, web: [...conns.values()].filter((c) => c.web).length },
    };
  }

  return { connect, message, disconnect, snapshot, audienceCount, SENTIMENTS, _state: { sessions, views, votes, conns } };
}

module.exports = { createStream, SENTIMENTS };
