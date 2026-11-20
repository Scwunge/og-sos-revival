# SOS matchmaking WebSocket protocol

Reverse-engineered from `SOS-Win64-Shipping.exe` (UE 4.12.5, no PDB) with Ghidra. Source file names come
from the exe's own log strings: `Online/Outpost/MatchmakingClient/Private/OutpostMatchmakingClient.cpp`
(the WebSocket client, `FOutpostMatchmakingClient`) and
`OnlineSubsystemOutpost/Private/OnlineSessionInterfaceOutpost.cpp` (the game-facing session layer).

All addresses are virtual addresses in the shipping exe (image base `0x140000000`). `FUN_xxx` names are
Ghidra's auto-names. Tags: **[C]** = Confirmed (seen in decompiled code), **[I]** = Inferred.

Helper scripts that produced this are in `tools/ghidra/` (`run.ps1` wrapper, `DecompStrRefs`,
`DecompAddr`, `DecompXrefs`, `DecompVtables`, `DecompRange`, `DumpPtrs`).

Notation for the JSON below: `"x": str` = JSON string, `int` = JSON number (read as int32), `bool` = JSON
boolean, `obj` = JSON object. UE's FJsonSerializable silently skips fields whose JSON type does not match
(string=2, number=3, bool=4, object=6, array=5), so wrong types are not errors, they just come out empty.

---

## 1. Framing

### 1.1 Transport [C/I]
* Connects to `ws(s)://<MatchmakingEndpoint>:<MatchmakingPort><MatchmakingPath>`; path default `/ws`
  (`PTR_DAT_142a0b100`, constructor `FUN_140e7d220`). SSL is `MatchmakingSSL`. [C]
* The upgrade request carries `Authorization: Token <jwt>` and `app-id: sos` (seen in `logs/ws.jsonl`).
  **Authentication is entirely in the upgrade headers.** The client sends no auth packet. [C: nothing
  is sent after connect; token comes from the HTTP login]
* Frames are parsed as UTF-8 JSON by `FUN_140e8b490` (`FUN_140134ad0` converts the raw buffer to an
  FString, then JSON parse). The websocket wrapper (`FUN_140e797e0`) does not branch on text vs binary
  that I could see, so either works; send **text** frames. [I]
* One JSON object per frame. No length prefix, no batching. [C]

### 1.2 Envelope [C]
Client to server (every request is built as `FJsonSerializable`; base class vtable `0x142349450`,
serializer `FUN_140e8d7a0`):

```json
{ "type": "<request-type>", "data": { ...request fields... } }
```

Exceptions: requests with no payload (`ping`, `get-regions`, `get-session`, `get-group`,
`leave-all-groups`, `cancel-find-session`, `cancel-group-find-session`) are sent as just
`{ "type": "<request-type>" }` (vtable `0x1423499c8`, serializer `FUN_140e8efa0`).

Server to client (all packets):

```json
{ "type": "<packet-type>", "data": { ...payload... } }
```

* `type` (string) is read first by `FUN_140e8b490` and looked up in a name table at client+0x3f0
  (filled in the constructor `FUN_140e7d220` from the pointer table at `0x142a0b000`). **Types not in the
  table are logged "ignoring packet of type" and dropped** (`*piVar5 == -1` check). The known
  incoming types are exactly: `nak ack pong group group-event regions session session-started
  session-closed session-list summary ready player-join player-leave`. [C]
* `data` (object) is parsed per type (sections 4 and 5). A missing `data` is harmless unless the handler
  needs a field (then it logs a parse error and ignores or fails the op).
* A generic error is `{"type":"nak","data":{"error":"<error-string>"}}` (section 6). The "error" field
  is read from `data.error` for every packet type (`FUN_140e8f060`, vtable `0x1423491c0`, used by
  `FUN_140e85840`). [C]

