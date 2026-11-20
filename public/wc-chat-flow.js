/* =========================================================================
   WhaleChat chat flow  (wc-chat-flow)  ·  3.67.0
   -------------------------------------------------------------------------
   One module for the four chat problems reported on the live app:

   1. QUIET OFFLINE UI
      The "Offline — the app keeps working from your device" toast, the
      "Offline · saved on device" pill, the "Device mode" banner, the
      "Waiting for network" badges and the session-guard offline chip are all
      suppressed. Offline support keeps working; the app simply stops
      announcing that it is offline.

   2. MESSAGES THAT SURVIVE OFFLINE AND ARRIVE FAST
      Every outgoing message is written to the local database immediately and
      kept in a small durable queue (localStorage, so a reconnect cannot wipe
      it). When the connection returns — or when another device receives the
      message — the queue is merged back into the synced database and pushed
      to the server with no artificial debounce. A reconnect can no longer
      replace the database with the server copy and silently drop messages
      written while offline. Incoming changes are pulled within ~120 ms
      instead of waiting up to 6 s.

   3. KEYBOARD-SAFE COMPOSER
      The device keyboard must never cover the message box. The module tracks
      window.visualViewport and sizes the chat shell to the visible area, so
      the composer always sits directly above the keyboard and the last
      message stays in view.

   4. FAST SEND FEEDBACK
      The fake 1.2 s delivery re-render is replaced by the real server state:
      the bubble appears at once, the chat scrolls instantly and the message
      is pushed to the server in the same tick.

   Nothing in the existing chat / trading code is removed. The module only
   adds behaviour on top of it.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcChatFlow) return;
  window.__wcChatFlow = true;

  var QUEUE_KEY = 'wc.chat.outbox.v2';
  var MAX_QUEUE = 400;
  var OFFLINE_TOAST = /^(offline\b|offline\s*[—·:-]|waiting for network|device mode\b|no internet connection)/i;

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function online() { return navigator.onLine !== false; }
  function app() { return safe(function () { return (typeof App !== 'undefined') ? App : null; }, null); }
  function store() { return safe(function () { return (typeof DB !== 'undefined') ? DB : null; }, null); }
  function remote() { return safe(function () { return (typeof Remote !== 'undefined') ? Remote : null; }, null); }
  function live() { return safe(function () { return (typeof INV !== 'undefined') ? INV : null; }, null); }
  function meSafe() { return safe(function () { return (typeof me === 'function') ? me() : null; }, null); }
  function syncNow() {
    safe(function () { if (typeof persist === 'function') persist(true); });
    safe(function () { if (typeof sync === 'function') sync(); });
  }
  function renderNow() { safe(function () { if (typeof render === 'function') render(); }); }

  /* ------------------------------------------------------------------ 1
     Quiet offline UI
     ------------------------------------------------------------------ */
  function installQuietStyles() {
    if (document.getElementById('wc-quiet-offline-css')) return;
    var st = document.createElement('style');
    st.id = 'wc-quiet-offline-css';
    st.textContent =
      /* notices that shouted "offline" ------------------------------- */
      '#wcNetPill,#wcOfflineChip,.wc-net-pill,.wc-device-mode,' +
      'html.wc-is-offline body::after{display:none!important}' +
      'html.wc-is-offline [data-wc-offline-badge]{display:none!important}' +
      '.wc-pending-badge{display:none!important}' +
      /* keyboard-safe layout ----------------------------------------- */
      'html.wc-kb-open .shell{height:var(--wc-vvh,100dvh)!important;min-height:0!important}' +
      'html.wc-kb-open .main.chat-mode .content{height:var(--wc-vvh,100dvh)!important;min-height:0!important}' +
      'html.wc-kb-open .chat-room{height:var(--wc-vvh,100dvh)!important;min-height:0!important}' +
      'html.wc-kb-open .main.chat-mode .bottomnav{display:none!important}' +
      'html.wc-kb-open .chat-input{padding-bottom:8px!important}' +
      'html.wc-kb-open .chat-body{overflow-anchor:none}' +
      '.chat-input textarea{scroll-margin-bottom:120px}' +
      /* one-screen chat: the room owns the height, the body scrolls ---- */
      '.main.chat-mode .content{height:100dvh;overflow:hidden;padding:0!important}' +
      '.chat-room{height:100%;min-height:0}' +
      '.chat-room .chat-body{overscroll-behavior:contain}' +
      /* live trading chart skin (matches the reference board) --------- */
      '.wc-live-chart{display:flex;flex-direction:column;gap:6px;min-width:0}' +
      '.wc-live-host{width:100%;min-width:0}' +
      'html body .wc-live-chart .wck.inline{background:linear-gradient(180deg,#0c1720,#0a141d)!important;' +
      '  border:1px solid rgba(255,255,255,.07)!important;border-radius:14px!important;padding:8px 10px 4px!important}' +
      '.wc-live-chart .wck-top{display:none}' +
      '.wc-live-chart .wck-ctrls{margin:2px 0 4px}' +
      '.wc-live-caption{font-size:10.5px;line-height:1.55;color:var(--muted,#8ba4b6);text-align:center;padding:6px 6px 0}' +
      '.wc-live-caption b{color:var(--text,#cfe6ef);font-weight:700}' +
      '.wc-live-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:9.5px;font-weight:700;' +
      'letter-spacing:.06em;text-transform:uppercase;color:#7d93a5}' +
      '.wc-live-meta .dot{width:5px;height:5px;border-radius:50%;background:#31e0a0;box-shadow:0 0 8px #31e0a0;animation:wckPulse 1.6s infinite}' +
      '.wc-live-meta .muted{color:#5f7788;letter-spacing:.02em;text-transform:none;font-weight:600}' +
      '.wc-live-meta .right{margin-left:auto;color:#8ba4b6;font-weight:600;text-transform:none;letter-spacing:.02em}';
    document.head.appendChild(st);
  }

  function suppressOfflineNotices() {
    var original = window.toast;
    if (typeof original === 'function' && !original.__wcQuiet) {
      var wrapped = function (msg, kind, ms) {
        if (OFFLINE_TOAST.test(String(msg == null ? '' : msg).trim())) return;
        return original.call(window, msg, kind, ms);
      };
      wrapped.__wcQuiet = true;
      window.toast = wrapped;
    }
    var sweep = function () {
      ['wcNetPill', 'wcOfflineChip'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) { try { el.remove(); } catch (e) { el.style.display = 'none'; } }
      });
      document.querySelectorAll('.wc-device-mode').forEach(function (el) {
        try { el.remove(); } catch (e) { el.style.display = 'none'; }
      });
      document.querySelectorAll('.wc-pending-badge').forEach(function (el) { el.remove(); });
    };
    sweep();
    setInterval(sweep, 900);
    window.addEventListener('offline', sweep);
  }

  /* ------------------------------------------------------------------ 2
     Durable outgoing-message queue + merge after a resync
     ------------------------------------------------------------------ */
  function readQueue() {
    try {
      var raw = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(function (m) { return m && m.id; }) : [];
    } catch (e) { return []; }
  }
  function writeQueue(list) {
    try {
      var seen = {}, out = [];
      (list || []).forEach(function (m) {
        if (!m || !m.id || seen[m.id] || m.deleted) return;
        seen[m.id] = 1;
        out.push(m);
      });
      if (out.length > MAX_QUEUE) out = out.slice(-MAX_QUEUE);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(out));
    } catch (e) {}
  }
  function enqueueMessage(m) {
    if (!m || !m.id || m.deleted) return;
    var q = readQueue();
    if (!q.some(function (x) { return x.id === m.id; })) {
      q.push({
        id: m.id, chatId: m.chatId, from: m.from, to: m.to, type: m.type || 'text',
        text: m.text || '', mediaId: m.mediaId || null, dur: m.dur || null,
        createdAt: m.createdAt || Date.now(), status: m.status || 'sent',
        forwarded: !!m.forwarded, deleted: false, readBy: m.readBy || []
      });
    }
    writeQueue(q);
  }
  function dequeue(ids) {
    if (!ids || !ids.length) return;
    var drop = {};
    ids.forEach(function (id) { drop[id] = 1; });
    writeQueue(readQueue().filter(function (m) { return !drop[m.id]; }));
  }

  /* After the server copy has replaced the local one, put every message that
     this device created while offline back into the database. The diff push
     then delivers it. Returns the number merged. */
  function mergeQueuedMessages() {
    var dbx = store();
    if (!dbx || !Array.isArray(dbx.messages)) return 0;
    var q = readQueue();
    if (!q.length) return 0;
    var have = {};
    dbx.messages.forEach(function (m) { if (m && m.id) have[m.id] = 1; });
    var add = q.filter(function (m) { return !have[m.id] && !m.deleted; });
    if (!add.length) return 0;
    add.forEach(function (m) {
      var copy = Object.assign({}, m);
      copy._pending = true;
      copy._pendingAt = copy._pendingAt || Date.now();
      if (!copy.status || copy.status === 'seen') copy.status = 'sent';
      dbx.messages.push(copy);
    });
    dbx.messages.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    try { if (typeof persist === 'function') persist(true); } catch (e) {}
    return add.length;
  }

  function pruneQueueAgainst(dbx) {
    var q = readQueue();
    if (!q.length || !dbx || !Array.isArray(dbx.messages)) return;
    var have = {};
    dbx.messages.forEach(function (m) { if (m && m.id) have[m.id] = 1; });
    writeQueue(q.filter(function (m) { return !have[m.id]; }));
  }

  function pushNow() {
    var R = remote();
    if (!R || !R.enabled || !online()) return;
    if (R.applying || R.flushing) return;
    R.dirty = true;
    try { clearTimeout(R.timer); } catch (e) {}
    try { R.flush(); } catch (e) {}
  }

  function hookSend() {
    var A = app();
    if (!A || typeof A.send !== 'function' || A.send.__wcFlow) return false;
    var orig = A.send;
    A.send = function () {
      var dbx = store();
      var before = {};
      if (dbx && Array.isArray(dbx.messages)) dbx.messages.forEach(function (m) { if (m && m.id) before[m.id] = 1; });
      var out = orig.apply(this, arguments);
      Promise.resolve(out).then(function () {
        var d = store();
        if (!d || !Array.isArray(d.messages)) return;
        var fresh = d.messages.filter(function (m) { return m && m.id && !before[m.id]; });
        if (!fresh.length) return;
        fresh.forEach(function (m) {
          if (!online()) { m._pending = true; m._pendingAt = Date.now(); }
          enqueueMessage(m);
        });
        /* rewrite the local store so the bubbles are durable even before the
           server answers; this is what a reconnect now merges back in */
        try { if (typeof persist === 'function') persist(true); } catch (e) {}
        if (online()) pushNow();
        scrollChatToEnd(true);
      }).catch(function () {});
      return out;
    };
    A.send.__wcFlow = true;
    return true;
  }

  function hookDelete() {
    var A = app();
    if (!A || typeof A.deleteMessage !== 'function' || A.deleteMessage.__wcFlow) return;
    var orig = A.deleteMessage;
    A.deleteMessage = function (id) {
      dequeue([id]);
      return orig.apply(this, arguments);
    };
    A.deleteMessage.__wcFlow = true;
  }

  /* remote resync wrappers: merge the queue before the push is computed */
  function hookRemote() {
    var R = remote();
    if (!R || R.__wcChatFlow) return false;
    R.__wcChatFlow = true;

    function afterResync() {
      var merged = mergeQueuedMessages();
      pruneQueueAgainst(store());
      if (merged > 0) {
        renderNow();
        pushNow();
      }
      scrollChatToEnd(false);
    }

    var connect = R.connect;
    R.connect = async function () {
      var ok = await connect.apply(this, arguments);
      if (ok) afterResync();
      return ok;
    };

    var refresh = R.refresh;
    R.refresh = async function () {
      var r = await refresh.apply(this, arguments);
      afterResync();
      return r;
    };

    /* A new message must leave the device in the same tick, not after 140 ms. */
    R.onLocalChange = function () {
      if (!this.enabled || this.applying) return;
      this.dirty = true;
      clearTimeout(this.timer);
      this.timer = setTimeout(function () { try { R.flush(); } catch (e) {} }, 30);
    };
    return true;
  }

  /* incoming changes: pull within ~120 ms when the user is idle, and never
     defer for more than 1.4 s while they are typing in the composer */
  function hookIncoming() {
    if (typeof window.scheduleRemoteRefresh !== 'function' || window.scheduleRemoteRefresh.__wcFlow) return;
    window.scheduleRemoteRefresh = function () {
      var R = remote();
      if (!R) return;
      if (R._refreshTimer) return;
      var started = Date.now();
      var run = function () {
        if (document.hidden) { R._refreshTimer = null; R._refreshOnShow = true; return; }
        var busy = safe(function () { return typeof wcUserBusy === 'function' && wcUserBusy(); }, false);
        if (busy && Date.now() - started < 1400) { R._refreshTimer = setTimeout(run, 200); return; }
        R._refreshTimer = null;
        R._lastRefreshAt = Date.now();
        try { R.refresh(); } catch (e) {}
      };
      R._refreshTimer = setTimeout(run, 120);
    };
    window.scheduleRemoteRefresh.__wcFlow = true;
  }

  function onOnline() {
    var R = remote();
    var dbx = store();
    if (dbx) {
      /* show the queued bubbles as sending again, then merge + push */
      mergeQueuedMessages();
    }
    if (R && R.enabled) {
      pushNow();
      /* a full pull brings in everything the other side sent while we were
         offline; it is cheap because the server answers with one state doc */
      setTimeout(function () { try { R.refresh(true); } catch (e) {} }, 180);
    }
    scrollChatToEnd(false);
  }

  /* ------------------------------------------------------------------ 3
     Keyboard-safe composer
     ------------------------------------------------------------------ */
  var kbTimer = 0;
  function viewportHeight() {
    var vv = window.visualViewport;
    if (!vv) return window.innerHeight || 0;
    return Math.round(vv.height);
  }
  function keyboardOverlap() {
    var vv = window.visualViewport;
    if (!vv) return 0;
    return Math.max(0, Math.round((window.innerHeight || 0) - vv.height - (vv.offsetTop || 0)));
  }
  function isChatOpen() {
    return !!(document.body && document.body.dataset && document.body.dataset.route === 'chat') ||
      !!document.querySelector('.chat-room');
  }
  function scrollChatToEnd(instant) {
    var body = document.getElementById('chatBody');
    if (!body) return;
    try { body.scrollTo({ top: body.scrollHeight, behavior: instant ? 'auto' : 'smooth' }); }
    catch (e) { body.scrollTop = body.scrollHeight; }
    var inp = document.getElementById('msgInput');
    if (inp && document.activeElement === inp && keyboardOverlap() > 120) {
      try { inp.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    }
  }
  function applyViewport() {
    var h = viewportHeight();
    var overlap = keyboardOverlap();
    var open = overlap > 120;
    var root = document.documentElement;
    if (h > 0) root.style.setProperty('--wc-vvh', h + 'px');
    if (open && isChatOpen()) {
      root.classList.add('wc-kb-open');
      clearTimeout(kbTimer);
      kbTimer = setTimeout(function () { scrollChatToEnd(true); }, 80);
    } else {
      root.classList.remove('wc-kb-open');
      if (open) setTimeout(function () { scrollChatToEnd(false); }, 40);
    }
  }
  function hookKeyboard() {
    var m = document.querySelector('meta[name="viewport"]');
    if (m) {
      var content = m.getAttribute('content') || '';
      if (!/interactive-widget/.test(content)) {
        m.setAttribute('content', content.replace(/\s*$/, '') + ', interactive-widget=resizes-content');
      }
    }
    var vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', applyViewport, { passive: true });
      vv.addEventListener('scroll', applyViewport, { passive: true });
    }
    window.addEventListener('resize', applyViewport);
    window.addEventListener('orientationchange', function () { setTimeout(applyViewport, 220); });
    document.addEventListener('focusin', function (ev) {
      var t = ev.target;
      if (!t || t.id !== 'msgInput') return;
      setTimeout(function () { applyViewport(); scrollChatToEnd(true); }, 280);
    });
    document.addEventListener('focusout', function (ev) {
      if (ev.target && ev.target.id === 'msgInput') setTimeout(applyViewport, 180);
    });
    applyViewport();
  }

  /* keep the newest message visible whenever the chat view is (re)painted */
  var lastChat = '';
  function watchChatView() {
    setInterval(function () {
      var room = document.querySelector('.chat-room');
      var id = room ? (location.hash || '') : '';
      if (room && id !== lastChat) {
        lastChat = id;
        setTimeout(function () { scrollChatToEnd(true); }, 60);
      }
      if (!room) lastChat = '';
    }, 700);
  }

  /* fast, non-rebuilding delivery mark (used by the chat code) */
  window.wcMessageDelivered = function (ids) {
    var d = store();
    if (!d || !Array.isArray(d.messages) || !ids) return;
    var set = {};
    (Array.isArray(ids) ? ids : [ids]).forEach(function (x) { set[x] = 1; });
    d.messages.forEach(function (m) { if (set[m.id] && m.status === 'sent') m.status = 'delivered'; });
    try { if (typeof persist === 'function') persist(true); } catch (e) {}
    /* let Remote push the delivered status to the sender as well */
    pushNow();
  };

  /* ------------------------------------------------------------------ 4
     Boot
     ------------------------------------------------------------------ */
  function start() {
    installQuietStyles();
    suppressOfflineNotices();
    hookKeyboard();
    watchChatView();
    /* the app globals are defined before this module runs, but retry briefly
       for slow boots / restored sessions */
    var tries = 0;
    (function bind() {
      var ok = hookSend();
      hookDelete();
      var r = hookRemote();
      hookIncoming();
      if ((!ok || !r) && tries++ < 40) setTimeout(bind, 250);
    })();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', function () { /* stay silent */ });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (online()) onOnline();
      applyViewport();
    });
    /* messages are visible immediately after a send */
    var A = app();
    if (A && typeof A.send === 'function') scrollChatToEnd(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
