/* =========================================================================
   WhaleChat smooth chat  (wc-chat-smooth)  v1.0

   THE typing bug this fixes
   -------------------------
   The app rebuilt its whole screen (`app.innerHTML = shellHTML(...)`) for every
   background change: a typing notice from the other person, a delivery tick, a
   presence heartbeat, an incoming message. On the chat screen that destroyed
   and re-created the <textarea> the user was typing in, `AFTER.chat` then
   re-focused it (keyboard flicker) and scrolled the list to the bottom. The
   result is exactly what users reported: the screen shakes/blinks, the
   keyboard jumps, and typing gets interrupted or wiped.

   What this module does
   ---------------------
   1. `intercept()` is called at the top of render(). While the user is on a
      chat screen with the composer active it REFUSES the rebuild and paints
      only what actually changed (new bubbles, ticks, typing indicator), so the
      composer, its text, its caret and the keyboard are never touched.
   2. `syncChat()` appends only the messages that are not on screen yet and
      fixes read ticks in place — no full re-render, no scroll jump.
   3. `paintPresence()` / `paintTicks()` update the "typing…"/"online" header
      and the ✓✓ ticks without touching the message list.
   4. A pending rebuild is flushed the moment the composer loses focus (or the
      user navigates), so nothing is ever left stale.

   Everything is defensive: if a helper is missing the call is skipped and the
   normal render continues, so the app can never be left blank by this module.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_SMOOTH) return;

  var S = window.WC_SMOOTH = {};
  var lastHash = '';
  var flushTimer = null;
  var inflight = false;

  function g(name) { try { return typeof window[name] !== 'undefined' ? window[name] : null; } catch (e) { return null; } }
  function id(x) { return document.getElementById(x); }
  function q(x, r) { try { return (r || document).querySelector(x); } catch (e) { return null; } }
  function qa(x, r) { try { return Array.prototype.slice.call((r || document).querySelectorAll(x)); } catch (e) { return []; } }

  /* globals exposed by the main app script (let/const live in the shared
     global lexical scope, function declarations on window) */
  function activeChat() { try { return typeof ACTIVE_CHAT !== 'undefined' ? ACTIVE_CHAT : null; } catch (e) { return null; } }
  function composeMap() { try { return typeof COMPOSE !== 'undefined' ? COMPOSE : null; } catch (e) { return null; } }
  function typingMap() { try { return typeof TYPING !== 'undefined' ? TYPING : null; } catch (e) { return null; } }
  function theMe() { try { return typeof me === 'function' ? me() : null; } catch (e) { return null; } }
  function findUserX(x) { try { return typeof findUser === 'function' ? findUser(x) : null; } catch (e) { return null; } }
  function chatMsgs(cid) { try { return typeof chatMessages === 'function' ? chatMessages(cid) : []; } catch (e) { return []; } }
  function msgHTML(m, u, o) { try { return typeof messageHTML === 'function' ? messageHTML(m, u, o) : ''; } catch (e) { return ''; } }
  function hydrate(n) { try { if (window.Media && Media.hydrate) Media.hydrate(n); } catch (e) {} }

  function inChatRoom() {
    try {
      if (!document.body.classList.contains('chat-open')) return false;
      return !!id('chatBody') && !!id('msgInput');
    } catch (e) { return false; }
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
  }

  /* true while the user is writing (composer focused or a draft is waiting) */
  S.composerActive = function () {
    try {
      var el = document.activeElement;
      if (isTextField(el)) return true;
      var c = composeMap();
      var cid = activeChat();
      if (c && cid && c[cid] && (c[cid].text || '').length) return true;
    } catch (e) {}
    return false;
  };

  /* ---------------------------------------------------------------- *
   * 1. the guard used by render()
   * ---------------------------------------------------------------- */
  S.intercept = function () {
    if (inflight) return false;
    try {
      if (!inChatRoom()) { lastHash = location.hash || ''; return false; }
      /* navigation must never be delayed */
      var h = location.hash || '';
      if (h !== lastHash) { lastHash = h; return false; }
      if (!S.composerActive()) return false;
      /* the user is typing in the chat: paint the delta, keep the composer */
      inflight = true;
      try { S.syncChat(); } catch (e) {}
      inflight = false;
      return true;
    } catch (e) { inflight = false; return false; }
  };

  /* run a full render as soon as the user is not typing any more */
  S.renderIdle = function (fn) {
    var run = typeof fn === 'function' ? fn : (typeof render === 'function' ? render : null);
    if (!run) return;
    if (!S.composerActive()) { try { run(); } catch (e) {} return; }
    clearTimeout(flushTimer);
    flushTimer = setTimeout(function () {
      if (S.composerActive()) return;         /* still typing — wait for blur */
      try { run(); } catch (e) {}
    }, 600);
  };

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(function () {
      if (S.composerActive()) return;
      if (!inChatRoom()) { try { render(); } catch (e) {} return; }
      try { render(); } catch (e) {}
    }, 220);
  }

  /* ---------------------------------------------------------------- *
   * 2. in-place chat painting
   * ---------------------------------------------------------------- */
  S.paintTicks = function () {
    try {
      if (!inChatRoom()) return false;
      var u = theMe(); if (!u) return false;
      var body = id('chatBody'); if (!body) return false;
      var db = (typeof DB !== 'undefined') ? DB : null; if (!db) return false;
      qa('[data-msg]', body).forEach(function (el) {
        var mid = el.getAttribute('data-msg');
        var m = db.messages.find(function (x) { return x.id === mid; });
        if (!m || m.from !== u.id) return;
        var tick = q('.tick', el);
        if (!tick) return;
        var seen = m.status === 'seen';
        var want = seen ? 'seen' : '';
        if (tick.getAttribute('data-state') === want) return;
        tick.setAttribute('data-state', want);
        tick.className = 'tick ' + (seen ? 'seen' : '');
        tick.setAttribute('title', seen ? 'Read' : 'Sent');
        try {
          tick.innerHTML = typeof ic === 'function' ? ic(seen ? 'checks' : 'check', 12) : '';
        } catch (e) {}
      });
      return true;
    } catch (e) { return false; }
  };

  S.paintPresence = function () {
    try {
      if (!inChatRoom()) return false;
      var cid = activeChat(); if (!cid) return false;
      var u = theMe(); if (!u) return false;
      var otherId = String(cid).split('__').filter(function (x) { return x && x !== u.id; })[0];
      var other = findUserX(otherId); if (!other) return false;
      var T = typingMap() || {};
      var t = T[cid] && T[cid][other.id];
      var typing = !!(t && Date.now() - t < 4000);
      var online = false, lastSeen = 0;
      try { online = Presence.isOnline(other.id); lastSeen = Presence.lastSeen(other.id); } catch (e) {}
      var db = (typeof DB !== 'undefined') ? DB : null;
      var meta = (db && db.chatsMeta && db.chatsMeta[cid]) || {};
      var muted = (meta.muted || []).indexOf(u.id) !== -1;

      var sub = id('chatHeadSub');
      if (sub) {
        var label = typing ? 'typing…'
          : online ? 'online'
            : 'last seen ' + (lastSeen ? (typeof timeAgo === 'function' ? timeAgo(lastSeen) + ' ago' : 'recently') : 'recently');
        if (muted) label += ' · muted';
        if (sub.textContent !== label) sub.textContent = label;
        sub.style.color = typing ? 'var(--accent)' : 'var(--muted)';
      }
      var dots = id('chatTyping');
      if (typing && !dots) {
        var body = id('chatBody');
        if (body) {
          var d = document.createElement('div');
          d.className = 'typing'; d.id = 'chatTyping';
          d.innerHTML = '<i></i><i></i><i></i>';
          body.appendChild(d);
          body.scrollTop = body.scrollHeight;
        }
      } else if (!typing && dots) {
        dots.remove();
      }
      return true;
    } catch (e) { return false; }
  };

  /* append only what is missing — never rebuilds the screen */
  S.syncChat = function (opts) {
    var o = opts || {};
    try {
      if (!inChatRoom()) return false;
      var cid = activeChat(); if (!cid) return false;
      var body = id('chatBody'); if (!body) return false;
      var u = theMe(); if (!u) return false;
      var otherId = String(cid).split('__').filter(function (x) { return x && x !== u.id; })[0];
      var other = findUserX(otherId); if (!other) return false;

      var msgs = chatMsgs(cid);
      var shown = {};
      qa('[data-msg]', body).forEach(function (el) { shown[el.getAttribute('data-msg')] = 1; });

      var nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 200;
      var typingEl = id('chatTyping') || q('.typing', body);
      var lastShown = qa('[data-msg]', body).pop();
      var added = 0, appendTo = null;

      msgs.forEach(function (m) {
        if (shown[m.id]) return;
        var tmp = document.createElement('div');
        tmp.innerHTML = msgHTML(m, u, other);
        var node = tmp.firstElementChild;
        if (!node) return;
        var prevAt = lastShown ? Number(lastShown.getAttribute('data-at') || 0) : 0;
        var dayLabel = typeof timeDivider === 'function' ? timeDivider(m.createdAt) : '';
        var prevDay = lastShown ? lastShown.getAttribute('data-day') || '' : '';
        if (dayLabel && dayLabel !== prevDay) {
          var sep = document.createElement('div');
          sep.className = 'day-sep';
          sep.setAttribute('data-day', dayLabel);
          sep.textContent = dayLabel;
          if (typingEl && typingEl.parentNode === body) body.insertBefore(sep, typingEl);
          else body.appendChild(sep);
          prevDay = dayLabel;
        }
        node.setAttribute('data-day', dayLabel || '');
        if (typingEl && typingEl.parentNode === body) body.insertBefore(node, typingEl);
        else body.appendChild(node);
        lastShown = node;
        appendTo = node;
        added++;
      });

      if (added) {
        var hint = q('.chat-empty-hint', body);
        if (hint) hint.remove();
        if (appendTo) hydrate(appendTo.parentNode || body);
      }

      var bc = body.querySelector('[data-day]');
      if (bc) { /* keep day separators from piling up */ }

      S.paintTicks();
      S.paintPresence();

      if (opts.forceScroll || (added && nearBottom)) {
        var go = function () { body.scrollTop = body.scrollHeight; };
        if (window.requestAnimationFrame) requestAnimationFrame(go); else go();
      }

      /* read receipts for what just arrived, without a re-render */
      try {
        var receipts = !(u.settings && u.settings.readReceipts === false);
        var changed = false;
        msgs.forEach(function (m) {
          if (m.to !== u.id) return;
          if (typeof isReadBy === 'function' && isReadBy(m, u.id)) return;
          m.readBy = Array.isArray(m.readBy) ? m.readBy : [];
          if (m.readBy.indexOf(u.id) === -1) { m.readBy.push(u.id); changed = true; }
        });
        if (changed) {
          if (typeof persist === 'function') persist(true);
          if (typeof notifySeen === 'function') notifySeen(otherId);
          if (window.WCI && WCI.drainReadQueue) WCI.drainReadQueue();
        }
      } catch (e) {}

      return true;
    } catch (e) { return false; }
  };

  /* called right after a message is sent: show the bubble, keep the keyboard */
  S.afterSend = function () {
    try {
      if (S.syncChat({ forceScroll: true })) {
        var inp = id('msgInput');
        if (inp && document.activeElement !== inp) {
          try { inp.focus({ preventScroll: true }); } catch (e) {}
        }
        return true;
      }
    } catch (e) {}
    return false;
  };

  /* ---------------------------------------------------------------- *
   * 3. flush the deferred render when the user stops typing
   * ---------------------------------------------------------------- */
  document.addEventListener('focusout', function (e) {
    var t = e.target;
    if (!t || !isTextField(t)) return;
    setTimeout(function () { if (!S.composerActive()) flush(); }, 260);
  }, true);

  /* A new route always renders immediately — never update lastHash here, or
     the navigation render would look like "no change" and be cancelled. */
  window.addEventListener('hashchange', function () {
    clearTimeout(flushTimer);
  });

  /* a rebuild that was skipped must not leave the page stale forever */
  setInterval(function () {
    try {
      if (!inChatRoom()) return;
      if (S.composerActive()) return;
      S.paintTicks();
      S.paintPresence();
    } catch (e) {}
  }, 5000);

  try { lastHash = location.hash || ''; } catch (e) {}
})();
