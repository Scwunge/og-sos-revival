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
  const canReadToken = opts.canReadToken || (() => false);   // extra tokens allowed to READ blobs (unverified community hosts)
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
    const hostRes = isHostToken(token);   // true, or the lobby's sessionId (string) when the token is a host's
    const isHost = !!hostRes;
    const hostSession = typeof hostRes === 'string' ? hostRes : null;
    const acct = isHost ? null : jwtAccount(token);
    const unauthorized = reply(401, { version: 1, data: { error: 'unauthorized' } });
    const key = `${accountId}/${appId}`;
    db.appData = db.appData || {};
    const cur = db.appData[key];
    const version = cur && Number.isInteger(cur.version) ? cur.version : 1;
    const stored = cur && isObj(cur.data) ? cur.data : {};

    if (method === 'GET') {
      if (!isHost && !acct && !canReadToken(token)) return unauthorized;
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
    // Fallback per-player match stats from the game's own lifetime counters (the DLL's list may be empty).
    if (isHost && hostSession) {
      try { recordBlobDelta(hostSession, String(accountId), stored, data); } catch { /* never break a save */ }
    }
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

  // ---- per-match stats derived from blob diffs (fallback when the DLL's player list is empty) ----
  // The host saves each player's whole blob at match end. The blob holds lifetime counters (games, escapes, relics,
  // fame wins, alliances, feedback received, badges) and level/progress; the difference to the stored previous blob
  // is what that player did in the match. There are no kill/damage counters in the blob; those come only from the DLL.
  const XP_KEYS = [[1, 500], [3, 1900], [6, 3400], [10, 5000], [20, 7000]];   // XP per level, docs/PROGRESSION.md [C]
  const xpCost = (l) => {
    if (l <= XP_KEYS[0][0]) return XP_KEYS[0][1];
    for (let i = 1; i < XP_KEYS.length; i++) {
      const [x1, y1] = XP_KEYS[i];
      if (l <= x1) { const [x0, y0] = XP_KEYS[i - 1]; return y0 + ((y1 - y0) * (l - x0)) / (x1 - x0); }
    }
    return XP_KEYS[XP_KEYS.length - 1][1];   // above level 20: assumed constant [I]
  };
  const xpTotal = (prog) => {
    const level = Math.min(200, Math.max(1, Math.floor(Number(prog && prog.level) || 1)));
    const frac = Math.min(1, Math.max(0, Number(prog && prog.levelProgress) || 0));
    let t = 0;
    for (let l = 1; l < level; l++) t += Math.round(xpCost(l));
    return t + frac * Math.round(xpCost(level));
  };
  const numLeaves = (o, prefix, out) => {
    if (!isObj(o)) return out;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[`${prefix}${k}`] = v;
      else if (isObj(v)) numLeaves(v, `${prefix}${k}.`, out);
    }
    return out;
  };
  const posDelta = (a, b) => {
    const out = {};
    for (const [k, v] of Object.entries(b)) { const d = v - (a[k] || 0); if (d > 0) out[k] = d; }
    return out;
  };
  const FEEDBACK = { shock: 'totalShockFeedbackReceived', laughter: 'totalLaughterFeedbackReceived', applause: 'totalApplauseFeedbackReceived', love: 'totalLoveFeedbackReceived', anger: 'totalAngerFeedbackReceived' };

  // -> null when nothing the match could have caused changed, else a cleaned entry (source 'blob').
  function blobDelta(oldData, newData) {
    const oS = numLeaves(oldData && oldData.stats, 'stats.', {}), nS = numLeaves(newData && newData.stats, 'stats.', {});
    const sd = posDelta(oS, nS);
    const bd = posDelta(numLeaves(oldData && oldData.badges, '', {}), numLeaves(newData && newData.badges, '', {}));
    const xp = Math.round(xpTotal(newData && newData.progression) - xpTotal(oldData && oldData.progression));
    const games = sd['stats.objectives.classic.totalGamesPlayed'] || 0;
    if (!Object.keys(sd).length && !Object.keys(bd).length && xp <= 0) return null;
    const e = { source: 'blob' };
    if (xp > 0) e.xp = Math.min(xp, 1e6);
    if (games > 0 || sd['stats.objectives.classic.totalEscapes']) e.escaped = (sd['stats.objectives.classic.totalEscapes'] || 0) > 0;
    const relics = clampInt(sd['stats.objectives.classic.totalRelicsRetrieved'], 0, 200);
    if (relics) e.relics = relics;
    if (sd['stats.social.totalFameWins']) e.fameWins = clampInt(sd['stats.social.totalFameWins'], 0, 50);
    if (sd['stats.social.totalAlliancesFormed']) e.alliances = clampInt(sd['stats.social.totalAlliancesFormed'], 0, 50);
    const fb = {};
    for (const [name, k] of Object.entries(FEEDBACK)) { const d = sd[`stats.hero.${k}`]; if (d) fb[name] = clampInt(d, 0, 1e6); }
    if (Object.keys(fb).length) e.feedback = fb;
    const badges = {};
    for (const [k, d] of Object.entries(bd).slice(0, 20)) badges[k] = clampInt(d, 0, 1e6);
    if (Object.keys(badges).length) e.badges = badges;
    const lv = newData && newData.progression && newData.progression.level;
    if (Number.isFinite(lv)) e.level = Math.min(200, Math.max(1, Math.floor(lv)));
    return e;
  }

  const BLOB_MATCH_WINDOW_MS = 60 * 1000;
  const ensureStats = (id) => {
    db.playerStats = db.playerStats || {};
    return db.playerStats[id] || (db.playerStats[id] = { matches: 0, escapes: 0, kills: 0, deaths: 0, damageDealt: 0, relics: 0, totalSurvivalSec: 0 });
  };

  function recordBlobDelta(sessionId, playerId, oldData, newData) {
    if (!/^\d{17}$/.test(playerId)) return;
    const d = blobDelta(oldData, newData);
    if (!d) return;
    const t = now();
    db.matches = Array.isArray(db.matches) ? db.matches : [];
    // The match this save belongs to: the session's latest match, if it ended just now (the DLL's match-end comes
    // first, then the host saves each player), else a new record that a later DLL match-end can still adopt.
    let match = null;
    for (let i = db.matches.length - 1; i >= 0 && !match; i--) {
      const m = db.matches[i];
      if (m.sessionId === sessionId && t - Date.parse(m.endedAt) <= BLOB_MATCH_WINDOW_MS) match = m;
    }
    if (!match) {
      match = { id: `blob:${sessionId}:${t}`.slice(0, 64), sessionId, endedAt: new Date(t).toISOString(), reason: 'blob', players: [], source: 'blob' };
      db.matches.push(match);
      while (db.matches.length > MAX_MATCHES) db.matches.shift();
    }
    const ex = match.players.find((p) => p.playerId === playerId);
    if (ex && ex.source !== 'blob') {
      // The DLL's own entry wins; the blob only adds what the DLL does not send.
      for (const [k, v] of Object.entries(d)) if (k !== 'source' && ex[k] === undefined) ex[k] = v;
      return;
    }
    const name = displayName(playerId);
    if (ex) {   // a second save of the same player in the same match: add up
      for (const [k, v] of Object.entries(d)) {
        if (k === 'escaped') ex.escaped = ex.escaped || v;
        else if (typeof v === 'number' && k !== 'level') ex[k] = (ex[k] || 0) + v;
        else if (isObj(v)) { ex[k] = ex[k] || {}; for (const [k2, v2] of Object.entries(v)) ex[k][k2] = (ex[k][k2] || 0) + v2; }
        else ex[k] = v;
      }
      applyBlobTotals(ex, d, playerId, match, false);
      return;
    }
    const entry = { playerId, ...(name && name !== playerId ? { name: [...name].slice(0, 32).join('') } : {}), ...d };
    match.players.push(entry);
    applyBlobTotals(entry, d, playerId, match, true);
  }

  // Lifetime totals for a blob-derived entry; remembered in entry.totalsApplied so a DLL entry that replaces it later can undo them.
  function applyBlobTotals(entry, d, playerId, match, first) {
    const s = ensureStats(playerId);
    const ta = entry.totalsApplied || (entry.totalsApplied = { matches: 0, escapes: 0, relics: 0 });
    if (first) { s.matches += 1; ta.matches += 1; }
    if (d.escaped === true && ta.escapes === 0) { s.escapes += 1; ta.escapes += 1; }
    if (d.relics) { s.relics += d.relics; ta.relics += d.relics; }
    s.lastMatchAt = match.endedAt;
    s.lastMatchId = match.id;
  }
  function undoBlobTotals(entry, playerId) {
    const ta = entry && entry.totalsApplied;
    const s = db.playerStats && db.playerStats[playerId];
    if (!ta || !s) return;
    s.matches = Math.max(0, s.matches - ta.matches);
    s.escapes = Math.max(0, s.escapes - ta.escapes);
    s.relics = Math.max(0, s.relics - ta.relics);
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
    // A record the blob fallback made for this session just before (the host saved first): the DLL's list replaces
    // its entries (and their totals), the blob-only players stay.
    let adopt = null;
    for (let i = db.matches.length - 1; i >= 0 && !adopt; i--) {
      const m = db.matches[i];
      if (m.sessionId === sessionId && m.source === 'blob' && String(m.id).startsWith('blob:') && t - Date.parse(m.endedAt) <= 2 * BLOB_MATCH_WINDOW_MS) adopt = m;
    }

    const seated = seatedIds && (seatedIds.size ?? seatedIds.length) ? new Set(seatedIds) : null;
    const players = [];
    for (const raw of (Array.isArray(pl.players) ? pl.players.slice(0, MAX_PLAYERS) : [])) {
      const p = cleanPlayer(raw);
      if (!p || (seated && !seated.has(p.playerId))) continue;
      players.push(p);
    }
    const endedAt = new Date(t).toISOString();
    const fields = {
      id: matchId,
      sessionId,
      endedAt,
      startedAt: typeof pl.startedAt === 'string' ? pl.startedAt.slice(0, 40) : undefined,
      reason: typeof pl.reason === 'string' ? pl.reason.slice(0, 32) : undefined,
      durationSec: clampNum(pl.durationSec, 0, 14400),
      fame: fameCall('fameForMatch', sessionId) ?? undefined,
    };
    let match;
    if (adopt) {
      const keep = [];
      for (const e of adopt.players) {
        const dll = players.find((p) => p.playerId === e.playerId);
        if (dll) {
          undoBlobTotals(e, e.playerId);
          for (const [k, v] of Object.entries(e)) if (!['source', 'totalsApplied', 'name', 'escaped', 'relics'].includes(k) && dll[k] === undefined) dll[k] = v;
        } else keep.push(e);
      }
      match = Object.assign(adopt, fields, { players: [...players, ...keep] });
      delete match.source;
    } else {
      match = { ...fields, players };
      db.matches.push(match);
      while (db.matches.length > MAX_MATCHES) db.matches.shift();
    }

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
  // Totals from match records plus the game's own lifetime counters from the player's blob (level, escapes, ...).
  function playerSummary(accountId) {
    const out = { ...(playerStats(accountId) || {}) };
    const b = db.appData && db.appData[`${accountId}/${APP_ID}`];
    const d = b && isObj(b.data) ? b.data : null;
    if (d) {
      const c = (d.stats && d.stats.objectives && d.stats.objectives.classic) || {};
      out.lifetime = {
        level: d.progression && d.progression.level, levelProgress: d.progression && d.progression.levelProgress,
        xp: Math.round(xpTotal(d.progression)), games: c.totalGamesPlayed, escapes: c.totalEscapes, relics: c.totalRelicsRetrieved,
        fameWins: d.stats && d.stats.social && d.stats.social.totalFameWins,
      };
    }
    return out;
  }
  const recentMatches = (limit = 20) => {
    const n = Math.min(100, Math.max(1, Math.round(Number(limit)) || 20));
    return (db.matches || []).slice(-n).reverse();
  };
  const matchById = (id) => (db.matches || []).find((m) => m.id === id) || null;

  return { handleAppData, handleLeaderboard, recordMatchEnd, playerStats, playerSummary, recentMatches, matchById };
}

module.exports = { createProgression };
