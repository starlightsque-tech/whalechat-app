/* =========================================================================
   WhaleChat · offline trading desk (wc-offline-desk)
   -------------------------------------------------------------------------
   One trading surface for both modes, so feature parity is structural rather
   than duplicated:

     ONLINE           prices from Finnhub / Twelve Data / Binance (WC feed),
                      every order is queued with the live price and pushed to
                      the reconciliation engine immediately → Appwrite + Brevo
     OFFLINE (app)    prices from WC_SIM (seeded from the last real close),
                      orders are validated against the device balance, filled
                      locally and queued in `pending_sync`

   Everything the desk does:
     · market buy / sell, limit orders, stop-loss orders
     · watchlist (device persisted)
     · portfolio value, cash, reserved cash, unrealised P/L
     · cash ⇄ wallet transfer
     · order history with Synced / Price adjusted / Active limit badges
     · native chart (live or simulated) in the same panel

   Public API
     WC_DESK.open(symbol)          full-screen desk
     WC_DESK.view()                HTML for the desk body
     WC_DESK.ticket(el, symbol)    embed a trade ticket
     WC_DESK.place(order)          → Promise<result>
     WC_DESK.close()
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_DESK) return;

  var D = window.WC_DEVICE;
  var asset = 'AAPL';
  var tab = 'trade';
  var sheet = null;
  var styleOnce = false;

  function mode() { return window.WC_MODE || { installed: false, online: navigator.onLine !== false }; }
  function online() { return navigator.onLine !== false && mode().online !== false; }
  function installed() { return !!(mode().installed); }
  function money(v) { return '$' + (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function fmtPx(v) { var n = Number(v) || 0; return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toFixed(n >= 1 ? 2 : 4); }
  function toast(m, k) { try { if (typeof toast === 'function') return toast(m, k || 'ok'); } catch (e) {} if (window.WC_RECON) WC_RECON.toast(m, k); }

  /* ------------------------------------------------------------ price feed */
  function livePrice(symbol) {
    var sym = String(symbol || '').toUpperCase();
    try { if (typeof INV !== 'undefined' && INV.live && INV.live[sym]) { var p = Number(INV.live[sym].price); if (p > 0) return { price: p, simulated: false, bid: Number(INV.live[sym].bid) || p, ask: Number(INV.live[sym].ask) || p }; } } catch (e) {}
    try { var q = window.WC_SIM && WC_SIM.quote(sym); if (q && q.price > 0) return q; } catch (e) {}
    return null;
  }

  function priceFor(symbol) {
    var sym = String(symbol || '').toUpperCase();
    if (online()) {
      var live = livePrice(sym);
      if (live && !live.simulated) return live;
      if (live) return live;      /* stale cached quote is better than nothing */
    }
    var S = window.WC_SIM;
    if (S) {
      var q = S.quote(sym);
      if (q && q.simulated) return q;
      if (installed() && D) {
        /* start the simulator from the last cached candle close */
        return S.start(sym, { assetType: /USDT$/.test(sym) ? 'crypto' : 'stock' }) || q || null;
      }
      return q;
    }
    return null;
  }

  function seedSimFromCache(symbol) {
    if (!D || !window.WC_SIM) return Promise.resolve(null);
    return D.getCandles(symbol, '1H').then(function (rows) {
      var last = rows && rows.length ? rows[rows.length - 1] : null;
      return window.WC_SIM.start(symbol, { seedPrice: last ? last.c : 0, candles: rows || [], assetType: /USDT$/.test(symbol) ? 'crypto' : 'stock' });
    });
  }

  /* ------------------------------------------------------------ portfolio */
  function portfolio() {
    if (!D) return Promise.resolve({ cashUsd: 0, reservedUsd: 0, holdings: [], value: 0 });
    return Promise.all([D.portfolio(), D.holdings()]).then(function (r) {
      var p = r[0], hs = r[1] || [];
      var value = hs.reduce(function (a, h) {
        var q = priceFor(h.ticker);
        return a + (Number(h.qty) || 0) * (q && q.price > 0 ? q.price : Number(h.avgPrice) || 0);
      }, 0);
      var cost = hs.reduce(function (a, h) { return a + (Number(h.qty) || 0) * (Number(h.avgPrice) || 0); }, 0);
      return { cashUsd: Number(p.cashUsd) || 0, reservedUsd: Number(p.reservedUsd) || 0, holdings: hs, value: value, cost: cost, pl: value - cost };
    });
  }

  /* -------------------------------------------------------------- placing */
  function place(input) {
    var o = input || {};
    var sym = String(o.symbol || asset).toUpperCase();
    var side = String(o.side || 'BUY').toUpperCase();
    var type = String(o.type || 'MARKET').toUpperCase();
    var q = priceFor(sym);
    var px = Number(o.price) || (q && q.price) || 0;

    if (!installed() && !online()) {
      mode().gate && mode().gate('Offline trading needs WhaleChat installed on your device.');
      return Promise.resolve({ ok: false, error: 'install_required' });
    }
    if (!(px > 0)) {
      toast('Waiting for a price for ' + sym + ' — try again in a moment', 'warn');
      return Promise.resolve({ ok: false, error: 'no_price' });
    }
    if (!D) return Promise.resolve({ ok: false, error: 'no_store' });

    var notional = Number(o.notional) || 0;
    var quantity = Number(o.quantity) || 0;
    if (!notional && quantity) notional = quantity * px;
    if (!quantity && notional) quantity = notional / px;
    if (type === 'LIMIT' || type === 'STOP_LOSS') {
      var trigger = Number(o.triggerPrice) || px;
      if (type === 'LIMIT') notional = quantity ? quantity * trigger : notional;
      else notional = quantity ? quantity * trigger : notional;
    }
    if (!(notional > 0)) return Promise.resolve({ ok: false, error: 'invalid_amount' });

    return Promise.all([D.portfolio(), D.get('holdings', sym)]).then(function (r) {
      var pf = r[0], hold = r[1] || { ticker: sym, qty: 0, avgPrice: 0 };
      var available = (Number(pf.cashUsd) || 0) - (Number(pf.reservedUsd) || 0);
      var heldQty = Number(hold.qty) || 0;
      if (side === 'BUY' && notional > available + 1e-6) {
        return { ok: false, error: 'insufficient_funds', message: 'Available cash ' + money(available) + ' is less than ' + money(notional) };
      }
      if (side === 'SELL' && quantity > heldQty + 1e-9) {
        return { ok: false, error: 'insufficient_units', message: 'You hold ' + heldQty.toFixed(6) + ' ' + sym };
      }

      var clientOrderId = D.uuid();
      var now = Date.now();
      var order = {
        clientOrderId: clientOrderId,
        assetSymbol: sym,
        assetName: sym,
        assetType: /USDT$/.test(sym) ? 'crypto' : 'stock',
        side: side,
        orderType: type,
        quantity: quantity,
        notionalAmount: notional,
        offlineSimulatedPrice: px,
        offlineTimestamp: now,
        triggerPrice: type === 'MARKET' ? 0 : (Number(o.triggerPrice) || px),
        direction: o.direction || '',
        preCashUsd: Number(pf.cashUsd) || 0,
        preHoldingQty: heldQty,
        preAvgPrice: Number(hold.avgPrice) || 0,
        syncStatus: 'PENDING',
        simulated: !online(),
        createdAt: now
      };

      /* optimistic local application — identical whether online or offline */
      var jobs = [];
      if (type === 'TRANSFER') {
        jobs.push(D.savePortfolio({ cashUsd: order.direction === 'to_stock' ? (Number(pf.cashUsd) || 0) + notional : (Number(pf.cashUsd) || 0) - notional }));
      } else if (side === 'BUY') {
        if (type === 'MARKET') {
          jobs.push(D.savePortfolio({ cashUsd: (Number(pf.cashUsd) || 0) - notional }));
          var newQty = heldQty + quantity;
          var newAvg = newQty > 0 ? ((heldQty * (Number(hold.avgPrice) || 0)) + (quantity * px)) / newQty : px;
          jobs.push(D.saveHolding(sym, { qty: newQty, avgPrice: newAvg, userId: pf.userId || '' }));
        } else {
          jobs.push(D.savePortfolio({ cashUsd: (Number(pf.cashUsd) || 0) - notional, reservedUsd: (Number(pf.reservedUsd) || 0) + notional }));
        }
      } else if (side === 'SELL') {
        jobs.push(D.savePortfolio({ cashUsd: (Number(pf.cashUsd) || 0) + notional }));
        jobs.push(D.saveHolding(sym, { qty: Math.max(0, heldQty - quantity), avgPrice: Number(hold.avgPrice) || 0 }));
      }

      return Promise.all(jobs)
        .then(function () { return D.saveOrder(order); })
        .then(function () { return D.queue(order); })
        .then(function () {
          if (!online()) {
            if (window.WC_RECON && WC_RECON.requestBackgroundSync) WC_RECON.requestBackgroundSync();
            toast((simulated() ? 'Simulated ' : '') + side + ' ' + sym + ' filled on this device · queued for sync', 'warn');
            return { ok: true, order: order, local: true };
          }
          return window.WC_RECON.flush({ silent: true }).then(function (out) {
            return { ok: true, order: order, sync: out };
          });
        });
    }).catch(function (e) { return { ok: false, error: e.message }; });
  }

  function simulated() { return !online(); }

  /* ------------------------------------------------------------------ view */
  function styles() {
    if (styleOnce) return;
    styleOnce = true;
    var css = document.createElement('style');
    css.id = 'wc-desk-css';
    css.textContent =
      '.wcdesk{position:fixed;inset:0;z-index:99996;background:#04101a;color:#e9f4f9;display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}' +
      '.wcdesk-top{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.07)}' +
      '.wcdesk-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px 12px 28px}' +
      '.wcdesk-h{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#5d7a8c;margin:0 0 8px}' +
      '.wcdesk-card{background:#0a1a28;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:12px}' +
      '.wcdesk-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
      '.wcdesk-tabs{display:flex;gap:6px;padding:0 12px 10px;overflow-x:auto}' +
      '.wcdesk-tab{flex:0 0 auto;border:1px solid rgba(255,255,255,.1);background:transparent;color:#8ba7b8;font-size:11.5px;font-weight:800;padding:7px 12px;border-radius:9px}' +
      '.wcdesk-tab[data-on="1"]{background:#2ee6c9;color:#03221d;border-color:#2ee6c9}' +
      '.wcdesk-side{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}' +
      '.wcdesk-side button{border-radius:11px;border:1px solid rgba(255,255,255,.12);background:transparent;color:#cfe3ee;font-weight:800;font-size:13px;padding:11px}' +
      '.wcdesk-side button[data-on="1"][data-side="BUY"]{background:#2ee6c9;color:#03221d;border-color:#2ee6c9}' +
      '.wcdesk-side button[data-on="1"][data-side="SELL"]{background:#ff5c6e;color:#210308;border-color:#ff5c6e}' +
      '.wcdesk-input{width:100%;background:#04101a;border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#e9f4f9;font-size:15px;font-weight:700;padding:10px 12px;outline:none}' +
      '.wcdesk-chip{border:1px solid rgba(255,255,255,.12);background:transparent;color:#8ba7b8;border-radius:8px;font-size:10.5px;font-weight:800;padding:5px 8px}' +
      '.wcdesk-chip[data-on="1"]{background:#0f2f3d;color:#98f2e2;border-color:#2ee6c955}' +
      '.wcdesk-btn{width:100%;border:0;border-radius:12px;padding:13px;font-weight:800;font-size:14px;margin-top:12px}' +
      '.wcdesk-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:12.5px}' +
      '.wcdesk-row:last-child{border-bottom:0}' +
      '.wcdesk-fab{position:fixed;right:14px;bottom:calc(78px + env(safe-area-inset-bottom));z-index:9000;border:0;border-radius:999px;padding:13px 18px;background:linear-gradient(145deg,#2ee6c9,#14a4a0);color:#03221d;font-weight:900;font-size:13px;box-shadow:0 12px 28px rgba(0,0,0,.45)}' +
      '@media(min-width:820px){.wcdesk-body{max-width:860px;margin:0 auto;width:100%}}';
    document.head.appendChild(css);
  }

  function statusPill() {
    var live = online();
    return '<span style="font-size:9.5px;font-weight:800;letter-spacing:.07em;padding:3px 8px;border-radius:6px;border:1px solid ' + (live ? '#2ee6c955' : '#f5b54455') + ';color:' + (live ? '#2ee6c9' : '#f5b544') + ';background:' + (live ? '#2ee6c912' : '#f5b54414') + '">' + (live ? 'LIVE MARKET' : 'OFFLINE SIMULATED') + '</span>';
  }

  function view() {
    if (!D) return '<div class="wcdesk-body"><p>Device storage unavailable.</p></div>';
    return portfolio().then(function (pf) {
      return D.watched().then(function (watch) {
        return D.orders().then(function (orders) {
          var rows = (orders || []).slice(0, 30).map(function (o) {
            var tag = window.WC_RECON ? WC_RECON.badge(o.syncStatus) : '';
            return '<div class="wcdesk-row" data-client-order="' + esc(o.clientOrderId) + '">' +
              '<div style="min-width:0"><b>' + esc(o.side) + ' ' + esc(o.assetSymbol) + '</b> <span style="color:#5d7a8c;font-size:10.5px">' + esc(o.orderType) + '</span><div style="color:#5d7a8c;font-size:10.5px">' + new Date(o.offlineTimestamp || o.createdAt).toLocaleString() + '</div></div>' +
              '<div style="text-align:right"><b>' + money(o.notionalAmount) + '</b><div style="color:#5d7a8c;font-size:10.5px">' + (o.executedPrice ? '@ ' + fmtPx(o.executedPrice) : '@ ' + fmtPx(o.offlineSimulatedPrice)) + ' ' + tag + '</div></div>' +
              '</div>';
          }).join('') || '<div style="color:#5d7a8c;font-size:12px">No trades yet.</div>';

          var holdings = (pf.holdings || []).map(function (h) {
            var q = priceFor(h.ticker);
            var last = q && q.price > 0 ? q.price : Number(h.avgPrice) || 0;
            var val = last * (Number(h.qty) || 0);
            var pl = val - (Number(h.qty) || 0) * (Number(h.avgPrice) || 0);
            return '<div class="wcdesk-row"><div><b>' + esc(h.ticker) + '</b><div style="color:#5d7a8c;font-size:10.5px">' + Number(h.qty).toFixed(6) + ' @ ' + fmtPx(h.avgPrice) + '</div></div>' +
              '<div style="text-align:right"><b>' + money(val) + '</b><div style="color:' + (pl >= 0 ? '#2ee6c9' : '#ff5c6e') + ';font-size:10.5px">' + (pl >= 0 ? '+' : '') + money(pl) + ' · <a href="#" data-wc-open="' + esc(h.ticker) + '" style="color:#7ab6ff;text-decoration:none">trade</a></div></div></div>';
          }).join('') || '<div style="color:#5d7a8c;font-size:12px">No open positions.</div>';

          var watchRows = (watch || []).map(function (sym) {
            var q = priceFor(sym);
            return '<div class="wcdesk-row"><a href="#" data-wc-open="' + esc(sym) + '" style="color:#e9f4f9;text-decoration:none;font-weight:800">' + esc(sym) + '</a>' +
              '<div style="text-align:right"><b>' + (q ? fmtPx(q.price) : '—') + '</b> <button data-wc-unwatch="' + esc(sym) + '" style="border:0;background:transparent;color:#ff5c6e;font-size:11px;font-weight:700">remove</button></div></div>';
          }).join('') || '<div style="color:#5d7a8c;font-size:12px">Your watchlist is empty — add assets from the Trade tab.</div>';

          return '' +
            '<div class="wcdesk-tabs">' +
              ['trade', 'portfolio', 'orders', 'watchlist', 'transfer'].map(function (t) {
                return '<button class="wcdesk-tab" data-tab="' + t + '" data-on="' + (tab === t ? 1 : 0) + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</button>';
              }).join('') +
            '</div>' +
            '<div class="wcdesk-body">' +
              '<div class="wcdesk-card" style="margin-bottom:12px">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
                  '<div><div class="wcdesk-h" style="margin:0">Portfolio</div>' +
                  '<div style="font-size:22px;font-weight:900;letter-spacing:-.02em">' + money(pf.value + pf.cashUsd) + '</div>' +
                  '<div style="font-size:11px;color:' + (pf.pl >= 0 ? '#2ee6c9' : '#ff5c6e') + ';font-weight:700">' + (pf.pl >= 0 ? '▲' : '▼') + ' ' + money(Math.abs(pf.pl)) + ' unrealised</div></div>' +
                  '<div style="text-align:right"><div class="wcdesk-h" style="margin:0">Cash</div>' +
                  '<div style="font-size:15px;font-weight:800">' + money(pf.cashUsd) + '</div>' +
                  '<div style="font-size:10.5px;color:#5d7a8c">' + money(pf.reservedUsd) + ' reserved</div></div>' +
                '</div>' +
                '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;border-top:1px solid rgba(255,255,255,.06);padding-top:8px;font-size:10.5px;color:#5d7a8c">' +
                  '<span>' + (installed() ? 'Installed app · device storage' : 'Browser tab · offline locked') + '</span>' + statusPill() +
                '</div>' +
              '</div>' +
              (tab === 'trade' ? '<div id="wcdesk-trade"></div><div class="wcdesk-card" style="margin-top:12px"><div class="wcdesk-h">Chart · ' + esc(asset) + '</div><div id="wcdesk-chart" data-height="300"></div></div>' : '') +
              (tab === 'portfolio' ? '<div class="wcdesk-card"><div class="wcdesk-h">Holdings</div>' + holdings + '</div>' : '') +
              (tab === 'orders' ? '<div class="wcdesk-card"><div class="wcdesk-h">Order history</div>' + rows + '</div>' : '') +
              (tab === 'watchlist' ? '<div class="wcdesk-card"><div class="wcdesk-h">Watchlist</div>' + watchRows + '</div>' : '') +
              (tab === 'transfer' ? '<div class="wcdesk-card" id="wcdesk-transfer"></div>' : '') +
            '</div>';
        });
      });
    });
  }

  function ticketHtml(sym) {
    var q = priceFor(sym);
    return '' +
      '<div class="wcdesk-card">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
          '<input class="wcdesk-input" id="wcdesk-sym" value="' + esc(sym) + '" style="max-width:130px;text-transform:uppercase" aria-label="Symbol" />' +
          '<div style="text-align:right"><div style="font-size:17px;font-weight:900" id="wcdesk-px">' + (q ? fmtPx(q.price) : '—') + '</div>' +
          '<div style="font-size:10px;color:#5d7a8c" id="wcdesk-bidask">' + (q ? 'bid ' + fmtPx(q.bid) + ' · ask ' + fmtPx(q.ask) : 'waiting for price') + '</div></div>' +
        '</div>' +
        '<div class="wcdesk-side">' +
          '<button data-side="BUY" data-on="1">Buy</button>' +
          '<button data-side="SELL" data-on="0">Sell</button>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-bottom:10px">' +
          '<button class="wcdesk-chip" data-type="MARKET" data-on="1">Market</button>' +
          '<button class="wcdesk-chip" data-type="LIMIT" data-on="0">Limit</button>' +
          '<button class="wcdesk-chip" data-type="STOP_LOSS" data-on="0">Stop-loss</button>' +
        '</div>' +
        '<label class="wcdesk-h" for="wcdesk-amt">Amount (USD)</label>' +
        '<input class="wcdesk-input" id="wcdesk-amt" inputmode="decimal" placeholder="0.00" />' +
        '<div style="display:flex;gap:6px;margin-top:8px">' +
          ['25', '50', '100', '250'].map(function (v) { return '<button class="wcdesk-chip" data-amt="' + v + '">$' + v + '</button>'; }).join('') +
        '</div>' +
        '<div id="wcdesk-trigger-wrap" style="display:none;margin-top:10px">' +
          '<label class="wcdesk-h" for="wcdesk-trigger">Trigger price</label>' +
          '<input class="wcdesk-input" id="wcdesk-trigger" inputmode="decimal" placeholder="' + (q ? fmtPx(q.price) : '0.00') + '" />' +
        '</div>' +
        '<div id="wcdesk-qty-line" style="margin-top:8px;font-size:11px;color:#5d7a8c">≈ 0 units</div>' +
        '<button class="wcdesk-btn" id="wcdesk-submit" style="background:#2ee6c9;color:#03221d">Buy</button>' +
        '<div style="margin-top:8px;font-size:10.5px;color:#5d7a8c" id="wcdesk-help">' + (online() ? 'Orders settle against live Finnhub / Twelve Data / Binance prices and sync to Appwrite.' : 'Offline: the order fills at the simulated device price and syncs automatically when you reconnect.') + '</div>' +
        ' <button class="wcdesk-chip" id="wcdesk-watch" style="margin-top:8px">+ Watchlist</button>' +
      '</div>';
  }

  function wireTicket(root, symbol) {
    var state = { side: 'BUY', type: 'MARKET', sym: symbol };
    var symEl = root.querySelector('#wcdesk-sym');
    var amtEl = root.querySelector('#wcdesk-amt');
    var trigWrap = root.querySelector('#wcdesk-trigger-wrap');
    var trigEl = root.querySelector('#wcdesk-trigger');
    var submit = root.querySelector('#wcdesk-submit');
    var qtyLine = root.querySelector('#wcdesk-qty-line');
    var pxEl = root.querySelector('#wcdesk-px');
    var bidask = root.querySelector('#wcdesk-bidask');

    function refreshPrice() {
      var q = priceFor(state.sym);
      if (q) {
        pxEl.textContent = fmtPx(q.price);
        bidask.textContent = 'bid ' + fmtPx(q.bid) + ' · ask ' + fmtPx(q.ask);
        if (!trigEl.value) trigEl.placeholder = fmtPx(q.price);
      }
      var qq = q ? q.price : 0;
      var amt = Number(amtEl.value) || 0;
      qtyLine.textContent = qq > 0 && amt > 0 ? '≈ ' + (amt / qq).toFixed(6) + ' units @ ' + fmtPx(qq) : '≈ 0 units';
    }

    root.querySelectorAll('[data-side]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.side = b.getAttribute('data-side');
        root.querySelectorAll('[data-side]').forEach(function (x) { x.setAttribute('data-on', x === b ? '1' : '0'); });
        submit.textContent = state.side === 'BUY' ? 'Buy' : 'Sell';
        submit.style.background = state.side === 'BUY' ? '#2ee6c9' : '#ff5c6e';
        submit.style.color = state.side === 'BUY' ? '#03221d' : '#210308';
      });
    });
    root.querySelectorAll('[data-type]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.type = b.getAttribute('data-type');
        root.querySelectorAll('[data-type]').forEach(function (x) { x.setAttribute('data-on', x === b ? '1' : '0'); });
        trigWrap.style.display = state.type === 'MARKET' ? 'none' : '';
      });
    });
    root.querySelectorAll('[data-amt]').forEach(function (b) {
      b.addEventListener('click', function () { amtEl.value = b.getAttribute('data-amt'); refreshPrice(); });
    });
    amtEl.addEventListener('input', refreshPrice);
    if (symEl) symEl.addEventListener('change', function () {
      state.sym = String(symEl.value || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
      symEl.value = state.sym;
      refreshPrice();
      if (installed() && !online()) seedSimFromCache(state.sym);
    });
    var watchBtn = root.querySelector('#wcdesk-watch');
    if (watchBtn) watchBtn.addEventListener('click', function () {
      D.watch(state.sym).then(function () { toast(state.sym + ' added to your watchlist'); });
    });

    submit.addEventListener('click', function () {
      var amt = Number(amtEl.value) || 0;
      if (!(amt > 0)) { toast('Enter an amount to ' + state.side.toLowerCase(), 'warn'); return; }
      submit.disabled = true;
      place({
        symbol: state.sym, side: state.side, type: state.type,
        notional: amt,
        triggerPrice: state.type === 'MARKET' ? 0 : Number(trigEl.value) || 0
      }).then(function (out) {
        submit.disabled = false;
        if (!out.ok) { toast((out.message || out.error || 'Order rejected'), 'warn'); return; }
        amtEl.value = '';
        refreshPrice();
        if (window.WC_NCHART && document.getElementById('wcdesk-chart')) {
          var c = document.getElementById('wcdesk-chart').__wcncMounted;
          void c;
        }
        renderDesk();
      });
    });

    setInterval(function () { if (root.isConnected) refreshPrice(); }, 1500);
    refreshPrice();
  }

  function transferPanel(root) {
    var state = { dir: 'to_wallet' };
    root.innerHTML =
      '<div class="wcdesk-h">Balance transfer</div>' +
      '<p style="font-size:11.5px;color:#8ba7b8;line-height:1.6;margin:0 0 10px">Move funds between your stock trading cash and your WhaleChat wallet. Offline transfers are validated on the device and reconciled with Appwrite when you reconnect.</p>' +
      '<div style="display:flex;gap:6px;margin-bottom:10px">' +
        '<button class="wcdesk-chip" data-dir="to_wallet" data-on="1">Cash → Wallet</button>' +
        '<button class="wcdesk-chip" data-dir="to_stock" data-on="0">Wallet → Cash</button>' +
      '</div>' +
      '<input class="wcdesk-input" id="wcdesk-tr-amt" inputmode="decimal" placeholder="0.00" />' +
      '<button class="wcdesk-btn" id="wcdesk-tr-go" style="background:#7ab6ff;color:#03101f">Transfer</button>';
    root.querySelectorAll('[data-dir]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.dir = b.getAttribute('data-dir');
        root.querySelectorAll('[data-dir]').forEach(function (x) { x.setAttribute('data-on', x === b ? '1' : '0'); });
      });
    });
    root.querySelector('#wcdesk-tr-go').addEventListener('click', function () {
      var amt = Number(root.querySelector('#wcdesk-tr-amt').value) || 0;
      if (!(amt > 0)) { toast('Enter an amount', 'warn'); return; }
      place({ symbol: 'USD', side: 'TRANSFER', type: 'TRANSFER', notional: amt, direction: state.dir })
        .then(function (out) {
          if (!out.ok) { toast(out.message || out.error || 'Transfer rejected', 'warn'); return; }
          toast('Transfer queued');
          renderDesk();
        });
    });
  }

  function renderDesk() {
    if (!sheet) return;
    var body = sheet.querySelector('#wcdesk-root');
    view().then(function (html) {
      body.innerHTML = html;
      body.querySelectorAll('[data-tab]').forEach(function (b) {
        b.addEventListener('click', function () { tab = b.getAttribute('data-tab'); renderDesk(); });
      });
      body.querySelectorAll('[data-wc-open]').forEach(function (a) {
        a.addEventListener('click', function (e) { e.preventDefault(); asset = a.getAttribute('data-wc-open'); tab = 'trade'; renderDesk(); });
      });
      body.querySelectorAll('[data-wc-unwatch]').forEach(function (b) {
        b.addEventListener('click', function () { D.unwatch(b.getAttribute('data-wc-unwatch')).then(renderDesk); });
      });
      if (tab === 'trade') {
        var host = body.querySelector('#wcdesk-trade');
        if (host) { host.innerHTML = ticketHtml(asset); wireTicket(host, asset); }
        var chartHost = body.querySelector('#wcdesk-chart');
        if (chartHost && window.WC_NCHART) {
          chartHost.innerHTML = '';
          var ctl = WC_NCHART.mount(chartHost, { symbol: asset, height: 300 });
          chartHost.__wcncMounted = ctl;
        }
      }
      if (tab === 'transfer') {
        var tr = body.querySelector('#wcdesk-transfer');
        if (tr) transferPanel(tr);
      }
      if (window.WC_RECON) WC_RECON.decorate(body);
    });
  }

  function open(symbol) {
    styles();
    if (symbol) asset = String(symbol).toUpperCase();
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.className = 'wcdesk';
      sheet.id = 'wcdesk';
      sheet.innerHTML =
        '<div class="wcdesk-top">' +
          '<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:900;letter-spacing:-.01em">Trading desk</div>' +
          '<div style="font-size:10.5px;color:#5d7a8c">Online &amp; offline · Appwrite reconciled</div></div>' +
          '<button id="wcdesk-close" style="border:1px solid rgba(255,255,255,.14);background:transparent;color:#cfe3ee;font-weight:700;font-size:12px;padding:7px 12px;border-radius:9px">Close</button>' +
        '</div>' +
        '<div id="wcdesk-root" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>';
      document.body.appendChild(sheet);
      sheet.querySelector('#wcdesk-close').addEventListener('click', function () {
        sheet.remove(); sheet = null;
        if (window.WC_SIM) WC_SIM.stop();
        if (location.hash === '#/offline-trade') location.hash = '#/investment';
      });
    }
    renderDesk();
    if (!installed() && !online()) mode().gate && mode().gate();
    return sheet;
  }

  function close() { if (sheet) { sheet.remove(); sheet = null; } }

  /* --------------------------------------------------------------- wiring */
  function wire() {
    /* hash route: #/offline-trade or #/trade-desk */
    function route() {
      if (/^#\/(offline-trade|trade-desk|desk)\b/.test(location.hash)) {
        var m = location.hash.match(/[?&]asset=([A-Za-z0-9.]+)/);
        open(m ? m[1] : asset);
      }
    }
    window.addEventListener('hashchange', route);
    route();

    /* floating entry point */
    var fab = document.createElement('button');
    fab.id = 'wcdesk-fab';
    fab.className = 'wcdesk-fab';
    fab.textContent = 'Trade';
    fab.title = 'Open the trading desk';
    fab.addEventListener('click', function () { open(); });
    var tryPlace = function () {
      if (document.getElementById('wcdesk-fab')) return;
      if (!document.body) return;
      document.body.appendChild(fab);
    };
    setTimeout(tryPlace, 1500);

    /* keep the ticket + portfolio fresh as the feed ticks */
    setInterval(function () {
      if (!sheet) return;
      var px = sheet.querySelector('#wcdesk-px');
      if (!px) return;
      var q = priceFor(asset);
      if (q) {
        px.textContent = fmtPx(q.price);
        var ba = sheet.querySelector('#wcdesk-bidask');
        if (ba) ba.textContent = 'bid ' + fmtPx(q.bid) + ' · ask ' + fmtPx(q.ask);
      }
    }, 1500);

    window.addEventListener('wc:sync', function () { if (sheet) renderDesk(); });
    window.addEventListener('online', function () { if (sheet) renderDesk(); });
    window.addEventListener('offline', function () { if (sheet) renderDesk(); });
  }

  window.WC_DESK = {
    open: open,
    close: close,
    view: view,
    place: place,
    ticket: function (el, symbol) {
      if (!el) return;
      styles();
      el.innerHTML = ticketHtml(String(symbol || asset).toUpperCase());
      wireTicket(el, String(symbol || asset).toUpperCase());
    },
    portfolio: portfolio,
    priceFor: priceFor,
    setAsset: function (s) { asset = String(s).toUpperCase(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
