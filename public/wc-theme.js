/* =========================================================================
   WhaleChat · theme switch  (wc-theme)  ·  3.69.0
   -------------------------------------------------------------------------
   The app already ships a full light palette (html[data-theme="light"]) and a
   Dark mode switch in Settings, but the choice never stayed: every render ran
   initTheme(), and view-mode.js forced "phone layout = dark, desktop = light"
   on top of it. Tapping the switch flipped the colours for a moment and the
   next repaint (or the next view-mode pass) put them back.

   This module makes the user's choice authoritative and reachable:

     · a theme button on every page (floating, bottom-right, above the nav)
       plus the existing Settings switch, both flipping dark ⇄ bright;
     · the choice is stored per device AND on the account, so it follows the
       user to another device;
     · it re-asserts itself after initTheme(), after view-mode, and after any
       other module sets data-theme, so nothing can quietly override it;
     · the browser chrome colour (theme-color) follows too.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcTheme) return;
  window.__wcTheme = true;

  var KEY = 'whalechat.theme';          /* the app's own key: initTheme reads it */
  var FORCE_KEY = 'wc.theme.explicit.v1';
  var LIGHT_META = '#f2f7fa';
  var DARK_META = '#04101a';

  var applying = false;

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function g(name) { try { return window[name]; } catch (e) { return undefined; } }
  function root() { return document.documentElement; }
  function current() { return root().getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }

  function stored() {
    var v = safe(function () { return localStorage.getItem(FORCE_KEY); }, null);
    if (v === 'light' || v === 'dark') return v;
    /* an account preference counts as explicit once the user has chosen */
    var u = safe(function () { var m = g('me'); return typeof m === 'function' ? m() : null; }, null);
    var t = safe(function () { return u && u.settings && u.settings.theme; }, null);
    return (t === 'light' || t === 'dark') ? t : null;
  }

  function setMeta(theme) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? LIGHT_META : DARK_META);
  }

  function apply(theme) {
    applying = true;
    try {
      root().setAttribute('data-theme', theme);
      root().setAttribute('data-wc-theme-choice', theme);
      setMeta(theme);
    } finally { applying = false; }
  }

  function persist(theme) {
    safe(function () { localStorage.setItem(KEY, theme); });
    safe(function () { localStorage.setItem(FORCE_KEY, theme); });
    safe(function () {
      var u = safe(function () { var m = g('me'); return typeof m === 'function' ? m() : null; }, null);
      if (!u) return;
      u.settings = u.settings || {};
      u.settings.theme = theme;
      var p = g('persist');
      if (typeof p === 'function') p(true);
    });
  }

  function label(theme) {
    return theme === 'light' ? 'Switch to dark mode' : 'Switch to bright mode';
  }

  function icon(theme) {
    /* the icon shows what tapping will give you */
    if (theme === 'light') {
      return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/></svg>';
  }

  function toggle() {
    var next = current() === 'light' ? 'dark' : 'light';
    apply(next);
    persist(next);
    paintButton();
    /* the app's own toggle keeps its switch in step */
    safe(function () {
      var sw = document.querySelector('[data-act="toggle-theme"]');
      if (sw) sw.classList.toggle('on', next === 'dark');
    });
    /* charts read colours at paint time */
    setTimeout(function () { safe(function () { window.dispatchEvent(new Event('resize')); }); }, 60);
    setTimeout(function () {
      safe(function () { var r = g('render'); if (typeof r === 'function') r({ force: true }); });
      /* the repaint replaced the header button: re-attach immediately so the
         app's own handler cannot fire on the next tap as well */
      ensureButton();
    }, 120);
    safe(function () { if (typeof window.toast === 'function') window.toast(next === 'light' ? 'Bright mode on' : 'Dark mode on', 'ok'); });
    return next;
  }

  /* ------------------------------------------------------------- the button
     The switch lives in the TOP BAR, beside search / notifications / view —
     it is a normal flex child there, so it can never float over a card, a
     button or the bottom navigation. (The old fixed bubble in the bottom-right
     corner covered page content and is gone.) */
  function topbarRow() {
    return document.querySelector('header.topbar .row') || document.querySelector('header.topbar');
  }

  function bindButton(b) {
    if (!b || b.__wcBound) return;
    b.__wcBound = true;
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      toggle();
    }, true);
  }

  function ensureButton() {
    var old = document.getElementById('wcThemeBtn');
    var host = topbarRow();
    if (!host) { if (old && old.parentNode) old.parentNode.removeChild(old); return; }
    var b = null;

    /* reuse the app's own topbar theme control (the moon/sun button) */
    var nativeBtn = host.querySelector('[data-theme-toggle]');
    if (nativeBtn) {
      nativeBtn.classList.remove('hide-desktop');
      nativeBtn.id = 'wcThemeBtn';
      try { nativeBtn.style.position = 'relative'; nativeBtn.style.display = ''; } catch (e) {}
      b = nativeBtn;
    } else if (old && old.parentNode === host) {
      b = old;
    } else {
      if (old && old.parentNode) old.parentNode.removeChild(old);
      b = document.createElement('button');
      b.id = 'wcThemeBtn';
      b.type = 'button';
      b.className = 'btn-icon';
      b.style.cssText = 'position:relative;flex:none;display:flex;align-items:center;justify-content:center;padding:0';
      var profile = host.lastElementChild;
      if (profile) host.insertBefore(b, profile); else host.appendChild(b);
    }
    bindButton(b);
    /* every theme control in the app (sidebar entry included) goes through
       this module, so the choice sticks and nothing double-toggles */
    document.querySelectorAll('[data-theme-toggle]').forEach(bindButton);
    paintButton();
  }

  function paintButton() {
    var t = current();
    var b = document.getElementById('wcThemeBtn');
    if (b) {
      b.innerHTML = icon(t);
      b.setAttribute('aria-label', label(t));
      b.setAttribute('title', label(t));
      b.dataset.theme = t;
    }
    /* the sidebar entry mirrors the same state */
    document.querySelectorAll('aside.sidebar [data-theme-toggle]').forEach(function (n) {
      if (n === b) return;
      var txt = n.querySelector('span:last-child');
      if (txt) txt.textContent = t === 'dark' ? 'Light mode' : 'Dark mode';
    });
  }

  /* --------------------------------------------------------- re-assertion */
  function reassert() {
    if (applying) return;
    var want = stored();
    if (!want) { paintButton(); return; }
    if (current() !== want) apply(want);
    paintButton();
  }

  function hookInitTheme() {
    var real = g('initTheme');
    if (typeof real !== 'function' || real.__wcTheme) return false;
    var wrapped = function () {
      var want = stored();
      if (want) { apply(want); }
      else { safe(function () { real.apply(this, arguments); }); }
      paintButton();
      return want || current();
    };
    wrapped.__wcTheme = true;
    try { window.initTheme = wrapped; } catch (e) {}
    return true;
  }

  function boot() {
    var want = stored();
    if (want) apply(want);
    hookInitTheme();
    ensureButton();
    reassert();

    /* nothing may override the explicit choice: view-mode, a chart module or a
       late initTheme all write data-theme, and each write is put back */
    try {
      var mo = new MutationObserver(function () { setTimeout(reassert, 0); });
      mo.observe(root(), { attributes: true, attributeFilter: ['data-theme', 'data-wc-view'] });
    } catch (e) {}

    /* the settings switch in the app is wired to App.toggleTheme — route it
       through this module so both stay in sync and the choice sticks */
    safe(function () {
      var A = g('App');
      if (A && typeof A.toggleTheme === 'function' && !A.toggleTheme.__wcTheme) {
        A.toggleTheme = function () { return toggle(); };
        A.toggleTheme.__wcTheme = true;
      }
    });

    /* route changes rebuild the DOM: keep the button and the theme */
    window.addEventListener('hashchange', function () { setTimeout(function () { ensureButton(); reassert(); }, 60); });
    setInterval(function () { ensureButton(); paintButton(); }, 900);
    setInterval(reassert, 2500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.WCTheme = {
    get: current,
    set: function (t) { var v = t === 'light' ? 'light' : 'dark'; apply(v); persist(v); paintButton(); return v; },
    toggle: toggle,
    explicit: function () { return stored(); }
  };
})();
