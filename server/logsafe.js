'use strict';
// Log hygiene: no credentials and no unbounded strings reach the log files.
//   redactHeaders(h)  authorization / cookie / x-ogsos-admin / sec-websocket-key keep the scheme and first 6 chars + '...'
//   redactText(s)     JSON bodies get secret-looking keys masked; anything else gets a regex pass; then cut to MAX_TEXT
//   sanitize(entry)   a log entry copy with all of the above applied (headers, body, out, text, path, error, ...)

const MAX_TEXT = 2048;
const SECRET_KEYS = new Set(['session-auth-token', 'sessiontoken', 'token', 'access-token', 'key', 'password', 'secret', 'ticket']);
const MASKED_HEADERS = new Set(['authorization', 'cookie', 'x-ogsos-admin', 'sec-websocket-key']);

function maskValue(v) {
  const s = String(v);
  const m = s.match(/^(\w+)\s+(\S+)$/);   // "Token abc123..." keeps the scheme
  if (m) return `${m[1]} ${m[2].slice(0, 6)}...`;
  return `${s.slice(0, 6)}...`;
}
function redactHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object') return out;
  for (const k of Object.keys(h)) out[k] = MASKED_HEADERS.has(k.toLowerCase()) ? maskValue(Array.isArray(h[k]) ? h[k].join('; ') : h[k]) : h[k];
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
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}...<${s.length} chars>` : t;
}
function sanitize(entry) {
  const out = {};
  for (const k of Object.keys(entry)) {
    const v = entry[k];
    if (k === 'headers') out[k] = redactHeaders(v);
    else if (typeof v === 'string') out[k] = redactText(v);
    else out[k] = v;
  }
  return out;
}

module.exports = { redactHeaders, redactText, sanitize, maskValue, MAX_TEXT };
