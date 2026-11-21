/* =========================================================================
   WhaleChat live chat on tap  (wc-live-chat)

   The floating third-party bubble is intentionally hidden. This module loads
   the live-chat widget only when the user taps a "Live chat" button, opens the
   conversation full screen, and hides it again when the chat is closed — so the
   app stays clean and the chat box always appears on tap.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcLiveChat) return;
  window.__wcLiveChat = true;

  var PROPERTY = '6af412c51859cf3c3d81d341';
  var WIDGET = '1k74milq6';
  var loading = false;

  try {
    var cfg = (typeof WC_TAWK !== 'undefined' && WC_TAWK.cfg) ? WC_TAWK.cfg() : null;
    if (cfg && cfg.propertyId) PROPERTY = cfg.propertyId;
    if (cfg && cfg.widgetId) WIDGET = cfg.widgetId;
  } catch (e) {}

  function ready() {
    try { return !!(window.Tawk_API && typeof window.Tawk_API.maximize === 'function'); } catch (e) { return false; }
  }

  function identify() {
    try {
      var u = (typeof me === 'function') ? me() : null;
      if (u && window.Tawk_API) window.Tawk_API.visitor = { name: u.fullName || u.username, email: u.email };
    } catch (e) {}
  }

  function load() {
    if (ready() || loading) return;
    loading = true;
    window.Tawk_API = window.Tawk_API || {};
    window.Tawk_API.onChatMinimized = function () { closeWidget(); };
    window.Tawk_API.onChatHidden = function () { closeWidget(); };
    var old = document.getElementById('wc-livechat-embed');
    if (old) old.remove();
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://embed.tawk.to/' + PROPERTY + '/' + WIDGET;
    s.charset = 'UTF-8';
    s.setAttribute('crossorigin', '*');
    s.id = 'wc-livechat-embed';
    document.head.appendChild(s);
  }

  function closeWidget() {
    window.__wcLiveChatOpen = false;
    try { document.body.classList.remove('wc-livechat-open'); } catch (e) {}
    setTimeout(function () {
      try { if (window.Tawk_API && Tawk_API.hideWidget) Tawk_API.hideWidget(); } catch (e) {}
    }, 400);
  }

  function open() {
    window.__wcLiveChatOpen = true;
    try { document.body.classList.add('wc-livechat-open'); } catch (e) {}
    try { if (typeof closeModal === 'function') closeModal(); } catch (e) {}
    load();
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      try {
        if (ready()) {
          clearInterval(timer);
          identify();
          window.Tawk_API.maximize();
        } else if (tries > 45) {
          clearInterval(timer);
          window.__wcLiveChatOpen = false;
          try { document.body.classList.remove('wc-livechat-open'); } catch (e) {}
          try { if (typeof App !== 'undefined' && App.liveChatHelp) return App.liveChatHelp(true); } catch (e) {}
          try { if (typeof toast === 'function') toast('Live chat could not load — check your connection', 'err'); } catch (e) {}
        }
      } catch (e) {}
    }, 300);
  }

  /* override both entry points (older buttons call either name) */
  try {
    App.openLiveChat = open;
    App.liveChatOpen = open;
  } catch (e) {}

  window.WC_LIVE_CHAT = { open: open, ready: ready };
})();
