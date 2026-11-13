/* =========================================================================
   WhaleChat view mode — Desktop (default) / Mobile
   Desktop mode on a phone narrows the visual viewport to a desktop width so
   the app's real desktop layout (sidebar + wide content) is used. Mobile mode
   keeps the native responsive layout and, on a desktop screen, frames the app
   in a centred phone-width column.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  const V = window.WC_VIEW = window.WC_VIEW || {};
  const KEY = 'wc.viewMode';
  V.mode = 'desktop';

  function stored() {
    try { return localStorage.getItem(KEY) === 'mobile' ? 'mobile' : 'desktop'; }
    catch (e) { return 'desktop'; }
  }
  function viewport() { return document.querySelector('meta[name="viewport"]'); }
  function content(mode) {
    const screenW = (window.screen && Number(window.screen.width)) || window.innerWidth;
    if (mode === 'desktop' && (isHandheld() || screenW < 1024)) {
      return 'width=1280, user-scalable=yes, viewport-fit=cover';
    }
    return 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover';
  }

  function updateButtons() {
    const target = V.mode === 'desktop' ? 'mobile' : 'desktop';
    const icon = V.mode === 'desktop' ? 'smartphone' : 'monitor';
    document.querySelectorAll('[data-view-toggle]').forEach((btn) => {
      const label = btn.querySelector('[data-view-label]');
      const iconEl = btn.querySelector('[data-view-icon]');
      if (typeof ic === 'function') {
        if (iconEl) iconEl.innerHTML = ic(icon, 18);
        else if (!label) btn.innerHTML = ic(icon, 18);
      }
      if (label) label.textContent = 'Switch to ' + target + ' view';
      btn.setAttribute('title', 'Switch to ' + target + ' view');
      btn.setAttribute('aria-label', 'Switch to ' + target + ' view');
    });
    document.querySelectorAll('[data-view-mode-label]').forEach((el) => { el.textContent = V.mode; });
  }

  function isHandheld() {
    try { return /Mobi|Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || ''); }
    catch (e) { return false; }
  }

  function apply(mode, opts) {
    mode = mode === 'mobile' ? 'mobile' : 'desktop';
    V.mode = mode;
    try { localStorage.setItem(KEY, mode); } catch (e) {}
    document.documentElement.setAttribute('data-wc-view', mode);
    const meta = viewport();
    if (meta) meta.setAttribute('content', content(mode));
    updateButtons();
    if (!opts || !opts.silent) {
      /* phones need a reload for the viewport width switch to fully apply */
      if (isHandheld()) {
        setTimeout(function () { try { location.reload(); } catch (e) {} }, 60);
        return;
      }
      /* let the viewport/layout settle, then make charts recalculate widths */
      setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 80);
      setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 420);
    }
  }

  V.apply = apply;
  V.set = function (mode) { apply(mode); };
  V.toggle = function () { apply(V.mode === 'desktop' ? 'mobile' : 'desktop'); };

  if (typeof App !== 'undefined') {
    App.viewToggle = function () { V.toggle(); };
    App.viewModeDesktop = function () { apply('desktop'); if (typeof render === 'function') { try { render(); } catch (e) {} } };
    App.viewModeMobile = function () { apply('mobile'); if (typeof render === 'function') { try { render(); } catch (e) {} } };
  }

  /* a clear Desktop / Mobile choice in Settings → Preferences */
  try {
    if (typeof VIEWS !== 'undefined' && VIEWS.settings && !VIEWS.__wcViewPatched) {
      const base = VIEWS.settings;
      VIEWS.settings = function () {
        let html = base.apply(this, arguments);
        const mode = V.mode;
        const block = `<div class="divider"></div>
        <div class="between"><div><div class="small" style="font-weight:600">View mode</div>
          <div class="tiny muted mt6">Currently <b data-view-mode-label>${mode}</b> · desktop uses the wide layout, mobile uses the phone layout</div></div>
          <div class="row" style="gap:6px">
            <button class="btn btn-xs ${mode === 'desktop' ? 'btn-primary' : 'btn-ghost'}" data-act="view-mode-desktop">Desktop</button>
            <button class="btn btn-xs ${mode === 'mobile' ? 'btn-primary' : 'btn-ghost'}" data-act="view-mode-mobile">Mobile</button>
          </div></div>`;
        const anchor = '<div class="divider"></div>\n        <div class="between"><div><div class="small" style="font-weight:600">Enable device alerts</div>';
        return html.indexOf(anchor) >= 0 ? html.replace(anchor, block + anchor) : html;
      };
      VIEWS.__wcViewPatched = true;
    }
  } catch (e) {}

  (function styles() {
    if (document.getElementById('wc-view-style')) return;
    const st = document.createElement('style');
    st.id = 'wc-view-style';
    st.textContent = `
    /* fallback desktop layout when a phone ignores the width=1280 viewport */
    @media(max-width:1023px){
      html[data-wc-view="desktop"] body{min-width:1180px}
      html[data-wc-view="desktop"] .sidebar{display:flex!important}
      html[data-wc-view="desktop"] .bottomnav{display:none!important}
      html[data-wc-view="desktop"] .content{padding:22px 24px 60px!important}
      html[data-wc-view="desktop"] .topbar .brand{display:flex!important}
      html[data-wc-view="desktop"] .topbar-search{display:flex!important}
      html[data-wc-view="desktop"] .topbar .hide-desktop{display:none!important}
      html[data-wc-view="desktop"] .main.chat-mode .topbar{display:flex!important}
    }
    /* mobile mode on a desktop screen: centred phone frame + bottom navigation */
    @media(min-width:1024px){
      html[data-wc-view="mobile"] body{background:#020b12}
      html[data-wc-view="mobile"] .shell{max-width:480px;width:100%;margin:0 auto;height:100dvh;
        border-left:1px solid var(--border);border-right:1px solid var(--border);
        box-shadow:0 0 80px -20px rgba(0,0,0,.9)}
      html[data-wc-view="mobile"] .sidebar{display:none!important}
      html[data-wc-view="mobile"] .bottomnav{display:flex!important;position:fixed;left:50%;right:auto;bottom:0;
        transform:translateX(-50%);width:min(100vw,480px);height:calc(var(--nav-h) + env(safe-area-inset-bottom));
        padding-bottom:env(safe-area-inset-bottom);z-index:40;background:rgba(6,20,31,.92);backdrop-filter:blur(20px);
        border-top:1px solid var(--border);align-items:center;justify-content:space-around}
      html[data-theme="light"][data-wc-view="mobile"] .bottomnav{background:rgba(255,255,255,.94)}
      html[data-wc-view="mobile"] .content{padding:16px 14px calc(var(--nav-h) + 104px)!important}
      html[data-wc-view="mobile"] .topbar .brand{display:flex!important}
      html[data-wc-view="mobile"] .topbar-search{display:none!important}
      html[data-wc-view="mobile"] .topbar .hide-desktop{display:flex!important}
      html[data-wc-view="mobile"] .main.chat-mode .bottomnav{display:none!important}
    }`;
    document.head.appendChild(st);
  })();

  /* keep dynamically re-rendered topbars/sidebars in sync */
  setInterval(updateButtons, 1200);
  apply(stored(), { silent: true });
  setTimeout(updateButtons, 300);
})();
