'use strict';
// Helpers for ids that become object keys: '__proto__', 'constructor' and 'prototype' must never reach a plain-object
// store, and id-keyed maps are prototype-free (Object.create(null)) so a lookup never finds an inherited member.

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const badKey = (k) => BAD_KEYS.has(String(k));
const STEAM_ID_RE = /^7656\d{13}$/;

// A prototype-free copy of a plain object (shallow). Non-objects pass through.
function nullProto(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  if (Object.getPrototypeOf(o) === null) return o;
  const out = Object.create(null);
  for (const k of Object.keys(o)) if (!badKey(k)) out[k] = o[k];
  return out;
}
// Same, but every value is converted too (maps of maps, e.g. leaderboards -> scores).
function nullProtoDeep(o, depth = 1) {
  const out = nullProto(o);
  if (out && typeof out === 'object' && !Array.isArray(out) && depth > 0) for (const k of Object.keys(out)) out[k] = nullProtoDeep(out[k], depth - 1);
  return out;
}

module.exports = { badKey, nullProto, nullProtoDeep, STEAM_ID_RE };
