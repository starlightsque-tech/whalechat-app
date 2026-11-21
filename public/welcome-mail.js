/* =========================================================================
   WhaleChat welcome mail after verification  (wc-welcome-mail)

   The signup notice is queued when the account is created. This module sends
   the *welcome* email only after the 6-digit code is accepted, through the
   same-origin /api/welcome endpoint (Cloudflare Pages Function). If that
   endpoint is not deployed the app simply carries on — verification itself
   never depends on it.
   ========================================================================= */
'use strict';

  var PAGES_MAIL_ORIGIN = 'https://whalechat.pages.dev';
  function mailBase() { try { return /\.pages\.dev$/i.test(location.hostname) ? '' : PAGES_MAIL_ORIGIN; } catch (e) { return PAGES_MAIL_ORIGIN; } }
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcWelcomeMail) return;
  window.__wcWelcomeMail = true;

  function send(u) {
    if (!u || !u.email) return;
    var payload = {
      email: u.email,
      userId: u.id,
      username: u.username || '',
      fullName: u.fullName || '',
      referralCode: u.referralCode || ''
    };
    try {
      fetch(mailBase() + '/api/welcome', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && d.ok) console.log('[welcome] mail sent'); })
        .catch(function () {});
    } catch (e) {}
  }

  function install() {
    if (typeof App === 'undefined' || !App || !App.verifyAccount || App.verifyAccount.__wcWelcome) return false;
    var orig = App.verifyAccount;
    var wrapped = async function () {
      var before = false;
      try { before = !!(me() && (me().emailVerified === true || me().verified === true)); } catch (e) {}
      var out = await orig.apply(this, arguments);
      try {
        var u = me();
        if (u && !before && (u.emailVerified === true || u.verified === true)) send(u);
      } catch (e) {}
      return out;
    };
    wrapped.__wcWelcome = true;
    App.verifyAccount = wrapped;
    return true;
  }

  if (!install()) {
    var tries = 0;
    var t = setInterval(function () { if (install() || ++tries > 40) clearInterval(t); }, 400);
  }
})();
