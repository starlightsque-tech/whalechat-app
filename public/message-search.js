/* =========================================================================
   WhaleChat offline message search  (wc-message-search)
   -------------------------------------------------------------------------
   Find text inside your chat history from inside the Chat screen, with no
   network at all. Two sources are merged:

     · the live conversation store (window.DB.messages) — instant
     · the IndexedDB mirror via WC_OFFLINE.searchMessages() — survives a
       reload and covers history that is no longer in memory

   Results show the conversation, a highlighted snippet and when it was sent,
   and say "on device" when the answer came from cached storage. Tapping a
   result opens that conversation.

   Reach it from the magnifier in the Chats header, the one in a chat room,
   Ctrl/Cmd+F inside a chat, or WC_MSG_SEARCH.open().
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcMessageSearch) return;
  window.__wcMessageSearch = true;

  var MS = window.WC_MSG_SEARCH = { open: open, close: close, search: search, lastQuery: '', lastCount: 0 };
  var OF = window.WC_OFFLINE;
  var seq = 0;

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function highlight(text, q) {
    var t = esc(text);
    if (!q) return t;
    try {
      var re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
      return t.replace(re, '<mark>$1</mark>');
    } catch (e) { return t; }
  }
  function when(ts) {
    if (!ts) return '';
    var d = new Date(ts), now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return hm;
    var days = Math.floor((now - d) / 86400000);
    if (days === 1) return 'Yesterday ' + hm;
    if (days < 7) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + hm;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + hm;
  }
  function meId() { return safe(function () { return me().id; }, null); }
  function findUserLocal(id) {
    return safe(function () { return (DB.users || []).filter(function (u) { return u.id === id; })[0]; }, null);
  }
  function chatOther(m) {
    var uid = meId();
    return m.from === uid ? m.to : m.from;
  }

  /* ------------------------------------------------------------- searching */
  function localScan(q) {
    var uid = meId();
    var db = safe(function () { return window.DB; }, null);
    if (!db || !uid || !Array.isArray(db.messages)) return [];
    var needle = q.toLowerCase();
    var out = [];
    for (var i = 0; i < db.messages.length; i++) {
      var m = db.messages[i];
      if (!m || m.deleted) continue;
      if (m.from !== uid && m.to !== uid) continue;
      if (String(m.text || '').toLowerCase().indexOf(needle) === -1) continue;
      out.push({
        id: m.id, text: m.text || '', createdAt: m.createdAt,
        from: m.from, to: m.to, chatId: m.chatId,
        type: m.type || 'text', source: 'memory'
      });
    }
    return out;
  }

  function mirroredScan(q) {
    if (!OF || !OF.searchMessages) return Promise.resolve([]);
    return OF.all('messages').then(function (rows) {
      var uid = meId();
      var needle = q.toLowerCase();
      return (rows || []).filter(function (m) {
        if (!m || m.deleted) return false;
        if (uid && m.from !== uid && m.to !== uid) return false;
        return String(m.text || '').toLowerCase().indexOf(needle) > -1;
      }).map(function (m) {
        return {
          id: m.id, text: m.text || '', createdAt: m.createdAt,
          from: m.from, to: m.to, chatId: m.chatId,
          type: m.type || 'text', source: 'device'
        };
      });
    }).catch(function () { return []; });
  }

  /* merged, de-duplicated, newest first */
  function search(q) {
    var query = String(q || '').trim();
    if (query.length < 2) return Promise.resolve([]);
    MS.lastQuery = query;
    var fromMemory = localScan(query);
    return mirroredScan(query).then(function (fromDevice) {
      var byId = {};
      fromMemory.concat(fromDevice).forEach(function (r) {
        if (!r || !r.id) return;
        if (!byId[r.id]) byId[r.id] = r;
        else if (r.source === 'device') byId[r.id].source = 'device';
      });
      var list = Object.keys(byId).map(function (k) { return byId[k]; });
      list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      list.slice(0, 80).forEach(function (r) { r.otherId = chatOther(r); });
      MS.lastCount = list.length;
      return list;
    }).catch(function () { return []; });
  }

  /* ------------------------------------------------------------------- UI */
  function resultsHTML(list, q, offline) {
    if (!q || q.length < 2) {
      return '<div class="wc-ms-hint">Type at least 2 characters. Search runs on this device, so it works in airplane mode.</div>';
    }
    if (!list.length) {
      return '<div class="wc-ms-empty">' + (offline ? 'No messages cached on this device match “' + esc(q) + '”.' : 'No messages match “' + esc(q) + '”.') +
        '<span>Messages you have opened on this phone are searchable offline.</span></div>';
    }
    return list.map(function (r) {
      var other = findUserLocal(r.otherId) || { fullName: 'Conversation', username: '' };
      var who = r.from === meId() ? 'You' : (other.fullName || other.username || 'Contact');
      return '<button class="wc-ms-row" data-wcms-open="' + esc(r.otherId || '') + '">' +
        '<span class="wc-ms-top"><b>' + esc(other.fullName || other.username || 'Conversation') + '</b>' +
          '<span class="wc-ms-time">' + esc(when(r.createdAt)) + '</span></span>' +
        '<span class="wc-ms-snip">' + (r.type !== 'text' ? '<i>[' + esc(r.type) + ']</i> ' : '') + highlight(r.text, q) + '</span>' +
        '<span class="wc-ms-meta">' + esc(who) + (r.source === 'device' ? ' · on device' : '') + '</span>' +
      '</button>';
    }).join('');
  }

  function paint(q) {
    var box = document.getElementById('wcMsResults');
    var meta = document.getElementById('wcMsMeta');
    if (!box) return;
    var token = ++seq;
    var offline = !navigator.onLine;
    if (meta) meta.textContent = offline ? 'Offline · searching this device' : 'Searching your chats';
    search(q).then(function (list) {
      if (token !== seq) return;              /* a newer query already won */
      box.innerHTML = resultsHTML(list, q, offline);
      if (meta) {
        meta.textContent = (q.length >= 2 ? list.length + ' result' + (list.length === 1 ? '' : 's') : 'Type to search') +
          (offline ? ' · on device' : '') + (q.length >= 2 ? ' · ' + (offline ? 'cached history' : 'memory + cache') : '');
      }
    }).catch(function () {});
  }

  function open(initial) {
    if (document.getElementById('wcMs')) {
      var i0 = document.getElementById('wcMsInput');
      if (i0 && initial) { i0.value = initial; paint(initial); }
      return;
    }
    var wrap = document.createElement('div');
    wrap.id = 'wcMs';
    wrap.className = 'wc-ms';
    wrap.innerHTML =
      '<div class="wc-ms-card" role="dialog" aria-label="Search messages">' +
        '<div class="wc-ms-head">' +
          '<span class="wc-ms-ic">⌕</span>' +
          '<input id="wcMsInput" class="wc-ms-input" type="search" autocomplete="off" placeholder="Search your messages" aria-label="Search messages"/>' +
          '<button class="wc-ms-x" id="wcMsClose" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="wc-ms-meta" id="wcMsMeta">Type to search</div>' +
        '<div class="wc-ms-body" id="wcMsResults"></div>' +
      '</div>';
    document.body.appendChild(wrap);

    var input = document.getElementById('wcMsInput');
    var timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var v = input.value;
      timer = setTimeout(function () { paint(v); }, 120);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Enter') {
        var first = document.querySelector('.wc-ms-row');
        if (first) first.click();
      }
    });
    document.getElementById('wcMsClose').onclick = close;
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) close();
      var row = e.target.closest && e.target.closest('[data-wcms-open]');
      if (row) {
        var id = row.getAttribute('data-wcms-open');
        close();
        if (id) { try { go('chat/' + id); } catch (err) {} }
      }
    });
    if (initial) { input.value = initial; paint(initial); } else { paint(''); setTimeout(function () { try { input.focus(); } catch (e) {} }, 60); }
  }

  function close() {
    var el = document.getElementById('wcMs');
    if (el) el.remove();
  }

  /* --------------------------------------------------------------- styles */
  function styles() {
    if (document.getElementById('wc-ms-styles')) return;
    var st = document.createElement('style');
    st.id = 'wc-ms-styles';
    st.textContent =
      '.wc-ms{position:fixed;inset:0;z-index:10040;display:flex;align-items:flex-start;justify-content:center;' +
      'background:rgba(2,10,16,.72);backdrop-filter:blur(6px);padding:max(env(safe-area-inset-top,0px),10px) 10px 10px}' +
      '.wc-ms-card{width:100%;max-width:560px;max-height:86vh;display:flex;flex-direction:column;background:#07141d;' +
      'border:1px solid rgba(46,230,201,.22);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.55);overflow:hidden}' +
      '.wc-ms-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.07)}' +
      '.wc-ms-ic{color:#5d7a8c;font-size:16px}' +
      '.wc-ms-input{flex:1;background:transparent;border:0;outline:0;color:#e9f4f9;font:15px Inter,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.wc-ms-x{background:transparent;border:0;color:#63798a;font-size:14px;cursor:pointer;padding:6px}' +
      '.wc-ms-meta{padding:7px 14px;font:600 10.5px Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:#5d7a8c;' +
      'letter-spacing:.05em;text-transform:uppercase;border-bottom:1px solid rgba(255,255,255,.05)}' +
      '.wc-ms-body{overflow-y:auto;-webkit-overflow-scrolling:touch}' +
      '.wc-ms-row{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;padding:11px 14px;' +
      'background:transparent;border:0;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;' +
      'font:13px/1.45 Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:#e9f4f9}' +
      '.wc-ms-row:active{background:rgba(46,230,201,.07)}' +
      '.wc-ms-top{display:flex;justify-content:space-between;gap:10px;align-items:baseline}' +
      '.wc-ms-top b{font-weight:650;font-size:13px}' +
      '.wc-ms-time{font-size:10.5px;color:#5d7a8c;white-space:nowrap}' +
      '.wc-ms-snip{color:#9fb6c6;font-size:12.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
      '.wc-ms-snip mark{background:rgba(46,230,201,.22);color:#bff5ec;border-radius:3px;padding:0 1px}' +
      '.wc-ms-meta{font-size:10.5px;color:#4f6b7c}' +
      '.wc-ms-hint,.wc-ms-empty{padding:26px 18px;color:#7f97a8;text-align:center;font:12.5px/1.7 Inter,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.wc-ms-empty span{display:block;margin-top:6px;color:#4f6b7c;font-size:11.5px}' +
      '.wc-msgsearch-btn{position:relative}' +
      '@media(min-width:720px){.wc-ms{align-items:center}}';
    document.head.appendChild(st);
  }

  /* --------------------------------------------------- entry points in UI */
  function mkButton(cls, title) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('data-wc-msgsearch', '1');
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = '⌕';
    b.onclick = function (e) { e.preventDefault(); e.stopPropagation(); open(''); };
    return b;
  }

  function mount() {
    if (!document.body) return;
    /* chats header: next to the people search */
    var peopleBtn = document.querySelector('[data-act="search-people"]');
    if (peopleBtn && peopleBtn.parentNode && !document.querySelector('.home-grid [data-wc-msgsearch]')) {
      var b = mkButton('btn-icon wc-msgsearch-btn', 'Search messages on this device');
      b.style.fontSize = '17px';
      peopleBtn.parentNode.insertBefore(b, peopleBtn);
    }
    /* chat room header */
    var head = document.querySelector('.chat-head');
    if (head && !head.querySelector('[data-wc-msgsearch]')) {
      var actions = head.querySelector('.chat-head-actions') || head;
      var b2 = mkButton('btn-icon wc-msgsearch-btn', 'Search this conversation history');
      b2.style.fontSize = '16px';
      actions.appendChild(b2);
    }
  }

  function bind() {
    styles();
    mount();
    setInterval(mount, 1500);
    var obs = new MutationObserver(function () {
      if (obs.__t) return;
      obs.__t = setTimeout(function () { obs.__t = null; mount(); }, 250);
    });
    try { obs.observe(document.body, { childList: true, subtree: true }); } catch (e) {}

    document.addEventListener('keydown', function (e) {
      var inChat = document.querySelector('.chat-room');
      if (inChat && (e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'f') {
        e.preventDefault();
        open('');
      }
      if (String(e.key) === 'Escape') close();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