### 1.3 Request/response matching [C]
**There are no request ids and no nonces.** Operations are queued in a FIFO (client+0x310, count at
+0x318). Only the head operation is "in flight"; every incoming packet that is not one of the
unsolicited kinds below is handed to the head operation's `HandleResponse` (vtable slot +0x10)
(`FUN_140e8b490` tail, then `FUN_140e8ff60` pumps the queue). So the server must answer requests
**in order, one at a time**, and each reply type must be what that operation accepts (section 4).

Unsolicited (never routed to an operation; handled globally and `return`): `pong`, `summary`,
`player-join`, `player-leave`, `group-event`, `ready`.

Globally handled **and then also forwarded to the head op**: `session` (stores session at client+0x558),
`session-started` (stores host/port), `session-closed` (clears session, fires closed delegate). An op
that is not waiting for them logs "unexpected ..." and (for most ops) completes itself with an error,
so do not send these when nothing is queued except as intended (session-closed is fine).

Per-operation phase enum (`FUN_140e8c400`): `0 NotIssued, 1 Issued, 2 Acknowledged, 3 CancelOnIssue,
4 CancelRequested, 5 Completed`. Timeouts (defaults from `0x142a0b120`, overridable in Engine.ini):

| setting | default | meaning |
|---|---|---|
| `MatchmakingPingInterval` | 15.0 s | keepalive ping period (+0x3b0) |
| `MatchmakingMaxMissedPingCount` | 3 | missed pongs before reconnect (+0x39c) |
| `MatchmakingIssueTimeout` | 10.0 s | resend an unanswered request (+0x3d0) |
| `MatchmakingCancelTimeout` | 10.0 s | same for cancel requests (+0x3d8) |
| max re-issues | 3 | then op fails with NoResponse, client goes to state 3 |
| `MatchmakingMaxConnectFailed` | 5 | connection attempts before failing all ops |
| `MatchmakingMaxConnectInterval` | 30.0 s | cap for reconnect backoff |

If the server never answers, the same request is **re-sent** every IssueTimeout seconds (up to 3 times
after the first), so a server must tolerate duplicates (`FUN_140e8ff60` case 1).

---

## 2. Connect handshake

Client state (client+0x340): `1 = connected, waiting for ready`, `2 = ready`, `3 = failed`.

1. Client opens the socket. On "established" callback `FUN_140e81ac0` logs
   "FOutpostMatchmakingClient connected. Waiting for ready." and sets state = 1. **The client sends
   nothing.** [C]
2. **Server must send:**

   ```json
   {"type":"ready"}
   ```

   Handler is in `FUN_140e8b490`: `if (state == 1) { state = 2; missedPongs = 0; lastPong = now;
   if (queue non-empty) FUN_140e8ff60(client); }`. No fields are read from a `ready` packet. [C]
3. Until `ready` arrives the client does **not** send any queued request (`FUN_140e8ff60` case 0 requires
   state == 2). After 1.5x... in practice after the op's issue timeout with no state 2 the op fails with
   "service non-responsive" (`FUN_140e8ff60`, message at 0x15e). [C]
4. After `ready` the client flushes its queue (first op typically `get-regions`, then `find-session`),
   one request at a time. [C for the flush, I for which op is first]

Optionally the server may follow `ready` with a `summary` (section 5.6) so the "players playing/waiting"
numbers are populated.

---

## 3. Keepalive [C]

Function `FUN_140e8c480` (called from the client tick), only when state == 2:

* Every `PingInterval` (15 s) the **client** sends the pre-built string `{"type":"ping"}`
  (built in the constructor from vtable `0x1423499c8`, text at `0x1423496bc` = `ping`).
* It is only sent while there is work: queue non-empty, or (+0x3e0 > 0), or less than 15 s since the last
  activity (+0x3e8). An idle client may go silent. [I for the exact reason, C for the condition]
