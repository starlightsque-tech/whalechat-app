/* =========================================================================
   WhaleChat live chat on tap  (wc-live-chat)

   Every "Live chat" button opens the installed Tawk.to chat box:
   · the floating bubble is hidden — the app has its own buttons;
   · the widget is loaded once after sign-in, and re-loaded from scratch if the
     iframe is missing (a killed widget, a blocked first load, a stale API);
   · nothing removes the widget any more (that was why the tap did nothing);
   · the button waits for the chat to be really ready, then opens it.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcLiveChat) return;
  window.__wcLiveChat = true;

  var PROPERTY = '6af412c51859cf3c3d81d341';
  var WIDGET = '1k74milq6';
  var loading = false;
  var loadStartedAt = 0;

  try {
    var cfg = (typeof WC_TAWK !== 'undefined' && WC_TAWK.cfg) ? WC_TAWK.cfg() : null;
    if (cfg && cfg.propertyId) PROPERTY = cfg.propertyId;
    if (cfg && cfg.widgetId) WIDGET = cfg.widgetId;
  } catch (e) {}

  function enabled() {
    try { return (typeof WC_TAWK !== 'undefined' && WC_TAWK.enabled) ? WC_TAWK.enabled() : true; } catch (e) { return true; }
  }

  /* the widget is really there only when the API exists AND its iframe is in
     the document — a killed widget leaves a useless API object behind */
  function frame() {
    return document.querySelector('iframe[title="Chat widget"], iframe#tawkchat-iframe, iframe[id^="tawk"], .tawk-max-container iframe');
  }
  function ready() {
    try { return !!(window.Tawk_API && typeof window.Tawk_API.maximize === 'function' && frame()); } catch (e) { return false; }
  }

  function identify() {
    try {
      var u = (typeof me === 'function') ? me() : null;
      if (u && window.Tawk_API) window.Tawk_API.visitor = { name: u.fullName || u.username, email: u.email };
      var o = window.__wcLiveOrder;
      if (o && window.Tawk_API && window.Tawk_API.addEvent) {
        window.Tawk_API.addEvent('order_reference', { ref: o.ref, status: o.status });
        window.__wcLiveOrder = null;
      }
    } catch (e) {}
  }

  function markOpen() {
    try { document.body.classList.add('wc-livechat-open'); } catch (e) {}
  }
  function markClosed() {
    try { document.body.classList.remove('wc-livechat-open'); } catch (e) {}
  }

  /* wipe a dead widget so it can be loaded again cleanly */
  function reset() {
    try {
      Array.prototype.forEach.call(document.querySelectorAll('#wc-livechat-embed, #wc-tawk-embed'), function (s) { s.remove(); });
    } catch (e) {}
    try {
      Array.prototype.forEach.call(document.querySelectorAll('iframe[title="Chat widget"], iframe[id^="tawk"], #tawkchat-container, .tawk-max-container, .tawk-min-container'), function (n) { n.remove(); });
    } catch (e) {}
    try { window.Tawk_API = {}; } catch (e) {}
    loading = false;
  }

  var attempts = 0;
  function load(force) {
    if (!force && (ready() || loading)) return;
    if (force) reset();
    attempts += 1;
    loading = true;
    loadStartedAt = Date.now();
    window.Tawk_API = window.Tawk_API || {};
    window.Tawk_LoadStart = new Date();
    /* the bubble stays hidden; a tap opens the full chat box */
    window.Tawk_API.onLoad = function () {
      loading = false;
      try { identify(); } catch (e) {}
      try {
        if (window.__wcLiveChatOpen) {
          markOpen();
          if (window.Tawk_API.showWidget) window.Tawk_API.showWidget();
          if (window.Tawk_API.maximize) window.Tawk_API.maximize();
        } else if (window.Tawk_API.hideWidget) {
          window.Tawk_API.hideWidget();
        }
      } catch (e) {}
    };
    window.Tawk_API.onChatMinimized = function () { window.__wcLiveChatOpen = false; markClosed(); };
    window.Tawk_API.onChatHidden = function () { window.__wcLiveChatOpen = false; markClosed(); };
    window.Tawk_API.onChatEnded = function () { window.__wcLiveChatOpen = false; markClosed(); };
    var old = document.getElementById('wc-livechat-embed');
    if (old) old.remove();
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://embed.tawk.to/' + PROPERTY + '/' + WIDGET;
    s.charset = 'UTF-8';
    /* the official Tawk snippet asks for the script in CORS mode; if that is
       refused (a proxy or a strict network), the retry loads it as a plain
       script instead */
    if (attempts % 2 === 1) s.setAttribute('crossorigin', '*');
    s.id = 'wc-livechat-embed';
    s.onerror = function () { loading = false; window.__wcLiveChatScriptFailed = Date.now(); };
    document.head.appendChild(s);
  }

  /* preload the widget after sign-in so the first tap is instant */
  /* last resort that still shows the real chat box: Tawk's hosted chat page
     in a full-screen in-app frame (no embed script needed). */
  function openHostedChat() {
    try {
      var old = document.getElementById('wcLiveChatHosted');
      if (old) old.remove();
      var wrap = document.createElement('div');
      wrap.id = 'wcLiveChatHosted';
      wrap.innerHTML =
        '<div class="wclh-bar"><span>Live chat support</span>' +
        '<span class="wclh-actions"><button type="button" id="wcLiveChatSupport" title="Open in-app support">Support</button>' +
        '<button type="button" id="wcLiveChatClose" aria-label="Close">✕</button></span></div>' +
        '<iframe title="WhaleChat live chat" src="https://tawk.to/chat/' + PROPERTY + '/' + WIDGET + '" ' +
        'allow="microphone; camera; clipboard-write" referrerpolicy="no-referrer-when-downgrade"></iframe>';
      document.body.appendChild(wrap);
      document.body.classList.add('wc-livechat-open', 'wc-hosted-open');
      var close = document.getElementById('wcLiveChatClose');
      if (close) close.onclick = function () {
        window.__wcLiveChatOpen = false;
        try { wrap.remove(); } catch (e) {}
        try { document.body.classList.remove('wc-livechat-open', 'wc-hosted-open'); } catch (e) {}
      };
      var help = document.getElementById('wcLiveChatSupport');
      if (help) help.onclick = function () {
        try { wrap.remove(); } catch (e) {}
        try { document.body.classList.remove('wc-livechat-open', 'wc-hosted-open'); } catch (e) {}
        try { if (typeof App !== 'undefined' && App.supportChat) App.supportChat(); } catch (e) {}
      };
      return true;
    } catch (e) { return false; }
  }
  window.WC_LIVE_CHAT_OPEN_HOSTED = openHostedChat;

  function preload() {
    try {
      if (typeof DB === 'undefined' || !DB) { setTimeout(preload, 1200); return; }
      if (!enabled()) return;
      load(false);
    } catch (e) { setTimeout(preload, 1500); }
  }

  function open() {
    if (!enabled()) {
      try { if (typeof toast === 'function') toast('Live chat is currently switched off', 'err'); } catch (e) {}
      return (typeof App !== 'undefined' && App.liveChatHelp) ? App.liveChatHelp(true) : undefined;
    }
    window.__wcLiveChatOpen = true;
    markOpen();
    try { if (typeof closeModal === 'function') closeModal(); } catch (e) {}
    /* a previous tap already had to fall back: open the hosted chat directly */
    if (!ready() && window.__wcHostedTried) { if (openHostedChat()) return; }
    if (!ready()) load(false);
    try { if (typeof toast === 'function') toast('Opening live chat…', 'ok', 1600); } catch (e) {}

    var started = Date.now();
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      try {
        if (ready()) {
          clearInterval(timer);
          identify();
          try { window.Tawk_API.showWidget && window.Tawk_API.showWidget(); } catch (e) {}
          try { window.Tawk_API.maximize(); } catch (e) {}
          return;
        }
        /* a widget that never produced an iframe: reload it from scratch */
        var stuck = loading && Date.now() - loadStartedAt > 7000;
        if (!loading && tries % 6 === 0) load(true);
        else if (stuck) load(true);
        var scriptDead = window.__wcLiveChatScriptFailed && Date.now() - window.__wcLiveChatScriptFailed > 1200;
        if ((scriptDead || Date.now() - started > 6000) && !window.__wcHostedTried) {
          /* the embed script did not produce the chat: show Tawk's hosted chat
             page in the app so the user still gets the live chat box */
          window.__wcHostedTried = true;
          clearInterval(timer);
          if (openHostedChat()) return;
        }
        if (Date.now() - started > 24000) {
          clearInterval(timer);
          window.__wcLiveChatOpen = false;
          markClosed();
          try { if (typeof toast === 'function') toast('Live chat could not load — check your connection', 'err'); } catch (e) {}
          try { if (typeof App !== 'undefined' && App.liveChatHelp) return App.liveChatHelp(true); } catch (e) {}
        }
      } catch (e) {}
    }, 350);
  }

  try {
    App.openLiveChat = open;
    App.liveChatOpen = function () { open(); };
  } catch (e) {}

  (function css() {
    if (document.getElementById('wc-livechat-css')) return;
    var st = document.createElement('style');
    st.id = 'wc-livechat-css';
    st.textContent = [
      '#wcLiveChatHosted{position:fixed;inset:0;z-index:2147483000;background:#0b141b;display:flex;flex-direction:column}',
      '#wcLiveChatHosted .wclh-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;',
      '  padding-top:calc(12px + env(safe-area-inset-top,0px));background:#0f1c24;color:#e9f4f9;font:700 14px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;',
      '  border-bottom:1px solid rgba(255,255,255,.08)}',
      '#wcLiveChatHosted .wclh-bar .wclh-actions{display:flex;align-items:center;gap:8px}',
      '#wcLiveChatHosted .wclh-bar button{min-width:34px;height:34px;padding:0 10px;border-radius:99px;border:1px solid rgba(255,255,255,.18);',
      '  background:rgba(255,255,255,.06);color:#e9f4f9;font:700 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;cursor:pointer}',
      '#wcLiveChatHosted iframe{flex:1;width:100%;border:0;background:#fff}'
    ].join('\n');
    document.head.appendChild(st);
  })();

  window.WC_LIVE_CHAT = { open: open, ready: ready, preload: preload, load: load, reset: reset, hosted: openHostedChat };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(preload, 600); });
  else setTimeout(preload, 600);
})();
