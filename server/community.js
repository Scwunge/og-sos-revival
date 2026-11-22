// Community host registry (see docs/COMMUNITY_HOSTS.md). Third-party Classic hosts register here, get a session
// id + host token, and are listed in GET /servers once the game has polled and the UDP probe succeeded.
// Pure logic: the clock, the probe and the matchmaker are injected. No dependencies.
'use strict';
const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const { cleanLabel } = require('./matchmaking');

// UE4 stateless-handshake "initial connect" packet: bit 0 = handshake flag, zero padding, then the terminating 1 bit
// at bit 200 (26 bytes). A listening Classic host answers with a 32-byte connect challenge (the game logs
// "LogHandshake: SendConnectChallenge"); verified 21 Nov 2026 against a Windows listen host. 25-byte packets get no
// reply, nor do all-zero or random 26-byte ones. No connection is created by the challenge.
const PROBE_PACKET = (() => { const b = Buffer.alloc(26); b[0] = 0x01; b[25] = 0x01; return b; })();
const PROBE_REPLY_BYTES = 32;   // the challenge's size: a datagram of any other size (an echo, a generic UDP responder) does not count


// Resolves true if a datagram of replyBytes bytes comes back from exactly host:port within timeoutMs (up to 3 tries, 1 s
// apart; replyBytes 0 = any size). Never throws.
function udpProbe(host, port, timeoutMs = 3000, replyBytes = PROBE_REPLY_BYTES) {
  return new Promise((resolve) => {
    let sock = null, done = false, timer = null, tries = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearInterval(tries);
      try { sock && sock.close(); } catch { /* already closed */ }
      resolve(v);
    };
    try {
      sock = dgram.createSocket('udp4');
      sock.on('error', () => { /* ICMP unreachable etc: keep waiting for the timeout */ });
      sock.on('message', (msg, rinfo) => { if (rinfo.address === host && rinfo.port === port && (!replyBytes || msg.length === replyBytes)) finish(true); });
      let n = 0;
      const send = () => { if (n++ < 3) { try { sock.send(PROBE_PACKET, port, host, () => {}); } catch { /* ignore */ } } };
      send();
      tries = setInterval(send, 1000);
      tries.unref && tries.unref();
      timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref && timer.unref();
    } catch { finish(false); }
  });
}

const flag = (v, def) => (v === undefined || v === null || v === '' ? def : !/^(0|false|no|off)$/i.test(String(v).trim()));
const int = (v, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };
const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

// Settings from the environment (all optional, see docs/COMMUNITY_HOSTS.md).
function loadCommunityConfig(env = process.env) {
  return {
    enabled: flag(env.OGSOS_COMMUNITY_ENABLED, true),
    keys: list(env.OGSOS_COMMUNITY_KEYS),
    requireKey: flag(env.OGSOS_COMMUNITY_REQUIRE_KEY, false),
    bans: list(env.OGSOS_COMMUNITY_BANS),
    maxPerIp: int(env.OGSOS_COMMUNITY_MAX_PER_IP, 3),
    maxTotal: int(env.OGSOS_COMMUNITY_MAX_TOTAL, 50),
    maxPerNet: int(env.OGSOS_COMMUNITY_MAX_PER_NET, 3),           // listed + pending hosts per source /24, on top of maxPerIp
    maxPending: int(env.OGSOS_COMMUNITY_MAX_PENDING, 20),         // registered hosts that were never listed yet
    pendingSec: int(env.OGSOS_COMMUNITY_PENDING_SECONDS, 120),    // a host not listed this long after it first registered is dropped
    probeReplyBytes: int(env.OGSOS_COMMUNITY_PROBE_REPLY_BYTES, PROBE_REPLY_BYTES),   // 0 = any reply size counts
    ratePerIp: int(env.OGSOS_COMMUNITY_RATE_PER_IP, 10),
    firstPollSec: int(env.OGSOS_COMMUNITY_FIRST_POLL_SECONDS, 600),
    expireSec: int(env.OGSOS_COMMUNITY_EXPIRE_SECONDS, 600),
    probe: flag(env.OGSOS_COMMUNITY_PROBE, true),
    allowPrivate: flag(env.OGSOS_COMMUNITY_ALLOW_PRIVATE, false),
    maxPlayers: int(env.OGSOS_COMMUNITY_MAX_PLAYERS, 0),   // 0 = the matchmaker's MAX_PLAYERS
  };
}

