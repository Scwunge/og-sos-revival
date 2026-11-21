# SOS: Classic progression: what the client/host send and parse

Scope: level / XP, match stats, leaderboards, rewards, for the Classic client (UE 4.12.5, Steam app 802240, backend app-id `sostest`). Read-only RE of `SOS-Win64-Shipping.exe` (image base 0x140000000, Ghidra project SOS-Classic) and the pak Blueprints (`tools/pak_list.py`, `tools/kismet_dis.py`), plus our own traffic in `logs/http.jsonl`. No game data is reproduced here, only ids, field names, formats and addresses.

Tags: **[C]** = Confirmed (decompiled parser, Blueprint bytecode, or seen in traffic). **[I]** = Inferred.

## 0. The big picture

**[C]** All progression is computed by the **game host** (the listen/dedicated server running the same exe), not by the client and not by the backend. The host:

1. when a player logs in to the match: `GET /api/account/<id>` and `GET /api/account/<id>/app/sostest` with **the host's session token** (`Authorization: Token <sessionToken>`, a 48-hex string in our logs, not the player's JWT). The reply becomes the player's `PlayerBlob` (`PlayerState->PlayerAppData->PlayerBlob`), which replicates to the owning client (`OnRep_PlayerBlob`, `OnRep_PlayerAppData`).
2. grants XP and stats in the Blueprint `PlayerRewardsComponent` / `ExperienceManager` while the match runs (section 2).
3. at match end (and when a player logs out mid-match), runs `SavePlayerBlobs` and `LeaderboardFunctions::UpdateAllLeaderboards`: for each score-eligible player `POST /api/account/<id>/app/sostest` (the whole blob), then one `POST /api/leaderboard/sostest/<id>` per leaderboard. Both with the host session token.
4. **Save gate (`Gamemode_Survival::CanSaveBlobs`)**: eligible players >= 4 OR the match is not a custom match. Custom matches with < 4 players save nothing. Seen in traffic: the host POSTs appeared 6 ms apart right after the last player left (14:31:11).

The client only GETs the blob at login (to show level/stats in the frontend) and GETs the leaderboards for the frontend. It never writes progression itself. **[C]** (traffic: the only `POST .../app/sostest` and `POST /api/leaderboard/...` carried the host token.)

## 1. Account progression (level / XP)

### Where level and XP live

**[C]** Only in the app blob (`data` of the app data), `progression`:

```json
"progression": { "level": 2, "levelProgress": 0.4166666567325592 }
```

- `level`: int, starts at 1 for a new account (empty `{}` data: first match gave level 1 -> 2 after 1000 XP, see below). **[C]** by arithmetic against the observed POST.
- `levelProgress`: float 0..1 = XP into the current level / XP needed for the next level. **There is no total-XP field.** Clients and host reconstruct XP via `ConvertProgressToExperience = round(progress * needed)`.
- Blueprint struct `OutpostPlayerBlobProgression` (fields `Level`, `LevelProgress`); the JSON is the UE struct serialized camelCase.
- Not in the account JSON (`GET /api/account/<id>` has no level), not in KV, no `/season`/`/inventory` routes (section 4).

### Level curve (client data, not KV)

**[C]** Asset `/Game/Tuning/Experience/ExperienceLevelsCurve` (CurveFloat, linear keys, level -> XP to go from that level to the next):

| level (key) | 1 | 3 | 6 | 10 | 20 |
|---|---|---|---|---|---|
| XP to next level | 500 | 1900 | 3400 | 5000 | 7000 |

Linear in between (level 2 = 1200, 4 = 2400, 5 = 2900, 7 = 3800 ... 19 = 6800). Beyond 20: **[I]** constant 7000 (UE default extrapolation; key interp mode byte 0 = linear, extrapolation not checked). No level cap found in the Blueprint.

`ExperienceManager` (Blueprint, `/Game/Blueprints/Managers/ExperienceManager`), **[C]** from bytecode:

