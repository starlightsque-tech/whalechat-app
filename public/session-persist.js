/* =========================================================================
   WhaleChat persistent sign-in  (wc-session-persist)

   A signed-in account stays signed in — across reloads, updates, offline
   starts, a sync race and a server that is still restoring its database —
   until the user explicitly taps Sign out.

   · The session flag lives in localStorage with no expiry.
   · The signed-in account record is backed up on this device, so if the
     server/database copy of the user is missing or not downloaded yet, the
     account is restored locally and pushed back to the server.
   · Nothing in the app clears the session except App.logout (Sign out).
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcSessionPersist) return;
  window.__wcSessionPersist = true;

  var KEY = 'whalechat.session.v1';

  function rawSession() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function signedIn() {
    try { return !!(typeof SESSION !== 'undefined' && SESSION && SESSION.userId); } catch (e) { return false; }
  }
  function currentUser() {
    try { return (typeof me === 'function') ? me() : null; } catch (e) { return null; }
  }
  function backup(force) {
    try { if (typeof backupSessionUser === 'function') backupSessionUser(force); } catch (e) {}
  }
  function restore() {
    try { if (typeof restoreSessionUser === 'function') return restoreSessionUser(); } catch (e) {}
    return null;
  }
  function onAuthScreen() {
    var h = String(location.hash || '');
    return h === '' || h === '#/' || /#\/(welcome|login|signup|verify)\b/.test(h);
  }

  /* Recover the signed-in account without ever signing the user out. */
  function ensureSignedIn(tries) {
    tries = tries || 0;
    var stored = rawSession();
    try { if (localStorage.getItem('wc.signedout') && !signedIn()) return; } catch (e) {}
    if (!stored && !signedIn()) return;          /* signed out on purpose */
    if (currentUser()) {
      backup(true);
      return;
    }
    if (restore()) {
      backup(true);
      try { if (typeof render === 'function') render(); } catch (e) {}
      /* the account is back: step off a stale welcome/login screen */
      try { if (onAuthScreen() && typeof go === 'function') go(currentUser().role === 'admin' ? 'admin' : 'home'); } catch (e) {}
      return;
    }
    /* the database may still be downloading — retry patiently instead of
       clearing the session */
    if (tries < 60) setTimeout(function () { ensureSignedIn(tries + 1); }, 800);
  }

  function boot() { ensureSignedIn(0); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.addEventListener('load', boot);
  window.addEventListener('online', function () { ensureSignedIn(0); });
  window.addEventListener('hashchange', function () { backup(false); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { backup(true); ensureSignedIn(0); }
  });
  window.addEventListener('pagehide', function () { backup(true); });
  window.addEventListener('beforeunload', function () { backup(true); });

  /* keep the local snapshot fresh while the app is open */
  setInterval(function () { if (currentUser()) backup(false); }, 30000);

  /* Safety net: if some older code path clears the stored session while the
     user is still navigating (not through Sign out), put it straight back. */
  try {
    var origRemove = localStorage.removeItem.bind(localStorage);
    var logoutUntil = 0;
    var origLogout = (typeof App === 'object' && App && typeof App.logout === 'function') ? App.logout : null;
    if (origLogout && !origLogout.__wcPersistWrapped) {
      var wrappedLogout = function () {
        logoutUntil = Date.now() + 4000;         /* a real sign-out is allowed */
        return origLogout.apply(this, arguments);
      };
      wrappedLogout.__wcPersistWrapped = true;
      App.logout = wrappedLogout;
    }
    localStorage.removeItem = function (key) {
      if (key === KEY && signedIn() && Date.now() > logoutUntil) {
        /* keep the user signed in unless Sign out was tapped */
        return undefined;
      }
      return origRemove(key);
    };
  } catch (e) {}
})();
