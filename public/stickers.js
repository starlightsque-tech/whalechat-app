/* =========================================================================
   WhaleChat stickers  (wc-stickers)  v1.0

   WhatsApp-style stickers, on the account:
     · built-in packs (Whale Moods, Whale Love, Reactions, Big Day)
     · tap a sticker in the chat composer tray to send it
     · long-press any sticker (in the tray or on a received message) to
       SAVE it to "My stickers", or remove it again
     · "My stickers" is saved on the user's account (user.stickers) so it
       follows them to every device, exactly like WhatsApp
     · make a sticker out of a photo (sticker from photo) — stored on the
       device as media, listed under My stickers
     · "Recent" keeps the last stickers used

   Sticker messages are ordinary chat messages with type:"sticker" and a
   sticker key, so they travel over the instant/offline outbox and the
   cross-device sync with no extra server work:
       b:<pack>:<index>   built-in sticker
       c:<recordId>       a sticker saved on the account (photo or built-in)
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_STICKERS) return;

  var ST = window.WC_STICKERS = {};

  function $(x) { return document.getElementById(x); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function tmsg(m, t) { try { if (typeof toast === 'function') toast(m, t || 'ok'); } catch (e) {} }
  function theMe() { try { return typeof me === 'function' ? me() : null; } catch (e) { return null; } }
  function persistX() { try { if (typeof sync === 'function') sync(); } catch (e) {} }
  function uidX(p) { try { return typeof uid === 'function' ? uid(p) : p + '_' + Date.now().toString(36); } catch (e) { return p + '_' + Date.now().toString(36); } }

  /* ------------------------------------------------------------------ *
   * packs
   * ------------------------------------------------------------------ */
  var PACKS = [
    {
      id: 'mood', name: 'Whale Moods', bg: ['#0f766e', '#0ea5e9'],
      items: ['🐳', '😂', '😍', '🤣', '😎', '🥳', '😴', '🤔', '😭', '😤', '🫶', '👋']
    },
    {
      id: 'love', name: 'Whale Love', bg: ['#be123c', '#f43f5e'],
      items: ['❤️', '😘', '🥰', '💖', '🌹', '💐', '🫂', '😻', '💌', '💍', '😽', '🌸']
    },
    {
      id: 'react', name: 'Reactions', bg: ['#1e3a8a', '#7c3aed'],
      items: ['👍', '👎', '🔥', '💯', '✅', '🎉', '🙏', '👏', '💀', '🤯', '🥴', '🤝']
    },
    {
      id: 'day', name: 'Big Day', bg: ['#7c2d12', '#db2777'],
      items: ['☀️', '🌙', '☕', '🍕', '🍻', '🎂', '🎁', '🏆', '💸', '🚀', '🎧', '✨']
    }
  ];
  var BY_ID = {};
  PACKS.forEach(function (p) { BY_ID[p.id] = p; });

  function packItem(key) {
    var m = /^b:([a-z]+):(\d+)$/.exec(String(key || ''));
    if (!m) return null;
    var p = BY_ID[m[1]];
    if (!p) return null;
    var i = Number(m[2]);
    if (!(i >= 0 && i < p.items.length)) return null;
    return { pack: p, emoji: p.items[i], index: i };
  }

  /* the account's sticker list */
  function mine(u) {
    if (!u) return [];
    if (!Array.isArray(u.stickers)) u.stickers = [];
    return u.stickers;
  }
  function recById(u, id) {
    return mine(u).filter(function (r) { return r && r.id === id; })[0] || null;
  }

  /* ------------------------------------------------------------------ *
   * rendering — one place used by the tray and by chat bubbles
   * ------------------------------------------------------------------ */
  function tileStyle(bg) {
    return 'background:linear-gradient(135deg,' + bg[0] + ',' + bg[1] + ')';
  }

  ST.html = function (msg) {
    var u = theMe();
    var key = msg && msg.sticker ? String(msg.sticker) : '';
    var p = packItem(key);
    if (p) {
      return '<div class="stk">' + '<div class="stk-tile" style="' + tileStyle(p.pack.bg) + '">' +
        '<span class="stk-e">' + p.emoji + '</span></div></div>';
    }
    var rec = key.indexOf('c:') === 0 ? recById(u, key.slice(2)) : null;
    if (rec && rec.kind === 'photo' && rec.mediaId) {
      return '<div class="stk"><img class="stk-img" data-media="' + esc(rec.mediaId) + '" alt="Sticker"/></div>';
    }
    if (rec && rec.ref) {
      var q = packItem(rec.ref);
      if (q) return '<div class="stk"><div class="stk-tile" style="' + tileStyle(q.pack.bg) + '"><span class="stk-e">' + q.emoji + '</span></div></div>';
    }
    return '<div class="stk"><div class="stk-tile" style="' + tileStyle(['#334155', '#0f172a']) + '"><span class="stk-e">🫥</span></div></div>';
  };

  /* label used in chat lists / notifications */
  ST.preview = function () { return 'Sticker'; };

  /* a thumbnail for the tray */
  function thumbHTML(key, rec) {
    var p = packItem(key) || (rec && rec.ref ? packItem(rec.ref) : null);
    if (p) return '<div class="stk-tile sm" style="' + tileStyle(p.pack.bg) + '"><span class="stk-e sm">' + p.emoji + '</span></div>';
    if (rec && rec.mediaId) return '<img class="stk-img sm" data-media="' + esc(rec.mediaId) + '" alt="Sticker"/>';
    return '<div class="stk-tile sm" style="' + tileStyle(['#334155', '#0f172a']) + '"><span class="stk-e sm">🫥</span></div>';
  }

  function hydrateTray(root) {
    try { if (window.Media && Media.hydrate) Media.hydrate(root || document); } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   * sending
   * ------------------------------------------------------------------ */
  function remember(u, key) {
    var list = Array.isArray(u.stickerRecent) ? u.stickerRecent : [];
    list = list.filter(function (x) { return x !== key; });
    list.unshift(key);
    u.stickerRecent = list.slice(0, 16);
  }

  ST.send = function (key) {
    var u = theMe();
    if (!u) return;
    try { if (typeof closeModal === 'function') closeModal(); } catch (e) {}
    var cid = null;
    try { cid = (typeof ACTIVE_CHAT !== 'undefined') ? ACTIVE_CHAT : null; } catch (e) { cid = null; }
    if (!cid) return tmsg('Open a chat first', 'err');
    /* the composer belongs to the user — the sticker is sent on its own,
       never written into their text field */
    sendStickerMessage(u, cid, key);
  };

  function sendStickerMessage(u, cid, key) {
    var db = (typeof DB !== 'undefined') ? DB : null;
    if (!db) return;
    var otherId = String(cid).split('__').filter(function (x) { return x && x !== u.id; })[0];
    var msg = {
      id: uidX('msg'), chatId: cid, from: u.id, to: otherId, type: 'sticker', sticker: key, text: '',
      createdAt: Date.now(), status: 'sent', forwarded: false, deleted: false, readBy: []
    };
    db.messages.push(msg);
    var meta = db.chatsMeta[cid] || {};
    if ((meta.deletedFor || []).indexOf(u.id) !== -1) meta.deletedFor = meta.deletedFor.filter(function (x) { return x !== u.id; });
    db.chatsMeta[cid] = meta;
    remember(u, key);
    try {
      if (typeof notify === 'function') notify(otherId, u.fullName, 'Sticker', '#/chat/' + u.id, 'chat');
    } catch (e) {}
    persistX();
    try {
      if (typeof chan !== 'undefined' && chan) chan.postMessage({ t: 'message', from: u.id });
    } catch (e) {}
    /* instant outbox + cross-device */
    try { if (window.WCI && WCI.enqueueMessage) WCI.enqueueMessage(msg); } catch (e) {}
    var painted = false;
    try { painted = !!(window.WC_SMOOTH && WC_SMOOTH.afterSend && WC_SMOOTH.afterSend()); } catch (e) {}
    if (!painted) {
      try { if (typeof render === 'function') render(); } catch (e) {}
      setTimeout(function () {
        var b = document.getElementById('chatBody');
        if (b) b.scrollTop = b.scrollHeight;
      }, 40);
    }
    tmsg('Sticker sent');
  }

  /* ------------------------------------------------------------------ *
   * saving on the account
   * ------------------------------------------------------------------ */
  ST.save = function (key) {
    var u = theMe(); if (!u) return false;
    var list = mine(u);
    if (list.some(function (r) { return r && r.ref === key; })) { tmsg('Already in My stickers'); return false; }
    var rec = { id: uidX('stk'), kind: 'builtin', ref: key, at: Date.now() };
    list.unshift(rec);
    u.stickers = list.slice(0, 120);
    persistX();
    tmsg('Saved to My stickers');
    return rec;
  };

  ST.removeRec = function (id) {
    var u = theMe(); if (!u) return false;
    u.stickers = mine(u).filter(function (r) { return r && r.id !== id; });
    persistX();
    tmsg('Removed from My stickers');
    return true;
  };

  ST.isSaved = function (key) {
    var u = theMe(); if (!u) return false;
    return mine(u).some(function (r) { return r && r.ref === key; });
  };

  /* save the sticker carried by a chat message */
  ST.saveFromMessage = function (msgId) {
    var db = (typeof DB !== 'undefined') ? DB : null;
    if (!db) return;
    var m = db.messages.filter(function (x) { return x.id === msgId; })[0];
    if (!m || m.type !== 'sticker' || !m.sticker) return tmsg('This is not a sticker', 'err');
    ST.save(String(m.sticker));
    try { if (typeof closeModal === 'function') closeModal(); } catch (e) {}
  };

  /* ------------------------------------------------------------------ *
   * sticker from a photo
   * ------------------------------------------------------------------ */
  ST.fromPhoto = async function () {
    var f = null;
    try {
      f = await (typeof pickFile === 'function' ? pickFile({ accept: 'image/*' }) : Promise.resolve(null));
    } catch (e) { f = null; }
    if (!f) return;
    var u = theMe(); if (!u) return;
    var mediaId = null;
    try {
      var small = await compressImage(f, 512, 0.9);
      mediaId = await Media.put(small);
    } catch (e) { mediaId = null; }
    if (!mediaId) return tmsg('Could not store the picture', 'err');
    var rec = { id: uidX('stk'), kind: 'photo', mediaId: mediaId, label: 'My sticker', at: Date.now() };
    var list = mine(u);
    list.unshift(rec);
    u.stickers = list.slice(0, 120);
    persistX();
    tmsg('Sticker created');
    ST.open('saved');
  };

  /* ------------------------------------------------------------------ *
   * tray
   * ------------------------------------------------------------------ */
  var TAB = 'pack:mood';

  ST.open = function (tab) {
    if (tab) TAB = tab;
    var u = theMe(); if (!u) return;
    var body = '';
    if (TAB === 'recent') {
      var rec = Array.isArray(u.stickerRecent) ? u.stickerRecent : [];
      body = rec.length ? grid(rec, 'recent') : empty('No stickers used yet', 'Send a sticker and it will show up here.');
    } else if (TAB === 'saved') {
      var saved = mine(u);
      body = saved.length ? '<div class="stk-grid">' + saved.map(function (r) {
        return '<button class="stk-cell" data-act="stk-send-rec" data-id="' + esc(r.id) + '" data-stk="c:' + esc(r.id) + '" title="Tap to send · hold to manage">' + thumbHTML('c:' + r.id, r) + '</button>';
      }).join('') + '</div>' : empty('No saved stickers', 'Hold any sticker in a pack to save it to your account.');
      body += '<button class="btn btn-ghost btn-sm btn-block mt10" data-act="stk-photo">📷 Make a sticker from a photo</button>';
    } else {
      var pack = BY_ID[String(TAB).replace('pack:', '')] || PACKS[0];
      var saved2 = mine(u);
      body = '<div class="stk-grid">' + pack.items.map(function (e, i) {
        var key = 'b:' + pack.id + ':' + i;
        var on = saved2.some(function (r) { return r && r.ref === key; });
        return '<button class="stk-cell" data-act="stk-send" data-stk="' + key + '" title="Tap to send · hold to save">' +
          thumbHTML(key) + (on ? '<i class="stk-saved"></i>' : '') + '</button>';
      }).join('') + '</div>';
    }

    var tabs = [['recent', 'Recent'], ['saved', 'My stickers']].concat(PACKS.map(function (p) { return ['pack:' + p.id, p.name]; }));

    var html = '<div class="stk-sheet">' +
      '<div class="between mb10"><div style="font-weight:700;font-size:14px">Stickers</div>' +
      '<button class="btn btn-xs btn-ghost" data-close>Close</button></div>' +
      '<div class="stk-tabs">' + tabs.map(function (t) {
        return '<button class="stk-tab' + (TAB === t[0] ? ' on' : '') + '" data-act="stk-tab" data-id="' + t[0] + '">' + esc(t[1]) + '</button>';
      }).join('') + '</div>' + body + '</div>';

    if (typeof openModal === 'function') {
      openModal(html, { width: '430px' });
      hydrateTray($('overlay'));
      bindHold();
    }
  };

  function empty(t, s) {
    return '<div class="stk-empty"><div style="font-weight:650;font-size:13px">' + esc(t) + '</div><div class="tiny muted mt6">' + esc(s) + '</div></div>';
  }
  function grid(keys, kind) {
    return '<div class="stk-grid">' + keys.map(function (k) {
      var rec = String(k).indexOf('c:') === 0 ? recById(theMe(), String(k).slice(2)) : null;
      return '<button class="stk-cell" data-act="stk-send-key" data-stk="' + esc(k) + '" title="Tap to send">' + thumbHTML(k, rec) + '</button>';
    }).join('') + '</div>';
  }

  /* long press = save / manage */
  function bindHold() {
    var cells = document.querySelectorAll('.stk-cell');
    Array.prototype.forEach.call(cells, function (cell) {
      var t = null;
      var start = function () {
        clearTimeout(t);
        t = setTimeout(function () {
          t = null;
          try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
          var key = cell.getAttribute('data-stk');
          if (String(key).indexOf('c:') === 0) manage(String(key).slice(2));
          else manageBuiltin(key);
        }, 480);
      };
      var cancel = function () { clearTimeout(t); };
      cell.addEventListener('pointerdown', start);
      cell.addEventListener('pointerup', cancel);
      cell.addEventListener('pointerleave', cancel);
      cell.addEventListener('pointercancel', cancel);
      cell.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });
  }

  function manageBuiltin(key) {
    var saved = ST.isSaved(key);
    var p = packItem(key);
    var label = p ? p.emoji : 'Sticker';
    openModal(modalShell(label + ' sticker', '<div class="stk-preview">' + thumbHTML(key) + '</div>' +
      '<div class="list">' +
      (saved
        ? '<button class="list-item" data-act="stk-unsave" data-stk="' + esc(key) + '" style="width:100%;text-align:left">🗑 <span class="grow">Remove from My stickers</span></button>'
        : '<button class="list-item" data-act="stk-save" data-stk="' + esc(key) + '" style="width:100%;text-align:left">⭐ <span class="grow">Save to My stickers</span></button>') +
      '<button class="list-item" data-act="stk-send" data-stk="' + esc(key) + '" style="width:100%;text-align:left">➤ <span class="grow">Send now</span></button>' +
      '</div>', '<button class="btn btn-ghost" data-close style="width:100%">Cancel</button>'));
  }

  function manage(recId) {
    var u = theMe(); if (!u) return;
    var rec = recById(u, recId); if (!rec) return;
    openModal(modalShell('My sticker', '<div class="stk-preview">' + thumbHTML('c:' + rec.id, rec) + '</div>' +
      '<div class="list">' +
      '<button class="list-item" data-act="stk-send-rec" data-id="' + esc(rec.id) + '" data-stk="c:' + esc(rec.id) + '" style="width:100%;text-align:left">➤ <span class="grow">Send now</span></button>' +
      '<button class="list-item" data-act="stk-del-rec" data-id="' + esc(rec.id) + '" style="width:100%;text-align:left;color:var(--danger)">🗑 <span class="grow">Delete sticker</span></button>' +
      '</div>', '<button class="btn btn-ghost" data-close style="width:100%">Cancel</button>'));
    hydrateTray($('overlay'));
  }

  /* ------------------------------------------------------------------ *
   * actions
   * ------------------------------------------------------------------ */
  function bindActions() {
    if (typeof App === 'undefined' || App.__wcStickers) return false;
    App.__wcStickers = true;

    App.stickers = function () { ST.open(); };
    App.stkTab = function (id) { ST.open(id); };

    App.stkSend = function (id, ds) {
      var key = (ds && ds.stk) || id || '';
      if (!key) return;
      ST.send(key);
    };
    App.stkSendKey = App.stkSend;
    App.stkSendRec = function (id, ds) {
      var key = (ds && ds.stk) || (id ? 'c:' + id : '');
      if (key) ST.send(key);
    };
    App.stkSave = function (id, ds) {
      var key = (ds && ds.stk) || id;
      ST.save(key);
      try { closeModal(); } catch (e) {}
      ST.open(TAB);
    };
    App.stkUnsave = function (id, ds) {
      var key = (ds && ds.stk) || id;
      var u = theMe();
      var rec = mine(u).filter(function (r) { return r && r.ref === key; })[0];
      if (rec) ST.removeRec(rec.id);
      try { closeModal(); } catch (e) {}
      ST.open(TAB);
    };
    App.stkDelRec = function (id) {
      ST.removeRec(id);
      try { closeModal(); } catch (e) {}
      ST.open('saved');
    };
    App.stkPhoto = function () { ST.fromPhoto(); };
    App.stickerSaveMessage = function (id) { ST.saveFromMessage(id); };
    return true;
  }

  /* patch the message menu so received/sent stickers can be saved */
  function patchMenu() {
    if (typeof App === 'undefined' || !App.messageMenu || App.messageMenu.__wcStk) return false;
    var base = App.messageMenu;
    var wrapped = function (msgId) {
      var out = base.apply(this, arguments);
      try {
        var db = (typeof DB !== 'undefined') ? DB : null;
        var m = db && db.messages.filter(function (x) { return x.id === msgId; })[0];
        if (m && m.type === 'sticker') {
          var list = document.querySelector('#overlay .list');
          if (list && !list.querySelector('[data-act="sticker-save-message"]')) {
            var key = String(m.sticker || '');
            var saved = key.indexOf('c:') === 0 ? true : ST.isSaved(key);
            var btn = document.createElement('button');
            btn.className = 'list-item';
            btn.setAttribute('data-act', 'sticker-save-message');
            btn.setAttribute('data-id', msgId);
            btn.style.cssText = 'width:100%;text-align:left';
            btn.innerHTML = (saved ? '⭐ ' : '⭐ ') + '<span class="grow">' + (saved ? 'Saved to My stickers' : 'Save sticker') + '</span>';
            list.insertBefore(btn, list.firstChild);
          }
        }
      } catch (e) {}
      return out;
    };
    wrapped.__wcStk = true;
    App.messageMenu = wrapped;
    return true;
  }

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  function styles() {
    if (document.getElementById('wc-stickers-style')) return;
    var st = document.createElement('style');
    st.id = 'wc-stickers-style';
    st.textContent = [
      '.stk{margin:1px 0}',
      '.stk-tile{width:132px;height:132px;border-radius:22px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.22);position:relative;overflow:hidden}',
      '.stk-tile:after{content:"";position:absolute;inset:0;border-radius:22px;border:2px solid rgba(255,255,255,.22);pointer-events:none}',
      '.stk-e{font-size:84px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.25))}',
      '.stk-img{width:132px;height:132px;border-radius:18px;object-fit:cover;background:var(--surface-2)}',
      '.msg.out .stk-tile,.msg.out .stk-img{width:118px;height:118px}',
      '.msg.out .stk-e{font-size:74px}',
      '.stk-tile.sm{width:58px;height:58px;border-radius:14px;box-shadow:none}',
      '.stk-e.sm{font-size:34px}',
      '.stk-img.sm{width:58px;height:58px;border-radius:14px}',
      '.stk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:9px;max-height:44vh;overflow:auto;padding:2px 1px 6px;-webkit-overflow-scrolling:touch}',
      '.stk-cell{background:transparent;border:0;padding:2px;border-radius:16px;position:relative;cursor:pointer;display:flex;align-items:center;justify-content:center;touch-action:manipulation}',
      '.stk-cell:active{transform:scale(.94)}',
      '.stk-saved{position:absolute;right:3px;bottom:3px;width:9px;height:9px;border-radius:99px;background:var(--accent);box-shadow:0 0 0 2px var(--surface)}',
      '.stk-tabs{display:flex;gap:6px;overflow-x:auto;padding-bottom:8px;margin-bottom:6px}',
      '.stk-tab{white-space:nowrap;padding:5px 11px;border-radius:99px;font-size:11.5px;font-weight:650;color:var(--muted);background:var(--surface-2);border:1px solid transparent}',
      '.stk-tab.on{color:var(--text);border-color:var(--border);background:var(--surface)}',
      '.stk-empty{padding:26px 10px;text-align:center;color:var(--muted)}',
      '.stk-preview{display:flex;justify-content:center;padding:10px 0 14px}',
      '.stk-preview .stk-tile,.stk-preview .stk-img{width:110px;height:110px}',
      '.stk-preview .stk-e{font-size:70px}',
      '.chat-stk-btn{width:38px;height:38px;flex:none}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function boot() {
    styles();
    bindActions();
    patchMenu();
  }
  boot();
  var tries = 0;
  (function retry() {
    if (bindActions() && patchMenu()) return;
    if (tries++ < 100) setTimeout(retry, 250);
  })();
})();
