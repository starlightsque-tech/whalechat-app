/* =========================================================================
   WhaleChat · core bridge  (wc-core-bridge)  ·  3.74.0
   -------------------------------------------------------------------------
   The app core declares its state with `const`/`let` (App, DB, Remote, VIEWS,
   AFTER, INV, LT …). Those bindings live in the global lexical environment,
   NOT on `window`, so add-on modules that looked them up as `window.App`
   silently did nothing.

   This bridge (loaded before every other add-on) exposes the live values as
   window properties. Mutable ones (DB, SESSION, ACTIVE_CHAT) are accessors, so
   a module always reads the CURRENT value — a reassignment during a sync or a
   route change is picked up instead of a stale snapshot.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcCoreBridge) return;
  window.__wcCoreBridge = true;

  function value(name, getter, setter) {
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: getter,
        set: setter || function () {}
      });
    } catch (e) {
      try { window[name] = getter(); } catch (e2) {}
    }
  }
  function read(name) {
    try {
      /* eslint-disable no-eval */
      return (0, eval)(name);
    } catch (e) { return undefined; }
  }

  /* mutable core state: always current */
  value('DB', function () { return read('DB'); }, function (v) { try { DB = v; } catch (e) {} });
  value('SESSION', function () { return read('SESSION'); }, function (v) { try { SESSION = v; } catch (e) {} });
  value('ACTIVE_CHAT', function () { return read('ACTIVE_CHAT'); }, function (v) { try { ACTIVE_CHAT = v; } catch (e) {} });
  value('EDITING', function () { return read('EDITING'); }, function (v) { try { EDITING = v; } catch (e) {} });
  value('DB_READY', function () { return read('DB_READY'); });

  /* stable objects the add-ons patch or read */
  ['App', 'VIEWS', 'AFTER', 'Remote', 'INV', 'LT', 'COMPOSE', 'TYPING', 'Presence', 'Media', 'WC_SERVERS', 'ADMIN_NAV', 'NOTIFY', 'CHATS'].forEach(function (name) {
    var ref = read(name);
    if (ref !== undefined) {
      try { window[name] = ref; } catch (e) {}
    } else {
      value(name, function () { return read(name); }, function () {});
    }
  });
})();
