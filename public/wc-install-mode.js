/* =========================================================================
   WhaleChat · installed-app detection + offline access gate (wc-install-mode)
   -------------------------------------------------------------------------
   Offline trading is an INSTALLED-APP feature.

     installed  = display-mode: standalone | fullscreen | minimal-ui
                  OR navigator.standalone (iOS home screen)
                  OR the Capacitor/Android shell (window.__WC_NATIVE)

     · installed + offline  → 100% offline mode (local data, simulator, trades)
     · installed + online   → normal app, live feeds
     · browser  + offline   → offline features LOCKED, with a clear prompt to
                              install WhaleChat on Android / iPhone / desktop
     · browser  + online    → normal app (no offline trading entry point)

   Public API
     WC_MODE.installed / .online / .offlineTrading / .refresh()
     WC_MODE.requireOffline()      → true when offline features may run
     WC_MODE.gate(reason)          → shows the install prompt, returns false
     WC_MODE.onChange(fn)
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_MODE) return;

  var listeners = [];
  var M = {
    installed: false,
    standalone: false,
    iosStandalone: false,
    nativeShell: false,
    online: navigator.onLine !== false,
    displayMode: 'browser',
    installPrompt: null,
    canInstall: false
  };

  function mq() {
    try { return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || window.matchMedia('(display-mode: minimal-ui)').matches; } catch (e) { return false; }
  }

  function detect() {
    M.standalone = mq();
    M.iosStandalone = navigator.standalone === true;
    M.nativeShell = !!(window.__WC_NATIVE || window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    var ref = '';
    try { ref = String(document.referrer || ''); } catch (e) {}
    M.displayMode = M.standalone ? 'standalone' : (M.iosStandalone ? 'ios-standalone' : (M.nativeShell ? 'native' : 'browser'));
    M.installed = !!(M.standalone || M.iosStandalone || M.nativeShell || /android-app:\/\//i.test(ref));
    M.online = navigator.onLine !== false;
    M.offlineTrading = M.installed;
    return M;
  }

  function emit() {
    detect();
    listeners.forEach(function (fn) { try { fn(M); } catch (e) {} });
    try { document.documentElement.setAttribute('data-wc-mode', M.installed ? 'installed' : 'browser'); } catch (e) {}
    try { document.documentElement.setAttribute('data-wc-net', M.online ? 'online' : 'offline'); } catch (e) {}
    paintChip();
  }

  M.onChange = function (fn) { if (typeof fn === 'function') listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; };
  M.refresh = function () { emit(); return M; };
  M.isInstalled = function () { return detect().installed; };
  M.isOnline = function () { return navigator.onLine !== false; };

  M.requireOffline = function () {
    detect();
    if (!M.installed) { M.gate(); return false; }
    return true;
  };

  /* ------------------------------------------------------------- prompts */
  function sheet(html) {
    var old = document.getElementById('wc-install-sheet');
    if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.id = 'wc-install-sheet';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(3,12,20,.78);backdrop-filter:blur(8px);display:flex;align-items:flex-end;justify-content:center;padding:16px;padding-bottom:calc(16px + env(safe-area-inset-bottom))';
    wrap.innerHTML = '<div style="width:100%;max-width:520px;background:#0a1a28;border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:22px 20px;color:#e9f4f9;font-family:inherit">' + html + '</div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
    return wrap;
  }

  function installSteps() {
    var ua = navigator.userAgent || '';
    var ios = /iPhone|iPad|iPod/i.test(ua);
    var android = /Android/i.test(ua);
    if (android) return 'Tap the browser menu <b>⋮</b> → <b>Install app</b> (or “Add to Home screen”).';
    if (ios) return 'Tap <b>Share</b> <span style="opacity:.8">(the square with an arrow)</span> → <b>Add to Home Screen</b>.';
    return 'Click the <b>install icon</b> in the address bar, or open the browser menu → <b>Install WhaleChat</b>.';
  }

  M.gate = function (reason) {
    var re = String(reason || 'Offline trading is only available inside the installed WhaleChat app.');
    var wrap = sheet(
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
        '<div style="width:38px;height:38px;border-radius:11px;background:linear-gradient(145deg,#2ee6c9,#0e7f8f);display:flex;align-items:center;justify-content:center;font-weight:800;color:#03221d">W</div>' +
        '<div><div style="font-weight:800;font-size:16px">Install WhaleChat to trade offline</div>' +
        '<div style="font-size:12px;color:#8ba7b8">Offline mode is an installed-app feature</div></div>' +
      '</div>' +
      '<p style="font-size:13.5px;line-height:1.65;color:#a9bfcd;margin:0 0 12px">' + re + '</p>' +
      '<ol style="font-size:13px;line-height:1.9;color:#cfe3ee;margin:0 0 14px;padding-left:18px">' +
        '<li>' + installSteps() + '</li>' +
        '<li>Open WhaleChat from your home screen / app list.</li>' +
        '<li>Charts, portfolio and trading then work with the network off.</li>' +
      '</ol>' +
      (M.installPrompt ? '<button id="wc-install-go" style="width:100%;border:0;border-radius:12px;padding:13px;background:#2ee6c9;color:#03221d;font-weight:800;font-size:14px">Install app now</button>' : '') +
      '<button id="wc-install-close" style="width:100%;margin-top:8px;border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:12px;background:transparent;color:#cfe3ee;font-weight:700;font-size:13px">Not now</button>' +
      '<div style="margin-top:10px;font-size:11px;color:#63798a;text-align:center">You are in a browser tab — install to unlock offline trading.</div>'
    );
    var close = wrap.querySelector('#wc-install-close');
    if (close) close.addEventListener('click', function () { wrap.remove(); });
    var go = wrap.querySelector('#wc-install-go');
    if (go) go.addEventListener('click', function () { M.promptInstall(); wrap.remove(); });
    return false;
  };

  M.promptInstall = function () {
    if (M.installPrompt) {
      try {
        M.installPrompt.prompt();
        return M.installPrompt.userChoice;
      } catch (e) {}
    }
    M.gate('Your browser has not offered an install prompt yet. Use the steps below to add WhaleChat to your device.');
    return Promise.resolve({ outcome: 'manual' });
  };

  /* ------------------------------------------------------------ status chip */
  function paintChip() {
    try {
      if (!M.installed || M.online) { var old = document.getElementById('wc-offline-chip'); if (old) old.remove(); return; }
      if (document.getElementById('wc-offline-chip')) return;
      var chip = document.createElement('div');
      chip.id = 'wc-offline-chip';
      chip.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(76px + env(safe-area-inset-bottom));z-index:9000;background:#3a2a05;border:1px solid #f5b544;color:#ffd47a;font-size:11.5px;font-weight:800;letter-spacing:.03em;padding:7px 13px;border-radius:999px;box-shadow:0 8px 22px rgba(0,0,0,.4)';
      chip.textContent = 'OFFLINE MODE · simulated prices';
      document.body.appendChild(chip);
    } catch (e) {}
  }

  window.addEventListener('online', function () { emit(); });
  window.addEventListener('offline', function () { emit(); setTimeout(paintChip, 300); });
  try {
    var m = window.matchMedia('(display-mode: standalone)');
    if (m.addEventListener) m.addEventListener('change', emit);
  } catch (e) {}

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    M.installPrompt = e;
    M.canInstall = true;
    try {
      var btn = document.getElementById('wc-install-btn');
      if (btn) btn.style.display = '';
    } catch (err) {}
  });
  window.addEventListener('appinstalled', function () { M.installPrompt = null; M.canInstall = false; emit(); });

  window.WC_MODE = M;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', emit);
  else emit();
})();
