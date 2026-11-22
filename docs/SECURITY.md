# Backend security notes

What the backend (`server/`) enforces on its own, how to tune it, and what the deployment has to provide.
Tests: `node tools/hardening_test.js` (limits, refusals, persistence, host write scope, report queue, IP tracking and IP
bans, retention, log redaction) and `node tools/crash_test.js` (hostile input must never stop the process).

## 1. Request limits

| Limit | Value |
|---|---|
| Request body | 64 KB. 300 KB for `POST /api/account/<id>/app/sostest` and `POST /session/<id>/events` (also under `/api`). 4 KB for `/api/community/*`. |
| Over the cap | `413 {"error":"too-large"}`, nothing more is buffered, the connection is closed after the response. The body is never logged. |
| Timeouts | headers 15 s, whole request 30 s, keep-alive 5 s, 4000 connections. |
| Unparseable request line / URL | `400`, the process keeps running (`//`, `/%zz`, ...). |

Every limit is applied per client address (section 3). Over the limit: `429 {"error":"rate-limited"}` with `Retry-After`.

| Route | Default | Environment override (the maximum) |
|---|---|---|
| `POST /api/access-token/*` (login) | 60 per 10 min | `OGSOS_RATE_LOGIN` |
| `/api/reports`, `/api/account/*/report`, `/api/account/*/app-meta/*/report`, `/api/reports/*/evidence` | 20 per hour | `OGSOS_RATE_REPORT` |
| `/api/search/*` | 30 per min | `OGSOS_RATE_SEARCH` |
| `/kv/*` | 300 per min | `OGSOS_RATE_KV` |
| `POST /api/servers/*/join-hint`, `POST /api/session/*/vote-start` | 60 per min | `OGSOS_RATE_HINT` |
| `/admin/login`, `/admin/auth` | 20 per 10 min | `OGSOS_RATE_ADMIN` |
| everything else | 1200 per min | `OGSOS_RATE_GLOBAL` |
| WebSocket upgrades | 30 per min | `OGSOS_RATE_WS` |

The global limit does not apply to loopback callers or to requests carrying a valid host session token (pool and community
hosts poll every few seconds). The route-specific limits apply to everyone. `OGSOS_RATE_<NAME>=0` blocks the class,
so raise the number rather than trying to disable it.

## 2. WebSockets

Only `/ws` (matchmaking, needs a JWT) and `/ws/stream` (anonymous read-only use, see 5) upgrade; any other path gets `404`.

| Limit | Value |
|---|---|
| Concurrent sockets per client address / total | 16 (`OGSOS_MAX_WS_PER_IP`) / 3000 (`OGSOS_MAX_WS_TOTAL`), over: `429` / `503` |
| Frames | client frames must be masked, no RSV bits, opcodes 0-2 and 8-10 only (close 1002); control frames FIN and at most 125 bytes |
| Size | one frame and one reassembled (fragmented) message at most 256 KB (close 1009) |
| Message rate | 50 data messages per 10 s per socket (`OGSOS_WS_MSG_MAX`), then close 1008 |
| Keepalive | server ping every 30 s (`OGSOS_WS_PING_MS`); a socket that sent nothing for 300 s (`OGSOS_WS_IDLE_MS`) is dropped, pongs count |

## 3. Client address behind a proxy

`clientIp(req)` is the TCP peer, except when the peer is loopback, a Docker bridge address (172.16.0.0/12) or listed in
`OGSOS_TRUSTED_PROXIES` (comma separated exact IPs). Then the **last** `X-Forwarded-For` entry is used, the one the proxy
appended; earlier entries are client-controlled and ignored. A client connecting directly to a public port cannot choose its
address.

When Caddy runs on the Docker host and proxies to the host's own public address (`reverse_proxy <backend-host>:7781`), the
backend sees Caddy as that public address, not as a Docker bridge address. Put that address in `OGSOS_TRUSTED_PROXIES` in
the deployment's `.env` (never in git), otherwise every HTTPS client shares one rate-limit bucket. Only processes on the
host itself can connect from that address: Docker DNATs external traffic to published ports and keeps the real source
address.

