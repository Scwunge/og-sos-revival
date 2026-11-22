# Community hosts

Third parties can run a Classic game host and register it with this backend. A registered host gets a session id and a
host token, and shows up in `GET /servers` (and so in the client mod's server list) once it is reachable. It reuses the
normal hosted-session lifecycle (waiting, countdown, started, ended, reset) and the normal host routes
(`GET /api/session/<id>` poll, `POST .../reset`, `/end`, `/start`, `/announce`, `/events`), so the existing `sos_host` DLL
and host container work unchanged. Only the Classic matchmaker takes community hosts.

Players are never auto-seated into a community lobby. They reach one by picking it in the server list
(`POST /api/servers/<id>/join-hint`, then find-session) or by an explicit join-session with its id. Clients are always told
the host's own address, never `PUBLIC_HOST` (that is the official pool's address).

## API

All bodies are JSON, at most 4 KB (413 otherwise).

### `POST /api/community/register`

The address of the host is the TCP source address of this request. A `host` field is optional and must equal it
(`400 host-mismatch`); `X-Forwarded-For` is ignored.

| field | meaning |
| --- | --- |
| `name` | 3 to 48 characters, required. Whitespace runs are collapsed. Names containing "official" or "og sos" are refused unless the host is verified. |
| `port` | UDP game port, 1024 to 65535, default 7777 |
| `region` | optional, up to 16 characters |
| `maxPlayers` | 2 to the server cap, default the cap |
| `hostIds` | up to 4 strings of digits, the host's own player id (`"0"` under Wine, or a SteamID64); default `["0"]` |
| `key` | optional community key; a valid one makes the host verified |
| `sessionId`, `sessionToken` | renewal credentials (see below) |

Success (200): `{ result, sessionId, sessionToken, verified, listed:false, heartbeatSec:30, expireSec, firstPollSec, probe:"pending"|"off"|"ok"|"failed", note }`.

Errors: `503 disabled`, `429 rate-limited`, `400 bad-body | address-not-public | host-mismatch | bad-port | bad-name | bad-max-players | bad-host-ids`,
`403 banned | key-required | ip-mismatch`, `401 unauthorized` (wrong token on a known id), `409 already-registered | id-in-use`,
`429 too-many-for-ip | too-many-for-network`, `503 registry-full | too-many-pending`.

Renewal: register again with the stored `sessionId` and `sessionToken` (every 5 minutes or so, and on every start; send the
`key` again each time). The same id and token come back. A renewal from a different IP is `403 ip-mismatch`. Registering
the same ip and port without credentials is `409 already-registered`, so nobody can take over a registered host.

Backend restarts: the registry is in memory. A renewal with an unknown but well-formed id (a UUID) and token (32 to 128 hex
characters) re-creates the host with exactly that id and token, so a game that keeps running with them on its command line
carries on. It still passes every normal check, and an id used by a pool host or another community host is `409 id-in-use`.
A new registration (no credentials, or malformed ones) gets a freshly generated id and a 48-hex token.

### `POST /api/community/unregister`

`Authorization: Token <sessionToken>`, body `{ "sessionId": "<id>" }`. Removes the host; seated players are released with
`session-closed`.

### `GET /api/community/status/<id>`

Public, no token, works for unlisted hosts. Flat object for watchdog scripts:
`{"id","listed","probe","online","state","players","lastSeenSec","verified"}`. `players` excludes the host's own ids,
`lastSeenSec` is `null` before the first poll, `state` is `waiting|countdown|started|ended`. `404 {"error":"not-found"}` for unknown ids.

### Listing

`GET /servers` entries gain `community` and `verified` booleans. Order: official entries, then verified community hosts, then
other community hosts. A community host is listed only after the game polled `GET /api/session/<id>` at least once, is online
(polled within `HOST_ONLINE_SECONDS`), and its UDP probe succeeded (or the probe is off). Join hints for an unlisted host are `409 unlisted`.

### Probe and expiry