* **Server replies** `{"type":"pong"}`. Handler stores `lastPong = now` (+0x390); nothing else is read.
* Each interval: if `lastPong < lastPingSent` (no pong since last ping) then `missed++` and logs
  "missed pong. MissedPongCount = %d", else `missed = 0`. When `missed >= MaxMissedPingCount` (3) it logs
  "exceeded max missed pong count" and reconnects (`FUN_140e84200`).
* The server never needs to send pings. The WebSocket-level ping/pong is not used by the client logic.

---

## 4. Operations

Request type strings are ASCII literals in the `GetPacket` functions. Operation classes and their vtables
(`GetPacket` = slot +8, `HandleResponse` = slot +0x10), table at `0x142349c60`:

| request `type` | GetPacket | HandleResponse | class |
|---|---|---|---|
| `get-regions` | `FUN_140e82920` | `FUN_140e87ed0` | FGetRegionsOperation |
| `find-session` | `FUN_140e82640` (data: `FUN_140e7cb50`) | `FUN_140e876c0` | FFindSessionOperation |
| `group-find-session` | `FUN_140e82c00` (data: `FUN_140e7cd50`) | `FUN_140e876c0` | FFindSessionOperation (group variant) |
| `cancel-find-session` | `FUN_140e81b90` | n/a (cancel slot +0x28) | |
| `cancel-group-find-session` | `FUN_140e81d00` | n/a | |
| `create-session` | `FUN_140e823e0` (data: `FUN_140e7c710`) | `FUN_140e87440` | FCreateSessionOperation |
| `join-session` | `FUN_140e82f90` | `FUN_140e88d20` | FJoinSessionOperation |
| `start-session` | `FUN_140e83d40` | `FUN_140e89b90` | FStartSessionOperation |
| `leave-session` | `FUN_140e83950` | (shares op slot table, `FUN_140e87010` tail) | FLeaveSessionOperation |
| `get-session` | `FUN_140e82a90` | `FUN_140e89e50` then `FUN_140e876c0` | FGetSessionOperation |
| `kick-from-session` | `FUN_140e833f0` | `FUN_140e89240` | FKickFromSessionOperation |
| `sessions` | `FUN_140e83b10` | `FUN_140e89940` | FListSessionsOperation |
| `create-group` | `FUN_140e82190` | `FUN_140e871e0` | FCreateGroupOperation |
| `get-group` | `FUN_140e827b0` | `FUN_140e87c80` | FGetGroupOperation |
| `join-group` | `FUN_140e82d80` | `FUN_140e88ac0` | FJoinGroupOperation |
| `leave-group` | `FUN_140e83790` | `FUN_140e895e0` | FLeaveGroupOperation |
| `leave-all-groups` | `FUN_140e83620` | `FUN_140e89440` | FLeaveAllGroupsOperation |
| `kick-from-group` | `FUN_140e831c0` | `FUN_140e89100` | FKickFromGroupOperation |

### 4.0 Shared request sub-objects [C]
(serializer functions found via vtables at `0x142349xxx`)

* **opts** (find/join-group/create-group; `FUN_140e8d960`, vtable `0x1423495b8`):
  ```json
  {"language": str, "map": str, "game-mode": str, "auto-group": bool,
   "regions": { "<region-name>": {"ping": int}, ... },
   "user-data": {"set": str, "char": str, "outfit": str, "var": str}}
  ```
  `regions` is the ping table measured by get-regions (ms per region). `user-data` is the player's
  cosmetic loadout (set/character/outfit/variant, `FUN_140e8d8c0`).
* **create-session opts** (`FUN_140e8d080`, vtable `0x142349630`):
  `{"language","map","game-mode","game-mode-params": str, "public": bool, "regions": {...}}`.
* **group-opts** (`FUN_140e8ebe0`, `0x142349800`):
  `{"map","language","group-type","game-mode": str, "auto-group": bool}`.

