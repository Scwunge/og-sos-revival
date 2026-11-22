'use strict';
// Player IP tracking and IP bans (docs/SECURITY.md section 8). Pure logic, no dependencies.
//   - normalize / isPrivate / isEligible: which addresses may ever be stored as a player's IP
//   - createIpTracker({ db }): db.ipHistory (null-proto) accountId -> { first, last, ips: { [ip]: { first, last, count } } }
//   - parseBanTarget / banMatches: IP ban targets (IPv4, IPv6, IPv4 CIDR /16../32) and matching
// IPs are only ever read back by the owner-only admin API (server/admin.js). Nothing here logs.
const net = require('net');
const { badKey } = require('./safe');

const DAY_MS = 24 * 3600 * 1000;
const MAX_IPS_PER_ACCOUNT = 50;
const ID_RE = /^[\w.-]{1,64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Canonical text of an IP, or null. IPv4-mapped IPv6 becomes plain IPv4; IPv6 is compressed and lower-cased.
function normalize(ip) {
  let s = String(ip === undefined || ip === null ? '' : ip).trim();
  if (!s || s.length > 64) return null;
  s = s.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) s = mapped[1];
  const kind = net.isIP(s);
  if (!kind) return null;
  if (kind === 4) return s;
  try { return new URL(`http://[${s}]/`).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return null; }
}

const v4ToInt = (ip) => ip.split('.').reduce((a, x) => a * 256 + Number(x), 0);
// [first, last] address pairs (as integers) of the ranges that are never a player's address and never bannable.
const PRIVATE_V4 = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]
  .map(([b, bits]) => { const size = 2 ** (32 - bits); const lo = Math.floor(v4ToInt(b) / size) * size; return [lo, lo + size - 1]; });

function isPrivateV6(ip) {
  if (ip === '::' || ip === '::1') return true;
  const first = parseInt(ip.split(':')[0] || '0', 16);
  if (!Number.isFinite(first)) return true;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;   // fc00::/7, fe80::/10, ff00::/8
}
// Loopback, private, link-local, CGNAT, multicast, reserved (the Docker bridge range 172.16/12 is in here).
function isPrivate(ip) {
  const n = normalize(ip);
  if (!n) return true;
  if (net.isIPv4(n)) { const x = v4ToInt(n); return PRIVATE_V4.some(([lo, hi]) => x >= lo && x <= hi); }
  return isPrivateV6(n);
}

// -> { kind: 'ip' | 'cidr', value } (value normalized; CIDR as the network address) or { error }.
// Refuses private/loopback ranges and anything that covers a trusted proxy address.
function parseBanTarget(raw, isTrusted = () => false, trustedList = []) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s || s.length > 64) return { error: 'bad-ip' };
  const m = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (m) {
    const bits = Number(m[2]);
    if (!net.isIPv4(m[1]) || bits < 16 || bits > 32) return { error: 'bad-cidr' };
    const size = 2 ** (32 - bits);
    const lo = Math.floor(v4ToInt(m[1]) / size) * size, hi = lo + size - 1;
    if (PRIVATE_V4.some(([a, b]) => lo <= b && hi >= a)) return { error: 'private-range' };
    for (const t of trustedList) { const n = normalize(t); if (n && net.isIPv4(n) && v4ToInt(n) >= lo && v4ToInt(n) <= hi) return { error: 'trusted-proxy' }; }
    const base = [lo >>> 24, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255].join('.');
    return bits === 32 ? { kind: 'ip', value: base } : { kind: 'cidr', value: `${base}/${bits}` };
  }
  const n = normalize(s);
  if (!n || s.includes('/')) return { error: 'bad-ip' };
  if (isPrivate(n)) return { error: 'private-range' };
  if (isTrusted(n)) return { error: 'trusted-proxy' };
  return { kind: 'ip', value: n };
}

// Does this ban record ({ kind, value }) cover the IP?
function banMatches(ban, ip) {
  const n = normalize(ip);
  if (!n || !ban) return false;
  if (ban.kind === 'ip') return ban.value === n;
  if (ban.kind === 'cidr' && net.isIPv4(n)) {
    const [base, bits] = String(ban.value).split('/');
    const size = 2 ** (32 - Number(bits));
    return Math.floor(v4ToInt(n) / size) === Math.floor(v4ToInt(base) / size);
  }
  return false;
}

