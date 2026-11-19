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
  V.mode = 'mobile';

  function stored() {
    try {
      const v = localStorage.getItem(KEY);
      if (v === 'mobile' || v === 'desktop' || v === 'auto') return v;
      return 'desktop';
    } catch (e) { return 'desktop'; }
  }
  function resolved(mode) {
    if (mode === 'mobile' || mode === 'desktop') return mode;
    /* auto: match the device — phones and small tablets get the phone layout,
       desktops get the wide layout. Nothing is scaled off the screen edge. */
    try {
      const w = window.innerWidth || (window.screen && window.screen.width) || 0;
      return (isHandheld() || w < 1024) ? 'mobile' : 'desktop';
    } catch (e) { return 'mobile'; }
  }
  function viewport() { return document.querySelector('meta[name="viewport"]'); }
  function content() {
    /* always the real device width: text and buttons can never sit under the
       screen edge, in mobile or desktop mode, online or offline */
    return 'width=device-width, initial-scale=1, viewport-fit=cover';
  }

  function updateButtons() {
    const effective = resolved(V.mode);
    const target = V.mode === 'auto' ? 'desktop' : (effective === 'desktop' ? 'mobile' : 'desktop');
    const icon = effective === 'desktop' ? 'smartphone' : 'monitor';
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
    document.querySelectorAll('[data-view-mode-label]').forEach((el) => { el.textContent = V.mode === 'auto' ? ('auto · ' + effective) : V.mode; });
  }

  function isHandheld() {
    try { return /Mobi|Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || ''); }
    catch (e) { return false; }
  }

  function apply(mode, opts) {
    mode = (mode === 'mobile' || mode === 'desktop' || mode === 'auto') ? mode : 'auto';
    V.mode = mode;
    const effective = resolved(mode);
    try { localStorage.setItem(KEY, mode); } catch (e) {}
    document.documentElement.setAttribute('data-wc-view', effective);
    document.documentElement.setAttribute('data-wc-view-pref', mode);
    const meta = viewport();
    if (meta) meta.setAttribute('content', content());
    /* the reference look: phone layout on a dark canvas, desktop on white */
    try {
      document.documentElement.setAttribute('data-theme', effective === 'mobile' ? 'dark' : 'light');
      document.documentElement.setAttribute('data-wc-view-theme', effective === 'mobile' ? 'dark' : 'light');
    } catch (e) {}
    updateButtons();
    if (!opts || !opts.silent) {
      /* no reload needed — the viewport is the device width in every mode */
      if (isHandheld()) {
        setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 80);
        return;
      }
      /* let the viewport/layout settle, then make charts recalculate widths */
      setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 80);
      setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 420);
    }
  }

  V.apply = apply;
  V.set = function (mode) { apply(mode); };
  V.toggle = function () { apply(resolved(V.mode) === 'desktop' ? 'mobile' : 'desktop'); };

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
        <div><div class="small" style="font-weight:700">View mode</div>
          <div class="tiny muted mt6">Currently <b data-view-mode-label>${mode}</b> · your choice is remembered on this device</div></div>
        <div class="wc-view-picks">
          <button type="button" class="wc-view-pick ${mode === 'mobile' ? 'on' : ''}" data-act="view-mode-mobile">
            <span class="wc-vp-ic">${typeof ic === 'function' ? ic('smartphone', 16) : ''}</span>
            <span class="wc-vp-t"><b>Mobile view</b><small>Phone layout · dark screen</small></span>
            <span class="wc-vp-check">${mode === 'mobile' ? '✓' : ''}</span></button>
          <button type="button" class="wc-view-pick ${mode === 'auto' ? 'on' : ''}" data-act="view-mode-auto">
            <span class="wc-vp-ic">${typeof ic === 'function' ? ic('refresh', 16) : ''}</span>
            <span class="wc-vp-t"><b>Auto</b><small>Match this device automatically</small></span>
            <span class="wc-vp-check">${mode === 'auto' ? '✓' : ''}</span></button>
          <button type="button" class="wc-view-pick ${mode === 'desktop' ? 'on' : ''}" data-act="view-mode-desktop">
            <span class="wc-vp-ic">${typeof ic === 'function' ? ic('monitor', 16) : ''}</span>
            <span class="wc-vp-t"><b>Desktop view</b><small>Wide layout · white screen</small></span>
            <span class="wc-vp-check">${mode === 'desktop' ? '✓' : ''}</span></button>
        </div>`;
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
    .wc-view-picks{display:flex;flex-direction:column;gap:8px;margin-top:12px}
    .wc-view-pick{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:11px 12px;border-radius:14px;
      border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;min-height:52px}
    .wc-view-pick.on{border-color:rgba(46,230,201,.65);background:rgba(46,230,201,.10);box-shadow:0 0 0 1px rgba(46,230,201,.25) inset}
    .wc-vp-ic{width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;
      background:rgba(46,230,201,.12);color:var(--accent);flex:0 0 auto}
    .wc-vp-t{display:flex;flex-direction:column;min-width:0;flex:1}
    .wc-vp-t b{font-size:12.5px;font-weight:800;line-height:1.25}
    .wc-vp-t small{font-size:10.5px;font-weight:600;color:var(--muted);line-height:1.3}
    .wc-vp-check{font-size:14px;font-weight:800;color:var(--accent);width:16px;text-align:center}
    /* desktop layout on a small screen: keep it responsive, never 1180px wide */
    @media(max-width:1023px){
      html[data-wc-view="desktop"] body{min-width:0!important;width:100%!important;overflow-x:hidden}
      html[data-wc-view="desktop"] .sidebar{display:none!important}
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
  if (typeof App !== 'undefined') App.viewModeAuto = function () { apply('auto'); if (typeof render === 'function') { try { render(); } catch (e) {} } };
  apply(stored(), { silent: true });
  setTimeout(updateButtons, 300);
})();