Before listing, the backend sends a UDP packet to `host:port` (up to three tries) and expects a 32-byte datagram back
from that same address and port (`OGSOS_COMMUNITY_PROBE_REPLY_BYTES`). A failed
probe keeps the host unlisted and is retried at most once a minute; a listed host is re-probed every 10 minutes. A host is
removed if the game never polled within `FIRST_POLL_SECONDS` of (re)registration, or once both its last poll and its last
registration are older than `EXPIRE_SECONDS`. A host that is registered but still not listed after
`OGSOS_COMMUNITY_PENDING_SECONDS` (120) is removed too, however often it renews. A sweep runs every 15 seconds.

## Settings (environment)

| key | default | meaning |
| --- | --- | --- |
| `OGSOS_COMMUNITY_ENABLED` | 1 | 0 is the kill switch: registration refused, every registered host removed at once |
| `OGSOS_COMMUNITY_KEYS` | none | comma-separated keys; a matching `key` in the register body makes the host verified |
| `OGSOS_COMMUNITY_REQUIRE_KEY` | 0 | 1 refuses registration without a valid key |
| `OGSOS_COMMUNITY_BANS` | none | comma-separated IPv4 addresses, IPv4 CIDRs and/or session ids; registered hosts are removed on the next sweep |
| `OGSOS_COMMUNITY_MAX_PER_IP` | 3 | registered hosts per source IP |
| `OGSOS_COMMUNITY_MAX_PER_NET` | 3 | registered hosts per source /24 (`429 too-many-for-network`) |
| `OGSOS_COMMUNITY_MAX_PENDING` | 20 | registered hosts not listed yet (`503 too-many-pending`) |
| `OGSOS_COMMUNITY_PENDING_SECONDS` | 120 | how long a host may stay registered without being listed |
| `OGSOS_COMMUNITY_PROBE_REPLY_BYTES` | 32 | exact size of the probe reply, 0 accepts any datagram |
| `OGSOS_COMMUNITY_MAX_TOTAL` | 50 | registered hosts in total |
| `OGSOS_COMMUNITY_RATE_PER_IP` | 10 | register calls per IP per 10 minutes (renewals count) |
| `OGSOS_COMMUNITY_FIRST_POLL_SECONDS` | 600 | remove a host the game never polled within this long |
| `OGSOS_COMMUNITY_EXPIRE_SECONDS` | 600 | remove a host with no poll and no renewal for this long |
| `OGSOS_COMMUNITY_PROBE` | 1 | UDP reachability probe before listing |
| `OGSOS_COMMUNITY_ALLOW_PRIVATE` | 0 | 1 accepts private, loopback, link-local and CGNAT source addresses (local testing only) |
| `OGSOS_COMMUNITY_MAX_PLAYERS` | the matchmaker `MAX_PLAYERS` | cap for a host's `maxPlayers` |

Public source addresses only by default: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 224/4 and 240/4 are
refused. If the backend sits behind a proxy or NAT that hides the real source address, hosts cannot register (by design: the
address a host is listed under is never taken from the request body or a header).

## Trust model

Registration is open, with limits (per-IP cap, rate limit, total cap, public addresses only, UDP probe, name rules, bans, kill
switch). Keys make a host verified. The recommendation for now: keep registration open with limits, hand out keys to hosts you
know, and switch `OGSOS_COMMUNITY_REQUIRE_KEY` on if it gets abused.

An unverified community host:

- is listed with `verified:false`, after official and verified hosts;
- cannot write any player's blob (`POST /api/account/<id>/app/sostest`) or post leaderboard scores (401); it can read blobs,
  which the game needs to load a player;
- does not feed match stats: its `match-end` event still ends the session but records nothing;
- cannot use the words "official" or "og sos" in its name;
- is never chosen by automatic matchmaking.

A verified host counts like an official host for progression writes and match stats, so only give keys to people you trust
with player data. Keys are secrets: they are only ever compared, never logged or listed. Tokens are never logged.