const net24 = (ip) => String(ip).split('.').slice(0, 3).join('.');
const ipToInt = (ip) => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);
function inCidr(ip, cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (!net.isIPv4(base) || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(ipToInt(ip) / size) === Math.floor(ipToInt(base) / size);
}
const PRIVATE_RANGES = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4'];
const isPublicIp = (ip) => net.isIPv4(ip) && !PRIVATE_RANGES.some((r) => inCidr(ip, r));

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const RATE_WINDOW_MS = 10 * 60 * 1000;
const REPROBE_MS = 10 * 60 * 1000;
const RETRY_PROBE_MS = 60 * 1000;
const MAX_RATE_KEYS = 20000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{32,128}$/i;
const reply = (status, body) => ({ status, body });

function createCommunityRegistry({ mm, config, now = Date.now, probe: probeIn, log = () => {} }) {
  const cfg = { ...loadCommunityConfig({}), ...config };
  const probe = probeIn || ((h, p) => udpProbe(h, p, 3000, cfg.probeReplyBytes));
  const cap = cfg.maxPlayers > 0 ? cfg.maxPlayers : 16;
  const hosts = new Map();      // id -> { id, token, ip, host, port, name, verified, registeredAt, probe, probeAt, probing }
  const rate = new Map();       // ip -> [timestamps]
  const inflight = new Set();   // pending probe promises

  const bans = () => cfg.bans.map((b) => String(b).toLowerCase());   // read live so a reload / test can change cfg.bans
  const bannedIp = (ip) => bans().some((b) => (b.includes('/') ? inCidr(ip, b) : b === ip));
  const bannedId = (id) => bans().includes(String(id).toLowerCase());
  const keyValid = (k) => typeof k === 'string' && k.length > 0 && cfg.keys.some((x) => safeEq(x, k));

  function rateHit(ip, t) {
    const arr = (rate.get(ip) || []).filter((x) => t - x < RATE_WINDOW_MS);
    arr.push(t);
    rate.set(ip, arr);
    if (rate.size > MAX_RATE_KEYS) {   // keep the map bounded: drop the oldest keys
      for (const k of [...rate.keys()].slice(0, rate.size - MAX_RATE_KEYS)) rate.delete(k);
    }
    return arr.length > cfg.ratePerIp;
  }

  function startProbe(h) {
    if (!cfg.probe || h.probing) return;
    h.probing = true; h.probeAt = now();
    const host = h.host, port = h.port;
    const p = Promise.resolve().then(() => probe(host, port)).catch(() => false).then((ok) => {
      h.probing = false;
      if (hosts.get(h.id) !== h || h.host !== host || h.port !== port) return;   // removed or moved meanwhile
      const was = h.probe;
      h.probe = ok ? 'ok' : 'failed';
      if (was !== h.probe) log(`community host ${h.id} (${h.ip}:${h.port} "${h.name}") probe ${h.probe}`);
    }).then(() => { inflight.delete(p); });
    inflight.add(p);
  }

  function remove(id, why) {
    const h = hosts.get(id);
    if (!h) return null;
    hosts.delete(id);
    const released = mm.removeCommunityHost(id, why);
    log(`community host removed (${why}): ip ${h.ip} id ${id} name "${h.name}"`);
    return released;
  }

  function badName(name, verified) {
    if (name.length < 3) return true;
    if (!verified && /official|og sos/i.test(name)) return true;
    return false;
  }

  function register(ip, body, authToken) {
    const t = now();
    if (!cfg.enabled) return reply(503, { error: 'disabled' });
    if (rateHit(ip, t)) return reply(429, { error: 'rate-limited' });
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    if (!b) return reply(400, { error: 'bad-body' });
    if (!net.isIPv4(ip) || (!cfg.allowPrivate && !isPublicIp(ip))) return reply(400, { error: 'address-not-public' });
    if (bannedIp(ip)) { log(`community register refused (banned): ip ${ip}`); return reply(403, { error: 'banned' }); }
    if (b.host !== undefined && b.host !== null && b.host !== '' && b.host !== ip) return reply(400, { error: 'host-mismatch' });

    // Renewal credentials: an existing community host of the same ip.
    const renewId = typeof b.sessionId === 'string' && b.sessionId ? b.sessionId : null;
    const renewTok = typeof b.sessionToken === 'string' && b.sessionToken ? b.sessionToken : (authToken || '');
    const existing = renewId ? hosts.get(renewId) : null;
    if (existing) {
      if (!safeEq(existing.token, renewTok)) return reply(401, { error: 'unauthorized' });
      if (existing.ip !== ip) return reply(403, { error: 'ip-mismatch' });
      if (bannedId(renewId)) return reply(403, { error: 'banned' });
    }

    const verified = keyValid(b.key);
    if (cfg.requireKey && !verified) return reply(403, { error: 'key-required' });

    const port = b.port === undefined || b.port === null || b.port === '' ? 7777 : b.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return reply(400, { error: 'bad-port' });
    const name = cleanLabel(b.name, 48).replace(/\s+/g, ' ');
    if (badName(name, verified)) return reply(400, { error: 'bad-name' });
    const region = cleanLabel(b.region, 16).replace(/\s+/g, ' ');
    let maxPlayers = cap;
    if (b.maxPlayers !== undefined && b.maxPlayers !== null && b.maxPlayers !== '') {
      if (!Number.isInteger(b.maxPlayers) || b.maxPlayers < 2 || b.maxPlayers > cap) return reply(400, { error: 'bad-max-players' });
      maxPlayers = b.maxPlayers;
    }
    let hostIds = ['0'];
    if (b.hostIds !== undefined && b.hostIds !== null) {
      if (!Array.isArray(b.hostIds) || b.hostIds.length > 4 || !b.hostIds.every((x) => typeof x === 'string' && /^\d{1,20}$/.test(x))) return reply(400, { error: 'bad-host-ids' });
      hostIds = b.hostIds.slice();
    }

    let h = existing;
    if (h) {
      const moved = h.port !== port;
      mm.updateCommunityHost(h.id, { host: ip, port, name, region, maxPlayers, verified, hostIds });
      Object.assign(h, { port, name, verified, registeredAt: t });
      if (moved) h.probe = cfg.probe ? 'pending' : 'off';
      log(`community host renewed: ip ${ip} id ${h.id} name "${name}"`);
    } else {
      for (const o of hosts.values()) if (o.ip === ip && o.port === port) return reply(409, { error: 'already-registered' });
      let perIp = 0;
      for (const o of hosts.values()) if (o.ip === ip) perIp++;
      if (perIp >= cfg.maxPerIp) return reply(429, { error: 'too-many-for-ip' });
      // Per source /24 (listed + pending) and a separate cap on hosts that were never listed, so spam from one network or a
      // flood of unreachable registrations cannot take the slots of working hosts.
      let perNet = 0, pending = 0;
      const net = net24(ip);
      for (const o of hosts.values()) { if (net24(o.ip) === net) perNet++; isListed(o.id); if (!o.everListed) pending++; }
      if (perNet >= cfg.maxPerNet) return reply(429, { error: 'too-many-for-network' });
      if (pending >= cfg.maxPending) return reply(503, { error: 'too-many-pending' });
      if (hosts.size >= cfg.maxTotal) return reply(503, { error: 'registry-full' });
      // Re-claim after a backend restart: the game still runs with its old id/token, so an unknown but well-formed
      // id + token pair is accepted as is (never one that collides with a pool or community session).
      const reclaim = renewId && UUID_RE.test(renewId) && TOKEN_RE.test(renewTok);
      const id = reclaim ? renewId : crypto.randomUUID();
      if (bannedId(id)) return reply(403, { error: 'banned' });
      const token = reclaim ? renewTok : crypto.randomBytes(24).toString('hex');
      try { mm.addCommunityHost({ host: ip, port, sessionId: id, sessionToken: token, hostIds, name, region, maxPlayers, verified }); }
      catch { return reply(409, { error: 'id-in-use' }); }
      h = { id, token, ip, host: ip, port, name, verified, registeredAt: t, pendingSince: t, everListed: false, probe: cfg.probe ? 'pending' : 'off', probeAt: 0, probing: false };
      hosts.set(id, h);
      log(`community host ${reclaim ? 're-claimed' : 'registered'}: ip ${ip} id ${id} name "${name}"${verified ? ' (verified)' : ''}`);
    }
    if (cfg.probe && h.probe !== 'ok') startProbe(h);
    return reply(200, {
      result: true, sessionId: h.id, sessionToken: h.token, verified: h.verified, listed: isListed(h.id),
      heartbeatSec: 30, expireSec: cfg.expireSec, firstPollSec: cfg.firstPollSec, probe: h.probe,
      note: 'Listed once the game has polled this backend and the UDP port answers a reachability probe. Keep the host running; renew by registering again with the same sessionId and sessionToken.',
    });
  }

  function unregister(id, token) {
    const h = hosts.get(String(id));
    if (!h) return reply(404, { error: 'not-found' });
    if (!safeEq(h.token, token || '')) return reply(401, { error: 'unauthorized' });
    const released = remove(h.id, 'unregistered');
    return reply(200, { result: true, released });
  }

  function isListed(id) {
    const h = hosts.get(String(id));
    if (!h) return false;
    const listed = mm.lastPollOf(h.id) !== null && mm.hostOnline(h.id) && (h.probe === 'ok' || h.probe === 'off');
    if (listed) h.everListed = true;   // no longer counts against the pending cap, whatever happens to it later
    return listed;
  }

  // Public status for the host's watchdog scripts (flat, same field semantics as the GET /servers entries).
  function status(id) {
    const h = hosts.get(String(id));
    if (!h) return null;
    const v = mm.listHosted().find((x) => x.id === h.id) || {};
    return {
      id: h.id, listed: isListed(h.id), probe: h.probe, online: !!v.online, state: v.state || 'waiting',
      players: v.players || 0, lastSeenSec: v.lastSeenSec === undefined ? null : v.lastSeenSec, verified: h.verified,
    };
  }

  const communityInfo = (id) => { const h = hosts.get(String(id)); return h ? { community: true, verified: h.verified, listed: isListed(h.id) } : null; };
  function communityIdForToken(tok) {
    if (!tok) return null;
    for (const h of hosts.values()) if (safeEq(h.token, tok)) return h.id;
    return null;
  }
  const isVerifiedToken = (tok) => { const id = communityIdForToken(tok); return !!id && hosts.get(id).verified; };

  // Every 15 s: kill switch, bans, expiry, due probes, rate-map pruning. Returns a promise for tests (probes started).
  function sweep() {
    const t = now();
    for (const h of [...hosts.values()]) {
      if (!cfg.enabled) { remove(h.id, 'disabled'); continue; }
      if (bannedIp(h.ip) || bannedId(h.id)) { remove(h.id, 'banned'); continue; }
      const lp = mm.lastPollOf(h.id);
      // Pending (never listed) entries expire PENDING_SECONDS after the first registration; renewals do not extend it.
      if (!isListed(h.id) && !h.everListed && t - h.pendingSince > cfg.pendingSec * 1000) { remove(h.id, 'pending-expired'); continue; }
      if (lp === null && t - h.registeredAt > cfg.firstPollSec * 1000) { remove(h.id, 'never-polled'); continue; }
      if (t - Math.max(lp || 0, h.registeredAt) > cfg.expireSec * 1000) { remove(h.id, 'expired'); continue; }
      if (cfg.probe && !h.probing) {
        const due = h.probe === 'pending' ? true
          : h.probe === 'failed' ? t - h.probeAt >= RETRY_PROBE_MS
          : t - h.probeAt >= REPROBE_MS;
        if (due) startProbe(h);
      }
    }
    for (const [ip, arr] of rate) {
      const live = arr.filter((x) => t - x < RATE_WINDOW_MS);
      if (live.length) rate.set(ip, live); else rate.delete(ip);
    }
    return whenIdle();
  }
  const whenIdle = () => Promise.all([...inflight]).then(() => undefined);

  return { register, unregister, status, sweep, badName, isListed, communityInfo, isVerifiedToken, communityIdForToken, whenIdle, _hosts: hosts, _cfg: cfg };
}

module.exports = { createCommunityRegistry, loadCommunityConfig, udpProbe, PROBE_PACKET, PROBE_REPLY_BYTES, isPublicIp };