Community host registration (`/api/community/register`) deliberately keeps using the raw socket address, so
register on the direct port, not through the proxy.

## 4. Logs

`logs/*.jsonl` (`OGSOS_LOG_DIR`) are for debugging, and they are redacted:

- headers `authorization`, `cookie`, `x-ogsos-admin`, `sec-websocket-key` keep the scheme and the first 6 characters
  (`Token abc123...`);
- JSON bodies, responses and WebSocket texts have the keys `session-auth-token`, `sessionToken`, `token`, `access-token`,
  `key`, `password`, `secret`, `ticket` masked (case-insensitive); `?token=`-style query values and JWT-shaped strings are
  masked in any text;
- IP addresses never reach the log files: IPv4 and IPv6 literals in any logged string, the `ip` field, the `Host` header
  and matchmaker text become `ip-redacted`, and proxy headers that only carry an address (`x-forwarded-for`, `x-real-ip`,
  `forwarded`, `cf-connecting-ip`, ...) are replaced whole. Player addresses live only in `db.json` (section 9);
- every logged string is cut to 2048 characters;
- a file larger than 50 MB (`OGSOS_LOG_MAX_BYTES`) is renamed to `<file>.1` (replacing the old one) and a new file starts
  (size checked about every 1000 writes or 10 s);
- `log()` never throws, a full disk does not stop the server.

Older logs written before this change still contain tokens and Steam tickets. Delete them, and rotate `secret.key` and
the community keys if those logs ever left the machine.

## 5. Accounts, tokens and stream

- Login accepts only `steam-id` matching `^7656\d{13}$` (`400 bad-steam-id` otherwise; no id means no account). The Steam
  session ticket is **still not verified** (design item): anyone who knows a Steam id can log in as it. It is never logged.
- Roles in the JWT are computed by the server. Classic ignores the roles the client asks for; other apps may get
  `app-user` and `user` only.
- JWTs are not stored. `readJwt` checks the `HS256` header, compares the signature in constant time and requires a numeric
  `exp` that has not passed. `secret.key` is created mode 0600 and must hold at least 32 characters or the backend refuses to
  start.
- `GET/POST /api/account/<id>/app/<app>` for apps other than Classic: any valid JWT may read, only the account itself
  writes, 64 KB, at most 16 app keys per account (`409`). Classic data keeps its host-only write rules.
- `/api/search/account` needs a JWT and returns at most 50 rows with `id`, `account-id`, `alias`, `display-name`.
  `GET /api/account/<id>` returns that reduced view unless the caller is the account itself.
- `/ws/stream`: anonymous sockets may ping, view, subscribe and read counts. `session`, `session-end`, `feedback`,
  `create-vote` and `cast-vote` need a socket with a valid JWT (`Authorization: Token ...` or `?token=`). Only the connection
  that owns a session can end it, a session's players must be SteamID64s, the feedback rate cap is per account, and one
  socket holds at most 3 sessions, 20 views and 2 open votes. Web spectators that send feedback or votes therefore need to
  pass a token in the embed URL.
- Id-keyed maps (`accounts`, `appData`, `leaderboards`, `heroStats`, `playerStats`, moderation `bans`/`notes`/`warnings`/`mods`)
  are prototype-free, and `__proto__`, `constructor`, `prototype` are refused as ids at the edges.
- Community hosts that are not verified cannot announce a name containing "official" or "og sos"; names lose zero-width and
  bidi characters.
- Admin panel: the OpenID assertion must sign `claimed_id`, `identity`, `return_to`, `response_nonce` and `op_endpoint` and the
  nonce must be at most 5 minutes old; `/admin/login` and `/admin/auth` are rate limited.

## 6. Persistence and backups

