/* =========================================================================
   WhaleChat email notifications  (wc-email-notify)

   - Adds Settings → Preferences → Email notifications (on by default).
   - Sends a Brevo email through /api/notify-email when an account receives a
     chat or order notification, so alerts reach users outside the app.
   - Per-recipient throttling keeps a busy conversation from flooding inboxes.
   ========================================================================= */
'use strict';

  var PAGES_MAIL_ORIGIN = 'https://whalechat.pages.dev';
  function mailBase() { try { return /\.pages\.dev$/i.test(location.hostname) ? '' : PAGES_MAIL_ORIGIN; } catch (e) { return PAGES_MAIL_ORIGIN; } }
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcEmailNotify) return;
  window.__wcEmailNotify = true;

  var lastSent = {};                 /* userId -> ms */
  var MIN_GAP = 120000;

  function enabled(u) {
    return !!(u && u.email && u.settings && u.settings.emailNotifications !== false);
  }

  function shouldSend(userId, icon) {
    try {
      if (!userId || userId === 'usr_admin' || userId === 'all') return false;
      var u = (typeof findUser === 'function') ? findUser(userId) : null;
      if (!u || !enabled(u)) return false;
      if (u.banned) return false;
      if (/@whalechat\.app$/i.test(u.email)) return false;
      if (icon === 'gift' || icon === 'shield') return false;   /* account mail handles those */
      var now = Date.now();
      if (lastSent[userId] && now - lastSent[userId] < MIN_GAP) return false;
      return true;
    } catch (e) { return false; }
  }

  function postMail(userId, title, body, link, icon) {
    try {
      lastSent[userId] = Date.now();
      fetch(mailBase() + '/api/notify-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: userId, title: title, body: body, link: link, icon: icon }),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  function patchNotify() {
    if (typeof window.notify !== 'function' || window.notify.__wcEmail) return false;
    var orig = window.notify;
    var wrapped = function (userId, title, body, link, icon) {
      var out = orig.apply(this, arguments);
      try {
        var mine = (typeof me === 'function') ? me() : null;
        if (!mine || mine.id !== userId) {
          if (shouldSend(userId, String(icon || ''))) postMail(userId, title, body, link, icon);
        }
      } catch (e) {}
      return out;
    };
    wrapped.__wcEmail = true;
    window.notify = wrapped;
    return true;
  }

  function patchSettings() {
    if (typeof VIEWS === 'undefined' || !VIEWS || !VIEWS.settings || VIEWS.settings.__wcEmail) return false;
    var orig = VIEWS.settings;
    var wrapped = function () {
      var html = orig.apply(this, arguments);
      try {
        var u = (typeof me === 'function') ? me() : null;
        var on = !!(u && u.settings && u.settings.emailNotifications !== false);
        var row = '<div class="divider"></div>' +
          '<div class="between"><div><div class="small" style="font-weight:600">Email notifications</div>' +
          '<div class="tiny muted mt6">Chats, orders and wallet alerts by email</div></div>' +
          '<div class="switch ' + (on ? 'on' : '') + '" data-act="toggle-email-notif"></div></div>';
        var needle = /(<div class="between mt16">[\s\S]*?data-act="toggle-notif"><\/div><\/div>)/;
        if (needle.test(html)) html = html.replace(needle, '$1' + row);
      } catch (e) {}
      return html;
    };
    wrapped.__wcEmail = true;
    VIEWS.settings = wrapped;
    return true;
  }

  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-act="toggle-email-notif"]') : null;
    if (!el) return;
    ev.preventDefault();
    var u = (typeof me === 'function') ? me() : null;
    if (!u) return;
    u.settings = u.settings || {};
    u.settings.emailNotifications = !(u.settings.emailNotifications !== false);
    try { if (typeof persist === 'function') persist(true); } catch (e) {}
    try { if (typeof sync === 'function') sync(); } catch (e) {}
    try { if (typeof render === 'function') render(); } catch (e) {}
    if (typeof toast === 'function') toast(u.settings.emailNotifications ? 'Email notifications on' : 'Email notifications off', 'ok');
  }, true);

  var t = 0;
  var iv = setInterval(function () {
    var a = patchNotify();
    var b = patchSettings();
    if ((a && b) || ++t > 60) clearInterval(iv);
  }, 400);
  patchNotify(); patchSettings();
})();
