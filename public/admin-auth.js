/* =========================================================================
   WhaleChat admin session (browser side) · 3.46
   The server no longer trusts an adminId sent by the browser. An admin
   confirms their password once; the server returns a signed token that is
   kept in sessionStorage (cleared when the tab closes) and attached to every
   /api/ request as the x-admin-token header.
   - any admin request that comes back 401 admin_session_required (or 403
     admin_only for a signed-in admin) opens the password dialog and is
     retried once after a successful confirmation
   - a small banner on admin pages offers to unlock admin actions up front
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
  function apiUrl(p) { try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled && Remote.url) return Remote.url(p); } catch (e) {} return p; }
  function isApi(url) { try { return /\/api\//.test(typeof url === 'string' ? url : (url && url.url) || ''); } catch (e) { return false; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function withToken(init) {
    var t = token();
    if (!t) return init;
    init = Object.assign({}, init || {});
    var h = new Headers(init.headers || {});
    h.set('x-admin-token', t);
    init.headers = h;
    return init;
  }

  /* password dialog: resolves true when a token was obtained */
  function prompt_(why) {
    if (pending) return pending;
    pending = new Promise(function (resolve) {
      var u = me_();
      var wrap = document.createElement('div');
      wrap.id = 'wcAdminAuthModal';
      wrap.setAttribute('style', 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px');
      wrap.innerHTML = '<form class="card" style="max-width:380px;width:100%;margin:0">' +
        '<div class="card-title" style="margin:0">Confirm admin password</div>' +
        '<div class="tiny muted" style="margin-top:6px;line-height:1.5">' + esc(why || 'Admin actions now need a server-verified session.') + ' The session lasts 12 hours or until you close this tab.</div>' +
        '<div class="field" style="margin-top:12px"><label class="label">Password for ' + esc((u && (u.username || u.email)) || 'admin') + '</label>' +
        '<input class="input" id="wcAdminAuthPw" type="password" autocomplete="current-password" required/></div>' +
        '<div class="tiny" id="wcAdminAuthErr" style="color:#dc2626;min-height:16px;margin-top:6px"></div>' +
        '<div class="row" style="gap:8px;margin-top:8px;justify-content:flex-end"><button type="button" class="btn btn-ghost" id="wcAdminAuthCancel">Cancel</button><button type="submit" class="btn btn-primary" id="wcAdminAuthOk">Unlock</button></div></form>';
      document.body.appendChild(wrap);
      var input = wrap.querySelector('#wcAdminAuthPw');
      setTimeout(function () { try { input.focus(); } catch (e) {} }, 30);
      function done(ok) { try { wrap.remove(); } catch (e) {} pending = null; resolve(ok); renderBanner(); }
      wrap.querySelector('#wcAdminAuthCancel').onclick = function () { done(false); };
      wrap.querySelector('form').onsubmit = function (ev) {
        ev.preventDefault();
        var btn = wrap.querySelector('#wcAdminAuthOk'); btn.disabled = true;
        origFetch(apiUrl('/api/admin/session'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: (u && u.id) || '', password: input.value }) })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (d) {
            if (d && d.ok && d.token) {
              try { sessionStorage.setItem(KEY, JSON.stringify({ token: d.token, adminId: d.adminId, exp: d.expiresAt })); } catch (e) {}
              try { if (typeof toast === 'function') toast('Admin session unlocked', 'ok'); } catch (e) {}
              done(true);
            } else {
              btn.disabled = false; input.value = '';
              wrap.querySelector('#wcAdminAuthErr').textContent = (d && d.error) || 'Login failed';
            }
          }).catch(function () { btn.disabled = false; wrap.querySelector('#wcAdminAuthErr').textContent = 'Network error'; });
      };
    });
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
    if (/\/api\/admin\/session$/.test(url)) return origFetch(input, init);
    return origFetch(input, withToken(init)).then(function (res) {
      return needsAuth(res).then(function (need) {
        if (!need) return res;
        clear();
        if (!isAdminUser()) return res;
        return prompt_().then(function (ok) { return ok ? origFetch(input, withToken(init)) : res; });
      });
    });
  };

  /* banner on admin pages while no session is active */
  function renderBanner() {
    var id = 'wcAdminAuthBanner', el = document.getElementById(id);
    var show = isAdminUser() && /^#\/admin/.test(location.hash || '') && !read();
    if (!show) { if (el) el.remove(); return; }
    if (el) return;
    el = document.createElement('div');
    el.id = id;
    el.setAttribute('style', 'position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:2147482000;max-width:520px;width:calc(100% - 24px)');
    el.innerHTML = '<div class="card" style="margin:0;display:flex;gap:10px;align-items:center;justify-content:space-between;box-shadow:0 10px 30px rgba(0,0,0,.4)"><span class="tiny">Admin actions are locked until you confirm your password.</span><button class="btn btn-primary btn-sm" type="button">Unlock</button></div>';
    el.querySelector('button').onclick = function () { prompt_(); };
    document.body.appendChild(el);
  }
  window.addEventListener('hashchange', renderBanner);
  setInterval(renderBanner, 4000);
  setTimeout(renderBanner, 1500);

  window.WCAdminAuth = { token: token, clear: clear, unlock: prompt_, active: function () { return !!read(); } };
})();
