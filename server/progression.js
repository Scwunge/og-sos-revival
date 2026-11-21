'use strict';
// Classic progression backend, pure logic (no HTTP server, no fs besides the injected saveDb):
//   - the per-account app-data blob (GET/POST /api/account/<id>/app/sostest) with compare-and-swap versions,
//   - leaderboards (GET list / around a member, POST from the host),
//   - match-end records and per-account totals fed by the host DLL's match-end event.
// See docs/PROGRESSION.md. The blob is stored verbatim: the host computes XP/level, we never interpret it.

const APP_ID = 'sostest';
const MAX_BLOB_BYTES = 256 * 1024;
const MAX_BOARDS = 300;
const MAX_POST_ENTRIES = 200;
const MAX_MATCHES = 500;
const MAX_PLAYERS = 64;
const ID_RE = /^[\w-]{1,64}$/;
const BOARD_RE = /^[A-Za-z0-9_\-]{1,64}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const reply = (status, body) => ({ status, body });
const clampInt = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined);
const clampNum = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
const num = (s, def) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : def; };

function createProgression(opts = {}) {
  const { db, saveDb = () => {}, fame = null } = opts;
  const displayName = opts.displayName || ((id) => String(id));
  const isHostToken = opts.isHostToken || (() => false);
  const jwtAccount = opts.jwtAccount || (() => null);
  const leaderboardOpen = opts.leaderboardOpen ?? process.env.OGSOS_LEADERBOARD_OPEN === '1';
  const allowOwnerWrite = !!opts.allowOwnerWrite;
  const rankBase = opts.rankBase ?? 1;
  const now = opts.now || Date.now;

  // A fame bug must never break a request.
  const fameCall = (fn, ...args) => {
    try { return typeof fame?.[fn] === 'function' ? fame[fn](...args) : undefined; } catch { return undefined; }
  };
  const applyFame = (accountId, data) => {
    const out = fameCall('applyToBlob', accountId, data);
    return isObj(out) ? out : data;
  };
  const save = () => { try { saveDb(); } catch { /* keep serving */ } };

  // ---- app data ----
  function handleAppData(method, accountId, appId, bodyText, token) {
    if (appId !== APP_ID) return null;
    if (!ID_RE.test(String(accountId))) return reply(400, { error: 'bad account id' });
    const isHost = !!isHostToken(token);
    const acct = isHost ? null : jwtAccount(token);
    const unauthorized = reply(401, { version: 1, data: { error: 'unauthorized' } });
    const key = `${accountId}/${appId}`;
    db.appData = db.appData || {};
    const cur = db.appData[key];
    const version = cur && Number.isInteger(cur.version) ? cur.version : 1;
    const stored = cur && isObj(cur.data) ? cur.data : {};

    if (method === 'GET') {
      if (!isHost && !acct) return unauthorized;
      return reply(200, { version, data: applyFame(accountId, stored) });
    }
    if (method !== 'POST') return reply(405, { error: 'method not allowed' });
    if (!isHost && !(allowOwnerWrite && acct && acct === accountId)) return unauthorized;

    const text = bodyText == null ? '' : String(bodyText);
    if (Buffer.byteLength(text) > MAX_BLOB_BYTES) return reply(413, { error: 'too large' });
    let body;
    try { body = JSON.parse(text); } catch { return reply(400, { error: 'bad json' }); }
    if (!isObj(body)) return reply(400, { error: 'bad body' });
    let data;
    if ('data' in body) {
      data = body.data;
      if (typeof body.version === 'number' && body.version < version) return reply(409, { version, data: stored });
    } else {
      data = body;   // legacy: the whole object is the blob, no envelope version to compare
    }
    if (!isObj(data)) return reply(400, { error: 'data must be an object' });
    data = applyFame(accountId, data);
    const newVersion = version + 1;
    db.appData[key] = { version: newVersion, data };
    save();
    return reply(200, { version: newVersion, data });
  }

  // ---- leaderboards ----
  const sortedEntries = (scores) =>
    Object.entries(scores).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const rowOf = (member, score, i) => ({ member, rank: i + rankBase, score, uname: displayName(member) });

  function pruneBoards() {
    const keys = Object.keys(db.leaderboards);
    if (keys.length <= MAX_BOARDS) return;
    keys.sort((a, b) => String(db.leaderboards[a].updated || '').localeCompare(String(db.leaderboards[b].updated || '')));
    for (const k of keys.slice(0, keys.length - MAX_BOARDS)) delete db.leaderboards[k];
  }

  function handleLeaderboard(method, appId, board, member, query, bodyText, token) {
    if (!BOARD_RE.test(String(board))) return reply(400, { error: 'bad board id' });
    const q = query || {};
    db.leaderboards = db.leaderboards || {};
    const key = `${appId}/${board}`;

    if (method === 'POST') {
      if (member != null) return reply(405, { error: 'method not allowed' });
      if (!isHostToken(token) && !leaderboardOpen) return reply(401, { error: 'unauthorized' });
      let arr;
      try { arr = JSON.parse(bodyText == null ? '' : String(bodyText)); } catch { return reply(400, { error: 'bad json' }); }
      if (!Array.isArray(arr) || arr.length > MAX_POST_ENTRIES) return reply(400, { error: 'bad body' });
      if (!arr.length) return reply(200, []);   // the host posts [] for boards it has no score for
      const valid = {};
      for (const e of arr) {
        if (!isObj(e) || typeof e.member !== 'string' || !ID_RE.test(e.member)) continue;
        if (typeof e.score !== 'number' || !Number.isFinite(e.score)) continue;
        valid[e.member] = Math.min(1e9, Math.max(-1e9, Math.round(e.score)));
      }
      const members = Object.keys(valid);
      if (!members.length) return reply(400, { error: 'no valid entries' });
      const b = db.leaderboards[key] || (db.leaderboards[key] = { updated: '', scores: {} });
      Object.assign(b.scores, valid);
      b.updated = new Date(now()).toISOString();
      pruneBoards();
      save();
      const rows = [];
      sortedEntries(b.scores).forEach(([m, s], i) => { if (m in valid) rows.push(rowOf(m, s, i)); });
      return reply(200, rows);
    }
    if (method !== 'GET') return reply(405, { error: 'method not allowed' });

    const useFame = fameCall('isFameBoard', board) === true;
    if (member == null) {
      const start = Math.max(0, num(q.start, 0));
      const limit = Math.min(1000, Math.max(1, num(q.limit, 100)));
      if (useFame) {
        const rows = fameCall('fameLeaderboard', board, { offset: start, limit });
        if (Array.isArray(rows) && rows.length) return reply(200, rows);
      }
      const b = db.leaderboards[key];
      const sorted = b ? sortedEntries(b.scores) : [];
      return reply(200, sorted.slice(start, start + limit).map(([m, s], i) => rowOf(m, s, start + i)));
    }
    const n = Math.min(100, Math.max(0, num(q.surrounding, 0)));
    if (useFame) {
      const rows = fameCall('fameAround', board, member, n);
      if (Array.isArray(rows) && rows.length) return reply(200, rows);
    }
    const b = db.leaderboards[key];
    const sorted = b ? sortedEntries(b.scores) : [];
    const idx = sorted.findIndex(([m]) => m === member);
    if (idx < 0) return reply(200, []);
    const from = Math.max(0, idx - n);
    return reply(200, sorted.slice(from, idx + n + 1).map(([m, s], i) => rowOf(m, s, from + i)));
  }

  // ---- matches ----
  function cleanPlayer(p) {
    if (!isObj(p) || typeof p.playerId !== 'string' || !/^\d{17}$/.test(p.playerId)) return null;
    const o = { playerId: p.playerId };
    if (typeof p.name === 'string') o.name = [...p.name].slice(0, 32).join('');
    const set = (k, v) => { if (v !== undefined) o[k] = v; };
    set('kills', clampInt(p.kills, 0, 200));
    set('deaths', clampInt(p.deaths, 0, 200));
    set('damageDealt', clampNum(p.damageDealt, 0, 1e6));
    set('survivalSec', clampNum(p.survivalSec, 0, 14400));
    set('placement', clampInt(p.placement, 1, 64));
    set('relics', clampInt(p.relics, 0, 200));
    set('fame', clampNum(p.fame, -1e6, 1e6));
    set('teamId', clampInt(p.teamId, 0, 255));
    for (const k of ['escaped', 'aliveAtEnd', 'connected']) if (typeof p[k] === 'boolean') o[k] = p[k];
    return o;
  }

  function recordMatchEnd(sessionId, payload, seatedIds) {
    const pl = isObj(payload) ? payload : {};
    const t = now();
    let matchId;
    if (typeof pl.matchId === 'string' && pl.matchId) matchId = pl.matchId.slice(0, 64);
    else if (typeof pl.startedAt === 'string' && pl.startedAt) matchId = `${sessionId}:${pl.startedAt}`.slice(0, 64);
    else matchId = `${sessionId}:${t}`.slice(0, 64);
    db.matches = Array.isArray(db.matches) ? db.matches : [];
    if (db.matches.some((m) => m.id === matchId)) return { accepted: 0, duplicate: true, matchId };

    const seated = seatedIds && (seatedIds.size ?? seatedIds.length) ? new Set(seatedIds) : null;
    const players = [];
    for (const raw of (Array.isArray(pl.players) ? pl.players.slice(0, MAX_PLAYERS) : [])) {
      const p = cleanPlayer(raw);
      if (!p || (seated && !seated.has(p.playerId))) continue;
      players.push(p);
    }
    const endedAt = new Date(t).toISOString();
    const match = {
      id: matchId,
      sessionId,
      endedAt,
      startedAt: typeof pl.startedAt === 'string' ? pl.startedAt.slice(0, 40) : undefined,
      reason: typeof pl.reason === 'string' ? pl.reason.slice(0, 32) : undefined,
      durationSec: clampNum(pl.durationSec, 0, 14400),
      players,
      fame: fameCall('fameForMatch', sessionId) ?? undefined,
    };
    db.matches.push(match);
    while (db.matches.length > MAX_MATCHES) db.matches.shift();

    db.playerStats = db.playerStats || {};
    for (const p of players) {
      const s = db.playerStats[p.playerId] || (db.playerStats[p.playerId] = {
        matches: 0, escapes: 0, kills: 0, deaths: 0, damageDealt: 0, relics: 0, totalSurvivalSec: 0,
      });
      s.matches += 1;
      if (p.escaped === true) s.escapes += 1;
      if (p.kills !== undefined) s.kills += p.kills;
      if (p.deaths !== undefined) s.deaths += p.deaths;
      if (p.damageDealt !== undefined) s.damageDealt += p.damageDealt;
      if (p.relics !== undefined) s.relics += p.relics;
      if (p.survivalSec !== undefined) s.totalSurvivalSec += p.survivalSec;
      if (p.placement !== undefined && (s.bestPlacement === undefined || p.placement < s.bestPlacement)) s.bestPlacement = p.placement;
      s.lastMatchAt = endedAt;
      s.lastMatchId = matchId;
    }
    save();
    return { accepted: players.length, duplicate: false, matchId };
  }

  const playerStats = (accountId) => (db.playerStats && db.playerStats[accountId]) || null;
  const recentMatches = (limit = 20) => {
    const n = Math.min(100, Math.max(1, Math.round(Number(limit)) || 20));
    return (db.matches || []).slice(-n).reverse();
  };
  const matchById = (id) => (db.matches || []).find((m) => m.id === id) || null;

  return { handleAppData, handleLeaderboard, recordMatchEnd, playerStats, recentMatches, matchById };
}

module.exports = { createProgression };
