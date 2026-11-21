'use strict';
/* OG SOS admin panel, core. Vanilla JS, no innerHTML with data, CSP-safe (no inline code/styles).
 * Loads first; pages-ops.js and pages-people.js register pages on window.OGA.pages; the router starts on DOMContentLoaded. */
(function () {
  const $ = (id) => document.getElementById(id);
  const main = $('main');
  const OGA = { pages: {}, me: null };
  window.OGA = OGA;

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
  const mid = (id) => h('span', { class: 'mono', text: id == null ? '' : String(id) });
  const matchLink = (id, label) => id ? h('a', { href: '#/match/' + encodeURIComponent(id), class: 'mono', title: 'Open match page', text: label || short(id, 14) }) : h('span', { class: 'muted' }, '-');
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : (d === undefined ? 0 : d));
  const isOwner = () => !!(OGA.me && OGA.me.role === 'owner');
  // A value that may be a steam id string or {id,name} (assignee and similar).
  const refId = (v) => (v && typeof v === 'object' ? v.id || v.steamId || '' : (v || ''));
  const refName = (v) => (v && typeof v === 'object' ? v.name || '' : '');

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
  const okData = (r) => (r && r !== true ? r : null);
  const listOf = (r, key) => (Array.isArray(r) ? r : (r && Array.isArray(r[key]) ? r[key] : []));
  const qs = (o) => {
    const p = [];
    for (const k of Object.keys(o)) if (o[k] !== undefined && o[k] !== null && o[k] !== '') p.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k]));
    return p.length ? '?' + p.join('&') : '';
  };

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
  function kvTable(obj) {
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

  function statusBadge(s) { return h('span', { class: 'badge ' + String(s || '').replace(/[^a-z-]/g, ''), text: s || '?' }); }
  // State pill for lobbies (waiting / countdown / started / ended).
  function statePill(s) { return h('span', { class: 'pill st-' + String(s || 'unknown').replace(/[^a-z-]/gi, '').toLowerCase(), text: s || 'unknown' }); }

  // Sortable per-player match table. cols: stat keys; hl: {reporter,target} ids to highlight.
  function playersTable(players, hl) {
    hl = hl || {};
    const cols = [];
    for (const p of players) for (const k of Object.keys(p)) {
      if (k === 'playerId' || k === 'name') continue;
      if (typeof p[k] !== 'object' && !cols.includes(k)) cols.push(k);
    }
    const state = { key: null, dir: -1 };
    const box = h('div', {});
    const draw = () => {
      let rows = players.slice();
      if (state.key) {
        const k = state.key;
        rows.sort((a, b) => {
          const x = a[k], y = b[k];
          if (typeof x === 'number' && typeof y === 'number') return (x - y) * state.dir;
          return String(x == null ? '' : x).localeCompare(String(y == null ? '' : y)) * state.dir;
        });
      }
      const ths = [h('th', { text: 'Name' }), h('th', { text: 'Id' })].concat(cols.map((k) => {
        const th = h('th', { class: 'sortable' + (state.key === k ? ' sorted' : ''), tabindex: '0', title: 'Sort', text: k + (state.key === k ? (state.dir < 0 ? ' ▼' : ' ▲') : '') });
        const go = () => { if (state.key === k) state.dir = -state.dir; else { state.key = k; state.dir = -1; } draw(); };
        th.addEventListener('click', go);
        th.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        return th;
      }));
      clear(box);
      box.appendChild(tableWrap(ths, rows.map((p) => h('tr', { class: p.playerId === hl.reporter ? 'hl-a' : (p.playerId === hl.target ? 'hl-b' : '') },
        h('td', {}, idLink(p.playerId, p.name || p.playerId), p.playerId === hl.reporter ? ' (reporter)' : '', p.playerId === hl.target ? ' (target)' : ''),
        h('td', {}, mid(p.playerId)),
        cols.map((k) => h('td', { class: typeof p[k] === 'number' ? 'num' : '', text: fmtVal(p[k]) })))), 'No players recorded'));
    };
    draw();
    return box;
  }

  // Typed confirmation dialog, e.g. RESET.
  function typedConfirm(title, intro, word, onGo) {
    const inp = h('input', { type: 'text', autocomplete: 'off', placeholder: 'Type ' + word });
    const go = h('button', { class: 'danger', disabled: true }, 'Confirm');
    inp.addEventListener('input', () => { go.disabled = inp.value !== word; });
    const { close } = openDialog(title, [h('p', {}, intro), h('div', { class: 'field' }, h('label', {}, 'Type ' + word + ' to confirm'), inp)],
      [h('button', { onclick: () => close() }, 'Cancel'), go], { narrow: true });
    go.addEventListener('click', async () => {
      if (inp.value !== word) return;
      go.disabled = true;
      const ok = await onGo();
      if (ok) close(); else go.disabled = inp.value !== word;
    });
    inp.focus();
  }

  // ---------- header / auth ----------
  const NAV = [['dashboard', 'Dashboard'], ['servers', 'Servers'], ['players', 'Players'], ['matches', 'Matches'], ['reports', 'Reports'],
    ['bans', 'Bans'], ['community', 'Community'], ['config', 'Config'], ['admins', 'Admins'], ['audit', 'Audit']];
  const NAV_ON = { player: 'players', match: 'matches', report: 'reports' };
  function renderNav(route) {
    const nav = $('nav');
    clear(nav);
    const cur = NAV_ON[route] || route;
    for (const [k, label] of NAV) {
      nav.appendChild(h('a', { href: k === 'dashboard' ? '#/' : '#/' + k, class: cur === k ? 'on' : '' }, label));
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
      OGA.me = me;
      const who = $('who'); clear(who);
      add(who, [h('span', { class: 'badge role-' + (me.role || 'none'), text: me.role || 'no role' }),
        h('span', {}, h('b', { text: me.name || '(unnamed)' }), ' ', h('span', { class: 'mono', text: me.steamId })),
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
  let renderSeq = 0;

  // ---------- router ----------
  function parseRoute() {
    let raw = (location.hash || '#/').replace(/^#\/?/, '');
    let query = {};
    const qi = raw.indexOf('?');
    if (qi >= 0) {
      for (const kv of raw.slice(qi + 1).split('&')) {
        if (!kv) continue;
        const [k, v] = kv.split('=');
        try { query[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' ')); } catch (_) { /* skip bad pair */ }
      }
      raw = raw.slice(0, qi);
    }
    const parts = raw.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch (_) { return x; } });
    return { name: parts[0] || 'dashboard', arg: parts[1] || '', query };
  }
  async function route() {
    stopRefresh();
    document.querySelectorAll('dialog').forEach((d) => { try { d.close(); } catch (_) { /* ignore */ } d.remove(); });
    if (unauthorized) { if (!(await loadMe())) return; }
    const { name, arg, query } = parseRoute();
    renderNav(name);
    window.scrollTo(0, 0);
    const fn = OGA.pages[name];
    if (!fn) { location.hash = '#/'; return; }
    return fn(arg, query);
  }

  Object.assign(OGA, {
    h, add, clear, show, fmtTime, ago, timeCell, dur, short, fmtVal, safeUrl, extLink, idLink, mid, matchLink, num, isOwner, refId, refName,
    toast, api, act, okData, listOf, qs, openDialog, copyBtn, durationField, codeField, banDialog, kickDialog, spectate,
    kvTable, tableWrap, statusBadge, statePill, playersTable, typedConfirm, startRefresh, stopRefresh,
    seq: () => ++renderSeq, cur: () => renderSeq, parseRoute, route,
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('DOMContentLoaded', async () => {
    if (await loadMe()) route();
  });
})();
