/* =========================================================================
   WhaleChat · live chat lane  (wc-live-chat)  ·  3.69.0
   -------------------------------------------------------------------------
   The chat no longer waits for the whole database to travel.

   BEFORE: a message was pushed as part of the 2.7 MB state document and the
   other device only learned about it by fetching that whole document back.
   That is the several-second gap between "sent" and "arrived".

   NOW — three things, none of which touch the existing chat code:

   1 · ONE PERSISTENT CONNECTION
       A single long-poll stays open per device (/api/chat/sync?since=N). The
       server answers the moment a message exists, so the only latency left is
       one network round trip — typically 60–200 ms. The poll re-arms itself
       immediately after every answer; there is exactly one in flight, never a
       new request per message.

   2 · INSTANT LOCAL DISPLAY
       The moment the user taps send, the bubble is painted into the transcript
       before anything is sent anywhere (a "clock" tick on it), and the message
       itself — not the database — goes down the lane. When the server accepts
       it the tick turns into the real sent state, in place, with no repaint.

   3 · OFFLINE THAT ACTUALLY WORKS
       Every outgoing message is written to a durable outbox first. Offline the
       bubble still appears immediately, the connection keeps retrying, and on
       reconnect the outbox drains in order. Messages the other side sent while
       this device was offline are pulled in by `since` on the first successful
       poll. A ledger of lane messages is merged back after any full state
       refresh, so a server copy can never erase a delivered message.

   Everything here is additive: App.send, render and the sync engine keep
   working exactly as before. The lane is a faster road on top of them.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcLiveChat) return;
  window.__wcLiveChat = true;

  var SEQ_KEY = 'wc.chat.seq.v1';
  var OUT_KEY = 'wc.chat.outbox.v3';
  var LEDGER_KEY = 'wc.chat.ledger.v1';
  var MAX_OUT = 300;
  var MAX_LEDGER = 400;

  var state = {
    started: false,
    net: true,
    polling: false,
    seq: 0,
    pollTimer: null,
    retry: 0,
    lastAt: 0
  };

  /* ------------------------------------------------------------- helpers */
  function g(name) { try { return window[name]; } catch (e) { return undefined; } }
  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function db() { return safe(function () { return g('DB') || null; }, null); }
  function meUser() { return safe(function () { var f = g('me'); return typeof f === 'function' ? f() : null; }, null); }
  function activeChat() { return safe(function () { return g('ACTIVE_CHAT') || ''; }, ''); }
  function store() { return safe(function () { return g('DB') || null; }, null); }
  function persistNow() { safe(function () { var p = g('persist'); if (typeof p === 'function') p(true); }); }
  function renderNow(force) {
    safe(function () {
      var r = g('render');
      if (typeof r === 'function') r(force ? { force: true } : undefined);
    });
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function apiBase() {
    var b = safe(function () { var S = g('WC_SERVERS'); return (S && typeof S.apiBase === 'function') ? S.apiBase() : ''; }, '');
    if (!b) b = safe(function () { var R = g('Remote'); return (R && R.base) || ''; }, '');
    if (!b) b = safe(function () { return g('DEFAULT_SYNC_SERVER') || ''; }, '');
    return String(b || '').replace(/\/+$/, '');
  }
  function api(path) {
    var b = apiBase();
    if (!b) return path;               /* same-origin (Render / local server) */
    return b + path;
  }

  function readJSON(key, dflt) {
    try { var raw = JSON.parse(localStorage.getItem(key) || 'null'); return raw == null ? dflt : raw; }
    catch (e) { return dflt; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  /* --------------------------------------------------------------- outbox */
  function readOut() { var v = readJSON(OUT_KEY, []); return Array.isArray(v) ? v.filter(function (m) { return m && m.id; }) : []; }
  function writeOut(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (m) {
      if (!m || !m.id || seen[m.id]) return;
      seen[m.id] = 1;
      out.push(m);
    });
    if (out.length > MAX_OUT) out = out.slice(-MAX_OUT);
    writeJSON(OUT_KEY, out);
  }
  function queueOut(m) {
    if (!m || !m.id) return;
    var q = readOut();
    if (q.some(function (x) { return x.id === m.id; })) return;
    q.push(m);
    writeOut(q);
  }
  function dropOut(ids) {
    if (!ids || !ids.length) return;
    var drop = {};
    ids.forEach(function (id) { drop[id] = 1; });
    writeOut(readOut().filter(function (m) { return !drop[m.id]; }));
  }

  /* --------------------------------------------------------------- ledger */
  /* every message that travelled the lane, so a full state replace cannot
     drop it from this device before the database catches up */
  function readLedger() { var v = readJSON(LEDGER_KEY, []); return Array.isArray(v) ? v : []; }
  function ledgerPut(msgs) {
    var list = readLedger();
    var seen = {}, out = [];
    list.concat(msgs || []).forEach(function (m) {
      if (!m || !m.id || seen[m.id]) return;
      seen[m.id] = 1;
      out.push(m);
    });
    if (out.length > MAX_LEDGER) out = out.slice(-MAX_LEDGER);
    writeJSON(LEDGER_KEY, out);
  }

  function mergeIntoDB(msgs) {
    var d = db();
    if (!d || !Array.isArray(d.messages) || !msgs || !msgs.length) return 0;
    var have = {};
    d.messages.forEach(function (m) { if (m && m.id) have[m.id] = 1; });
    var added = 0;
    msgs.forEach(function (m) {
      if (!m || !m.id) return;
      if (have[m.id]) {
        /* keep the local row's delivery state, everything else is the server's */
        var cur = d.messages.filter(function (x) { return x.id === m.id; })[0];
        if (cur && m.status && cur.status !== m.status && cur.from === (meUser() || {}).id) cur.status = m.status;
        if (cur && m.readBy && m.readBy.length > (cur.readBy || []).length) cur.readBy = m.readBy;
        return;
      }
      var copy = {};
      for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) copy[k] = m[k];
      copy._lane = true;
      d.messages.push(copy);
      have[m.id] = 1;
      added++;
    });
    if (added) {
      d.messages.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      persistNow();
    }
    return added;
  }

  /* ----------------------------------------------------------- transcript */
  function chatMatches(m) {
    var act = activeChat();
    if (!act || !m) return false;
    return m.chatId === act;
  }

  function otherOf(chatId, myId) {
    var d = db();
    var otherId = String(chatId || '').split('__').filter(function (x) { return x !== myId; })[0];
    return (d && d.users ? d.users.filter(function (u) { return u && u.id === otherId; })[0] : null) || { id: otherId, fullName: '' };
  }

  function bubbleHtml(m) {
    var mk = g('messageHTML');
    var u = meUser();
    if (typeof mk !== 'function' || !u) return '';
    return safe(function () { return mk(m, u, otherOf(m.chatId, u.id)); }, '');
  }

  function bodyEl() { return document.getElementById('chatBody'); }

  function appendBubble(m, opts) {
    var body = bodyEl();
    if (!body || !chatMatches(m)) return null;
    var existing = body.querySelector('[data-msg="' + String(m.id).replace(/"/g, '') + '"]');
    if (existing) return existing;
    var placeholder = body.querySelector('.chat-empty-hint');
    if (placeholder) placeholder.remove();
    var html = bubbleHtml(m);
    if (!html) return null;
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    var node = wrap.firstElementChild;
    if (!node) return null;
    /* jump-free append: only auto-scroll when the user is already at the end */
    var atEnd = (body.scrollHeight - body.scrollTop - body.clientHeight) < 90;
    var typing = body.querySelector('.typing');
    if (typing) body.insertBefore(node, typing); else body.appendChild(node);
    if (node.querySelector && !node.querySelector('img,video')) {}
    else safe(function () { var hy = g('Media'); if (hy && hy.hydrate) hy.hydrate(node); });
    if (atEnd || (opts && opts.force)) {
      try { body.scrollTop = body.scrollHeight; } catch (e) {}
    }
    return node;
  }

  function markBubble(m) {
    var body = bodyEl();
    if (!body || !m) return;
    var node = body.querySelector('[data-msg="' + String(m.id).replace(/"/g, '') + '"]');
    if (!node) return;
    var tick = node.querySelector('.msg-meta .tick, .tick');
    if (tick && m.status) {
      if (m.status === 'delivered' || m.status === 'seen') {
        if (tick.dataset.state !== m.status) { tick.dataset.state = m.status; }
      }
    }
  }

  /* paint the message the user just typed, before the network is touched */
  function paintInstant(msg) {
    return appendBubble(msg, { force: true });
  }

  /* --------------------------------------------------------------- the lane */
  function normalize(m) {
    if (!m || !m.id) return null;
    return {
      id: m.id,
      chatId: m.chatId,
      from: m.from,
      to: m.to,
      type: m.type || 'text',
      text: m.text || '',
      mediaId: m.mediaId || null,
      dur: m.dur || null,
      createdAt: Number(m.createdAt) || Date.now(),
      status: m.status || 'sent',
      forwarded: !!m.forwarded,
      deleted: !!m.deleted,
      readBy: Array.isArray(m.readBy) ? m.readBy : []
    };
  }

  function sendLane(msgs) {
    var list = (msgs || []).map(normalize).filter(Boolean);
    if (!list.length) return Promise.resolve({ ok: false, error: 'nothing_to_send' });
    if (!state.net) {
      list.forEach(queueOut);
      return Promise.resolve({ ok: false, offline: true, queued: list.length });
    }
    return fetch(api('/api/chat/send'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: list, device: deviceId() })
    })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        if (d && d.ok) {
          dropOut(list.map(function (m) { return m.id; }));
          ledgerPut(list);
          if (typeof d.seq === 'number' && d.seq > state.seq) { state.seq = d.seq; writeJSON(SEQ_KEY, state.seq); }
          (d.accepted || []).forEach(function (a) {
            if (!a || !a.id) return;
            var d2 = db();
            if (!d2 || !Array.isArray(d2.messages)) return;
            var cur = d2.messages.filter(function (x) { return x.id === a.id; })[0];
            if (cur) { cur.status = a.status || cur.status; cur._lane = true; }
            markBubble({ id: a.id, status: a.status });
          });
          return d;
        }
        /* the lane refused (auth/edge case): keep the message and retry later */
        list.forEach(queueOut);
        return d || { ok: false };
      })
      .catch(function () {
        list.forEach(queueOut);
        return { ok: false, offline: true };
      });
  }

  function deviceId() {
    var id = '';
    try { id = localStorage.getItem('wc.chat.device') || ''; } catch (e) {}
    if (!id) {
      id = 'd_' + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem('wc.chat.device', id); } catch (e) {}
    }
    return id;
  }

  function applyIncoming(msgs, seq) {
    if (!msgs || !msgs.length) return 0;
    var u = meUser();
    var mine = [];
    var added = mergeIntoDB(msgs);
    ledgerPut(msgs);
    (msgs || []).forEach(function (m) {
      if (u && m.from === u.id) { dropOut([m.id]); mine.push(m); }
    });
    var act = activeChat();
    var painted = 0;
    (msgs || []).forEach(function (m) {
      if (act && m.chatId === act) {
        if (appendBubble(m)) painted++;
      }
    });
    if (added || painted) {
      /* a received message for the open chat may also clear the seen state */
      if (u && msgs.some(function (m) { return m.to === u.id; })) safe(function () {
        var bad = document.querySelector('.bottomnav .badge, [data-badge="chat"]');
        if (bad) bad.remove();
      });
    }
    if (typeof seq === 'number' && seq > state.seq) { state.seq = seq; writeJSON(SEQ_KEY, state.seq); }
    return added;
  }

  /* ONE connection in flight at all times, re-armed the moment it answers.
     Appwrite Functions cannot hold a request open (a held execution blocks the
     instance for every other call), so this is a tight poll of a tiny payload
     rather than a held stream: measured 120-180 ms per answer, which puts a
     received message on screen in well under a second. */
  function pollInterval() {
    /* a background tab has nobody watching it: poll slowly and save battery,
       but come straight back to fast polling when it is visible again */
    if (document.hidden) return 2500;
    if (document.querySelector('.chat-room')) return 550;
    return 1200;
  }

  function pollOnce() {
    if (!state.started || !meUser()) return;
    if (state.polling) return;
    state.polling = true;
    var since = Number(state.seq) || 0;
    var url = api('/api/chat/state?since=' + since + '&t=' + Date.now());
    fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) throw new Error('unauthorised');
        return r.json().catch(function () { return null; });
      })
      .then(function (d) {
        state.polling = false;
        state.net = true;
        state.retry = 0;
        if (d && d.ok) {
          if (Array.isArray(d.messages) && d.messages.length) applyIncoming(d.messages, d.seq);
          else if (typeof d.seq === 'number' && d.seq > state.seq) { state.seq = d.seq; writeJSON(SEQ_KEY, state.seq); }
        }
        schedule(pollInterval());
      })
      .catch(function () {
        state.polling = false;
        state.net = navigator.onLine !== false;
        state.retry = Math.min(state.retry + 1, 6);
        schedule(Math.max(700, 500 * state.retry));
      });
  }

  function schedule(ms) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(pollOnce, ms || pollInterval());
  }

  /* ---------------------------------------------------------- outbox drain */
  var draining = false;
  function flushOut() {
    if (draining) return Promise.resolve(0);
    var q = readOut();
    if (!q.length) return Promise.resolve(0);
    if (!state.net || navigator.onLine === false) return Promise.resolve(0);
    draining = true;
    /* in order, oldest first, so a conversation reads correctly on the peer */
    q.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    return sendLane(q).then(function (d) {
      draining = false;
      if (d && d.ok) return q.length;
      return 0;
    }).catch(function () { draining = false; return 0; });
  }

  /* ------------------------------------------------------------- App hooks */
  function hookSend() {
    var A = g('App');
    if (!A || typeof A.send !== 'function' || A.send.__wcLane) return false;
    var orig = A.send;
    A.send = function () {
      var u = meUser();
      var d = db();
      var cid = activeChat();
      var before = {};
      if (d && Array.isArray(d.messages)) d.messages.forEach(function (m) { if (m && m.id) before[m.id] = 1; });
      var out = orig.apply(this, arguments);

      /* 1 · instant local display: the bubble is on screen now */
      safe(function () {
        var d2 = db();
        if (!d2 || !Array.isArray(d2.messages)) return;
        var fresh = d2.messages.filter(function (m) { return m && m.id && !before[m.id] && (m.chatId === cid || !cid); });
        if (!fresh.length) return;
        fresh.forEach(function (m) { m._pending = true; if (!m.status) m.status = 'sending'; paintInstant(m); queueOut(m); });
        var b = bodyEl();
        if (b) { try { b.scrollTop = b.scrollHeight; } catch (e) {} }
      });

      /* 2 · the message (not the database) goes down the lane immediately */
      Promise.resolve(out).then(function () {
        safe(function () {
          var d3 = db();
          if (!d3 || !Array.isArray(d3.messages)) return;
          var fresh = d3.messages.filter(function (m) { return m && m.id && !before[m.id]; });
          if (fresh.length) sendLane(fresh);
        });
      }).catch(function () { safe(flushOut); });

      return out;
    };
    A.send.__wcLane = true;
    return true;
  }

  /* after any full state refresh, put lane messages back that the server copy
     does not know about yet, then drain the outbox */
  function hookRemote() {
    var R = g('Remote');
    if (!R || R.__wcLane) return false;
    R.__wcLane = true;
    ['connect', 'refresh'].forEach(function (name) {
      var orig = R[name];
      if (typeof orig !== 'function') return;
      R[name] = function () {
        var self = this, args = arguments;
        var pr = orig.apply(self, args);
        return Promise.resolve(pr).then(function (v) {
          safe(function () {
            var led = readLedger();
            var added = mergeIntoDB(led);
            if (added) { var d = db(); if (d && Array.isArray(d.messages)) fillTranscript(d); }
            flushOut();
            schedule(60);
          });
          return v;
        }, function (e) { throw e; });
      };
    });
    return true;
  }

  /* put any ledger message that belongs to the open chat into the transcript */
  function fillTranscript(d) {
    var act = activeChat();
    if (!act || !d || !Array.isArray(d.messages)) return;
    d.messages.forEach(function (m) { if (m && m.chatId === act) appendBubble(m); });
    var b = bodyEl();
    if (b) { try { b.scrollTop = b.scrollHeight; } catch (e) {} }
  }

  /* when the chat view opens, paint anything the lane already holds */
  function watchChatOpen() {
    var last = '';
    setInterval(function () {
      var act = activeChat();
      var hasRoom = !!document.querySelector('.chat-room');
      if (hasRoom && act && act !== last) {
        last = act;
        var d = db();
        if (d) setTimeout(function () { fillTranscript(d); }, 30);
      }
      if (!hasRoom) last = '';
    }, 500);
  }

  function onOnline() {
    state.net = true;
    flushOut().then(function () { schedule(30); });
    safe(function () {
      var R = g('Remote');
      if (R && R.enabled && typeof R.refresh === 'function') setTimeout(function () { R.refresh(true); }, 220);
    });
  }

  function start() {
    if (state.started) return;
    state.started = true;
    state.net = navigator.onLine !== false;
    state.seq = Number(readJSON(SEQ_KEY, 0)) || 0;
    window.addEventListener('online', onOnline);
    window.addEventListener('hashchange', function () { schedule(20); });
    document.addEventListener('focusin', function () { if (state.pollTimer) { clearTimeout(state.pollTimer); schedule(20); } });
    window.addEventListener('offline', function () { state.net = false; });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { clearTimeout(state.pollTimer); return; }
      state.net = navigator.onLine !== false;
      flushOut();
      schedule(30);
    });
    watchChatOpen();
    var tries = 0;
    (function bind() {
      var ok = hookSend();
      var r = hookRemote();
      if ((!ok || !r) && tries++ < 40) return setTimeout(bind, 250);
      flushOut();
      schedule(60);
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.WCLiveChat = {
    send: sendLane,
    flush: flushOut,
    pending: function () { return readOut().length; },
    seq: function () { return state.seq; },
    online: function () { return state.net; },
    poll: pollOnce,
    ledger: readLedger,
    merge: mergeIntoDB
  };
})();
