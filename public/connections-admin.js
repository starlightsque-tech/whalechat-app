/* =========================================================================
   WhaleChat admin · Servers & API  (wc-connections-admin)  v2.0

   One page where the admin manually connects:

     · APP SERVERS   — the WhaleChat sync/API server(s) the app talks to.
                       Paste a URL, press Connect: it is probed on /api/health,
                       stored with the primary flag, and can be re-tested,
                       made primary or removed at any time.

     · EMAIL SERVER  — the Brevo transactional email account. Paste the API key
                       (+ verified sender), press Connect: the key is checked
                       against Brevo, stored, and a test email can be sent.
                       Verification codes and broadcasts then use it.

   Both are stored server-side (D1 app_state → settings.connections) so a
   redeploy, a cache clear or a new browser never loses them. Nothing here
   rebuilds the chat screen — refreshing status never interrupts a user.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcConnAdmin) return;
  window.__wcConnAdmin = true;

  var C = window.WC_CONN = window.WC_CONN || {};
  var STATE = { status: null, busy: '', note: '', to: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function me2() { try { return typeof me === 'function' ? me() : null; } catch (e) { return null; } }
  function isAdmin() { try { var u = me2(); return !!(u && u.role === 'admin'); } catch (e) { return false; } }
  function tmsg(m, t) { try { if (typeof toast === 'function') toast(m, t || 'ok'); } catch (e) {} }
  function reRender() { try { if (typeof render === 'function') render(); } catch (e) {} }
  function api(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled && Remote.url) return Remote.url(p); } catch (e) {}
    return p;
  }
  function dot(ok) { return '<i class="cn-dot ' + (ok ? 'ok' : 'off') + '"></i>'; }
  function kv(k, v) { return '<div class="cn-kv"><span>' + esc(k) + '</span><b>' + v + '</b></div>'; }
  function when(ts) { return ts ? new Date(ts).toLocaleString() : '—'; }
  function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }

  /* ------------------------------------------------------------------ *
   * data
   * ------------------------------------------------------------------ */
  C.load = async function () {
    if (!isAdmin()) return null;
    var u = me2();
    try {
      var r = await fetch(api('/api/connections?adminId=' + encodeURIComponent(u && u.id)), { headers: { accept: 'application/json' } });
      var d = await r.json();
      if (d && d.ok) { STATE.status = d; STATE.note = ''; }
      else STATE.note = (d && (d.error || d.message)) || 'Could not read the connection status';
    } catch (e) { STATE.note = 'Server unreachable — ' + e.message; }
    return STATE.status;
  };

  C.post = async function (body) {
    var u = me2();
    body.adminId = u && u.id;
    var r = await fetch(api('/api/connections'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    var d = await r.json();
    if (d && d.status) STATE.status = d.status;
    return d || { ok: false, error: 'empty_response' };
  };

  C.test = async function (which, extra) {
    var u = me2();
    var r = await fetch(api('/api/connections/test'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ adminId: u && u.id, which: which, to: STATE.to || (u && u.email) || '' }, extra || {}))
    });
    var d = await r.json();
    if (d && d.status) STATE.status = d.status;
    return d || { ok: false };
  };

  /* ------------------------------------------------------------------ *
   * view
   * ------------------------------------------------------------------ */
  C.view = function () {
    if (!STATE.status && !STATE.note) {
      C.load().then(function () { reRender(); });
    }
    var s = STATE.status;
    var head = '<div class="page-head" style="margin-bottom:14px"><div>' +
      '<div class="section-title" style="margin:0">Servers &amp; API</div>' +
      '<div class="tiny muted">Connect the app server and the email server by hand — saved on the server, kept through every deploy</div></div>' +
      '<button class="btn btn-sm btn-ghost" data-act="cn-reload">' + 'Refresh' + '</button></div>';

    if (!s) {
      return head + '<div class="card"><div class="tiny muted">' + esc(STATE.note || 'Reading the connection status…') + '</div>' +
        (STATE.note ? '<button class="btn btn-sm btn-primary mt12" data-act="cn-reload">Try again</button>' : '') + '</div>';
    }

    var app = s.app || {}, servers = app.servers || [], bre = s.brevo || {}, st = s.storage || {};

    /* ---------- app servers ---------- */
    var serverRows = servers.length ? servers.map(function (x) {
      return '<div class="cn-server">' +
        '<div class="cn-server-top"><div style="min-width:0">' +
        '<div class="cn-server-url">' + dot(x.connected) + esc(x.url) + (x.primary ? '<span class="badge badge-accent" style="margin-left:8px">Primary</span>' : '') + '</div>' +
        '<div class="tiny muted">' + (x.label ? esc(x.label) + ' · ' : '') +
        (x.connected ? 'connected' : 'not reachable') +
        (x.latencyMs ? ' · ' + x.latencyMs + ' ms' : '') +
        (x.version ? ' · build ' + esc(String(x.version).slice(0, 18)) : '') +
        (x.rev ? ' · rev ' + x.rev : '') +
        (x.error ? ' · ' + esc(x.error) : '') +
        ' · checked ' + when(x.checkedAt) + '</div></div>' +
        '<div class="row gap6" style="flex:none">' +
        '<button class="btn btn-xs btn-ghost" data-act="cn-test-server" data-id="' + esc(x.id) + '">Test</button>' +
        (x.primary ? '' : '<button class="btn btn-xs btn-ghost" data-act="cn-primary" data-id="' + esc(x.id) + '">Make primary</button>') +
        '<button class="btn btn-xs btn-ghost" data-act="cn-remove-server" data-id="' + esc(x.id) + '" style="color:var(--danger)">Remove</button>' +
        '</div></div></div>';
    }).join('') : '<div class="cn-empty">No app server connected yet. Paste the address of your WhaleChat sync server below and press Connect.</div>';

    /* ---------- brevo ---------- */
    var brevoBlock =
      '<div class="card cn-card"><div class="between" style="align-items:flex-start;gap:10px">' +
      '<div class="card-title" style="margin:0">' + dot(bre.configured) + ' Brevo · email server</div>' +
      '<span class="badge ' + (bre.configured ? 'badge-success' : 'badge-warn') + '">' + esc(bre.configured ? 'connected' : 'not connected') + '</span></div>' +
      '<div class="cn-grid">' +
      kv('API key', esc(bre.key) || '—') +
      kv('Key source', esc(bre.source || '—')) +
      kv('Verified sender', esc(bre.from || '—')) +
      kv('Sender name', esc(bre.name || '—')) +
      kv('Last verified', when(bre.verifiedAt)) +
      kv('Last test', bre.lastTest ? (bre.lastTest.ok ? 'passed' : 'failed') + ' · ' + when(bre.lastTest.at) : '—') +
      '</div>' +
      (bre.senders && bre.senders.length ? '<div class="tiny muted mt8">Verified senders: ' + bre.senders.map(esc).join(', ') + '</div>' : '') +
      '<div class="field mt12"><label class="label">Brevo API key</label>' +
      '<input class="input" id="cnBrevoKey" type="password" autocomplete="off" placeholder="xkeysib-…  (stored on the server, never shown again)"/></div>' +
      '<div class="row gap8 wrap">' +
      '<div class="field grow" style="margin:0;min-width:170px"><label class="label">Verified sender email</label>' +
      '<input class="input" id="cnBrevoFrom" type="email" value="' + esc(bre.from || '') + '" placeholder="you@yourdomain.com"/></div>' +
      '<div class="field grow" style="margin:0;min-width:140px"><label class="label">Sender name</label>' +
      '<input class="input" id="cnBrevoName" value="' + esc(bre.name || 'WhaleChat') + '"/></div>' +
      '</div>' +
      '<div class="row gap8 wrap mt10">' +
      '<button class="btn btn-primary btn-sm" data-act="cn-connect-brevo">' + 'Connect email server</button>' +
      '<button class="btn btn-ghost btn-sm" data-act="cn-test-brevo">Send test email</button>' +
      (bre.configured && bre.source === 'admin panel' ? '<button class="btn btn-ghost btn-sm" data-act="cn-disconnect-brevo" style="color:var(--danger)">Disconnect</button>' : '') +
      '</div>' +
      '<div class="field mt10" style="margin-bottom:0"><label class="label">Test email goes to</label>' +
      '<input class="input" id="cnTestTo" type="email" value="' + esc(STATE.to || (me2() && me2().email) || '') + '" placeholder="you@yourdomain.com" oninput="window.WC_CONN && (window.WC_CONN.to = this.value)"/></div>' +
      '<div class="tiny muted mt8">Brevo sends over HTTPS (no SMTP socket), so an idle server or a redeploy can never disconnect email. The sender must be a verified sender in Brevo.</div>' +
      '</div>';

    return head +
      (STATE.note ? '<div class="card"><div class="tiny" style="color:var(--danger)">' + esc(STATE.note) + '</div></div>' : '') +
      '<div class="card cn-card"><div class="between" style="align-items:flex-start;gap:10px">' +
      '<div class="card-title" style="margin:0">' + dot(servers.some(function (x) { return x.connected; })) + ' App servers · sync &amp; API</div>' +
      '<span class="badge">' + servers.length + ' connected</span></div>' +
      '<div class="cn-servers">' + serverRows + '</div>' +
      '<div class="hr" style="margin:14px 0"></div>' +
      '<div class="row gap8 wrap" style="align-items:flex-end">' +
      '<div class="field grow" style="margin:0;min-width:200px"><label class="label">App server URL</label>' +
      '<input class="input" id="cnAppUrl" placeholder="https://whalechat-api.yourname.workers.dev"/></div>' +
      '<div class="field" style="margin:0;min-width:130px;max-width:170px"><label class="label">Label</label>' +
      '<input class="input" id="cnAppLabel" placeholder="Primary server"/></div>' +
      '<button class="btn btn-primary btn-sm" data-act="cn-connect-app"' + (STATE.busy === 'app' ? ' disabled' : '') + '>' + (STATE.busy === 'app' ? 'Connecting…' : 'Connect server') + '</button>' +
      '</div>' +
      '<div class="field mt10" style="margin-bottom:0"><label class="label">Public app URL (shown to users &amp; used for links)</label>' +
      '<input class="input" id="cnPublicUrl" value="' + esc(app.publicUrl || '') + '" placeholder="https://whalechat.pages.dev/whalechat"/></div>' +
      '<div class="row gap8 mt10"><button class="btn btn-ghost btn-sm" data-act="cn-test-app">Test all servers</button>' +
      '<button class="btn btn-ghost btn-sm" data-act="cn-save-public">Save public URL</button>' +
      '<span class="tiny muted" style="align-self:center">This API is serving from ' + esc(app.selfUrl || 'this Worker') + '</span></div>' +
      '</div>' +
      brevoBlock +
      '<div class="card cn-card"><div class="card-title" style="margin:0">Where these settings live</div>' +
      '<div class="cn-grid">' + kv('Backend', esc(st.backend || '—')) + kv('Storage', esc(st.table || '—')) +
      kv('Last saved', when(st.updatedAt)) + kv('On new release', 'kept') + '</div>' +
      '<div class="tiny muted mt8">Connections are written to the server database, not the browser, so clearing a cache, signing in on another phone or publishing a new build never disconnects the app server or the email server.</div></div>' +
      '<style>' + CSS + '</style>';
  };

  var CSS = [
    '.cn-card{margin-bottom:12px}',
    '.cn-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}',
    '.cn-kv{display:flex;flex-direction:column;gap:1px;min-width:0}',
    '.cn-kv span{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-2);font-weight:700}',
    '.cn-kv b{font-size:12px;overflow-wrap:anywhere}',
    '.cn-dot{display:inline-block;width:8px;height:8px;border-radius:99px;margin-right:7px;vertical-align:middle}',
    '.cn-dot.ok{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18)}',
    '.cn-dot.off{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.16)}',
    '.cn-servers{display:flex;flex-direction:column;gap:8px;margin-top:10px}',
    '.cn-server{border:1px solid var(--border);border-radius:12px;padding:10px 11px;background:var(--surface-2)}',
    '.cn-server-top{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}',
    '.cn-server-url{font-size:12.5px;font-weight:650;overflow-wrap:anywhere}',
    '.cn-empty{border:1px dashed var(--border);border-radius:12px;padding:16px;text-align:center;color:var(--muted);font-size:12.5px;margin-top:10px}',
    '@media(max-width:520px){.cn-grid{grid-template-columns:1fr}}'
  ].join('\n');

  /* ------------------------------------------------------------------ *
   * actions
   * ------------------------------------------------------------------ */
  function busy(what, on) {
    STATE.busy = on ? what : '';
    reRender();
  }

  function install() {
    if (typeof App === 'undefined' || App.__wcConnActions) return true;
    App.__wcConnActions = true;

    App.cnReload = async function () {
      STATE.status = null; STATE.note = '';
      reRender();
      await C.load();
      reRender();
    };

    App.cnConnectApp = async function () {
      var url = String(val('cnAppUrl') || '').trim();
      if (!url) return tmsg('Paste the app server URL first', 'err');
      var label = String(val('cnAppLabel') || '').trim();
      STATE.busy = 'app'; reRender();
      tmsg('Connecting ' + url + '…');
      try {
        var d = await C.post({ app: { url: url, label: label } });
        STATE.busy = '';
        if (!d.ok) { tmsg('Could not connect: ' + (d.error || 'unknown error'), 'err'); reRender(); return; }
        tmsg('App server connected', 'ok');
        reRender();
      } catch (e) {
        STATE.busy = ''; tmsg('Connect failed: ' + e.message, 'err'); reRender();
      }
    };

    App.cnTestApp = async function () {
      tmsg('Testing app servers…');
      try {
        var d = await C.test('app');
        var ok = d && d.results && d.results.app && d.results.app.ok;
        tmsg(ok ? 'App server is live' : 'No app server answered', ok ? 'ok' : 'err');
      } catch (e) { tmsg('Test failed: ' + e.message, 'err'); }
      reRender();
    };

    App.cnTestServer = async function (id) {
      tmsg('Testing server…');
      try {
        var d = await C.test('app', { serverId: id });
        var s = d && d.results && d.results.app && (d.results.app.servers || [])[0];
        tmsg(s && s.ok ? 'Server answered in ' + (s.latencyMs || 0) + ' ms' : 'Server did not answer' + (s && s.error ? ' — ' + s.error : ''), s && s.ok ? 'ok' : 'err');
      } catch (e) { tmsg('Test failed: ' + e.message, 'err'); }
      reRender();
    };

    App.cnPrimary = async function (id) {
      try {
        var d = await C.post({ app: { primary: id } });
        tmsg(d.ok ? 'Primary server updated' : 'Could not update: ' + (d.error || ''), d.ok ? 'ok' : 'err');
      } catch (e) { tmsg('Failed: ' + e.message, 'err'); }
      reRender();
    };

    App.cnRemoveServer = async function (id) {
      var okDel = true;
      try {
        if (typeof confirmDialog === 'function') {
          okDel = await confirmDialog({ title: 'Remove this server?', body: 'The app will keep using the remaining servers. You can add it back at any time.', danger: true, ok: 'Remove' });
        }
      } catch (e) { okDel = true; }
      if (!okDel) return;
      try {
        var d = await C.post({ app: { remove: id } });
        tmsg(d.ok ? 'Server removed' : 'Could not remove: ' + (d.error || ''), d.ok ? 'ok' : 'err');
      } catch (e) { tmsg('Failed: ' + e.message, 'err'); }
      reRender();
    };

    App.cnSavePublic = async function () {
      try {
        var d = await C.post({ app: { publicUrl: String(val('cnPublicUrl') || '') } });
        tmsg(d.ok ? 'Public URL saved' : 'Could not save: ' + (d.error || ''), d.ok ? 'ok' : 'err');
      } catch (e) { tmsg('Failed: ' + e.message, 'err'); }
      reRender();
    };

    App.cnConnectBrevo = async function () {
      var key = String(val('cnBrevoKey') || '').trim();
      var from = String(val('cnBrevoFrom') || '').trim();
      var name = String(val('cnBrevoName') || '').trim();
      if (!key) return tmsg('Paste the Brevo API key first', 'err');
      if (!from) return tmsg('Add the verified sender email', 'err');
      tmsg('Checking the key with Brevo…');
      try {
        var d = await C.post({ brevo: { apiKey: key, from: from, name: name } });
        if (!d.ok) { tmsg('Email server not connected: ' + (d.error || 'unknown error'), 'err'); reRender(); return; }
        tmsg('Email server connected', 'ok');
        reRender();
      } catch (e) { tmsg('Connect failed: ' + e.message, 'err'); }
    };

    App.cnTestBrevo = async function () {
      STATE.to = String(val('cnTestTo') || STATE.to || '');
      tmsg('Sending a test email…');
      try {
        var d = await C.test('brevo');
        var b = d && d.results && d.results.brevo;
        if (!b) return tmsg('No answer from the server', 'err');
        if (!b.configured) return tmsg('Connect the email server first', 'err');
        if (!b.ok) return tmsg('Brevo rejected the key — check it in Brevo', 'err');
        if (b.sent) tmsg('Test email sent to ' + (b.to || STATE.to || 'you'), 'ok');
        else tmsg(b.sendError || 'Key is valid but the test email did not send (check the verified sender)', 'err');
      } catch (e) { tmsg('Test failed: ' + e.message, 'err'); }
      reRender();
    };

    App.cnDisconnectBrevo = async function () {
      var okDisc = true;
      try {
        if (typeof confirmDialog === 'function') {
          okDisc = await confirmDialog({ title: 'Disconnect the email server?', body: 'Verification codes and account emails will stop until you connect an email server again.', danger: true, ok: 'Disconnect' });
        }
      } catch (e) { okDisc = true; }
      if (!okDisc) return;
      try {
        var d = await C.post({ brevo: { disconnect: true } });
        tmsg(d.ok ? 'Email server disconnected' : 'Could not disconnect: ' + (d.error || ''), d.ok ? 'ok' : 'err');
      } catch (e) { tmsg('Failed: ' + e.message, 'err'); }
      reRender();
    };
    return true;
  }

  /* route: #/admin/connections */
  function patch() {
    if (typeof VIEWS === 'undefined' || !VIEWS.admin) return false;
    if (VIEWS.__wcConnAdmin) return true;
    var base = VIEWS.admin;
    VIEWS.admin = function (parts, params) {
      if ((parts[1] || '') === 'connections') {
        if (!STATE.status && !STATE.note) C.load().then(function () { reRender(); });
        return C.view();
      }
      return base.apply(this, arguments);
    };
    VIEWS.__wcConnAdmin = true;
    return true;
  }

  var tries = 0;
  (function boot() {
    install();
    if (!patch()) {
      if (tries++ < 120) setTimeout(boot, 300);
      return;
    }
    try {
      var nav = window.ADMIN_NAV;
      if (Array.isArray(nav) && !nav.some(function (n) { return n && n.key === 'admin-connections'; })) {
        nav.splice(Math.max(0, nav.length - 2), 0, { key: 'admin-connections', label: 'Servers & API', icon: 'server', href: '#/admin/connections' });
      }
    } catch (e) {}
    if (isAdmin()) C.load();
  })();
})();