```
needed(L)           = round(curve(L - 1))          // GetExperienceNeededForLevel
xpToNext(level)     = needed(level + 1) = round(curve(level))
CalculateAddedExperience(level, curXP, add):
   rem = curXP + add; next = level + 1; until = needed(next)
   while rem >= until: rem -= until; next++; until = needed(next)
   newLevel = next - 1; newXP = rem
levelProgress       = newXP / max(needed(newLevel + 1), 1)
```

`GrantExperience` converts the blob's (level, progress) to XP, adds, writes `Progression.Level/LevelProgress` back into the blob, and on level-up calls `PlayerState_Survival::HandleLevelUp(old, new)` (broadcast `OnLevelUp`, analytics `PlayerLevelUp`). If the stored progress is >= 1.0 the host first normalizes (`ResolveExcessLevelProgress`), so a backend that edits `levelProgress` above 1 still works.

Worked check against traffic: level 1, +1000 XP (completed match 500 + social podium 500) -> level 2, remaining 500, 500/1200 = 0.41667 = the observed `levelProgress`. **[C]**

### Display

**[C]** `ExperienceManager::GetExperienceDisplayInformationForBlob(blob) -> Level, NextLevel, LevelProgress, CurrentExperience, NextExperience`; used by the post-game `XPProgressionUI` and the frontend. Nothing else (no coins, no tiers).

### Account JSON vs app data

`GET /api/account/<id>` (identity) is unchanged and has no progression. The app-data envelope: `{"version": <int>, "data": {...blob...}}`.

## 2. Match results / stats

### Who posts what

| What | Who | Where | Confirmed |
|---|---|---|---|
| Whole blob (level, stats, badges, ratings, social) | host, per eligible player | `POST /api/account/<id>/app/sostest` | [C] traffic + decompiled |
| Leaderboard rating per player | host | `POST /api/leaderboard/sostest/<lb-id>` (section 3) | [C] |
| Session end | host | `POST /api/session/<id>/events` `{"type":"match-start"}` (seen); `match-end` already handled by our server (CLASSIC.md) | [C] |
| Analytics events (`LogPlayerLevelUp`, `LogPlayerEscaped`, ratings changed ...) | host `UEventLogLibrary` -> `FOutpostAnalyticsProvider` | `POST /api/log` | [I] host sending; **not seen**, our logs only contain client login/language events |

So there is **no separate "match result" POST**. The per-match numbers arrive only as the new blob and as the new leaderboard scores. If you need richer per-match stats on the backend, diff old vs new blob (e.g. `totalGamesPlayed`, `totalEscapes`).

### Blob shape (seen in traffic, host POST body; `version` 8 is the blob schema version)

```json
{
  "version": 1,
  "data": {
    "version": 8,
    "permissions": { "allowCheats": false },
    "stats": {
      "objectives": { "classic": { "totalGamesPlayed": 1, "totalEscapes": 0, "totalRelicsRetrieved": 0 } },
      "social": { "totalFameWins": 1, "totalAlliancesFormed": 0 },
      "hero": {
        "totalShockFeedbackReceived": 0, "totalLaughterFeedbackReceived": 0,
        "totalApplauseFeedbackReceived": 0, "totalLoveFeedbackReceived": 0, "totalAngerFeedbackReceived": 0
      }
    },
    "progression": { "level": 2, "levelProgress": 0.4166666567325592 },
    "badges": {
      "amusing": 0, "hated": 0, "selfish": 0, "generous": 0, "sharpshooter": 0, "friendly": 0,
      "loner": 0, "betrayer": 0, "harmless": 0, "deadly": 0, "caretaker": 0, "loyal": 0, "aggressor": 0
    },
    "ratings": {
      "soloRatings": {
        "fame":     { "leaderboardId": "fame_solo",                 "matchesPlayed": 1, "rating": 0 },
        "survival": { "leaderboardId": "survival_solo",             "matchesPlayed": 1, "rating": 0 },
        "trending": { "leaderboardId": "trending_solo_2026_11_20",  "matchesPlayed": 1, "rating": 0 }
      },
      "duoRatings": {
        "fame":     { "leaderboardId": "", "matchesPlayed": 0, "rating": 0 },
        "survival": { "leaderboardId": "", "matchesPlayed": 0, "rating": 0 },
        "trending": { "leaderboardId": "", "matchesPlayed": 0, "rating": 0 }
      },
      "toxicity": { "leaderboardId": "toxicity", "matchesPlayed": 1, "rating": 0 }
    },
    "social": { "mutedPlayers": [], "history": [] }
  }
}
```

