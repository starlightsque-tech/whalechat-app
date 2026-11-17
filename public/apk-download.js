/* =========================================================================
   WhaleChat admin: Android APK download button.
   Adds a "Download Android APK" bar at the top of every admin page.
   Download order:
     1. /whalechat.apk served by this app (public/whalechat.apk)
     2. Latest GitHub Release asset (published by the build Action)
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcApkDownload) return;
  window.__wcApkDownload = true;

  var APK_URL = '/whalechat.apk';
  var RELEASE_URL = 'https://github.com/starlightsque-tech/whalechat-app/releases/download/apk-latest/whalechat.apk';
  var BAR_ID = 'wc-apk-bar';

  function isAdmin() {
    try { var u = me(); return !!(u && u.role === 'admin'); } catch (e) { return false; }
  }
  function note(msg) {
    var el = document.getElementById('wc-apk-note');
    if (el) el.textContent = msg;
  }
  function trigger(url) {
    var a = document.createElement('a');
    a.href = url; a.download = 'WhaleChat.apk'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function isApkResponse(r) {
    var type = (r.headers.get('content-type') || '').toLowerCase();
    return r.ok && type.indexOf('text/html') === -1;
  }
  function inject() {
    if (!/^#\/admin/.test(location.hash || '')) return;
    if (!isAdmin()) return;
    var nav = document.querySelector('.admin-nav');
    if (!nav || document.getElementById(BAR_ID)) return;
    var bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.className = 'card';
    bar.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px;padding:12px 14px';
    bar.innerHTML =
      '<div style="flex:1;min-width:180px"><b>WhaleChat Android app</b>' +
      '<div class="tiny muted" id="wc-apk-note">Signed APK (Amazon Appstore DRM enabled)</div></div>' +
      '<a class="btn btn-primary btn-sm" id="wc-apk-btn" href="' + APK_URL + '" download="WhaleChat.apk">Download APK</a>';
    nav.parentNode.insertBefore(bar, nav);
    var btn = document.getElementById('wc-apk-btn');
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      note('Preparing download...');
      fetch(APK_URL, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
        if (isApkResponse(r)) {
          note('Download started.');
          trigger(APK_URL);
        } else {
          // Not on this server (yet): use the latest GitHub Release asset.
          note('Download started from release storage.');
          trigger(RELEASE_URL);
        }
      }).catch(function () {
        note('Download started from release storage.');
        trigger(RELEASE_URL);
      });
    });
  }
  var timer = null;
  function schedule() { if (timer) return; timer = setTimeout(function () { timer = null; try { inject(); } catch (e) {} }, 150); }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', schedule);
  schedule();
})();