- `db.json` is written to `db.json.tmp` and renamed over it, at most once per second (writes are coalesced) and on
  SIGTERM/SIGINT. The first save of a process copies the previous `db.json` to `db.json.bak`.
- Startup: no `db.json` is a first run; one that does not parse is never replaced by an empty db: the backend loads `db.json.bak`, and if
  that fails too it exits with code 1 and leaves the files alone (restore a backup instead of starting empty).
- Nightly archives of the state volume: `deploy/classic-backend/backup.sh` driven by `backup.cron` (14 days kept).
  Restore: stop the backend, untar the chosen archive into the `ogsos_state` volume mountpoint, start the backend.
  (`tar -xzf <archive> -C <mountpoint>`; the archive holds `secret.key`, keep the backup directory private.)

## 7. Exposure notes

- Port `7781/tcp` must stay public while existing clients still talk plain http to `<backend-host>:7781`; they can move to
  https through the proxy later. Docker publishes ports around the host firewall (UFW), so the compose file publishes only
  `7781/tcp` and the game UDP ports and nothing else.
- The admin panel sets `Secure` cookies when `OGSOS_ADMIN_ORIGIN` is https, so `/admin` only works through https
  (`https://<backend-host>/admin/`), not over the plain port.
- Set `OGSOS_ADMIN_ORIGIN` in production, keep `OGSOS_ADMIN_DEV_LOGIN` and `OGSOS_ADMIN_GAME_WATCH` off, and keep
  `OGSOS_LEADERBOARD_OPEN` unset.

## 8. Hardening status

Fixed in the first pass: request/body caps and timeouts, per-route rate limits, WebSocket limits, `clientIp` with trusted
proxies, log redaction, SteamID64 shape check, HS256 pinning and constant-time compare, atomic `db.json` with a backup,
prototype-free id maps, owner-only blob writes for non-Classic apps, stream/session ownership rules, OpenID assertion
checks, community host name rules.

Fixed in the second pass:

- **Host write scope.** A host session token can write a Classic blob or leaderboard row only for a player who is seated in
  that host's session now, or was seated in it within the last 30 minutes (so end-of-match saves still land), or is one of
  the host's own ids. Anything else is `403 {"error":"not-seated"}`; a leaderboard post naming any non-seated member is
  refused whole. Code: `wasSeated` in `server/matchmaking.js`, `inScope` in `server/progression.js`.
  `OGSOS_HOST_WRITE_ANY=1` turns the check off (tests only; never set it in production).
- **Report queue.** Reports are capped at `OGSOS_MAX_REPORTS` (default 5000). When full, the oldest resolved or dismissed
  report is evicted; open and investigating reports are never dropped, and if none can be evicted the new one gets
  `429 {"error":"report-queue-full"}` (audited at most once an hour). Per reporter: 20 open reports per account and 30 per
  client address (`429 too-many-open-reports`). The per-address rate maps are bounded.
- **Admin logout** is `POST /admin/logout` with the `X-OGSOS-Admin: 1` header only (GET is `405`, no header is `403`), so a
  link or image cannot sign an admin out.
- **Community hosts.** The UDP probe needs a 32-byte reply from the registered ip:port (a bare datagram from anyone no longer
  lists a host); at most 3 registered hosts per source /24 (`too-many-for-network`); at most 20 hosts that were never listed
  (`503 too-many-pending`); a host that never gets listed is removed after 120 s (`pending-expired`), renewals do not extend that.
- **Player IP tracking and IP bans**, owner only (section 9).

Environment variables added in the second pass:

