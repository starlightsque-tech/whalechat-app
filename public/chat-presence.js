/* =========================================================================
   WhaleChat live presence + typing  (v1.0)

   The app used to fake presence with localStorage, so another user could never
   appear online, and typing used BroadcastChannel, which only reaches tabs of
   the SAME browser. This module makes both real:

     presence  — a 15 s heartbeat (plus the open realtime socket) is stored on
                 the server and pushed to everyone who shares a chat with you.
                 Hide the tab / close it / lose the network and your contact
                 sees "last seen …" within a second.
     typing    — an input flag debounced to at most one write per 2 s, cleared
                 after 2 s of silence, on send, and on blur. Pushed straight to
                 the other participant over the same realtime stream.

   Both ride the single EventSource created by chat-instant.js (no second
   connection, no polling). Appwrite mode is supported when the optional
   presence/typing collections are configured — see CHAT-INSTANT.md.

   UI is repainted surgically (header subtitle, chat-list dots and preview,
   typing dots) so a keystroke never re-renders the whole page.
   ========================================================================= */
'use strict';

(function () {
  if (typeof window === 'undefined') return;
  if (window.__WCL_LOADED__) return;
  window.__WCL_LOADED__ = true;

  var WCL = window.WCL = {};
  var HEARTBEAT_MS = 15000;      // presence write
  var STALE_MS = 35000;          // server considers you offline after this
  var TYPING_IDLE_MS = 2200;     // stop typing after this much silence
  var TYPING_REFRESH_MS = 2000;  // at most one typing write per 2 s

  var $ = function (id) { return document.getElementById(id); };
  function meSafe() { try { return typeof me === 'function' ? me() : null; } catch (e) { return null; } }
  function uid() { var u = meSafe(); return u ? u.id : ''; }

  function remoteReady() {
    try { return !!(typeof Remote !== 'undefined' && Remote && Remote.enabled); } catch (e) { return false; }
  }
  function apiUrl(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.url && Remote.enabled) return Remote.url(p); } catch (e) {}
    return p;
  }
  function post(url, body, timeout) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, timeout || 6000) : null;
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl ? ctrl.signal : undefined,
      keepalive: true
    }).then(function (r) { return r.json().catch(function () { return null; }); })
      .finally(function () { if (t) clearTimeout(t); });
  }

  /* Appwrite transport (optional): set wc.appwrite with presenceCollection +
     typingCollection and the same logic runs through Appwrite Realtime. */
  function awCfg() { try { return (window.WCI && WCI.awCfg) ? WCI.awCfg() : null; } catch (e) { return null; } }

  /* ------------------------------------------------------------------ *
   *  presence state                                                     *
   * ------------------------------------------------------------------ */
  var R = {};                    // userId -> { online, lastSeen, currentChatWith, at }
  var currentChatWith = '';
  var lastBeat = 0;
  var beatTimer = null;
  var seenSnapshot = false;

  function applyPresence(p) {
    if (!p || !p.userId) return false;
    var id = String(p.userId);
    var prev = R[id] || {};
    var next = {
      online: !!p.online,
      lastSeen: Number(p.lastSeen) || prev.lastSeen || 0,
      currentChatWith: p.currentChatWith == null ? (prev.currentChatWith || '') : String(p.currentChatWith),
      at: Date.now()
    };
    R[id] = next;
    return prev.online !== next.online || prev.lastSeen !== next.lastSeen || prev.currentChatWith !== next.currentChatWith;
  }

  /* Presence is authoritative when the server has spoken about a user; the
     localStorage guess is only a cold-start fallback before the first frame. */
  function localPresence() {
    try { return JSON.parse(localStorage.getItem('whalechat.presence') || '{}'); } catch (e) { return {}; }
  }

  WCL.presenceOf = function (id) { return R[String(id)] || null; };
  WCL.isOnline = function (id) {
    var r = R[String(id)];
    if (r) return !!r.online;
    try { var m = localPresence(); return !!(m[id] && Date.now() - m[id] < 90000); } catch (e) { return false; }
  };
  WCL.lastSeen = function (id) {
    var r = R[String(id)];
    if (r && r.lastSeen) return r.lastSeen;
    try { var m = localPresence(); return m[id] || 0; } catch (e) { return 0; }
  };
  WCL.lastSeenText = function (id) {
    var ts = WCL.lastSeen(id);
    if (!ts) return 'last seen recently';
    if (Date.now() - ts < 60000) return 'last seen just now';
    try { return 'last seen ' + timeAgo(ts) + ' ago'; } catch (e) { return 'last seen recently'; }
  };

  /* conversations that are currently typing at me: chatId -> { userId, at } */
  var typingIn = {};
  WCL.typingIn = function (chatId) {
    var t = typingIn[chatId];
    if (!t) return null;
    if (Date.now() - t.at > 6000) { delete typingIn[chatId]; return null; }
    return t;
  };

  /* ------------------------------------------------------------------ *
   *  heartbeat                                                          *
   * ------------------------------------------------------------------ */
  function beat(force) {
    if (!uid()) return Promise.resolve(null);
    var t = Date.now();
    if (!force && t - lastBeat < 2000) return Promise.resolve(null);
    lastBeat = t;
    if (!remoteReady() && !awCfg()) return Promise.resolve(null);
    if (awCfg()) return awPresence(true);
    return post(apiUrl('/api/presence'), {
      userId: uid(),
      currentChatWith: currentChatWith,
      device: (navigator.userAgent || '').slice(0, 110),
      visible: document.visibilityState !== 'hidden'
    }, 6000).catch(function () { return null; });
  }
  WCL.beat = beat;

  function goOffline() {
    if (!uid()) return;
    var body = JSON.stringify({ userId: uid() });
    if (awCfg()) { awPresence(false); return; }
    try {
      if (navigator.sendBeacon) {
        var ok = navigator.sendBeacon(apiUrl('/api/presence/offline'), new Blob([body], { type: 'application/json' }));
        if (ok) return;
      }
    } catch (e) {}
    try { fetch(apiUrl('/api/presence/offline'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true }).catch(function () {}); } catch (e) {}
  }

  WCL.setCurrentChat = function (otherId) {
    var next = String(otherId || '');
    if (next === currentChatWith) return;
    currentChatWith = next;
    beat(true);
    paintChatList();
  };

  /* ------------------------------------------------------------------ *
   *  typing (outgoing)                                                  *
   * ------------------------------------------------------------------ */
  var typing = { chatId: '', sentAt: 0, lastAt: 0, idle: null, active: false };

  function typingTarget() {
    var cid = '';
    try { cid = (typeof ACTIVE_CHAT !== 'undefined' && ACTIVE_CHAT) ? String(ACTIVE_CHAT) : ''; } catch (e) {}
    if (!cid) return null;
    var myId = uid();
    var other = cid.split('__').filter(function (x) { return x && x !== myId; })[0];
    if (!other) return null;
    return { chatId: cid, to: other };
  }

  function sendTyping(isTyping, force) {
    var t = typingTarget();
    if (!t || !uid()) return;
    var now = Date.now();
    if (!isTyping && !typing.active && !force) return;
    if (isTyping && !force && now - typing.sentAt < TYPING_REFRESH_MS) return;
    typing.active = !!isTyping;
    typing.chatId = t.chatId;
    typing.sentAt = now;
    if (awCfg()) { awTyping(t, isTyping); return; }
    if (!remoteReady()) return;
    post(apiUrl('/api/typing'), { userId: uid(), chatId: t.chatId, to: t.to, isTyping: !!isTyping }, 5000).catch(function () {});
  }

  function stopTyping() {
    if (typing.idle) { clearTimeout(typing.idle); typing.idle = null; }
    if (typing.active) sendTyping(false, true);
  }
  WCL.stopTyping = stopTyping;

  function onInput(ev) {
    var el = ev.target;
    if (!el || el.id !== 'msgInput') return;
    var has = !!(el.value && el.value.trim());
    if (!has) { stopTyping(); return; }
    sendTyping(true);
    if (typing.idle) clearTimeout(typing.idle);
    typing.idle = setTimeout(function () { typing.idle = null; sendTyping(false, true); }, TYPING_IDLE_MS);
  }

  /* ------------------------------------------------------------------ *
   *  incoming events                                                    *
   * ------------------------------------------------------------------ */
  function onPresence(d) {
    if (!d) return;
    var changed = false;
    if (Array.isArray(d.presence)) d.presence.forEach(function (p) { if (applyPresence(p)) changed = true; });
    else if (d.presence && applyPresence(d.presence)) changed = true;
    else if (d.userId && applyPresence(d)) changed = true;
    if (changed) {
      paintChatList();
      paintChatHeader();
    }
  }
  function onSnapshot(d) {
    if (!d || !d.presence) return;
    seenSnapshot = true;
    Object.keys(d.presence).forEach(function (k) { applyPresence(d.presence[k]); });
    paintChatList();
    paintChatHeader();
  }
  function onTyping(d) {
    if (!d || !d.chatId || !d.from) return;
    var myId = uid();
    if (d.from === myId) return;
    if (d.isTyping) typingIn[d.chatId] = { userId: d.from, at: Date.now() };
    else delete typingIn[d.chatId];
    try { if (typeof TYPING !== 'undefined') { TYPING[d.chatId] = TYPING[d.chatId] || {}; TYPING[d.chatId][d.from] = d.isTyping ? Date.now() : 0; } } catch (e) {}
    paintChatHeader();
    paintChatList();
    paintTypingBubble();
    /* safety: typing auto-expires even if the "stop" frame is lost */
    if (d.isTyping) setTimeout(function () {
      var t = typingIn[d.chatId];
      if (t && Date.now() - t.at >= 6000) { delete typingIn[d.chatId]; paintChatHeader(); paintChatList(); paintTypingBubble(); }
    }, 6500);
  }

  /* ------------------------------------------------------------------ *
   *  UI paint (targeted, no full render)                                 *
   * ------------------------------------------------------------------ */
  function activeOther() {
    try {
      var h = (location.hash || '').replace(/^#\/?/, '');
      var parts = h.split('?')[0].split('/');
      if (parts[0] === 'chat' && parts[1]) return parts[1];
    } catch (e) {}
    return '';
  }

  function headerStatus() {
    var other = activeOther();
    if (!other) return;
    /* the chat header subtitle; works with or without the optional id */
    var el = $('wcChatSub') || document.querySelector('.chat-room .chat-head .grow .tiny');
    if (!el) return;
    var cid = '';
    try { cid = chatId(uid(), other); } catch (e) {}
    var typing = !!(cid && WCL.typingIn(cid));
    var online = WCL.isOnline(other);
    var p = WCL.presenceOf(other);
    var text;
    if (typing) text = 'typing…';
    else if (online && p && p.currentChatWith && p.currentChatWith !== uid()) text = 'online · in another chat';
    else if (online) text = 'online';
    else text = WCL.lastSeenText(other);
    el.textContent = text;
    el.style.color = typing ? 'var(--accent)' : online ? 'var(--success, #22c55e)' : 'var(--muted)';
  }

  function paintChatHeader() { try { headerStatus(); } catch (e) {} }

  function paintTypingBubble() {
    var body = $('chatBody');
    if (!body) return;
    var other = activeOther();
    var cid = '';
    try { cid = other ? chatId(uid(), other) : ''; } catch (e) {}
    var on = !!(cid && WCL.typingIn(cid));
    var b = $('wcTypingBubble');
    if (!on) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement('div');
      b.id = 'wcTypingBubble';
      b.className = 'typing';
      b.innerHTML = '<i></i><i></i><i></i>';
      body.appendChild(b);
    }
    if (body.lastElementChild !== b) body.appendChild(b);
    try { body.scrollTop = body.scrollHeight; } catch (e) {}
  }

  function paintChatList() {
    try {
      var myId = uid();
      var items = document.querySelectorAll('.chat-item[data-id]');
      for (var i = 0; i < items.length; i++) {
        var el = items[i];
        var id = el.getAttribute('data-id');
        var wrap = el.querySelector('.avatar-wrap');
        if (wrap) {
          var dot = wrap.querySelector('.status-dot');
          if (WCL.isOnline(id)) {
            if (!dot) { dot = document.createElement('span'); dot.className = 'status-dot'; wrap.appendChild(dot); }
          } else if (dot) dot.remove();
        }
        /* "Last seen 14:32" under the preview when the contact is away */
        var meta = el.querySelector('.meta');
        var online = WCL.isOnline(id);
        var ts = WCL.lastSeen(id);
        var seenEl = el.querySelector('.wc-seen');
        if (!online && ts && meta) {
          if (!seenEl) { seenEl = document.createElement('div'); seenEl.className = 'wc-seen tiny muted'; meta.appendChild(seenEl); }
          var d = new Date(ts);
          var hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          seenEl.textContent = 'last seen ' + hhmm;
        } else if (seenEl) seenEl.remove();

        var cid = '';
        try { cid = chatId(myId, id); } catch (e) {}
        var prev = el.querySelector('.pv .ellipsis');
        if (!prev) continue;
        var isTyping = !!(cid && WCL.typingIn(cid));
        if (isTyping) {
          if (!el.__wcPrevText) el.__wcPrevText = prev.textContent;
          prev.textContent = 'typing…';
          prev.style.color = 'var(--accent)';
          prev.style.fontStyle = 'italic';
        } else if (el.__wcPrevText) {
          prev.textContent = el.__wcPrevText;
          el.__wcPrevText = '';
          prev.style.color = '';
          prev.style.fontStyle = '';
        }
      }
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   *  read receipts on open + delivered for history                      *
   * ------------------------------------------------------------------ */
  function ackOpen() {
    var other = activeOther();
    var myId = uid();
    if (!other || !myId) return;
    var cid = '';
    try { cid = chatId(myId, other); } catch (e) { return; }
    var ids = [];
    try {
      (DB.messages || []).forEach(function (m) {
        if (!m || m.chatId !== cid || m.from !== other) return;
        var readBy = Array.isArray(m.readBy) ? m.readBy : [];
        if (m.status !== 'seen' && readBy.indexOf(myId) < 0) ids.push(m.id);
      });
    } catch (e) {}
    if (!ids.length) return;
    if (awCfg()) return;
    if (!remoteReady()) return;
    post(apiUrl('/api/messages/ack'), { chatId: cid, userId: myId, ids: ids.slice(0, 400), kind: 'read' }, 7000).catch(function () {});
  }

  /* ------------------------------------------------------------------ *
   *  Appwrite mode (optional; activates only when configured)            *
   * ------------------------------------------------------------------ */
  function awDocUrl(c, collection) {
    return c.endpoint.replace(/\/$/, '') + '/databases/' + encodeURIComponent(c.database) + '/collections/' + encodeURIComponent(collection) + '/documents';
  }
  function awHeaders(c) { return { 'content-type': 'application/json', 'x-appwrite-project': c.project }; }

  function awPresence(online) {
    var c = awCfg();
    if (!c || !c.presenceCollection) return Promise.resolve(null);
    var body = {
      documentId: 'unique()',
      userId: uid(),
      isOnline: !!online,
      lastSeen: new Date().toISOString(),
      currentChatWith: currentChatWith,
      device: (navigator.userAgent || '').slice(0, 110)
    };
    return post(awDocUrl(c, c.presenceCollection), body, 6000).catch(function () { return null; });
  }
  function awTyping(t, isTyping) {
    var c = awCfg();
    if (!c || !c.typingCollection) return;
    post(awDocUrl(c, c.typingCollection), {
      documentId: 'unique()',
      chatId: t.chatId, userId: uid(), isTyping: !!isTyping, updatedAt: new Date().toISOString()
    }, 5000).catch(function () {});
  }

  /* ------------------------------------------------------------------ *
   *  Transport hardening                                                *
   *  Two production failures are fixed here so no other file has to     *
   *  change: a saved sync host that no longer exists, and a double      *
   *  base prefix that built https://hosthttps://host/api/...            *
   * ------------------------------------------------------------------ */
  function hardenTransport() {
    var R = null;
    try { R = (typeof Remote !== 'undefined') ? Remote : null; } catch (e) { R = null; }
    if (!R || R.__wcHardened) return;
    R.__wcHardened = true;

    R.absolute = function (p) {
      var s = String(p == null ? '' : p);
      if (/^https?:\/\//i.test(s)) return s;
      return this.url(s);
    };

    R.fetchJSON = async function (pathname, opts, timeout) {
      opts = opts || {}; timeout = timeout || 7000;
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, timeout);
      var send = function (url) {
        return fetch(url, Object.assign({ signal: ctrl.signal, headers: { 'content-type': 'application/json' } }, opts));
      };
      try {
        var res;
        try {
          res = await send(this.absolute(pathname));
        } catch (e) {
          /* the sync host is unreachable: when this page was served by our own
             server, same-origin is always the right answer */
          if (this.base && window.__WC_SERVER__) {
            this.base = ''; this.setStoredBase(''); this.status = 'online'; this.lastError = '';
            res = await send(this.absolute(pathname));
          } else { throw e; }
        }
        var data = await res.json().catch(function () { return null; });
        return { res: res, data: data };
      } finally { clearTimeout(timer); }
    };

    var origInit = R.init;
    R.init = async function () {
      var ok = false;
      try { ok = await origInit.apply(this, arguments); } catch (e) { ok = false; }
      if (ok) return ok;
      /* a remembered server that no longer answers must never leave the app in
         "Failed to fetch" — forget it and use the server this build ships with */
      try {
        if (!window.__WC_SERVER__) {
          var fallback = (typeof DEFAULT_SYNC_SERVER !== 'undefined') ? DEFAULT_SYNC_SERVER : '';
          var stored = this.storedBase();
          if (fallback && stored) {
            this.setStoredBase('');
            return await this.connect(fallback, { silent: true, initFromLocal: true });
          }
        }
      } catch (e) {}
      return ok;
    };
  }
  hardenTransport();

  /* ------------------------------------------------------------------ *
   *  Realtime bridge                                                    *
   *  chat-instant.js keeps ONE EventSource for the app's lifetime. The  *
   *  constructor is wrapped once, at parse time (before that module     *
   *  boots), so presence / typing / snapshot frames are tapped without  *
   *  a second connection and without editing the chat engine.           *
   * ------------------------------------------------------------------ */
  function bridgeRealtime() {
    var Native = window.EventSource;
    if (!Native || Native.__wcBridged) return;
    function Wrapped(url, cfg) {
      var es = new Native(url, cfg);
      try {
        ['presence', 'presence-snapshot', 'typing'].forEach(function (name) {
          es.addEventListener(name, function (ev) {
            var d = null;
            try { d = JSON.parse(ev.data); } catch (e) { return; }
            if (name === 'presence') onPresence(d);
            else if (name === 'presence-snapshot') onSnapshot(d);
            else onTyping(d);
          });
        });
      } catch (e) {}
      return es;
    }
    Wrapped.prototype = Native.prototype;
    Wrapped.CONNECTING = Native.CONNECTING;
    Wrapped.OPEN = Native.OPEN;
    Wrapped.CLOSED = Native.CLOSED;
    Wrapped.__wcBridged = true;
    try { window.EventSource = Wrapped; } catch (e) {}
  }
  bridgeRealtime();

  /* Appwrite Realtime subscriptions for presence/typing (optional mode) */
  var awSubClient = null;
  function loadSdk() {
    if (loadSdk._p) return loadSdk._p;
    loadSdk._p = new Promise(function (resolve) {
      if (window.Appwrite) return resolve(window.Appwrite);
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/appwrite@17.0.0/dist/iife/sdk.js';
      s.async = true;
      s.onload = function () { resolve(window.Appwrite || null); };
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
    return loadSdk._p;
  }
  function awListen() {
    var c = awCfg();
    if (!c || !(c.presenceCollection || c.typingCollection)) return;
    loadSdk().then(function (A) {
      if (!A) return;
      try {
        var client = new A.Client().setEndpoint(c.endpoint).setProject(c.project);
        awSubClient = client;
        if (c.presenceCollection) {
          client.subscribe('databases.' + c.database + '.collections.' + c.presenceCollection + '.documents', function (res) {
            var p = res && res.payload;
            if (!p || !p.userId) return;
            onPresence({ presence: { userId: p.userId, online: !!p.isOnline, lastSeen: Date.parse(p.lastSeen) || Date.now(), currentChatWith: p.currentChatWith || '' } });
          });
        }
        if (c.typingCollection) {
          client.subscribe('databases.' + c.database + '.collections.' + c.typingCollection + '.documents', function (res) {
            var p = res && res.payload;
            if (!p || !p.chatId || !p.userId) return;
            onTyping({ chatId: p.chatId, from: p.userId, isTyping: !!p.isTyping });
          });
        }
      } catch (e) {}
    });
  }

  /* ------------------------------------------------------------------ *
   *  wiring                                                             *
   * ------------------------------------------------------------------ */
  var lastPaint = 0;
  function paintAll() {
    var t = Date.now();
    if (t - lastPaint < 60) return;      // coalesce bursts of realtime frames
    lastPaint = t;
    paintChatHeader();
    paintChatList();
    paintTypingBubble();
  }

  function start() {
    var u = meSafe();
    if (!u) { setTimeout(start, 1200); return; }

    /* Presence hooks used by every view (chat list, header, profile, admin) */
    if (typeof Presence !== 'undefined' && Presence) {
      Presence.isOnline = function (id) { return WCL.isOnline(id); };
      Presence.lastSeen = function (id) { return WCL.lastSeen(id); };
      Presence.touch = function () { beat(true); };
    }

    /* one realtime stream, created by chat-instant.js */
    try {
      if (window.WCI && WCI.onRealtime) {
        WCI.onRealtime('presence', onPresence);
        WCI.onRealtime('presence-snapshot', onSnapshot);
        WCI.onRealtime('typing', onTyping);
        WCI.onRealtime('hello', function () { seenSnapshot = false; beat(true); onRoute(); });
      }
    } catch (e) {}

    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', function (ev) {
      if (ev && ev.key === 'Enter' && !ev.shiftKey && ev.target && ev.target.id === 'msgInput') stopTyping();
    }, true);
    /* the send button / Enter both fire the app's send; stop typing right away */
    document.addEventListener('click', function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-act="send"]') : null;
      if (el) stopTyping();
    }, true);

    window.addEventListener('hashchange', onRoute);
    window.addEventListener('online', function () { beat(true); onRoute(); });
    window.addEventListener('offline', function () { });
    window.addEventListener('pagehide', goOffline);
    window.addEventListener('beforeunload', goOffline);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { stopTyping(); goOffline(); }
      else { beat(true); onRoute(); }
    });

    beatTimer = setInterval(function () {
      if (document.visibilityState === 'hidden') return;
      beat(false);
    }, HEARTBEAT_MS);

    /* housekeeping: expire stale typing flags and refresh the header clock */
    setInterval(function () {
      var dirty = false;
      Object.keys(typingIn).forEach(function (k) { if (Date.now() - typingIn[k].at > 6000) { delete typingIn[k]; dirty = true; } });
      if (dirty) paintAll();
      else if (activeOther() && !WCL.isOnline(activeOther())) paintChatHeader();
    }, 2500);

    if (awCfg()) awListen();
    onRoute();
    beat(true);
    setTimeout(function () { paintAll(); ackOpen(); }, 800);
  }

  function onRoute() {
    var other = activeOther();
    WCL.setCurrentChat(other ? other : '');
    try { if (typeof TYPING !== 'undefined' && other) { var cid = ''; try { cid = chatId(uid(), other); } catch (e) {} if (cid && TYPING[cid]) delete TYPING[cid][other]; } } catch (e) {}
    paintAll();
    if (other) setTimeout(ackOpen, 120);
  }
  WCL.onRoute = onRoute;

  /* public helpers for other modules / diagnostics */
  WCL.status = function () {
    return {
      heartbeatMs: HEARTBEAT_MS,
      transport: (function () { try { return WCI.transport(); } catch (e) { return 'unknown'; } })(),
      currentChatWith: currentChatWith,
      known: Object.keys(R).length,
      online: Object.keys(R).filter(function (k) { return R[k].online; }).length,
      typingChats: Object.keys(typingIn),
      snapshot: seenSnapshot
    };
  };
  WCL.users = function () { return JSON.parse(JSON.stringify(R)); };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else setTimeout(start, 300);
})();
