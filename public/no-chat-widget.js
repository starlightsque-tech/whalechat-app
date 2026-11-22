/* =========================================================================
   WhaleChat — no floating chat bubble  (wc-no-chat-widget)

   The Tawk.to bubble is not shown on app screens: the app has its own
   "Live chat support" buttons. The widget itself is NOT removed here — the
   chat box must open from those buttons. This module only styles the widget:
   hidden (and out of the way of taps) until the user taps a live-chat button,
   which adds `body.wc-livechat-open`.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcNoChatWidget) return;
  window.__wcNoChatWidget = true;

  var css = document.createElement('style');
  css.id = 'wc-no-chat-widget-style';
  css.textContent = [
    /* the floating bubble is never shown — the app has its own buttons */
    '#tawk-bubble-container, .tawk-min-container, .tawk-bubble{display:none!important;visibility:hidden!important;pointer-events:none!important}',
    /* the chat window stays hidden until a live-chat button is tapped */
    'body:not(.wc-livechat-open) #tawkchat-container,',
    'body:not(.wc-livechat-open) .tawk-max-container,',
    'body:not(.wc-livechat-open) iframe[title="Chat widget"]{display:none!important;visibility:hidden!important;pointer-events:none!important;',
    '  width:0!important;height:0!important}',
    /* when opened, it sits above the app and clears the mobile nav */
    'body.wc-livechat-open #tawkchat-container,',
    'body.wc-livechat-open .tawk-max-container{display:block!important;visibility:visible!important;',
    '  z-index:1200!important;bottom:calc(env(safe-area-inset-bottom,0px) + 16px)!important;right:12px!important;',
    '  height:min(78vh,620px)!important;max-height:calc(100dvh - 110px)!important}',
    'body.wc-livechat-open{direction:ltr}'
  ].join('\n');
  if (!document.getElementById('wc-no-chat-widget-style')) document.head.appendChild(css);
})();