| Variable | Default | Meaning |
|---|---|---|
| `OGSOS_HOST_WRITE_ANY` | off | 1 disables the host write scope (tests only) |
| `OGSOS_MAX_REPORTS` | 5000 | report queue size |
| `OGSOS_IP_RETENTION_DAYS` | 90 | player IP retention (section 9) |
| `OGSOS_COMMUNITY_MAX_PER_NET` | 3 | registered community hosts per source /24 |
| `OGSOS_COMMUNITY_MAX_PENDING` | 20 | registered hosts waiting to be listed |
| `OGSOS_COMMUNITY_PENDING_SECONDS` | 120 | how long an unlisted host may stay registered |
| `OGSOS_COMMUNITY_PROBE_REPLY_BYTES` | 32 | exact size of the probe reply (0 = any datagram) |

Still open (by decision or not done):

- **Login does not verify the Steam session ticket.** Anyone who knows a Steam id can get a token for it. This is a known
  design item, left as it is on purpose. Everything below that says "the account id from the JWT" is only as strong as that.
  Account bans and IP bans are the mitigation.
- Moderators still see community host addresses on the community page (existing behaviour, host addresses are public in the
  server list anyway); player addresses are owner only.
- No hardware or device bans.

## 9. Player IP tracking and IP bans (owner only)

- **What is stored.** Per account in `db.json` (`ipHistory`): the first and last address, and up to 50 addresses with first
  seen, last seen and a count. Recorded on login, on `/ws` and `/ws/stream` sockets that carry an account, on join-hint,
  vote-start and when a report is filed. The address is `clientIp(req)` (section 3). Loopback, private, Docker, CGNAT and
  the trusted proxies' own addresses are never recorded. Code: `server/iptrack.js`.
- **Who sees it.** Only owners (`OGSOS_ADMINS`). For moderators the admin API leaves out every IP field: player profile
  (`ips`, `sharedIp`), report detail and report edit (`ips`), the audit `ip` field and the audit CSV `ip` column. Owner views of a
  player's or report's addresses and the address lookup write an `ip-view` audit entry (once per admin and target per
  10 minutes).
- **Reports** store a snapshot at filing time: the target's last address and up to 10 from the last 30 days, and the
  reporter's address.
- **Shared addresses.** Owner profile and report pages list other accounts seen on the same address in the last 90 days;
  `GET /admin/api/ip/<ip>` lists the accounts seen on one address.
- **Retention.** `OGSOS_IP_RETENTION_DAYS` (default 90): at startup and then daily, an address last seen longer ago is
  deleted, and an account left with none loses its entry. Addresses in stored report snapshots and in IP ban records are
  kept.
- **IP bans.** Owner only: `GET/POST /admin/api/ip-bans`, `POST /admin/api/ip-bans/<id>/lift` (panel: Bans page). A target is
  an IPv4, an IPv6 or an IPv4 CIDR from /16 to /32, with an optional duration. Banning loopback, private or CGNAT ranges, the
  trusted proxies, a range that covers one, or a malformed target is refused (`400`), so an owner cannot lock out the proxy or
  the whole network by mistake. An IP ban refuses login (the same `403` body as an account ban), `/ws` and `/ws/stream`
  upgrades (`403`), join-hint and report filing from that address. Plain reads and the host routes are not affected. It can
  catch other players behind the same router, which is why bans take an expiry.
- **Logs** never contain addresses (section 4). The audit log (`db.moderation`) keeps the address of an ip-ban or ip-view
  in a separate `ip` field that is owner only and is not written to `logs/admin.jsonl`.

## 10. Building your own auth

This backend's login is a stand-in: it trusts the Steam id the client sends (section 5). If you replace it with real
verification (Steam, your own accounts), these are the places that matter. Nothing here is secret; line numbers drift, search
for the function names.

**Where login happens.** `server/server.js`, the handler for `POST /api/access-token` and `/api/access-token/steam` (search
`'/api/access-token'`; it is the route that calls `makeJwt`). In order: parse the JSON body, check `steam-id` against
`STEAM_ID_RE` (`server/safe.js`), refuse banned accounts and banned addresses (`moderation.isBanned`, `moderation.ipBanned`),
`moderation.recordIp`, create or touch `db.accounts[id]`, decide roles (`classicRoles` for Classic), `makeJwt`, reply. The
Steam ticket (`session-auth-token`) is read by nobody; **this is where to verify it** (for example with Steam's
`ISteamUserAuth/AuthenticateUserTicket`), before the ban check or right after it, and answer `401` on failure.

