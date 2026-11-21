/* =========================================================================
   WhaleChat smooth UI  (wc-ui-smooth)

   - Background state refreshes no longer rebuild the page while the user is
     typing or a modal is open; the refresh is deferred a moment instead, so
     forms, chat text and scroll positions never jump.
   - Tap targets get instant feedback (no 300ms delay, no highlight flash) and
     the app avoids expensive scroll/overscroll work.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcUiSmooth) return;
  window.__wcUiSmooth = true;

  var style = document.createElement('style');
  style.id = 'wc-ui-smooth-style';
  style.textContent = [
    'html{-webkit-text-size-adjust:100%}',
    'button,.btn,a,[data-act],[data-nav]{touch-action:manipulation;-webkit-tap-highlight-color:transparent}',
    'button:active,.btn:active,[data-act]:active{transform:scale(.985)}',
    '.content{overscroll-behavior-y:contain;-webkit-overflow-scrolling:touch}',
    '.chat-body{overscroll-behavior:contain;-webkit-overflow-scrolling:touch}',
    'img,video,svg{max-width:100%}',
    '@media(prefers-reduced-motion:reduce){*{animation-duration:.001ms!important;transition-duration:.001ms!important}}'
  ].join('\n');
  if (!document.getElementById('wc-ui-smooth-style')) document.head.appendChild(style);

  function busyEditing() {
    try {
      var el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return true;
      var ov = document.getElementById('overlay');
      if (ov && ov.offsetParent !== null && getComputedStyle(ov).display !== 'none') return true;
    } catch (e) {}
    return false;
  }

  var pending = null, pendingSince = 0;
  function schedule(force) {
    var now = Date.now();
    if (!pendingSince) pendingSince = now;
    /* never postpone for more than 8 seconds */
    if (now - pendingSince > 8000) { pendingSince = 0; try { return origRefresh(true); } catch (e) { return Promise.resolve(); } }
    clearTimeout(pending);
    pending = setTimeout(function () {
      pending = null;
      if (busyEditing()) schedule(force);
      else { pendingSince = 0; try { origRefresh(force); } catch (e) {} }
    }, 900);
    return Promise.resolve();
  }

  var origRefresh = null;
  function patchRefresh() {
    if (typeof Remote === 'undefined' || !Remote || typeof Remote.refresh !== 'function' || Remote.refresh.__wcSmooth) return false;
    origRefresh = Remote.refresh;
    var wrapped = function (force) {
      if (!force && busyEditing()) return schedule(force);
      pendingSince = 0;
      return origRefresh.apply(this, arguments);
    };
    wrapped.__wcSmooth = true;
    Remote.refresh = wrapped;
    return true;
  }

  if (!patchRefresh()) {
    var t = 0;
    var iv = setInterval(function () { if (patchRefresh() || ++t > 40) clearInterval(iv); }, 300);
  }

})();