### 4.1 get-regions
* Request: `{"type":"get-regions"}`.
* Accepted reply: **`regions`** (anything else = op fails via the "unexpected or error packet" path). [C]
  ```json
  {"type":"regions","data":{ "<region-name>": {"beacon-url": str}, ... }}
  ```
  Parsed by `FUN_140e8f2f0` (vtable `0x142349350`): the `data` object is iterated, each member must be an
  object with `beacon-url` (`FUN_140e8f290`). [C]
* What the client does with it: for each region it fires **3 pings** to the `beacon-url` string
  (`FUN_140e87ed0` loop `iVar4 = 3`, `FUN_140e7af00`), averages the successful round trips
  (`FUN_140e87100`, `FUN_140e84f30`), and completes with a `region -> avg ms` map once all pings finish
  or after `MatchmakingRegionPingsTimeout` (`FUN_140e90830`, log "FGetRegionsOperation timeout ... pings
  remaining"). The ICMP module is linked (`IcmpWindows.cpp`, `IcmpSendEcho`) so the ping is almost
  certainly an ICMP echo to the host in `beacon-url`. [I] Regions with 0 successful pings are omitted
  from the result. Use a reachable host (e.g. `127.0.0.1`) so the average is non-empty. Whether the
  value may carry a scheme/port is unverified. [I]
* No `ack` is expected for this op. The server may send `ack` first; it would be treated as an
  unexpected packet (goes to the error path), so **do not**.

### 4.2 find-session (solo / matchmaking queue)
* Request: `{"type":"find-session","data":{"opts":{ <opts, 4.0> }}}`. [C]
  (data wrapper vtable `0x142349a50` = `{"opts": ...}`.) The group variant `group-find-session` is
  `{"data":{"opts":{<group-opts>}}}` (`FUN_140e7cd50`).
* Reply sequence the op handles (`FUN_140e876c0`): [C]
  1. `ack` (phase Issued -> Acknowledged, fires the "queued" delegate). Optional but expected.
  2. `session` (optional, phase 1 or 2 only): `{"type":"session","data":{"session":{...},"access-token":str}}`.
     * `session.id` must be non-empty or it is ignored.
     * If `session.host` is **empty** the op stays alive (phase 2, "session found, waiting for server").
     * If `session.host` is **non-empty** the op completes immediately (phase 5, success).
  3. `session-started`: `{"type":"session-started","data":{"id":str,"host":str,"port":int}}`.
     `FUN_140e90d40` stores host/port (client+0x5a8 / +0x5b8) if `id` is non-empty; the op then completes
     with success (phase 5). An empty `id` makes the op fail with "session-started for another session".
* Any other type (including `nak`) completes the op with an error (see 6). [C]
* The **session object** (fields read by `FUN_1401c5ef0` / `FUN_1401c6cb0` / `FUN_1401c5e80`) [C]:
  ```json
  {"id": str, "version": str, "name": str, "description": str, "host": str, "port": int,
   "opts": {"game-mode": str, "game-mode-params": str, "min-players": int, "max-players": int,
            "map": str, "language": str, "has-auth": bool},
   "player-map": { "<player-id>": {"uname": str, "auto-group": bool} },
   "groups": { "<group-id>": {"players": [str, ...]} },
   "owner": str}
  ```
  The game later reads this (name, description, map, game mode, players) to build its session search
  result (`FUN_141abdc10`, settings `MAPNAME`, `DESCRIPTION`, `PLAYERIDSSTR`, `PLAYERUNAMESTR`, ...), so
  send a populated `session` before `session-started`. Minimal working form is `session-started` alone. [I]
* Cancel while queued: client sends `{"type":"cancel-find-session"}` (phase 4 CancelRequested). The server
  should answer **`ack`** (that is what the cancel path accepts: handler for phase 4 calls the cancel
  completion, `FUN_140e876c0` first branch and `FUN_140e8ff60` case 4) and stop matching. [C for
  structure, I for the exact reply; `queue-cancel` is a *group event*, see 4.6]

### 4.3 create-session (custom match) / start-session / join-session
* `create-session`: `{"type":"create-session","data":{"opts":{<create opts>},"name":str,"description":str,"pass":str}}`
  (`FUN_140e7c710`; vtables `0x142349670`, `0x142349630`). Accepted reply: **`session`** only
  (phase 1 -> 5, completes with the session); `ack` is not accepted. [C: `FUN_140e87440`]
* `join-session`: `{"type":"join-session","data":{"session-id":str,"pass":str}}` (`FUN_140e82f90`).
  Replies: `ack`, `session`, `session-started` exactly like find-session (`FUN_140e88d20`). [C]
* `start-session` / `leave-session`: `{"data":{"session-id":str}}` (`FUN_140e8fe40`). start-session
  waits for `ack` then `session-started` (`FUN_140e89b90`). The game calls it for `STARTMATCH`
  (log "Failed to notify matchmaking server of match-start"). [C]
* `get-session`: `{"type":"get-session"}` -> `session` or `session-started` (or `ack` first).
  (`FUN_140e89e50` then `FUN_140e876c0`.) [C]
* `kick-from-session`: `{"data":{"session-id":str,"player-id":str}}`, expects `ack` (`FUN_140e89240`). [C]
* `sessions` (browse): `{"data":{"map":str,"opts":{...}}}`-ish (`FUN_140e83b10`, vtables `0x1423494a8`,
  `0x1423494d8` = `{"name":str,"opts":obj}`) -> reply **`session-list`**:
  `{"type":"session-list","data":[ <session object>, ... ]}` (`FUN_140e8fa10`: key `data` is a JSON
  **array**, each element a session object). [C]

### 4.4 create-group / join-group / get-group
* `create-group`: `{"data":{"opts":{<opts 4.0>},"group-opts":{<group-opts>}}}` (`FUN_140e7c550`,
  vtable `0x1423498d8`). Accepted reply: **`group`**. [C: `FUN_140e871e0`]
* `join-group`: `{"data":{"group-id":str,"opts":{<opts>}}}` (`FUN_140e7d160`, `0x142349930`).
  Reply: `group` (`FUN_140e88ac0`). [C]
* `get-group`: `{"type":"get-group"}` -> `group` (`FUN_140e87c80`). [C]
* `group` payload (`FUN_140e8ed80`, `FUN_140e8e1c0`):
  ```json
  {"type":"group","data":{"group":{
     "id": str, "owner-id": str,
     "opts": {"map","language","group-type","game-mode": str, "auto-group": bool},
     "players": { "<player-id>": {"user":{"uname":str}, "connected": bool,
                                  "opts":{"set","char","outfit","var": str}} } }}}
  ```
  (a player entry is `FUN_140e8ec90`, vtable `0x1423497a8`). [C]
* `leave-group`: `{"data":{"group-id":str}}` -> `group` (empty/remaining snapshot) (`FUN_140e895e0`,
  parses the group struct). `leave-all-groups`: `{"type":"leave-all-groups"}` -> `group`
  (`FUN_140e89440`). `kick-from-group`: `{"data":{"group-id":str,"player-id":str}}` -> `ack`
  (`FUN_140e89100`). [C for parse, I that an empty `group` object is acceptable]

---

## 5. Server-initiated packets

### 5.1 ack / nak
* `{"type":"ack"}`, `{"type":"nak","data":{"error":"<error-string>"}}`.

### 5.2 pong, ready: see sections 2, 3.

### 5.3 session-started [C]
`{"type":"session-started","data":{"id":str,"host":str,"port":int}}` (`FUN_140e8fdb0`). Accepted at any
time (it is stored globally by `FUN_140e90d40`, then forwarded to the head op).

### 5.4 session-closed [C]
`{"type":"session-closed","data":{"id":str}}` (`FUN_140e8f9b0`). Only acted on if `id` equals the current
session id (client+0x568); otherwise logged "ignoring unexpected session closed". There is **no field for
the leave reason** (see 6.2).

### 5.5 player-join / player-leave [C]
```json
{"type":"player-join","data":{"id":"<session id>","player-id":str,"uname":str}}
{"type":"player-leave","data":{"id":"<session id>","player-id":str}}
```
(`FUN_140e8f0c0`, `FUN_140e8f150`.) Ignored if `id` is not the current session or `player-id` is empty.

### 5.6 summary [C]
`{"type":"summary","data":{"players":{"playing":int,"waiting":int}}}` (`FUN_140e8fea0`, `FUN_140e8f1c0`;
stored at client+0x338/0x33c, shown as queue numbers).

### 5.7 group-event [C]
```json
{"type":"group-event","data":{"group-id":str,"event":"<kind>", ...}}
```
`event` kinds (`FUN_140e86150`): 
* `join`: + `"player-id":str,"uname":str` (`FUN_140e8eab0`)
* `leave`: + `"player-id":str` (`FUN_140e8eb50`)
* `connection`: + `"player-id":str,"connected":bool` (`FUN_140e8e9a0`)
* `destroy`: no extra fields (group disbanded)
* `queue`, `queue-cancel`: group entered/left the matchmaking queue (fires group delegates)
Unknown kinds log "unrecognized group event type". After `join/leave` the client only updates its cached
group (client+0x508) if it already knows that `group-id`.

---

## 6. Errors and leave reasons

### 6.1 EMatchmakingError (`FUN_140e85330` maps `data.error` string to enum) [C]

| enum | `error` string |
|---|---|
| 0 None | `""` (default/no error string) |
| 1 NoResponse | `no-response` |
| 2 ServiceUnavailable | `service-unavailable` |
| 3 Unauthorized | `unauthorized` |
| 4 ConcurrentClientConnection | `concurrent-client-connection` |
| 5 Other | anything else (e.g. `other`) |
| 6 NotFound | `not-found` |
| 7 Incompatible | `incompatible` |
| 8 GroupFull | `group-full` |
| 9 InOtherGroup | `in-other-group` |

Server sends `{"type":"nak","data":{"error":"<string>"}}` as the reply to a request to fail that
operation (`FUN_140e85840` copies `data.error` when `type == "nak"`; any non-expected type also completes
the op but with error None, string empty). A WebSocket close/refusal triggers reconnect with backoff
(`FUN_140e84200`); after `MaxConnectFailed` (5) failed connects all ops fail with NoResponse.
`concurrent-client-connection` is the intended reply when the same account opens a second matchmaking
socket. [I for that use]

### 6.2 EMatchmakingSessionLeaveReason
Enum values seen: `Unknown`, `Kicked`, `Canceled`. The `session-closed` packet only carries `id`, so the
reason is not transmitted by the server; the client derives it itself (kick op vs cancel op). [I]

---

## 7. How the client reaches the game server

* After the find/join op completes the game layer calls `FUN_141abf980` (OnlineSessionInterfaceOutpost,
  line 0x486): it reads the host string and port from the matchmaking session (client+0x5a8, +0x5b8 =
  the `session-started` `host`/`port`), puts them into the session's `FInternetAddr`, and reports
  join-complete success. **The host must be a literal IP address**: it is passed to
  `FInternetAddr::SetIp(const TCHAR*, bool& bIsValid)`; when invalid the client logs "Could not translate
  host received from matchmaking '%s' into an IP address" and the join fails with an error (result 5).
  In UE 4.12 that function does not do DNS. Use a dotted IPv4 string, not a hostname. [C for the failure
  path, I for no-DNS]
* Connect string: the game calls `GetResolvedConnectString`. Game port type gives `"<ip>:<port>"`
  (`ToString(true)`, port = `session-started.port`). Beacon port type gives `"<ip>:<BEACONPORT>"` where
  `BEACONPORT` is a session setting defaulting to **15000** (`FUN_141aa0360` / `FUN_141ab6fe0`,
  `L"BEACONPORT"`, default `15000`). `GamePort` / `BeaconPort` are UPROPERTY names in the game's own
  classes (the `Online/Outpost` strings), not part of this WebSocket protocol. Travel URL is therefore a
  normal `ClientTravel("<ip>:<port>")` and an online beacon on `<ip>:15000` (APartyBeaconHost style). [I for
  the ClientTravel step; the string formatting is C]
* **`beacon-url` is NOT the game server address.** It only appears in the `regions` reply (section 4.1) as
  the ping target for latency measurement. [C]
* `access-token` in the `session` payload (`FUN_140e8fd30`, field +0x170) is stored with the session and
  later used by the game layer; the dedicated server side uses `-SESSION_ID=` and `-SESSION_TOKEN=`
  command-line options and an HTTP `POST <MatchmakingApi>/session/<id>/events` with
  `Authorization: Token <session token>` (`FUN_141ab85e0`, `FUN_141ac7700`). The exact use of the token on
  the client is unresolved; send any non-empty string. [C that it exists, open on the use]
* **Dedicated server expected, not a listen server.** Sessions carry a `host`/`port` supplied by the
  service, the server binary reads `SESSION_ID`/`SESSION_TOKEN` from its command line and notifies the
  service over HTTP (`.../events`, and a match-start notification), and `has-auth` / `owner` exist on the
  session. Nothing in the WebSocket protocol lets the *client* announce itself as host. For a revival
  the practical approach is to run a dedicated server (or the game's `-server`) on the user's machine and
  advertise `127.0.0.1` / its LAN IP. [I]

---

## 8. Minimal server to get one player into a match

1. Accept upgrade with `Authorization` token (validate JWT), echo first subprotocol (already done).
2. Send `{"type":"ready"}` immediately.
3. Answer `{"type":"ping"}` with `{"type":"pong"}`.
4. `get-regions` -> `{"type":"regions","data":{"local":{"beacon-url":"127.0.0.1"}}}`.
5. `find-session` -> `{"type":"ack"}`, then
   `{"type":"session","data":{"session":{...id,host,port,opts,player-map...},"access-token":"x"}}`
   with empty `host` (or skip), then
   `{"type":"session-started","data":{"id":"<id>","host":"<IPv4>","port":<gameport>}}`.
6. Optionally send `{"type":"summary","data":{"players":{"playing":1,"waiting":0}}}` while waiting.
7. Reply `ack` to `cancel-find-session`, `session-closed` when the match ends.

---

## 9. Example transcript (solo queue)

```
C -> S   (HTTP upgrade GET /ws, Authorization: Token <jwt>, Sec-WebSocket-Protocol: wss,ws)
S -> C   101 Switching Protocols (Sec-WebSocket-Protocol: wss)
S -> C   {"type":"ready"}
C -> S   {"type":"get-regions"}
S -> C   {"type":"regions","data":{"local":{"beacon-url":"127.0.0.1"}}}
         (client now sends 3 ICMP echoes to 127.0.0.1, completes with {"local": ~0 ms})
C -> S   {"type":"find-session","data":{"opts":{"language":"en","map":"","game-mode":"Deathmatch",
          "auto-group":false,"regions":{"local":{"ping":1}},
          "user-data":{"set":"...","char":"...","outfit":"...","var":"..."}}}}
S -> C   {"type":"ack"}
S -> C   {"type":"summary","data":{"players":{"playing":0,"waiting":1}}}
C -> S   {"type":"ping"}                       (every 15 s while a request is pending)
S -> C   {"type":"pong"}
S -> C   {"type":"session","data":{"session":{"id":"s1","version":"1","name":"Local","description":"",
          "host":"","port":0,"opts":{"game-mode":"Deathmatch","game-mode-params":"","min-players":1,
          "max-players":8,"map":"","language":"en","has-auth":false},
          "player-map":{"7656119825903379":{"uname":"Player","auto-group":false}},
          "groups":{},"owner":""},"access-token":"tok"}}
S -> C   {"type":"session-started","data":{"id":"s1","host":"127.0.0.1","port":7777}}
         (client: op completes; game JoinSession -> SetIp("127.0.0.1"), SetPort(7777)
          -> ClientTravel "127.0.0.1:7777"; beacon on 127.0.0.1:15000)
S -> C   {"type":"player-join","data":{"id":"s1","player-id":"7656119825903379","uname":"Player"}}
...
S -> C   {"type":"session-closed","data":{"id":"s1"}}
```

---

## 10. Confidence and open questions

Confirmed (high confidence): envelope and type list, ready handshake, ping/pong, all request type strings
and their field names, the reply types each operation accepts, all payload field names and JSON types,
error strings, no ids/FIFO matching, hosts must be IPs.

Open / unverified:
* Exact semantics of the region ping (ICMP assumed) and whether `beacon-url` may include scheme or port.
* Which op the game issues first and whether it requires non-empty `session` objects before `session-started`
  (minimal path should work without, not tested).
* The idle-ping conditions (+0x3e0, +0x3e8) and exactly how the client uses `access-token` and `version`.
* Whether the cancel path accepts `ack` or just any packet (`FUN_140e8ff60` case 4 retries until a reply).
* Leave reason origin (Kicked/Canceled/Unknown) is client-derived as far as seen.
* `group` empty-snapshot replies to `leave-group`/`leave-all-groups` were inferred from the handler
  building an (empty) group struct.
* Text vs binary frame type not verified at the lws level.
* Cannot confirm the server `Sec-WebSocket-Protocol` echo requirement; the existing echo is fine.

---

## 11. Server implementation

Implemented in `server/matchmaking.js` (protocol, in-memory groups/sessions/queue; no I/O) and wired into
the `/ws` upgrade handler in `server/server.js`. Test with `node tools/mm_test.js [port]` against a running
server (default port 7791).

* **Auth**: the upgrade needs `Authorization: Token <jwt>` with a valid, unexpired JWT, else HTTP 401. A
  second socket for the same account replaces the first (the old one gets `nak concurrent-client-connection`
  and is closed). Other `/ws`-less upgrade paths stay log-only.
* **Ordering**: handlers are synchronous, so replies leave in request order. `ping` is answered with `pong`
  outside the FIFO. Unknown or malformed requests get `nak` (`not-found` / `other`) and are logged.
* **Matching**: `find-session` / `group-find-session` reply `ack` and queue. Once `MIN_PLAYERS` are queued
  (after a `MATCH_BATCH_MS` batching delay) or the oldest entry has waited `QUEUE_TIMEOUT` s, up to
  `MAX_PLAYERS` are put in one session; groups are never split. Each player gets `session` (empty `host`)
  then `session-started` with `GAME_SERVER_HOST:GAME_SERVER_PORT`. A matchmade session younger than
  `LATE_JOIN_SECONDS` with room takes later queuers immediately and sends `player-join` to those inside.
  Queued players get `summary` updates. Matching ignores map/mode/region.
* **Groups**: the owner leaving or disconnecting sends `group-event destroy` (the protocol has no
  owner-changed event); `leave-group`/`leave-all-groups` reply with an empty `group`. Only the owner may
  kick (`unauthorized` otherwise).
* **Custom sessions**: `create-session` replies `session` (empty host); `start-session` replies `ack` then
  sends `session-started` to every member; `join-session` replies `ack`, `session`, plus `session-started`
  if already started. `get-session` and `sessions` return sessions with the real host filled in.
  `leave-session` and `kick-from-session` reply `ack` (the kicked player gets `session-closed`).
* **Config**: `data/config.json` (see `data/config.example.json`) or env `OGSOS_<KEY>`.
