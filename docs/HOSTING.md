# Hosting runbook: how prod is laid out and how to change it

For whoever operates the Linux VPS. No real addresses or ssh aliases are in the repo; use your own (`<vps>` below).
Background: `docs/LINUX_HOST.md` (why it works), `docs/COMMUNITY_HOSTS.md` (other people's hosts), `docs/SECURITY.md`
(backups and restore), `docs/ADMIN.md` (moderation panel).

## 1. Layout

One Docker compose project, **`ogsos`**, defined in `deploy/classic-backend/compose.yaml` (on the VPS under
`/opt/ogsos/deploy/classic-backend/`, with the git checkout's `deploy/` and `server/` beside it). **Always pass `-p ogsos`**:
`docker compose -p ogsos ...`. Without it, compose from that directory names the project after the folder and creates a second
project that clashes with the running containers.

| Service | Container | Port | Notes |
|---|---|---|---|
| `backend` | `ogsos-backend-1` | TCP 7781 | the lobby/API/web backend (`server/server.js`), image `ogsos-backend:local` |
| `host1` | `ogsos-host1-1` | UDP 7777 | game host, lobby "OG SOS Classic 1", map LaCuna |
| `host2` | `ogsos-host2-1` | UDP 7778 | lobby 2, `GAME_MAP=/Game/Maps/Test_Mike/Layouts/Circle01` (test arena) |
| `host3` | `ogsos-host3-1` | UDP 7779 | lobby 3, `GAME_MAP=/Game/Maps/Test_Will/Crater` (experimental, not match-ready) |

Hosts run the game under Wine + Xvfb (`deploy/classic-host/`, image `ogsos-classic-host:local`). Per host, on the VPS:
`/srv/ogsos/pool/<n>/game` (a copy of the game; **never committed**, holds `version.dll` + `sos_host.ini`),
`/srv/ogsos/pool/<n>/prefix` (Wine prefix), `/srv/ogsos/pool/<n>/logs`. Per-host settings are in
`deploy/classic-backend/pool/host<n>.env` (session id/token, `GAME_MAP`, optional `SOS_HOST_MAX_FPS`, `RESTART_HOUR`...).
Lobby names and the session ids/tokens the backend trusts are `OGSOS_CLASSIC_HOSTS` in `deploy/classic-backend/.env`.
Backend env (admins, origins, hosts) is `.env`; nothing secret is committed (`.env.example` is the template).
HTTPS is Caddy in front of the backend (a `reverse_proxy` to TCP 7781; WebSockets pass through), admin panel at `/admin`.

Test slots (`profiles: ["prog"]` and the `*-test` / hero containers) are not part of prod. Leave them stopped unless you are
testing; they were published publicly and are set to `restart: "no"`.

## 2. What the host supervisor does (`deploy/classic-host/entrypoint.sh`)

It starts the game, waits for `Listening with` in `sos_host.log`, then polls the backend about every 15 s and **recycles**
(stop, back off if needed, start a fresh game) when:
- the game exits (and backs off up to 5 min if it dies within 90 s three times, so the lobby shows offline instead of a crash loop);
- no `Listening with` within `LISTEN_TIMEOUT` (300 s);
- the match ended: it **waits for the post-game show**, i.e. until the last `Players alive=A connected=C` line in
  `sos_host.log` has `connected=0` (at least 20 s, at most `POSTGAME_MAX`, default 300 s), then recycles for a fresh map;
- the backend does not see the host (lobby gone from `/servers`, `lastSeenSec` null or older than `POLL_STALE`) for
  `BAD_GRACE` (default 120 s) while nobody is connected;
- the backend container's IP changed (it was recreated): recycles once the lobby is idle, since the game was started with the old IP;
- the daily restart (fresh 24 h token) while the lobby is empty and waiting.

On every stop it copies `sos_host.log` and `sos_game_*.log` to `/srv/ogsos/pool/<n>/logs/` first (the game recreates them at start,
so without this a hang's evidence is lost). `GAME_MAP` selects the launch map (default `LaCuna`; a full path works).
`SOS_HOST_MAX_FPS` defaults to 60 (a listen host ticks and acks moves once per frame).
The Windows host kit (`deploy/host-kit/windows/sos-server.ps1`) has the same post-game drain and backend-not-seen rules.

## 3. Rules for changing things

1. **Recreate, never restart.** `docker compose -p ogsos up -d --force-recreate --no-build host2`. `docker compose restart` /
   `docker restart` keeps `/tmp`, including a stale Xvfb lock, and the game then crash-loops.
2. **Only while the lobby has 0 players.** Look at `/servers` (players, state) and the host's last `Players alive=... connected=...`
   line. Never recreate the backend or a host mid-match.
3. **Restarting the backend changes its container IP.** Hosts recycle themselves once idle (see above); check all three come
   back online (`node tools/smoke_test.js <host> 7781 3`; hosts take a minute or two to register).
4. **Rollback first.** Before replacing anything, tag or copy what is running:
   - images: `docker tag ogsos-backend:local ogsos-backend:prev-<yyyymmdd-hhmm>` and
     `docker tag ogsos-classic-host:local ogsos-classic-host:prev-<yyyymmdd>[letter]`;
   - env files: `cp .env .env.bak-<what>-<date>`, `cp pool/host2.env pool/host2.env.bak-<what>`;
   - the DLL: `cp -p version.dll version.dll.<first 8 hex of the old SHA256>` (see section 4).
   Roll back by re-tagging `prev-*` to `local` (or restoring the backed-up file) and recreating the service.
5. **Build from committed code:** `git archive HEAD | ssh <vps> 'rm -rf /tmp/ogsos-src && mkdir /tmp/ogsos-src && tar -x -C /tmp/ogsos-src'`
   then `docker build -t ogsos-backend:local -f deploy/classic-backend/Dockerfile .` (from that tree) or
   `docker build -t ogsos-classic-host:local deploy/classic-host`. The image's root filesystem is read-only: you cannot hot-copy a
   file into a running container, rebuild instead.
6. **Backend deploy checklist:** all tests pass; 0 players in all three lobbies; rollback image tagged and `.env` backed up;
   build; `up -d --force-recreate --no-build backend`; smoke test; roll back at once on a regression.
7. **Never print `.env` or the host env files** (tokens). Read them in shape only (`grep -c`, `sed 's/TOKEN=.*/TOKEN=***/'`).

## 4. Swapping the host DLL (`version.dll`, the `sos_host` mod)

The DLL lives in each host's game copy: `/srv/ogsos/pool/<n>/game/SOS/Binaries/Win64/version.dll`.
1. Copy the new build to the VPS and verify its SHA256 matches the one you were given.
2. Per host, only at 0 players: `cp -p version.dll version.dll.<oldsha8>` (backup), `install -m 755 <new> version.dll`
   (owner must be the host user, normally `ubuntu`), then `docker compose -p ogsos up -d --force-recreate --no-build host<n>`.
3. Verify: `sos_host.log` shows `Listen(<the right map>) requested`, `Listening with`, and `/servers` lists the lobby online.
4. Rollback: copy the backup over `version.dll` and recreate.
`sos_host.ini` next to it holds the DLL's options (rates, `MaxFPS`, move correction); `SOS_HOST_MAX_FPS` and the other
`SOS_HOST_*` env vars override it.

## 5. Backups

- Backend state (`db.json`, `secret.key`, mod data): nightly tarball by `deploy/classic-backend/backup.sh` (cron at 04:17 UTC,
  14 days kept, mode 700 directory). Restore steps are in `docs/SECURITY.md`.
- Config: `.env.bak-*` and `pool/host*.env.bak-*` beside the live files, one per change (named for what changed).
- Images: `ogsos-backend:prev-*`, `ogsos-classic-host:prev-*`. Prune old ones when disk is tight; keep the last few.
- The game copies under `/srv/ogsos/pool` are not in git and are large; keep one pristine copy elsewhere to rebuild a host from.

## 6. Quick health check

```
docker compose -p ogsos ps
curl -s https://<your-domain>/servers          # players/state/online per lobby
node tools/smoke_test.js <vps-address> 7781 3   # from a checkout
docker exec ogsos-host1-1 tail -n 20 /game/SOS/Binaries/Win64/sos_host.log
```