function createIpTracker({ db, saveDb = () => {}, now = Date.now, isTrusted = () => false } = {}) {
  const nullMap = () => Object.create(null);
  // db.ipHistory and every entry's ips map are prototype-free (the keys are client-derived addresses and account ids).
  function store() {
    if (!isObj(db.ipHistory) || Object.getPrototypeOf(db.ipHistory) !== null) {
      const o = nullMap();
      if (isObj(db.ipHistory)) for (const k of Object.keys(db.ipHistory)) if (!badKey(k)) o[k] = db.ipHistory[k];
      db.ipHistory = o;
    }
    return db.ipHistory;
  }
  function entryOf(id) {
    const e = store()[id];
    if (!e || !isObj(e)) return null;
    if (!isObj(e.ips) || Object.getPrototypeOf(e.ips) !== null) { const o = nullMap(); if (isObj(e.ips)) for (const k of Object.keys(e.ips)) o[k] = e.ips[k]; e.ips = o; }
    return e;
  }
  for (const id of Object.keys(store())) entryOf(id);

  // The address as it may be stored for a player, or null (private / loopback / Docker / the trusted proxies themselves).
  const eligible = (ip) => { const n = normalize(ip); return n && !isPrivate(n) && !isTrusted(n) ? n : null; };

  function record(accountId, ip) {
    const id = String(accountId || '');
    if (!ID_RE.test(id) || badKey(id)) return false;
    const n = eligible(ip);
    if (!n) return false;
    const at = new Date(now()).toISOString();
    const all = store();
    let e = entryOf(id);
    if (!e) e = all[id] = { first: { ip: n, at }, last: { ip: n, at }, ips: nullMap() };
    const r = e.ips[n];
    if (r) { r.last = at; r.count = (Number(r.count) || 0) + 1; } else e.ips[n] = { first: at, last: at, count: 1 };
    e.last = { ip: n, at };
    const keys = Object.keys(e.ips);
    if (keys.length > MAX_IPS_PER_ACCOUNT) {   // evict the least recently seen
      keys.sort((a, b) => String(e.ips[a].last).localeCompare(String(e.ips[b].last)));
      for (const k of keys.slice(0, keys.length - MAX_IPS_PER_ACCOUNT)) delete e.ips[k];
    }
    try { saveDb(); } catch { /* keep serving */ }
    return true;
  }

  const history = (id) => entryOf(String(id));
  const list = (id) => {
    const e = entryOf(String(id));
    if (!e) return [];
    return Object.keys(e.ips).map((ip) => ({ ip, first: e.ips[ip].first, last: e.ips[ip].last, count: e.ips[ip].count })).sort((a, b) => String(b.last).localeCompare(String(a.last)));
  };
  // Accounts seen on one IP (optionally only seen since `sinceMs` ago), most recent first.
  function accountsOn(ip, { sinceMs = 0, exclude = '' } = {}) {
    const n = normalize(ip);
    const out = [];
    if (!n) return out;
    const cutoff = sinceMs ? new Date(now() - sinceMs).toISOString() : '';
    const all = store();
    for (const id of Object.keys(all)) {
      if (id === exclude) continue;
      const e = entryOf(id);
      const r = e && e.ips[n];
      if (r && (!cutoff || String(r.last) >= cutoff)) out.push({ id, first: r.first, last: r.last, count: r.count });
    }
    return out.sort((a, b) => String(b.last).localeCompare(String(a.last)));
  }
  // For one account: its IPs that other accounts were seen on within `sinceMs`. [{ ip, accounts: [{ id, first, last, count }] }].
  function sharedWith(id, { sinceMs = 90 * DAY_MS, maxIps = 20, maxAccounts = 20 } = {}) {
    const out = [];
    for (const row of list(id)) {
      if (out.length >= maxIps) break;
      const others = accountsOn(row.ip, { sinceMs, exclude: String(id) }).slice(0, maxAccounts);
      if (others.length) out.push({ ip: row.ip, accounts: others });
    }
    return out;
  }
  // The last `days` days of an account's IPs, newest first, at most `max`.
  function recent(id, days = 30, max = 10) {
    const cutoff = new Date(now() - days * DAY_MS).toISOString();
    return list(id).filter((r) => String(r.last) >= cutoff).slice(0, max).map((r) => ({ ip: r.ip, last: r.last }));
  }
  // Retention: drop ips last seen before `ageMs` ago, except those in `keep` (a Set of normalized addresses or a
  // predicate); drop accounts left without any ip. Returns the number of ip rows removed.
  function prune(ageMs, keep = () => false) {
    const cutoff = new Date(now() - ageMs).toISOString();
    const keepFn = typeof keep === 'function' ? keep : (ip) => keep.has(ip);
    let removed = 0;
    const all = store();
    for (const id of Object.keys(all)) {
      const e = entryOf(id);
      if (!e) { delete all[id]; continue; }
      for (const ip of Object.keys(e.ips)) {
        if (String(e.ips[ip].last) < cutoff && !keepFn(ip)) { delete e.ips[ip]; removed++; }
      }
      const left = Object.keys(e.ips);
      if (!left.length) { delete all[id]; continue; }
      if (e.first && !e.ips[e.first.ip]) e.first = { ip: left.sort((a, b) => String(e.ips[a].first).localeCompare(String(e.ips[b].first)))[0], at: e.ips[left[0]].first };
      if (e.last && !e.ips[e.last.ip]) { const l = left.sort((a, b) => String(e.ips[b].last).localeCompare(String(e.ips[a].last)))[0]; e.last = { ip: l, at: e.ips[l].last }; }
    }
    if (removed) { try { saveDb(); } catch { /* keep serving */ } }
    return removed;
  }
  return { record, history, list, accountsOn, sharedWith, recent, prune, eligible };
}

module.exports = { normalize, isPrivate, parseBanTarget, banMatches, createIpTracker, DAY_MS, MAX_IPS_PER_ACCOUNT };
