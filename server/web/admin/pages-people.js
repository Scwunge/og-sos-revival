'use strict';
/* OG SOS admin panel: people pages (players, matches, reports, bans). */
(function () {
  const A = window.OGA;
  const { h, add, clear, show, fmtTime, ago, timeCell, dur, short, fmtVal, extLink, idLink, mid, matchLink, num, isOwner, refId, refName,
    toast, api, act, okData, listOf, qs, openDialog, kvTable, tableWrap, statusBadge, statePill, stopRefresh } = A;

  const serverName = (s) => (s && typeof s === 'object' ? s.name || '' : (s || ''));
  const confirmP = (msg) => confirm(msg);

  // ---------- Player IP addresses (owner only: the API sends no IP fields to mods, so these never render for them) ----------
  function ipBanDialog(ip, done) {
    const reason = h('input', { type: 'text', maxlength: '200', placeholder: 'Reason (required)' });
    const dur_ = A.durationField();
    const go = h('button', { class: 'danger' }, 'Ban IP');
    const { close } = openDialog('Ban IP address', [
      h('p', {}, 'Players on this address cannot log in, open matchmaking or stream sockets, join lobbies from the server list, or file reports. It can catch other players behind the same router.'),
      h('div', { class: 'field' }, h('label', {}, 'Address'), h('input', { type: 'text', value: ip, readonly: true })),
      h('div', { class: 'field' }, h('label', {}, 'Reason'), reason),
      dur_.node,
    ], [h('button', { onclick: () => close() }, 'Cancel'), go], { narrow: true });
    go.addEventListener('click', async () => {
      const r = reason.value.trim();
      if (!r) { toast('A reason is required'); return; }
      let hours;
      try { hours = dur_.hours(); } catch (e) { toast(e.message); return; }
      go.disabled = true;
      const ok = await act(() => api('ip-bans', { ip, reason: r, hours }), 'IP banned');
      go.disabled = false;
      if (ok) { close(); if (done) done(); }
    });
    reason.focus();
  }
  // Who was seen on an address, with links, and a ban button.
  async function ipDialog(ip) {
    const d = okData(await act(() => api('ip/' + encodeURIComponent(ip))));
    if (!d) return;
    const accs = d.accounts || [];
    const ban = h('button', { class: 'danger', onclick: () => ipBanDialog(ip) }, 'Ban IP');
    openDialog('Address ' + ip, [
      d.banned ? h('div', { class: 'banner bad' }, h('b', {}, 'IP BANNED'), ' ', d.ban && d.ban.reason ? d.ban.reason : '') : null,
      tableWrap(['Account', 'Steam id', 'First seen', 'Last seen', 'Count'], accs.map((a) => h('tr', {},
        h('td', {}, idLink(a.id, a.name || a.id)), h('td', {}, mid(a.id)), timeCell(a.first), timeCell(a.last), h('td', { class: 'num', text: String(a.count == null ? '' : a.count) }))), 'No accounts seen on this address'),
    ], d.banned ? [] : [ban], {});
  }
  // An address with a lookup link and an IP ban button next to it.
  const ipCell = (ip) => h('span', {}, h('a', { href: '#', class: 'mono', title: 'Accounts seen on this address', onclick: (e) => { e.preventDefault(); ipDialog(ip); } }, ip), ' ',
    h('button', { class: 'sm danger', onclick: () => ipBanDialog(ip) }, 'Ban IP'));
  const sharedTable = (shared) => tableWrap(['Address', 'Other accounts seen on it (last 90 days)'], (shared || []).map((x) => h('tr', {},
    h('td', {}, ipCell(x.ip)), h('td', {}, (x.accounts || []).map((a) => [idLink(a.id, a.name || a.id), ' '])))), 'No other accounts share an address');

  // ---------- Players list ----------
  A.pages.players = async function () {
    const seq = A.seq();
    stopRefresh();
    const out = h('div', {});
    const input = h('input', { type: 'text', class: 'search', placeholder: 'Search name or Steam id (empty = most recent)' });
    const run = async () => {
      const r = okData(await act(() => api('players' + qs({ limit: 50, q: input.value.trim() }))));
      if (seq !== A.cur() || !r) return;
      clear(out);
      out.appendChild(tableWrap(['Name', 'Steam id', 'Last access', 'Created', 'Status', 'Reports vs', 'Reports by', 'Matches'],
        listOf(r, 'players').map((p) => h('tr', {},
          h('td', {}, idLink(p.id, p.name || p.id)), h('td', {}, mid(p.id)), timeCell(p.lastAccess), timeCell(p.created),
          h('td', {}, p.banned ? h('span', { class: 'badge bad' }, 'banned') : ''),
          h('td', { class: 'num', text: String(p.reportsAgainst ?? 0) }), h('td', { class: 'num', text: String(p.reportsBy ?? 0) }), h('td', { class: 'num', text: String(p.matches ?? 0) }))),
        'No players found'));
    };
    const form = h('form', { class: 'row' }, input, h('button', { class: 'primary', type: 'submit' }, 'Search'));
    form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
    show(h('h1', {}, 'Players'), form, out);
    input.focus();
    run();
  };

  // ---------- Player dialogs ----------
  function textDialog(title, label, max, btn, onGo, rows) {
    const ta = h('textarea', { maxlength: String(max), rows: String(rows || 3) });
    const go = h('button', { class: 'primary' }, btn);
    const { close } = openDialog(title, [h('div', { class: 'field' }, h('label', {}, label + ' (max ' + max + ' characters)'), ta)], [h('button', { onclick: () => close() }, 'Cancel'), go], { narrow: true });
    go.addEventListener('click', async () => {
      const t = ta.value.trim();
      if (!t) { toast('Text is required'); return; }
      go.disabled = true;
      const ok = await onGo(t);
      go.disabled = false;
      if (ok) close();
    });
    ta.focus();
  }

  function adjustDialog(id, name, profile, done) {
    const p = profile || {};
    const inputs = []; // {path:[..], el, orig}
    const field = (label, path, orig, step) => {
      const el = h('input', { type: 'number', step: step || 'any' });
      if (typeof orig === 'number') el.value = String(orig);
      inputs.push({ path, el, orig });
      return h('div', { class: 'field' }, h('label', {}, label), el);
    };
    const ratingFields = Object.keys(p.ratings || {}).filter((k) => typeof p.ratings[k] === 'number').map((k) => field('ratings.' + k, ['ratings', k], p.ratings[k]));
    const fameFields = p.fame && typeof p.fame === 'object' ? ['soloFameRating', 'totalFameWins', 'fameMatches'].filter((k) => typeof p.fame[k] === 'number').map((k) => field('fame.' + k, ['fame', k], p.fame[k])) : [];
    const go = h('button', { class: 'primary' }, 'Apply');
    const { close } = openDialog('Adjust ' + (name || id), [
      h('p', { class: 'muted', text: 'Only changed fields are sent. Not possible while the player is seated in a lobby.' }),
      h('div', { class: 'cols' },
        h('div', {}, field('Level', ['level'], p.level, '1'), field('Level progress (as shown on the profile)', ['levelProgress'], p.levelProgress)),
        h('div', {}, ratingFields.length ? h('h3', {}, 'Ratings') : null, ratingFields)),
      fameFields.length ? [h('h3', {}, 'Fame'), h('div', { class: 'cols' }, fameFields)] : null,
    ], [h('button', { onclick: () => close() }, 'Cancel'), go]);
    go.addEventListener('click', async () => {
      const body = {};
      for (const f of inputs) {
        if (f.el.value.trim() === '') continue;
        const v = Number(f.el.value);
        if (!isFinite(v)) { toast('Not a number: ' + f.path.join('.')); return; }
        if (v === f.orig) continue;
        if (f.path.length === 1) body[f.path[0]] = v;
        else { body[f.path[0]] = body[f.path[0]] || {}; body[f.path[0]][f.path[1]] = v; }
      }
      if (!Object.keys(body).length) { toast('Nothing changed'); return; }
      go.disabled = true;
      const ok = await act(() => api('players/' + encodeURIComponent(id) + '/adjust', body), 'Stats adjusted');
      go.disabled = false;
      if (ok) { close(); done(); }
    });
  }

  function levelBar(prof) {
    const lp = prof.levelProgress;
    if (typeof lp !== 'number') return null;
    const pct = Math.max(0, Math.min(100, lp <= 1 ? lp * 100 : lp));
    const bar = h('progress', { max: '100', value: String(Math.round(pct)) });
    return h('div', { class: 'lvl' }, bar, h('span', { class: 'muted', text: ' ' + Math.round(pct) + '%' + (typeof prof.xpIntoLevel === 'number' ? ' (' + prof.xpIntoLevel + ' xp into level)' : '') }));
  }

  // ---------- Player detail ----------
  A.pages.player = async function (id) {
    if (!id) return A.pages.players();
    const seq = A.seq();
    stopRefresh();
    const d = okData(await act(() => api('players/' + encodeURIComponent(id))));
    if (seq !== A.cur()) return;
    if (!d) { show(h('h1', {}, 'Player'), h('p', { class: 'muted' }, 'Could not load player ', mid(id))); return; }
    const acc = d.account || { id };
    const name = acc.name || id;
    const prof = d.profile || {};
    const reload = () => { if (seq === A.cur()) A.pages.player(id); };
    const unban = async () => { if (confirmP('Lift ban on ' + name + '?') && await act(() => api('bans/' + encodeURIComponent(id) + '/lift', {}), 'Ban lifted')) reload(); };
    const cur = d.current;

    const banInfo = d.ban
      ? h('div', { class: 'banner bad' }, h('b', {}, 'BANNED'), ' ', d.ban.reason, ' ',
        h('span', { class: 'muted', text: d.ban.expiresAt ? '(until ' + fmtTime(d.ban.expiresAt) + ')' : '(permanent)' }), ' ',
        h('button', { class: 'sm', onclick: unban }, 'Unban'))
      : null;
    const curInfo = cur
      ? h('p', {}, 'In session ', mid(cur.sessionId), ' (', cur.game, ', ', cur.state || '?', ') ',
        h('button', { class: 'sm danger', onclick: () => A.kickDialog(cur.sessionId, id, name, cur.game, reload) }, 'Kick'), ' ',
        h('button', { class: 'sm', onclick: () => A.spectate(cur.sessionId, cur.game) }, 'Spectate'))
      : h('p', { class: 'muted' }, 'Not in a live session');

    const actions = h('div', { class: 'row' },
      h('button', { class: 'danger', onclick: () => A.banDialog(id, name, reload) }, 'Ban'),
      d.ban ? h('button', { onclick: unban }, 'Unban') : null,
      h('button', { onclick: () => textDialog('Warn ' + name, 'Warning shown to staff / sent to the player', 200, 'Send warning', async (t) => { const ok = await act(() => api('players/' + encodeURIComponent(id) + '/warn', { reason: t }), 'Warning recorded'); if (ok) reload(); return ok; }) }, 'Warn'),
      h('button', { onclick: () => adjustDialog(id, name, prof, reload) }, 'Adjust stats'),
      h('button', { class: 'danger', onclick: () => A.typedConfirm('Reset stats: ' + name, 'This clears level, ratings, badges and match totals. It cannot be undone.', 'RESET',
        async () => { const ok = await act(() => api('players/' + encodeURIComponent(id) + '/reset-stats', {}), 'Stats reset'); if (ok) reload(); return ok; }) }, 'Reset stats'));

    // Matches
    const m0 = d.matches || [];
    const mcols = [];
    for (const m of m0) for (const k of Object.keys(m.me || {})) if (typeof m.me[k] === 'number' && !mcols.includes(k)) mcols.push(k);
    const matches = tableWrap(['Ended', 'Server', 'Duration', ...mcols, 'Players', 'Match'],
      m0.map((m) => h('tr', {},
        timeCell(m.endedAt), h('td', { text: serverName(m.server) }), h('td', { class: 'nowrap', text: dur(m.durationSec) }),
        mcols.map((k) => h('td', { class: 'num', text: m.me && m.me[k] !== undefined ? String(m.me[k]) : '' })),
        h('td', { class: 'num', text: String(Array.isArray(m.players) ? m.players.length : (m.players ?? '')) }), h('td', {}, matchLink(m.matchId || m.id)))),
      'No matches');

    // History
    const bh = d.banHistory || [], kicks = d.kicks || [], warns = d.warnings || [];
    const histRows = [];
    for (const b of bh) histRows.push({ at: b.at, kind: 'ban', by: b.by, byName: b.byName, text: b.reason + ' (' + (b.expiresAt ? 'until ' + fmtTime(b.expiresAt) : 'permanent') + ')' + (b.lifted ? ', lifted ' + fmtTime(b.lifted.at) : '') });
    for (const k of kicks) histRows.push({ at: k.at, kind: 'kick', by: k.by, byName: k.byName, text: k.detail || '' });
    for (const w of warns) histRows.push({ at: w.at, kind: 'warning', by: w.by, byName: w.byName, text: w.reason });
    histRows.sort((a, b) => new Date(b.at) - new Date(a.at));
    const history = tableWrap(['When', 'Kind', 'By', 'Detail'], histRows.map((x) => h('tr', {},
      timeCell(x.at), h('td', {}, h('span', { class: 'badge ' + (x.kind === 'ban' ? 'bad' : (x.kind === 'warning' ? 'warn' : '')), text: x.kind })),
      h('td', {}, x.byName || '', ' ', mid(x.by)), h('td', { class: 'excerpt', text: x.text }))), 'No bans, kicks or warnings');

    // Notes
    const noteBox = h('textarea', { maxlength: '1000', placeholder: 'Add an internal note (visible to admins only)' });
    const addNote = h('button', { class: 'primary' }, 'Add note');
    addNote.addEventListener('click', async () => {
      const t = noteBox.value.trim();
      if (!t) { toast('Note is empty'); return; }
      addNote.disabled = true;
      const ok = await act(() => api('players/' + encodeURIComponent(id) + '/notes', { text: t }), 'Note added');
      addNote.disabled = false;
      if (ok) reload();
    });
    const notes = (d.notes || []).slice().sort((a, b) => new Date(b.at) - new Date(a.at));
    const noteList = notes.length ? h('ul', { class: 'thread' }, notes.map((n) => h('li', {},
      h('div', { class: 'muted' }, n.byName || n.by || '', ' ', h('span', { title: fmtTime(n.at), text: ago(n.at) })), h('div', { class: 'note', text: n.text }))))
      : h('p', { class: 'muted' }, 'No notes yet');

    const ratings = prof.ratings || {};
    show(
      h('div', { class: 'row' }, h('h1', { class: 'grow', text: name }), h('span', { class: 'mono muted', text: id })),
      banInfo, actions,
      h('div', { class: 'cols' },
        h('div', { class: 'card' }, h('h3', {}, 'Account'),
          kvTable({ id: acc.id, name: acc.name, created: fmtTime(acc.created), lastAccess: fmtTime(acc.lastAccess) }),
          h('p', {}, h('a', { href: 'https://steamcommunity.com/profiles/' + encodeURIComponent(acc.id || id), rel: 'noopener noreferrer nofollow', target: '_blank' }, 'Steam profile')),
          curInfo),
        h('div', { class: 'card' }, h('h3', {}, 'Profile'),
          prof.level !== undefined && prof.level !== null ? h('p', {}, 'Level ', h('b', { class: 'big', text: String(prof.level) })) : h('p', { class: 'muted' }, 'No game save yet (saved after their first match)'),
          levelBar(prof),
          Object.keys(ratings).length ? [h('h3', { class: 'mt' }, 'Ratings'), kvTable(ratings)] : null,
          prof.fame ? [h('h3', { class: 'mt' }, 'Fame'), kvTable(prof.fame)] : null),
        h('div', { class: 'card' }, h('h3', {}, 'Stats summary'), kvTable(d.stats || {}))),
      d.ips ? h('div', { class: 'cols mt' },
        h('div', { class: 'card' }, h('h3', {}, 'IP addresses'),
          d.ips.first ? h('p', { class: 'muted' }, 'First seen on ', h('span', { class: 'mono', text: d.ips.first.ip }), ' ', ago(d.ips.first.at)) : null,
          tableWrap(['Address', 'First seen', 'Last seen', 'Count'], (d.ips.list || []).map((r) => h('tr', {},
            h('td', {}, ipCell(r.ip)), timeCell(r.first), timeCell(r.last), h('td', { class: 'num', text: String(r.count == null ? '' : r.count) }))), 'No addresses recorded yet')),
        h('div', { class: 'card' }, h('h3', {}, 'Accounts sharing an IP'), sharedTable(d.sharedIp))) : null,
      h('h2', { class: 'mt' }, 'Match history'), matches,
      h('div', { class: 'cols mt' },
        h('div', {}, h('h2', {}, 'Reports against'), reportsTable(d.reportsAgainst || [], 'against')),
        h('div', {}, h('h2', {}, 'Reports filed'), reportsTable(d.reportsBy || [], 'by'))),
      h('h2', { class: 'mt' }, 'Bans, kicks and warnings'), history,
      h('h2', { class: 'mt' }, 'Notes'),
      h('div', { class: 'card' }, h('div', { class: 'field' }, noteBox), h('div', { class: 'row' }, addNote)),
      noteList,
      h('p', { class: 'muted', text: 'Warnings are recorded for staff. The game has a Violation Warning dialog, but how to deliver one in-game is not known yet.' }));
  };

  function reportsTable(list, mode) {
    return tableWrap(['Time', 'Status', mode === 'by' ? 'Target' : 'Reporter', 'Reason', ''],
      list.map((r) => h('tr', {},
        timeCell(r.at), h('td', {}, statusBadge(r.status)),
        h('td', {}, mode === 'by' ? idLink(r.target && r.target.id, r.target && r.target.name) : idLink(r.reporter && r.reporter.id, r.reporter && r.reporter.name)),
        h('td', { text: r.reason }), h('td', {}, h('a', { href: '#/report/' + encodeURIComponent(r.id) }, 'open')))),
      'None');
  }

  // ---------- Matches ----------
  A.pages.matches = async function (arg, query) {
    const seq = A.seq();
    stopRefresh();
    query = query || {};
    const player = h('input', { type: 'text', placeholder: 'player Steam id', value: query.player || '' });
    const session = h('input', { type: 'text', placeholder: 'session id', value: query.session || '' });
    const out = h('div', {});
    const form = h('form', { class: 'row' }, h('div', { class: 'field' }, player), h('div', { class: 'field' }, session),
      h('button', { class: 'primary', type: 'submit' }, 'Filter'),
      h('button', { type: 'button', onclick: () => { location.hash = '#/matches'; } }, 'Clear'));
    form.addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/matches' + qs({ player: player.value.trim(), session: session.value.trim() }); });
    let rows = [], last = null;
    const render = (more) => {
      clear(out);
      out.appendChild(tableWrap(['Ended', 'Server', 'Duration', 'Players', 'Top killer', 'Match'],
        rows.map((m) => h('tr', {},
          timeCell(m.endedAt), h('td', { text: serverName(m.server) || m.sessionId || '' }), h('td', { class: 'nowrap', text: dur(m.durationSec) }),
          h('td', { class: 'num', text: String(m.players ?? '') }),
          h('td', {}, m.top ? [idLink(m.top.id || m.top.playerId || '', m.top.name || ''), ' ', h('span', { class: 'muted', text: m.top.kills != null ? '(' + m.top.kills + ' kills)' : '' })] : ''),
          h('td', {}, matchLink(m.id)))), 'No matches found'));
      if (more) out.appendChild(h('div', { class: 'row mt' }, h('button', { onclick: () => load(true) }, 'Older')));
    };
    const load = async (older) => {
      const q = { limit: 50, player: query.player, session: query.session };
      if (older && last) q.before = last;
      const r = okData(await act(() => api('matches' + qs(q))));
      if (seq !== A.cur() || !r) return;
      const list = listOf(r, 'matches');
      rows = older ? rows.concat(list) : list;
      last = rows.length ? rows[rows.length - 1].endedAt : null;
      render(list.length >= 50);
    };
    show(h('h1', {}, 'Matches'), form, out);
    load(false);
  };

  A.pages.match = async function (id) {
    if (!id) return A.pages.matches('', {});
    const seq = A.seq();
    stopRefresh();
    const m = okData(await act(() => api('matches/' + encodeURIComponent(id))));
    if (seq !== A.cur()) return;
    if (!m) { show(h('h1', {}, 'Match'), h('p', { class: 'muted' }, 'Could not load match ', mid(id))); return; }
    const srv = m.server && typeof m.server === 'object' ? m.server : { name: m.server };
    const meta = {};
    for (const k of Object.keys(m)) if (!['players', 'server', 'reports'].includes(k)) meta[k] = m[k];
    if (m.startedAt) meta.startedAt = fmtTime(m.startedAt);
    if (m.endedAt) meta.endedAt = fmtTime(m.endedAt);
    if (typeof m.durationSec === 'number') meta.durationSec = dur(m.durationSec) + ' (' + m.durationSec + ' s)';
    const reps = m.reports || [];
    show(
      h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Match ', h('span', { class: 'mono', text: id })), h('a', { href: '#/matches' }, '← all matches')),
      h('div', { class: 'cols' },
        h('div', { class: 'card' }, h('h3', {}, 'Match'), kvTable(meta)),
        h('div', { class: 'card' }, h('h3', {}, 'Server'),
          srv.name || srv.game ? kvTable({ name: srv.name, game: srv.game, community: srv.community }) : h('p', { class: 'muted' }, 'Unknown server'),
          m.sessionId ? h('p', {}, h('a', { href: '#/matches' + qs({ session: m.sessionId }) }, 'Other matches on this session')) : null)),
      h('h2', { class: 'mt' }, 'Players'),
      A.playersTable(m.players || [], {}),
      h('h2', { class: 'mt' }, 'Linked reports'),
      reportsTable(reps, 'against'));
  };

  // ---------- Reports ----------
  const REPORT_TABS = ['open', 'investigating', 'resolved', 'dismissed', 'all', 'mine'];
  const REPORT_STATUS = ['open', 'investigating', 'resolved', 'dismissed'];

  A.pages.reports = async function (tab) {
    const seq = A.seq();
    stopRefresh();
    tab = REPORT_TABS.includes(tab) ? tab : 'open';
    const me = (A.me || {}).steamId;
    const q = tab === 'mine' ? { assignee: me } : (tab === 'all' ? {} : { status: tab });
    const r = okData(await act(() => api('reports' + qs(q))));
    if (seq !== A.cur()) return;
    const list = listOf(r, 'reports');
    const tabs = h('div', { class: 'tabs' }, REPORT_TABS.map((t) => h('a', { href: '#/reports/' + t, class: t === tab ? 'on' : '' }, t === 'mine' ? 'assigned to me' : t)));
    const rows = list.map((x) => h('tr', {},
      timeCell(x.at), h('td', {}, statusBadge(x.status)),
      h('td', {}, idLink(x.reporter && x.reporter.id, x.reporter && x.reporter.name)),
      h('td', {}, idLink(x.target && x.target.id, x.target && x.target.name)),
      h('td', { text: x.reason }), h('td', { class: 'excerpt', text: short(x.text, 140) }),
      h('td', { text: refName(x.assignee) || (refId(x.assignee) ? short(refId(x.assignee), 10) : '') }),
      h('td', {}, extLink(x.evidenceUrl, 'clip') || h('span', { class: 'muted' }, '-')),
      h('td', {}, matchLink(x.matchId)),
      h('td', {}, h('a', { href: '#/report/' + encodeURIComponent(x.id) }, 'view'))));
    show(h('h1', {}, 'Reports'), tabs,
      tableWrap(['Time', 'Status', 'Reporter', 'Target', 'Reason', 'Text', 'Assignee', 'Evidence', 'Match', ''], rows, 'No ' + (tab === 'all' ? '' : (tab === 'mine' ? 'assigned ' : tab + ' ')) + 'reports'));
  };

  A.pages.report = async function (id) {
    if (!id) return A.pages.reports('open');
    const seq = A.seq();
    stopRefresh();
    const [d, adm] = await Promise.all([okData(await act(() => api('reports/' + encodeURIComponent(id)))), api('admins').catch(() => null)]);
    if (seq !== A.cur()) return;
    if (!d) { show(h('h1', {}, 'Report'), h('p', { class: 'muted' }, 'Could not load report ', mid(id))); return; }
    const r = d.report || {};
    const links = d.links || {};
    const reload = () => { if (seq === A.cur()) A.pages.report(id); };
    const tId = links.target || (r.target && r.target.id), rId = links.reporter || (r.reporter && r.reporter.id);
    const matchId = links.match || r.matchId;
    const hl = { reporter: rId, target: tId };
    const snap = r.snapshot || {};
    const sess = snap.session || null;
    const sp = links.spectate || {};
    const sessId = sp.sessionId || r.sessionId || (sess && sess.id) || null;
    const game = sess && sess.game;
    const post = (body, msg) => act(() => api('reports/' + encodeURIComponent(id), body), msg);

    const statusSel = h('select', {}, REPORT_STATUS.map((s) => h('option', { value: s, text: s })));
    statusSel.value = REPORT_STATUS.includes(r.status) ? r.status : 'open';
    statusSel.addEventListener('change', async () => { if (await post({ status: statusSel.value }, 'Status: ' + statusSel.value)) reload(); });

    const people = adm ? (adm.owners || []).concat(adm.mods || []) : [];
    const assSel = h('select', {}, h('option', { value: '' }, 'unassigned'), people.map((p) => h('option', { value: p.steamId, text: (p.name || p.steamId) + (p.steamId === (A.me || {}).steamId ? ' (me)' : '') })));
    assSel.value = refId(r.assignee) || '';
    assSel.addEventListener('change', async () => { if (await post({ assignee: assSel.value || null }, 'Assignee updated')) reload(); });

    const noteBox = h('textarea', { maxlength: '1000', placeholder: 'Add a note to this report' });
    const addNote = h('button', { class: 'primary' }, 'Add note');
    addNote.addEventListener('click', async () => {
      if (!noteBox.value.trim()) { toast('Note is empty'); return; }
      addNote.disabled = true;
      const ok = await post({ note: noteBox.value.trim() }, 'Note added');
      addNote.disabled = false;
      if (ok) reload();
    });
    // notes: new list; fall back to the legacy single note string.
    const notes = Array.isArray(r.notes) ? r.notes : (r.note ? [{ at: r.resolvedAt, text: r.note, byName: '' }] : []);
    const thread = notes.length ? h('ul', { class: 'thread' }, notes.map((n) => h('li', {},
      h('div', { class: 'muted' }, n.byName || n.by || '', ' ', n.at ? h('span', { title: fmtTime(n.at), text: ago(n.at) }) : null), h('div', { class: 'note', text: n.text })))) : h('p', { class: 'muted' }, 'No notes yet');

    const body = [];
    body.push(h('div', { class: 'row' },
      h('h1', { class: 'grow' }, 'Report ', h('span', { class: 'mono', text: r.id }), ' ', statusBadge(r.status || '?')),
      h('a', { href: '#/reports' }, '← all reports')));
    if (!r.evidenceUrl) body.push(h('div', { class: 'banner' }, 'No video: record with Steam/OBS clips; reporters can attach a clip link'));
    body.push(h('div', { class: 'cols' },
      h('div', { class: 'card' }, h('h3', {}, 'Report'),
        kvTable({ time: fmtTime(r.at) + ' (' + ago(r.at) + ')', source: r.source, reason: r.reason, sessionId: r.sessionId, resolvedBy: r.resolvedBy, resolvedAt: r.resolvedAt ? fmtTime(r.resolvedAt) : null }),
        h('p', {}, 'Match: ', matchId ? matchLink(matchId) : h('span', { class: 'muted' }, 'not linked')),
        h('p', {}, 'Reporter: ', idLink(rId, r.reporter && r.reporter.name), ' ', mid(rId)),
        h('p', {}, 'Target: ', idLink(tId, r.target && r.target.name), ' ', mid(tId),
          d.priorReportsAgainstTarget ? h('span', { class: 'badge warn', text: d.priorReportsAgainstTarget + ' prior reports' }) : null,
          d.ban ? h('span', { class: 'badge bad' }, 'banned') : null),
        r.evidenceUrl ? h('p', {}, 'Evidence: ', extLink(r.evidenceUrl, short(r.evidenceUrl, 60)) || h('span', { class: 'mono', text: r.evidenceUrl })) : null,
        h('h3', {}, 'Text'), h('div', { class: 'note', text: r.text || '(none)' })),
      h('div', { class: 'card' }, h('h3', {}, 'Workflow'),
        h('div', { class: 'field' }, h('label', {}, 'Status'), statusSel),
        h('div', { class: 'field' }, h('label', {}, 'Assignee'), assSel,
          h('button', { class: 'sm mt', onclick: async () => { if (await post({ assignee: 'me' }, 'Assigned to you')) reload(); } }, 'Assign to me')),
        h('div', { class: 'row' },
          tId ? h('button', { class: 'danger', onclick: () => A.banDialog(tId, r.target && r.target.name, reload) }, 'Ban target') : null,
          tId && sessId ? h('button', { class: 'danger', title: 'Only works if the target is still seated in this session', onclick: () => A.kickDialog(sessId, tId, r.target && r.target.name, game, reload) }, 'Kick target') : null,
          sessId && (sp.live !== false) ? h('button', { onclick: () => A.spectate(sessId, game) }, sp.live ? 'Spectate (live)' : 'Spectate session') : null,
          tId ? h('a', { class: 'btn', href: '#/player/' + encodeURIComponent(tId) }, 'Target page') : null))));
    body.push(h('h2', {}, 'Notes'), h('div', { class: 'card' }, h('div', { class: 'field' }, noteBox), h('div', { class: 'row' }, addNote)), thread);
    if (d.match || matchId) body.push(h('h2', {}, 'Linked match ', matchLink(matchId)), d.match ? A.playersTable(d.match.players || [], hl) : h('p', { class: 'muted' }, 'Match record not found'));
    const cands = d.candidates || [];
    body.push(h('h2', {}, 'Candidate matches'),
      tableWrap(['Match', 'Ended', 'Duration', 'Players', ''],
        cands.map((m) => h('tr', {}, h('td', {}, matchLink(m.id)), timeCell(m.endedAt), h('td', { text: dur(m.durationSec) }),
          h('td', { class: 'num', text: String((m.players || []).length) }),
          h('td', {}, h('button', { class: 'sm', onclick: async () => { if (await post({ matchId: m.id }, 'Match linked')) reload(); } }, 'Link this match')))),
        'No candidate matches'));
    body.push(h('h2', {}, 'Snapshot at report time'),
      h('div', { class: 'cols' },
        h('div', { class: 'card' }, h('h3', {}, 'Reporter ', r.reporter && r.reporter.name || ''), snap.reporter ? kvTable(snap.reporter) : h('p', { class: 'muted' }, 'No snapshot'),
          d.reporter ? [h('h3', {}, 'Reporter now'), kvTable(d.reporter)] : null),
        h('div', { class: 'card' }, h('h3', {}, 'Target ', r.target && r.target.name || ''), snap.target ? kvTable(snap.target) : h('p', { class: 'muted' }, 'No snapshot'),
          d.target ? [h('h3', {}, 'Target now'), kvTable(d.target)] : null)));
    if (sess) body.push(h('div', { class: 'card' }, h('h3', {}, 'Session at report time'), kvTable(sess)));
    if (r.ips) {   // owner only (the API leaves it out for mods)
      const t = r.ips.target || {}, rp_ = r.ips.reporter || {};
      body.push(h('h2', {}, 'IP addresses at report time'), h('div', { class: 'cols' },
        h('div', { class: 'card' }, h('h3', {}, 'Target ', r.target && r.target.name || ''),
          t.last ? h('p', {}, 'Last: ', ipCell(t.last)) : h('p', { class: 'muted' }, 'No address recorded'),
          (t.recent || []).length ? tableWrap(['Recent address', 'Last seen'], t.recent.map((x) => h('tr', {}, h('td', {}, ipCell(x.ip)), timeCell(x.last))), '') : null),
        h('div', { class: 'card' }, h('h3', {}, 'Reporter ', r.reporter && r.reporter.name || ''),
          rp_.last ? h('p', {}, 'Last: ', ipCell(rp_.last)) : h('p', { class: 'muted' }, 'No address recorded')),
        h('div', { class: 'card' }, h('h3', {}, 'Accounts sharing the target addresses'), sharedTable(d.sharedIp))));
    }
    if (snap.lastMatch) body.push(h('h2', {}, 'Target\'s last match at report time'), A.playersTable(snap.lastMatch.players || [], hl));
    show(h('div', { class: 'stack' }, body));
  };

  // ---------- Bans ----------
  A.pages.bans = async function (arg) {
    const showAll = arg === 'all';
    const seq = A.seq();
    stopRefresh();
    const r = okData(await act(() => api('bans' + (showAll ? '?all=1' : ''))));
    if (seq !== A.cur()) return;
    const ipr = isOwner() ? okData(await act(() => api('ip-bans' + (showAll ? '?all=1' : '')))) : null;
    if (seq !== A.cur()) return;
    const bans = !r ? [] : (Array.isArray(r.bans) ? r.bans : Object.values(r.bans || {}));
    const blocks = !r ? [] : (r.hostBlocks || []);
    const reload = () => { if (seq === A.cur()) A.pages.bans(arg); };
    const lift = (b) => async () => { if (confirmP('Lift ban on ' + (b.name || b.steamId) + '?') && await act(() => api('bans/' + encodeURIComponent(b.steamId) + '/lift', {}), 'Ban lifted')) reload(); };
    const now = Date.now();
    const banRows = bans.map((b) => {
      const active = !b.lifted && (!b.expiresAt || new Date(b.expiresAt).getTime() > now);
      return h('tr', {}, h('td', {}, idLink(b.steamId, b.name || b.steamId)), h('td', {}, mid(b.steamId)), h('td', { text: b.reason }),
        h('td', {}, mid(b.by)), timeCell(b.at), h('td', { class: 'nowrap', text: b.expiresAt ? fmtTime(b.expiresAt) : 'permanent' }),
        h('td', {}, b.lifted ? h('span', { class: 'muted', text: 'lifted ' + fmtTime(b.lifted.at) }) : (active ? h('span', { class: 'badge bad' }, 'active') : h('span', { class: 'badge' }, 'expired'))),
        h('td', {}, active ? h('button', { class: 'sm', onclick: lift(b) }, 'Lift') : null));
    });
    const showToggle = h('input', { type: 'checkbox' }); showToggle.checked = showAll;
    showToggle.addEventListener('change', () => { location.hash = '#/bans' + (showToggle.checked ? '/all' : ''); });

    const sid = h('input', { type: 'text', placeholder: '7656119...' });
    const reason = h('input', { type: 'text', maxlength: '200', placeholder: 'Reason' });
    const durF = A.durationField();
    const codeF = A.codeField();
    const banForm = h('form', { class: 'inline-form' },
      h('div', { class: 'field' }, h('label', {}, 'Steam id'), sid), h('div', { class: 'field' }, h('label', {}, 'Reason'), reason), codeF.node, durF.node,
      h('button', { class: 'danger', type: 'submit' }, 'New ban'));
    banForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!sid.value.trim() || !reason.value.trim()) { toast('Steam id and reason are required'); return; }
      let hours; try { hours = durF.hours(); } catch (er) { toast(er.message); return; }
      if (await act(() => api('bans', { steamId: sid.value.trim(), reason: reason.value.trim(), hours, code: codeF.value() }), 'Ban created')) reload();
    });

    const blockRows = blocks.map((b) => h('tr', {}, h('td', {}, mid(b.value)), h('td', { text: b.kind }), h('td', { text: b.reason }), h('td', {}, mid(b.by)), timeCell(b.at),
      h('td', {}, b.lifted ? h('span', { class: 'muted', text: 'lifted ' + fmtTime(b.lifted.at) }) : h('span', { class: 'badge bad' }, 'active')),
      h('td', {}, !b.lifted ? h('button', { class: 'sm', onclick: async () => { if (confirmP('Lift host block ' + b.value + '?') && await act(() => api('host-blocks/' + encodeURIComponent(b.id) + '/lift', {}), 'Block lifted')) reload(); } }, 'Lift') : null)));
    const bv = h('input', { type: 'text', placeholder: 'IPv4, CIDR or session id' });
    const br = h('input', { type: 'text', maxlength: '200', placeholder: 'Reason' });
    const blockForm = h('form', { class: 'inline-form' },
      h('div', { class: 'field' }, h('label', {}, 'Value'), bv), h('div', { class: 'field' }, h('label', {}, 'Reason'), br),
      h('button', { class: 'danger', type: 'submit' }, 'Block host'));
    blockForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!bv.value.trim() || !br.value.trim()) { toast('Value and reason are required'); return; }
      if (await act(() => api('host-blocks', { value: bv.value.trim(), reason: br.value.trim() }), 'Host blocked')) reload();
    });

    // IP bans (owner only)
    let ipSection = null;
    if (ipr) {
      const ipRows = (ipr.bans || []).map((b) => {
        const active = !b.lifted && (!b.expiresAt || new Date(b.expiresAt).getTime() > now);
        return h('tr', {}, h('td', {}, mid(b.value)), h('td', { text: b.kind }), h('td', { text: b.reason }), h('td', {}, mid(b.by)), timeCell(b.at),
          h('td', { class: 'nowrap', text: b.expiresAt ? fmtTime(b.expiresAt) : 'permanent' }),
          h('td', {}, b.lifted ? h('span', { class: 'muted', text: 'lifted ' + fmtTime(b.lifted.at) }) : (active ? h('span', { class: 'badge bad' }, 'active') : h('span', { class: 'badge' }, 'expired'))),
          h('td', {}, active ? h('button', { class: 'sm', onclick: async () => { if (confirmP('Lift IP ban ' + b.value + '?') && await act(() => api('ip-bans/' + encodeURIComponent(b.id) + '/lift', {}), 'IP ban lifted')) reload(); } }, 'Lift') : null));
      });
      const ipv = h('input', { type: 'text', placeholder: 'IPv4, IPv6 or IPv4 CIDR (/16 - /32)' });
      const ipr_ = h('input', { type: 'text', maxlength: '200', placeholder: 'Reason' });
      const ipd = A.durationField();
      const ipForm = h('form', { class: 'inline-form' }, h('div', { class: 'field' }, h('label', {}, 'Address'), ipv), h('div', { class: 'field' }, h('label', {}, 'Reason'), ipr_), ipd.node,
        h('button', { class: 'danger', type: 'submit' }, 'Ban IP'));
      ipForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!ipv.value.trim() || !ipr_.value.trim()) { toast('Address and reason are required'); return; }
        let hours; try { hours = ipd.hours(); } catch (er) { toast(er.message); return; }
        if (await act(() => api('ip-bans', { ip: ipv.value.trim(), reason: ipr_.value.trim(), hours }), 'IP banned')) reload();
      });
      ipSection = [h('h1', { class: 'mt' }, 'IP bans'),
        tableWrap(['Address', 'Kind', 'Reason', 'By', 'Created', 'Expires', 'Status', ''], ipRows, 'No IP bans'),
        h('div', { class: 'card' }, h('h3', {}, 'New IP ban'), ipForm)];
    }

    show(h('h1', {}, 'Bans'),
      h('div', { class: 'row' }, h('label', { class: 'check' }, showToggle, 'show lifted / expired')),
      tableWrap(['Player', 'Steam id', 'Reason', 'By', 'Created', 'Expires', 'Status', ''], banRows, 'No bans'),
      h('div', { class: 'card' }, h('h3', {}, 'New ban'), banForm),
      ipSection,
      h('h1', { class: 'mt' }, 'Host blocks'),
      tableWrap(['Value', 'Kind', 'Reason', 'By', 'Created', 'Status', ''], blockRows, 'No host blocks'),
      h('div', { class: 'card' }, h('h3', {}, 'New host block'), blockForm));
  };
})();
