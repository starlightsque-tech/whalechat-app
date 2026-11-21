/* =========================================================================
   WhaleChat verification gate  (wc-verify-gate)

   Two races made the "create account → verify" step skippable:
     1. needsEmailVerify() was false while the sync server was still
        connecting, so a brand-new account could land on Home unverified.
     2. the verify screen tried to send the code before the server was ready
        and then never retried.

   This module closes both: a configured sync server always enforces the gate,
   and the code is (re)sent as soon as the connection is online.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcVerifyGate) return;
  window.__wcVerifyGate = true;

  var codeTried = false;

  function serverConfigured() {
    try {
      if (typeof Remote === 'undefined' || !Remote) return false;
      if (Remote.enabled) return true;
      if (Remote.base) return true;
      if (typeof Remote.storedBase === 'function' && Remote.storedBase()) return true;
    } catch (e) {}
    try { if (typeof DEFAULT_SYNC_SERVER !== 'undefined' && DEFAULT_SYNC_SERVER) return true; } catch (e) {}
    try { if (window.__WC_SERVER__) return true; } catch (e) {}
    return false;
  }

  function patchGate() {
    if (typeof window.needsEmailVerify !== 'function' || window.needsEmailVerify.__wcGate) return false;
    var orig = window.needsEmailVerify;
    var wrapped = function (u) {
      if (!u) return false;
      if (u.emailVerified === true || u.verified === true) return false;
      if (u.emailVerifyRequired !== true) return false;
      if (orig(u)) return true;
      /* the account still needs a code — enforce it whenever a sync server is
         configured, even if the socket has not finished connecting */
      return serverConfigured();
    };
    wrapped.__wcGate = true;
    window.needsEmailVerify = wrapped;
    return true;
  }

  function onVerifyRoute() {
    var h = '';
    try { h = String(location.hash || ''); } catch (e) {}
    if (h.indexOf('#/verify') === 0) return true;
    return !!(document.body && document.body.dataset && document.body.dataset.route === 'verify');
  }

  function retryCode() {
    if (codeTried || !onVerifyRoute()) return;
    if (typeof App === 'undefined' || !App || typeof App.sendSignupCode !== 'function') return;
    var enabled = false;
    try { enabled = !!(typeof Remote !== 'undefined' && Remote.enabled); } catch (e) {}
    if (!enabled) return;
    /* a code request already in flight / cooldown running means it was sent */
    try { if (typeof verifyLeft === 'function' && verifyLeft() > 0) { codeTried = true; return; } } catch (e) {}
    setTimeout(function () {
      try {
        var u = (typeof me === 'function') ? me() : null;
        if (!u || u.emailVerified === true || u.verified === true) return;
        var inp = document.getElementById('vcCode');
        if (!inp) return;
        /* manual=true respects an active cooldown but still fires once the
           earlier connection-related failure cleared */
        var p = App.sendSignupCode(true);
        if (p && typeof p.then === 'function') p.then(function () {
          try { if (typeof verifyLeft === 'function' && verifyLeft() > 0) codeTried = true; } catch (e) {}
        });
      } catch (e) {}
    }, 500);
  }

  if (!patchGate()) {
    var t = 0;
    var iv = setInterval(function () { if (patchGate() || ++t > 30) clearInterval(iv); }, 200);
  } else {
    /* the gate function may be replaced by a later module — re-assert it */
    setTimeout(patchGate, 3000);
  }

  setInterval(function () {
    retryCode();
    if (!onVerifyRoute()) codeTried = false;
  }, 1800);
  window.addEventListener('hashchange', function () { codeTried = false; setTimeout(retryCode, 1200); });
})();
