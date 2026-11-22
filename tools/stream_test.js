// End-to-end check of the HERO Stream service (/ws/stream) and the embed pages. Node 22+, no dependencies.
//   node tools/stream_test.js [http://127.0.0.1:7783]
// Plays a game host, a spectating client, the performer's own client and a web spectator (feedback page),
// and walks session -> view -> sub -> viewers -> feedback-batch -> vote -> session-end -> session-not-found.
// Shapes are the ones server/stream.js uses (INFERENCE until real game traffic is captured, HERO_TV.md 5).
// Then checks Fame (server/fame.js): the player blob's hero stats and rating, and the fame_solo leaderboard rows.
// Writes nothing but test-* accounts' stream feedback; never posts to any leaderboard.

'use strict';
const BASE = (process.argv[2] || 'http://127.0.0.1:7783').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/ws/stream';
const tag = String(Date.now()).slice(-9);
// Stream ids must be SteamID64s (server/stream.js drops anything else) and anything that writes needs a logged-in socket.
const P1 = `76561190${tag}`, P2 = `76561191${tag}`;
let failed = 0, passed = 0;
const ok = (cond, what, extra) => { if (cond) { passed++; console.log(`  ok   ${what}`); } else { failed++; console.log(`  FAIL ${what}`, extra !== undefined ? JSON.stringify(extra) : ''); } };

function open(name, query = '') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS + query);
    const c = { name, ws, inbox: [], waiters: [] };
    c.send = (obj) => ws.send(JSON.stringify(obj));
    // Wait for the first message matching pred (already received ones count), or fail after ms.
    c.wait = (pred, ms = 4000) => new Promise((res) => {
      const i = c.inbox.findIndex(pred);
      if (i >= 0) return res(c.inbox.splice(i, 1)[0]);
      const w = { pred, res, timer: setTimeout(() => { c.waiters.splice(c.waiters.indexOf(w), 1); res(null); }, ms) };
      c.waiters.push(w);
    });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const w = c.waiters.find((x) => x.pred(m));
      if (w) { clearTimeout(w.timer); c.waiters.splice(c.waiters.indexOf(w), 1); w.res(m); } else c.inbox.push(m);
    };
    ws.onopen = () => resolve(c);
    ws.onerror = (e) => reject(new Error(`${name}: ${e.message || 'ws error'}`));
  });
}
const T = (t) => (m) => m.type === t;
const topic = (t, pred = () => true) => (m) => m.type === 'message' && m.data && m.data.topic === t && pred(m.data.message);

async function http(path, init) {
  const r = await fetch(BASE + path, init);
  return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
}

