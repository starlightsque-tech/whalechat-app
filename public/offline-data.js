/* =========================================================================
   WhaleChat local-first data layer  (wc-offline-data)
   -------------------------------------------------------------------------
   Builds on the IndexedDB schema created by offline-first.js (v2) and adds:

     · a mirror of the app's DB into IndexedDB — chats, messages, profiles,
       products, cart and orders — so history is readable and searchable with
       no network
     · an outbox: chat messages and cart changes made offline are stored in
       creation order and flushed when the connection returns
     · "Waiting for network" badges on the messages that are still queued
     · an optimistic cart with a sync badge
     · a hard offline guard on Pay / Checkout — payment needs live verification,
       the cart and invoice stay on the device
     · a calm connectivity pill that appears offline and disappears on reconnect

   Everything returns a promise that is caught: a device with navigator.onLine
   === false must never produce an unhandled rejection or a raw error screen.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcOfflineData) return;
  window.__wcOfflineData = true;

  var VERSION = '3.49.0';
  var OF = window.WC_OFFLINE;
  var OD = window.WC_OFFLINE_DATA = {
    version: VERSION,
    pending: 0,
    lastMirrorAt: 0,
    lastFlushAt: 0,
    lastFlushResult: '',
    flushing: false
  };

  /* ------------------------------------------------------------ helpers */
  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function db() { return safe(function () { return window.DB; }, null); }
  function meSafe() { return safe(function () { return (typeof me === 'function') ? me() : null; }, null); }
  function syncNow() {
    safe(function () { if (typeof sync === 'function') sync(); });
    safe(function () { if (typeof persist === 'function') persist(); });
  }
  function renderNow() { safe(function () { if (typeof render === 'function') render(); }); }
  function toastSafe(m, k) { safe(function () { if (typeof toast === 'function') toast(m, k || 'ok'); }); }
  function hasStore() { return !!(OF && OF.all && OF.put); }

  /* ============================================================== OUTBOX */
  var PENDING_MSGS = {};      /* messageId -> true, kept for the badge pass */
  var pendingCart = {};

  function enqueue(kind, payload) {
    if (!hasStore()) return Promise.resolve(0);
    var rec = { kind: kind, payload: payload || {}, at: Date.now(), status: 'pending', tries: 0, lastError: '' };
    return OF.put('outbox', rec).then(function () {
      OD.pending++;
      paintPill();
      decorate();
      return 1;
    }).catch(function () { return 0; });
  }

  function outboxAll() {
    if (!hasStore()) return Promise.resolve([]);
    return OF.all('outbox').then(function (rows) {
      return (rows || []).sort(function (a, b) { return (a.id || 0) - (b.id || 0); });
    }).catch(function () { return []; });
  }

  /* each handler is idempotent: it forces the intended end state, it never
     re-applies a delta (so a double flush cannot double a cart quantity) */
  var HANDLERS = {
    'message': function () {
      /* the message already lives in the local DB; the state push carries it */
      return true;
    },
    'cart-set': function (p) {
      var u = meSafe(); if (!u) return true;
      u.cart = u.cart || [];
      var line = u.cart.filter(function (c) { return c.productId === p.productId; })[0];
      if (p.qty > 0) {
        if (line) line.qty = p.qty;
        else u.cart.push({ productId: p.productId, qty: p.qty });
      } else if (line) {
        u.cart = u.cart.filter(function (c) { return c.productId !== p.productId; });
      }
      return true;
    },
    'cart-remove': function (p) {
      var u = meSafe(); if (!u) return true;
      u.cart = (u.cart || []).filter(function (c) { return c.productId !== p.productId; });
      return true;
    },
    'cart-clear': function () {
      var u = meSafe(); if (!u) return true;
      u.cart = [];
      return true;
    }
  };

  function flushOutbox(manual) {
    if (OD.flushing) return Promise.resolve(0);
    if (!navigator.onLine) return Promise.resolve(0);
    OD.flushing = true;
    return outboxAll().then(function (items) {
      if (!items.length) { OD.flushing = false; return 0; }
      var done = 0;
      var chain = Promise.resolve();
      items.forEach(function (item) {
        chain = chain.then(function () {
          if (item.status === 'done') return OF.del('outbox', item.id);
          var fn = HANDLERS[item.kind];
          try {
            if (fn) fn(item.payload || {});
          } catch (e) {
            item.lastError = String(e && e.message || e);
          }
          /* mark done then delete; a crash between the two is harmless because
             the handlers are idempotent */
          return OF.del('outbox', item.id).then(function () { done++; });
        });
      });
      return chain.then(function () {
        if (done) {
          syncNow();                      /* one state push for the whole batch */
          Object.keys(PENDING_MSGS).forEach(function (id) {
            var dbx = db(); if (!dbx) return;
            var m = (dbx.messages || []).filter(function (x) { return x.id === id; })[0];
            if (m) { m._pending = false; m._pendingAt = null; }
          });
          PENDING_MSGS = {};
          pendingCart = {};
          OD.lastFlushAt = Date.now();
          OD.lastFlushResult = 'synced ' + done;
          OD.pending = 0;
          renderNow();
          decorate();
          paintPill(true);
          toastSafe(done + ' change' + (done === 1 ? '' : 's') + ' synced', 'ok');
        }
        OD.flushing = false;
        return done;
      }).catch(function (e) {
        OD.flushing = false;
        OD.lastFlushResult = 'error: ' + (e && e.message || e);
        return 0;
      });
    }).catch(function () { OD.flushing = false; return 0; });
  }

  /* ======================================================== MIRROR TO IDB */
  var lastMirror = 0;
  function mirror(force) {
    if (!hasStore()) return Promise.resolve(0);
    var dbx = db(); if (!dbx) return Promise.resolve(0);
    var now = Date.now();
    if (!force && now - lastMirror < 8000) return Promise.resolve(0);
    lastMirror = now;

    var users = (dbx.users || []).map(function (u) {
      return {
        id: u.id, username: u.username || '', fullName: u.fullName || '', role: u.role || 'user',
        avatar: u.avatar || null, bio: u.bio || null, online: !!u.online, updatedAt: now
      };
    });

    var products = (dbx.products || []).slice(-2000).map(function (p) {
      return {
        id: p.id, name: p.name || '', priceUsd: Number(p.priceUsd) || 0, stock: Number(p.stock) || 0,
        active: p.active !== false, vendorId: p.vendorId || null, cat: p.cat || null,
        img: p.img || p.image || null, desc: p.desc || '', updatedAt: now
      };
    });

    var msgs = (dbx.messages || []).slice(-3000).map(function (m) {
      return {
        id: m.id, chatId: m.chatId, from: m.from, to: m.to, type: m.type || 'text',
        text: m.text || '', createdAt: m.createdAt, status: m.status || 'sent',
        deleted: !!m.deleted, pending: !!m._pending
      };
    });

    var byChat = {};
    msgs.forEach(function (m) {
      if (!m.chatId) return;
      if (!byChat[m.chatId] || m.createdAt > byChat[m.chatId]) byChat[m.chatId] = m.createdAt;
    });
    var chats = Object.keys(byChat).map(function (cid) {
      return { id: cid, updatedAt: byChat[cid], pending: false };
    });

    var u = meSafe();
    var cart = ((u && u.cart) || []).map(function (c) {
      var p = (dbx.products || []).filter(function (x) { return x.id === c.productId; })[0];
      return {
        productId: c.productId, qty: Number(c.qty) || 1,
        name: p ? p.name : '', priceUsd: p ? Number(p.priceUsd) || 0 : 0,
        img: p ? (p.img || p.image || null) : null, updatedAt: now
      };
    });

    var orders = (dbx.orders || []).slice(-300).map(function (o) {
      return {
        id: o.id, createdAt: o.createdAt || o.at || now, userId: o.userId || null,
        status: o.status || 'placed', totalUsd: Number(o.totalUsd || o.total || 0) || 0,
        items: o.items || [], vendorId: o.vendorId || null, receipt: o.receipt || null
      };
    });

    return Promise.all([
      OF.bulk('profiles', users),
      OF.bulk('products', products),
      OF.bulk('messages', msgs),
      OF.bulk('chats', chats),
      OF.bulk('orders', orders),
      /* cart is keyed by productId, not id */
      (function () {
        return OF.clear('cart').then(function () {
          if (!cart.length) return 0;
          return OF.db().then(function (d) {
            return new Promise(function (resolve) {
              var tx = d.transaction('cart', 'readwrite');
              var s = tx.objectStore('cart');
              cart.forEach(function (r) { try { s.put(r); } catch (e) {} });
              tx.oncomplete = function () { resolve(cart.length); };
              tx.onerror = function () { resolve(0); };
            });
          });
        });
      })()
    ]).then(function () {
      OD.lastMirrorAt = Date.now();
      return msgs.length;
    }).catch(function () { return 0; });
  }

  /* offline search over the mirrored history */
  OD.searchMessages = function (q) {
    var needle = String(q || '').toLowerCase().trim();
    if (!needle) return Promise.resolve([]);
    return OF.all('messages').then(function (rows) {
      return (rows || []).filter(function (m) {
        return !m.deleted && String(m.text || '').toLowerCase().indexOf(needle) > -1;
      }).sort(function (a, b) { return b.createdAt - a.createdAt; }).slice(0, 100);
    }).catch(function () { return []; });
  };
  OD.mirror = mirror;

  /* ============================================== HOOKS INTO APP ACTIONS */
  function hookSend() {
    var App = safe(function () { return window.App; }, null);
    if (!App || typeof App.send !== 'function' || App.send.__wcOffline) return;
    var orig = App.send;
    App.send = function () {
      var before = {};
      var dbx = db();
      (dbx && dbx.messages || []).forEach(function (m) { before[m.id] = 1; });
      var out = orig.apply(this, arguments);
      Promise.resolve(out).then(function () {
        if (navigator.onLine) return;
        var d = db(); if (!d) return;
        var fresh = (d.messages || []).filter(function (m) { return !before[m.id]; });
        if (!fresh.length) return;
        fresh.forEach(function (m) { m._pending = true; m._pendingAt = Date.now(); PENDING_MSGS[m.id] = 1; });
        syncNow();
        enqueue('message', { ids: fresh.map(function (m) { return m.id; }) });
        decorate();
      }).catch(function () {});
      return out;
    };
    App.send.__wcOffline = true;
  }

  function hookCart() {
    var App = safe(function () { return window.App; }, null);
    if (!App) return;

    function wrap(name, payloadFor) {
      if (typeof App[name] !== 'function' || App[name].__wcOfflineQ) return;
      var orig = App[name];
      App[name] = function () {
        var out = orig.apply(this, arguments);
        if (navigator.onLine) return out;
        var p = payloadFor.apply(this, arguments);
        if (p) { pendingCart[p.productId || '*'] = 1; enqueue(p.kind, p); }
        return out;
      };
      App[name].__wcOfflineQ = true;
    }

    wrap('addToCart', function (id) {
      var u = meSafe(); if (!u) return null;
      var line = (u.cart || []).filter(function (c) { return c.productId === id; })[0];
      return { kind: 'cart-set', productId: id, qty: line ? line.qty : 0 };
    });
    wrap('cartQty', function (id) {
      var u = meSafe(); if (!u) return null;
      var line = (u.cart || []).filter(function (c) { return c.productId === id; })[0];
      return { kind: 'cart-set', productId: id, qty: line ? line.qty : 0 };
    });
    wrap('cartRemove', function (id) { return { kind: 'cart-remove', productId: id }; });
    wrap('clearCart', function () { return { kind: 'cart-clear' }; });

    /* payment needs live server verification — never let it run offline */
    if (typeof App.placeOrder === 'function' && !App.placeOrder.__wcOfflineGuard) {
      var origPlace = App.placeOrder;
      App.placeOrder = function () {
        if (!navigator.onLine) {
          payOfflineNotice();
          return Promise.resolve(false);
        }
        return origPlace.apply(this, arguments);
      };
      App.placeOrder.__wcOfflineGuard = true;
    }
  }

  /* ========================================================== UI: BADGES */
  function decorate() {
    if (!document.body) return;
    /* queued chat messages */
    Object.keys(PENDING_MSGS).forEach(function (id) {
      var el = document.querySelector('[data-msg="' + cssEscape(id) + '"]');
      if (!el) return;
      if (el.querySelector('.wc-pending-badge')) return;
      var b = document.createElement('span');
      b.className = 'wc-pending-badge';
      b.textContent = 'Waiting for network';
      b.setAttribute('title', 'Saved on this device — it will send when you are back online');
      el.appendChild(b);
    });
    /* queued cart badge */
    if (Object.keys(pendingCart).length) {
      var cartHead = document.querySelector('[data-route="cart"] .page-head p');
      if (cartHead && !cartHead.querySelector('.wc-cart-pending')) {
        var s = document.createElement('span');
        s.className = 'wc-cart-pending';
        s.textContent = ' · cart changes waiting for network';
        cartHead.appendChild(s);
      }
    }
    /* payment guard state */
    var pay = document.getElementById('placeOrder');
    if (!navigator.onLine) {
      if (pay && !pay.__wcOfflineDisabled) {
        pay.__wcOfflineDisabled = true;
        pay.disabled = true;
        var note = document.createElement('div');
        note.className = 'wc-pay-offline';
        note.innerHTML = '<b>Payment needs a connection</b><span>Your cart and delivery details are saved on this device. Reconnect to pay — nothing has been charged.</span>';
        pay.parentNode.insertBefore(note, pay);
      }
    } else if (pay) {
      if (pay.__wcOfflineDisabled) { pay.disabled = false; pay.__wcOfflineDisabled = false; }
      var oldNote = document.querySelector('.wc-pay-offline');
      if (oldNote) oldNote.remove();
    }
  }

  function cssEscape(v) { return String(v).replace(/["\\]/g, '\\$&'); }

  function payOfflineNotice() {
    try {
      if (typeof toast === 'function') {
        toast('Payment needs a connection — your cart is saved on this device', 'warn');
        return;
      }
    } catch (e) {}
    alert('Payment needs a connection. Your cart and delivery details are saved on this device.');
  }

  /* ============================================================ UI: PILL */
  var pillTimer = null;
  function paintPill(justSynced) {
    var pill = document.getElementById('wcNetPill');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'wcNetPill';
      pill.className = 'wc-net-pill';
      pill.setAttribute('role', 'status');
      pill.setAttribute('aria-live', 'polite');
      document.body.appendChild(pill);
    }
    clearTimeout(pillTimer);
    var pending = OD.pending;
    if (!navigator.onLine) {
      pill.className = 'wc-net-pill off';
      pill.innerHTML = '<i></i>Offline' + (pending ? ' · ' + pending + ' waiting' : ' · saved on device');
      pill.style.display = 'flex';
      return;
    }
    if (justSynced) {
      pill.className = 'wc-net-pill ok';
      pill.innerHTML = '<i></i>All changes synced';
      pill.style.display = 'flex';
      pillTimer = setTimeout(function () { pill.style.display = 'none'; }, 2600);
      return;
    }
    if (pending) {
      pill.className = 'wc-net-pill wait';
      pill.innerHTML = '<i></i>Syncing ' + pending + ' change' + (pending === 1 ? '' : 's') + '…';
      pill.style.display = 'flex';
      return;
    }
    pill.style.display = 'none';
  }

  function installStyles() {
    if (document.getElementById('wc-od-styles')) return;
    var st = document.createElement('style');
    st.id = 'wc-od-styles';
    st.textContent =
      '.wc-net-pill{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 10px);' +
      'z-index:9994;display:none;align-items:center;gap:7px;padding:7px 13px;border-radius:999px;' +
      'font:600 11.5px Inter,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 10px 24px rgba(0,0,0,.4);' +
      'pointer-events:none;max-width:calc(100vw - 32px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.wc-net-pill i{width:7px;height:7px;border-radius:50%;flex:none;background:currentColor}' +
      '.wc-net-pill.off{background:rgba(30,24,6,.95);color:#ffc400;border:1px solid rgba(255,196,0,.32)}' +
      '.wc-net-pill.ok{background:rgba(6,28,22,.95);color:#2ee6c9;border:1px solid rgba(46,230,201,.32)}' +
      '.wc-net-pill.wait{background:rgba(8,22,34,.95);color:#9fc4d8;border:1px solid rgba(159,196,216,.25)}' +
      '.wc-pending-badge{display:inline-flex;align-items:center;margin-top:4px;padding:2px 7px;border-radius:999px;' +
      'background:rgba(255,196,0,.14);color:#ffc400;font:600 10px/1.5 Inter,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'border:1px solid rgba(255,196,0,.28);letter-spacing:.1px}' +
      '.wc-cart-pending{color:#ffc400;font-weight:600}' +
      '.wc-pay-offline{display:flex;flex-direction:column;gap:3px;margin:10px 0;padding:11px 13px;border-radius:12px;' +
      'background:rgba(30,24,6,.9);border:1px solid rgba(255,196,0,.3);color:#ffc400;' +
      'font:600 12px/1.5 Inter,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.wc-pay-offline span{color:#c9b98a;font-weight:500;font-size:11.5px}';
    document.head.appendChild(st);
  }

  /* ============================================================== BOOT */
  function bindConnectivity() {
    window.addEventListener('online', function () {
      paintPill();
      flushOutbox();
      mirror(true);
    });
    window.addEventListener('offline', function () {
      paintPill();
      decorate();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      mirror();
      if (navigator.onLine) flushOutbox();
      decorate();
    });
  }

  function start() {
    installStyles();
    bindConnectivity();
    paintPill();

    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      hookSend();
      hookCart();
      if (document.body) decorate();
      if (tries > 40) clearInterval(timer);
    }, 500);

    /* pick up anything queued by a previous session */
    OD.pendingCount().then(function (n) { OD.pending = n; paintPill(); }).catch(function () {});

    /* mirror on boot and then on a slow loop (cheap: 8s throttle inside) */
    setTimeout(function () { mirror(true); }, 2000);
    setInterval(function () { mirror(); }, 12000);

    /* decorate after every render without hooking the renderer itself */
    var obs = new MutationObserver(function () {
      if (obs.__t) return;
      obs.__t = setTimeout(function () { obs.__t = null; decorate(); paintPill(); }, 120);
    });
    try { obs.observe(document.body, { childList: true, subtree: true }); } catch (e) {}

    if (navigator.onLine) setTimeout(function () { flushOutbox(); }, 3000);
    if (!navigator.onLine) setTimeout(decorate, 1200);
  }

  OD.flush = flushOutbox;
  OD.enqueue = enqueue;
  OD.pendingCount = function () { return outboxAll().then(function (r) { return r.length; }); };
  OD.decorate = decorate;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
