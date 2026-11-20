/* =========================================================================
   WhaleChat · admin change watcher  (wc-admin-watch)  ·  3.79.0
   -------------------------------------------------------------------------
   Admin pages no longer auto-repaint (see wc-quiet-render). That keeps the
   page, scroll position and form the admin is working on perfectly still.
   New deposit/withdrawal requests still need to reach the admin, so this
   module watches them and shows a small fixed banner — no repaint, no scroll,
   no layout shift. The admin taps Review when they are ready.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcAdminWatch) return;
  window.__wcAdminWatch = true;

  var seen = null;
  var dismissedAt = 0;

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function meUser() { return safe(function () { var f = window.me; return typeof f === 'function' ? f() : null; }, null); }
  function isAdmin() { var u = meUser(); return !!(u && u.role === 'admin'); }
  function db() { return safe(function () { return window.DB || null; }, null); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  function counts() {
    var d = db();
    if (!d) return { dep: 0, wd: 0, depIds: '', wdIds: '' };
    var deps = (d.deposits || []).filter(function (x) { return x && x.status === 'pending'; });
    var wds = (d.withdrawals || []).filter(function (x) { return x && x.status === 'pending'; });
    return {
      dep: deps.length,
      wd: wds.length,
      depIds: deps.map(function (x) { return x.id; }).sort().join(','),
      wdIds: wds.map(function (x) { return x.id; }).sort().join(',')
    };
  }

  function ensureCss() {
    if (document.getElementById('wc-admin-watch-css')) return;
    var st = document.createElement('style');
    st.id = 'wc-admin-watch-css';
    st.textContent =
      '.wc-aw{position:fixed;right:18px;bottom:18px;z-index:9998;max-width:340px;padding:12px 14px;border-radius:14px;' +
      'background:#0b1f2b;color:#e9f4f9;border:1px solid rgba(46,230,201,.42);box-shadow:0 18px 50px rgba(0,0,0,.42);' +
      'display:flex;gap:12px;align-items:center;font-size:12.5px;line-height:1.45}' +
      'html[data-theme="light"] .wc-aw{background:#ffffff;color:#0b2230;border-color:rgba(10,156,120,.45)}' +
      '.wc-aw b{display:block;font-size:13px;margin-bottom:2px}.wc-aw .wc-aw-actions{display:flex;gap:6px;flex:none}' +
      '.wc-aw button{font:inherit;font-weight:800;border-radius:9px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:inherit;padding:7px 10px;cursor:pointer}' +
      'html[data-theme="light"] .wc-aw button{border-color:rgba(11,34,48,.18);background:rgba(11,34,48,.05)}' +
      '.wc-aw .wc-aw-go{background:#2ee6c9;color:#03221d;border-color:transparent}' +
      '@media(max-width:560px){.wc-aw{left:12px;right:12px;bottom:12px;max-width:none}}';
    document.head.appendChild(st);
  }

  function banner(text, onGo) {
    ensureCss();
    var el = document.getElementById('wcAdminWatch');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wcAdminWatch';
      el.className = 'wc-aw';
      document.body.appendChild(el);
    }
    el.innerHTML = '<div style="flex:1;min-width:0"><b>New request' + (text.count === 1 ? '' : 's') + '</b>' + esc(text.msg) + '</div>' +
      '<div class="wc-aw-actions"><button type="button" class="wc-aw-go">Review</button><button type="button" data-wc-aw-close>Later</button></div>';
    el.querySelector('.wc-aw-go').onclick = function () { hide(); onGo(); };
    el.querySelector('[data-wc-aw-close]').onclick = function () { dismissedAt = Date.now(); hide(); };
  }

  function hide() {
    var el = document.getElementById('wcAdminWatch');
    if (el) el.remove();
  }

  function check(first) {
    if (!isAdmin()) { hide(); return; }
    var now = counts();
    if (first || seen === null) { seen = now; return; }
    if (Date.now() - dismissedAt < 120000) { seen = now; return; }
    var newDep = now.depIds !== seen.depIds && now.dep > seen.dep;
    var newWd = now.wdIds !== seen.wdIds && now.wd > seen.wd;
    if (!newDep && !newWd) { seen = now; return; }
    var bits = [];
    if (newDep) bits.push((now.dep - seen.dep) + ' new deposit request' + ((now.dep - seen.dep) === 1 ? '' : 's'));
    if (newWd) bits.push((now.wd - seen.wd) + ' new withdrawal request' + ((now.wd - seen.wd) === 1 ? '' : 's'));
    var msg = bits.join(' · ') + ' awaiting approval.';
    banner({ msg: msg, count: (now.dep - seen.dep) + (now.wd - seen.wd) }, function () {
      var target = newDep ? '#/admin/deposits' : '#/admin/withdrawals';
      if (location.hash === target) { try { if (typeof render === 'function') render({ force: true }); } catch (e) {} }
      else location.hash = target;
    });
    seen = now;
  }

  setInterval(function () { safe(function () { check(false); }); }, 7000);
  window.addEventListener('hashchange', function () { setTimeout(function () { safe(function () { check(false); }); }, 300); });
  setTimeout(function () { safe(function () { check(true); }); }, 1500);
  setTimeout(function () { safe(function () { check(false); }); }, 9000);
})();
