// Steam persona lookup (server/persona.js) with a fake fetch, no network:  node tools/persona_test.js
'use strict';
const { cleanPersona, refreshPersona, REFRESH_MS } = require('../server/persona');

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '-', e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const ID = '76561190000000777';
const xml = (id, name) => `<?xml version="1.0"?><profile><steamID64>${id}</steamID64><steamID><![CDATA[${name}]]></steamID></profile>`;
const fake = (body, ok = true) => async () => ({ ok, text: async () => body, json: async () => JSON.parse(body) });

(async () => {
  await check('cleanPersona strips URL separators, control chars, caps 32', () => {
    assert(cleanPersona('a?b=c#d&e') === 'abcde', cleanPersona('a?b=c#d&e'));
    assert(cleanPersona(' x\u0000‮y  z ') === 'xy z', JSON.stringify(cleanPersona(' x\u0000‮y  z ')));
    assert([...cleanPersona('é'.repeat(40))].length === 32, 'length');
    assert(cleanPersona('Ünïcødé 名前') === 'Ünïcødé 名前', 'unicode kept');
  });
  await check('community XML name replaces the placeholder', async () => {
    const acc = { 'display-name': 'player-0777', alias: 'player-0777' };
    const changed = await refreshPersona(acc, ID, { waitMs: 1000, fetchImpl: fake(xml(ID, 'Scwunge?=')) });
    assert(changed === true, 'not changed');
    assert(acc['display-name'] === 'Scwunge' && acc.alias === 'Scwunge' && acc['persona-source'] === 'steam', JSON.stringify(acc));
  });
  await check('fresh check is not repeated within REFRESH_MS', async () => {
    let calls = 0;
    const acc = { 'display-name': 'x', 'persona-checked': new Date().toISOString() };
    await refreshPersona(acc, ID, { waitMs: 200, fetchImpl: async () => { calls++; return { ok: false }; } });
    assert(calls === 0, 'fetched again');
    acc['persona-checked'] = new Date(Date.now() - REFRESH_MS - 1000).toISOString();
    await refreshPersona(acc, ID, { waitMs: 200, fetchImpl: async () => { calls++; return { ok: false }; } });
    assert(calls === 1, 'stale not refetched');
  });
  await check('private/missing profile or wrong id keeps the old name', async () => {
    const acc = { 'display-name': 'player-0777', alias: 'player-0777' };
    await refreshPersona(acc, ID, { waitMs: 500, fetchImpl: fake('<response><error>The specified profile could not be found.</error></response>') });
    assert(acc['display-name'] === 'player-0777', 'changed on error page');
    acc['persona-checked'] = '';
    await refreshPersona(acc, ID, { waitMs: 500, fetchImpl: fake(xml('76561190000000001', 'Other')) });
    assert(acc['display-name'] === 'player-0777', 'took another profile');
  });
  await check('non-Steam ids are ignored', async () => {
    let calls = 0;
    await refreshPersona({}, 'abc', { waitMs: 100, fetchImpl: async () => { calls++; } });
    assert(calls === 0, 'fetched for non-steam id');
  });
  await check('Web API path when OGSOS_STEAM_WEB_API_KEY is set', async () => {
    process.env.OGSOS_STEAM_WEB_API_KEY = 'k';
    let url = '';
    const acc = {};
    await refreshPersona(acc, ID, { waitMs: 500, fetchImpl: async (u) => { url = u; return { ok: true, json: async () => ({ response: { players: [{ personaname: 'ApiName' }] } }) }; } });
    delete process.env.OGSOS_STEAM_WEB_API_KEY;
    assert(url.includes('GetPlayerSummaries') && acc['display-name'] === 'ApiName', url + ' ' + JSON.stringify(acc));
  });
  console.log(failed ? `${failed} FAILED` : 'ALL OK');
  process.exit(failed ? 1 : 0);
})();
