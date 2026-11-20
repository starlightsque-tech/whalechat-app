/* =========================================================================
   WhaleChat admin session (browser side) · 3.47
   The admin panel no longer asks for a second password confirmation and no
   longer shows the "Admin actions are locked" banner. A signed-in admin is
   given a server-signed session for their own account as soon as the app
   loads, and every /api/ request carries it as the x-admin-token header.
   - the token is still bound to the admin id + current password hash, so it
     is revoked when the password changes
   - if a request comes back 401 admin_session_required / 403 admin_only the
     session is re-issued automatically once and the request is retried
   ========================================================================= */
(function () {
  'use strict';
  if (window.WCAdminAuth) return;
  var KEY = 'wc_admin_token_v1';
  var origFetch = window.fetch.bind(window);
  var pending = null;

  function me_() { try { return typeof me === 'function' ? me() : null; } catch (e) { return null; } }
  function isAdminUser() { var u = me_(); return !!(u && u.role === 'admin'); }
  function read() {
    try { var t = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (t && t.token && t.exp > Date.now() + 30000) { var u = me_(); if (!u || u.id === t.adminId) return t; } } catch (e) {}
    return null;
  }
  function token() { var t = read(); return t ? t.token : ''; }
  function clear() { try { sessionStorage.removeItem(KEY); } catch (e) {} }
  function apiUrl(p) { try { if (typeof Remote !== 'undefined' && Remote && Remote.url) return Remote.url(p); } catch (e) {} return p; }
  function isApi(url) { try { return /\/api\//.test(typeof url === 'string' ? url : (url && url.url) || ''); } catch (e) { return false; } }

  function withToken(init) {
    var t = token();
    if (!t) return init;
    init = Object.assign({}, init || {});
    var h = new Headers(init.headers || {});
    h.set('x-admin-token', t);
    init.headers = h;
    return init;
  }

  /* Silently obtain a server session for the signed-in admin. No password prompt. */
  function ensure() {
    if (pending) return pending;
    var u = me_();
    if (!u || u.role !== 'admin') return Promise.resolve(false);
    if (read()) return Promise.resolve(true);
    pending = origFetch(apiUrl('/api/admin/session/auto'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: u.id })
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) {
        pending = null;
        if (d && d.ok && d.token) {
          try { sessionStorage.setItem(KEY, JSON.stringify({ token: d.token, adminId: d.adminId, exp: d.expiresAt })); } catch (e) {}
          return true;
        }
        return false;
      }).catch(function () { pending = null; return false; });
    return pending;
  }

  function needsAuth(res) {
    if (!res || (res.status !== 401 && res.status !== 403)) return Promise.resolve(false);
    return res.clone().json().then(function (d) {
      var e = d && d.error;
      if (e === 'admin_session_required') return true;
      return (e === 'admin_only' || e === 'admin only') && isAdminUser();
    }).catch(function () { return false; });
  }

  window.fetch = function (input, init) {
    if (!isApi(input)) return origFetch(input, init);
    var url = typeof input === 'string' ? input : input.url;
    if (/\/api\/admin\/session(\/auto)?$/.test(url)) return origFetch(input, init);
    var send = function () {
      return origFetch(input, withToken(init)).then(function (res) {
        return needsAuth(res).then(function (need) {
          if (!need) return res;
          clear();
          if (!isAdminUser()) return res;
          return ensure().then(function (ok) { return ok ? origFetch(input, withToken(init)) : res; });
        });
      });
    };
    /* an admin's very first /api call waits for the automatic session so no
       admin action is ever evaluated without the token */
    if (isAdminUser() && !token()) return ensure().then(send);
    return send();
  };

  /* admins are unlocked on load so the first admin page never waits on a session */
  var tries = 0;
  (function boot() {
    if (!isAdminUser()) {
      if (tries++ < 40) return setTimeout(boot, 500);
      return;
    }
    ensure();
  })();

  window.WCAdminAuth = {
    token: token,
    clear: clear,
    unlock: function () { return ensure(); },
    active: function () { return !!read(); }
  };
})();
