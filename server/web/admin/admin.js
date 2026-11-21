'use strict';
/* OG SOS admin panel. Vanilla JS, no innerHTML with data, CSP-safe (no inline code/styles). */
(function () {
  const $ = (id) => document.getElementById(id);
  const main = $('main');

  // ---------- DOM helpers ----------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    add(el, children);
    return el;
  }
  function add(el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) add(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function show(...nodes) { clear(main); add(main, nodes); }

  // ---------- formatting ----------
  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function ago(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    let s = Math.round((Date.now() - t) / 1000);
    const fut = s < 0; s = Math.abs(s);
    let out;
    if (s < 60) out = s + ' s';
    else if (s < 3600) out = Math.round(s / 60) + ' min';
    else if (s < 86400) out = Math.round(s / 3600) + ' h';
    else out = Math.round(s / 86400) + ' d';
    return fut ? 'in ' + out : out + ' ago';
  }
  function timeCell(iso) {
    if (!iso) return h('td', { class: 'muted' }, '-');
    return h('td', { class: 'nowrap', title: ago(iso) }, fmtTime(iso), ' ', h('span', { class: 'muted' }, '(' + ago(iso) + ')'));
  }
  function dur(sec) {
    if (typeof sec !== 'number' || !isFinite(sec)) return '';
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m >= 60 ? Math.floor(m / 60) + 'h ' + pad2(m % 60) + 'm' : m + 'm ' + pad2(s) + 's';
  }
  function short(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function fmtVal(v) {
    if (v === null || v === undefined) return '-';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return String(v); } }
    return String(v);
  }
  function safeUrl(u) { return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null; }
  function extLink(url, label) {
    const u = safeUrl(url);
    if (!u) return null;
    return h('a', { href: u, rel: 'noopener noreferrer nofollow', target: '_blank' }, label || short(u, 40));
  }
  const idLink = (id, name) => h('a', { href: '#/player/' + encodeURIComponent(id), title: id }, name || id);
  const mid = (id) => h('span', { class: 'mono' }, id == null ? '' : String(id));

  // ---------- toasts ----------
  function toast(msg, ok) {
    const t = h('div', { class: 'toast' + (ok ? ' ok' : ''), role: 'alert' });
    const x = h('button', { class: 'sm', 'aria-label': 'Dismiss', onclick: () => t.remove() }, '×');
    add(t, [h('span', { text: String(msg) }), x]);
    $('toasts').appendChild(t);
    if (ok) setTimeout(() => t.remove(), 4000);
  }

  // ---------- API ----------
  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  let unauthorized = false;
  async function api(path, body) {
    const opts = { credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-OGSOS-Admin'] = '1';
      opts.body = JSON.stringify(body);
    }
    let res;
    try { res = await fetch('/admin/api/' + path, opts); }
    catch (e) { throw new ApiError(0, 'Network error: ' + e.message); }
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (res.status === 401) { showSignIn(); throw new ApiError(401, 'Not signed in'); }
    if (!res.ok) {
      const m = data && (data.error || data.message);
      throw new ApiError(res.status, 'HTTP ' + res.status + (m ? ': ' + (typeof m === 'string' ? m : JSON.stringify(m)) : ''));
    }
    return data;
  }
  // Run an action, toasting failures. Returns result or undefined on failure.
  async function act(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, true);
      return r === undefined ? true : r;
    } catch (e) {
      if (e.status !== 401) toast(e.message || String(e));
      return undefined;
    }
  }

  // ---------- dialogs ----------
  function openDialog(title, body, buttons, opts) {
    const dlg = h('dialog', { class: opts && opts.narrow ? 'narrow' : '' });
    const close = () => { try { dlg.close(); } catch (_) { /* already closed */ } dlg.remove(); };
    add(dlg, [
      h('div', { class: 'dlg-head' }, h('h2', { text: title }), h('button', { class: 'sm', 'aria-label': 'Close', onclick: close }, '×')),
      h('div', { class: 'dlg-body' }, body),
      buttons && buttons.length ? h('div', { class: 'dlg-foot' }, buttons) : null,
    ]);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
    return { dlg, close };
  }

  function copyBtn(text) {
    const b = h('button', { class: 'sm' }, 'Copy');
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
      catch (_) {
        const ta = h('textarea', {}); ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); b.textContent = 'Copied'; } catch (e) { b.textContent = 'Copy failed'; }
        ta.remove();
      }
      setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    });
    return b;
  }

  // Duration picker shared by the ban dialog and "New ban" form.
  function durationField() {
    const sel = h('select', {},
      h('option', { value: '1' }, '1 hour'),
      h('option', { value: '24' }, '24 hours'),
      h('option', { value: '168' }, '7 days'),
      h('option', { value: '720' }, '30 days'),
      h('option', { value: 'perm' }, 'Permanent'),
      h('option', { value: 'custom' }, 'Custom (hours)...'));
    sel.value = '24';
    const custom = h('input', { type: 'number', min: '1', max: '87600', step: '1', placeholder: 'hours', class: 'hidden' });
    sel.addEventListener('change', () => custom.classList.toggle('hidden', sel.value !== 'custom'));
    return {
      node: h('div', { class: 'field' }, h('label', {}, 'Duration'), sel, custom),
      hours() {
        if (sel.value === 'perm') return null;
        if (sel.value === 'custom') {
          const n = Number(custom.value);
          if (!isFinite(n) || n < 1 || n > 87600) throw new Error('Custom hours must be 1 - 87600');
          return Math.round(n);
        }
        return Number(sel.value);
      },
    };
  }

  // "Code shown to the player": the game words only 24 h and 7 d bans precisely; anything else reads "permanently banned".
  function codeField() {
    const sel = h('select', {}, [['cheating', 'Cheating'], ['harassment', 'Harassment'], ['spam', 'Spam'], ['bad-username', 'Bad username'],
      ['toxicity', 'Toxicity'], ['stream-sniping', 'Stream sniping'], ['ban-evasion', 'Ban evasion'], ['other', 'Other']].map(([v, t]) => h('option', { value: v }, t)));
    sel.value = 'other';
    return {
      node: h('div', { class: 'field' }, h('label', {}, 'Code shown to the player'), sel,
        h('p', { class: 'muted', text: 'The game only words 24 hour and 7 day bans precisely; any other length reads as "permanently banned" to the player.' })),
      value: () => sel.value,
    };
  }

  function banDialog(steamId, name, done) {
    const reason = h('input', { type: 'text', maxlength: '200', placeholder: 'Reason (required)' });
    const dur_ = durationField();
    const code_ = codeField();
    const go = h('button', { class: 'danger' }, 'Ban');
    const { close } = openDialog('Ban ' + (name || steamId), [
      h('p', { class: 'muted mono', text: steamId }),
      h('div', { class: 'field' }, h('label', {}, 'Reason'), reason),
      code_.node,
      dur_.node,
    ], [h('button', { onclick: () => close() }, 'Cancel'), go], { narrow: true });
    go.addEventListener('click', async () => {
      const r = reason.value.trim();
      if (!r) { toast('A reason is required'); return; }
      let hours;
      try { hours = dur_.hours(); } catch (e) { toast(e.message); return; }
      go.disabled = true;
      const ok = await act(() => api('bans', { steamId, reason: r, hours, code: code_.value() }), 'Banned ' + (name || steamId));
      go.disabled = false;
      if (ok) { close(); if (done) done(); }
    });
    reason.focus();
  }

  function kickDialog(sessionId, playerId, name, game, done) {
    const reason = h('input', { type: 'text', maxlength: '200', placeholder: 'Reason' });
    const go = h('button', { class: 'danger' }, 'Confirm kick');
    const { close } = openDialog('Kick ' + (name || playerId), [
      h('p', {}, 'Remove ', h('b', { text: name || playerId }), ' from session ', mid(sessionId), '?'),
      h('div', { class: 'field' }, h('label', {}, 'Reason'), reason),
    ], [h('button', { onclick: () => close() }, 'Cancel'), go], { narrow: true });
    go.addEventListener('click', async () => {
      go.disabled = true;
      const body = { sessionId, playerId, reason: reason.value.trim() };
      if (game) body.game = game;
      const ok = await act(() => api('kick', body), 'Kicked ' + (name || playerId));
      go.disabled = false;
      if (ok) { close(); if (done) done(); }
    });
    reason.focus();
  }

  // Spectate / director: choose a mode, then show the join URL, command and expiry; "Stop watching" removes the allow-listing.
  function spectate(sessionId, game) {
    const mode = h('select', {}, h('option', { value: 'spectator' }, 'Spectator'), h('option', { value: 'director' }, 'Director (director camera)'));
    const result = h('div', {});
    const go = h('button', {}, 'Start watching');
    const stop = h('button', { class: 'danger' }, 'Stop watching');
    const base = () => { const b = { sessionId, mode: mode.value }; if (game) b.game = game; return b; };
    const { close } = openDialog('Spectate session', [
      h('p', { class: 'muted mono', text: sessionId }),
      h('div', { class: 'field' }, h('label', {}, 'Mode'), mode),
      result,
    ], [h('button', { onclick: () => close() }, 'Close'), stop, go], { narrow: true });
    go.addEventListener('click', async () => {
      go.disabled = true;
      const r = await act(() => api('spectate', base()));
      go.disabled = false;
      if (!r || r === true) return;
      const parts = [];
      const line = (label, key) => {
        if (r[key] === undefined || r[key] === null || r[key] === '') return;
        parts.push(h('h3', { text: label }), h('div', { class: 'copyrow' }, h('code', { text: String(r[key]) }), copyBtn(String(r[key]))));
      };
      line('Address', 'address');
      line('Join URL', 'joinUrl');
      line('Command', 'command');
      if (r.expiresAt) parts.push(h('p', { class: 'muted', text: 'Expires ' + fmtTime(r.expiresAt) }));
      if (r.instructions) parts.push(h('h3', { text: 'Instructions' }), h('div', { class: 'note', text: String(r.instructions) }));
      result.replaceChildren(...parts);
    });
    stop.addEventListener('click', async () => {
      stop.disabled = true;
      const b = { sessionId }; if (game) b.game = game;
      const r = await act(() => api('spectate/stop', b), 'Stopped watching');
      stop.disabled = false;
      if (r) result.replaceChildren();
    });
  }

  // ---------- generic renderers ----------
  function kvTable(obj, hlKeys) {
    const rows = [];
    const put = (k, v) => rows.push(h('tr', {}, h('th', { text: k }), h('td', { text: fmtVal(v) })));
    if (!obj || typeof obj !== 'object') return h('p', { class: 'muted' }, 'No data');
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const ks = Object.keys(v);
        if (!ks.length) put(k, '-');
        for (const s of ks) put(k + '.' + s, v[s]);
      } else if (Array.isArray(v)) {
        put(k, v.length && typeof v[0] !== 'object' ? v.join(', ') : v.length + ' item(s)');
      } else put(k, v);
    }
    if (!rows.length) return h('p', { class: 'muted' }, 'No data');
    return h('div', { class: 'tw' }, h('table', { class: 'kv' }, h('tbody', {}, rows)));
  }

  function tableWrap(headers, rows, emptyMsg) {
    if (!rows.length) return h('div', { class: 'tw' }, h('div', { class: 'empty', text: emptyMsg || 'Nothing here' }));
    return h('div', { class: 'tw' }, h('table', {},
      h('thead', {}, h('tr', {}, headers.map((x) => typeof x === 'string' ? h('th', { text: x }) : x))),
      h('tbody', {}, rows)));
  }

  function statusBadge(s) { return h('span', { class: 'badge ' + s, text: s }); }

  // Match record dialog: table of all players in the match.
  async function matchDialog(matchId, highlight) {
    const m = await act(() => api('matches/' + encodeURIComponent(matchId)));
    if (!m || m === true) return;
    const hl = highlight || {};
    const players = Array.isArray(m.players) ? m.players : [];
    const colSet = [];
    for (const p of players) for (const k of Object.keys(p)) {
      if (k === 'playerId' || k === 'name') continue;
      if (typeof p[k] !== 'object' && !colSet.includes(k)) colSet.push(k);
    }
    const rows = players.map((p) => {
      const cls = hl.reporter && p.playerId === hl.reporter ? 'hl-a' : (hl.target && p.playerId === hl.target ? 'hl-b' : '');
      return h('tr', { class: cls },
        h('td', {}, idLink(p.playerId, p.name || p.playerId)),
        h('td', {}, mid(p.playerId)),
        colSet.map((k) => h('td', { class: typeof p[k] === 'number' ? 'num' : '', text: fmtVal(p[k]) })));
    });
    const meta = {};
    for (const k of Object.keys(m)) if (k !== 'players') meta[k] = m[k];
    openDialog('Match ' + matchId, [
      kvTable(meta),
      h('h3', { class: 'mt' }, ''),
      tableWrap(['Name', 'Id', ...colSet], rows, 'No players recorded'),
    ], [h('button', { onclick: (e) => e.target.closest('dialog').close() }, 'Close')]);
  }

  function matchLink(id, hl) {
    if (!id) return h('span', { class: 'muted' }, '-');
    const a = h('a', { href: '#', class: 'mono', title: 'Show match record' }, short(id, 14));
    a.addEventListener('click', (e) => { e.preventDefault(); matchDialog(id, hl); });
    return a;
  }

  // ---------- header / auth ----------
  const NAV = [['servers', 'Servers'], ['players', 'Players'], ['reports', 'Reports'], ['bans', 'Bans'], ['audit', 'Audit']];
  function renderNav(route) {
    const nav = $('nav');
    clear(nav);
    for (const [k, label] of NAV) {
      nav.appendChild(h('a', { href: '#/' + k, class: route === k || (k === 'players' && route === 'player') || (k === 'reports' && route === 'report') ? 'on' : '' }, label));
    }
  }
  function showSignIn() {
    unauthorized = true;
    stopRefresh();
    clear($('who')); clear($('nav'));
    show(h('div', { class: 'card signin' },
      h('h1', {}, 'OG SOS Admin'),
      h('p', { class: 'muted' }, 'Sign in with the Steam account listed as an admin for this server.'),
      h('a', { class: 'btn', href: '/admin/login' }, 'Sign in through Steam')));
  }
  async function loadMe() {
    try {
      const me = await api('me');
      unauthorized = false;
      const who = $('who'); clear(who);
      add(who, [h('span', {}, h('b', { text: me.name || '(unnamed)' }), ' ', h('span', { class: 'mono', text: me.steamId })),
        h('a', { href: '/admin/logout' }, 'Sign out')]);
      return true;
    } catch (e) {
      if (e.status !== 401) toast(e.message);
      return false;
    }
  }

  // ---------- auto-refresh ----------
  let refreshTimer = null;
  function stopRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }
  function startRefresh(fn) {
    stopRefresh();
    refreshTimer = setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) fn(); }, 10000);
  }

  // ---------- pages ----------
  let renderSeq = 0;

  // Servers
  async function pageServers() {
    const seq = ++renderSeq;
    let first = true;
    const draw = async () => {
      let data;
      try { data = await api('servers'); } catch (e) { if (first && e.status !== 401) { toast(e.message); } return; }
      if (seq !== renderSeq) return;
      first = false;
      const servers = data.servers || [];
      const on = data.online || {}, q = data.queue || {};
      const stats = h('div', { class: 'stats' },
        ['classic', 'main'].map((g) => h('div', { class: 'stat' }, g, ' online', h('b', { text: String(on[g] ?? 0) }), '  queue', h('b', { text: String(q[g] ?? 0) }))),
        h('div', { class: 'stat' }, 'servers', h('b', { text: String(servers.length) })),
        h('button', { onclick: draw }, 'Refresh'),
        h('span', { class: 'muted' }, 'auto-refresh 10 s'));
      const cards = servers.map((s) => serverCard(s, draw));
      show(h('h1', {}, 'Servers'), stats,
        cards.length ? h('div', { class: 'cards' }, cards) : h('div', { class: 'card empty' }, 'No hosted servers right now'));
    };
    await draw();
    startRefresh(draw);
  }

  function serverCard(s, redraw) {
    const players = s.players || [];
    const meta = [
      s.game ? h('span', {}, 'game: ', h('b', { text: s.game })) : null,
      s.region ? h('span', { text: 'region: ' + s.region }) : null,
      s.state ? h('span', { text: 'state: ' + s.state }) : null,
      s.map ? h('span', { text: 'map: ' + s.map }) : null,
      s.address ? h('span', {}, 'addr: ', h('span', { class: 'mono', text: s.address })) : null,
      s.startedAt ? h('span', { title: fmtTime(s.startedAt) }, 'started ' + ago(s.startedAt)) : null,
      s.community ? h('span', { class: 'badge' }, 'community') : null,
    ];
    const list = players.length ? h('ul', { class: 'plist' }, players.map((p) => h('li', {},
      h('span', { class: 'pname' }, idLink(p.id, p.name || p.id), ' ', p.banned ? h('span', { class: 'badge bad' }, 'banned') : null, p.host ? h('span', { class: 'badge' }, 'host') : null),
      h('span', { class: 'mono muted', text: p.id }),
      h('button', { class: 'sm danger', onclick: () => kickDialog(s.id, p.id, p.name, s.game, redraw) }, 'Kick'),
      h('button', { class: 'sm danger', onclick: () => banDialog(p.id, p.name, redraw) }, 'Ban'))))
      : h('p', { class: 'muted' }, 'No players');
    return h('div', { class: 'card' },
      h('h2', {}, h('span', { class: 'dot' + (s.online ? ' on' : ''), title: s.online ? 'online' : 'offline' }), h('span', { text: s.name || s.id }),
        h('span', { class: 'badge', text: (s.playerCount ?? players.length) + '/' + (s.maxPlayers ?? '?') })),
      h('div', { class: 'srv-meta' }, meta),
      list,
      (s.watchers || []).length ? h('p', { class: 'muted' }, 'Watching: ', (s.watchers || []).map((w) => h('span', { class: 'badge', text: w.name || w.id }))) : null,
      h('div', { class: 'row', 'data-x': '' }, h('span', { class: 'mono muted grow', text: s.id }),
        h('button', { class: 'sm', onclick: () => spectate(s.id, s.game) }, 'Spectate')));
  }

  // Players list
  async function pagePlayers() {
    const seq = ++renderSeq;
    stopRefresh();
    const out = h('div', {});
    const input = h('input', { type: 'text', class: 'search', placeholder: 'Search name or Steam id (empty = most recent)' });
    const run = async () => {
      const r = await act(() => api('players?limit=50&q=' + encodeURIComponent(input.value.trim())));
      if (seq !== renderSeq || !r || r === true) return;
      const list = Array.isArray(r) ? r : (r.players || []);
      clear(out);
      out.appendChild(tableWrap(['Name', 'Steam id', 'Last access', 'Created', 'Status', 'Reports vs', 'Reports by', 'Matches'],
        list.map((p) => h('tr', {},
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
  }

  // Player detail
  async function pagePlayer(id) {
    const seq = ++renderSeq;
    stopRefresh();
    const d = await act(() => api('players/' + encodeURIComponent(id)));
    if (seq !== renderSeq) return;
    if (!d || d === true) { show(h('h1', {}, 'Player'), h('p', { class: 'muted' }, 'Could not load player ', mid(id))); return; }
    const acc = d.account || { id };
    const reload = () => { if (seq === renderSeq) pagePlayer(id); };
    const banInfo = d.ban
      ? h('div', { class: 'banner bad' }, h('b', {}, 'BANNED'), ' ', d.ban.reason, ' ',
        h('span', { class: 'muted', text: d.ban.expiresAt ? '(until ' + fmtTime(d.ban.expiresAt) + ')' : '(permanent)' }), ' ',
        h('button', { class: 'sm', onclick: async () => { if (confirm('Lift ban on ' + (acc.name || id) + '?') && await act(() => api('bans/' + encodeURIComponent(id) + '/lift', {}), 'Ban lifted')) reload(); } }, 'Unban'))
      : null;
    const matchRows = (d.matches || []).map((m) => {
      const me = m.me || {};
      return me;
    });
    const mcols = [];
    for (const me of matchRows) for (const k of Object.keys(me)) {
      if (typeof me[k] === 'number' && !mcols.includes(k)) mcols.push(k);
    }
    const matches = tableWrap(['Ended', 'Duration', ...mcols, 'Players', 'Match'],
      (d.matches || []).map((m) => h('tr', {},
        timeCell(m.endedAt), h('td', { class: 'nowrap', text: dur(m.durationSec) }),
        mcols.map((k) => h('td', { class: 'num', text: m.me && m.me[k] !== undefined ? String(m.me[k]) : '' })),
        h('td', { class: 'num', text: String(m.players ?? '') }), h('td', {}, matchLink(m.id, { target: id })))),
      'No matches');
    const cur = d.current
      ? h('p', {}, 'In session ', mid(d.current.sessionId), ' (', d.current.game, ', ', d.current.state || '?', ') ',
        h('button', { class: 'sm danger', onclick: () => kickDialog(d.current.sessionId, id, acc.name, d.current.game, reload) }, 'Kick'),
        ' ', h('button', { class: 'sm', onclick: () => spectate(d.current.sessionId, d.current.game) }, 'Spectate'))
      : h('p', { class: 'muted' }, 'Not in a live session');
    const history = (d.banHistory || []).length ? tableWrap(['At', 'Reason', 'By', 'Expires', 'Lifted'],
      d.banHistory.map((b) => h('tr', {}, timeCell(b.at), h('td', { text: b.reason }), h('td', {}, mid(b.by)),
        h('td', { text: b.expiresAt ? fmtTime(b.expiresAt) : 'permanent' }), h('td', { text: b.lifted ? fmtTime(b.lifted.at) + ' by ' + b.lifted.by : '' })))) : null;
    show(
      h('div', { class: 'row' }, h('h1', { class: 'grow', text: acc.name || id }),
        h('button', { class: 'danger', onclick: () => banDialog(id, acc.name, reload) }, 'Ban'),
        d.ban ? h('button', { onclick: async () => { if (confirm('Lift ban?') && await act(() => api('bans/' + encodeURIComponent(id) + '/lift', {}), 'Ban lifted')) reload(); } }, 'Unban') : null),
      banInfo,
      h('div', { class: 'cols' },
        h('div', { class: 'card' }, h('h3', {}, 'Account'),
          kvTable({ id: acc.id, name: acc.name, created: fmtTime(acc.created), lastAccess: fmtTime(acc.lastAccess) }),
          h('p', {}, h('a', { href: 'https://steamcommunity.com/profiles/' + encodeURIComponent(acc.id || id), rel: 'noopener noreferrer nofollow', target: '_blank' }, 'Steam profile'),
            ' ', h('span', { class: 'muted' }, '(Steam id is the account id)')),
          cur),
        h('div', { class: 'card' }, h('h3', {}, 'Stats summary'), kvTable(d.stats || {}))),
      h('h2', {}, 'Match history'), matches,
      h('div', { class: 'cols' },
        h('div', {}, h('h2', {}, 'Reports against'), reportsTable(d.reportsAgainst || [], 'against')),
        h('div', {}, h('h2', {}, 'Reports filed'), reportsTable(d.reportsBy || [], 'by'))),
      history ? [h('h2', {}, 'Ban history'), history] : null);
  }

  function reportsTable(list, mode) {
    return tableWrap(['Time', 'Status', mode === 'by' ? 'Target' : 'Reporter', 'Reason', ''],
      list.map((r) => h('tr', {},
        timeCell(r.at), h('td', {}, statusBadge(r.status)),
        h('td', {}, mode === 'by' ? idLink(r.target && r.target.id, r.target && r.target.name) : idLink(r.reporter && r.reporter.id, r.reporter && r.reporter.name)),
        h('td', { text: r.reason }), h('td', {}, h('a', { href: '#/report/' + encodeURIComponent(r.id) }, 'open')))),
      'None');
  }

  // Reports list
  async function pageReports(tab) {
    const seq = ++renderSeq;
    stopRefresh();
    tab = ['open', 'actioned', 'dismissed', 'all'].includes(tab) ? tab : 'open';
    const r = await act(() => api('reports?status=' + tab));
    if (seq !== renderSeq) return;
    const list = !r || r === true ? [] : (Array.isArray(r) ? r : (r.reports || []));
    const tabs = h('div', { class: 'tabs' }, ['open', 'actioned', 'dismissed', 'all'].map((t) =>
      h('a', { href: '#/reports/' + t, class: t === tab ? 'on' : '' }, t)));
    const rows = list.map((x) => h('tr', {},
      timeCell(x.at), h('td', {}, statusBadge(x.status)),
      h('td', {}, idLink(x.reporter && x.reporter.id, x.reporter && x.reporter.name)),
      h('td', {}, idLink(x.target && x.target.id, x.target && x.target.name)),
      h('td', { text: x.reason }), h('td', { class: 'excerpt', text: short(x.text, 140) }),
      h('td', {}, extLink(x.evidenceUrl, 'clip') || h('span', { class: 'muted' }, '-')),
      h('td', {}, matchLink(x.matchId, { reporter: x.reporter && x.reporter.id, target: x.target && x.target.id })),
      h('td', {}, h('a', { href: '#/report/' + encodeURIComponent(x.id) }, 'view'))));
    show(h('h1', {}, 'Reports'), tabs,
      tableWrap(['Time', 'Status', 'Reporter', 'Target', 'Reason', 'Text', 'Evidence', 'Match', ''], rows, 'No ' + (tab === 'all' ? '' : tab + ' ') + 'reports'));
  }

  // Report detail
  async function pageReport(id) {
    const seq = ++renderSeq;
    stopRefresh();
    const d = await act(() => api('reports/' + encodeURIComponent(id)));
    if (seq !== renderSeq) return;
    if (!d || d === true) { show(h('h1', {}, 'Report'), h('p', { class: 'muted' }, 'Could not load report ', mid(id))); return; }
    const r = d.report || {};
    const reload = () => { if (seq === renderSeq) pageReport(id); };
    const tId = r.target && r.target.id, rId = r.reporter && r.reporter.id;
    const hl = { reporter: rId, target: tId };
    const note = h('textarea', { maxlength: '1000', placeholder: 'Moderator note' });
    note.value = r.note || '';
    const setStatus = async (status) => {
      if (await act(() => api('reports/' + encodeURIComponent(id), { status, note: note.value }), 'Report ' + status)) reload();
    };
    const snap = r.snapshot || {};
    const sess = snap.session || null;
    const sessId = r.sessionId || (sess && sess.id) || null;
    const game = sess && sess.game;
    const body = [];
    body.push(h('div', { class: 'row' },
      h('h1', { class: 'grow' }, 'Report ', h('span', { class: 'mono', text: r.id }), ' ', statusBadge(r.status || '?')),
      h('a', { href: '#/reports' }, '← all reports')));
    if (!r.evidenceUrl) body.push(h('div', { class: 'banner' }, 'No video: record with Steam/OBS clips; reporters can attach a clip link'));
    body.push(h('div', { class: 'cols' },
      h('div', { class: 'card' }, h('h3', {}, 'Report'),
        kvTable({ time: fmtTime(r.at) + ' (' + ago(r.at) + ')', source: r.source, reason: r.reason, sessionId: r.sessionId, matchId: r.matchId, resolvedBy: r.resolvedBy, resolvedAt: r.resolvedAt ? fmtTime(r.resolvedAt) : null }),
        h('p', {}, 'Reporter: ', idLink(rId, r.reporter && r.reporter.name), ' ', mid(rId)),
        h('p', {}, 'Target: ', idLink(tId, r.target && r.target.name), ' ', mid(tId),
          d.priorReportsAgainstTarget ? h('span', { class: 'badge warn', text: d.priorReportsAgainstTarget + ' prior reports' }) : null,
          d.ban ? h('span', { class: 'badge bad' }, 'banned') : null),
        r.evidenceUrl ? h('p', {}, 'Evidence: ', extLink(r.evidenceUrl, short(r.evidenceUrl, 60)) || h('span', { class: 'mono', text: r.evidenceUrl })) : null,
        h('h3', {}, 'Text'), h('div', { class: 'note', text: r.text || '(none)' })),
      h('div', { class: 'card' }, h('h3', {}, 'Actions'),
        h('div', { class: 'field' }, h('label', {}, 'Note'), note),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => setStatus('actioned') }, 'Mark actioned'),
          h('button', { onclick: () => setStatus('dismissed') }, 'Dismiss'),
          h('button', { onclick: () => setStatus('open') }, 'Reopen')),
        h('div', { class: 'row' },
          tId ? h('button', { class: 'danger', onclick: () => banDialog(tId, r.target && r.target.name, reload) }, 'Ban target') : null,
          tId && sessId ? h('button', { class: 'danger', title: 'Only works if the target is still seated in this session', onclick: () => kickDialog(sessId, tId, r.target && r.target.name, game, reload) }, 'Kick target (if in a live session)') : null,
          sessId ? h('button', { onclick: () => spectate(sessId, game) }, 'Spectate session') : null))));
    if (d.match || r.matchId) {
      body.push(h('h2', {}, 'Linked match ', matchLink(r.matchId, hl)), matchPlayersTable(d.match, hl));
    }
    const cands = d.candidates || [];
    body.push(h('h2', {}, 'Candidate matches'),
      tableWrap(['Match', 'Ended', 'Duration', 'Players', ''],
        cands.map((m) => h('tr', {}, h('td', {}, matchLink(m.id, hl)), timeCell(m.endedAt), h('td', { text: dur(m.durationSec) }),
          h('td', { class: 'num', text: String((m.players || []).length) }),
          h('td', {}, h('button', { class: 'sm', onclick: async () => { if (await act(() => api('reports/' + encodeURIComponent(id), { matchId: m.id }), 'Match linked')) reload(); } }, 'Link this match')))),
        'No candidate matches'));
    body.push(h('h2', {}, 'Snapshot at report time'),
      h('div', { class: 'cols' },
        h('div', { class: 'card' }, h('h3', {}, 'Reporter ', r.reporter && r.reporter.name || ''), snap.reporter ? kvTable(snap.reporter) : h('p', { class: 'muted' }, 'No snapshot'),
          d.reporter ? [h('h3', {}, 'Reporter now'), kvTable(d.reporter)] : null),
        h('div', { class: 'card' }, h('h3', {}, 'Target ', r.target && r.target.name || ''), snap.target ? kvTable(snap.target) : h('p', { class: 'muted' }, 'No snapshot'),
          d.target ? [h('h3', {}, 'Target now'), kvTable(d.target)] : null)));
    if (sess) body.push(h('div', { class: 'card' }, h('h3', {}, 'Session at report time'), kvTable(sess)));
    if (snap.lastMatch) body.push(h('h2', {}, 'Target\'s last match at report time'), matchPlayersTable(snap.lastMatch, hl));
    show(h('div', { class: 'stack' }, body));
  }

  function matchPlayersTable(m, hl) {
    if (!m) return h('p', { class: 'muted' }, 'Match record not found');
    const players = m.players || [];
    const cols = [];
    for (const p of players) for (const k of Object.keys(p)) {
      if (k === 'playerId' || k === 'name') continue;
      if (typeof p[k] !== 'object' && !cols.includes(k)) cols.push(k);
    }
    return h('div', {},
      h('p', { class: 'muted' }, 'ended ', fmtTime(m.endedAt), m.durationSec ? ' - ' + dur(m.durationSec) : '', m.reason ? ' - ' + m.reason : ''),
      tableWrap(['Name', 'Id', ...cols], players.map((p) => h('tr', { class: p.playerId === hl.reporter ? 'hl-a' : (p.playerId === hl.target ? 'hl-b' : '') },
        h('td', {}, idLink(p.playerId, p.name || p.playerId), p.playerId === hl.reporter ? ' (reporter)' : '', p.playerId === hl.target ? ' (target)' : ''), h('td', {}, mid(p.playerId)),
        cols.map((k) => h('td', { class: typeof p[k] === 'number' ? 'num' : '', text: fmtVal(p[k]) })))), 'No players'));
  }

  // Bans
  async function pageBans(showAll) {
    const seq = ++renderSeq;
    stopRefresh();
    const r = await act(() => api('bans' + (showAll ? '?all=1' : '')));
    if (seq !== renderSeq) return;
    const bans = !r || r === true ? [] : (Array.isArray(r.bans) ? r.bans : Object.values(r.bans || {}));
    const blocks = !r || r === true ? [] : (r.hostBlocks || []);
    const reload = () => { if (seq === renderSeq) pageBans(showAll); };
    const lift = (b) => async () => { if (confirm('Lift ban on ' + (b.name || b.steamId) + '?') && await act(() => api('bans/' + encodeURIComponent(b.steamId) + '/lift', {}), 'Ban lifted')) reload(); };
    const now = Date.now();
    const banRows = bans.map((b) => {
      const active = !b.lifted && (!b.expiresAt || new Date(b.expiresAt).getTime() > now);
      return h('tr', {}, h('td', {}, idLink(b.steamId, b.name || b.steamId)), h('td', {}, mid(b.steamId)), h('td', { text: b.reason }),
        h('td', {}, mid(b.by)), timeCell(b.at), h('td', { class: 'nowrap', text: b.expiresAt ? fmtTime(b.expiresAt) : 'permanent' }),
        h('td', {}, b.lifted ? h('span', { class: 'muted', text: 'lifted ' + fmtTime(b.lifted.at) }) : (active ? h('span', { class: 'badge bad' }, 'active') : h('span', { class: 'badge' }, 'expired'))),
        h('td', {}, active ? h('button', { class: 'sm', onclick: lift(b) }, 'Lift') : null));
    });
    const showToggle = h('input', { type: 'checkbox' }); showToggle.checked = !!showAll;
    showToggle.addEventListener('change', () => { location.hash = '#/bans' + (showToggle.checked ? '/all' : ''); });

    const sid = h('input', { type: 'text', placeholder: '7656119...' });
    const reason = h('input', { type: 'text', maxlength: '200', placeholder: 'Reason' });
    const durF = durationField();
    const codeF = codeField();
    const banForm = h('form', { class: 'inline-form' },
      h('div', { class: 'field' }, h('label', {}, 'Steam id'), sid), h('div', { class: 'field' }, h('label', {}, 'Reason'), reason), codeF.node, durF.node,
      h('button', { class: 'danger', type: 'submit' }, 'New ban'));
    banForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!sid.value.trim() || !reason.value.trim()) { toast('Steam id and reason are required'); return; }
      let hours; try { hours = durF.hours(); } catch (er) { toast(er.message); return; }
      if (await act(() => api('bans', { steamId: sid.value.trim(), reason: reason.value.trim(), hours, code: codeF.value() }), 'Ban created')) reload();
    });

    const blockRows = blocks.map((b) => {
      const active = !b.lifted;
      return h('tr', {}, h('td', {}, mid(b.value)), h('td', { text: b.kind }), h('td', { text: b.reason }), h('td', {}, mid(b.by)), timeCell(b.at),
        h('td', {}, b.lifted ? h('span', { class: 'muted', text: 'lifted ' + fmtTime(b.lifted.at) }) : h('span', { class: 'badge bad' }, 'active')),
        h('td', {}, active ? h('button', { class: 'sm', onclick: async () => { if (confirm('Lift host block ' + b.value + '?') && await act(() => api('host-blocks/' + encodeURIComponent(b.id) + '/lift', {}), 'Block lifted')) reload(); } }, 'Lift') : null));
    });
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

    show(h('h1', {}, 'Bans'),
      h('div', { class: 'row' }, h('label', { class: 'check' }, showToggle, 'show lifted / expired')),
      tableWrap(['Player', 'Steam id', 'Reason', 'By', 'Created', 'Expires', 'Status', ''], banRows, 'No bans'),
      h('div', { class: 'card' }, h('h3', {}, 'New ban'), banForm),
      h('h1', { class: 'mt' }, 'Host blocks'),
      tableWrap(['Value', 'Kind', 'Reason', 'By', 'Created', 'Status', ''], blockRows, 'No host blocks'),
      h('div', { class: 'card' }, h('h3', {}, 'New host block'), blockForm));
  }

  // Audit
  async function pageAudit() {
    const seq = ++renderSeq;
    stopRefresh();
    const r = await act(() => api('audit?limit=200'));
    if (seq !== renderSeq) return;
    const list = !r || r === true ? [] : (Array.isArray(r) ? r : (r.audit || r.entries || []));
    show(h('h1', {}, 'Audit log'), tableWrap(['Time', 'Admin', 'Action', 'Target', 'Detail'],
      list.map((a) => h('tr', {}, timeCell(a.at), h('td', {}, a.byName || '', ' ', mid(a.by)), h('td', {}, h('span', { class: 'badge', text: a.action })),
        h('td', {}, mid(a.target)), h('td', { class: 'excerpt mono', text: typeof a.detail === 'string' ? a.detail : fmtVal(a.detail) }))), 'Audit log is empty'));
  }

  // ---------- router ----------
  function parseRoute() {
    const parts = (location.hash || '#/servers').replace(/^#\/?/, '').split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch (_) { return x; } });
    return { name: parts[0] || 'servers', arg: parts[1] || '' };
  }
  async function route() {
    stopRefresh();
    if (unauthorized) { if (!(await loadMe())) return; }
    const { name, arg } = parseRoute();
    renderNav(name);
    window.scrollTo(0, 0);
    switch (name) {
      case 'servers': return pageServers();
      case 'players': return pagePlayers();
      case 'player': return arg ? pagePlayer(arg) : pagePlayers();
      case 'reports': return pageReports(arg);
      case 'report': return arg ? pageReport(arg) : pageReports('open');
      case 'bans': return pageBans(arg === 'all');
      case 'audit': return pageAudit();
      default: location.hash = '#/servers';
    }
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { /* timer checks document.hidden */ });

  (async () => {
    if (await loadMe()) route();
  })();
})();
