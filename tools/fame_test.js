// Fame (server/fame.js), no network:  node tools/fame_test.js
'use strict';
const { createFame } = require('../server/fame');
let failed = 0;
const ok = (c, what, extra) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}`); if (!c) { failed++; if (extra !== undefined) console.log('      ', JSON.stringify(extra)); } };

// Weights come from env OGSOS_FAME_WEIGHTS (not from the served KV), defaults otherwise.
const def = createFame({ db: {}, saveDb() {} }).weights();
ok(def.anger === 0.5 && def.applause === 1 && def.love === 1 && def.shock === 1, 'default weights (anger 0.5, rest 1)', def);
process.env.OGSOS_FAME_WEIGHTS = JSON.stringify({ AngerWeight: 0.5, ApplauseWeight: 2, JoyWeight: 1, LaughterWeight: 1, SurpriseWeight: 1 });

const db = { accounts: { a1: { 'display-name': 'Alice' }, b2: { 'display-name': 'Bob' } } };
let saves = 0;
const fame = createFame({ db, saveDb: () => saves++, displayName: (id) => db.accounts[id]?.['display-name'] || id });

const w = fame.weights();
ok(w.anger === 0.5 && w.applause === 2 && w.love === 1, 'weights read from env (Joy -> love)', w);

// Match 1: a1 applause 3 + anger 2 = 3*2 + 2*0.5 = 7; b2 laughter 2 = 2; c3 nothing.
const m1 = fame.recordMatch({ id: 'S1', players: ['a1', 'b2', 'c3'], feedback: { a1: { applause: 3, anger: 2 }, b2: { laughter: 2 } } });
ok(m1 && saves === 1, 'recordMatch saves once');
const r1 = fame.fameForMatch('S1');
ok(r1.a1.fameDelta === 7 && r1.a1.rank === 1 && r1.a1.win && r1.b2.fameDelta === 2 && !r1.b2.win && r1.c3.fameDelta === 0, 'fameForMatch: weighted delta, rank, one win', r1);
ok(r1.a1.prevRating === 0 && r1.a1.newRating === 7, 'prev/new rating for the match', r1.a1);

// Match 2: b2 wins with love 9.
fame.recordMatch({ id: 'S2', players: ['a1', 'b2'], feedback: { b2: { love: 9 } } });
const h = fame.heroStats('a1');
ok(h.totalApplauseFeedbackReceived === 3 && h.totalAngerFeedbackReceived === 2 && h.totalFameWins === 1 && h.fameMatches === 2, 'heroStats totals in blob naming', h);
ok(h.prevSoloFameRating === 7 && h.newSoloFameRating === 7, 'no feedback in match 2: rating unchanged', h);
ok(fame.heroStats('b2').soloFameRating === 11 && fame.heroStats('b2').totalFameWins === 1, 'b2 rating 2 + 9 = 11, one win', fame.heroStats('b2'));
ok(fame.recordMatch({ id: '', players: ['a1'] }) === null && fame.recordMatch({ id: 'S3', players: [] }) === null, 'no session id / no players: nothing recorded');

// Leaderboards
const rows = fame.fameLeaderboard('fame_solo');
ok(rows.length === 3 && rows[0].member === 'b2' && rows[0].rank === 1 && rows[0].score === 11 && rows[0].uname === 'Bob' && rows[1].member === 'a1',
  'fame_solo rows {member, rank, score, uname}, best first', rows);
ok(rows.every((r) => typeof r.member === 'string' && typeof r.rank === 'number' && typeof r.score === 'number'), 'every row has the 3 fields the client requires');
ok(fame.fameLeaderboard('solo', { offset: 1, limit: 1 })[0].rank === 2, 'offset/limit paging keeps ranks');
ok(fame.fameLeaderboard('fame_duo').length === 0, 'duo board empty (Classic is solo)');
const around = fame.fameAround('fame_solo', 'c3', 1);
ok(around.length === 2 && around[0].member === 'a1' && around[1].member === 'c3', '?surrounding=1 around the last member', around);
ok(fame.fameAround('fame_solo', 'nobody', 3).length === 0, 'surrounding for an unknown member is empty');
ok(fame.isFameBoard('fame_solo') && fame.isFameBoard('fame_duo') && !fame.isFameBoard('survival_solo'), 'isFameBoard only for fame_*');

// Blob
const blob = { version: 8, stats: { hero: { totalApplauseFeedbackReceived: 1, totalAngerFeedbackReceived: 5 }, social: { totalFameWins: 0, totalAlliancesFormed: 2 } },
  ratings: { soloRatings: { fame: { leaderboardId: 'fame_solo', matchesPlayed: 4, rating: 0 }, survival: { rating: 3 } }, toxicity: { rating: 1 } } };
const out = fame.applyToBlob('a1', blob);
ok(out.stats.hero.totalApplauseFeedbackReceived === 3 && out.stats.hero.totalAngerFeedbackReceived === 5, 'hero counters: max of game and ours', out.stats.hero);
ok(out.stats.social.totalFameWins === 1 && out.stats.social.totalAlliancesFormed === 2, 'totalFameWins set, other social stats kept', out.stats.social);
ok(out.ratings.soloRatings.fame.rating === 7 && out.ratings.soloRatings.fame.matchesPlayed === 4 && out.ratings.soloRatings.fame.leaderboardId === 'fame_solo', 'fame rating from fame.js, matchesPlayed max', out.ratings.soloRatings.fame);
ok(out.ratings.soloRatings.survival.rating === 3 && out.ratings.toxicity.rating === 1 && out.version === 8, 'other ratings untouched');
ok(blob.stats.hero.totalApplauseFeedbackReceived === 1 && blob.ratings.soloRatings.fame.rating === 0, 'input blob not modified');
ok(fame.applyToBlob('nobody', blob) === blob, 'account without fame: blob returned as is');

console.log(failed ? `${failed} FAILED` : 'ALL OK');
process.exit(failed ? 1 : 0);
