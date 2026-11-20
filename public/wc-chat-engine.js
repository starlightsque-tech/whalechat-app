/* =========================================================================
   WhaleChat · chat engine  (wc-chat-engine)  ·  3.73.0
   -------------------------------------------------------------------------
   User types -> message is on screen and in the phone's database INSTANTLY,
   the network happens afterwards.

   1 · SEND (optimistic, ~0 ms)
       App.send already pushes the bubble synchronously. This engine then
       writes the message to IndexedDB (WhaleChatDB.messages) and to the
       Outbox, marks it "sending" (clock tick) and clears the way for the
       background sync. The input box is cleared by the app itself.

   2 · BACKGROUND SYNC (Outbox, every 2 s)
         online  -> create the Appwrite document (documentId = message id, so a
                    retry can never duplicate) -> status "sent" (single tick)
         fail    -> keep it, retry after 5 s, 10 s, 30 s
         offline -> nothing at all; on "online" the same drain runs immediately
       The legacy realtime lane is still mirrored for server-side push and as a
       delivery backstop, but it does not drive the ticks any more.

   3 · RECEIVE (Appwrite Realtime, one subscription for the app's lifetime)
       client.subscribe('databases.<db>.collections.messages.documents')
       -> save to IndexedDB -> merge into the open transcript instantly, or
       leave it for the unread badge. No polling.

   4 · HISTORY (cache first)
       Open a chat: the IndexedDB copy is merged and painted first, then the
       last 100 documents are fetched in the background and merged.

   5 · STATUS
       clock = in the outbox · single = Appwrite accepted ·
       double = the other device received it · blue double = read.
       Delivery/read are written back to the document by the receiving device,
       so the sender's realtime subscription updates the tick.

   Configuration comes from WC_SERVERS (public ids only). The Appwrite key is
   never used in the browser: the collection grants create/read/update to the
   app's clients, exactly like the existing chat endpoint did.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcChatEngine) return;
  window.__wcChatEngine = true;

  var CFG = {
    endpoint: 'https://nyc.cloud.appwrite.io/v1',
    project: '6aff3eda000983f5a975',
    database: '6aff488e0006a3fe39e0',
    collection: 'messages'
  };
  try {
    var S = window.WC_SERVERS;
    if (S && S.appwrite) {
      if (S.appwrite.endpoint) CFG.endpoint = String(S.appwrite.endpoint).replace(/\/+$/, '');
      if (S.appwrite.projectId) CFG.project = S.appwrite.projectId;
      if (S.appwrite.databaseId) CFG.database = S.appwrite.databaseId;
    }
  } catch (e) {}
  var CHANNEL = 'databases.' + CFG.database + '.collections.' + CFG.collection + '.documents';
  var DOCS_URL = CFG.endpoint + '/databases/' + CFG.database + '/collections/' + CFG.collection + '/documents';

  var state = {
    started: false,
    idb: null,
    realtime: null,
    rtOpen: false,
    syncing: false,
    lastChat: '',
    historyAt: {},
    deliveredAt: {},
    readAt: {},
    outboxTimer: null,
    errors: 0
  };

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function g(name) { try { return window[name]; } catch (e) { return undefined; } }
  function meUser() { return safe(function () { var f = g('me'); return typeof f === 'function' ? f() : null; }, null); }
  function db() { return safe(function () { return g('DB') || null; }, null); }
  function activeChat() { return safe(function () { return g('ACTIVE_CHAT') || ''; }, ''); }
  function persist() { safe(function () { var p = g('persist'); if (typeof p === 'function') p(true); }); }
  function dispatch(name, detail) {
    safe(function () { window.dispatchEvent(new CustomEvent(name, { detail: detail })); });
  }
  function serverBase() {
    var b = safe(function () { var S2 = g('WC_SERVERS'); return (S2 && typeof S2.apiBase === 'function') ? S2.apiBase() : ''; }, '');
    if (!b) b = safe(function () { var R = g('Remote'); return (R && R.base) || ''; }, '');
    if (!b) b = safe(function () { return g('DEFAULT_SYNC_SERVER') || ''; }, '');
    return String(b || '').replace(/\/+$/, '');
  }
  function nowMs() { return Date.now(); }

  /* ===================================================================== *
   * IndexedDB — the phone's own copy. Native IDB, no library to load first,
   * so a save can never wait for a CDN.
   * ===================================================================== */
  function openDb() {
    if (state.idb) return Promise.resolve(state.idb);
    return new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open('WhaleChatDB', 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('messages')) {
          var m = d.createObjectStore('messages', { keyPath: 'id' });
          m.createIndex('chatId', 'chatId', { unique: false });
          m.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!d.objectStoreNames.contains('outbox')) {
          var o = d.createObjectStore('outbox', { keyPath: 'id' });
          o.createIndex('chatId', 'chatId', { unique: false });
          o.createIndex('nextAt', 'nextAt', { unique: false });
        }
      };
      req.onsuccess = function () { state.idb = req.result; resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('indexeddb_unavailable')); };
    });
  }

  function idbDo(store, mode, fn) {
    return openDb().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(store, mode);
        var os = tx.objectStore(store);
        var out = fn(os);
        tx.oncomplete = function () { resolve(out && out.__req ? out.__req.result : out); };
        tx.onerror = function () { reject(tx.error || new Error('idb_error')); };
        tx.onabort = function () { reject(tx.error || new Error('idb_aborted')); };
      });
    });
  }

  function putMessage(m) {
    if (!m || !m.id) return Promise.resolve();
    var row = {
      id: m.id, chatId: m.chatId, from: m.from, to: m.to, type: m.type || 'text',
      text: m.text || '', mediaId: m.mediaId || null, dur: m.dur || null,
      createdAt: Number(m.createdAt) || nowMs(), status: m.status || 'sent',
      readBy: Array.isArray(m.readBy) ? m.readBy.slice() : [], docId: m.$id || null
    };
    return idbDo('messages', 'readwrite', function (os) { os.put(row); }).catch(function () {});
  }
  function putMessages(list) {
    return Promise.all((list || []).map(putMessage));
  }
  function chatFromCache(chatId) {
    return openDb().then(function (d) {
      return new Promise(function (resolve) {
        var tx = d.transaction('messages', 'readonly');
        var idx = tx.objectStore('messages').index('chatId');
        var rows = [];
        idx.openCursor(IDBKeyRange.only(String(chatId))).onsuccess = function (e) {
          var cur = e.target.result;
          if (cur) { rows.push(cur.value); cur.continue(); } else resolve(rows);
        };
        tx.onerror = function () { resolve([]); };
      });
    }).catch(function () { return []; });
  }
  function allCached() {
    return idbDo('messages', 'readonly', function (os) { var r = os.getAll(); r.__req = r; return r; }).catch(function () { return []; });
  }
  function getStatus(id) {
    return idbDo('messages', 'readonly', function (os) { var r = os.get(String(id)); r.__req = r; return r; }).catch(function () { return null; });
  }
  function patchIdb(id, patch) {
    return idbDo('messages', 'readwrite', function (os) {
      var req = os.get(String(id));
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return;
        Object.assign(cur, patch || {});
        os.put(cur);
      };
    }).catch(function () {});
  }

  function outboxAll() {
    return idbDo('outbox', 'readonly', function (os) { var r = os.getAll(); r.__req = r; return r; }).catch(function () { return []; });
  }
  function outboxPut(row) {
    return idbDo('outbox', 'readwrite', function (os) { os.put(row); }).catch(function () {});
  }
  function outboxDel(id) {
    return idbDo('outbox', 'readwrite', function (os) { os.delete(String(id)); }).catch(function () {});
  }
  function countOutbox() {
    return idbDo('outbox', 'readonly', function (os) { var r = os.count(); r.__req = r; return r; }).catch(function () { return 0; });
  }

  /* ===================================================================== *
   * Message shape: app <-> Appwrite document
   * ===================================================================== */
  function toDoc(m) {
    return {
      chatId: String(m.chatId || ''),
      senderId: String(m.from || ''),
      toId: String(m.to || ''),
      text: String(m.text == null ? '' : m.text).slice(0, 8000),
      type: String(m.type || 'text'),
      createdAt: Number(m.createdAt) || nowMs(),
      status: 'sent',
      mediaId: m.mediaId ? String(m.mediaId) : '',
      dur: Number(m.dur) || 0,
      readBy: []
    };
  }
  function fromDoc(doc) {
    if (!doc || !doc.$id) return null;
    return {
      id: String(doc.$id),
      chatId: String(doc.chatId || ''),
      from: String(doc.senderId || ''),
      to: String(doc.toId || ''),
      type: doc.type || 'text',
      text: doc.text || '',
      mediaId: doc.mediaId || null,
      dur: Number(doc.dur) || null,
      createdAt: Number(doc.createdAt) || Date.parse(doc.$createdAt) || nowMs(),
      status: doc.status || 'sent',
      readBy: Array.isArray(doc.readBy) ? doc.readBy.slice() : [],
      forwarded: false,
      deleted: false,
      $id: doc.$id,
      _appwrite: true
    };
  }

  function inMyChats(doc, u) {
    if (!doc || !u) return false;
    if (doc.senderId === u.id || doc.toId === u.id) return true;
    return String(doc.chatId || '').split('__').indexOf(u.id) >= 0;
  }

  function hasMessage(id) {
    var d = db();
    return !!(d && Array.isArray(d.messages) && d.messages.some(function (m) { return m && m.id === id; }));
  }

  function mergeLocal(msgs) {
    var d = db();
    if (!d || !Array.isArray(d.messages) || !msgs || !msgs.length) return 0;
    var have = {};
    d.messages.forEach(function (m) { if (m && m.id) have[m.id] = 1; });
    var added = 0;
    msgs.forEach(function (m) {
      if (!m || !m.id) return;
      if (have[m.id]) {
        var cur = d.messages.filter(function (x) { return x.id === m.id; })[0];
        if (cur) {
          if (m.status) cur.status = m.status;
          if (m.readBy && m.readBy.length > (cur.readBy || []).length) cur.readBy = m.readBy;
        }
        return;
      }
      d.messages.push(m);
      have[m.id] = 1;
      added++;
    });
    if (added) {
      d.messages.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      persist();
    }
    return added;
  }

  /* ===================================================================== *
   * Delivery ticks
   * ===================================================================== */
  function paintTick(id, status) {
    var node = document.querySelector('[data-msg="' + String(id).replace(/"/g, '') + '"]');
    if (!node) return;
    var tick = node.querySelector('.tick');
    if (!tick) {
      var meta = node.querySelector('.meta');
      if (!meta) return;
      tick = document.createElement('span');
      tick.className = 'tick';
      meta.appendChild(tick);
    }
    tick.className = 'tick ' + status;
    tick.setAttribute('data-state', status);
    tick.setAttribute('title',
      status === 'sending' || status === 'queued' ? 'Sending' :
      status === 'error' ? 'Not sent — retrying' :
      status === 'delivered' ? 'Delivered' :
      status === 'seen' ? 'Read' : 'Sent');
    var icon = (status === 'sending' || status === 'queued' || status === 'error') ? 'clock'
      : (status === 'delivered' || status === 'seen') ? 'checks' : 'check';
    try {
      tick.innerHTML = typeof window.ic === 'function' ? window.ic(icon, 12) : '';
    } catch (e) {}
    void icon;
  }

  function updateLocal(id, patch) {
    var d = db();
    if (d && Array.isArray(d.messages)) {
      var cur = d.messages.filter(function (m) { return m && m.id === id; })[0];
      if (cur) {
        Object.assign(cur, patch || {});
        persist();
      }
    }
    patchIdb(id, patch);
  }

  /* ===================================================================== *
   * 1 · SEND — optimistic, offline ready
   * ===================================================================== */
  function hookSend() {
    var A = g('App');
    if (!A || typeof A.send !== 'function' || A.send.__wcEngine) return false;
    var orig = A.send;
    A.send = function () {
      var before = {};
      var d = db();
      if (d && Array.isArray(d.messages)) d.messages.forEach(function (m) { if (m && m.id) before[m.id] = 1; });
      var out = orig.apply(this, arguments);      /* bubble is already on screen */
      var fresh = [];
      safe(function () {
        var d2 = db();
        if (!d2 || !Array.isArray(d2.messages)) return;
        fresh = d2.messages.filter(function (m) { return m && m.id && !before[m.id]; });
      });
      if (!fresh.length) return out;
      fresh.forEach(function (m) {
        m.status = 'sending';
        m._pending = true;
        putMessage(m);
        outboxPut({
          id: m.id,
          chatId: m.chatId,
          doc: toDoc(m),
          attempts: 0,
          nextAt: 0,
          createdAt: nowMs()
        });
        paintTick(m.id, 'sending');
      });
      dispatch('wc-chat-local', fresh);
      mirrorToServer(fresh);
      syncOutbox();
      return out;
    };
    A.send.__wcEngine = true;
    return true;
  }

  /* keep the existing server lane (push notifications, other-device ledger)
     fed without letting it drive the ticks */
  function mirrorToServer(fresh) {
    if (!navigator.onLine) return;
    var base = serverBase();
    var messages = (fresh || []).map(function (m) {
      return {
        id: m.id, chatId: m.chatId, from: m.from, to: m.to, type: m.type || 'text',
        text: m.text || '', mediaId: m.mediaId || null, dur: m.dur || null,
        createdAt: m.createdAt, status: 'sent', readBy: []
      };
    });
    if (!messages.length) return;
    fetch((base || '') + '/api/chat/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: messages, device: 'wc-engine' })
    }).catch(function () {});
  }

  /* ===================================================================== *
   * 2 · BACKGROUND SYNC — Outbox, every 2 s, retry 5/10/30
   * ===================================================================== */
  function createDocument(row) {
    return fetch(DOCS_URL, {
      method: 'POST',
      headers: { 'X-Appwrite-Project': CFG.project, 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: String(row.id), data: row.doc })
    }).then(function (r) {
      if (r.ok) return { ok: true };
      if (r.status === 409) return { ok: true, duplicate: true };
      return { ok: false, status: r.status };
    }).catch(function (e) { return { ok: false, error: e.message }; });
  }

  function patchDocument(id, data) {
    return fetch(DOCS_URL + '/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'X-Appwrite-Project': CFG.project, 'content-type': 'application/json' },
      body: JSON.stringify({ data: data })
    }).then(function (r) { return { ok: r.ok, status: r.status }; })
      .catch(function (e) { return { ok: false, error: e.message }; });
  }

  function syncOutbox() {
    if (state.syncing || !navigator.onLine) return Promise.resolve();
    state.syncing = true;
    return outboxAll().then(function (rows) {
      if (!rows.length) return;
      var chain = Promise.resolve();
      rows.forEach(function (row) {
        chain = chain.then(function () {
          if (row.nextAt && row.nextAt > nowMs()) return;
          return createDocument(row).then(function (res) {
            if (res.ok) {
              updateLocal(row.id, { status: 'sent', $id: row.id });
              return idbDo('messages', 'readwrite', function (os) {
                var req = os.get(String(row.id));
                req.onsuccess = function () {
                  var cur = req.result;
                  if (cur) { cur.status = 'sent'; cur.docId = row.id; os.put(cur); }
                };
              }).then(function () {
                paintTick(row.id, 'sent');
                return outboxDel(row.id).then(function () { dispatch('message-synced', { id: row.id }); });
              });
            }
            row.attempts = (Number(row.attempts) || 0) + 1;
            row.nextAt = nowMs() + (row.attempts <= 1 ? 5000 : row.attempts === 2 ? 10000 : 30000);
            paintTick(row.id, 'error');
            return outboxPut(row);
          });
        });
      });
      return chain;
    }).catch(function () {}).then(function () { state.syncing = false; });
  }

  /* ===================================================================== *
   * 3 · RECEIVE — Appwrite Realtime (one subscription, whole app lifetime)
   * ===================================================================== */
  function loadSdk() {
    if (window.Appwrite) return Promise.resolve(window.Appwrite);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'vendor/appwrite.iife.js';
      s.async = true;
      s.onload = function () { resolve(window.Appwrite || null); };
      s.onerror = function () { reject(new Error('appwrite_sdk_unavailable')); };
      document.head.appendChild(s);
    });
  }

  function handleRealtime(res) {
    var doc = res && res.payload;
    if (!doc || !doc.$id) return;
    var u = meUser();
    if (!u || !inMyChats(doc, u)) return;
    var m = fromDoc(doc);
    if (!m) return;

    putMessage(m);

    var mine = doc.senderId === u.id;
    if (mine) {
      /* our own document: mark the local row sent, and adopt read receipts */
      updateLocal(m.id, { status: m.status, readBy: m.readBy, $id: m.id });
      if (m.status !== 'sending') paintTick(m.id, m.status);
      return;
    }

    if (!hasMessage(m.id)) {
      /* paint instantly through the lane's own bubble renderer */
      var painted = 0;
      try {
        if (window.WCLiveChat && typeof window.WCLiveChat.apply === 'function') {
          painted = window.WCLiveChat.apply([m]);
        }
      } catch (e) {}
      if (!painted) mergeLocal([m]);
    } else {
      updateLocal(m.id, { status: m.status, readBy: m.readBy });
    }

    /* tell the sender their message reached a device */
    if (doc.toId === u.id && doc.status === 'sent') markDelivered(doc);
    if (activeChat() === m.chatId) {
      setTimeout(function () { markRead(m.chatId); }, 350);
    }
    dispatch('wc-chat-incoming', m);
  }

  function markDelivered(doc) {
    var id = doc.$id;
    var last = state.deliveredAt[id] || 0;
    if (nowMs() - last < 60000) return;
    state.deliveredAt[id] = nowMs();
    patchDocument(id, { status: 'delivered' }).then(function (r) {
      if (r.ok) {
        updateLocal(id, { status: 'delivered' });
        idbDo('messages', 'readwrite', function (os) {
          var req = os.get(String(id));
          req.onsuccess = function () { if (req.result) { req.result.status = 'delivered'; os.put(req.result); } };
        });
      }
    });
  }

  function markRead(chatId) {
    var u = meUser();
    var d = db();
    if (!u || !d || !Array.isArray(d.messages)) return;
    var last = state.readAt[chatId] || 0;
    if (nowMs() - last < 1500) return;
    var rows = d.messages.filter(function (m) {
      return m && m.chatId === chatId && m.to === u.id && !m.deleted &&
        !(Array.isArray(m.readBy) && m.readBy.indexOf(u.id) >= 0);
    }).slice(0, 40);
    if (!rows.length) return;
    state.readAt[chatId] = nowMs();
    rows.forEach(function (m) {
      m.readBy = Array.isArray(m.readBy) ? m.readBy : [];
      if (m.readBy.indexOf(u.id) < 0) m.readBy.push(u.id);
      m.status = 'seen';
      patchDocument(m.id, { status: 'seen', readBy: m.readBy });
    });
    persist();
  }

  function startRealtime() {
    return loadSdk().then(function (SDK) {
      if (!SDK || !SDK.Client) throw new Error('appwrite_sdk_missing');
      var client = new SDK.Client().setEndpoint(CFG.endpoint).setProject(CFG.project);
      state.client = client;
      /* one subscription, kept for the whole app lifetime. SDK 29 returns an
         unsubscribe function; connection state lives on client.realtime.socket. */
      try { state.unsubscribe = client.subscribe(CHANNEL, handleRealtime); }
      catch (e) { throw e; }

      function setOpen(open) {
        if (state.rtOpen === open) return;
        state.rtOpen = open;
        if (open) state.errors = 0;
        if (window.WCLiveChat && WCLiveChat.setExternal) WCLiveChat.setExternal(open);
        dispatch('wc-chat-realtime', { open: open });
        if (open) { syncOutbox(); watchChat(); }
      }

      setInterval(function () {
        var sock = null;
        try { sock = client.realtime && client.realtime.socket; } catch (e) {}
        var open = !!(sock && sock.readyState === 1);
        setOpen(open);
      }, 700);

      /* if the socket never opens, hand delivery back to the existing lane */
      setTimeout(function () {
        if (!state.rtOpen) {
          if (window.WCLiveChat && WCLiveChat.setExternal) WCLiveChat.setExternal(false);
        }
      }, 8000);
      return client;
    });
  }

  /* ===================================================================== *
   * 4 · HISTORY — cache first, then the last 100 documents
   * ===================================================================== */
  function fetchHistory(chatId) {
    var last = state.historyAt[chatId] || 0;
    if (nowMs() - last < 5000) return Promise.resolve(0);
    state.historyAt[chatId] = nowMs();
    var q = [
      JSON.stringify({ method: 'equal', attribute: 'chatId', values: [String(chatId)] }),
      JSON.stringify({ method: 'orderDesc', attribute: 'createdAt' }),
      JSON.stringify({ method: 'limit', values: [100] })
    ];
    var url = DOCS_URL + '?' + q.map(function (x) { return 'queries[]=' + encodeURIComponent(x); }).join('&');
    return fetch(url, { headers: { 'X-Appwrite-Project': CFG.project }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        var docs = (json && json.documents) || [];
        /* the API answers newest-first; the transcript wants oldest-first */
        var list = docs.map(fromDoc).filter(Boolean).sort(function (a, b) { return a.createdAt - b.createdAt; });
        if (!list.length) return 0;
        putMessages(list);
        var u = meUser();
        if (u) list.forEach(function (m) {
          /* tell the sender these reached this device (throttled per message) */
          if (m.to === u.id && m.status === 'sent') markDelivered({ $id: m.id, toId: m.to, status: 'sent' });
        });
        var added = 0;
        try {
          if (window.WCLiveChat && typeof window.WCLiveChat.apply === 'function') added = window.WCLiveChat.apply(list);
        } catch (e) {}
        if (!added) mergeLocal(list);
        if (activeChat() === chatId) markRead(chatId);
        return added;
      })
      .catch(function () { return 0; });
  }

  function loadChat(chatId) {
    if (!chatId) return;
    /* step 1: the phone's copy, instantly */
    chatFromCache(chatId).then(function (rows) {
      if (!rows.length) return;
      rows.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      var missing = rows.filter(function (m) { return !hasMessage(m.id); });
      if (missing.length) {
        /* the lane's merge keeps only conversations between known accounts */
        try {
          if (window.WCLiveChat && typeof window.WCLiveChat.apply === 'function') WCLiveChat.apply(rows);
          else mergeLocal(rows);
        } catch (e) { mergeLocal(rows); }
      }
      if (activeChat() === chatId) markRead(chatId);
    });
    /* step 2: the network, in the background */
    fetchHistory(chatId);
  }

  /* ===================================================================== *
   * Wiring
   * ===================================================================== */
  function seedCache() {
    var d = db();
    if (!d || !Array.isArray(d.messages) || !d.messages.length) return;
    putMessages(d.messages.slice(-2500));
  }

  function watchChat() {
    var act = activeChat();
    if (act && act !== state.lastChat) {
      state.lastChat = act;
      loadChat(act);
    }
    if (!act) state.lastChat = '';
  }

  function bind() {
    if (state.started) return;
    if (!meUser() || !db()) return;
    state.started = true;
    hookSend();
    seedCache();
    watchChat();
    syncOutbox();
    startRealtime().catch(function () {
      /* no realtime: keep the proven lane alive rather than a dead chat */
      if (window.WCLiveChat && WCLiveChat.setExternal) WCLiveChat.setExternal(false);
    });

    setInterval(syncOutbox, 2000);
    setInterval(watchChat, 400);
    window.addEventListener('online', function () { syncOutbox(); watchChat(); });
    window.addEventListener('hashchange', function () { setTimeout(watchChat, 60); });
    window.addEventListener('focus', function () { watchChat(); });
    window.addEventListener('wc:chat-opened', function () { watchChat(); });

    /* a Service Worker background sync on browsers that support it makes the
       outbox drain even if the tab was closed and reopened */
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function (reg) {
          if (reg.sync) reg.sync.register('wc-chat-outbox').catch(function () {});
        });
      }
    } catch (e) {}

    /* keep the persisted statuses in step on boot */
    outboxAll().then(function (rows) {
      (rows || []).forEach(function (row) { paintTick(row.id, 'sending'); });
    });
  }

  /* the app can sit on a splash or the login screen for a while: keep waiting
     (cheaply) until an account and the local database exist, then bind once. */
  (function waitForApp() {
    if (state.started) return;
    if (meUser() && db()) { bind(); return; }
    setTimeout(waitForApp, 1000);
  })();

  window.WCChatEngine = {
    send: function (chatId, senderId, text) {
      var m = {
        id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        chatId: chatId, from: senderId, to: String(chatId).split('__').filter(function (x) { return x !== senderId; })[0],
        type: 'text', text: text, createdAt: nowMs(), status: 'sending', readBy: []
      };
      var d = db();
      if (d && Array.isArray(d.messages)) { d.messages.push(m); persist(); }
      putMessage(m);
      outboxPut({ id: m.id, chatId: chatId, doc: toDoc(m), attempts: 0, nextAt: 0, createdAt: nowMs() });
      dispatch('wc-chat-local', [m]);
      mirrorToServer([m]);
      syncOutbox();
      return m;
    },
    sync: syncOutbox,
    pending: countOutbox,
    history: loadChat,
    fetchHistory: fetchHistory,
    realtime: function () { return { open: state.rtOpen, channel: CHANNEL, url: DOCS_URL }; },
    store: {
      put: putMessage,
      chat: chatFromCache,
      all: allCached,
      status: getStatus,
      outbox: outboxAll
    },
    config: CFG,
    /* test hook: feed a Realtime frame in without a socket */
    _handle: handleRealtime
  };
})();
