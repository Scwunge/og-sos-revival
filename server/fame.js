// Fame: the audience rating (hero-tv branch). See docs/HERO_TV.md section 8.
//
// Owned here: per-match fame from audience feedback, each account's hero stats and Fame rating, and the Fame
// leaderboards. The shared code in server/server.js (player blob storage, the /api/leaderboard dispatcher) only
// calls the small functions exported below, at lines marked `// hero-tv`.
//
// Data, all in the shared db (same account ids as db.accounts):
//   db.heroStats[account] = { anger, applause, laughter, love, shock,   feedback received, all matches
//                             fame, fameWins, matches,                  raw fame summed, matches won on fame
//                             soloFameRating, prevSoloFameRating }      rating shown in game, site, leaderboard
//   db.fameMatches[session] = { t, players: { account: {counts, fameDelta, rank, win, prevRating, newRating} } }
//
// Leaderboard rows: the client's FOutpostLeaderboards::GetRankingsResponse requires `member`, `rank` and `score`
// in every entry ("Ranking json missing <x> field") and also reads `uname` (exe strings at 0x25f1f50..0x25f1f68).
// Routes it calls: /api/leaderboard/<app>/<board>?start=&limit=  and  /api/leaderboard/<app>/<board>/<member>?surrounding=N.

'use strict';
const { badKey } = require('./safe');

const SENTIMENTS = ['anger', 'applause', 'laughter', 'love', 'shock'];
// FeedbackMatchRankingAlgorithm weight names. love = joy, shock = surprise.
const WEIGHT_KEYS = { anger: 'AngerWeight', applause: 'ApplauseWeight', love: 'JoyWeight', laughter: 'LaughterWeight', shock: 'SurpriseWeight' };
const DEFAULT_WEIGHTS = { anger: 0.5, applause: 1, laughter: 1, love: 1, shock: 1 };
// Blob field names as the game writes them (POST /api/account/<id>/app/sostest).
const BLOB_HERO = {
  anger: 'totalAngerFeedbackReceived', applause: 'totalApplauseFeedbackReceived', laughter: 'totalLaughterFeedbackReceived',
  love: 'totalLoveFeedbackReceived', shock: 'totalShockFeedbackReceived',
};
const MAX_MATCHES_KEPT = 500;
const BOARDS = { solo: 'fame_solo', duo: 'fame_duo' };

