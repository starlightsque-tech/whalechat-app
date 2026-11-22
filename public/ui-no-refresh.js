/* =========================================================================
   WhaleChat quiet updates  (wc-quiet-ui)

   Timers and sync events must never interrupt what the user is doing.
   This module provides:
     · WC_QUIET.busy()    – true while the user is scrolling, typing, tapping,
                            dragging a chart or has a dialog open
     · WC_QUIET.render()  – a background render that waits for a quiet moment,
                            and keeps the scroll position and the focused field
     · scroll/focus preservation for every render, so a sync never throws the
       user back to the top of a page or out of the field they were typing in
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcQuietUi) return;
  window.__wcQuietUi = true;

  var BUSY_MS = 1500;
  var lastInput = 0;

  ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'wheel', 'scroll', 'keydown', 'input', 'touchmove']
    .forEach(function (ev) {
      try { window.addEventListener(ev, function () { lastInput = Date.now(); }, { passive: true, capture: true }); } catch (e) {}
    });

  function scroller() {
    return document.querySelector('.content') || document.scrollingElement || document.documentElement;
  }

  function busy() {
    try {
      if (Date.now() - lastInput < BUSY_MS) return true;
      var a = document.activeElement;
      if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return true;
      if (document.querySelector('.modal-back, .modal, [role="dialog"], .story-view')) return true;
      /* a chart the user is dragging / a sheet in motion */
      if (document.body.classList.contains('dragging') || document.body.classList.contains('modal-open')) return true;
    } catch (e) {}
    return false;
  }

  function snapshot() {
    var snap = { top: 0, win: 0, hash: '', focusId: null, selStart: null, selEnd: null };
    try {
      var s = scroller();
      snap.top = s ? s.scrollTop : 0;
      snap.win = window.scrollY || 0;
      snap.hash = String(location.hash || '');
      var a = document.activeElement;
      if (a && a.id && /^(INPUT|TEXTAREA)$/.test(a.tagName)) {
        snap.focusId = a.id;
        snap.selStart = a.selectionStart;
        snap.selEnd = a.selectionEnd;
      }
    } catch (e) {}
    return snap;
  }

  function restore(snap) {
    if (!snap) return;
    try {
      /* never move the user when the page itself changed */
      if (String(location.hash || '') !== snap.hash) return;
      var s = scroller();
      if (s && snap.top != null && Math.abs((s.scrollTop || 0) - snap.top) > 2) s.scrollTop = snap.top;
      if (snap.win && Math.abs((window.scrollY || 0) - snap.win) > 2) window.scrollTo(0, snap.win);
      if (snap.focusId) {
        var el = document.getElementById(snap.focusId);
        if (el && document.activeElement !== el) {
          el.focus({ preventScroll: true });
          try { if (snap.selStart != null) el.setSelectionRange(snap.selStart, snap.selEnd); } catch (e) {}
        }
      }
    } catch (e) {}
  }

  function afterPaint(fn) {
    try {
      if (window.requestAnimationFrame) requestAnimationFrame(function () { fn(); setTimeout(fn, 70); });
      else setTimeout(fn, 40);
    } catch (e) { fn(); }
  }

  var pending = null;
  /* a background render: waits for the user to be idle, then repaints in place */
  function quietRender() {
    if (typeof render !== 'function') return false;
    if (busy()) {
      if (!pending) pending = setTimeout(function () { pending = null; quietRender(); }, 900);
      return false;
    }
    var snap = snapshot();
    try { render(); } catch (e) {}
    afterPaint(function () { restore(snap); });
    return true;
  }

  /* every other render keeps the user's place too */
  try {
    if (typeof render === 'function' && !render.__wcQuietWrapped) {
      var orig = render;
      var wrapped = function () {
        var snap = snapshot();
        var out = orig.apply(this, arguments);
        afterPaint(function () { restore(snap); });
        return out;
      };
      wrapped.__wcQuietWrapped = true;
      window.render = wrapped;
    }
  } catch (e) {}

  window.WC_QUIET = {
    busy: busy,
    render: quietRender,
    snapshot: snapshot,
    restore: restore,
    /* for code that wants a one-off quiet check */
    idle: function () { return !busy(); }
  };
})();
