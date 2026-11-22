'use strict';
/* OG SOS admin panel: operations pages (dashboard, servers + lobby control, community, config, admins, audit). */
(function () {
  const A = window.OGA;
  const { h, add, clear, show, fmtTime, ago, timeCell, short, fmtVal, idLink, mid, matchLink, num, isOwner, toast, api, act, okData, listOf, qs,
    openDialog, kvTable, tableWrap, statePill, startRefresh, stopRefresh } = A;

  const OPEN_STATES = ['waiting', 'countdown'];

  // ---------- Dashboard ----------
  A.pages.dashboard = async function () {
    const seq = A.seq();
    let first = true;
    const draw = async () => {
      let d;
      try { d = await api('dashboard'); } catch (e) { if (first && e.status !== 401) toast(e.message); return; }
      if (seq !== A.cur()) return;
      first = false;
      const po = d.playersOnline || {}, q = d.queue || {}, m = d.matches || {}, rp = d.reports || {}, ho = d.hosts || {};
      const tile = (label, value, sub, href) => {
        const inner = [h('div', { class: 'tile-v', text: String(value) }), h('div', { class: 'tile-l', text: label }), sub ? h('div', { class: 'tile-s muted', text: sub }) : null];
        return href ? h('a', { class: 'tile', href }, inner) : h('div', { class: 'tile' }, inner);
      };
      const lobbies = d.lobbies || [];
      const rows = lobbies.map((l) => h('tr', {},
        h('td', {}, h('span', { class: 'dot' + (l.online ? ' on' : ''), title: l.online ? 'online' : 'offline' }), ' ', l.name || l.id),
        h('td', { text: l.game || '' }),
        h('td', {}, statePill(l.state), ' ', l.locked ? h('span', { class: 'badge warn', text: 'locked' }) : null,
          l.community ? h('span', { class: 'badge', text: l.verified ? 'community, verified' : 'community' }) : null,
          l.countdownEndsAt ? h('span', { class: 'muted', text: ' starts ' + ago(l.countdownEndsAt) }) : null),
        h('td', { class: 'num', text: num(l.players) + '/' + (l.maxPlayers ?? '?') }),
        h('td', { class: 'nowrap ' + (l.online ? 'good' : 'bad'), text: l.online ? 'up' : 'down' + (l.lastSeenSec != null ? ' ' + l.lastSeenSec + ' s' : '') }),
        h('td', { class: 'num muted', text: l.lastSeenSec != null ? l.lastSeenSec + ' s' : '-' }),
        h('td', {}, h('a', { href: '#/servers' }, 'control'))));
      show(
        h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Dashboard'),
          h('span', { class: 'muted', text: d.generatedAt ? 'as of ' + fmtTime(d.generatedAt) + ', auto-refresh 10 s' : 'auto-refresh 10 s' }),
          h('button', { onclick: draw }, 'Refresh')),
        h('div', { class: 'tiles' },
          tile('Players online', num(po.classic) + num(po.main), 'classic ' + num(po.classic) + ' / main ' + num(po.main)),
          tile('Seated in lobbies', num(d.seated), null, '#/servers'),
          tile('In queue', num(q.classic) + num(q.main), 'classic ' + num(q.classic) + ' / main ' + num(q.main)),
          tile('Matches today', num(m.today), 'last 7 days: ' + num(m.week), '#/matches'),
          tile('Open reports', num(rp.open), num(rp.investigating) + ' investigating', '#/reports'),
          tile('Active bans', num(d.bansActive), null, '#/bans'),
          tile('Hosts up', num(ho.up), num(ho.down) + ' down', '#/community')),
        h('h2', { class: 'mt' }, 'Lobbies'),
        tableWrap(['Server', 'Game', 'State', 'Players', 'Host', 'Last seen', ''], rows, 'No lobbies right now'));
    };
    await draw();
    startRefresh(draw);
  };

  // ---------- Servers + lobby control ----------
  async function lobbyAction(s, action, extra, okMsg) {
    const body = Object.assign({}, extra || {});
    if (s.game) body.game = s.game;
    return act(() => api('lobbies/' + encodeURIComponent(s.id) + '/' + action, body), okMsg);
  }

  function optionsDialog(s, redraw) {
    const eff = s.effective || {}, ov = s.overrides || {};
    const mk = (label, key, min, max) => {
      const inp = h('input', { type: 'number', min: String(min), max: String(max), step: '1', placeholder: 'default' + (eff[key] != null ? ' (now ' + eff[key] + ')' : '') });
      if (ov[key] != null) inp.value = String(ov[key]);
      return { inp, node: h('div', { class: 'field' }, h('label', {}, label + ' (' + min + ' to ' + max + ', blank = default)'), inp) };
    };
    const cap = s.maxCap || 100;
    const minF = mk('Minimum players to start', 'minPlayers', 1, cap);
    const cdF = mk('Countdown seconds', 'countdownSec', 0, 600);
    const maxF = mk('Maximum players', 'maxPlayers', 1, cap);
    const save = h('button', { class: 'primary' }, 'Save');
    const { close } = openDialog('Lobby options: ' + (s.name || s.id), [
      h('p', { class: 'muted' }, 'Effective now: min ', h('b', { text: fmtVal(eff.minPlayers) }), ', countdown ', h('b', { text: fmtVal(eff.countdownSec) + ' s' }), ', max ', h('b', { text: fmtVal(eff.maxPlayers) })),
      minF.node, cdF.node, maxF.node,
      h('p', { class: 'muted', text: 'Lowering the minimum can start the countdown immediately if enough players are seated.' }),
    ], [h('button', { onclick: () => close() }, 'Cancel'), save], { narrow: true });
    const val = (f) => (f.inp.value.trim() === '' ? null : Number(f.inp.value));
    save.addEventListener('click', async () => {
      const body = { minPlayers: val(minF), countdownSec: val(cdF), maxPlayers: val(maxF) };
      for (const k of Object.keys(body)) if (body[k] !== null && (!Number.isInteger(body[k]))) { toast(k + ' must be a whole number'); return; }
      save.disabled = true;
      const ok = await lobbyAction(s, 'options', body, 'Options saved');
      save.disabled = false;
      if (ok) { close(); redraw(); }
    });
  }

  function countdownDialog(s, redraw) {
    const sec = h('input', { type: 'number', min: '0', max: '600', step: '1', placeholder: 'default (' + fmtVal((s.effective || {}).countdownSec) + ')' });
    const go = h('button', { class: 'primary' }, 'Start countdown');
    const { close } = openDialog('Start countdown: ' + (s.name || s.id), [
      h('div', { class: 'field' }, h('label', {}, 'Seconds (blank = the lobby default)'), sec)], [h('button', { onclick: () => close() }, 'Cancel'), go], { narrow: true });
    go.addEventListener('click', async () => {
      const body = {};
      if (sec.value.trim() !== '') {
        const n = Number(sec.value);
        if (!Number.isInteger(n) || n < 0 || n > 600) { toast('Seconds must be a whole number from 0 to 600'); return; }
        body.sec = n;
      }
      go.disabled = true;
      const ok = await lobbyAction(s, 'countdown', body, 'Countdown started');
      go.disabled = false;
      if (ok) { close(); redraw(); }
    });
    sec.focus();
  }

  function lobbyBar(s, redraw) {
    const seated = (s.players || []).length || num(s.playerCount);
    const open = OPEN_STATES.includes(String(s.state || '').toLowerCase());
    const name = s.name || s.id;
    const run = async (action, okMsg) => { if (await lobbyAction(s, action, {}, okMsg)) redraw(); };
    return h('div', { class: 'row bar' },
      h('button', { class: 'sm primary', disabled: seated < 1 || !open, title: seated < 1 ? 'Nobody is seated' : 'Skip minimum and countdown',
        onclick: () => { if (confirm('Force start "' + name + '" with ' + seated + ' seated player(s)?')) run('force-start', 'Match starting'); } }, 'Force start'),
      h('button', { class: 'sm', disabled: seated < 1 || !open, onclick: () => countdownDialog(s, redraw) }, 'Countdown...'),
      h('button', { class: 'sm danger', onclick: () => { if (confirm('End the match on "' + name + '" now?')) run('end', 'Match ended'); } }, 'End match'),
      h('button', { class: 'sm danger', onclick: () => { if (confirm('Reset the lobby "' + name + '"? Seated players are dropped.')) run('reset', 'Lobby reset'); } }, 'Reset'),
      s.locked
        ? h('button', { class: 'sm', onclick: () => run('unlock', 'Lobby unlocked') }, 'Unlock')
        : h('button', { class: 'sm', onclick: () => run('lock', 'Lobby locked') }, 'Lock'),
      h('button', { class: 'sm', onclick: () => optionsDialog(s, redraw) }, 'Options...'));
  }

  function lobbyCard(s, redraw) {
    const players = s.players || [];
    const eff = s.effective || {}, ov = s.overrides || {};
    const meta = [
      s.game ? h('span', {}, 'game: ', h('b', { text: s.game })) : null,
      s.region ? h('span', { text: 'region: ' + s.region }) : null,
      s.map ? h('span', { text: 'map: ' + s.map }) : null,
      s.address ? h('span', {}, 'addr: ', h('span', { class: 'mono', text: s.address })) : null,
      s.startedAt ? h('span', { title: fmtTime(s.startedAt) }, 'started ' + ago(s.startedAt)) : null,
      s.countdownEndsAt ? h('span', { title: fmtTime(s.countdownEndsAt) }, 'countdown ends ' + ago(s.countdownEndsAt)) : null,
    ];
    const ovList = Object.keys(ov).filter((k) => ov[k] != null);
    const list = players.length ? h('ul', { class: 'plist' }, players.map((p) => h('li', {},
      h('span', { class: 'pname' }, idLink(p.id, p.name || p.id), ' ', p.banned ? h('span', { class: 'badge bad' }, 'banned') : null, p.host ? h('span', { class: 'badge' }, 'host') : null),
      h('span', { class: 'mono muted', text: p.id }),
      h('button', { class: 'sm danger', onclick: () => A.kickDialog(s.id, p.id, p.name, s.game, redraw) }, 'Kick'),
      h('button', { class: 'sm danger', onclick: () => A.banDialog(p.id, p.name, redraw) }, 'Ban'))))
      : h('p', { class: 'muted' }, 'No players');
    return h('div', { class: 'card' + (s.locked ? ' locked' : '') },
      h('h2', {}, h('span', { class: 'dot' + (s.online ? ' on' : ''), title: s.online ? 'online' : 'offline' }), h('span', { text: s.name || s.id }),
        statePill(s.state),
        s.locked ? h('span', { class: 'badge warn', text: 'locked' }) : null,
        s.community ? h('span', { class: 'badge', text: s.verified ? 'community, verified' : 'community' }) : null,
        h('span', { class: 'badge', text: (s.playerCount ?? players.length) + '/' + (eff.maxPlayers ?? s.maxPlayers ?? '?') })),
      h('div', { class: 'srv-meta' }, meta),
      eff.minPlayers != null || ovList.length ? h('div', { class: 'srv-meta' },
        h('span', { text: 'min ' + fmtVal(eff.minPlayers) + ' / countdown ' + fmtVal(eff.countdownSec) + ' s / max ' + fmtVal(eff.maxPlayers) }),
        ovList.length ? h('span', { class: 'badge warn', title: 'Overridden by an admin', text: 'overrides: ' + ovList.map((k) => k + '=' + ov[k]).join(', ') }) : null) : null,
      list,
      (s.watchers || []).length ? h('p', { class: 'muted' }, 'Watching: ', (s.watchers || []).map((w) => h('span', { class: 'badge', text: w.name || w.id }))) : null,
      lobbyBar(s, redraw),
      h('div', { class: 'row' }, h('span', { class: 'mono muted grow', text: s.id }),
        h('button', { class: 'sm', onclick: () => A.spectate(s.id, s.game) }, 'Spectate')));
  }

  A.pages.servers = async function () {
    const seq = A.seq();
    let first = true;
    const draw = async () => {
      let data;
      try { data = await api('servers'); } catch (e) { if (first && e.status !== 401) toast(e.message); return; }
      if (seq !== A.cur()) return;
      first = false;
      const servers = data.servers || [];
      const on = data.online || {}, q = data.queue || {};
      const stats = h('div', { class: 'stats' },
        ['classic', 'main'].map((g) => h('div', { class: 'stat' }, g, ' online', h('b', { text: String(on[g] ?? 0) }), '  queue', h('b', { text: String(q[g] ?? 0) }))),
        h('div', { class: 'stat' }, 'servers', h('b', { text: String(servers.length) })),
        h('button', { onclick: draw }, 'Refresh'),
        h('span', { class: 'muted' }, 'auto-refresh 10 s'));
      show(h('h1', {}, 'Servers'), stats,
        servers.length ? h('div', { class: 'cards' }, servers.map((s) => lobbyCard(s, draw))) : h('div', { class: 'card empty' }, 'No hosted servers right now'));
    };
    await draw();
    startRefresh(draw);
  };

  // ---------- Community hosts ----------
  function blockDialog(label, value, done) {
    const reason = h('input', { type: 'text', maxlength: '200', placeholder: 'Reason (required)' });
    const go = h('button', { class: 'danger' }, 'Block');
    const { close } = openDialog('Block ' + label, [h('p', { class: 'mono', text: value }), h('div', { class: 'field' }, h('label', {}, 'Reason'), reason)],
      [h('button', { onclick: () => close() }, 'Cancel'), go], { narrow: true });
    go.addEventListener('click', async () => {
      if (!reason.value.trim()) { toast('A reason is required'); return; }
      go.disabled = true;
      const ok = await act(() => api('host-blocks', { value, reason: reason.value.trim() }), 'Blocked ' + value);
      go.disabled = false;
      if (ok) { close(); done(); }
    });
    reason.focus();
  }

  A.pages.community = async function () {
    const seq = A.seq();
    let first = true;
    const draw = async () => {
      let c, bans;
      try { [c, bans] = await Promise.all([api('community'), api('bans').catch(() => null)]); } catch (e) { if (first && e.status !== 401) toast(e.message); return; }
      if (seq !== A.cur()) return;
      first = false;
      const blocks = ((bans && bans.hostBlocks) || []).filter((b) => !b.lifted);
      const hosts = c.hosts || [];
      const unblock = async (host) => {
        const hit = blocks.filter((b) => b.value === host.id || b.value === host.ip);
        if (!hit.length) { toast('No active block found for this host'); return; }
        if (!confirm('Lift ' + hit.length + ' block(s) on "' + (host.name || host.id) + '"?')) return;
        for (const b of hit) { if (!(await act(() => api('host-blocks/' + encodeURIComponent(b.id) + '/lift', {})))) return; }
        toast('Unblocked', true); draw();
      };
      const rows = hosts.map((x) => h('tr', { class: x.blocked ? 'hl-b' : '' },
        h('td', {}, h('span', { class: 'dot' + (x.online ? ' on' : ''), title: x.online ? 'online' : 'offline' }), ' ', x.name || x.id, h('div', { class: 'mono muted', text: x.id })),
        h('td', { class: 'mono', text: (x.ip || '') + (x.port ? ':' + x.port : '') }),
        h('td', {}, x.state ? statePill(x.state) : '', x.blocked ? h('span', { class: 'badge bad', text: 'blocked' }) : null),
        h('td', { class: 'num', text: num(x.players) + '/' + (x.maxPlayers ?? '?') }),
        h('td', {}, h('span', { class: 'badge' + (x.verified ? ' good' : ''), text: x.verified ? 'verified' : 'unverified' }), ' ',
          h('span', { class: 'badge' + (x.listed ? ' good' : ''), text: x.listed ? 'listed' : 'unlisted' }), ' ',
          x.probe != null ? h('span', { class: 'badge', title: 'probe', text: 'probe: ' + (typeof x.probe === 'object' ? fmtVal(x.probe) : x.probe) }) : null),
        timeCell(x.registeredAt),
        h('td', { class: 'num muted', text: x.lastRenewSec != null ? x.lastRenewSec + ' s' : '-' }),
        h('td', { class: 'nowrap' },
          h('button', { class: 'sm danger', onclick: () => blockDialog('host id', x.id, draw) }, 'Block id'), ' ',
          x.ip ? h('button', { class: 'sm danger', onclick: () => blockDialog('host IP', x.ip, draw) }, 'Block IP') : null, ' ',
          x.blocked ? h('button', { class: 'sm', onclick: () => unblock(x) }, 'Unblock') : null)));
      show(h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Community hosts'),
        h('span', { class: 'badge ' + (c.enabled ? 'good' : ''), text: c.enabled ? 'registry enabled' : 'registry disabled' }),
        h('button', { onclick: draw }, 'Refresh')),
      h('p', { class: 'muted', text: 'Host addresses are shown to admins only. Blocks are managed under Bans too.' }),
      tableWrap(['Host', 'Address', 'State', 'Players', 'Trust', 'Registered', 'Renewed', ''], rows, 'No community hosts registered'));
    };
    await draw();
    startRefresh(draw);
  };

  // ---------- Config (announcements / KV) ----------
  const MOTD_KEYS = ['UE_CLIENT_MOTD', 'UE_CLIENT_TEST_SERVER_MOTD', 'UE_CLIENT_INACTIVE_SERVER_TEXT'];
  const kvType = (k) => {
    const t = String(k.type || typeof (k.value !== undefined ? k.value : k.base)).toLowerCase();
    return t === 'bool' ? 'boolean' : t;
  };

  function kvEditor(k, done) {
    const type = kvType(k);
    const owner = isOwner();
    let input;
    if (type === 'boolean') {
      input = h('select', {}, h('option', { value: 'true' }, 'true'), h('option', { value: 'false' }, 'false'));
      input.value = String(!!k.value);
    } else if (type === 'number') {
      input = h('input', { type: 'number', step: 'any' }); input.value = String(k.value);
    } else {
      input = h('textarea', { maxlength: '500' }); input.value = String(k.value == null ? '' : k.value);
    }
    const parse = () => {
      if (type === 'boolean') return input.value === 'true';
      if (type === 'number') { const n = Number(input.value); if (input.value.trim() === '' || !isFinite(n)) throw new Error('Enter a number'); return n; }
      return input.value;
    };
    const save = h('button', { class: 'primary' }, 'Save');
    const { close } = openDialog('Edit ' + k.key, [
      k.description ? h('p', { class: 'muted', text: k.description }) : null,
      h('p', { class: 'muted' }, 'Base value: ', h('span', { class: 'mono', text: fmtVal(k.base) })),
      h('div', { class: 'field' }, h('label', {}, 'Value (' + type + ')'), input)],
    [h('button', { onclick: () => close() }, 'Cancel'), owner ? save : null]);
    save.addEventListener('click', async () => {
      let v; try { v = parse(); } catch (e) { toast(e.message); return; }
      save.disabled = true;
      const ok = await act(() => api('kv', { key: k.key, value: v }), 'Saved ' + k.key);
      save.disabled = false;
      if (ok) { close(); done(); }
    });
  }

  A.pages.config = async function () {
    const seq = A.seq();
    stopRefresh();
    const r = okData(await act(() => api('kv')));
    if (seq !== A.cur()) return;
    const keys = listOf(r, 'keys');
    const owner = isOwner();
    const reload = () => { if (seq === A.cur()) A.pages.config(); };
    const motds = MOTD_KEYS.map((n) => keys.find((k) => k.key === n)).filter(Boolean);
    const cards = motds.map((k) => {
      const ta = h('textarea', { maxlength: '500', rows: '4' });
      ta.value = String(k.value == null ? '' : k.value);
      if (!owner) ta.setAttribute('readonly', '');
      const prev = h('div', { class: 'note motd-preview', text: ta.value || '(empty)' });
      ta.addEventListener('input', () => { prev.textContent = ta.value || '(empty)'; });
      return h('div', { class: 'card' },
        h('h2', {}, h('span', { class: 'mono', text: k.key }), k.overridden ? h('span', { class: 'badge warn', text: 'overridden' }) : null),
        k.description ? h('p', { class: 'muted', text: k.description }) : null,
        h('div', { class: 'field' }, h('label', {}, 'Text'), ta),
        h('h3', {}, 'Preview'), prev,
        owner ? h('div', { class: 'row mt' },
          h('button', { class: 'primary', onclick: async () => { if (await act(() => api('kv', { key: k.key, value: ta.value }), 'Saved ' + k.key)) reload(); } }, 'Save'),
          k.overridden ? h('button', { onclick: async () => { if (confirm('Clear the override for ' + k.key + '?') && await act(() => api('kv/' + encodeURIComponent(k.key) + '/clear', {}), 'Cleared ' + k.key)) reload(); } }, 'Clear override') : null,
          h('span', { class: 'muted', text: 'Base: ' + short(fmtVal(k.base), 80) })) : null);
    });
    const rows = keys.filter((k) => !MOTD_KEYS.includes(k.key)).map((k) => h('tr', { class: k.overridden ? 'hl-a' : '' },
      h('td', { class: 'mono', text: k.key }), h('td', { text: kvType(k) }),
      h('td', { class: 'mono', text: short(fmtVal(k.base), 60) }),
      h('td', { class: 'mono', text: short(fmtVal(k.value), 60) }),
      h('td', { class: 'excerpt muted', text: k.description || '' }),
      h('td', { class: 'nowrap' },
        h('button', { class: 'sm', onclick: () => kvEditor(k, reload) }, owner ? 'Edit' : 'View'), ' ',
        owner && k.overridden ? h('button', { class: 'sm', onclick: async () => { if (confirm('Clear override for ' + k.key + '?') && await act(() => api('kv/' + encodeURIComponent(k.key) + '/clear', {}), 'Cleared ' + k.key)) reload(); } }, 'Clear') : null)));
    show(h('h1', {}, 'Config'),
      owner ? null : h('div', { class: 'banner' }, 'Read-only: only owners can change announcements and game settings.'),
      h('p', { class: 'muted', text: 'Overrides apply to the Classic game client the next time it loads its runtime settings. Only the keys listed here can be changed.' }),
      motds.length ? h('div', { class: 'cols' }, cards) : null,
      h('h2', { class: 'mt' }, 'Settings'),
      tableWrap(['Key', 'Type', 'Base', 'Current', 'Description', ''], rows, 'No editable keys'));
  };

  // ---------- Admins ----------
  A.pages.admins = async function () {
    const seq = A.seq();
    stopRefresh();
    const r = okData(await act(() => api('admins')));
    if (seq !== A.cur()) return;
    const owners = (r && r.owners) || [], mods = (r && r.mods) || [];
    const owner = isOwner();
    const reload = () => { if (seq === A.cur()) A.pages.admins(); };
    const sid = h('input', { type: 'text', placeholder: '7656119...', maxlength: '32' });
    const form = h('form', { class: 'inline-form' }, h('div', { class: 'field' }, h('label', {}, 'Steam id (17 digits)'), sid), h('button', { class: 'primary', type: 'submit' }, 'Add moderator'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!/^\d{17}$/.test(sid.value.trim())) { toast('Enter a 17-digit Steam id'); return; }
      if (await act(() => api('admins', { steamId: sid.value.trim() }), 'Moderator added')) reload();
    });
    show(h('h1', {}, 'Admins'),
      h('p', { class: 'muted', text: 'Owners come from the server configuration. Moderators can manage lobbies, players, reports and bans, but not announcements, settings or other admins.' }),
      h('h2', {}, 'Owners'),
      tableWrap(['Name', 'Steam id'], owners.map((o) => h('tr', {}, h('td', {}, idLink(o.steamId, o.name || o.steamId)), h('td', {}, mid(o.steamId)))), 'No owners'),
      h('h2', { class: 'mt' }, 'Moderators'),
      tableWrap(['Name', 'Steam id', 'Added by', 'Added', ''], mods.map((m) => h('tr', {},
        h('td', {}, idLink(m.steamId, m.name || m.steamId)), h('td', {}, mid(m.steamId)), h('td', {}, mid(m.addedBy)), timeCell(m.at),
        h('td', {}, owner ? h('button', { class: 'sm danger', onclick: async () => { if (confirm('Remove moderator ' + (m.name || m.steamId) + '?') && await act(() => api('admins/' + encodeURIComponent(m.steamId) + '/remove', {}), 'Moderator removed')) reload(); } }, 'Remove') : null))),
      'No moderators'),
      owner ? h('div', { class: 'card mt' }, h('h3', {}, 'Add moderator'), form) : null);
  };

  // ---------- Audit ----------
  const KNOWN_ACTIONS = ['ban', 'unban', 'kick', 'warn', 'note', 'adjust', 'reset-stats', 'report-status', 'report-assign', 'report-note', 'host-block', 'host-unblock',
    'lobby-force-start', 'lobby-countdown', 'lobby-end', 'lobby-reset', 'lobby-lock', 'lobby-unlock', 'lobby-options', 'kv-set', 'kv-clear', 'mod-add', 'mod-remove', 'spectate', 'ip-ban', 'ip-unban', 'ip-view', 'report-queue-full'];

  A.pages.audit = async function () {
    const seq = A.seq();
    stopRefresh();
    const adm = okData(await act(() => api('admins').catch(() => null)));
    if (seq !== A.cur()) return;
    const people = adm ? (adm.owners || []).concat(adm.mods || []) : [];
    const by = h('select', {}, h('option', { value: '' }, 'any admin'), people.map((p) => h('option', { value: p.steamId, text: (p.name || p.steamId) })));
    const action = h('select', {}, h('option', { value: '' }, 'any action'), KNOWN_ACTIONS.map((a) => h('option', { value: a, text: a })));
    const target = h('input', { type: 'text', placeholder: 'target id contains...', class: 'search' });
    const out = h('div', {});
    const csv = h('a', { class: 'btn', href: '#', text: 'Export CSV' });
    let entries = [];
    const filters = () => ({ by: by.value, action: action.value, target: target.value.trim() });
    const render = () => {
      clear(out);
      const withIp = A.isOwner();   // the API sends the ip field to owners only
      out.appendChild(tableWrap(['Time', 'Admin', 'Action', 'Target', 'Detail'].concat(withIp ? ['IP'] : []),
        entries.map((a) => h('tr', {}, timeCell(a.at), h('td', {}, a.byName || '', ' ', mid(a.by)), h('td', {}, h('span', { class: 'badge', text: a.action })),
          h('td', {}, mid(a.target)), h('td', { class: 'excerpt mono', text: typeof a.detail === 'string' ? a.detail : fmtVal(a.detail) }),
          withIp ? h('td', {}, a.ip ? mid(a.ip) : '') : null)), 'No matching audit entries'));
      if (entries.length >= 500) {
        out.appendChild(h('div', { class: 'row mt' }, h('button', { onclick: () => run(true) }, 'Older entries')));
      }
    };
    const run = async (older) => {
      const f = filters();
      csv.setAttribute('href', '/admin/api/audit.csv' + qs(Object.assign({ limit: 20000 }, f)));
      const q = Object.assign({ limit: 500 }, f);
      if (older && entries.length) q.before = entries[entries.length - 1].at;
      const r = okData(await act(() => api('audit' + qs(q))));
      if (seq !== A.cur() || !r) return;
      const list = listOf(r, 'audit').length ? listOf(r, 'audit') : listOf(r, 'entries');
      entries = older ? entries.concat(list) : list;
      render();
      if (older && list.length < 500) { const b = out.querySelector('button'); if (b) b.remove(); }
    };
    const form = h('form', { class: 'row' }, by, action, target, h('button', { class: 'primary', type: 'submit' }, 'Filter'), csv);
    form.addEventListener('submit', (e) => { e.preventDefault(); run(false); });
    show(h('h1', {}, 'Audit log'), form, out);
    run(false);
  };
})();
