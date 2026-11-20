/* =========================================================================
   WhaleChat · stay signed in  (wc-stay-signed-in)  ·  3.69.0
   -------------------------------------------------------------------------
   Users were being signed out by the app itself. Both the connect path and
   every background refresh contained this:

       if (SESSION && !DB.users.some(u => u.id === SESSION.userId)) {
         SESSION = null; localStorage.removeItem(LS_SESSION);
       }

   So the moment the server's copy of the database did not contain the
   signed-in account — a state written a second earlier by another device, a
   merge that dropped a newly created account, an instance that answered from
   an older snapshot — the device deleted its own session and dropped the user
   on the login screen. That is not a logout the user asked for.

   The fix is deliberately the least destructive one: the session is never
   destroyed because a server copy is missing. Instead

     · the session is kept, and
     · the device's own account record is put back into the database, and
     · that account is pushed up so the server learns about it.

   A user is signed out only when they tap Sign out (or the account is truly
   banned / deleted by an admin, which the app already handles explicitly).
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcStaySignedIn) return;
  window.__wcStaySignedIn = true;

  /* 3.77: the live key is `whalechat.session.v1` — the old value here was
     missing the `.v1` suffix, so the "is the user really signed out?" guard
     answered "yes" on every tick and never repaired a dropped session. */
  var SESSION_KEY = 'whalechat.session.v1';
  var KEEP_KEY = 'wc.session.keep.v1';       /* last session this device held */
  var BACKUP_KEY = 'wc_session_backup_v1';
  var LOCAL_USER_KEY = 'wc.session.user.v1';
  var explicitSignOut = false;
  var lastKnownSession = null;

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function g(name) { try { return window[name]; } catch (e) { return undefined; } }
  function db() { return safe(function () { return g('DB') || null; }, null); }
  function sessionOf() { return safe(function () { return g('SESSION') || null; }, null); }

  /* the session this device last held, kept outside the app's own keys so a
     sync race cannot erase it */
  function rememberSession() {
    var S = sessionOf();
    if (S && S.userId) {
      lastKnownSession = S;
      safe(function () { localStorage.setItem(KEEP_KEY, JSON.stringify(S)); });
    }
    return S;
  }
  function keptSession() {
    if (lastKnownSession) return lastKnownSession;
    return safe(function () { return JSON.parse(localStorage.getItem(KEEP_KEY) || 'null'); }, null);
  }
  /* put the session back after a sync dropped it (never after a real sign-out) */
  function adoptSession() {
    if (explicitSignOut) return false;
    if (sessionOf()) return true;
    var S = keptSession();
    if (!S || !S.userId) return false;
    var d = db();
    if (!d || !Array.isArray(d.users) || !d.users.some(function (u) { return u && u.id === S.userId; })) return false;
    safe(function () { g('SESSION'); window.SESSION = S; });
    safe(function () { localStorage.setItem(SESSION_KEY, JSON.stringify(S)); });
    safe(function () { if (typeof window.render === 'function') window.render(); });
    return true;
  }

  /* --------------------------------------------------------- user backup */
  /* the signed-in account record, kept on this device, so the session can be
     repaired even if the server copy arrives without it */
  function rememberUser(u) {
    if (!u || !u.id) return;
    safe(function () {
      var keep = {};
      ['id', 'fullName', 'username', 'email', 'phone', 'role', 'pass', 'createdAt', 'pin', 'verified'].forEach(function (k) {
        if (u[k] !== undefined) keep[k] = u[k];
      });
      keep.settings = u.settings;
      localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(keep));
      sessionStorage.setItem(BACKUP_KEY, JSON.stringify({ userId: u.id, at: Date.now() }));
    });
  }
  function recalledUser() {
    return safe(function () { return JSON.parse(localStorage.getItem(LOCAL_USER_KEY) || 'null'); }, null);
  }

  /* ------------------------------------------------------------- repair */
  function repairSession() {
    var S = sessionOf();
    if (!S || !S.userId) return false;
    var d = db();
    if (!d || !Array.isArray(d.users)) return false;
    if (d.users.some(function (u) { return u && u.id === S.userId; })) return false;

    /* the server copy lost this account — put the device's copy back */
    var mine = recalledUser();
    if (mine && mine.id === S.userId) {
      d.users.push(mine);
      safe(function () { var p = g('persist'); if (typeof p === 'function') p(true); });
      safe(function () {
        var R = g('Remote');
        if (R && R.enabled) { R.dirty = true; setTimeout(function () { safe(function () { R.flush(); }); }, 400); }
      });
      safe(function () { if (typeof window.toast === 'function') window.toast('Your session was restored', 'ok'); });
      return true;
    }

    /* no backup: keep them signed in rather than throwing them out; the real
       record arrives with the next sync */
    return false;
  }

  /* the account the device last knew, remembered on every render */
  function watchUser() {
    var meFn = g('me');
    if (typeof meFn !== 'function') return;
    var u = safe(function () { return meFn(); }, null);
    if (u && u.id) rememberUser(u);
  }

  /* -------------------------------------------------- block the teardown */
  /* A global setter is not possible for a plain `var`, so instead of patching
     the assignment we neutralise its effect: as soon as the session is gone
     because of a sync, restore it from this device's own record. */
  function install() {
    var R = g('Remote');
    if (R && !R.__wcStay) {
      R.__wcStay = true;
      ['connect', 'refresh', 'apply'].forEach(function (name) {
        var orig = R[name];
        if (typeof orig !== 'function') return;
        R[name] = function () {
          safe(rememberSession);                 /* snapshot before the merge */
          var out = orig.apply(this, arguments);
          var after = function () { safe(adoptSession); safe(repairSession); safe(watchUser); };
          if (out && typeof out.then === 'function') return out.then(function (v) { after(); return v; }, function (e) { after(); throw e; });
          after();
          return out;
        };
      });
    }

    /* the session-guard backup is the recovery path used after a crash or a
       reload; make sure it is written even when the app never got that far */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) safe(watchUser);
    });
    window.addEventListener('pagehide', function () { safe(watchUser); });

    /* A sign-out must be the user's own action. session-guard and the 3.57 patch
       both remove the keys on real sign-out; here we make sure nothing else can
       put the app back on the login screen while the session key still exists. */
    var guard = setInterval(function () {
      var d = db();
      if (!d || !Array.isArray(d.users)) return;
      if (explicitSignOut) return;
      if (!localStorage.getItem(SESSION_KEY) && !keptSession()) return;  /* they really signed out */
      safe(adoptSession);
      var S = sessionOf();
      if (S && S.userId) {
        if (!d.users.some(function (u) { return u && u.id === S.userId; })) safe(repairSession);
        safe(watchUser);
      }
    }, 1500);
    safe(function () { window.addEventListener('beforeunload', function () { clearInterval(guard); }); });
  }

  function hookLogout() {
    var A = g('App');
    if (!A || typeof A.logout !== 'function' || A.logout.__wcStay) return false;
    var orig = A.logout;
    A.logout = function () {
      explicitSignOut = true;
      lastKnownSession = null;
      safe(function () { localStorage.removeItem(LOCAL_USER_KEY); localStorage.removeItem(KEEP_KEY); try { sessionStorage.removeItem(BACKUP_KEY); } catch (e) {} });
      return orig.apply(this, arguments);
    };
    A.logout.__wcStay = true;
    return true;
  }

  function boot() {
    var tries = 0;
    (function bind() {
      var a = hookLogout();
      var b = !!safe(function () { return g('Remote'); }, null);
      if (b) install(); else b = false;
      if ((!a || !b) && tries++ < 60) return setTimeout(bind, 300);
      safe(rememberSession);
      safe(adoptSession);
      safe(repairSession);
      safe(watchUser);
    })();
    /* the app may return from an update reload with the session dropped */
    setTimeout(function () { safe(adoptSession); safe(repairSession); }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.WCStaySignedIn = { repair: repairSession, remember: rememberUser, user: recalledUser };
})();
