'use strict';
// Steam persona (display name) lookup for accounts. The client's login carries only the Steam id and an auth
// ticket, and the game uses the account's display-name as its in-game name (it joins with ?Name=<display-name>),
// so without this everyone is "player-1234".
//   - OGSOS_STEAM_WEB_API_KEY set: ISteamUser/GetPlayerSummaries (works for private profiles too).
//   - otherwise: the public community profile XML (steamcommunity.com/profiles/<id>/?xml=1), no key needed;
//     a private or missing profile simply keeps the old name.
// Names are cached on the account and refreshed at most once per REFRESH_MS.

const REFRESH_MS = 24 * 3600 * 1000;
const TIMEOUT_MS = 4000;
const inflight = new Map();   // steamId -> Promise<string|null>
// At most this many Steam lookups run at once (OGSOS_PERSONA_MAX_CONCURRENT); further ones are skipped, the login
// proceeds with the id/alias like when Steam is slow, and the account is looked up on a later login.
const MAX_CONCURRENT = Math.max(1, Math.floor(Number(process.env.OGSOS_PERSONA_MAX_CONCURRENT)) || 4);

// Safe for the travel URL (?Name=...) and the scoreboard: no URL option separators, no control chars, max 32.
function cleanPersona(s) {
  const t = String(s ?? '')
    .replace(new RegExp('[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]', 'g'), '')
    .replace(/[?=#&\\"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...t].slice(0, 32).join('');
}

const xmlText = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</${tag}>`));
  if (!m) return null;
  const v = m[1] ?? m[2] ?? '';
  return v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
};

async function fetchPersona(steamId, fetchImpl = globalThis.fetch) {
  if (!/^7656\d{13}$/.test(steamId) || typeof fetchImpl !== 'function') return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const key = process.env.OGSOS_STEAM_WEB_API_KEY;
    if (key) {
      const r = await fetchImpl(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${steamId}`, { signal: ac.signal });
      if (!r.ok) return null;
      const p = (await r.json())?.response?.players?.[0];
      return cleanPersona(p?.personaname) || null;
    }
    const r = await fetchImpl(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, { signal: ac.signal, redirect: 'follow' });
    if (!r.ok) return null;
    const xml = await r.text();
    if (xmlText(xml, 'steamID64') !== steamId) return null;   // error page / wrong profile
    return cleanPersona(xmlText(xml, 'steamID')) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Updates account['display-name'] and alias from Steam when unknown or stale. Resolves true if the name changed.
// waitMs bounds how long the caller waits; the lookup keeps running in the background and is applied later.
function refreshPersona(account, steamId, { save, waitMs = 0, fetchImpl, now = Date.now() } = {}) {
  if (!account || !/^7656\d{13}$/.test(steamId)) return Promise.resolve(false);
  const at = Date.parse(account['persona-checked'] || '') || 0;
  if (now - at < REFRESH_MS) return Promise.resolve(false);
  let p = inflight.get(steamId);
  if (!p && inflight.size >= MAX_CONCURRENT) return Promise.resolve(false);
  if (!p) {
    p = fetchPersona(steamId, fetchImpl).finally(() => inflight.delete(steamId));
    inflight.set(steamId, p);
  }
  const apply = p.then((name) => {
    account['persona-checked'] = new Date().toISOString();
    if (!name || name === account['display-name']) { save?.(); return false; }
    account['display-name'] = name;
    account.alias = name;
    account['persona-source'] = 'steam';
    save?.();
    return true;
  });
  if (!waitMs) return Promise.resolve(false);
  return Promise.race([apply, new Promise((r) => setTimeout(() => r(false), waitMs))]);
}

module.exports = { cleanPersona, fetchPersona, refreshPersona, REFRESH_MS };
