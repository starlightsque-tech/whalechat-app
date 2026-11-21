/* =========================================================================
   WhaleChat login sync guard  (wc-login-guard)

   On a cold start the login form is usable before the account database has
   finished downloading, so a correct password could be rejected as
   "No account found". This guard refreshes the remote state once before
   showing that error, then lets the normal login run.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcLoginGuard) return;
  window.__wcLoginGuard = true;

  function install() {
    if (typeof App === 'undefined' || !App || typeof App.login !== 'function' || App.login.__wcLoginGuard) return false;
    var orig = App.login;
    var wrapped = async function () {
      try {
        var idEl = document.getElementById('loginUser');
        var id = idEl ? String(idEl.value || '').trim() : '';
        var local = null;
        try { local = (typeof byUsername === 'function') ? byUsername(id) : null; } catch (e) {}
        if (!local && id && typeof Remote !== 'undefined' && Remote.enabled && typeof Remote.refresh === 'function') {
          var btn = document.getElementById('loginBtn');
          if (btn) { btn.disabled = true; btn.dataset.orig = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span> Checking your account…'; }
          try { await Remote.refresh(true); } catch (e) {}
          if (btn) { btn.disabled = false; if (btn.dataset.orig) btn.innerHTML = btn.dataset.orig; }
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    wrapped.__wcLoginGuard = true;
    App.login = wrapped;
    return true;
  }

  if (!install()) {
    var t = 0;
    var iv = setInterval(function () { if (install() || ++t > 40) clearInterval(iv); }, 300);
  }
})();