function createFame({ db, saveDb, displayName = (id) => id, log = () => {} }) {
  const stats = () => db.heroStats || (db.heroStats = Object.create(null));
  const matches = () => db.fameMatches || (db.fameMatches = Object.create(null));

  // ---------- weights ----------
  // env OGSOS_FAME_WEIGHTS (JSON like {"AngerWeight":0.5,"ApplauseWeight":1,...}; lower-case sentiment keys also work),
  // else DEFAULT_WEIGHTS. Not read from the served KV: the real UE_CLIENT_FAME_WEIGHTINGS has an unknown type, and an
  // object there made the game log "Json Value of type 'Object' used as a 'Array'" (capture 2026-11-21), so that key stays
  // out of data/kv-classic.
  function weights() {
    const w = { ...DEFAULT_WEIGHTS };
    let v = null;
    try { v = process.env.OGSOS_FAME_WEIGHTS ? JSON.parse(process.env.OGSOS_FAME_WEIGHTS) : null; } catch { /* bad JSON: defaults */ }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [s, k] of Object.entries(WEIGHT_KEYS)) {
        const x = Number(v[k] ?? v[s]);
        if (Number.isFinite(x)) w[s] = x;
      }
    }
    return w;
  }

  // ---------- one match ----------
  // Raw fame of a player in a match = weighted feedback received.
  function rawFame(counts, w) {
    return SENTIMENTS.reduce((sum, s) => sum + (Number(counts[s]) || 0) * (w[s] || 0), 0);
  }
  // The rating step. Every player of the match gets an entry; the top raw fame (> 0) is the match's fame win.
  // The new rating is the old one plus this match's raw fame.
  function rateMatch(players, feedback) {
    const w = weights();
    const rows = players.map((id) => {
      const counts = {};
      for (const s of SENTIMENTS) counts[s] = Number((feedback[id] && Object.prototype.hasOwnProperty.call(feedback, id) ? feedback[id] : null)?.[s]) || 0;
      return { id, counts, fameDelta: Math.round(rawFame(counts, w)) };
    });
    const sorted = [...rows].sort((a, b) => b.fameDelta - a.fameDelta);
    sorted.forEach((r, i) => { r.rank = i + 1; r.win = i === 0 && r.fameDelta > 0; });
    return rows;
  }

  // Called by the Stream service when a session ends (server.js, `// hero-tv`).
  function recordMatch({ id: sessionId, players = [], feedback = {} }) {
    const ids = [...new Set([...players, ...Object.keys(feedback)])].filter((id) => !badKey(id));
    if (!sessionId || badKey(sessionId) || !ids.length) return null;
    const out = { t: new Date().toISOString(), players: Object.create(null) };
    for (const r of rateMatch(ids, feedback)) {
      const st = stats()[r.id] || (stats()[r.id] = { fame: 0, fameWins: 0, matches: 0, soloFameRating: 0, prevSoloFameRating: 0 });
      for (const s of SENTIMENTS) st[s] = (st[s] || 0) + r.counts[s];
      st.fame = (st.fame || 0) + r.fameDelta;
      st.matches = (st.matches || 0) + 1;
      if (r.win) st.fameWins = (st.fameWins || 0) + 1;
      st.prevSoloFameRating = st.soloFameRating || 0;
      st.soloFameRating = st.prevSoloFameRating + r.fameDelta;
      out.players[r.id] = { counts: r.counts, fameDelta: r.fameDelta, rank: r.rank, win: r.win, prevRating: st.prevSoloFameRating, newRating: st.soloFameRating };
    }
    matches()[sessionId] = out;
    const keys = Object.keys(matches());
    if (keys.length > MAX_MATCHES_KEPT) keys.slice(0, keys.length - MAX_MATCHES_KEPT).forEach((k) => delete matches()[k]);
    saveDb();
    log({ event: 'fame-match', session: sessionId, players: out.players });
    return out;
  }

  // ---------- exports for the shared code ----------
  // Per-account result of one match: {account: {counts, fameDelta, rank, win, prevRating, newRating}}, or null.
  function fameForMatch(sessionId) {
    const m = matches()[sessionId];
    return m ? m.players : null;
  }

  // Hero stats in blob naming: stats.hero.total*FeedbackReceived, stats.social.totalFameWins, the rating fields.
  function heroStats(accountId) {
    const st = stats()[accountId];
    if (!st) return null;
    const out = {};
    for (const [s, k] of Object.entries(BLOB_HERO)) out[k] = st[s] || 0;
    out.totalFameWins = st.fameWins || 0;
    out.fameMatches = st.matches || 0;
    out.soloFameRating = st.soloFameRating || 0;
    out.prevSoloFameRating = st.prevSoloFameRating || 0;
    out.newSoloFameRating = st.soloFameRating || 0;
    return out;
  }

  // Returns a copy of the player blob with Fame filled in. Counters take the larger of the game's value and ours,
  // so feedback the game counted itself is not added twice. Everything else in the blob is left alone.
  function applyToBlob(accountId, blob) {
    const h = heroStats(accountId);
    if (!h || !blob || typeof blob !== 'object' || Array.isArray(blob)) return blob;
    const max = (a, b) => Math.max(Number(a) || 0, Number(b) || 0);
    const out = { ...blob, stats: { ...(blob.stats || {}) }, ratings: { ...(blob.ratings || {}) } };
    const hero = { ...(out.stats.hero || {}) };
    for (const k of Object.values(BLOB_HERO)) hero[k] = max(hero[k], h[k]);
    out.stats.hero = hero;
    out.stats.social = { ...(out.stats.social || {}), totalFameWins: max(out.stats.social?.totalFameWins, h.totalFameWins) };
    const solo = { ...(out.ratings.soloRatings || {}) };
    const fame = { ...(solo.fame || {}) };
    fame.leaderboardId = fame.leaderboardId || BOARDS.solo;
    fame.rating = h.soloFameRating;
    fame.matchesPlayed = max(fame.matchesPlayed, h.fameMatches);
    solo.fame = fame;
    out.ratings.soloRatings = solo;
    return out;
  }

  // Ranked rows for a Fame board. kind: 'solo' | 'duo' | 'fame_solo' | 'fame_duo'. Classic is solo; duo is empty.
  function allRows(kind) {
    const board = BOARDS[kind] || kind;
    if (board !== BOARDS.solo) return [];
    return Object.entries(stats())
      .filter(([, st]) => (st.matches || 0) > 0)
      .map(([member, st]) => ({ member, score: st.soloFameRating || 0 }))
      .sort((a, b) => b.score - a.score || (a.member < b.member ? -1 : 1))
      .map((r, i) => ({ member: r.member, rank: i + 1, score: r.score, uname: displayName(r.member) }));
  }
  function fameLeaderboard(kind, { offset = 0, limit = 100 } = {}) {
    offset = Math.max(0, Math.floor(Number(offset) || 0));
    limit = Math.min(1000, Math.max(1, Math.floor(Number(limit) || 100)));
    return allRows(kind).slice(offset, offset + limit);
  }
  // Rows around one member (?surrounding=N above and below). Unknown member: empty.
  function fameAround(kind, member, surrounding = 5) {
    const rows = allRows(kind);
    const i = rows.findIndex((r) => r.member === member);
    if (i < 0) return [];
    const n = Math.min(100, Math.max(0, Math.floor(Number(surrounding) || 0)));
    return rows.slice(Math.max(0, i - n), i + n + 1);
  }
  const isFameBoard = (board) => board === BOARDS.solo || board === BOARDS.duo;

  // Admin edit (server/admin.js adjust / reset-stats). patch: soloFameRating, fameWins, matches and the five sentiment
  // counters. Only an account that already has hero stats is touched unless { create: true }. Returns { old, new } of the
  // fields that changed, or null when there is nothing to edit.
  function adjust(accountId, patch, { create = false } = {}) {
    if (badKey(accountId)) return null;
    let st = stats()[accountId];
    if (!st) {
      if (!create) return null;
      st = stats()[accountId] = { fame: 0, fameWins: 0, matches: 0, soloFameRating: 0, prevSoloFameRating: 0 };
    }
    const old = {}, nu = {};
    for (const k of ['soloFameRating', 'fameWins', 'matches', ...SENTIMENTS]) {
      if (patch[k] === undefined || !Number.isFinite(Number(patch[k]))) continue;
      const v = Math.round(Number(patch[k]));
      if ((st[k] || 0) === v) continue;
      old[k] = st[k] || 0; nu[k] = v; st[k] = v;
    }
    if ('soloFameRating' in nu) st.prevSoloFameRating = nu.soloFameRating;
    if (Object.keys(nu).length) saveDb();
    return { old, new: nu };
  }

  return { recordMatch, fameForMatch, heroStats, applyToBlob, adjust, fameLeaderboard, fameAround, isFameBoard, weights };
}

module.exports = { createFame, SENTIMENTS, BLOB_HERO };