(async () => {
  console.log(`stream test against ${WS} (players ${P1}, ${P2})`);

  const tokenFor = async (steamId) => JSON.parse((await http('/api/access-token/steam', { method: 'POST', headers: { 'app-id': 'sostest', 'content-type': 'application/json' },
    body: JSON.stringify({ 'steam-app-id': '802240', 'steam-id': steamId, 'session-auth-token': 'x', 'app-id': 'sostest' }) })).text)['access-token'];
  const tHost = await tokenFor(`76561192${tag}`), tSpec = await tokenFor(P2), tWeb = await tokenFor(`76561193${tag}`);
  console.log('connect');
  const host = await open('host', `?token=${encodeURIComponent(tHost)}`);
  ok(await host.wait(T('ready')), 'host gets ready');
  host.send({ type: 'ping' });
  ok(await host.wait(T('pong')), 'ping -> pong');

  console.log('session');
  host.send({ type: 'session', nonce: '1', data: { players: [{ id: P1 }, { id: P2 }] } });
  const sess = await host.wait((m) => m.type === 'session' || m.type === 'ack' || m.type === 'nak');
  const sid = sess && sess.data && sess.data['session-id'];
  ok(sess && sess.type === 'session' && sid, 'session -> session with session-id', sess);
  ok(sess && sess.nonce === '1', 'nonce echoed at top level', sess);
  host.send({ type: 'session', data: { 'session-id': sid, players: [{ id: P1 }, { id: P2 }], nonce: 'n2' } });
  const upd = await host.wait(T('session'));
  ok(upd && upd.data['session-id'] === sid && upd.data.nonce === 'n2', 'session update keeps id, nonce echoed in data', upd);

  console.log('views');
  const perf = await open('performer'); await perf.wait(T('ready'));
  perf.send({ type: 'session-view', data: { 'session-id': sid, players: [P1], 'viewer-id': P1 } });
  const pv = await perf.wait(T('session-view'));
  const pvid = pv && pv.data['view-id'];
  ok(pvid, 'performer session-view -> view-id', pv);
  perf.send({ type: 'sub', data: { 'view-id': pvid, topics: ['viewers', 'feedback-batch'] } });
  ok(await perf.wait(T('ack')), 'sub -> ack');
  ok(await perf.wait(topic('viewers', (x) => x.count === 0)), 'performer sees 0 viewers');

  const spec = await open('spectator', `?token=${encodeURIComponent(tSpec)}`); await spec.wait(T('ready'));
  spec.send({ type: 'session-view', data: { 'session-id': sid, players: [{ id: P1 }], 'viewer-id': P2 } });
  const sv = await spec.wait(T('session-view'));
  const svid = sv && sv.data['view-id'];
  ok(svid && svid !== pvid, 'spectator session-view -> own view-id', sv);
  ok(await perf.wait(topic('viewers', (x) => x.count === 1)), 'performer viewer count -> 1 (in-game spectator)');

  console.log('web spectator + feedback');
  const web = await open('web', `?client=web&role=feedback&target=${encodeURIComponent(P1)}&token=${encodeURIComponent(tWeb)}`); await web.wait(T('ready'));
  web.send({ type: 'sub', data: { target: P1, topics: ['viewers', 'feedback-batch'] } });
  ok(await web.wait(T('ack')), 'web sub -> ack');
  ok(await perf.wait(topic('viewers', (x) => x.count === 2)), 'performer viewer count -> 2 (web spectator)');
  web.send({ type: 'feedback', data: { target: P1, counts: { applause: 3, laughter: 1, bogus: 9 } } });
  const fb = await perf.wait(topic('feedback-batch'), 3000);
  ok(fb && fb.data.message.counts.applause === 3 && fb.data.message.counts.laughter === 1 && !fb.data.message.counts.bogus,
    'performer gets feedback-batch {applause:3, laughter:1}', fb && fb.data);
  ok(fb && fb.data['view-id'] === pvid, 'feedback-batch carries the subscribed view-id', fb && fb.data);
  web.send({ type: 'feedback', data: { target: P1, counts: { anger: 50 } } });
  const capped = await perf.wait(topic('feedback-batch'), 3000);
  ok(capped && capped.data.message.counts.anger === 5, 'feedback rate cap (5/s per sentiment)', capped && capped.data.message);

  console.log('naks');
  spec.send({ type: 'sub', data: { 'view-id': 'no-such-view', topics: ['viewers'] } });
  const n1 = await spec.wait((m) => m.type === 'nak' || m.type === 'ack');
  ok(n1 && n1.type === 'nak' && n1.data.error === 'session-not-found', 'sub unknown view -> nak session-not-found', n1);
  spec.send({ type: 'session-view', nonce: 9, data: { 'session-id': 'no-such-session', players: [P1] } });
  const n2 = await spec.wait((m) => m.type === 'nak' || m.type === 'session-view');
  ok(n2 && n2.type === 'nak' && n2.data.error === 'session-not-found' && n2.nonce === 9, 'session-view unknown session -> nak with nonce', n2);
  spec.send({ type: 'some-future-thing', data: { x: 1 } });
  ok(await spec.wait(T('ack')), 'unknown type -> ack (and logged)');

  console.log('flare vote');
  host.send({ type: 'create-vote', data: {
    'session-id': sid, config: { type: 'single-mutable', 'tally-type': 'total', duration: 3 },
    actors: [{ id: P1, relation: 'origin' }], title: 'Helicopter Supply', description: 'What should the helicopter drop?',
    options: [{ id: '0', label: 'Weapons' }, { id: '1', label: 'Medkits' }, { id: '2', label: 'Flares' }] } });
  const cv = await host.wait(T('vote'));
  const vid = cv && cv.data['vote-id'];
  ok(vid && cv.data.options.length === 3, 'create-vote -> vote with vote-id', cv);
  ok(await spec.wait((m) => m.type === 'vote' && m.data['vote-id'] === vid), 'spectator (has a view) is told about the vote');
  ok(await web.wait((m) => m.type === 'vote' && m.data['vote-id'] === vid), 'web spectator is told about the vote');
  spec.send({ type: 'cast-vote', data: { 'vote-id': vid, 'option-id': '1', 'voter-id': P2 } });
  ok(await spec.wait(T('ack')), 'cast-vote -> ack');
  web.send({ type: 'cast-vote', data: { 'vote-id': vid, 'option-id': '1' } });
  spec.send({ type: 'cast-vote', data: { 'vote-id': vid, 'option-id': '7' } });
  const bad = await spec.wait(T('nak'));
  ok(bad && bad.data.error === 'invalid-option', 'cast-vote bad option -> nak invalid-option', bad);
  host.send({ type: 'vote-status', data: { 'vote-id': vid } });
  const st = await host.wait((m) => m.type === 'vote-status' && !m.data.final);
  ok(st && st.data.total === 2 && st.data.tally['1'] === 2, 'vote-status running: total 2, tally {1:2}', st && st.data);
  const fin = await host.wait((m) => m.type === 'vote-status' && m.data.final, 6000);
  ok(fin && fin.data.winner === '1' && fin.data.total === 2, 'vote ends final with winner "1"', fin && fin.data);
  spec.send({ type: 'cast-vote', data: { 'vote-id': vid, 'option-id': '0' } });
  const late = await spec.wait(T('nak'));
  ok(late && late.data.error === 'vote-closed', 'late cast-vote -> nak vote-closed', late);

  console.log('http');
  const snap = await http('/api/stream/sessions');
  const live = snap.status === 200 && JSON.parse(snap.text).sessions.find((s) => s.id === sid);
  ok(live && live.players.find((p) => p.id === P1).viewers === 2, '/api/stream/sessions lists the session, P1 has 2 viewers', live);
  const pf = await http(`/embed/account/${P1}/performer?token=abc&skip-brand=0`);
  ok(pf.status === 200 && pf.text.includes('SOS LIVE') && pf.text.includes(`"target":"${P1}"`), 'performer embed page');
  const fbp = await http(`/embed/none/${P1}/feedback?viewer=1`);
  ok(fbp.status === 200 && fbp.text.includes('id="meter-4"') && fbp.text.includes('var mouseDownEvent') && fbp.text.includes('var mouseUpEvent'),
    'feedback embed page: meter-0..4 + mouseDownEvent/mouseUpEvent');
  const mp = await http('/embed/_/meter?n=2');
  ok(mp.status === 200 && mp.text.includes('id="button"'), 'meter iframe has #button');
  const tw = await http(`/embed/account/${P1}/connect/twitch?token=abc`);
  ok(tw.status === 200 && tw.text.includes('Twitch'), 'twitch connect placeholder');
  const blank = await http('/embed/something/else');
  ok(blank.status === 200 && !blank.text.includes('<script'), 'other /embed/* still blank');
  const xss = await http('/embed/none/%3Cscript%3E/feedback?viewer=1');
  ok(!xss.text.includes('"<script>"'), 'account id is escaped in page config');
  const site = await http('/');
  ok(site.status === 200 && site.text.includes('Live matches'), 'spectator site at /');

  console.log('session end');
  web.ws.close();
  ok(await perf.wait(topic('viewers', (x) => x.count === 1)), 'web spectator leaves -> count 1');
  spec.send({ type: 'session-delete-view', data: { 'session-id': sid, 'view-id': svid } });
  ok(await spec.wait(T('ack')), 'session-delete-view -> ack');
  ok(await perf.wait(topic('viewers', (x) => x.count === 0)), 'spectator view deleted -> count 0');
  host.send({ type: 'session-end', data: { 'session-id': sid } });
  ok(await host.wait(T('ack')), 'session-end -> ack');
  host.send({ type: 'session', data: { 'session-id': sid, players: [P1] } });
  const gone = await host.wait((m) => m.type === 'nak' || m.type === 'session');
  ok(gone && gone.type === 'nak' && gone.data.error === 'session-not-found', 'session update after end -> nak session-not-found', gone);
  const fame = JSON.parse((await http('/api/stream/fame')).text).fame.find((r) => r.member === P1);
  ok(fame && fame.score > 0, '/api/stream/fame has P1 with fame from feedback', fame);

  console.log('fame in blob + leaderboards');
  // Classic blob GET needs a player JWT (server/progression.js): log in a throwaway Classic account.
  const login = JSON.parse((await http('/api/access-token/steam', { method: 'POST', headers: { 'app-id': 'sostest', 'content-type': 'application/json' },
    body: JSON.stringify({ 'steam-app-id': '802240', 'steam-id': '7656119' + String(Date.now()).slice(-10), 'session-auth-token': 'x', 'app-id': 'sostest' }) })).text);
  const auth = { headers: { 'app-id': 'sostest', authorization: `Token ${login['access-token']}` } };
  const blob = JSON.parse((await http(`/api/account/${P1}/app/sostest`, auth)).text);
  const d = blob && blob.data;
  ok(d && d.stats.hero.totalApplauseFeedbackReceived >= 3 && d.stats.hero.totalLaughterFeedbackReceived >= 1, 'player blob stats.hero has the feedback totals', d && d.stats);
  ok(d && d.stats.social.totalFameWins === 1 && d.ratings.soloRatings.fame.rating > 0 && d.ratings.soloRatings.fame.leaderboardId === 'fame_solo',
    'blob: totalFameWins 1 and a Fame rating (P1 had the most feedback)', d && d.ratings);
  const lb = await http('/api/leaderboard/sostest/fame_solo?start=0&limit=1000');
  const rows = lb.status === 200 ? JSON.parse(lb.text) : [];
  const me = rows.find((x) => x.member === P1);
  ok(Array.isArray(rows) && me && me.score === d.ratings.soloRatings.fame.rating && typeof me.rank === 'number' && me.uname,
    'fame_solo has P1 {member, rank, score = blob rating, uname}', me);
  ok(rows.every((x, i) => x.rank === i + 1 && typeof x.score === 'number'), 'fame_solo ranks are 1..n, scores numeric');
  const ar = JSON.parse((await http(`/api/leaderboard/sostest/fame_solo/${P1}?surrounding=2`)).text);
  ok(Array.isArray(ar) && ar.some((x) => x.member === P1) && ar.length <= 5, '?surrounding=2 around P1', ar.length);
  const siteFame = JSON.parse((await http('/api/stream/fame')).text);
  ok(siteFame.fame.find((x) => x.member === P1)?.score === me?.score, 'site Fame table = game leaderboard (one source)');

  for (const c of [host, perf, spec]) c.ws.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
