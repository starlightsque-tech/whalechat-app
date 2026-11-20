/* =========================================================================
   WhaleChat · admin SMS desk  (wc-admin-sms)  ·  3.68.0
   -------------------------------------------------------------------------
   Adds one admin page — Admin → SMS — that sends text messages through
   Telesign (the server signs the request, the API key never reaches the
   browser):

     · message body written in the panel
     · an optional BUTTON: a label + a link the admin pastes in. A plain SMS
       has no real button, so the link is delivered as its own line —
       "<label>: <https link>" — which phones render as a tappable link that
       opens the app. That is the button the recipient taps.
     · audience: every account with a phone number, or only the accounts the
       admin ticks
     · a live preview of exactly what the phone receives
     · send a test to one number, then send to the audience
     · the recent send log, straight from the server

   Nothing existing is modified: the module adds a nav entry, wraps VIEWS.admin
   (delegating every other admin route to the original view) and talks to
   /api/telesign/{sms,broadcast,log}.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcAdminSms) return;
  window.__wcAdminSms = true;

  var state = { audience: 'all', ids: {}, busy: false, log: null, users: null, status: null };

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? String(e.value == null ? '' : e.value) : ''; }

  /* same API base the rest of the app uses (Appwrite Function / sync server) */
  /* globals are read through window so a module order change or a strict-mode
     wrapper can never turn them into ReferenceErrors */
  function call(name, args) {
    var fn = window[name];
    return typeof fn === 'function' ? fn.apply(window, args || []) : null;
  }
  function apiBase() {
    var b = safe(function () { return (window.WC_SERVERS && typeof window.WC_SERVERS.apiBase === 'function') ? window.WC_SERVERS.apiBase() : ''; }, '');
    if (!b) b = safe(function () { return (window.Remote && window.Remote.base) || ''; }, '');
    if (!b) b = safe(function () { return window.DEFAULT_SYNC_SERVER || ''; }, '');
    return String(b || '').replace(/\/+$/, '');
  }
  function api(path) { return apiBase() + path; }

  function post(path, payload) {
    return fetch(api(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {})
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_response', status: r.status }; }); });
  }
  function get(path) {
    return fetch(api(path), { cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_response' }; }); });
  }

  function toast(msg, kind) {
    safe(function () { if (typeof window.toast === 'function') window.toast(msg, kind); });
    if (!safe(function () { return typeof window.toast === 'function'; }, false)) {
      var bar = el('smsFlash');
      if (bar) { bar.textContent = msg; bar.className = 'sms-flash on ' + (kind || ''); }
    }
  }

  /* ------------------------------------------------------------ compose */
  function cleanUrl(raw) {
    var v = String(raw || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
    if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(v)) return '';
    return v;
  }
  function compose() {
    var body = String(val('smsBody') || '').replace(/\r\n/g, '\n').trim().slice(0, 700);
    var url = cleanUrl(val('smsUrl'));
    var label = String(val('smsBtn') || '').replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '').trim().slice(0, 60);
    if (!url) return { text: body, hasButton: false, url: '', label: '' };
    return { text: body + '\n\n' + (label || 'Open WhaleChat') + ': ' + url, hasButton: true, url: url, label: label || 'Open WhaleChat' };
  }

  /* ------------------------------------------------------------ pieces */
  function pill(on, yes, no) {
    return '<span class="sms-pill ' + (on ? 'ok' : 'off') + '">' + esc(on ? yes : no) + '</span>';
  }

  function recipientsHtml() {
    var users = state.users;
    if (!users) return '<div class="tiny muted">Loading accounts…</div>';
    var withPhone = users.filter(function (u) { return u && u.phone; });
    if (!withPhone.length) {
      return '<div class="sms-empty">No account has a phone number saved yet. A user adds one on signup or in Account → Profile.</div>';
    }
    return '<div class="sms-users">' + withPhone.slice(0, 200).map(function (u) {
      var on = !!state.ids[u.id];
      return '<label class="sms-user' + (on ? ' on' : '') + '">' +
        '<input type="checkbox" data-sms-user="' + esc(u.id) + '"' + (on ? ' checked' : '') + '/>' +
        '<span class="sms-user-main"><b>' + esc(u.fullName || u.username || u.id) + '</b>' +
        '<span>' + esc(u.phone) + '</span></span>' +
        '</label>';
    }).join('') + '</div>';
  }

  function logHtml() {
    var log = state.log;
    if (!log) return '<div class="tiny muted">Loading…</div>';
    var rows = log.entries || [];
    if (!rows.length) return '<div class="sms-empty">Nothing sent yet.</div>';
    return '<table class="sms-table"><thead><tr><th>When</th><th>Type</th><th>Reached</th><th>Button</th><th>Message</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var reached = r.kind === 'broadcast'
          ? (Number(r.sent) || 0) + ' / ' + (Number(r.attempted) || 0) + ' sent' + (r.remaining ? ' · ' + r.remaining + ' queued' : '')
          : '1 · ' + esc(r.status || (r.ok ? 'sent' : 'failed'));
        return '<tr><td>' + esc(new Date(Number(r.at) || Date.now()).toLocaleString()) + '</td>' +
          '<td>' + esc(r.kind === 'broadcast' ? 'Broadcast' : 'Test') + '</td>' +
          '<td>' + esc(reached) + '</td>' +
          '<td>' + (r.button ? '<a href="' + esc(r.button) + '" target="_blank" rel="noopener">' + esc(r.buttonLabel || 'link') + '</a>' : '—') + '</td>' +
          '<td class="sms-msg">' + esc(String(r.message || '').slice(0, 120)) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* ------------------------------------------------------------- panel */
  function panel() {
    var cfg = state.status;
    var configured = !!(cfg && (cfg.configured === true));
    var reach = (cfg && Number(cfg.usersWithPhone)) || 0;
    return '' +
      '<div class="page-head"><div><div class="section-title" style="margin:0">SMS messages</div>' +
        '<div class="tiny muted">Send a text through Telesign — with a link button users can tap to open the app</div></div></div>' +

      '<div id="smsFlash" class="sms-flash"></div>' +

      '<div class="card"><div class="between" style="align-items:center;flex-wrap:wrap;gap:10px">' +
        '<div><div class="card-title" style="margin:0 0 4px">Telesign</div>' +
          '<div class="small muted">' + (configured ? 'Connected — messages are signed by the server' : 'Not connected — add the Telesign customer id and API key to the server environment') + '</div></div>' +
        pill(configured, 'Live', 'Off') +
      '</div>' +
      '<div class="tiny muted mt10">' + esc(reach) + ' account' + (reach === 1 ? '' : 's') + ' with a phone number can be reached.</div></div>' +

      '<div class="card"><div class="card-title" style="margin:0 0 10px">Message</div>' +
        '<div class="field"><label class="label">Text</label>' +
          '<textarea class="input" id="smsBody" rows="4" maxlength="700" placeholder="WhaleChat: your verification code is 418302. It expires in 5 minutes."></textarea></div>' +
        '<div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px">' +
          '<div class="field grow" style="margin:0;min-width:170px"><label class="label">Button label</label>' +
            '<input class="input" id="smsBtn" maxlength="60" placeholder="Open WhaleChat"/></div>' +
          '<div class="field grow" style="margin:0;min-width:220px"><label class="label">Button link</label>' +
            '<input class="input" id="smsUrl" placeholder="https://whalechat.appwrite.network/whalechat.html" autocomplete="off"/></div>' +
        '</div>' +
        '<div class="tiny muted mt6">Paste any link. It is sent as its own tappable line: <b>Button label: https://…</b></div>' +

        '<div class="sms-preview" id="smsPreview"></div>' +
      '</div>' +

      '<div class="card"><div class="card-title" style="margin:0 0 10px">Send to</div>' +
        '<div class="row" style="gap:8px;flex-wrap:wrap">' +
          '<button class="btn ' + (state.audience === 'all' ? 'btn-primary' : 'btn-ghost') + '" data-act="sms-audience" data-aud="all">Everyone with a phone (' + reach + ')</button>' +
          '<button class="btn ' + (state.audience === 'selected' ? 'btn-primary' : 'btn-ghost') + '" data-act="sms-audience" data-aud="selected">Choose accounts</button>' +
        '</div>' +
        '<div id="smsUsers" class="mt10">' + (state.audience === 'selected' ? recipientsHtml() : '') + '</div>' +
        '<div class="row" style="gap:8px;flex-wrap:wrap;margin-top:12px;align-items:flex-end">' +
          '<div class="field grow" style="margin:0;min-width:200px"><label class="label">Send a test first</label>' +
            '<input class="input" id="smsTest" placeholder="+1 469 246 6072"/></div>' +
          '<button class="btn btn-ghost" data-act="sms-test"' + (configured ? '' : ' disabled') + '>Send test</button>' +
          '<button class="btn btn-primary" data-act="sms-send"' + (configured ? '' : ' disabled') + '>Send to users</button>' +
        '</div>' +
        '<div class="tiny muted mt6" id="smsProgress"></div>' +
      '</div>' +

      '<div class="card"><div class="between" style="align-items:center;gap:10px">' +
        '<div class="card-title" style="margin:0">Recent sends</div>' +
        '<button class="btn btn-ghost btn-xs" data-act="sms-refresh">Refresh</button></div>' +
        '<div id="smsLog" class="mt10">' + logHtml() + '</div>' +
      '</div>';
  }

  function style() {
    if (el('wcAdminSmsCss')) return;
    var st = document.createElement('style');
    st.id = 'wcAdminSmsCss';
    st.textContent =
      '.sms-flash{display:none;margin:0 0 10px;padding:10px 12px;border-radius:10px;font-size:12.5px;font-weight:600}' +
      '.sms-flash.on{display:block;background:rgba(46,230,201,.12);border:1px solid rgba(46,230,201,.35);color:#9ff6e6}' +
      '.sms-flash.on.bad{background:rgba(255,92,114,.12);border-color:rgba(255,92,114,.4);color:#ffb3bd}' +
      '.sms-pill{display:inline-flex;align-items:center;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:4px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.12)}' +
      '.sms-pill.ok{color:#7ff0c2;border-color:rgba(34,197,94,.4);background:rgba(34,197,94,.12)}' +
      '.sms-pill.off{color:#ffc400;border-color:rgba(255,196,0,.35);background:rgba(255,196,0,.1)}' +
      '.sms-preview{margin-top:14px;padding:14px;border-radius:14px;background:rgba(255,255,255,.03);border:1px dashed rgba(255,255,255,.12)}' +
      '.sms-preview .sms-bub{max-width:340px;background:#1d6f5f;color:#eafffa;border-radius:16px 16px 16px 4px;padding:10px 12px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word}' +
      '.sms-preview .sms-bub a{color:#b6ffe9;text-decoration:underline;word-break:break-all}' +
      '.sms-preview .sms-cap{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:#7d93a5;font-weight:800;margin-bottom:7px}' +
      '.sms-users{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto}' +
      '.sms-user{display:flex;gap:9px;align-items:center;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.07);cursor:pointer}' +
      '.sms-user.on{border-color:rgba(46,230,201,.35);background:rgba(46,230,201,.07)}' +
      '.sms-user-main{display:flex;flex-direction:column;min-width:0;font-size:12.5px;line-height:1.35}' +
      '.sms-user-main span{font-size:11px;color:#8ba4b6}' +
      '.sms-table{width:100%;border-collapse:collapse;font-size:12px}' +
      '.sms-table th{text-align:left;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:#8ba4b6;padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.08)}' +
      '.sms-table td{padding:8px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top}' +
      '.sms-table .sms-msg{color:#8ba4b6;max-width:320px}' +
      '.sms-empty{font-size:12px;color:#8ba4b6;padding:10px 0}';
    document.head.appendChild(st);
  }

  function paintPreview() {
    var host = el('smsPreview');
    if (!host) return;
    var c = compose();
    if (!c.text) {
      host.innerHTML = '<div class="sms-cap">Preview</div><div class="sms-empty">Type the message above — the preview shows exactly what the phone receives.</div>';
      return;
    }
    var bodyHtml = esc(c.text).replace(/(https?:\/\/[^\s<]+)/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>';
    });
    host.innerHTML = '<div class="sms-cap">Preview · what the phone shows</div>' +
      '<div class="sms-bub">' + bodyHtml + '</div>' +
      '<div class="tiny muted mt6">' + (c.hasButton
        ? 'Button <b>' + esc(c.label) + '</b> → ' + esc(c.url)
        : 'No button — add a label and a link to show a tappable button line.') + '</div>';
  }

  function refreshLog() {
    return get('/api/telesign/log').then(function (d) {
      if (d && d.ok) {
        state.log = d;
        state.status = d;
      }
      var host = el('smsLog');
      if (host) host.innerHTML = logHtml();
      return d;
    }).catch(function () { return null; });
  }

  function paintStatus() {
    var wrap = el('smsStatusWrap');
    if (wrap && state.status) {
      wrap.innerHTML = pill(!!state.status.configured, 'Live', 'Off');
    }
  }

  function loadAccounts() {
    if (state.users) return Promise.resolve(state.users);
    return safe(function () {
      var db = window.DB || null;
      if (db && Array.isArray(db.users)) return Promise.resolve(db.users);
      return null;
    }, null) || Promise.resolve([]);
  }

  function openPanel() {
    style();
    state.users = null;
    loadAccounts().then(function (users) {
      state.users = users || [];
      var host = el('smsUsers');
      if (host && state.audience === 'selected') host.innerHTML = recipientsHtml();
    });
    refreshLog();
    setTimeout(paintPreview, 30);
  }

  /* ----------------------------------------------------------- actions */
  function payload() {
    var c = compose();
    return {
      message: String(val('smsBody') || '').trim(),
      buttonLabel: c.hasButton ? c.label : '',
      buttonUrl: c.hasButton ? c.url : '',
      audience: state.audience,
      userIds: Object.keys(state.ids).filter(function (k) { return state.ids[k]; })
    };
  }

  function sendTest() {
    if (state.busy) return;
    var phone = val('smsTest').trim();
    var c = compose();
    if (!phone) return toast('Enter a phone number with country code.', 'warn');
    if (!c.text) return toast('Type the message first.', 'warn');
    state.busy = true;
    var prog = el('smsProgress');
    if (prog) prog.textContent = 'Sending test…';
    var body = payload();
    body.phone = phone;
    post('/api/telesign/sms', body).then(function (d) {
      state.busy = false;
      if (prog) prog.textContent = '';
      if (d && d.ok) toast('Test sent to ' + (d.to || phone) + (d.hasButton ? ' with the link button' : '') + '.', 'success');
      else toast('Test failed: ' + ((d && (d.message || d.error)) || 'unknown error'), 'warn');
      refreshLog();
    }).catch(function (e) {
      state.busy = false;
      if (prog) prog.textContent = '';
      toast('Test failed: ' + (e && e.message ? e.message : 'network error'), 'warn');
    });
  }

  function sendAll() {
    if (state.busy) return;
    var c = compose();
    if (!c.text) return toast('Type the message first.', 'warn');
    if (state.audience === 'selected' && !payload().userIds.length) return toast('Tick at least one account.', 'warn');
    if (!confirm('Send this SMS now?' + (c.hasButton ? '\n\nWith button: ' + c.label + ' → ' + c.url : ''))) return;
    state.busy = true;
    var prog = el('smsProgress');
    if (prog) prog.textContent = 'Sending…';
    post('/api/telesign/broadcast', payload()).then(function (d) {
      state.busy = false;
      if (prog) prog.textContent = '';
      if (d && d.ok) {
        toast('Sent ' + d.sent + ' of ' + d.attempted + (d.remaining ? ' · ' + d.remaining + ' still queued — send again to continue' : ''), 'success');
      } else {
        toast('Could not send: ' + ((d && (d.message || d.error)) || 'unknown error'), 'warn');
      }
      refreshLog();
    }).catch(function (e) {
      state.busy = false;
      if (prog) prog.textContent = '';
      toast('Could not send: ' + (e && e.message ? e.message : 'network error'), 'warn');
    });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!t) return;
    var act = t.getAttribute('data-act') || '';
    if (act.indexOf('sms-') !== 0) return;
    if (act === 'sms-audience') {
      state.audience = t.getAttribute('data-aud') === 'selected' ? 'selected' : 'all';
      var host = el('smsUsers');
      if (host) host.innerHTML = state.audience === 'selected' ? recipientsHtml() : '';
      document.querySelectorAll('[data-act="sms-audience"]').forEach(function (b) {
        var on = b.getAttribute('data-aud') === state.audience;
        b.className = 'btn ' + (on ? 'btn-primary' : 'btn-ghost');
      });
      if (state.audience === 'selected') {
        loadAccounts().then(function (users) { state.users = users || []; var h = el('smsUsers'); if (h) h.innerHTML = recipientsHtml(); });
      }
      ev.preventDefault(); ev.stopPropagation();
      return;
    }
    if (act === 'sms-test') { ev.preventDefault(); ev.stopPropagation(); return sendTest(); }
    if (act === 'sms-send') { ev.preventDefault(); ev.stopPropagation(); return sendAll(); }
    if (act === 'sms-refresh') { ev.preventDefault(); ev.stopPropagation(); return refreshLog(); }
  }, true);

  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (!t) return;
    if (t.id === 'smsBody' || t.id === 'smsBtn' || t.id === 'smsUrl') paintPreview();
    if (t.getAttribute && t.getAttribute('data-sms-user')) {
      var id = t.getAttribute('data-sms-user');
      state.ids[id] = !!t.checked;
      var lab = t.closest ? t.closest('.sms-user') : null;
      if (lab) lab.classList.toggle('on', !!t.checked);
    }
  }, true);
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t || !t.getAttribute || !t.getAttribute('data-sms-user')) return;
    var id = t.getAttribute('data-sms-user');
    state.ids[id] = !!t.checked;
    var lab = t.closest ? t.closest('.sms-user') : null;
    if (lab) lab.classList.toggle('on', !!t.checked);
  }, true);

  /* -------------------------------------------------------- mount hooks */
  function installView() {
    var V = safe(function () { return (window.VIEWS && window.VIEWS.admin) || null; }, null);
    if (!V || V.__wcSms) return !!V;
    var wrapped = function (parts, params) {
      var seg = (parts && parts[1]) || '';
      if (seg === 'sms') {
        var u = safe(function () { return call('me'); }, null);
        if (!u || u.role !== 'admin') {
          return '<div class="card empty"><h3>Admin access only</h3></div>';
        }
        setTimeout(openPanel, 20);
        return panel();
      }
      return V.apply(this, arguments);
    };
    wrapped.__wcSms = true;
    window.VIEWS.admin = wrapped;
    return true;
  }

  function installNav() {
    var nav = safe(function () { return window.ADMIN_NAV || null; }, null);
    if (!nav || !Array.isArray(nav) || typeof nav.push !== 'function') return false;
    if (nav.some(function (n) { return n && n.key === 'admin-sms'; })) return true;
    var at = Math.max(0, nav.length - 1);
    nav.splice(at, 0, { key: 'admin-sms', label: 'SMS', icon: 'send', href: '#/admin/sms' });
    return true;
  }

  var tries = 0;
  (function boot() {
    installNav();
    var done = installView();
    if ((!done || !nav_ready()) && tries++ < 60) setTimeout(boot, 400);
    function nav_ready() { return !!safe(function () { return window.ADMIN_NAV && window.ADMIN_NAV.some(function (n) { return n && n.key === 'admin-sms'; }); }, false); }
  })();

  window.addEventListener('hashchange', function () {
    if (/^#\/admin\/sms/i.test(location.hash || '')) { installView(); openPanel(); }
  });

  window.WCAdminSms = {
    compose: compose,
    sendTest: sendTest,
    broadcast: sendAll,
    status: function () { return state.status; }
  };
})();