UE struct names **[C]** (exe strings): `OutpostPlayerBlob`, `...Stats`, `...ObjectiveStats`, `...ClassicObjectiveStats`, `...SocialStats`, `...HeroStats`, `...Progression`, `...Badges`, `...Ratings`, `...ModeRatings` (`SoloRatings`, `DuoRatings`, `Toxicity`), `...RatingEntry` (`LeaderboardId`, `MatchesPlayed`, `Rating`), `...Social` (`MutedPlayers`, `History`). Field `rating` is the stored **raw** rating (int, ELO points; the UI shows `rating / 100` rounded).

Missing fields default (UE serializer, lenient). An empty `data: {}` for a new account is accepted (all our logs). **[C]**

### What counts for the stats (Blueprint trackers, `/Game/Blueprints/Player/Rewards/`)

Registered in `PlayerRewards_Survival::AvailableRewardTrackers` **[C]**. Stat trackers (`StatGrant`, +1 each):

| Stat (blob field) | Trigger (requirement class) |
|---|---|
| `totalGamesPlayed` | player spawn (`SpawnRequirement`) |
| `totalEscapes` | `EscapeRequirement` (player escapes via helicopter/rope) |
| `totalRelicsRetrieved` | `KillRequirement` (relic hupia kill) |
| `totalFameWins` | `SocialPodiumRequirement` (top of the audience/fame podium) |
| `totalAlliancesFormed` | `FriendedRequirement` |
| `total{Shock,Laughter,Applause,Love,Anger}FeedbackReceived` | `FeedbackReceivedRequirement` (audience feedback) |

XP trackers (`ExperienceGrant`, amount = `ExperienceCount`; "A" = `AllianceSharedExperienceGrant`, shared with nearby alliance members, scaled by `/Game/Tuning/Experience/AllianceExperienceMultiplierCurve`: alliance size 0-4 -> 1.0, 8 -> 0.2, 9 -> 0.1, linear between):

| XP | Event |
|---|---|
| 500 | completed match; escape (self); social podium |
| 200 | escape assist; A: extraction triggered |
| 100 | teammate escaped; A: helicopter flared |
| 80 | A: kill relic hupia |
| 50 | A: pick up relic |
| 30 | A: kill player; A: pick up gun |
| 20 | revive; trade; friended; cure infection (other); A: kill normal hupia |
| 10 | heal self (medkit); cure infection (self); A: kill small hupia; A: pick up antidote, defib, grenade, headlamp, healing, helmet, jacket, lockpick, melee, mushroom |

(Cure/medkit "self/other" amounts read from the tracker defaults; CureInfectionSelf and MedkitHealOther were not individually dumped, **[I]** 10 / 20.) Achievement trackers (`AchievementGrant`, 14 of them, e.g. `FirstTimeContestant`, `SOSHero`) go to Steam achievements via `SetServerAchievement`, not to our backend. **[C]** names, **[I]** destination.

### Per-player match stats classes (names only)

**[C]** (Blueprint/exe names) `PlayerState_Survival` fields `Escaped`, `Dead`, `SurvivalTime` (int seconds, set at escape), score functions `GetTotalScore`, `GetEscapeScore`, `GetFriendScore`, `GetTreasureScoreTotal`; analytics attribute names `TotalScore`, `EscapeScore`, `FriendScore`, `TreasureScore`, `PlayerScore`. `GameState_Survival::GetScoreEligiblePlayers`. `UPlayerRewardsComponent`, `UPlayerRewardTracker`, `UPlayerGrant` (`EPlayerGrantType` = Stat, EXP, Achievement). `UOutpostPlayerAppData` (`SaveAppData`, `MergeBlobs`, `OnPlayerAppDataChanged`, `ConflictingPlayerBlob`).

