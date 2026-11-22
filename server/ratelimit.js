'use strict';
// Small in-memory rate limiter, no dependencies.
//   const hit = limiter('login', 60, 10 * 60 * 1000);
//   if (!hit(ip)) -> over the limit (hit returns true when the request is allowed, false when it is over);
//   hit.retryAfter(ip) -> seconds until that key's window resets.
// Fixed window per key. The key map is capped (MAX_KEYS); when full the oldest key is evicted, so memory stays bounded
// even if an attacker rotates keys. A shared unref'd timer prunes expired windows.

const MAX_KEYS = 50000;
const registry = new Set();

function limiter(name, max, windowMs, maxKeys = MAX_KEYS) {
  const map = new Map();   // key -> { n, reset }
  function hit(key) {
    const k = String(key);
    const t = Date.now();
    let e = map.get(k);
    if (!e || t >= e.reset) {
      if (e) map.delete(k);
      else if (map.size >= maxKeys) map.delete(map.keys().next().value);   // oldest first (insertion order)
      e = { n: 0, reset: t + windowMs };
      map.set(k, e);
    }
    e.n++;
    return e.n <= max;
  }
  hit.retryAfter = (key) => { const e = map.get(String(key)); return e ? Math.max(1, Math.ceil((e.reset - Date.now()) / 1000)) : 1; };
  hit.prune = () => { const t = Date.now(); for (const [k, e] of map) if (t >= e.reset) map.delete(k); };
  hit.size = () => map.size;
  hit.limiterName = name;
  registry.add(hit);
  return hit;
}
setInterval(() => { for (const l of registry) { try { l.prune(); } catch { /* ignore */ } } }, 30000).unref();

// Integer from the environment, or the default when unset or invalid.
function envInt(name, def, env = process.env) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : def;
}

module.exports = { limiter, envInt, MAX_KEYS };
