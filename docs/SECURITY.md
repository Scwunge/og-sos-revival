# Backend security notes

What the backend (`server/`) enforces on its own, how to tune it, and what the deployment has to provide.
Tests: `node tools/hardening_test.js` (limits, refusals, persistence) and `node tools/crash_test.js` (hostile input must
never stop the process).

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