### Analytics events relevant to progression (`POST /api/log`, **[I]** whether the host actually sends them)

Envelope (client events, seen): JSON array of `{"Type": "...", "PlayerId": "...", "UserSessionId": "...", "DeviceId": "...", <fields>}`; response `{"version":1,"data":{}}`. Host-side types found in the exe with their attribute names **[C]** for name/fields, **[I]** for delivery: `PlayerLevelUp` {Player, PreviousLevel, NewLevel} (fn 0x1401739f0); `PlayerLeaderboardRatingsChanged` {Player, Prev/New SoloSurvivalRating, SoloFameRating, DuoSurvivalRating, DuoFameRating, ToxicityRating} (fn 0x140173280); `PlayerEscaped` {Player, Location, TeamNum}; `MatchStarted`/`MatchFinished` (fn 0x14016bf60); `RewardTriggered` {GrantType, GrantCount, ...}; `PlayerBadges`. Do not rely on them: not in any capture. The blob POST is the reliable source.

## 3. Leaderboards

All three requests use header `Authorization: Token <token>` and are parsed by the **same** function `FUN_1419ead70` (`FOutpostLeaderboards::GetRankingsResponse`, OutpostLeaderboards.cpp). **[C]**

| Call | Path | Fn |
|---|---|---|
| list | `GET /api/leaderboard/sostest/<id>?start=<int>&limit=<int>` | 0x1419eaa30 |
| around a member | `GET /api/leaderboard/sostest/<id>/<member>?surrounding=<int>` | 0x1419eb740 |
| update (host, match end) | `POST /api/leaderboard/sostest/<id>`, body `[{"member":"<accountId>","score":<int>}]` | 0x1419ebbe0 |

(Our server currently answers all of them `200 []`.)

### Response the client deserializes (for all three, including the POST)

A JSON **array**, **non-empty** (an empty array logs "Response failed to deserialize as a valid json array" and counts as failure, which is what we see today; harmless). Each element is an object:

```json
[ { "member": "76561198000000000", "rank": 0, "score": 1234, "uname": "SomeName" } ]
```

- `member`: string, required (entry skipped with an error if missing).
- `rank`: number (int32), required.
- `score`: number (int32), required.
- `uname`: string, optional (display name; the frontend list shows it).
- Base of `rank` (0 or 1): **unknown** [I], 0-based is the Redis-style guess; the UI was not traced.

HTTP error or non-200: "Request failed" logged, callbacks get failure.

### Leaderboard ids

**[C]** Frontend GETs at login (6 requests, `start=0&limit=100`, JWT token), all seen in traffic:

`fame_solo`, `survival_solo`, `trending_solo_<Y>_<M>_<D>`, `fame_duo`, `survival_duo`, `trending_duo_<Y>_<M>_<D>`

and the host also uses `toxicity` (POST only; `ToxicityLeaderboard`, no frontend list seen).

