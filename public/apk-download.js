/* =========================================================================
   WhaleChat admin: Android APK download button.
   Adds a "Download Android APK" bar at the top of every admin page.
   The signed APK is hosted at /whalechat.apk (public/whalechat.apk).
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcApkDownload) return;
  window.__wcApkDownload = true;

  var APK_URL = '/whalechat.apk';
  var BAR_ID = 'wc-apk-bar';

  function isAdmin() {
    try { var u = me(); return !!(u && u.role === 'admin'); } catch (e) { return false; }
  }
  function note(msg) {
    var el = document.getElementById('wc-apk-note');
    if (el) el.textContent = msg;
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
      '<div class="tiny muted" id="wc-apk-note">Signed APK for sideloading and store submission</div></div>' +
      '<a class="btn btn-primary btn-sm" id="wc-apk-btn" href="' + APK_URL + '" download="WhaleChat.apk">Download APK</a>';
    nav.parentNode.insertBefore(bar, nav);
    var btn = document.getElementById('wc-apk-btn');
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      note('Checking APK file...');
      fetch(APK_URL, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
        var type = r.headers.get('content-type') || '';
        if (r.ok && type.indexOf('text/html') === -1) {
          note('Starting download...');
          var a = document.createElement('a');
          a.href = APK_URL; a.download = 'WhaleChat.apk';
          document.body.appendChild(a); a.click(); a.remove();
        } else {
          note('APK not available yet. Run the "Build signed Android APK" GitHub Action first.');
        }
      }).catch(function () { note('Could not reach the server. Try again.'); });
    });
  }
  var timer = null;
  function schedule() { if (timer) return; timer = setTimeout(function () { timer = null; try { inject(); } catch (e) {} }, 150); }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', schedule);
  schedule();
})();
