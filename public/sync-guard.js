/* =========================================================================
   WhaleChat signup sync guard  (wc-sync-guard)

   A fresh account is written locally, then pushed to the sync server. If the
   periodic state refresh lands in that short window it replaces the local
   database with the server copy (which does not have the new user yet) and
   clears the session — the verify screen then loses the account.

   This guard skips remote refreshes for a short window after signup so the
   first push always wins; normal live refresh resumes right after.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcSyncGuard) return;
  window.__wcSyncGuard = true;

  var GUARD_MS = 120000;
  window.__wcSignupAt = window.__wcSignupAt || 0;

  function wrapSignup() {
    if (typeof App === 'undefined' || !App || typeof App.signup !== 'function' || App.signup.__wcGuard) return false;
    var orig = App.signup;
    var wrapped = async function () {
      var out = await orig.apply(this, arguments);
      window.__wcSignupAt = Date.now();
      /* push the new account straight away, then keep retrying if needed */
      try {
        if (typeof Remote !== 'undefined' && Remote.enabled) {
          Remote.dirty = true;
          Remote.last = Remote.last || null;
          setTimeout(function () { try { Remote.flush(); } catch (e) {} }, 200);
        }
      } catch (e) {}
      return out;
    };
    wrapped.__wcGuard = true;
    App.signup = wrapped;
    return true;
  }

  function wrapRefresh() {
    if (typeof Remote === 'undefined' || !Remote || typeof Remote.refresh !== 'function' || Remote.refresh.__wcGuard) return false;
    var orig = Remote.refresh;
    var wrapped = function (force) {
      var since = Number(window.__wcSignupAt || 0);
      if (since && Date.now() - since < GUARD_MS) {
        try {
          if (typeof Remote !== 'undefined' && Remote.enabled) {
            Remote.dirty = true;
            setTimeout(function () { try { Remote.flush(); } catch (e) {} }, 120);
          }
        } catch (e) {}
        return Promise.resolve();
      }
      return orig.apply(this, arguments);
    };
    wrapped.__wcGuard = true;
    Remote.refresh = wrapped;
    return true;
  }

  var tries = 0;
  var iv = setInterval(function () {
    var a = wrapSignup();
    var b = wrapRefresh();
    if ((a && b) || ++tries > 40) clearInterval(iv);
  }, 300);
  wrapSignup(); wrapRefresh();
})();