- `trending_*` id (Blueprint `TrendingLeaderboard::GetLeaderboardId`): `trending_solo` / `trending_duo` + `_` + year `_` month `_` day, **unpadded integers**, date = (UTC now minus 8 hours). Example: `trending_solo_2026_11_20`. The client computes it, so the backend must accept any such id (a new board per day). The date is also copied into the blob's `ratings.*.trending.leaderboardId`.
- Non-trending id: `LeaderboardId` (`fame_solo`...) plus `_<postfix>` when KV `UE_CLIENT_<PREFIX>_LEADERBOARD_ID_POSTFIX` is a non-empty string (lets the operator reset a season). Prefix = upper-case id (`FAME_SOLO`, `SURVIVAL_DUO`, `TRENDING_SOLO`, `TOXICITY`...).
- What is posted: in `Leaderboard::UpdateRankings` only players with `matchesPlayed >= RequiredGames` ("rated") are uploaded as `{member, score = raw rating}`. The raw rating is pairwise ELO per match, **[C]**:
  `dist(r) = 10^(r / RatingAdvantageStep)`; `expectedWinner = dist(w)/(dist(w)+dist(l))`; `change = round(RatingKFactor * (1 - expectedWinner))`; winner +change, loser -change; `matchesPlayed += 1`. Win order per board: survival = escaped beats not escaped (two escapees tie), fame = `FeedbackMatchRankingAlgorithm` (Escaped plus audience-feedback fame score), toxicity = `ToxicityMatchRankingAlgorithm`, trending = the survival algorithm **[I]**. Displayed rating = `(raw + RatingDistributionOffset)`; UI text `UNRATED` until `matchesPlayed >= RequiredGames`. Duo boards use the same code with the `_duo` ids.
- Observed: with one player in the match the POSTs were `survival_solo []`, `fame_solo []`, `toxicity [{member,score:0}]`, `trending_solo_.. [{member,score:0}]` (empty arrays are posted when nobody is rated).

### KV keys (client reads `GET /kv/runtime-N.json`; per prefix P in `FAME_SOLO FAME_DUO SURVIVAL_SOLO SURVIVAL_DUO TRENDING_SOLO TRENDING_DUO TOXICITY`, plus `FAME`, `SURVIVAL`, `TRENDING` for the base classes) **[C]**

`UE_CLIENT_<P>_ELO_K_FACTOR` (int), `_ELO_RATING_ADVANTAGE_STEP` (float), `_ELO_RATING_DISTRIBUTION_OFFSET` (int), `_REQUIRED_GAMES` (int), `_RATING_BRONZE_START`, `_RATING_SILVER_START`, `_RATING_GOLD_START`, `_RATING_GOLD_END` (floats, UI tier bands), `_LEADERBOARD_ID_POSTFIX` (string). Fame also: `UE_CLIENT_FAME_WEIGHTINGS`, `UE_CLIENT_FAME_REQUIRED_DELTA` (formats not decoded). Blueprint defaults: trending K=1000, required games 1; everything else 0/empty, **so with no KV keys the ratings never change** (K = 0) **[C]**. The leaderboard `OnReady` fires when the gold/silver keys arrive **[I]**.
**Our values (our choice, NOT the originals, which are unknown)**, in `data/kv-classic/runtime-3.json` (live-rev 3), for `SURVIVAL`, `SURVIVAL_SOLO`, `SURVIVAL_DUO`: classic ELO, `ELO_K_FACTOR` 32, `ELO_RATING_ADVANTAGE_STEP` 400, `ELO_RATING_DISTRIBUTION_OFFSET` 1000 (everyone shows 1000 at start), `REQUIRED_GAMES` 10, bands bronze 1000 / silver 1200 / gold 1400, gold end 2000. Tune them there (add a new runtime-N.json and bump live-rev so clients refetch). `FAME_*` is left to the hero.tv work (server/fame.js computes Fame); `TRENDING_*` keeps the game defaults; `TOXICITY` is unset.

Related: KV `UE_CLIENT_FRONTEND_LEADERBOARDS` gates the frontend leaderboard UI **[I]**, analytics `LeaderboardClicked` {LeaderboardName}.

## 4. Rewards, season, coins

**[C]** Classic has no rewards/season/wallet backend. The strings `/season`, `unseen-reward`, `store/items`, `/inventory`, `/reconcile`, `GetAppRewards`, `coins_*`, `xp-boost`, `current-level-xp` do **not exist** in the Classic exe (searched UTF-16 and ASCII). The `GetAppRewards` / season / wallet shapes in `docs/INVENTORY_FORMAT.md` are main-client only. There is no "claim reward" call. Rewards in Classic are only the XP/level numbers above (the Blueprint `RewardTextWidget` shows per-event XP toasts from `PlayerGrantResult`, local to the match) and Steam achievements. Level-up rewards: none found (`ReachLevelRequirement` exists as a Blueprint player requirement, used to gate content locally, **[I]**).

