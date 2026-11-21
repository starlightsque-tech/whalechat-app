/* =========================================================================
   WhaleChat mobile keyboard room  (wc-keyboard)

   On phones the on-screen keyboard overlays the page instead of resizing it
   (iOS Safari, many Android WebViews). The chat composer then sits behind the
   keyboard and the last messages disappear exactly while the user is typing.

   Fix: track visualViewport, publish the real visible height, and size the
   chat screen to it. The message list keeps its own scroll area above the
   composer, so the newest messages stay visible with the keyboard open.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcKeyboard) return;
  window.__wcKeyboard = true;

  var vv = window.visualViewport;
  var root = document.documentElement;
  var MIN = 320;

  var style = document.createElement('style');
  style.id = 'wc-keyboard-style';
  style.textContent = [
    ':root{--wc-vvh:100dvh;--wc-kb:0px}',
    'body.wc-kb-open .main.chat-mode .content{height:var(--wc-vvh)!important;max-height:var(--wc-vvh)!important}',
    'body.wc-kb-open .chat-room{height:var(--wc-vvh)!important;max-height:var(--wc-vvh)!important}',
    'body.wc-kb-open .chat-input{padding-bottom:calc(8px + env(safe-area-inset-bottom))}',
    'body.wc-kb-open .chat-body{scroll-padding-bottom:12px}',
    '@media(max-width:1023px){.chat-input textarea{max-height:96px}}',
    /* keep the app frame from being pushed under the keyboard */
    'body.wc-kb-open{overflow:hidden}'
  ].join('\n');
  if (!document.getElementById('wc-keyboard-style')) document.head.appendChild(style);

  function apply() {
    var h = vv ? Math.round(vv.height) : window.innerHeight;
    if (!h || h < MIN) h = window.innerHeight || MIN;
    root.style.setProperty('--wc-vvh', h + 'px');
    var open = vv ? (window.innerHeight - vv.height > 120) : false;
    document.body.classList.toggle('wc-kb-open', !!open);
    root.style.setProperty('--wc-kb', open ? Math.max(0, Math.round(window.innerHeight - vv.height)) + 'px' : '0px');
  }

  function stickToBottom() {
    var b = document.getElementById('chatBody');
    if (!b) return;
    var near = b.scrollHeight - b.scrollTop - b.clientHeight < 220;
    if (near) b.scrollTop = b.scrollHeight;
  }

  function onFocus(e) {
    var t = e && e.target;
    if (!t || !/^(INPUT|TEXTAREA)$/.test(t.tagName || '')) return;
    if (!t.closest || !t.closest('.chat-room')) return;
    apply();
    setTimeout(function () { apply(); stickToBottom(); }, 60);
    setTimeout(function () { apply(); stickToBottom(); }, 280);
  }

  window.addEventListener('focusin', onFocus, true);
  window.addEventListener('orientationchange', function () { setTimeout(apply, 120); });
  window.addEventListener('resize', function () { apply(); stickToBottom(); });
  if (vv) {
    vv.addEventListener('resize', function () { apply(); stickToBottom(); });
    vv.addEventListener('scroll', function () { apply(); });
  }

  /* the chat body re-renders on every message — keep the bottom pinned while
     the keyboard is open and the composer is focused */
  if (typeof MutationObserver === 'function') {
    var mo = new MutationObserver(function () {
      var input = document.getElementById('msgInput');
      if (input && document.activeElement === input) stickToBottom();
    });
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
  }

  apply();
})();
