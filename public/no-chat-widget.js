/* =========================================================================
   WhaleChat — remove the floating third-party chat widget
   (wc-no-chat-widget)

   The Tawk.to bubble was injected on every screen, sat over the account page
   and its iframe intercepted taps. This removes the widget completely; in-app
   support chat is still available from Account → Contact support.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcNoChatWidget) return;
  window.__wcNoChatWidget = true;

  try {
    window.Tawk_API = window.Tawk_API || {};
    window.Tawk_API.hideWidget = function () {};
    window.Tawk_API.onLoad = function () { try { window.Tawk_API.hideWidget(); } catch (e) {} };
  } catch (e) {}

  var css = document.createElement('style');
  css.id = 'wc-no-chat-widget-style';
  css.textContent = [
    'body:not(.wc-livechat-open) iframe[title="Chat widget"],',
    'body:not(.wc-livechat-open) #tawk-bubble-container, body:not(.wc-livechat-open) .tawk-min-container, body:not(.wc-livechat-open) .tawk-max-container,',
    'body:not(.wc-livechat-open) div[id^="tawk"], body:not(.wc-livechat-open) div[class*="tawk-"]{display:none!important;visibility:hidden!important;pointer-events:none!important;width:0!important;height:0!important}'
  ].join('\n');
  if (!document.getElementById('wc-no-chat-widget-style')) document.head.appendChild(css);

  function kill() {
    if (window.__wcLiveChatOpen) return;
    try { if (window.Tawk_API && window.Tawk_API.hideWidget) window.Tawk_API.hideWidget(); } catch (e) {}
    var sel = 'iframe[title="Chat widget"], #tawk-bubble-container, .tawk-min-container, .tawk-max-container, div[id^="tawk"]';
    Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
      try { el.remove(); } catch (e) { try { el.style.display = 'none'; } catch (e2) {} }
    });
    Array.prototype.forEach.call(document.querySelectorAll('script[src*="tawk.to"]'), function (s) {
      try { s.remove(); } catch (e) {}
    });
  }

  kill();
  if (typeof MutationObserver === 'function') {
    var pending = null;
    var mo = new MutationObserver(function () {
      if (pending) return;
      pending = setTimeout(function () { pending = null; kill(); }, 250);
    });
    try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  }
  setInterval(kill, 2500);
})();