## 5. Fame hooks (owned by another agent)

Fame shows up in the same data: blob `stats.social.totalFameWins`, `ratings.soloRatings.fame` / `duoRatings.fame` (`leaderboardId`, `matchesPlayed`, `rating`), leaderboards `fame_solo` / `fame_duo`, KV `UE_CLIENT_FAME_*`, hero feedback counters `stats.hero.total*FeedbackReceived`, and analytics `Prev/NewSoloFameRating`, `Prev/NewDuoFameRating`. Leave these fields untouched in the blob round trip.

## 6. App data transport (what the backend must honour)

**[C]** (decompiled `FOutpostIdentity::SetAccountApp*` / `GetAccountApp*`, fn 0x1419dc390 / 0x1419dca90 / 0x1419dbb60 / 0x1419dbee0, and `UOutpostPlayerAppData` fn 0x1401c6180 / 0x1401c4d80 / 0x1401c3f30)

- `GET /api/account/<id>/app/sostest` -> body must parse as JSON with number `version` and **object** `data` (else "Failed to get ..."). Empty account: `{"version":1,"data":{}}`.
- `POST /api/account/<id>/app/sostest` body `{"version": <the version it read>, "data": {...blob...}}` (compare-and-swap). Reply must parse and contain number `version` (the new version). Plain `PUT` is not used for the blob (PUT is only `app-meta/sostest/language`).
- **HTTP 409** is the CAS-failure signal (`bCasFailure` is set when the response status is 0x199 = 409, checked in fn 0x1419dca90). On 409 the player app data logs "SetAccountApp failed. bCasFailure = ..." and the host runs `MergeAccountApp` (`MergeBlobs`/`ConflictingPlayerBlob`): re-GET, merge, re-POST. Any other failure is just a lost save.
- Auth on the host's calls: `Token <sessionToken>` of the session the host runs, for accounts seated in that session. Our server already returns 200 to these; keep accepting the session token for `GET`/`POST /api/account/<id>/app/sostest` and `GET /api/account/<id>`.

## Implementation notes (backend)

What must be stored and returned so the UI shows level/XP/stats/leaderboards:

1. **App data blob per account, keyed by app `sostest`** (already works; `data/db.json`). Store `{version, data}` verbatim; do not interpret or strip fields. Bump `version` by 1 per accepted POST and return it. Optionally enforce CAS: POST `version` != stored -> 409 (the host merges and retries); safe to skip while one host writes per account.
2. **Never compute XP on the backend.** The host does it. Level/XP/stats appear in the UI purely because the blob is returned unchanged next login. To seed or edit a player, write `data.progression.level` / `levelProgress` (0..1) directly.
3. **Leaderboards**: keep a score table per id (any id string, including the daily `trending_*`). `POST`: upsert each `{member, score}` (replace), then reply a non-empty array with the posted members' `{member, rank, score, uname}`. `GET ?start&limit`: top by score descending, same element shape, with `uname` = the account display name (join from accounts). `GET /<member>?surrounding=N`: the N entries around that member. Return `[]` only for an empty board (the client logs an error but copes). Always 200 with auth (host token or JWT).
4. **KV**: add the `UE_CLIENT_<P>_ELO_K_FACTOR`, `_REQUIRED_GAMES`, `_ELO_RATING_ADVANTAGE_STEP`, `_ELO_RATING_DISTRIBUTION_OFFSET`, `_RATING_*_START/_END` keys for each prefix to `data/kv-classic/runtime-N.json`, otherwise raw ratings stay 0 and all boards show UNRATED. Suggested values are unknown (originals not recoverable); pick e.g. K 32-ish scaled by your point scale and step 400 [I].
5. **Saves are gated by the host**: custom matches with < 4 eligible players never POST a blob or scores. Matchmade (non-custom) matches always do, on match end and on mid-match logout of a player.
6. `/api/log` can stay a sink.

Cannot work / not available:

