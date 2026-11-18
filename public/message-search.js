/* =========================================================================
   WhaleChat device-wide search  (WC_MSG_SEARCH / WC_SEARCH)
   -------------------------------------------------------------------------
   One search box on the Chats screen that searches everything the device
   already holds, grouped by type:

     Messages  · your chat history
     Products  · the marketplace catalogue
     Orders    · your order history and receipts
     Wallet    · deposits, withdrawals, trades, transfers, purchases

   Sources are merged so the same search works online and with no connection:
     1. the live app store (window.DB) — instant
     2. the IndexedDB mirror (WC_OFFLINE) — survives a reload and covers
        history no longer kept in memory

   Reach it by typing in the search bar on Chats, the magnifier buttons, the
   magnifier in a chat room, Ctrl/Cmd+F inside a chat, or WC_SEARCH.open().
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcMessageSearch) return;
  window.__wcMessageSearch = true;

  var S = window.WC_SEARCH = { open: open, close: close, search: search, searchAll: searchAll, lastQuery: '', lastCount: 0 };
  window.WC_MSG_SEARCH = S;                 /* keep the 3.50 name working */
  var OF = window.WC_OFFLINE;
  var seq = 0;
  var MIN = 2;

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
    var hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return hm;
    var days = Math.floor((now - d) / 86400000);
    if (days === 1) return 'Yesterday ' + hm;
    if (days < 7) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + hm;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function meId() { return safe(function () { return me().id; }, null); }
  function userById(id) { return safe(function () { return (DB.users || []).filter(function (u) { return u.id === id; })[0]; }, null); }
  function money(v) { var n = Number(v) || 0; return (n < 0 ? '−' : '') + '$' + Math.abs(n).toFixed(2); }
  function coinsText(v) { var n = Number(v) || 0; return (n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + ' WC'; }
  function base() { return safe(function () { return window.DB; }, null); }
  function covers(q, ...fields) {
    var needle = q.toLowerCase();
    for (var i = 0; i < fields.length; i++) {
      if (String(fields[i] == null ? '' : fields[i]).toLowerCase().indexOf(needle) > -1) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------- messages */
  function messagesLocal(q) {
    var uid = meId();
    var db = base();
    if (!db || !uid || !Array.isArray(db.messages)) return [];
    var out = [];
    for (var i = 0; i < db.messages.length; i++) {
      var m = db.messages[i];
      if (!m || m.deleted) continue;
      if (m.from !== uid && m.to !== uid) continue;
      if (!covers(q, m.text)) continue;
      out.push({
        type: 'message', id: m.id, text: m.text || '', createdAt: m.createdAt,
        from: m.from, to: m.to, chatId: m.chatId, media: m.type || 'text',
        otherId: m.from === uid ? m.to : m.from, source: 'memory'
      });
    }
    return out;
  }
  function messagesDevice(q) {
    if (!OF || !OF.all) return Promise.resolve([]);
    var uid = meId();
    return OF.all('messages').then(function (rows) {
      return (rows || []).filter(function (m) {
        if (!m || m.deleted) return false;
        if (uid && m.from !== uid && m.to !== uid) return false;
        return covers(q, m.text);
      }).map(function (m) {
        return {
          type: 'message', id: m.id, text: m.text || '', createdAt: m.createdAt,
          from: m.from, to: m.to, chatId: m.chatId, media: m.type || 'text',
          otherId: m.from === uid ? m.to : m.from, source: 'device'
        };
      });
    }).catch(function () { return []; });
  }

  /* ------------------------------------------------------------- products */
  function productsLocal(q) {
    var db = base();
    return ((db && db.products) || []).filter(function (p) {
      return covers(q, p.name, p.category, p.desc, p.ticker);
    }).slice(0, 40).map(function (p) {
      return {
        type: 'product', id: p.id, title: p.name || 'Product', subtitle: (p.category || '') + (p.stock > 0 ? '' : ' · sold out'),
        priceUsd: Number(p.priceUsd) || 0, stock: Number(p.stock) || 0, active: p.active !== false,
        createdAt: 0, source: 'memory', thumb: p.img || p.image || null
      };
    });
  }
  function productsDevice(q) {
    if (!OF || !OF.all) return Promise.resolve([]);
    return OF.all('products').then(function (rows) {
      return (rows || []).filter(function (p) { return covers(q, p.name, p.cat, p.desc); })
        .slice(0, 40).map(function (p) {
          return {
            type: 'product', id: p.id, title: p.name || 'Product', subtitle: p.cat || '',
            priceUsd: Number(p.priceUsd) || 0, stock: Number(p.stock) || 0, active: p.active !== false,
            createdAt: 0, source: 'device', thumb: p.img || null
          };
        });
    }).catch(function () { return []; });
  }

  /* --------------------------------------------------------------- orders */
  function ordersLocal(q) {
    var uid = meId();
    var db = base();
    return ((db && db.orders) || []).filter(function (o) {
      if (!o) return false;
      if (uid && o.buyerId && o.buyerId !== uid && o.vendorId !== uid) return false;
      var names = (o.items || []).map(function (i) { return i.name; }).join(' ');
      return covers(q, o.ref, o.id, o.status, names);
    }).slice(0, 40).map(function (o) {
      return {
        type: 'order', id: o.id, title: (o.ref || o.id), subtitle: (o.items || []).map(function (i) { return i.qty + '× ' + (i.name || ''); }).join(', '),
        status: o.status || '', createdAt: o.createdAt, totalUsd: Number(o.totalUsd) || 0,
        coins: Number(o.totalCoins) || 0, source: 'memory'
      };
    });
  }
  function ordersDevice(q) {
    if (!OF || !OF.all) return Promise.resolve([]);
    var uid = meId();
    return OF.all('orders').then(function (rows) {
      return (rows || []).filter(function (o) {
        if (!o) return false;
        if (uid && o.userId && o.userId !== uid) return false;
        var names = (o.items || []).map(function (i) { return i.name; }).join(' ');
        return covers(q, o.id, o.status, names);
      }).slice(0, 40).map(function (o) {
        return {
          type: 'order', id: o.id, title: o.id, subtitle: (o.items || []).map(function (i) { return i.qty + '× ' + (i.name || ''); }).join(', '),
          status: o.status || '', createdAt: o.createdAt, totalUsd: Number(o.totalUsd) || 0,
          coins: 0, source: 'device'
        };
      });
    }).catch(function () { return []; });
  }

  /* --------------------------------------------------------- wallet ledger */
  function walletLocal(q) {
    var uid = meId();
    var db = base();
    return ((db && db.txs) || []).filter(function (t) {
      if (!t || (uid && t.userId !== uid)) return false;
      return covers(q, t.label, t.type);
    }).slice(0, 40).map(function (t) {
      return {
        type: 'wallet', id: t.id, title: t.label || t.type, subtitle: t.type || '',
        coins: Number(t.coins) || 0, createdAt: t.createdAt, source: 'memory'
      };
    });
  }
  function walletDevice(q) {
    if (!OF || !OF.all) return Promise.resolve([]);
    var uid = meId();
    return OF.all('txs').then(function (rows) {
      return (rows || []).filter(function (t) {
        if (!t || (uid && t.userId && t.userId !== uid)) return false;
        return covers(q, t.label, t.type);
      }).slice(0, 40).map(function (t) {
        return {
          type: 'wallet', id: t.id, title: t.label || t.type, subtitle: t.type || '',
          coins: Number(t.coins) || 0, createdAt: t.createdAt, source: 'device'
        };
      });
    }).catch(function () { return []; });
  }

  /* ---------------------------------------------------------------- merge */
  function merge(memory, device) {
    var byId = {};
    (memory || []).forEach(function (r) { if (r && r.id) byId[r.id] = r; });
    (device || []).forEach(function (r) {
      if (!r || !r.id) return;
      if (byId[r.id]) { if (r.source === 'device') byId[r.id].source = 'device'; }
      else byId[r.id] = r;
    });
    return Object.keys(byId).map(function (k) { return byId[k]; });
  }

  function searchAll(q) {
    var query = String(q || '').trim();
    S.lastQuery = query;
    var empty = { messages: [], products: [], orders: [], wallet: [], total: 0, query: query };
    if (query.length < MIN) return Promise.resolve(empty);

    return Promise.all([
      messagesDevice(query),
      productsDevice(query),
      ordersDevice(query),
      walletDevice(query)
    ]).then(function (res) {
      var out = {
        messages: merge(messagesLocal(query), res[0]),
        products: merge(productsLocal(query), res[1]),
        orders: merge(ordersLocal(query), res[2]),
        wallet: merge(walletLocal(query), res[3]),
        query: query
      };
      out.messages.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      out.orders.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      out.wallet.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      ['messages', 'products', 'orders', 'wallet'].forEach(function (k) { out[k] = out[k].slice(0, 30); });
      out.total = out.messages.length + out.products.length + out.orders.length + out.wallet.length;
      S.lastCount = out.total;
      return out;
    }).catch(function () { return empty; });
  }

  /* flat list, kept for callers (and tests) that just want hits */
  function search(q) {
    return searchAll(q).then(function (g) { return g.messages; });
  }

  /* ------------------------------------------------------------------- UI */
  var TYPES = [
    { key: 'messages', label: 'Messages' },
    { key: 'products', label: 'Products' },
    { key: 'orders', label: 'Orders' },
    { key: 'wallet', label: 'Wallet' }
  ];

  function rowFor(r, q) {
    if (r.type === 'message') {
      var other = userById(r.otherId) || { fullName: 'Conversation' };
      return '<button class="wc-ms-row" data-wcgo="chat/' + esc(r.otherId || '') + '">' +
        '<span class="wc-ms-top"><b>' + esc(other.fullName || other.username || 'Conversation') + '</b>' +
          '<span class="wc-ms-time">' + esc(when(r.createdAt)) + '</span></span>' +
        '<span class="wc-ms-snip">' + (r.media !== 'text' ? '<i>[' + esc(r.media) + ']</i> ' : '') + highlight(r.text, q) + '</span>' +
        '<span class="wc-ms-meta">' + esc(r.from === meId() ? 'You' : (other.fullName || 'Contact')) +
          (r.source === 'device' ? ' · on device' : '') + '</span>' +
      '</button>';
    }
    if (r.type === 'product') {
      return '<button class="wc-ms-row" data-wcgo="product/' + esc(r.id) + '">' +
        '<span class="wc-ms-top"><b>' + highlight(r.title, q) + '</b>' +
          '<span class="wc-ms-time">' + esc(coinsText(r.priceUsd / 0.5)) + '</span></span>' +
        '<span class="wc-ms-snip">' + (r.subtitle ? esc(r.subtitle) : '') + ' · ' + money(r.priceUsd) +
          (r.stock > 0 ? ' · ' + r.stock + ' in stock' : ' · sold out') + '</span>' +
        '<span class="wc-ms-meta">Marketplace' + (r.source === 'device' ? ' · on device' : '') + '</span>' +
      '</button>';
    }
    if (r.type === 'order') {
      return '<button class="wc-ms-row" data-wcgo="orders">' +
        '<span class="wc-ms-top"><b>' + highlight(r.title, q) + '</b>' +
          '<span class="wc-ms-time">' + esc(when(r.createdAt)) + '</span></span>' +
        '<span class="wc-ms-snip">' + esc(r.subtitle || '') + '</span>' +
        '<span class="wc-ms-meta">' + esc(r.status || 'order') + ' · ' + money(r.totalUsd) +
          (r.source === 'device' ? ' · on device' : '') + '</span>' +
      '</button>';
    }
    var neg = Number(r.coins) < 0;
    return '<button class="wc-ms-row" data-wcgo="wallet">' +
      '<span class="wc-ms-top"><b>' + highlight(r.title, q) + '</b>' +
        '<span class="wc-ms-time ' + (neg ? 'neg' : 'pos') + '">' + esc(coinsText(r.coins)) + '</span></span>' +
      '<span class="wc-ms-snip">' + esc(r.subtitle || '') + ' · ' + esc(when(r.createdAt)) + '</span>' +
      '<span class="wc-ms-meta">Wallet' + (r.source === 'device' ? ' · on device' : '') + '</span>' +
    '</button>';
  }

  function resultsHTML(g, q, offline) {
    if (!q || q.length < MIN) {
      return '<div class="wc-ms-hint">Search messages, products, orders and your wallet — all of it runs on this device, so it works in airplane mode.</div>';
    }
    if (!g.total) {
      return '<div class="wc-ms-empty">Nothing matches “' + esc(q) + '” on this device.' +
        (offline ? '<span>Only data this phone has already loaded is searchable offline.</span>' : '<span>Try a shorter word, or open the section to refresh it.</span>') + '</div>';
    }
    var html = '';
    TYPES.forEach(function (t) {
      var items = g[t.key] || [];
      if (!items.length) return;
      html += '<div class="wc-ms-group"><h5>' + t.label + '<span>' + items.length + '</span></h5>' +
        items.map(function (r) { return rowFor(r, q); }).join('') + '</div>';
    });
    return html;
  }

  function paint(q) {
    var box = document.getElementById('wcMsResults');
    var meta = document.getElementById('wcMsMeta');
    if (!box) return;
    var token = ++seq;
    var offline = !navigator.onLine;
    if (meta) meta.textContent = offline ? 'Offline · searching this device' : 'Searching this device';
    searchAll(q).then(function (g) {
      if (token !== seq) return;
      box.innerHTML = resultsHTML(g, q, offline);
      if (meta && q.length >= MIN) {
        var parts = TYPES.filter(function (t) { return (g[t.key] || []).length; })
          .map(function (t) { return g[t.key].length + ' ' + t.label.toLowerCase(); });
        meta.textContent = g.total + ' result' + (g.total === 1 ? '' : 's') +
          (parts.length ? ' · ' + parts.join(' · ') : '') + (offline ? ' · on device' : '');
      }
    }).catch(function () {});
  }

  function go(target) {
    close();
    if (!target) return;
    try { go_(target); } catch (e) {}
  }
  function go_(target) { if (typeof window.go === 'function') window.go(target); else location.hash = '#/' + target; }

  function open(initial) {
    if (document.getElementById('wcMs')) {
      var i0 = document.getElementById('wcMsInput');
      if (i0 && typeof initial === 'string') { i0.value = initial; paint(initial); }
      return;
    }
    var wrap = document.createElement('div');
    wrap.id = 'wcMs';
    wrap.className = 'wc-ms';
    wrap.innerHTML =
      '<div class="wc-ms-card" role="dialog" aria-label="Search everything on this device">' +
        '<div class="wc-ms-head">' +
          '<span class="wc-ms-ic">⌕</span>' +
          '<input id="wcMsInput" class="wc-ms-input" type="search" autocomplete="off" ' +
            'placeholder="Messages, products, orders, wallet" aria-label="Search messages, products, orders and wallet"/>' +
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
      var inline = document.getElementById('wcChatSearchInput');
      if (inline && inline.value !== v) inline.value = v;
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
      if (e.target === wrap) { close(); return; }
      var row = e.target.closest && e.target.closest('[data-wcgo]');
      if (row) go(row.getAttribute('data-wcgo'));
    });
    if (initial) { input.value = initial; paint(initial); }
    else { paint(''); setTimeout(function () { try { input.focus(); } catch (e) {} }, 60); }
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
      '.wc-ms-input{flex:1;background:transparent;border:0;outline:0;color:#e9f4f9;font:15px Inter,-apple-system,Segoe UI,Roboto,sans-serif;min-width:0}' +
      '.wc-ms-x{background:transparent;border:0;color:#63798a;font-size:14px;cursor:pointer;padding:6px}' +
      '.wc-ms-meta{padding:7px 14px;font:600 10.5px Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:#5d7a8c;' +
      'letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid rgba(255,255,255,.05)}' +
      '.wc-ms-body{overflow-y:auto;-webkit-overflow-scrolling:touch}' +
      '.wc-ms-group h5{position:sticky;top:0;z-index:1;margin:0;padding:8px 14px;background:#08161f;' +
      'border-bottom:1px solid rgba(255,255,255,.05);font:700 10.5px Inter,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'letter-spacing:.08em;text-transform:uppercase;color:#5d7a8c;display:flex;justify-content:space-between}' +
      '.wc-ms-group h5 span{color:#2ee6c9}' +
      '.wc-ms-row{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;padding:11px 14px;' +
      'background:transparent;border:0;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;' +
      'font:13px/1.45 Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:#e9f4f9}' +
      '.wc-ms-row:active{background:rgba(46,230,201,.07)}' +
      '.wc-ms-top{display:flex;justify-content:space-between;gap:10px;align-items:baseline}' +
      '.wc-ms-top b{font-weight:650;font-size:13px}' +
      '.wc-ms-time{font-size:10.5px;color:#5d7a8c;white-space:nowrap}' +
      '.wc-ms-time.neg{color:#ff8f8f}.wc-ms-time.pos{color:#2ee6c9}' +
      '.wc-ms-snip{color:#9fb6c6;font-size:12.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
      '.wc-ms-snip mark{background:rgba(46,230,201,.22);color:#bff5ec;border-radius:3px;padding:0 1px}' +
      '.wc-ms-meta{font-size:10.5px;color:#4f6b7c}' +
      '.wc-ms-hint,.wc-ms-empty{padding:26px 18px;color:#7f97a8;text-align:center;font:12.5px/1.7 Inter,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.wc-ms-empty span{display:block;margin-top:6px;color:#4f6b7c;font-size:11.5px}' +
      /* the single search box on the Chats screen */
      '.wc-chat-search{display:flex;align-items:center;gap:8px;margin:0 0 14px;padding:10px 12px;border-radius:12px;' +
      'background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}' +
      '.wc-chat-search i{font-style:normal;color:#5d7a8c;font-size:15px}' +
      '.wc-chat-search input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:#e9f4f9;' +
      'font:13.5px Inter,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.wc-chat-search input::placeholder{color:#5d7a8c}' +
      '.wc-chat-search .wc-cs-scope{font:600 9.5px Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:#2ee6c9;' +
      'letter-spacing:.06em;text-transform:uppercase;border:1px solid rgba(46,230,201,.25);border-radius:999px;padding:3px 7px}' +
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

  function mountChatsBar() {
    if (document.querySelector('.wc-chat-search')) return;
    var peopleBtn = document.querySelector('[data-act="search-people"]');
    var header = peopleBtn && peopleBtn.closest ? peopleBtn.closest('.between') : null;
    if (!header || !header.parentNode) return;
    var bar = document.createElement('div');
    bar.className = 'wc-chat-search';
    bar.innerHTML = '<i>⌕</i><input id="wcChatSearchInput" type="search" autocomplete="off" ' +
      'placeholder="Search messages, products, orders, wallet" aria-label="Search everything"/>' +
      '<span class="wc-cs-scope">On device</span>';
    header.parentNode.insertBefore(bar, header.nextSibling);
    var input = bar.querySelector('input');
    input.addEventListener('focus', function () { if (input.value.trim().length >= MIN) open(input.value); });
    input.addEventListener('input', function () { if (input.value.trim().length >= MIN) open(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); open(input.value); }
    });
  }

  function mount() {
    if (!document.body) return;
    mountChatsBar();
    var peopleBtn = document.querySelector('[data-act="search-people"]');
    if (peopleBtn && peopleBtn.parentNode && !document.querySelector('.home-grid [data-wc-msgsearch]')) {
      var b = mkButton('btn-icon wc-msgsearch-btn', 'Search messages, products, orders and wallet');
      b.style.fontSize = '17px';
      peopleBtn.parentNode.insertBefore(b, peopleBtn);
    }
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