**What the Classic client sends and expects.** Request: `POST /api/access-token/steam` with a JSON body
`{"steam-app-id":"802240","steam-id":"<SteamID64>","session-auth-token":"<hex ticket>","roles":[...],"app-id":"sostest"}`;
every later HTTP request carries `Authorization: Token <jwt>` and an `app-id` header. Reply (200): the account view
(`id`, `account-id`, `alias`, `display-name`) plus `user-id`, `access-token`, `token` (the JWT, the client refuses anything
that is not `xxx.yyy.zzz`) and, for Classic, `roles`; the same object is repeated under `data` with `version: 1`. A banned
account gets `403 {"error":"forbidden","metadata":{"cause":"app-banned",...}}` (`moderation.banBody`), the shape the client's
login error handler parses. A wrong or missing token elsewhere is `401`. The client reads these JWT claims: `id`,
`account-id`, `user-id`, `sub` (all the account id), `steam-id`, `roles`, `app-id`, `iat`, `exp`. See docs/CLASSIC.md.

**Where JWTs are verified.** One function: `readJwt` in `server/server.js` (HS256 with `secret.key`, header `alg` pinned,
constant-time signature compare, numeric `exp` required). Everything goes through it:
`jwtAccount(tok)` for HTTP routes (`progression`, `moderation` get it as an option), `accountFromAuth(req)` for `/api/account`,
and `wsAccount(req, token)` for WebSockets (`/ws` header token, `/ws/stream` header or `?token=`). Tokens are minted only by
`makeJwt`. If your auth issues tokens, keep `readJwt` as the single verifier and keep `exp` mandatory.

**Host session JWT (a second, separate token).** Game hosts authenticate with `Authorization: Token <SESSION_TOKEN>`, a
per-lobby secret from `OGSOS_CLASSIC_HOSTS`/`OGSOS_HOSTS` or issued to a community host at registration; `isHostToken` in
`server/server.js` compares it in constant time. Players get a per-session access token for the host: it is minted by
`makeSessionJwt` in `server/matchmaking.js` (HS512, keyed with the lobby's `sessionToken`, `sub` = session id,
`roles: ["user+session"]`, 24 h) and verified by `readSessionJwt` (same file; used by `vote-start`). The game host verifies it
itself with the same key. A player JWT is never valid as a host token or the other way round.

**Where bans hook in.** Account bans: `moderation.isBanned(id)` (`server/admin.js`), checked at login, at the `/ws` and
`/ws/stream` upgrade (`handleUpgrade`), in `filterPlayerMap` (banned ids are dropped from a host's player map) and when
reports and matchmaking act. IP bans: `moderation.ipBanned(ipOrReq)` at login, the WebSocket upgrade, join-hint and
`addReport`. If you add a new way in (another login route, another socket), call both.

**Routes that trust the account id from the JWT** (so they are only as good as login):
`GET/POST /api/account/<id>/app/<app>` for non-Classic apps (writer must equal `<id>`) and Classic blobs for the owner
(`progression.js`, `allowOwnerWrite`), `GET /api/account` (no id: the caller), `/api/search/account`, reports
(`/api/reports`, `/api/account/<id>/report`, `.../app-meta/<app>/report`, `/api/reports/<id>/evidence`: the reporter),
`POST /api/servers/<id>/join-hint`, `POST /api/session/<id>/vote-start` (the seat owner), the WebSocket identity for
matchmaking, `session`, `feedback` and votes (`/ws`, `/ws/stream`), and `handleWatchApi` (admin watch link, off by default
for this reason). The admin panel does not use these tokens: it has its own Steam OpenID login and signed cookie
(`/admin/login`, `/admin/auth`, `server/admin.js`).