- Wallet, coins, store, season pass, level rewards, "claim reward": no Classic client code for them.
- A per-match results screen sourced from the backend: the post-game UI is fed by replicated PlayerState on the host, not by any HTTP reply.
- Per-match history/leaderboards by kills, time alive etc.: only the blob counters above and ELO ratings are ever uploaded.

## Open questions

- Rank base (0/1) and exact use of `GET .../<member>?surrounding=N` (who calls it, which screen).
- Extrapolation of the level curve above level 20 (constant 7000 assumed) and whether new accounts without `progression` start at level 1 (arithmetic says yes).
- Whether the host sends `/api/log` analytics (PlayerLevelUp etc.) in a real match; none seen.
- Formats of `UE_CLIENT_FAME_WEIGHTINGS` / `_FAME_REQUIRED_DELTA` and the original K / step / required-games values.
- Exact CAS semantics of the real backend (409 on stale `version` assumed; first-GET `version` of a new account assumed 1).

## 7. Our backend (implemented)

`server/progression.js`, wired in `server/server.js` (Classic app `sostest` only; other apps keep the old behaviour):
- **Blob** `GET/POST /api/account/<id>/app/sostest`: stored verbatim in `db.appData["<id>/sostest"] = {version, data}` (same key as before, so older blobs load). GET needs the host's session token or any player JWT; POST is **host-only** (`Token <SESSION_TOKEN>` of a configured lobby), because logins don't verify the Steam ticket yet. A stale `version` gets 409 with the stored blob; otherwise version + 1. Max 256 KiB. Refusals log `app-data-refused` in `http.jsonl`.
- **Leaderboards** `/api/leaderboard/sostest/<board>[/<member>]`: score table per board in `db.leaderboards["sostest/<board>"]`; POST host-only (`OGSOS_LEADERBOARD_OPEN=1` lifts that on a test backend), `[]` -> 200 `[]`; GET `?start&limit` and `/<member>?surrounding=N`; rows `{member, rank (1-based), score, uname}`. At most 300 boards (oldest dropped; daily `trending_*` boards pile up).
- **Match stats** from the sos_host DLL's `match-end` event (`POST /api/session/<id>/events`, fields in the DLL agreement: `matchId`, `players[{playerId, kills, deaths, damageDealt, escaped, placement, survivalSec, relics, fame, ...}]`): deduped by `matchId`, only ids with an account, values clamped, missing stats not counted. `db.matches` keeps the last 500; `db.playerStats[<id>]` the totals. Public reads: `GET /api/stats/player/<id>`, `GET /api/stats/matches?limit=N`.
- **Fame hook point**: `fameHooks` in `server/server.js` (null by default). The hero.tv work sets it to its `createFame(...)` instance; then `applyToBlob` runs on blob GET/POST, `isFameBoard`/`fameLeaderboard`/`fameAround` answer fame board GETs (falling back to the host-posted scores when they return `[]`), and `fameForMatch(sessionId)` is stored with each match.
- Tests: `node tools/progression_test.js` (unit), `tools/progression_live_test.js` (end to end over HTTP, test backends only: its match-end ends the lobby).


### 7.1 Per-match stats from blob diffs (fallback when the DLL list is empty)

On every host blob POST, `server/progression.js` diffs the new blob against the stored one and records the positive
deltas as that player's entry (`source: "blob"`) in the session's current match record (the session's latest match if it
ended within 60 s, else a new `blob:<session>:<ts>` record). Fields: `xp` (from level + levelProgress, inferred curve),
`escaped`, `relics`, `fameWins`, `alliances`, `feedback{shock,laughter,applause,love,anger}`, `badges`, `level`.
The blob has no kill, death or damage counters; those only come from the DLL's `match-end` list. When a DLL list
arrives for the same session it wins: its entries replace the blob ones (totals undone first), deduped by matchId plus
player; blob-only players stay. `GET /api/stats/player/<id>` also returns `lifetime` (level, xp, games, escapes, relics,
fameWins) read from the stored blob.
