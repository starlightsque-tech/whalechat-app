/* =========================================================================
   WhaleChat · live chat lane  (wc-live-chat)  ·  3.71.0
   -------------------------------------------------------------------------
   Messages no longer wait for the whole database to travel, and they no
   longer depend on a poll either.

   TRANSPORTS, in the order the lane tries them
     1 · SSE — the app's own Node server  (/api/chat/stream)
         The server holds one response open per device and writes a frame the
         instant a message is accepted: 10–40 ms on a warm server.
     2 · HOSTED WEBSOCKET — Pusher Channels or Ably, configured on the server
         (/api/realtime/config). The Appwrite Function cannot hold an SSE
         response open, so this is the low-latency road on the Appwrite
         deployment: 50–100 ms, delivered by the provider's edge.
     3 · POLL — the original tiny /api/chat/state poll, kept forever as the
         fallback (and as a safety net even while a socket is healthy).

   WHAT DOES NOT CHANGE
     · the offline outbox (durable, drained in order on reconnect)
     · the lane ledger (a full state refresh can never erase a delivered message)
     · App.send / render / the sync engine — everything is additive.

   ONE PERSON'S ACTION ON ANOTHER PERSON'S SCREEN
     Sending is one half. The lane also carries typing, read receipts and
     presence on the same personal channel, and the receiver paints the bubble
     the moment it lands — with the chat open, closed, or coming back online.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcLiveChat) return;
  window.__wcLiveChat = true;

  var SEQ_KEY = 'wc.chat.seq.v1';
  var EV_KEY = 'wc.chat.evseq.v1';
  var OUT_KEY = 'wc.chat.outbox.v3';
  var LEDGER_KEY = 'wc.chat.ledger.v1';
  var MAX_OUT = 300;
  var MAX_LEDGER = 400;

  var state = {
    started: false,
    net: true,
    seq: 0,
    evSeq: 0,
    transport: 'boot',      /* boot | stream | pusher | ably | poll */
    provider: null,
    es: null,
    ws: null,
    wsSocketId: '',
    pollTimer: null,
    retryTimer: null,
    polling: false,
    retry: 0,
    streamFails: 0,
    wsFails: 0,
    lastAt: 0,
    lastTypingSent: 0,
    lastReadSent: 0,
    room: '',
    online: {}
  };

  /* ------------------------------------------------------------- helpers */
  function g(name) { try { return window[name]; } catch (e) { return undefined; } }
  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function db() { return safe(function () { return g('DB') || null; }, null); }
  function meUser() { return safe(function () { var f = g('me'); return typeof f === 'function' ? f() : null; }, null); }
  function activeChat() { return safe(function () { return g('ACTIVE_CHAT') || ''; }, ''); }
  function persistNow() { safe(function () { var p = g('persist'); if (typeof p === 'function') p(true); }); }
  function renderNow(force) {
    safe(function () {
      var r = g('render');
      if (typeof r === 'function') r(force ? { force: true } : undefined);
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
  function deviceId() {
    var id = '';
    try { id = localStorage.getItem('wc.chat.device') || ''; } catch (e) {}
    if (!id) {
      id = 'd_' + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem('wc.chat.device', id); } catch (e) {}
    }
    return id;
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

  function known(m, d) {
    if (!m || !m.chatId || !d || !Array.isArray(d.users)) return false;
    if (String(m.chatId).indexOf('__') < 0) return false;
    return d.users.some(function (u) { return u && u.id === m.from; }) &&
      d.users.some(function (u) { return u && u.id === m.to; });
  }

  function mergeIntoDB(msgs) {
    var d = db();
    if (!d || !Array.isArray(d.messages) || !msgs || !msgs.length) return 0;
    msgs = msgs.filter(function (m) { return known(m, d); });
    if (!msgs.length) return 0;
    var have = {};
    d.messages.forEach(function (m) { if (m && m.id) have[m.id] = 1; });
    var added = 0;
    msgs.forEach(function (m) {
      if (!m || !m.id) return;
      if (have[m.id]) {
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
    if (m.readBy && m.readBy.length) node.setAttribute('data-read', String(m.readBy.length));
  }

  function paintInstant(msg) { return appendBubble(msg, { force: true }); }

  function fillTranscript(d) {
    var act = activeChat();
    if (!act || !d || !Array.isArray(d.messages)) return;
    d.messages.forEach(function (m) { if (m && m.chatId === act) appendBubble(m); });
    var b = bodyEl();
    if (b) { try { b.scrollTop = b.scrollHeight; } catch (e) {} }
  }

  /* --------------------------------------------------------------- typing */
  function typingEl(show, who) {
    var body = bodyEl();
    if (!body) return;
    var el = body.querySelector('.wc-typing');
    if (!show) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'wc-typing typing';
      el.style.cssText = 'padding:6px 14px;font-size:12px;color:var(--muted);display:flex;gap:6px;align-items:center';
      el.innerHTML = '<span class="dot" style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block"></span><span class="grow">typing…</span>';
      body.appendChild(el);
    }
    var label = el.querySelector('.grow');
    if (label) label.textContent = (who || 'typing') + ' is typing…';
    try { body.scrollTop = body.scrollHeight; } catch (e) {}
  }

  function showPresence(on) {
    var head = document.querySelector('.chat-room .chat-head, .chat-room .chat-top');
    if (!head) return;
    var dot = head.querySelector('.wc-presence');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'wc-presence';
      dot.style.cssText = 'width:7px;height:7px;border-radius:50%;display:inline-block;margin-left:6px;background:currentColor;opacity:.5';
      head.appendChild(dot);
    }
    dot.style.background = on ? '#22c55e' : 'rgba(255,255,255,.25)';
    dot.title = on ? 'Online' : 'Offline';
  }

  function sendRead() {
    var u = meUser();
    var act = activeChat();
    var d = db();
    if (!u || !act || !d || !Array.isArray(d.messages)) return;
    if (Date.now() - state.lastReadSent < 1200) return;
    var ids = d.messages.filter(function (m) {
      return m && m.chatId === act && m.to === u.id && !m.deleted && !(Array.isArray(m.readBy) && m.readBy.indexOf(u.id) >= 0);
    }).map(function (m) { return m.id; }).slice(0, 200);
    if (!ids.length) return;
    state.lastReadSent = Date.now();
    ids.forEach(function (id) {
      var m = d.messages.filter(function (x) { return x.id === id; })[0];
      if (m) { m.readBy = Array.isArray(m.readBy) ? m.readBy : []; if (m.readBy.indexOf(u.id) < 0) m.readBy.push(u.id); }
    });
    if (state.net) {
      fetch(api('/api/chat/read'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: u.id, ids: ids, chatId: act })
      }).catch(function () {});
    }
  }

  /* --------------------------------------------------------------- the lane */
  function normalize(m) {
    if (!m || !m.id) return null;
    return {
      id: m.id, chatId: m.chatId, from: m.from, to: m.to,
      type: m.type || 'text', text: m.text || '',
      mediaId: m.mediaId || null, dur: m.dur || null,
      createdAt: Number(m.createdAt) || Date.now(),
      status: m.status || 'sent',
      forwarded: !!m.forwarded, deleted: !!m.deleted,
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
            if (cur) { cur.status = a.status || cur.status; cur._lane = true; cur._pending = false; }
            markBubble({ id: a.id, status: a.status });
          });
          return d;
        }
        list.forEach(queueOut);
        return d || { ok: false };
      })
      .catch(function () {
        list.forEach(queueOut);
        return { ok: false, offline: true };
      });
  }

  function applyIncoming(msgs, seq) {
    if (!msgs || !msgs.length) return 0;
    var u = meUser();
    var added = mergeIntoDB(msgs);
    ledgerPut(msgs);
    (msgs || []).forEach(function (m) { if (u && m.from === u.id) dropOut([m.id]); });
    var act = activeChat();
    var painted = 0;
    var dNow = db();
    (msgs || []).forEach(function (m) {
      if (act && m.chatId === act && known(m, dNow)) {
        if (appendBubble(m)) painted++;
        if (u && m.to === u.id) typingEl(false);
      }
    });
    if (added || painted) {
      if (u && msgs.some(function (m) { return m.to === u.id; })) safe(function () {
        var bad = document.querySelector('.bottomnav .badge, [data-badge="chat"]');
        if (bad) bad.remove();
      });
      if (act && u && msgs.some(function (m) { return m.chatId === act && m.to === u.id; })) {
        setTimeout(sendRead, 120);
      }
      if (act) setTimeout(function () { fillTranscript(db()); }, 20);
    }
    if (typeof seq === 'number' && seq > state.seq) { state.seq = seq; writeJSON(SEQ_KEY, state.seq); }
    return added;
  }

  function applyEvent(ev) {
    if (!ev || !ev.type) return;
    var u = meUser();
    if (!u) return;
    if (ev.type === 'typing') {
      if (ev.from === u.id) return;
      var act = activeChat();
      if (act && ev.chatId === act) typingEl(!!ev.typing, (otherOf(act, u.id) || {}).fullName);
      return;
    }
    if (ev.type === 'read') {
      var d = db();
      if (!d || !Array.isArray(d.messages)) return;
      var by = ev.by || ev.from;
      var ids = ev.ids || [];
      (ev.messages || []).forEach(function (m) {
        if (m && m.id && ids.indexOf(m.id) < 0) ids.push(m.id);
      });
      ids.forEach(function (id) {
        var cur = d.messages.filter(function (x) { return x.id === id; })[0];
        if (!cur) return;
        cur.readBy = Array.isArray(cur.readBy) ? cur.readBy : [];
        if (by && cur.readBy.indexOf(by) < 0) cur.readBy.push(by);
        cur.status = 'seen';
        markBubble({ id: id, status: 'seen', readBy: cur.readBy });
      });
      persistNow();
      return;
    }
    if (ev.type === 'presence') {
      var who = ev.userId || ev.from;
      if (!who || who === u.id) return;
      state.online[who] = ev.online !== false;
      var act2 = activeChat();
      if (act2 && String(act2).indexOf(who) >= 0) showPresence(state.online[who]);
    }
  }

  /* ------------------------------------------------------- provider frames */
  function handleFrame(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.kind === 'message' && payload.id) {
      var d = db();
      var have = d && Array.isArray(d.messages) && d.messages.some(function (m) { return m && m.id === payload.id; });
      if (have) {
        applyIncoming(d.messages.filter(function (m) { return m.id === payload.id; }), payload.seq);
      } else if (payload.message && payload.message.id) {
        /* the provider frame carries the body: paint it now, then let the
           normal lane confirm the sequence */
        applyIncoming([payload.message], payload.seq);
        schedule(30);
      } else {
        schedule(0);
      }
      return;
    }
    if (payload.kind === 'typing' || payload.kind === 'read' || payload.kind === 'presence') {
      applyEvent(Object.assign({ type: payload.kind }, payload));
      return;
    }
    if (payload.kind === 'sms') {
      safe(function () {
        var A = window.WCAdminSms;
        if (A && typeof A.onLive === 'function') A.onLive(payload);
      });
    }
  }

  /* --------------------------------------------------------------- SSE lane */
  function streamUrl() {
    var u = meUser() || {};
    return api('/api/chat/stream?since=' + (Number(state.seq) || 0) +
      '&evSince=' + (Number(state.evSeq) || 0) +
      '&userId=' + encodeURIComponent(u.id || '') +
      '&chatId=' + encodeURIComponent(activeChat() || '') +
      '&device=' + encodeURIComponent(deviceId()) +
      '&t=' + Date.now());
  }

  function startStream() {
    stopTransports();
    if (typeof EventSource === 'undefined' || !state.net) return startPoll('stream-unavailable');
    state.transport = 'stream';
    var es;
    try { es = new EventSource(streamUrl()); } catch (e) { return startPoll('stream-error'); }
    state.es = es;
    es.addEventListener('hello', function () { state.streamFails = 0; });
    es.addEventListener('messages', function (e) {
      var d = safe(function () { return JSON.parse(e.data); }, null);
      if (!d) return;
      state.lastAt = Date.now();
      state.streamFails = 0;
      applyIncoming(d.messages, d.seq);
    });
    es.addEventListener('events', function (e) {
      var d = safe(function () { return JSON.parse(e.data); }, null);
      if (!d || !Array.isArray(d.events)) return;
      state.evSeq = Math.max(state.evSeq, Number(d.seq) || 0);
      writeJSON(EV_KEY, state.evSeq);
      d.events.forEach(applyEvent);
    });
    es.onerror = function () {
      state.streamFails += 1;
      if (state.streamFails >= 2) {
        try { es.close(); } catch (e2) {}
        state.es = null;
        /* EventSource retries on its own; after two failures ask the server
           what this deployment can actually do, then pick the next road */
        bootTransports(true);
      }
    };
    scheduleWatchdog();
  }

  /* ------------------------------------------------------ hosted provider */
  function pusherChannels(cfg) {
    var u = meUser() || {};
    var list = [];
    var prefix = (cfg.channelPrefix || 'wc');
    if (u.id) list.push(prefix + '-user-' + String(u.id).replace(/[^a-zA-Z0-9_@=.,;-]/g, ''));
    var act = activeChat();
    if (act) list.push(prefix + '-room-' + String(act).replace(/[^a-zA-Z0-9_@=.,;-]/g, ''));
    return list;
  }

  function startPusher(cfg) {
    stopTransports();
    if (!state.net || typeof WebSocket === 'undefined') return startPoll('ws-unavailable');
    state.transport = 'pusher';
    state.provider = cfg;
    var ws;
    try {
      ws = new WebSocket('wss://' + (cfg.wsHost || ('ws-' + cfg.cluster + '.pusher.com')) +
        '/app/' + cfg.key + '?protocol=7&client=wc-live-chat&version=8.4.0&flash=false');
    } catch (e) { return startPoll('ws-error'); }
    state.ws = ws;
    var subscribed = false;
    function subscribeAll(socketId) {
      state.wsSocketId = socketId;
      pusherChannels(cfg).forEach(function (raw) {
        var channel = cfg.secure ? 'private-' + raw : raw;
        var done = function (auth) {
          var msg = { event: 'pusher:subscribe', data: { channel: channel } };
          if (auth && auth.auth) msg.data.auth = auth.auth;
          try { ws.send(JSON.stringify(msg)); } catch (e) {}
        };
        if (!cfg.secure) return done(null);
        fetch(api(cfg.authEndpoint || '/api/realtime/auth'), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ socket_id: socketId, channel_name: channel })
        }).then(function (r) { return r.json(); }).then(function (auth) { done(auth && auth.auth ? auth : null); })
          .catch(function () { done(null); });
      });
    }
    ws.onopen = function () { state.wsFails = 0; };
    ws.onmessage = function (ev) {
      var msg = safe(function () { return JSON.parse(ev.data); }, null);
      if (!msg) return;
      state.lastAt = Date.now();
      if (msg.event === 'pusher:connection_established') {
        var data = safe(function () { return JSON.parse(msg.data); }, {});
        subscribeAll(data.socket_id);
        return;
      }
      if (msg.event === 'pusher_internal:subscription_succeeded') { subscribed = true; state.wsFails = 0; return; }
      if (msg.event === 'pusher:ping') { try { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); } catch (e) {} return; }
      if (msg.event === 'pusher:error') { return; }
      if (msg.event === 'wc' || msg.event === 'chat.message' || msg.event === 'chat.event') {
        var payload = safe(function () { return typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data; }, null);
        handleFrame(payload);
      }
    };
    ws.onclose = function () {
      state.ws = null;
      state.wsFails += 1;
      if (state.wsFails >= 3) return startPoll('ws-closed');
      setTimeout(function () { if (state.transport === 'pusher' && !state.ws) startPusher(cfg); }, Math.min(8000, 600 * state.wsFails));
    };
    ws.onerror = function () { /* onclose follows */ };
    var ping = setInterval(function () {
      if (!state.ws || state.ws.readyState !== 1) return clearInterval(ping);
      try { state.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch (e) {}
    }, 25000);
    scheduleWatchdog();
  }

  function startAbly(cfg) {
    stopTransports();
    if (!state.net || typeof EventSource === 'undefined') return startPoll('ably-unavailable');
    state.transport = 'ably';
    state.provider = cfg;
    var channels = pusherChannels(cfg);
    if (!channels.length) { channels = [((cfg.channelPrefix || 'wc') + '-admin')]; }
    fetch(api((cfg.tokenEndpoint || '/api/realtime/token') + '?channels=' + encodeURIComponent(channels.join(',')) + '&clientId=' + encodeURIComponent((meUser() || {}).id || deviceId())))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.token) return startPoll('ably-token');
        var url = 'https://' + (cfg.realtimeHost || 'realtime.ably.io') + '/sse?channels=' +
          encodeURIComponent(channels.join(',')) + '&v=1.2&accessToken=' + encodeURIComponent(d.token) + '&t=' + Date.now();
        var es;
        try { es = new EventSource(url); } catch (e) { return startPoll('ably-error'); }
        state.es = es;
        es.onmessage = function (ev) {
          var frame = safe(function () { return JSON.parse(ev.data); }, null);
          if (!frame) return;
          state.lastAt = Date.now();
          if (frame.name !== (cfg.event || 'wc')) return;
          var payload = safe(function () { return typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data; }, null);
          handleFrame(payload);
        };
        es.onerror = function () {
          state.wsFails += 1;
          try { es.close(); } catch (e) {}
          state.es = null;
          /* an Ably token lives for an hour: fetch a fresh one before giving up */
          if (state.wsFails < 3) {
            setTimeout(function () { if (state.transport === 'ably' || state.wsFails < 3) startAbly(cfg); }, Math.min(8000, 600 * state.wsFails));
          } else {
            startPoll('ably-closed');
          }
        };
        scheduleWatchdog();
      })
      .catch(function () { startPoll('ably-token-failed'); });
  }

  /* --------------------------------------------------------------- polling */
  function pollInterval() {
    if (document.hidden) return 3000;
    /* a healthy socket keeps this as a slow safety net; polling alone is fast */
    if (state.transport === 'stream' || state.transport === 'pusher' || state.transport === 'ably') return 5000;
    if (document.querySelector('.chat-room') && Date.now() - state.lastAt < 90000) return 200;
    if (document.querySelector('.chat-room')) return 900;
    return 1200;
  }

  function pollOnce() {
    if (!state.started || !meUser()) return;
    if (state.polling) return;
    state.polling = true;
    var since = Number(state.seq) || 0;
    var who = (meUser() || {}).id || '';
    var url = api('/api/chat/state?since=' + since + '&evSince=' + (Number(state.evSeq) || 0) +
      '&userId=' + encodeURIComponent(who) + '&chatId=' + encodeURIComponent(activeChat() || '') +
      '&t=' + Date.now());
    fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (d) {
        state.polling = false;
        state.net = true;
        state.retry = 0;
        if (d && d.ok) {
          state.lastAt = Date.now();
          if (Array.isArray(d.messages) && d.messages.length) applyIncoming(d.messages, d.seq);
          else if (typeof d.seq === 'number' && d.seq > state.seq) { state.seq = d.seq; writeJSON(SEQ_KEY, state.seq); }
          if (Array.isArray(d.events) && d.events.length) {
            state.evSeq = Math.max(state.evSeq, Number(d.evSeq) || 0);
            d.events.forEach(applyEvent);
          }
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

  function startPoll(reason) {
    stopTransports();
    state.transport = 'poll';
    if (reason) state.provider = state.provider || null;
    schedule(40);
  }

  function stopTransports() {
    if (state.es) { try { state.es.close(); } catch (e) {} state.es = null; }
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
  }

  function schedule(ms) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(pollOnce, ms || pollInterval());
  }

  var watchdog = null;
  function scheduleWatchdog() {
    if (watchdog) clearInterval(watchdog);
    watchdog = setInterval(function () {
      if (!state.started) return;
      if (state.transport === 'poll') return;
      /* nothing heard on a socket for 60 s: re-arm rather than stay silent */
      if (Date.now() - state.lastAt > 60000) {
        if (state.transport === 'stream') { stopTransports(); startStream(); }
        else bootTransports(true);
      }
    }, 25000);
  }

  /* Ask the deployment what it can do, then open the best road. */
  function bootTransports(force) {
    if (!state.net) return startPoll('offline');
    var health = fetch(api('/api/health'), { cache: 'no-store' })
      .then(function (r) { return r.json(); }).catch(function () { return null; });
    var cfgP = fetch(api('/api/realtime/config'), { cache: 'no-store' })
      .then(function (r) { return r.json(); }).catch(function () { return null; });
    Promise.all([health, cfgP]).then(function (both) {
      var h = both[0], cfg = both[1];
      state.provider = cfg && cfg.enabled ? cfg : null;
      var canStream = !!(h && h.stream === true);
      if (canStream && (state.transport !== 'stream' || force)) return startStream();
      if (cfg && cfg.enabled) {
        if (cfg.provider === 'pusher') return startPusher(cfg);
        if (cfg.provider === 'ably') return startAbly(cfg);
      }
      /* the Appwrite Function and any older server land here */
      return startPoll('no-stream');
    }).catch(function () { startPoll('probe-failed'); });
  }

  /* ---------------------------------------------------------- outbox drain */
  var draining = false;
  function flushOut() {
    if (draining) return Promise.resolve(0);
    var q = readOut();
    if (!q.length) return Promise.resolve(0);
    if (!state.net || navigator.onLine === false) return Promise.resolve(0);
    draining = true;
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

      safe(function () {
        var d2 = db();
        if (!d2 || !Array.isArray(d2.messages)) return;
        var fresh = d2.messages.filter(function (m) { return m && m.id && !before[m.id] && (m.chatId === cid || !cid); });
        if (!fresh.length) return;
        fresh.forEach(function (m) { m._pending = true; if (!m.status) m.status = 'sending'; paintInstant(m); queueOut(m); });
        var b = bodyEl();
        if (b) { try { b.scrollTop = b.scrollHeight; } catch (e) {} }
      });

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

  /* typing + read + presence on the wire */
  function hookComposer() {
    if (window.__wcTypingHooked) return;
    window.__wcTypingHooked = true;
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || t.id !== 'msgInput') return;
      var u = meUser(); var act = activeChat();
      if (!u || !act || !state.net) return;
      if (Date.now() - state.lastTypingSent < 900) return;
      state.lastTypingSent = Date.now();
      var other = String(act).split('__').filter(function (x) { return x !== u.id; })[0] || '';
      fetch(api('/api/chat/typing'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: u.id, to: other, chatId: act, typing: !!String(t.value || '').trim() })
      }).catch(function () {});
    }, true);
    document.addEventListener('focusin', function (e) {
      if (e.target && e.target.id === 'msgInput') sendRead();
    });
    window.addEventListener('keyup', function (e) {
      if (e && e.target && e.target.id === 'msgInput') sendRead();
    });
  }

  function watchChatOpen() {
    var last = '';
    setInterval(function () {
      var act = activeChat();
      var hasRoom = !!document.querySelector('.chat-room');
      if (hasRoom && act && act !== last) {
        last = act;
        state.room = act;
        var d = db();
        if (d) setTimeout(function () { fillTranscript(d); sendRead(); }, 30);
        /* re-arm the personal lane so room typing/read events reach this tab */
        if (state.transport === 'stream') { stopTransports(); startStream(); }
        else if (state.transport === 'pusher' && state.provider) { /* room channel added on next reconnect */ }
      }
      if (!hasRoom) { last = ''; typingEl(false); }
    }, 500);
  }

  function onOnline() {
    state.net = true;
    bootTransports(true);
    flushOut().then(function () { schedule(30); });
    safe(function () {
      var R = g('Remote');
      if (R && R.enabled && typeof R.refresh === 'function') setTimeout(function () { R.refresh(true); }, 220);
    });
    var u = meUser();
    if (u) fetch(api('/api/chat/presence'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id, online: true }) }).catch(function () {});
  }

  function start() {
    if (state.started) return;
    state.started = true;
    state.net = navigator.onLine !== false;
    state.seq = Number(readJSON(SEQ_KEY, 0)) || 0;
    state.evSeq = Number(readJSON(EV_KEY, 0)) || 0;
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', function () { state.net = false; stopTransports(); });
    window.addEventListener('hashchange', function () { state.lastAt = Date.now(); schedule(20); });
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
      window.addEventListener(ev, function () { state.lastAt = Date.now(); }, { passive: true, capture: true });
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { clearTimeout(state.pollTimer); return; }
      state.net = navigator.onLine !== false;
      state.lastAt = Date.now();
      flushOut();
      schedule(30);
    });
    watchChatOpen();
    hookComposer();
    var tries = 0;
    (function bind() {
      var ok = hookSend();
      var r = hookRemote();
      if ((!ok || !r) && tries++ < 40) return setTimeout(bind, 250);
      flushOut();
      bootTransports(false);
      var u = meUser();
      if (u) fetch(api('/api/chat/presence'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id, online: true }) }).catch(function () {});
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
    transport: function () { return state.transport; },
    provider: function () { return state.provider; },
    poll: pollOnce,
    reconnect: function () { bootTransports(true); },
    ledger: readLedger,
    merge: mergeIntoDB,
    typing: function (typing) {
      var u = meUser(); var act = activeChat();
      if (!u || !act) return;
      var other = String(act).split('__').filter(function (x) { return x !== u.id; })[0] || '';
      fetch(api('/api/chat/typing'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: u.id, to: other, chatId: act, typing: typing !== false }) }).catch(function () {});
    }
  };
})();
