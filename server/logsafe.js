'use strict';
// Log hygiene: no credentials and no unbounded strings reach the log files.
//   redactHeaders(h)  authorization / cookie / x-ogsos-admin / sec-websocket-key keep the scheme and first 6 chars + '...'
//   redactText(s)     JSON bodies get secret-looking keys masked; anything else gets a regex pass; then cut to MAX_TEXT
//   redactIps(s)      every IPv4 / IPv6 literal in a string becomes 'ip-redacted' (player addresses are owner-only data,
//                     see docs/SECURITY.md); applied to every logged string, header value and nested value
//   sanitize(entry)   a log entry copy with all of the above applied (headers, body, out, text, path, error, ...)

const net = require('net');
const MAX_TEXT = 2048;
const SECRET_KEYS = new Set(['session-auth-token', 'sessiontoken', 'token', 'access-token', 'key', 'password', 'secret', 'ticket']);
const MASKED_HEADERS = new Set(['authorization', 'cookie', 'x-ogsos-admin', 'sec-websocket-key']);
// Headers that only carry a client address: dropped to a marker whatever they hold.
const IP_HEADERS = new Set(['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded', 'x-client-ip', 'cf-connecting-ip', 'true-client-ip', 'x-cluster-client-ip', 'fastly-client-ip']);
const IP_MARK = 'ip-redacted';
const IPV4_RE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w])/g;
const IPV6_CAND_RE = /(?<![\w:.])[0-9a-fA-F:.]*:[0-9a-fA-F:.]*(?![\w:])/g;   // candidates; net.isIPv6 decides (times like 10:20:30 are not addresses)
function redactIps(s) {
  if (typeof s !== 'string' || s.length < 3) return s;
  let t = s.length > 4096 ? s.slice(0, 4096) : s;   // bounded input: the candidate scan is quadratic in the worst case
  if (t.includes(':')) t = t.replace(IPV6_CAND_RE, (m) => { const c = m.replace(/\.+$/, ''); return net.isIPv6(c) ? IP_MARK + m.slice(c.length) : m; });
  if (t.includes('.')) t = t.replace(IPV4_RE, (m) => (net.isIPv4(m) ? IP_MARK : m));
  return t;
}
function redactDeep(v, depth = 0) {
  if (typeof v === 'string') return redactIps(v);
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) out[k] = redactDeep(v[k], depth + 1);
  return out;
}

function maskValue(v) {
  const s = String(v);
  const m = s.match(/^(\w+)\s+(\S+)$/);   // "Token abc123..." keeps the scheme
  if (m) return `${m[1]} ${m[2].slice(0, 6)}...`;
  return `${s.slice(0, 6)}...`;
}
function redactHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object') return out;
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase();
    if (IP_HEADERS.has(lk)) out[k] = IP_MARK;
    else out[k] = MASKED_HEADERS.has(lk) ? maskValue(Array.isArray(h[k]) ? h[k].join('; ') : h[k]) : redactDeep(h[k]);
  }
  return out;
}
function maskJson(v, depth = 0) {
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => maskJson(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) out[k] = SECRET_KEYS.has(k.toLowerCase()) && v[k] !== null && v[k] !== undefined && v[k] !== '' ? '***' : maskJson(v[k], depth + 1);
  return out;
}
// For text that is not (complete) JSON: mask "key":"value" pairs and ?token= style query values by pattern.
const KEY_ALT = 'session-auth-token|sessionToken|access-token|token|key|password|secret|ticket';
const JSON_PAIR_RE = new RegExp(String.raw`("(?:${KEY_ALT})"\s*:\s*)"(?:[^"\\]|\\.)*"?`, 'gi');
const QUERY_RE = new RegExp(String.raw`([?&](?:${KEY_ALT})=)[^&\s"]*`, 'gi');
const JWT_RE = /eyJ[\w-]{6,}\.[\w-]{2,}\.[\w-]*/g;   // any JWT-shaped string, whatever key it sits under
function redactText(s) {
  if (typeof s !== 'string') return s;
  let t = s;
  if (t.length && (t[0] === '{' || t[0] === '[') && t.length <= 1 << 20) {
    try { t = JSON.stringify(maskJson(JSON.parse(t))); } catch { /* not JSON: pattern pass below */ }
  }
  t = t.replace(JSON_PAIR_RE, '$1"***"').replace(QUERY_RE, '$1***').replace(JWT_RE, 'eyJ...***');
  const cut = t.length > MAX_TEXT;
  const u = redactIps(cut ? t.slice(0, MAX_TEXT + 40) : t);
  return cut || u.length > MAX_TEXT ? `${u.slice(0, MAX_TEXT)}...<${s.length} chars>` : u;
}
function sanitize(entry) {
  const out = {};
  for (const k of Object.keys(entry)) {
    const v = entry[k];
    if (k === 'headers') out[k] = redactHeaders(v);
    else if (typeof v === 'string') out[k] = redactText(v);
    else out[k] = redactDeep(v);
  }
  return out;
}

module.exports = { redactHeaders, redactText, redactIps, sanitize, maskValue, MAX_TEXT };
