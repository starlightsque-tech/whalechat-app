/* =========================================================================
   WhaleChat device mode  (wc-offline-actions)
   -------------------------------------------------------------------------
   Keeps the money and trading surfaces usable with no connection, and is
   explicit about the two things a device genuinely cannot do on its own.

   Works offline, recorded on the device and synced on reconnect:
     · stock / market investing (the local trade engine already settles on the
       device and reconciles with the server afterwards)
     · deposits (they are reviewed requests, not an instant charge)
     · withdrawals (request + balance hold, reviewed by the team)
     · transfers to another WhaleChat account
     · cart, checkout details, chat, alerts, wallet history, statement

   Needs the server, shown with a calm explanation instead of a dead button:
     · spot order tickets (/api/market/spot/*) — executed server-side
     · WhaleChat Shares plans and bot marketplace — they run server-side
     · live symbol search (needs Finnhub)

   Every queued money action also writes a row to the outbox, so the state push
   is retried on reconnect even if the tab was closed in between.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcOfflineActions) return;
  window.__wcOfflineActions = true;

  var OA = window.WC_OFFLINE_ACTIONS = {
    version: '3.50.0',
    queued: 0,
    lastQueuedAt: 0,
    lastKind: ''
  };
  var OD = window.WC_OFFLINE_DATA;
  var OF = window.WC_OFFLINE;

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function toastSafe(m, k) { safe(function () { if (typeof toast === 'function') toast(m, k || 'ok'); }); }
  function offline() { return !navigator.onLine; }

  var MONEY_ROUTES = ['wallet', 'deposit', 'withdraw', 'transfer', 'account', 'checkout', 'cart', 'invest', 'investment', 'market'];
  var ROUTE_TEXT = {
    wallet: 'Your balances and history are on this device. Deposits, withdrawals and transfers you make now are recorded here and sync automatically.',
    deposit: 'Send the payment now if you like — this deposit request is saved on your device and submitted the moment you reconnect.',
    withdraw: 'This withdrawal request and its balance hold are saved on your device. Nothing is sent to the blockchain until you reconnect and the team reviews it.',
    transfer: 'The transfer is recorded on this device and will be delivered to the recipient when you are back online.',
    checkout: 'Your cart and delivery details are stored on this device. Payment itself needs a connection.',
    cart: 'Your cart is stored on this device and survives closing the app.',
    invest: 'Trades placed now settle on the device and reconcile with the server when you reconnect.',
    investment: 'Trades placed now settle on the device and reconcile with the server when you reconnect.',
    market: 'Prices shown are the last quotes cached on this device.'
  };

  /* ------------------------------------------------------------ outbox use */
  function queue(kind, payload) {
    if (!OD || !OD.enqueue) return;
    OA.lastKind = kind;
    OA.lastQueuedAt = Date.now();
    OD.enqueue(kind, payload || {}).then(function () {
      OA.queued++;
      paint();
    }).catch(function () {});
  }

  /* register a conservative outbox handler for queued money actions: the local
     DB already holds the result, the flush only needs to push it */
  if (OD && OD.registerHandler) {
    OD.registerHandler('money', function () { return true; });
    OD.registerHandler('state', function () { return true; });
  }

  /* --------------------------------------------------------- hooks: money */
  function wrapMoney(name, kind, label) {
    var App = safe(function () { return window.App; }, null);
    if (!App || typeof App[name] !== 'function' || App[name].__wcOfflineAction) return;
    var orig = App[name];
    App[name] = function () {
      var out = orig.apply(this, arguments);
      Promise.resolve(out).then(function () {
        if (!offline()) return;
        queue(kind, { action: name, at: Date.now() });
        paint();
      }).catch(function () {});
      return out;
    };
    App[name].__wcOfflineAction = true;
  }

  /* --------------------------------------------------- hooks: spot tickets */
  function guardSpot() {
    var App = safe(function () { return window.App; }, null);
    if (!App) return;
    ['spotBuy', 'spotSell'].forEach(function (name) {
      if (typeof App[name] !== 'function' || App[name].__wcSpotGuard) return;
      var orig = App[name];
      App[name] = function () {
        if (offline()) {
          spotOfflineNotice();
          return Promise.resolve(false);
        }
        return orig.apply(this, arguments);
      };
      App[name].__wcSpotGuard = true;
    });
  }

  function spotOfflineNotice() {
    try {
      if (typeof openModal === 'function' && typeof modalShell === 'function') {
        openModal(modalShell('Spot tickets need a connection', `
          <p class="small muted" style="line-height:1.7">Spot orders are executed and settled on the WhaleChat server, so they cannot be placed from the device alone. Your balance and positions are safe and unchanged.</p>
          <p class="small muted mt10" style="line-height:1.7">Stock and market trades still work offline — they settle on your device and reconcile when you reconnect.</p>`,
          `<button class="btn btn-ghost" data-close style="flex:1">Close</button>
           <a href="#/investment" class="btn btn-primary" data-close style="flex:1">Open Invest</a>`));
        return;
      }
    } catch (e) {}
    toastSafe('Spot tickets need a connection — use Invest, which works offline', 'warn');
  }

  /* --------------------------------------------------------------- the pill */
  function paint() {
    var el = document.getElementById('wcDeviceMode');
    var show = offline() && MONEY_ROUTES.indexOf(document.body.dataset.route || '') > -1;
    if (!show) { if (el) el.remove(); return; }
    var text = ROUTE_TEXT[document.body.dataset.route] || ROUTE_TEXT.wallet;
    if (!el) {
      el = document.createElement('div');
      el.id = 'wcDeviceMode';
      el.className = 'wc-device-mode';
      var host = document.getElementById('content') || document.body;
      host.insertBefore(el, host.firstChild && host.firstChild.nextSibling);
    }
    el.innerHTML = '<b>Device mode</b><span>' + text + '</span>';
  }

  function styles() {
    if (document.getElementById('wc-oa-styles')) return;
    var st = document.createElement('style');
    st.id = 'wc-oa-styles';
    st.textContent =
      '.wc-device-mode{display:flex;flex-direction:column;gap:4px;margin:0 0 14px;padding:11px 13px;border-radius:12px;' +
      'background:rgba(30,24,6,.85);border:1px solid rgba(255,196,0,.28);' +
      'font:12px/1.55 Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:#ffc400}' +
      '.wc-device-mode b{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase}' +
      '.wc-device-mode span{color:#c9b98a;font-weight:500}' +
      '.wc-spot-offline{margin-top:10px;padding:9px 11px;border-radius:10px;background:rgba(30,24,6,.85);' +
      'border:1px solid rgba(255,196,0,.28);color:#ffc400;font:600 11.5px/1.5 Inter,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.wc-spot-offline span{display:block;color:#c9b98a;font-weight:500}';
    document.head.appendChild(st);
  }

  /* -------------------------------------------------------- offline notices */
  function annotateSpotButtons() {
    if (!offline()) {
      var old = document.querySelectorAll('.wc-spot-offline');
      for (var j = 0; j < old.length; j++) old[j].remove();
      return;
    }
    var buttons = document.querySelectorAll('[data-act="spot-buy"], [data-act="spot-sell"], [data-act="pc-buy"], [data-act="pc-sell"], #spotBuy, #spotSell');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (b.__wcSpotNote) continue;
      b.__wcSpotNote = true;
      b.disabled = true;
      var n = document.createElement('div');
      n.className = 'wc-spot-offline';
      n.innerHTML = 'Spot ticket needs a connection<span>Invest trades still work offline.</span>';
      b.parentNode.insertBefore(n, b.nextSibling);
    }
  }

  /* ------------------------------------------------------------------ boot */
  function start() {
    styles();
    wrapMoney('submitDeposit', 'money', 'deposit');
    wrapMoney('submitWithdraw', 'money', 'withdrawal');
    guardSpot();

    /* transfers are wired to a data-act handler inside money-hub */
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (!offline()) return;
      if (t.closest('[data-act="mh-send"]')) queue('money', { action: 'transfer', at: Date.now() });
    }, true);

    var tick = function () {
      wrapMoney('submitDeposit', 'money', 'deposit');
      wrapMoney('submitWithdraw', 'money', 'withdrawal');
      guardSpot();
      paint();
      annotateSpotButtons();
    };
    tick();
    setInterval(tick, 1200);

    window.addEventListener('online', function () { setTimeout(tick, 300); });
    window.addEventListener('offline', function () { setTimeout(tick, 200); });
  }

  OA.guardSpot = guardSpot;
  OA.queue = queue;
  OA.capabilities = function () {
    return {
      offline: offline(),
      routes: MONEY_ROUTES.slice(),
      queued: OA.queued,
      needsServer: ['spot orders', 'WhaleChat Shares plans', 'trading bots', 'live symbol search']
    };
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
