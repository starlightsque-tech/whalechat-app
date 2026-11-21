/* =========================================================================
   WhaleChat — Share Internet Session  (wc-session-bridge)

   A lightweight, self-contained "session room" layer on top of the chat:

     · Share button in every chat header → pick contacts → get a 6-character
       room code and a link anyone can join with.
     · Session overlay with live messages, typing, presence, delivered / read
       ticks and a durable outbox for devices without a connection.
     · Offline catch-up runs silently through POST /api/rooms/sync: only the
       other member's messages are pulled into this chat, so A's messages reach
       B and B's replies reach A as soon as either device has a link. No
       offline banner and no manual "reconnect" step.
     · Deep link  .../whalechat#/session/CODE  joins straight into the room.
     · Every write is local-first: the bubble is painted before the network,
       and queued messages survive a reload.

   Transport: the same single realtime stream the 1:1 chat already uses
   (WCI.onRealtime). No polling, no second socket.
   ========================================================================= */
'use strict';

(function () {
  if (typeof window === 'undefined') return;
  if (window.__WCS_LOADED__) return;
  window.__WCS_LOADED__ = true;

  var LS = {
    rooms: 'wc.rooms.v1',
    msgs: 'wc.rooms.msgs.v1',
    outbox: 'wc.rooms.outbox.v1',
    byPeer: 'wc.rooms.byPeer.v1',
    pendingJoin: 'wc.rooms.pendingJoin.v1'
  };

  function read(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }
  function uid() { try { return (typeof me === 'function' && me()) ? me().id : ''; } catch (e) { return ''; } }
  function userName(id) {
    try {
      var u = typeof findUser === 'function' ? findUser(id) : null;
      return (u && (u.fullName || u.username)) || 'WhaleChat user';
    } catch (e) { return 'WhaleChat user'; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function api(path) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled) return Remote.url(path); } catch (e) {}
    return path;
  }
  function toastSafe(msg, kind) {
    try { if (typeof toast === 'function') return toast(msg, kind || 'ok'); } catch (e) {}
    try { console.info('[session]', msg); } catch (e) {}
  }
  function clock(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function online(id) {
    try { return !!(window.WCL && WCL.isOnline(id)); } catch (e) { return false; }
  }
  function lastSeen(id) {
    try { return (window.WCL && WCL.lastSeen(id)) || 0; } catch (e) { return 0; }
  }
  function getJSON(path, timeout) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, timeout || 8000) : null;
    return fetch(api(path), { signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.json(); })
      .finally(function () { if (t) clearTimeout(t); });
  }
  function postJSON(path, body, timeout) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, timeout || 10000) : null;
    return fetch(api(path), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}), signal: ctrl ? ctrl.signal : undefined, keepalive: true
    }).then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .finally(function () { if (t) clearTimeout(t); });
  }

  /* ------------------------------------------------------------------ *
   *  local stores                                                       *
   * ------------------------------------------------------------------ */
  function rooms() { var r = read(LS.rooms, {}); return (r && typeof r === 'object') ? r : {}; }
  function saveRoom(room) {
    if (!room || !room.code) return;
    var all = rooms(); all[room.code] = Object.assign({}, all[room.code] || {}, room, { at: Date.now() });
    write(LS.rooms, all);
  }
  function messagesOf(code) {
    var all = read(LS.msgs, {}); var list = (all && all[code]) || [];
    return Array.isArray(list) ? list : [];
  }
  function saveMessages(code, list) {
    var all = read(LS.msgs, {}); all[code] = (list || []).slice(-400); write(LS.msgs, all);
  }
  function appendMessage(code, msg) {
    var list = messagesOf(code);
    var i = list.findIndex(function (m) { return m && m.id === msg.id; });
    if (i >= 0) list[i] = Object.assign({}, list[i], msg);
    else list.push(msg);
    list.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    saveMessages(code, list);
    return list;
  }
  function outbox() { var q = read(LS.outbox, []); return Array.isArray(q) ? q : []; }
  function saveOutbox(q) { write(LS.outbox, (q || []).slice(-300)); }

  /* ------------------------------------------------------------------ *
   *  state                                                              *
   * ------------------------------------------------------------------ */
  var state = {
    openCode: '',
    rooms: {},                // code -> room view
    typing: {},               // code -> { userId: at }
    latency: 0,
    lastSync: 0,
    observer: null,
    shareBusy: false
  };
  var ST = { QUEUED: 'queued', SENT: 'sent', DELIVERED: 'delivered', READ: 'read' };
  var RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };

  /* ------------------------------------------------------------------ *
   *  transport                                                          *
   * ------------------------------------------------------------------ */
  function networkUp() { return navigator.onLine !== false; }

  function createRoom(opts) {
    var body = { userId: uid(), name: opts.name || 'Internet session', members: opts.members || [] };
    if (opts.code) body.code = opts.code;
    return postJSON('/api/rooms/create', body).then(function (r) {
      if (r.ok && r.data && r.data.room) { saveRoom(r.data.room); state.rooms[r.data.room.code] = r.data.room; }
      return r;
    });
  }
  function joinRoom(code) {
    return postJSON('/api/rooms/join', { userId: uid(), code: String(code || '').toUpperCase() }).then(function (r) {
      if (r.ok && r.data && r.data.room) {
        saveRoom(r.data.room); state.rooms[r.data.room.code] = r.data.room;
        if (Array.isArray(r.data.messages)) {
          var merged = r.data.messages.reduce(function (acc, m) { return appendMessage(r.data.room.code, m), messagesOf(r.data.room.code); }, []);
          saveMessages(r.data.room.code, merged);
        }
      }
      return r;
    });
  }
  function fetchRoom(code) {
    return getJSON('/api/rooms/get?user=' + encodeURIComponent(uid()) + '&code=' + encodeURIComponent(code)).then(function (d) {
      if (d && d.ok && d.room) {
        saveRoom(d.room); state.rooms[code] = d.room;
        var list = (d.messages || []).reduce(function (acc, m) { acc.push(m); return acc; }, messagesOf(code));
        var seen = {}, out = [];
        list.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        list.forEach(function (m) { if (!m || seen[m.id]) return; seen[m.id] = 1; out.push(m); });
        saveMessages(code, out);
        if (d.presence && window.WCL) { /* presence arrives live too; nothing to do */ }
      }
      return d;
    });
  }

  /* ------------------------------------------------------------------ *
   *  room sync — the offline webhook                                   *
   *  POST /api/rooms/sync carries this device's queued messages up and  *
   *  returns ONLY the other members' messages back. A's messages reach  *
   *  B, B's replies reach A, and a device that was offline catches up   *
   *  automatically the moment it has a connection again.                *
   * ------------------------------------------------------------------ */
  function roomSince(code) {
    /* Cursor over the *incoming* stream only. Using our own latest message
       would skip an older message from the other side that we never saw. */
    var meId = uid();
    var max = 0;
    messagesOf(code).forEach(function (m) {
      if (!m || m.from === meId) return;
      var t = Number(m.serverAt || m.createdAt || 0);
      if (t > max) max = t;
    });
    return max ? Math.max(0, max - 1) : 0;
  }

  var syncing = {};
  function syncRoom(code) {
    if (!code || !uid() || !networkUp()) return Promise.resolve(null);
    if (syncing[code]) return syncing[code];
    var queued = outbox().filter(function (m) { return m && m.code === code; }).map(function (m) {
      return { id: m.id, text: m.text, createdAt: m.createdAt };
    });
    syncing[code] = postJSON('/api/rooms/sync', {
      userId: uid(), code: code, since: roomSince(code), outbox: queued
    }, 9000).then(function (r) {
      if (!r || !r.ok || !r.data || r.data.ok === false) return r;
      var d = r.data;
      if (d.room) { saveRoom(d.room); state.rooms[code] = d.room; }
      (d.messages || []).forEach(function (m) { if (m && m.id) ingestRoomMessage(code, m); });
      if (Array.isArray(d.accepted) && d.accepted.length) {
        var accepted = d.accepted;
        saveOutbox(outbox().filter(function (x) { return accepted.indexOf(x.id) < 0; }));
        var list = messagesOf(code).map(function (m) {
          if (m && accepted.indexOf(m.id) >= 0 && RANK[m.status || 'queued'] < RANK[ST.SENT]) {
            return Object.assign({}, m, { status: ST.SENT, serverAt: d.serverTime || Date.now() });
          }
          return m;
        });
        saveMessages(code, list);
      }
      state.lastSync = Date.now();
      state.latency = Math.max(0, state.lastSync - (d.serverTime || state.lastSync));
      if (state.openCode === code) { paintRoomMessages(); paintMembers(); markRoomRead(code); }
      refreshRoomsBadge();
      return r;
    }).catch(function () { return null; }).finally(function () { syncing[code] = null; });
    return syncing[code];
  }

  /* ------------------------------------------------------------------ *
   *  send (optimistic + durable outbox)                                 *
   * ------------------------------------------------------------------ */
  function sendRoomMessage(code, text) {
    var u = uid();
    text = String(text || '').trim();
    if (!u || !code || !text) return null;
    var msg = {
      id: 'rm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      code: code, from: u, text: text.slice(0, 4000), createdAt: Date.now(),
      status: ST.QUEUED, readBy: [], deliveredTo: []
    };
    appendMessage(code, msg);
    paintRoomMessages();
    var q = outbox(); q.push(msg); saveOutbox(q);
    updateSyncBadge();
    flushOutbox();
    syncRoom(code);
    return msg;
  }

  var flushing = false;
  function flushOutbox() {
    if (flushing || !networkUp()) { updateSyncBadge(); return; }
    var q = outbox();
    if (!q.length) { updateSyncBadge(); return; }
    flushing = true;
    (async function () {
      var remaining = q.slice();
      for (var i = 0; i < q.length; i++) {
        var m = q[i];
        try {
          var r = await postJSON('/api/rooms/message', {
            userId: uid(), code: m.code, id: m.id, text: m.text, createdAt: m.createdAt
          }, 9000);
          if (r.ok) {
            remaining = remaining.filter(function (x) { return x.id !== m.id; });
            var list = messagesOf(m.code);
            var hit = list.filter(function (x) { return x.id === m.id; })[0];
            if (hit && RANK[hit.status] < RANK[ST.SENT]) { hit.status = ST.SENT; }
            saveMessages(m.code, list);
            if (state.openCode === m.code) paintRoomMessages();
            syncRoom(m.code);
          } else if (r.status >= 400 && r.status < 500) {
            /* rejected forever — keep the bubble but stop retrying it */
            remaining = remaining.filter(function (x) { return x.id !== m.id; });
          }
        } catch (e) { break; }
      }
      saveOutbox(remaining);
      flushing = false;
      updateSyncBadge();
      if (remaining.length) setTimeout(flushOutbox, 2000);
    })();
  }

  /* ------------------------------------------------------------------ *
   *  realtime                                                           *
   * ------------------------------------------------------------------ */
  function ingestRoomMessage(code, msg) {
    if (!msg || !msg.id) return;
    var list = messagesOf(code);
    var hit = list.filter(function (m) { return m && m.id === msg.id; })[0];
    var next = Object.assign({}, hit || {}, msg);
    if (hit && RANK[hit.status] > RANK[next.status || 0]) next.status = hit.status;
    if (next.from === uid() && Array.isArray(next.deliveredTo) && next.deliveredTo.length && RANK[next.status] < RANK[ST.DELIVERED]) next.status = ST.DELIVERED;
    appendMessage(code, next);
    if (state.openCode === code) paintRoomMessages();
    if (msg.from !== uid() && state.openCode === code) markRoomRead(code);
    refreshRoomsBadge();
  }

  function wireRealtime() {
    if (!window.WCI || !WCI.onRealtime) return false;
    WCI.onRealtime('room-message', function (d) {
      if (!d || !d.code || !d.message) return;
      state.lastSync = Date.now(); state.latency = Math.max(0, state.lastSync - (d.at || state.lastSync));
      ingestRoomMessage(d.code, d.message);
    });
    WCI.onRealtime('room-invite', function (d) {
      if (!d || !d.room) return;
      saveRoom(d.room); state.rooms[d.room.code] = d.room;
      refreshRoomsBadge();
    });
    WCI.onRealtime('room-update', function (d) {
      if (!d || !d.room) return;
      saveRoom(d.room); state.rooms[d.room.code] = d.room;
    });
    WCI.onRealtime('room-typing', function (d) {
      if (!d || !d.code || !d.from || d.from === uid()) return;
      state.typing[d.code] = state.typing[d.code] || {};
      if (d.isTyping) state.typing[d.code][d.from] = Date.now();
      else delete state.typing[d.code][d.from];
      if (state.openCode === d.code) paintTyping();
      if (d.isTyping) setTimeout(function () {
        if (state.typing[d.code] && state.typing[d.code][d.from] && Date.now() - state.typing[d.code][d.from] >= 4000) {
          delete state.typing[d.code][d.from];
          if (state.openCode === d.code) paintTyping();
        }
      }, 4300);
    });
    WCI.onRealtime('room-read', function (d) {
      if (!d || !d.code || !Array.isArray(d.ids)) return;
      var list = messagesOf(d.code).map(function (m) {
        if (!m || d.ids.indexOf(m.id) < 0) return m;
        var readBy = Array.isArray(m.readBy) ? m.readBy.slice() : [];
        if (readBy.indexOf(d.userId) < 0) readBy.push(d.userId);
        var st = m.from === uid() ? ST.READ : m.status;
        return Object.assign({}, m, { readBy: readBy, status: st });
      });
      saveMessages(d.code, list);
      if (state.openCode === d.code) paintRoomMessages();
    });
    WCI.onRealtime('presence', function () { if (state.openCode) { paintRoomMessages(); paintTyping(); paintMembers(); } refreshRoomsBadge(); });
    WCI.onRealtime('presence-snapshot', function () { if (state.openCode) { paintRoomMessages(); paintTyping(); paintMembers(); } refreshRoomsBadge(); });
    WCI.onRealtime('hello', function () {
      state.lastSync = Date.now(); updateSyncBadge(); flushOutbox();
      if (state.openCode) syncRoom(state.openCode);
      fetchRoomsList();
    });
    return true;
  }

  /* ------------------------------------------------------------------ *
   *  typing (outgoing)                                                  *
   * ------------------------------------------------------------------ */
  var typingTimer = null, typingIdle = null, typingSentAt = 0;
  function sendTyping(code, isTyping) {
    if (!code || !window.WCI || !networkUp()) return;
    var now = Date.now();
    if (isTyping && now - typingSentAt < 1500) return;
    typingSentAt = now;
    postJSON('/api/rooms/typing', { userId: uid(), code: code, isTyping: !!isTyping }, 4000).catch(function () {});
  }
  function startTyping(code) {
    if (!code) return;
    sendTyping(code, true);
    if (typingTimer) return;
    typingTimer = setInterval(function () { sendTyping(code, true); }, 1600);
    if (typingIdle) clearTimeout(typingIdle);
    typingIdle = setTimeout(stopTyping, 2500);
  }
  function stopTyping() {
    if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
    if (typingIdle) { clearTimeout(typingIdle); typingIdle = null; }
    if (state.openCode) sendTyping(state.openCode, false);
  }

  /* ------------------------------------------------------------------ *
   *  UI primitives                                                      *
   * ------------------------------------------------------------------ */
  function injectCSS() {
    if (document.getElementById('wcs-style')) return;
    var css = document.createElement('style');
    css.id = 'wcs-style';
    css.textContent = [
      '.wcs-fab{position:fixed;right:16px;bottom:84px;z-index:60;display:flex;align-items:center;gap:8px;padding:10px 14px;border:1px solid rgba(46,230,201,.35);border-radius:999px;background:linear-gradient(135deg,rgba(46,230,201,.22),rgba(58,160,255,.16));color:#e9f4f9;font:600 12.5px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.45);cursor:pointer;backdrop-filter:blur(10px)}',
      '.wcs-fab .wcs-badge{min-width:17px;height:17px;border-radius:9px;background:#ff4d6d;color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;padding:0 4px}',
      '.wcs-share-btn{position:relative}',
      '.wcs-ov{position:fixed;inset:0;z-index:80;background:rgba(2,12,20,.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px}',
      '.wcs-card{width:min(520px,100%);max-height:92vh;overflow:auto;background:#071c2b;border:1px solid rgba(46,230,201,.22);border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.6);color:#e9f4f9;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}',
      '.wcs-card h3{margin:0;font-size:17px}',
      '.wcs-hd{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.08)}',
      '.wcs-hd .grow{flex:1;min-width:0}',
      '.wcs-x{width:32px;height:32px;border-radius:50%;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#e9f4f9;font-size:17px;cursor:pointer}',
      '.wcs-bd{padding:16px 18px;display:flex;flex-direction:column;gap:12px}',
      '.wcs-muted{color:#8ba4b6;font-size:12.5px}',
      '.wcs-code{font:700 26px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;color:#2ee6c9;background:rgba(46,230,201,.08);border:1px dashed rgba(46,230,201,.35);border-radius:12px;padding:12px;text-align:center}',
      '.wcs-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:10px 14px;border-radius:11px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#e9f4f9;font-weight:650;font-size:13px;cursor:pointer}',
      '.wcs-btn.primary{border:0;background:linear-gradient(135deg,#2ee6c9,#3aa0ff);color:#03221d}',
      '.wcs-btn:disabled{opacity:.5;cursor:default}',
      '.wcs-list{display:flex;flex-direction:column;gap:6px;max-height:210px;overflow:auto;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:6px}',
      '.wcs-person{display:flex;align-items:center;gap:10px;padding:8px;border-radius:9px;cursor:pointer}',
      '.wcs-person:hover{background:rgba(255,255,255,.04)}',
      '.wcs-av{width:30px;height:30px;border-radius:50%;background:rgba(46,230,201,.16);color:#2ee6c9;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex:none}',
      '.wcs-panel{position:fixed;inset:0;z-index:75;background:#04101a;display:flex;flex-direction:column;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#e9f4f9}',
      '.wcs-panel .hd{display:flex;align-items:center;gap:11px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08);background:#071c2b;flex:none}',
      '.wcs-panel .hd .grow{flex:1;min-width:0}',
      '.wcs-panel .body{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:7px;background:radial-gradient(circle at 50% 0%,rgba(46,230,201,.06),transparent 55%)}',
      '.wcs-msg{max-width:82%;padding:8px 11px;border-radius:13px;background:#0d2839;align-self:flex-start;white-space:pre-wrap;word-break:break-word;font-size:14px}',
      '.wcs-msg.me{align-self:flex-end;background:linear-gradient(135deg,rgba(46,230,201,.28),rgba(58,160,255,.22));border:1px solid rgba(46,230,201,.25)}',
      '.wcs-msg .m{display:flex;align-items:center;gap:6px;justify-content:flex-end;margin-top:4px;font-size:10.5px;color:#8ba4b6}',
      '.wcs-msg .tick{font-size:11px;letter-spacing:-2px}',
      '.wcs-msg .tick.seen{color:#3aa0ff}',
      '.wcs-in{display:flex;gap:8px;padding:10px 12px;border-top:1px solid rgba(255,255,255,.08);background:#071c2b;flex:none}',
      '.wcs-in textarea{flex:1;resize:none;min-height:42px;max-height:120px;border-radius:11px;border:1px solid rgba(255,255,255,.12);background:#04101a;color:#e9f4f9;padding:10px;font:14px/1.4 inherit;outline:none}',
      '.wcs-send{width:42px;height:42px;border-radius:50%;border:0;background:linear-gradient(135deg,#2ee6c9,#3aa0ff);color:#03221d;font-size:18px;cursor:pointer;flex:none}',
      '.wcs-sync{font-size:10.5px;color:#8ba4b6;display:flex;align-items:center;gap:5px}',
      '.wcs-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e}',
      '.wcs-dot.off{background:#f59e0b;box-shadow:0 0 8px #f59e0b}',
      '.wcs-dot.queue{background:#ff4d6d;box-shadow:0 0 8px #ff4d6d}',
      '.wcs-typing{display:flex;align-items:center;gap:8px;padding:0 16px 8px;color:#2ee6c9;font-size:12px;font-style:italic;min-height:22px}',
      '.wcs-typing i{width:5px;height:5px;border-radius:50%;background:#2ee6c9;display:inline-block;animation:wcsB 1.2s infinite}',
      '.wcs-typing i:nth-child(2){animation-delay:.15s}.wcs-typing i:nth-child(3){animation-delay:.3s}',
      '@keyframes wcsB{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}',
      '.wcs-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(255,255,255,.03)}',
      '.wcs-sw{width:44px;height:24px;border-radius:999px;background:rgba(255,255,255,.16);position:relative;cursor:pointer;flex:none;transition:.18s}',
      '.wcs-sw:after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.18s}',
      '.wcs-sw.on{background:#f59e0b}.wcs-sw.on:after{left:23px}',
      '.wcs-members{display:flex;flex-wrap:wrap;gap:6px}',
      '.wcs-chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:#8ba4b6;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:999px;padding:4px 8px}',
      '.wcs-chip b{width:6px;height:6px;border-radius:50%;background:#22c55e}',
      '.wcs-chip b.off{background:#63798a}'
    ].join('\n');
    document.head.appendChild(css);
  }

  function overlay(html) {
    var el = document.createElement('div');
    el.className = 'wcs-ov';
    el.innerHTML = html;
    document.body.appendChild(el);
    el.addEventListener('click', function (ev) { if (ev.target === el) el.remove(); });
    return el;
  }

  /* ------------------------------------------------------------------ *
   *  share modal                                                        *
   * ------------------------------------------------------------------ */
  function currentPeer() {
    try {
      var h = (location.hash || '').replace(/^#\/?/, '').split('?')[0].split('/');
      if (h[0] === 'chat' && h[1]) return decodeURIComponent(h[1]);
    } catch (e) {}
    return '';
  }

  function contactsForPicker() {
    var u = uid(), out = [];
    try {
      var list = (typeof myContacts === 'function') ? myContacts(u) : [];
      list.forEach(function (c) { if (c && c.id !== u) out.push(c); });
    } catch (e) {}
    if (!out.length) {
      try {
        var db = (typeof DB !== 'undefined') ? DB : null;
        (db && db.users || []).forEach(function (x) { if (x && x.id !== u && !x.isAdmin) out.push(x); });
      } catch (e) {}
    }
    return out;
  }

  function openShareModal(presetPeer) {
    injectCSS();
    var peer = presetPeer || currentPeer();
    var u = uid();
    var byPeer = read(LS.byPeer, {});
    var existingCode = (peer && byPeer[peer]) || '';
    var room = existingCode ? rooms()[existingCode] : null;
    var people = contactsForPicker();
    var rows = people.map(function (p) {
      var checked = p.id === peer ? ' checked' : '';
      return '<label class="wcs-person"><input type="checkbox" value="' + esc(p.id) + '"' + checked + '/>' +
        '<span class="wcs-av">' + esc((p.fullName || '?').slice(0, 1).toUpperCase()) + '</span>' +
        '<span class="grow"><span style="font-weight:600">' + esc(p.fullName || p.username || 'Contact') + '</span>' +
        '<span class="wcs-muted" style="display:block">' + (online(p.id) ? 'Online' : 'Offline') + '</span></span></label>';
    }).join('') || '<div class="wcs-muted">Add a contact first — sessions are shared with people you already chat with.</div>';

    var el = overlay(
      '<div class="wcs-card" role="dialog" aria-modal="true">' +
        '<div class="wcs-hd"><div class="grow"><h3>Share Internet Session</h3>' +
          '<div class="wcs-muted">Invite someone into a live, local-first session room. Works over any connection — including a zero-rated tunnel.</div></div>' +
          '<button class="wcs-x" data-close>×</button></div>' +
        '<div class="wcs-bd">' +
          (room ? '<div><div class="wcs-muted" style="margin-bottom:6px">Your session code</div><div class="wcs-code">' + esc(room.code) + '</div></div>'
                : '<div class="wcs-muted">A new session code is created when you invite the first person.</div>') +
          '<div><div class="wcs-muted" style="margin-bottom:6px;font-weight:650;color:#e9f4f9">Who is joining?</div><div class="wcs-list" id="wcsPeople">' + rows + '</div></div>' +
          '<div class="row" style="display:flex;gap:8px">' +
            '<button class="wcs-btn primary" id="wcsCreate" style="flex:1">' + (room ? 'Share session again' : 'Create & invite') + '</button>' +
            (room ? '<button class="wcs-btn" id="wcsOpen">Open room</button>' : '') +
          '</div>' +
          '<div style="border-top:1px solid rgba(255,255,255,.08);padding-top:12px">' +
            '<div class="wcs-muted" style="margin-bottom:6px;font-weight:650;color:#e9f4f9">Have a code or link?</div>' +
            '<div style="display:flex;gap:8px"><input id="wcsJoinCode" style="flex:1;background:#04101a;border:1px solid rgba(255,255,255,.12);border-radius:11px;color:#e9f4f9;padding:10px" placeholder="ABC123" maxlength="16"/>' +
            '<button class="wcs-btn" id="wcsJoin">Join</button></div>' +
          '</div>' +
          '<div id="wcsShareStatus" class="wcs-muted"></div>' +
        '</div>' +
      '</div>');

    el.querySelector('[data-close]').addEventListener('click', function () { el.remove(); });
    el.querySelector('#wcsJoin').addEventListener('click', function () {
      var code = (el.querySelector('#wcsJoinCode').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code) return;
      joinRoom(code).then(function (r) {
        if (r.ok) { el.remove(); openRoom(code); }
        else toastSafe(r.data && r.data.error === 'room_not_found' ? 'No session with that code' : 'Could not join session', 'err');
      });
    });
    el.querySelector('#wcsCreate').addEventListener('click', function () {
      if (state.shareBusy) return;
      var picked = [];
      el.querySelectorAll('#wcsPeople input:checked').forEach(function (i) { picked.push(i.value); });
      if (!picked.length) { toastSafe('Pick at least one contact to invite', 'warn'); return; }
      state.shareBusy = true;
      var btn = el.querySelector('#wcsCreate'); btn.disabled = true; btn.textContent = 'Creating…';
      var name = peer ? ('Session with ' + userName(peer)) : 'Internet session';
      createRoom({ name: name, members: picked, code: existingCode || undefined }).then(function (r) {
        state.shareBusy = false; btn.disabled = false;
        if (!r.ok || !r.data || !r.data.room) { btn.textContent = 'Try again'; toastSafe('Could not create the session', 'err'); return; }
        var rm = r.data.room;
        if (peer) { var bp = read(LS.byPeer, {}); bp[peer] = rm.code; write(LS.byPeer, bp); }
        shareLink(rm.code);
        el.remove();
        openRoom(rm.code);
      }).catch(function () {
        state.shareBusy = false; btn.disabled = false; btn.textContent = 'Try again';
        toastSafe('Offline — try again when the tunnel is up', 'err');
      });
    });
    var openBtn = el.querySelector('#wcsOpen');
    if (openBtn) openBtn.addEventListener('click', function () { el.remove(); openRoom(room.code); });
  }

  function shareLink(code) {
    var link = location.origin + location.pathname + '#/session/' + code;
    var text = 'Join my WhaleChat internet session: ' + link;
    try {
      if (navigator.share) { navigator.share({ title: 'WhaleChat session', text: text, url: link }).catch(function () {}); return; }
    } catch (e) {}
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(function () { toastSafe('Session link copied'); }).catch(function () { prompt('Copy this session link', link); });
        return;
      }
    } catch (e) {}
    try { prompt('Copy this session link', link); } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   *  rooms list modal                                                   *
   * ------------------------------------------------------------------ */
  function openSessionsModal() {
    injectCSS();
    var all = rooms();
    var codes = Object.keys(all).sort(function (a, b) { return (all[b].at || 0) - (all[a].at || 0); });
    var rows = codes.map(function (code) {
      var r = all[code];
      var msgs = messagesOf(code);
      var last = msgs[msgs.length - 1];
      return '<div class="wcs-person" data-room="' + esc(code) + '"><span class="wcs-av">' + esc(code.slice(0, 2)) + '</span>' +
        '<span class="grow"><span style="font-weight:650">' + esc(r.name || 'Session') + ' · ' + esc(code) + '</span>' +
        '<span class="wcs-muted" style="display:block">' + (last ? esc(String(last.text || '').slice(0, 42)) : 'No messages yet') + '</span></span>' +
        '<span class="wcs-muted">' + ((r.members || []).length) + ' 👤</span></div>';
    }).join('') || '<div class="wcs-muted">No sessions yet. Open a chat and tap Share session.</div>';

    var el = overlay('<div class="wcs-card"><div class="wcs-hd"><div class="grow"><h3>Internet sessions</h3>' +
      '<div class="wcs-muted">Live rooms you share with other people</div></div><button class="wcs-x" data-close>×</button></div>' +
      '<div class="wcs-bd"><div class="wcs-list" id="wcsRooms">' + rows + '</div>' +
      '<div style="display:flex;gap:8px"><input id="wcsJoin2" placeholder="Room code" maxlength="16" style="flex:1;background:#04101a;border:1px solid rgba(255,255,255,.12);border-radius:11px;color:#e9f4f9;padding:10px"/>' +
      '<button class="wcs-btn" id="wcsJoin2Btn">Join</button></div></div></div>');
    el.querySelector('[data-close]').addEventListener('click', function () { el.remove(); });
    el.querySelectorAll('[data-room]').forEach(function (n) {
      n.addEventListener('click', function () { var c = n.getAttribute('data-room'); el.remove(); openRoom(c); });
    });
    el.querySelector('#wcsJoin2Btn').addEventListener('click', function () {
      var code = (el.querySelector('#wcsJoin2').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code) return;
      joinRoom(code).then(function (r) { if (r.ok) { el.remove(); openRoom(code); } else toastSafe('Session not found', 'err'); });
    });
    fetchRoomsList();
  }

  function fetchRoomsList() {
    if (!uid()) return;
    getJSON('/api/rooms/list?user=' + encodeURIComponent(uid())).then(function (d) {
      if (!d || !d.ok || !Array.isArray(d.rooms)) return;
      d.rooms.forEach(function (r) { saveRoom(r); state.rooms[r.code] = r; });
      refreshRoomsBadge();
    }).catch(function () {});
  }

  /* ------------------------------------------------------------------ *
   *  room overlay                                                       *
   * ------------------------------------------------------------------ */
  function openRoom(code) {
    injectCSS();
    code = String(code || '').toUpperCase();
    if (!code || !uid()) return;
    state.openCode = code;
    var existing = document.querySelector('.wcs-panel');
    if (existing) existing.remove();

    var room = state.rooms[code] || rooms()[code] || { code: code, name: 'Internet session', members: [] };
    var el = document.createElement('div');
    el.className = 'wcs-panel';
    el.innerHTML =
      '<div class="hd"><button class="wcs-x" data-back>‹</button>' +
        '<div class="grow"><div style="font-weight:700">' + esc(room.name || 'Internet session') + ' · <span style="color:#2ee6c9">' + esc(code) + '</span></div>' +
        '<div class="wcs-members" id="wcsMembers"></div></div>' +
        '<button class="wcs-btn" data-copy style="padding:7px 10px">Share</button>' +
      '</div>' +
      '<div class="body" id="wcsBody"></div>' +
      '<div class="wcs-typing" id="wcsTyping"></div>' +
      '<div class="wcs-in"><textarea id="wcsMsg" rows="1" placeholder="Message the session…"></textarea><button class="wcs-send" data-send>➤</button></div>';
    document.body.appendChild(el);

    el.querySelector('[data-back]').addEventListener('click', function () {
      stopTyping(); state.openCode = ''; el.remove(); refreshRoomsBadge();
      if (codeFromURL()) { try { history.replaceState(null, '', location.pathname + (location.search || '') + '#/home'); render(); } catch (e) {} }
    });
    el.querySelector('[data-copy]').addEventListener('click', function () { shareLink(code); });
    var ta = el.querySelector('#wcsMsg');
    function send() {
      var text = (ta.value || '').trim();
      if (!text) return;
      ta.value = ''; ta.style.height = 'auto';
      stopTyping();
      sendRoomMessage(code, text);
    }
    el.querySelector('[data-send]').addEventListener('click', send);
    ta.addEventListener('input', function () {
      ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
      if (ta.value.trim()) startTyping(code); else stopTyping();
    });
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
    });

    paintRoomMessages(); paintTyping(); paintMembers(); updateSyncBadge();
    joinRoom(code).catch(function () {});
    fetchRoom(code).then(function () { paintRoomMessages(); paintMembers(); markRoomRead(code); syncRoom(code); }).catch(function () { syncRoom(code); });
  }

  function paintMembers() {
    var el = document.getElementById('wcsMembers'); if (!el) return;
    var code = state.openCode; var room = state.rooms[code] || rooms()[code] || {};
    var members = (room.members || []).slice();
    if (!members.length) return;
    el.innerHTML = members.map(function (id) {
      return '<span class="wcs-chip"><b class="' + (online(id) ? '' : 'off') + '"></b>' +
        (id === uid() ? 'You' : esc(userName(id).split(' ')[0])) + '</span>';
    }).join('');
  }

  function tickHTML(m) {
    var st = m.status || ST.SENT;
    var label = st === ST.QUEUED ? '◷' : st === ST.READ ? '✓✓' : st === ST.DELIVERED ? '✓✓' : '✓';
    var cls = st === ST.READ ? ' seen' : '';
    var title = st === ST.QUEUED ? 'Waiting for tunnel' : st === ST.READ ? 'Read' : st === ST.DELIVERED ? 'Delivered' : 'Sent';
    return '<span class="tick' + cls + '" title="' + title + '">' + label + '</span>';
  }

  function paintRoomMessages() {
    var body = document.getElementById('wcsBody'); if (!body) return;
    var code = state.openCode; if (!code) return;
    var list = messagesOf(code);
    var u = uid();
    body.innerHTML = list.map(function (m) {
      if (!m || !m.id) return '';
      var mine = m.from === u;
      return '<div class="wcs-msg' + (mine ? ' me' : '') + '">' +
        (mine ? '' : '<div style="font-size:10.5px;color:#2ee6c9;margin-bottom:2px">' + esc(userName(m.from).split(' ')[0]) + '</div>') +
        esc(m.text || '') + '<div class="m"><span>' + clock(m.createdAt) + '</span>' + (mine ? tickHTML(m) : '') + '</div></div>';
    }).join('') || '<div class="wcs-muted" style="text-align:center;margin-top:30px">This room is empty. Send the first message — it is painted locally before the network even wakes up.</div>';
    body.scrollTop = body.scrollHeight;
  }

  function paintTyping() {
    var el = document.getElementById('wcsTyping'); if (!el) return;
    var code = state.openCode; if (!code) return;
    var map = state.typing[code] || {};
    var who = Object.keys(map).filter(function (id) { return Date.now() - map[id] < 4000; });
    if (!who.length) { el.innerHTML = ''; return; }
    var names = who.map(function (id) { return userName(id).split(' ')[0]; }).join(', ');
    el.innerHTML = '<span>' + esc(names) + ' typing</span><i></i><i></i><i></i>';
  }

  function markRoomRead(code) {
    var u = uid(); if (!u) return;
    var ids = messagesOf(code).filter(function (m) { return m && m.from !== u && (m.readBy || []).indexOf(u) < 0; }).map(function (m) { return m.id; });
    if (!ids.length || !networkUp()) return;
    postJSON('/api/rooms/read', { userId: u, code: code, ids: ids.slice(0, 400) }, 7000).catch(function () {});
  }

  function updateSyncBadge() {
    /* Offline status is intentionally not shown as a banner. Messages queue
       quietly and drain through syncRoom() when the link returns. */
    var el = document.getElementById('wcsSync');
    if (el) el.innerHTML = '';
  }

  function refreshRoomsBadge() {
    var fab = document.getElementById('wcsFab'); if (!fab) return;
    var all = rooms();
    var n = 0;
    Object.keys(all).forEach(function (code) {
      var msgs = messagesOf(code);
      msgs.forEach(function (m) { if (m && m.from !== uid() && (m.readBy || []).indexOf(uid()) < 0) n++; });
    });
    var badge = fab.querySelector('.wcs-badge');
    if (n && !badge) { badge = document.createElement('span'); badge.className = 'wcs-badge'; fab.appendChild(badge); }
    if (badge) { badge.textContent = n > 99 ? '99+' : String(n); badge.style.display = n ? '' : 'none'; }
  }

  /* ------------------------------------------------------------------ *
   *  share button in the chat header + floating sessions button         *
   * ------------------------------------------------------------------ */
  function ensureShareButton() {
    var head = document.querySelector('.chat-room .chat-head');
    if (head && !head.querySelector('.wcs-share-btn')) {
      var btn = document.createElement('button');
      btn.className = 'btn-icon wcs-share-btn';
      btn.title = 'Share internet session';
      btn.style.width = '36px'; btn.style.height = '36px';
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>';
      btn.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); openShareModal(); });
      var menu = head.querySelector('[data-act="chat-menu"]');
      if (menu) head.insertBefore(btn, menu); else head.appendChild(btn);
    }
    if (!document.getElementById('wcsFab') && uid()) {
      var fab = document.createElement('button');
      fab.id = 'wcsFab'; fab.className = 'wcs-fab'; fab.title = 'Internet sessions';
      fab.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg><span>Session</span>';
      fab.addEventListener('click', function () { openSessionsModal(); });
      document.body.appendChild(fab);
      refreshRoomsBadge();
    }
  }

  function watchDOM() {
    if (state.observer) return;
    var queued = false;
    state.observer = new MutationObserver(function () {
      if (queued) return; queued = true;
      requestAnimationFrame(function () { queued = false; try { ensureShareButton(); } catch (e) {} });
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------ *
   *  routing / deep links                                               *
   * ------------------------------------------------------------------ */
  function codeFromURL() {
    try {
      var m = /^#\/session\/([A-Za-z0-9]{4,16})/.exec(location.hash || '');
      if (m) return m[1].toUpperCase();
      var q = new URLSearchParams(location.search).get('session');
      if (q) return q.toUpperCase();
    } catch (e) {}
    return '';
  }
  function handleRoute() {
    var code = codeFromURL();
    if (!code) return;
    if (!uid()) { write(LS.pendingJoin, code); return; }
    if (state.openCode === code) return;
    joinRoom(code).then(function (r) {
      if (r.ok) openRoom(code);
      else toastSafe('That session is no longer available', 'err');
    }).catch(function () { openRoom(code); });
  }

  try {
    window.WCS = window.WCS || {};
    window.WCS.syncRoom = syncRoom;
    window.WCS.messages = messagesOf;
    window.WCS.outbox = outbox;
    window.WCS.flush = flushOutbox;
    window.WCS.send = function (code, text) { return sendRoomMessage(code, text); };
    window.WCS.openRoom = function (code) { try { openRoom(code); } catch (e) {} };
  } catch (e) {}

  /* ------------------------------------------------------------------ *
   *  boot                                                               *
   * ------------------------------------------------------------------ */
  var started = false;
  function start() {
    if (started) return;
    if (!uid()) { setTimeout(start, 800); return; }
    started = true;
    injectCSS();
    wireRealtime();
    watchDOM();
    ensureShareButton();
    fetchRoomsList();
    flushOutbox();
    var pending = read(LS.pendingJoin, '');
    if (pending) {
      try { localStorage.removeItem(LS.pendingJoin); } catch (e) {}
      joinRoom(pending).then(function (r) { if (r.ok) openRoom(pending); }).catch(function () {});
    }
    handleRoute();
    window.addEventListener('hashchange', handleRoute);
    window.addEventListener('online', function () { flushOutbox(); updateSyncBadge(); if (state.openCode) syncRoom(state.openCode); fetchRoomsList(); });
    window.addEventListener('offline', updateSyncBadge);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { flushOutbox(); if (state.openCode) syncRoom(state.openCode); fetchRoomsList(); }
    });
    setInterval(function () { if (outbox().length && networkUp()) flushOutbox(); }, 2000);
    /* the offline webhook: while a room is open, pull only the other
       members' messages every 3 s even if the SSE stream dropped */
    setInterval(function () { if (state.openCode) syncRoom(state.openCode); }, 3000);
    setInterval(function () { fetchRoomsList(); if (state.openCode) syncRoom(state.openCode); }, 12000);
    setInterval(refreshRoomsBadge, 8000);
    try { console.info('[wcs] internet sessions ready'); } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else setTimeout(start, 400);
  setTimeout(start, 2500);
})();
