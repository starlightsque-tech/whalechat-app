/* =========================================================================
   WhaleChat · quiet repaint  (wc-quiet-render)  ·  3.69.0
   -------------------------------------------------------------------------
   The app repaints itself constantly (sync ticks, presence, market feed, the
   solo-render loop, admin pushes). A repaint used to be visible: the page
   jumped to the top, a half-typed message could vanish, a field lost focus,
   an open sheet closed, and a pill announced that something was refreshing.

   This module makes every automatic repaint invisible and non-destructive:

     · never repaint while the user is typing, scrolling or holding a dialog —
       the repaint is deferred until they stop (max 1.2 s), so an activity is
       never interrupted;
     · burst collapses: ten sync events inside 250 ms cause one repaint;
     · the scroll position of the window, the content pane and the chat
       transcript are captured and restored;
     · the focused field keeps focus, caret and selection, and a half-typed
       message is restored if the repaint rebuilt the composer;
     · update / "connected" / "syncing" chrome is suppressed, so the user
       never learns that the app refreshed at all.

   render() itself is untouched: this wraps the global and delegates.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcQuietRender) return;
  window.__wcQuietRender = true;

  var MIN_GAP = 250;        /* at most one repaint per quarter second */
  var MAX_DEFER = 400;      /* never postpone an automatic repaint longer */
  var startedAt = 0;
  var firstDeferredAt = 0;
  var pending = false;
  var pendingForce = false;
  var lastPaint = 0;
  var scrollerMemory = null;
  var realRender = null;   /* the app's own render, captured once */
  var lastHash = '';

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function g(name) { try { return window[name]; } catch (e) { return undefined; } }

  function typingNow() {
    var a = document.activeElement;
    if (!a) return false;
    var tag = String(a.tagName || '').toUpperCase();
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !a.isContentEditable) return false;
    /* a field that holds text the app would have to rebuild counts as busy */
    return true;
  }
  function dialogOpen() {
    return !!document.querySelector('.modal-backdrop:not(.hidden), .sheet-backdrop:not(.hidden), #wcModal, .modal.open');
  }
  function scrollingNow() {
    return Date.now() - (window.__wcLastScrollAt || 0) < 180;
  }
  function busyNow() { return typingNow() || dialogOpen() || scrollingNow(); }
  /* Admin console pages are read-and-edit screens: an automatic repaint is
     never worth losing the reader's place or the field they are editing.
     Only a route change or an action the admin just took repaints them. */
  function adminRoute() {
    return /^#\/admin(\/|$)/i.test(String(location_hash()));
  }
  function location_hash() { return (typeof location !== 'undefined' && location.hash) || ''; }
  var lastUserAction = 0;
  var bootedAt = Date.now();
  ['pointerdown', 'touchstart', 'keydown', 'input', 'change', 'wheel', 'touchmove'].forEach(function (ev) {
    window.addEventListener(ev, function () { lastUserAction = Date.now(); }, { passive: true, capture: true });
  });
  /* App-wide stability rule (3.79): a timer/sync-driven repaint is only
     allowed while the app is still booting or within 5 s of something the
     user actually did. After that, pages stay exactly as they are — reading,
     trading, investing, chatting and admin work are never interrupted by a
     background refresh. Route changes and explicit actions still paint at
     once, and the data modules that tick prices/chat paint in place. */
  function autoRepaintSuppressed() {
    if (Date.now() - bootedAt < 9000) return false;
    var app = document.getElementById('app');
    if (!app || !app.firstElementChild) return false;
    return Date.now() - lastUserAction > 5000;
  }
  function adminBusy() { return autoRepaintSuppressed(); }

  ['scroll', 'wheel', 'touchmove'].forEach(function (ev) {
    window.addEventListener(ev, function () { window.__wcLastScrollAt = Date.now(); }, { passive: true, capture: true });
  });

  function nodeKey(el) {
    var parts = [];
    var cur = el;
    while (cur && cur !== document.body && parts.length < 24) {
      var idx = 0, sib = cur;
      while ((sib = sib.previousElementSibling)) idx++;
      parts.unshift(String(cur.tagName || '') + ':' + idx);
      cur = cur.parentElement;
    }
    return parts.join('/');
  }

  function snapshot() {
    var content = document.getElementById('content');
    var chat = document.getElementById('chatBody');
    var ae = document.activeElement;
    var snap = {
      winY: window.scrollY || window.pageYOffset || 0,
      contentY: content ? content.scrollTop : 0,
      chatY: chat ? chat.scrollTop : 0,
      chatAtEnd: chat ? (chat.scrollHeight - chat.scrollTop - chat.clientHeight) < 60 : false,
      focusId: null, selStart: null, selEnd: null, value: null, tag: null,
      modalCount: document.querySelectorAll('.modal-backdrop:not(.hidden), .modal.open').length,
      nested: []
    };
    /* every scrolled panel inside the app (admin tables, lists, cards), keyed
       by its position in the DOM so a repaint puts the reader back exactly
       where they were — not only the page-level #content pane */
    try {
      var host = document.getElementById('app') || document.body;
      var nodes = host.querySelectorAll('*');
      for (var i = 0; i < nodes.length && i < 4000; i++) {
        var el = nodes[i];
        if (!el || el.scrollTop <= 0) continue;
        if (el.scrollHeight <= el.clientHeight + 2) continue;
        snap.nested.push({ key: nodeKey(el), top: el.scrollTop, left: el.scrollLeft });
      }
    } catch (e) {}
    if (ae && ae.id && /^(INPUT|TEXTAREA)$/.test(String(ae.tagName || '').toUpperCase())) {
      snap.focusId = ae.id;
      snap.tag = ae.tagName;
      snap.value = ae.value;
      snap.selStart = safe(function () { return ae.selectionStart; }, null);
      snap.selEnd = safe(function () { return ae.selectionEnd; }, null);
    }
    return snap;
  }

  function restore(snap) {
    if (!snap) return;
    var content = document.getElementById('content');
    var chat = document.getElementById('chatBody');
    try { if (typeof window.scrollTo === 'function') window.scrollTo(0, snap.winY); } catch (e) {}
    if (content && snap.contentY) content.scrollTop = snap.contentY;
    if (chat) chat.scrollTop = snap.chatAtEnd ? chat.scrollHeight : snap.chatY;
    if (snap.nested && snap.nested.length) {
      try {
        var host = document.getElementById('app') || document.body;
        var nodes = host.querySelectorAll('*');
        var want = {};
        snap.nested.forEach(function (n) { want[n.key] = n; });
        for (var i = 0; i < nodes.length && i < 4000; i++) {
          var el = nodes[i];
          if (!el || !want[nodeKey(el)]) continue;
          var n = want[nodeKey(el)];
          if (n.top) el.scrollTop = n.top;
          if (n.left) el.scrollLeft = n.left;
        }
      } catch (e) {}
    }
    if (snap.focusId) {
      var field = document.getElementById(snap.focusId);
      if (field) {
        /* a repaint rebuilds the composer: put the half-typed message back */
        if (snap.value != null && field.value !== snap.value) field.value = snap.value;
        try { field.focus({ preventScroll: true }); } catch (e) { safe(function () { field.focus(); }); }
        if (snap.selStart != null) safe(function () { field.setSelectionRange(snap.selStart, snap.selEnd == null ? snap.selStart : snap.selEnd); });
      }
    }
  }

  /* suppress the "something is refreshing" chrome */
  function quietChrome() {
    if (document.getElementById('wc-quiet-render-css')) return;
    var st = document.createElement('style');
    st.id = 'wc-quiet-render-css';
    st.textContent =
      '#wcUpdatePill,.wc-update-pill,.wc-sync-pill,.wc-refresh-pill{display:none!important}' +
      'html.wc-repainting body{--wc-quiet:1}' +
      /* a repaint must not flash an empty pane */
      'html.wc-repainting #app{opacity:1!important;transition:none!important}';
    document.head.appendChild(st);

    /* the update pill the session guard leaves behind is a refresh tell-tale */
    var sweep = function () {
      ['wcUpdatePill'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) { try { el.remove(); } catch (e) { el.style.display = 'none'; } }
      });
    };
    sweep();
    setInterval(sweep, 1200);
  }

  function realPaint(force) {
    var r = realRender || g('render');
    if (typeof r !== 'function' || r.__wcQuietWrapped) return;
    var snap = snapshot();
    scrollerMemory = snap;
    document.documentElement.classList.add('wc-repainting');
    try { r({ force: !!force }); }
    finally {
      restore(scrollerMemory);
      var clear = function () { document.documentElement.classList.remove('wc-repainting'); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(clear); else setTimeout(clear, 0);
      lastPaint = Date.now();
      lastHash = String(location.hash || '');
      startedAt = 0;
    }
  }

  function install() {
    var real = g('render');
    if (typeof real !== 'function' || real.__wcQuietWrapped) return !!real;

    realRender = real;
    lastHash = String(location.hash || '');
    var wrapped = function (opts) {
      opts = opts || {};
      /* an explicit, user-caused render must be immediate */
      var forced = !!(opts && (opts.force === true || opts.immediate === true || opts.sync === true));
      /* a route change is a user action: it must paint at once, never later */
      var moved = String(location.hash || '') !== lastHash;
      if (forced || moved) { pending = false; pendingForce = false; realPaint(forced); return; }

      /* never let a background repaint move the page, steal the cursor or
         interrupt a form — wait for the user's next action or a route change */
      if (autoRepaintSuppressed()) {
        pending = false;
        pendingForce = false;
        return;
      }

      var now = Date.now();
      if (busyNow()) {
        /* never interrupt: remember the request and paint when they pause */
        pending = true;
        if (!firstDeferredAt) firstDeferredAt = now;
        scheduleDeferred();
        return;
      }
      if (now - lastPaint < MIN_GAP) {
        pending = true;
        scheduleDeferred();
        return;
      }
      realPaint(false);
    };
    wrapped.__wcQuietWrapped = true;
    wrapped.__wcQuietReal = real;
    g_setRender(wrapped);
    return true;
  }

  function g_setRender(fn) {
    try { window.render = fn; } catch (e) {}
  }

  function scheduleDeferred() {
    if (pendingForce) return;
    pendingForce = true;
    (function tick() {
      pendingForce = false;
      var waited = firstDeferredAt ? Date.now() - firstDeferredAt : 0;
      var now = Date.now();
      if (pending && (now - lastPaint >= MIN_GAP) && (!busyNow() || waited > MAX_DEFER)) {
        pending = false;
        firstDeferredAt = 0;
        realPaint(false);
        return;
      }
      pendingForce = true;
      setTimeout(tick, 120);
    })();
  }

  /* an update that the session guard deferred must never pop a sheet over the
     screen: the app carries on, the update installs at the next real reload */
  function silenceUpdatePrompt() {
    var real = g('showUpdatePrompt');
    if (typeof real !== 'function' || real.__wcQuietPrompt) return;
    var wrapped = function (v, opts) {
      try {
        if (typeof real === 'function' && !(opts && opts.force)) {
          /* mark it as pending and let session-guard apply it on idle */
          return safe(function () { return real(v, Object.assign({}, opts, { auto: true })); }, true);
        }
        return safe(function () { return real.apply(this, arguments); }, true);
      } catch (e) { return true; }
    };
    wrapped.__wcQuietPrompt = true;
    try { window.showUpdatePrompt = wrapped; } catch (e) {}
  }

  function boot() {
    quietChrome();
    silenceUpdatePrompt();
    var tries = 0;
    (function bind() {
      var ok = install();
      if (!ok && tries++ < 80) return setTimeout(bind, 150);
      /* re-assert after a hot module replaces render */
      setInterval(function () {
        var r = g('render');
        if (typeof r === 'function' && !r.__wcQuietWrapped) install();
      }, 3000);
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.WCQuietRender = {
    busy: function () { return busyNow(); },
    force: function () { pending = false; realPaint(true); },
    pending: function () { return pending; },
    adminBusy: function () { return adminBusy(); }
  };
})();
