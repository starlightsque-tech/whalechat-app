/* =========================================================================
   WhaleChat Money Hub
   Unified transfers between every user balance, crypto-only withdrawals,
   USD/WC/crypto conversion and investment send-to-user.
   Loaded after investment-hub.js and account-center.js.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcMoneyHub) return;
  window.__wcMoneyHub = true;

  var RATE = (typeof COIN_USD === 'number') ? COIN_USD : 0.5;
  var COINS = ['USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'TRX', 'LTC', 'ADA', 'MATIC'];

  /* ---- crypto balance display: each coin shown in its own units ---------- */
  var STABLE = { USDT: 1, USDC: 1, BUSD: 1, DAI: 1, FDUSD: 1, TUSD: 1, USD: 1 };
  var priceCache = {};
  function coinPrice(coin) {
    coin = String(coin || '').toUpperCase();
    if (STABLE[coin]) return 1;
    try {
      var q = (window.WC_MARKET && window.WC_MARKET.feed && window.WC_MARKET.feed.quotes) || {};
      var hit = q[coin + 'USDT'] || q[coin + 'USD'] || q[coin];
      var p = hit && Number(hit.price);
      if (p > 0) { priceCache[coin] = p; return p; }
    } catch (e) {}
    return priceCache[coin] || 0;
  }
  function fmtQty(q) {
    q = Number(q) || 0;
    if (q >= 1000) return q.toFixed(2);
    if (q >= 1) return String(Math.round(q * 10000) / 10000);
    if (q === 0) return '0';
    return String(Number(q.toPrecision(4)));
  }
  function coinLabel(coin, usd) {
    var p = coinPrice(coin);
    coin = String(coin || '').toUpperCase();
    if (!(p > 0)) return moneyM(usd) + ' of ' + coin;
    return fmtQty((Number(usd) || 0) / p) + ' ' + coin;
  }
  (function primePrices() {
    try {
      var url = (typeof Remote !== 'undefined' && Remote && Remote.url) ? Remote.url('/api/market/quotes') : '/api/market/quotes';
      fetch(url).then(function (r) { return r.json(); }).then(function (d) {
        var q = (d && (d.quotes || d)) || {};
        var list = Array.isArray(q) ? q : Object.keys(q).map(function (k) { var x = q[k] || {}; if (!x.symbol) x.symbol = k; return x; });
        list.forEach(function (x) {
          var s = String(x.symbol || '').toUpperCase(); var p = Number(x.price);
          if (!(p > 0)) return;
          var m = s.match(/^([A-Z0-9]+?)(USDT|USD)$/);
          if (m && !priceCache[m[1]]) priceCache[m[1]] = p;
        });
      }).catch(function () {});
    } catch (e) {}
  })();
  window.WC_COIN = { price: coinPrice, label: coinLabel, qty: fmtQty };

  function escM(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function moneyM(n) { return '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
  function wcM(n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
  function roundM(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function icM(name, size) { try { return (typeof ic === 'function') ? ic(name, size || 16) : ''; } catch (e) { return ''; } }
  function toastM(msg, type) { try { toast(msg, type || 'ok'); } catch (e) {} }
  function saveM() { try { persist(); } catch (e) {} try { sync(); } catch (e) {} }
  function renderM() { try { render(); } catch (e) {} }
  function nowIdM(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function pinHash(pin) { try { return hash('pin::' + pin); } catch (e) { return Promise.resolve(''); } }

  function acct(u) {
    u = u || me();
    if (!u) return null;
    if (!u.referralCode) u.referralCode = 'WC' + Math.random().toString(36).slice(2, 7).toUpperCase();
    if (!u.accountId || u.accountId !== u.referralCode) u.accountId = u.referralCode;
    if (!(Number(u.walletUsd) >= 0)) u.walletUsd = Number(u.walletUsd) || 0;
    if (!u.depositBalances || typeof u.depositBalances !== 'object' || Array.isArray(u.depositBalances)) {
      var map = {};
      try {
        (DB.deposits || []).forEach(function (d) {
          if (!d || d.userId !== u.id || d.status !== 'approved') return;
          if (d.creditedToDeposit !== true) { d.creditedToDeposit = false; return; }
          var coin = String(d.coin || 'USD').toUpperCase();
          map[coin] = roundM((map[coin] || 0) + (Number(d.usd) || 0));
        });
      } catch (e) {}
      u.depositBalances = map;
    }
    if (!Array.isArray(u.acctLedger)) u.acctLedger = [];
    return u;
  }
  function ia(u) {
    if (typeof account === 'function') { try { return account(u); } catch (e) {} }
    if (!u.investAcct) u.investAcct = { usd: 0, payout: 0, wcBalance: 0, portfolios: { stock: 0, wc: 0, b2b: 0, bot: 0 }, stockProfit: 0, wcProfit: 0, wcLeftover: 0, stockLeftover: 0, b2bProfit: 0, tools: {}, b2b: {}, b2bFav: [], b2bAlerts: [], disputes: [], requests: [], ledger: [] };
    var a = u.investAcct;
    if (!a.portfolios) a.portfolios = { stock: 0, wc: 0, b2b: 0, bot: 0 };
    ['usd', 'payout', 'wcBalance', 'stockProfit', 'wcProfit', 'wcLeftover', 'stockLeftover', 'b2bProfit'].forEach(function (k) { if (!(Number(a[k]) >= 0)) a[k] = Number(a[k]) || 0; });
    ['stock', 'wc', 'b2b', 'bot'].forEach(function (k) { if (!(Number(a.portfolios[k]) >= 0)) a.portfolios[k] = 0; });
    return a;
  }
  function botProfitUsd() {
    try {
      var s = window.WC_BOTS && window.WC_BOTS.state;
      if (s && s.account) return Number(s.account.profitUsd != null ? s.account.profitUsd : (s.account.profitCoins || 0) * 0.5) || 0;
    } catch (e) {}
    return 0;
  }
  function ledgerM(u, label, usdDelta, wcDelta, meta) {
    acct(u);
    var m = meta || null;
    var id = String((m && (m.from || m.to)) || '');
    var scope = /^b2b/.test(id) ? 'b2b' : /^stock/.test(id) ? 'stock' : /^wc_/.test(id) ? 'wc' : /^bot/.test(id) ? 'bot' : 'general';
    u.acctLedger.unshift({ id: nowIdM('al_'), label: label, usd: roundM(usdDelta), wc: roundM(wcDelta), scope: scope, meta: m, at: Date.now() });
    if (u.acctLedger.length > 200) u.acctLedger.length = 200;
  }

  function definitions(u) {
    var a = ia(u);
    var d = u.depositBalances || {};
    var list = [
      { id: 'wallet_wc', group: 'Whalechat account', label: 'WC balance', cur: 'WC', get: function () { return Number(u.balance) || 0; }, set: function (v) { u.balance = roundM(v); }, out: true, in: true },
      { id: 'inv_usd', group: 'Investment account', label: 'Trade capital (USD)', cur: 'USD', get: function () { return Number(a.usd) || 0; }, set: function (v) { a.usd = roundM(v); }, out: true, in: true },
      { id: 'inv_payout', group: 'Investment account', label: 'Total profit balance', cur: 'USD', get: function () { return Number(a.payout) || 0; }, set: function (v) { a.payout = roundM(v); }, out: true, in: true },
      { id: 'stock_capital', group: 'Stock trading', label: 'Trade capital balance', cur: 'USD', get: function () { return Number(a.portfolios.stock) || 0; }, set: function (v) { a.portfolios.stock = roundM(v); }, out: false, in: true },
      { id: 'stock_profit', group: 'Stock trading', label: 'Profit balance', cur: 'USD', get: function () { return Number(a.stockProfit) || 0; }, set: function (v) { a.stockProfit = roundM(v); }, out: true, in: true },
      { id: 'stock_leftover', group: 'Stock trading', label: 'Leftover capital', cur: 'USD', get: function () { return Number(a.stockLeftover) || 0; }, set: function (v) { a.stockLeftover = roundM(v); }, out: true, in: false },
      { id: 'wc_capital', group: 'WC-Investing', label: 'Capital balance', cur: 'USD', get: function () { return Number(a.portfolios.wc) || 0; }, set: function (v) { a.portfolios.wc = roundM(v); }, out: false, in: true },
      { id: 'wc_profit', group: 'WC-Investing', label: 'Profit balance', cur: 'USD', get: function () { return Number(a.wcProfit) || 0; }, set: function (v) { a.wcProfit = roundM(v); }, out: true, in: true },
      { id: 'b2b_capital', group: 'B2B Investing', label: 'Capital balance', cur: 'USD', get: function () { return Number(a.portfolios.b2b) || 0; }, set: function (v) { var inc = roundM(v) - (Number(a.portfolios.b2b) || 0); if (inc > 0 && a.b2bDeposited !== undefined && !isNaN(Number(a.b2bDeposited))) a.b2bDeposited = roundM(Number(a.b2bDeposited) + inc); a.portfolios.b2b = roundM(v); }, out: false, in: true },
      { id: 'b2b_profit', group: 'B2B Investing', label: 'Profit balance', cur: 'USD', get: function () { return Number(a.b2bProfit) || 0; }, set: function (v) { a.b2bProfit = roundM(v); }, out: true, in: true },
      { id: 'bot_capital', group: 'Bot trading', label: 'Bot capital allocation', cur: 'USD', get: function () { return Number(a.portfolios.bot) || 0; }, set: function (v) { a.portfolios.bot = roundM(v); }, out: false, in: true },
      { id: 'bot_profit', group: 'Bot trading', label: 'Bot profit balance', cur: 'USD', get: function () { return botProfitUsd(); }, set: function () {}, out: true, in: false }
    ];
    if (hasVendor(u)) list.splice(1, 0, { id: 'vendor_cap', group: 'Vendor profile', label: 'Vendor capital (USD)', cur: 'USD', get: function () { return Number(u.vendorCapitalUsd) || 0; }, set: function (v) { u.vendorCapitalUsd = roundM(v); }, out: false, in: true });
    /* balances from the old flow stay intact; they can only move to the WC balance */
    if (Number(u.walletUsd) > 0.004) list.push({ id: 'wallet_usd', group: 'Whalechat account', label: 'Old $ balance', cur: 'USD', get: function () { return Number(u.walletUsd) || 0; }, set: function (v) { u.walletUsd = roundM(v); }, out: true, in: false });
    if (Number(a.wcBalance) > 0.004) list.push({ id: 'inv_wc', group: 'Investment account', label: 'Old investment WhaleCoin', cur: 'WC', get: function () { return Number(a.wcBalance) || 0; }, set: function (v) { a.wcBalance = roundM(v); }, out: true, in: false });
    return list;
  }
  function hasVendor(u) {
    try { if (typeof vendorOf === 'function') return !!vendorOf(u.id); } catch (e) {}
    try { return (DB.vendors || []).some(function (v) { return v.userId === u.id; }); } catch (e) { return false; }
  }
  /* money-flow rules (3.44)
     WhaleChat account:
       crypto              -> WC balance (Convert page only)
       WC balance          -> investment trade capital or vendor capital (auto WC -> USD)
       WC balance          -> USDT / BTC crypto for withdrawal (Convert page only)
     Investment account (USD, transfers happen only here):
       trade capital       -> stock / WC-Investing / B2B / bot capital
       portfolio profits   -> total profit balance or trade capital
       total profit        -> WhaleChat WC balance (auto USD -> WC) or trade capital
     old $ / old inv. WC   -> WC balance only */
  var ACCOUNT_SOURCES = ['wallet_wc', 'wallet_usd'];
  function allowedTargets(srcId, u) {
    if (srcId === 'wallet_wc') return (u && hasVendor(u)) ? ['inv_usd', 'vendor_cap'] : ['inv_usd'];
    if (srcId === 'wallet_usd' || srcId === 'inv_wc') return ['wallet_wc'];
    if (srcId === 'inv_usd') return ['stock_capital', 'wc_capital', 'b2b_capital', 'bot_capital'];
    if (srcId === 'inv_payout') return ['wallet_wc', 'inv_usd'];
    return ['inv_payout', 'inv_usd'];
  }
  function defById(u, id) {
    var list = definitions(u);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function units(cur) { return cur === 'WC' ? RATE : 1; }
  function converted(amount, src, dst) { return roundM((Number(amount) || 0) * units(src.cur) / units(dst.cur)); }
  function display(def, value) { return def.cur === 'WC' ? wcM(value) + ' WC' : moneyM(value); }

  function headM(title, sub, back) {
    return '<div class="page-head"><div class="row" style="gap:10px;align-items:flex-start">' +
      (back ? '<a href="' + back + '" class="btn-icon">' + icM('back', 18) + '</a>' : '') +
      '<div><h1 style="margin:0">' + escM(title) + '</h1><p class="muted" style="margin:3px 0 0">' + escM(sub) + '</p></div></div></div>';
  }
  function idBanner(u) {
    return '<div class="card" style="padding:11px 13px;margin-bottom:12px;border-color:rgba(46,230,201,.28);background:linear-gradient(140deg,rgba(46,230,201,.10),var(--surface-2))">' +
      '<div class="between"><div><div class="tiny muted" style="font-weight:700;letter-spacing:.06em">ACCOUNT ID / REFERRAL CODE</div>' +
      '<div style="font-family:var(--display);font-size:20px;font-weight:800;letter-spacing:.06em;margin-top:2px">' + escM(u.accountId || u.referralCode) + '</div></div>' +
      '<span class="badge badge-accent">' + icM('user', 12) + ' Your ID</span></div>' +
      '<div class="tiny muted" style="margin-top:6px">Give this ID to receive transfers from another WhaleChat user.</div></div>';
  }

  /* ---------------------------------------------------------- unified transfer */
  function transferPage(scope) {
    var u = acct(me()); if (!u) return '';
    var inv = scope === 'investment';
    var list = definitions(u).filter(function (x) { return x.out && (inv ? ACCOUNT_SOURCES.indexOf(x.id) < 0 : ACCOUNT_SOURCES.indexOf(x.id) >= 0); });
    var srcOpts = list.map(function (x) {
      return '<option value="' + x.id + '">' + escM(x.group + ' · ' + x.label) + ' — ' + display(x, x.get()) + '</option>';
    }).join('');
    var dstOpts = '';
    var title = inv ? 'Investment transfer' : 'Transfer WC';
    var sub = inv ? 'Move USD between your investment balances and top up your portfolios. Only the total profit balance can go back to your WC balance.' : 'Send WC from your WC balance to your investment trade capital or your vendor capital. It is converted to USD automatically.';
    return headM(title, sub, inv ? '#/investment' : '#/account') +
      idBanner(u) +
      '<div class="card mh-grid"><div class="mh-col">' +
        '<div class="field"><label class="label">From</label><select class="input" id="mhFrom">' + srcOpts + '</select></div>' +
        '<div class="field"><label class="label">To</label><select class="input" id="mhTo">' + dstOpts + '</select></div>' +
        '<div class="field"><label class="label" id="mhAmountLabel">Amount</label><div class="mh-input">' +
          '<span id="mhUnit">$</span><input class="input" id="mhAmount" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"/>' +
          '<button type="button" class="ac-max" id="mhMax">Max</button></div><div class="help" id="mhHint"></div></div>' +
        '<div class="mh-preview"><div><span>From</span><b id="mhFromVal">—</b></div><div class="mh-arrow">→</div><div><span>To</span><b id="mhToVal">—</b></div></div>' +
        '<button class="btn btn-primary btn-block btn-lg" data-act="mh-transfer">' + icM('send', 15) + ' Transfer now</button>' +
        '<div class="tiny muted" style="margin-top:9px">' + (inv ? 'USD sent from your total profit balance to your WC balance is converted at $' + RATE.toFixed(2) + ' per WC.' : 'WC is converted to USD at $' + RATE.toFixed(2) + ' per WC. Crypto is converted to WC on the Convert page.') + '</div>' +
      '</div><div class="mh-col mh-side">' +
        '<div class="card-title">Balance snapshot</div>' +
        list.map(function (x) {
          return '<div class="mh-row"><span>' + escM(x.label) + '</span><b>' + display(x, x.get()) + '</b></div>';
        }).join('') +
        (inv ? '' : definitions(u).filter(function (x) { return x.id === 'inv_usd' || x.id === 'vendor_cap'; }).map(function (x) {
          return '<div class="mh-row"><span>' + escM(x.label) + '</span><b>' + display(x, x.get()) + '</b></div>';
        }).join('')) +
        (inv ? '<a href="#/investment/send" class="btn btn-ghost btn-sm" style="width:100%;margin-top:12px">' + icM('users', 14) + ' Send to another user</a>' : (hasVendor(u) ? '' : '<div class="tiny muted" style="margin-top:10px">Create a vendor profile to unlock vendor capital.</div>')) +
      '</div></div>';
  }

  function bindTransfer() {
    var from = document.getElementById('mhFrom');
    var to = document.getElementById('mhTo');
    var amount = document.getElementById('mhAmount');
    if (!from || !to || !amount) return;
    var u = acct(me());
    function fillTargets() {
      var keep = to.value;
      var ids = allowedTargets(from.value, u);
      to.innerHTML = ids.map(function (id) { var d = defById(u, id); return d ? '<option value="' + d.id + '">' + escM(d.group + ' · ' + d.label) + '</option>' : ''; }).join('');
      if (ids.indexOf(keep) >= 0) to.value = keep;
    }
    var want = '';
    try { want = (location.hash.match(/[?&]to=([a-z_]+)/) || [])[1] || ''; if (want === 'trade') want = 'inv_usd'; if (want === 'vendor') want = 'vendor_cap'; } catch (e) {}
    if (want === 'wallet_wc' && from.querySelector('option[value="inv_payout"]')) from.value = 'inv_payout';
    fillTargets();
    if (want && to.querySelector('option[value="' + want + '"]')) to.value = want;
    function update() {
      var s = defById(u, from.value);
      var d = defById(u, to.value);
      if (!s || !d) return;
      var v = Number(amount.value) || 0;
      document.getElementById('mhUnit').textContent = s.cur === 'WC' ? 'WC' : '$';
      document.getElementById('mhAmountLabel').textContent = s.cur === 'WC' ? 'Amount (WC)' : 'Amount (USD)';
      document.getElementById('mhFromVal').textContent = display(s, v);
      document.getElementById('mhToVal').textContent = display(d, converted(v, s, d));
      document.getElementById('mhHint').textContent = 'Available: ' + display(s, s.get()) + ' · no PIN needed.';
    }
    from.onchange = function () { fillTargets(); update(); }; to.onchange = update; amount.oninput = update;
    document.getElementById('mhMax').onclick = function () {
      var s = defById(u, from.value);
      if (s) amount.value = (Number(s.get()) || 0).toFixed(2);
      update();
    };
    update();
  }

  async function botTransferProfit(u, amountUsd) {
    var uid = u.id;
    var res = await fetch((typeof Remote !== 'undefined' && Remote && Remote.url) ? Remote.url('/api/bots/transfer') : '/api/bots/transfer', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: uid, source: 'profit', amountUsd: amountUsd })
    });
    return res.json();
  }

  function doTransfer() {
    var u = acct(me());
    var src = defById(u, (document.getElementById('mhFrom') || {}).value || '');
    var dst = defById(u, (document.getElementById('mhTo') || {}).value || '');
    var amt = roundM(Number((document.getElementById('mhAmount') || {}).value || 0));
    if (!src || !dst) return toastM('Choose both balances', 'err');
    if (src.id === dst.id) return toastM('Choose two different balances', 'err');
    if (allowedTargets(src.id, u).indexOf(dst.id) < 0) return toastM(src.label + ' cannot be sent to ' + dst.label, 'err');
    if (!(amt > 0)) return toastM('Enter an amount greater than zero', 'err');
    if (amt > src.get() + 0.001) return toastM('Not enough in ' + src.label, 'err');
    var receive = converted(amt, src, dst);

    if (src.id === 'bot_profit') {
      botTransferProfit(u, amt).then(function (r) {
        if (!r || !r.ok) { toastM((r && r.error) || 'Bot profit transfer failed', 'err'); return; }
        var a = ia(u);
        // server already credited stock portfolio with the USD amount
        if (dst.id === 'stock_profit') {
          a.portfolios.stock = roundM((Number(a.portfolios.stock) || 0) - amt);
          a.stockProfit = roundM((Number(a.stockProfit) || 0) + amt);
        } else if (dst.id !== 'stock_capital') {
          a.portfolios.stock = roundM((Number(a.portfolios.stock) || 0) - amt);
          dst.set(dst.get() + converted(amt, { cur: 'USD' }, dst));
        }
        ledgerM(u, 'Bot profit → ' + dst.label + ' · ' + moneyM(amt), 0, 0, { from: 'bot_profit', to: dst.id });
        saveM(); toastM('Transfer complete', 'ok'); renderM();
      }).catch(function () { toastM('Bot profit transfer failed', 'err'); });
      return;
    }

    var srcBefore = src.get(), dstBefore = dst.get();
    src.set(roundM(srcBefore - amt));
    dst.set(roundM(dstBefore + receive));
    /* both sides are written and persisted together */
    ledgerM(u, src.label + ' → ' + dst.label + ' · ' + display(src, amt) + ' sent', 0, 0, { from: src.id, to: dst.id, srcBefore: srcBefore, dstBefore: dstBefore });
    saveM(); toastM('Transfer complete — ' + display(dst, receive) + ' added to ' + dst.label, 'ok'); renderM();
  }

  /* ---------------------------------------------------------- convert */
  function convertPage() {
    var u = acct(me()); if (!u) return '';
    var rows = Object.keys(u.depositBalances || {}).filter(function (k) { return Number(u.depositBalances[k]) > 0.004; });
    var opts = rows.map(function (c) { return '<option value="coin:' + escM(c) + '">Crypto · ' + escM(coinLabel(c, u.depositBalances[c])) + ' (' + moneyM(u.depositBalances[c]) + ')</option>'; }).join('');
    if (Number(u.walletUsd) > 0.004) opts += '<option value="usd">Old $ balance · ' + moneyM(u.walletUsd) + '</option>';
    opts += '<option value="wc">WC balance · ' + wcM(u.balance) + ' WC</option>';
    return headM('Convert', 'Convert your crypto to WhaleCoin (WC). To withdraw, convert WC to USDT or BTC.', '#/account') +
      idBanner(u) +
      '<div class="card mh-grid"><div class="mh-col">' +
        '<div class="field"><label class="label">Convert from</label><select class="input" id="mhCvFrom">' + opts + '</select></div>' +
        '<div class="field"><label class="label">Convert to</label><select class="input" id="mhCvTo"></select><div class="help" id="mhCvTarget"></div></div>' +
        '<div class="field"><label class="label" id="mhCvLabel">Amount</label><div class="mh-input"><span id="mhCvUnit">$</span>' +
          '<input class="input" id="mhCvAmount" type="number" min="0" step="0.01" placeholder="0.00"/><button type="button" class="ac-max" id="mhCvMax">Max</button></div>' +
          '<div class="help" id="mhCvHint"></div></div>' +
        '<div class="mh-preview"><div><span>You convert</span><b id="mhCvIn">$0.00</b></div><div class="mh-arrow">→</div><div><span>You receive</span><b id="mhCvOut">$0.00</b></div></div>' +
        '<button class="btn btn-primary btn-block btn-lg" data-act="mh-convert">' + icM('refresh', 15) + ' Convert now</button></div>' +
      '<div class="mh-col mh-side"><div class="card-title">Balances</div>' +
        rows.map(function (c) { return '<div class="mh-row"><span>' + escM(c) + '</span><b>' + escM(coinLabel(c, u.depositBalances[c])) + '</b></div>'; }).join('') +
        (Number(u.walletUsd) > 0.004 ? '<div class="mh-row"><span>Old $ balance</span><b>' + moneyM(u.walletUsd) + '</b></div>' : '') +
        '<div class="mh-row"><span>WC balance</span><b>' + wcM(u.balance) + ' WC</b></div></div></div>';
  }

  function bindConvert() {
    var from = document.getElementById('mhCvFrom');
    var to = document.getElementById('mhCvTo');
    var amount = document.getElementById('mhCvAmount');
    if (!from || !to || !amount) return;
    var u = acct(me());
    function source() { return from.value.indexOf('coin:') === 0 ? 'coin' : from.value; }
    function coin() { return from.value.slice(5); }
    function avail() {
      if (source() === 'coin') return Number(u.depositBalances[coin()]) || 0;
      if (source() === 'wc') return Number(u.balance) || 0;
      return Number(u.walletUsd) || 0;
    }
    function targets() {
      var k = source();
      if (k === 'coin') return [['wc', 'WC balance']];
      if (k === 'usd') return [['wc', 'WC balance']];
      return [['USDT', 'USDT crypto balance (for withdrawal)'], ['BTC', 'BTC crypto balance (for withdrawal)']];
    }
    function build() {
      var list = targets();
      to.innerHTML = list.map(function (x) { return '<option value="' + x[0] + '">' + x[1] + '</option>'; }).join('');
      if (to.options.length) to.selectedIndex = 0;
      document.getElementById('mhCvUnit').textContent = source() === 'wc' ? 'WC' : '$';
      document.getElementById('mhCvLabel').textContent = source() === 'wc' ? 'Amount (WC)' : 'Amount (USD)';
      document.getElementById('mhCvTarget').textContent = source() === 'wc' ? 'WC converts to ' + (to.value || 'USDT') + ' at $' + RATE.toFixed(2) + '/WC, valued at the live price.' : (source() === 'usd' ? 'USD converts to WC at $' + RATE.toFixed(2) + '/WC.' : 'Enter the USD value to convert. 1 WC = $' + RATE.toFixed(2) + '.');
      update();
    }
    function update() {
      var v = Number(amount.value) || 0;
      var k = source(), t = to.value;
      var out;
      if (k === 'wc' && (t === 'USDT' || t === 'BTC')) out = coinLabel(t, v * RATE) + ' (' + moneyM(v * RATE) + ')';
      else if (t === 'wc') out = wcM(v / RATE) + ' WC';
      else out = moneyM(v);
      document.getElementById('mhCvIn').textContent = k === 'wc' ? wcM(v) + ' WC' : (k === 'coin' ? coinLabel(coin(), v) + ' (' + moneyM(v) + ')' : moneyM(v));
      document.getElementById('mhCvOut').textContent = out;
      document.getElementById('mhCvHint').textContent = 'Available: ' + (k === 'wc' ? wcM(avail()) + ' WC' : (k === 'coin' ? coinLabel(coin(), avail()) + ' (' + moneyM(avail()) + ')' : moneyM(avail()))) + '.';
    }
    from.onchange = build; to.onchange = update; amount.oninput = update;
    document.getElementById('mhCvMax').onclick = function () { amount.value = avail().toFixed(2); update(); };
    build();
  }

  function doConvert() {
    var u = acct(me());
    var from = (document.getElementById('mhCvFrom') || {}).value || '';
    var to = (document.getElementById('mhCvTo') || {}).value || '';
    var amt = roundM(Number((document.getElementById('mhCvAmount') || {}).value || 0));
    if (!(amt > 0)) return toastM('Enter an amount', 'err');
    if (from.indexOf('coin:') === 0) {
      var coin = from.slice(5);
      var av = Number(u.depositBalances[coin]) || 0;
      if (amt > av + 0.001) return toastM('Not enough ' + coin, 'err');
      if (to !== 'wc') return toastM('Crypto can only be converted to WC', 'err');
      u.depositBalances[coin] = roundM(av - amt);
      if (u.depositBalances[coin] <= 0.004) delete u.depositBalances[coin];
      if (to === 'wc') { var got = roundM(amt / RATE); u.balance = roundM((Number(u.balance) || 0) + got); ledgerM(u, 'Converted ' + moneyM(amt) + ' ' + coin + ' to WC', -amt, got); }
      else return toastM('Choose a destination', 'err');
    } else if (from === 'usd') {
      var avUsd = Number(u.walletUsd) || 0;
      if (amt > avUsd + 0.001) return toastM('Not enough $ balance', 'err');
      u.walletUsd = roundM(avUsd - amt);
      var wc = roundM(amt / RATE);
      u.balance = roundM((Number(u.balance) || 0) + wc);
      ledgerM(u, 'Converted ' + moneyM(amt) + ' to WC', -amt, wc);
    } else if (from === 'wc') {
      var avWc = Number(u.balance) || 0;
      if (to !== 'USDT' && to !== 'BTC') return toastM('WC converts to USDT or BTC only', 'err');
      if (amt > avWc + 0.001) return toastM('Not enough Whalecoin', 'err');
      u.balance = roundM(avWc - amt);
      var cryptoUsd = roundM(amt * RATE);
      u.depositBalances[to] = roundM((Number(u.depositBalances[to]) || 0) + cryptoUsd);
      ledgerM(u, 'Converted ' + wcM(amt) + ' WC to ' + to + ' crypto', cryptoUsd, -amt);
    } else return toastM('Choose what to convert', 'err');
    saveM(); toastM('Conversion complete', 'ok'); renderM();
  }

  /* ---------------------------------------------------------- withdraw (crypto only) */
  function withdrawPage() {
    var u = acct(me()); if (!u) return '';
    if (!u.pin) {
      return headM('Withdraw crypto', 'Set your withdrawal PIN first. Withdrawals are crypto-only.', '#/account') +
        '<div class="card" style="padding:24px;text-align:center">' + icM('lock', 26) + '<h3>Set your withdrawal PIN</h3>' +
        '<p class="small muted">Your PIN is required for crypto withdrawals and transfers to other users.</p>' +
        '<button class="btn btn-primary" data-act="set-pin-now">Create withdrawal PIN</button></div>';
    }
    var rows = Object.keys(u.depositBalances || {}).filter(function (c) { return Number(u.depositBalances[c]) > 0.004; });
    if (!rows.length) {
      return headM('Withdraw crypto', 'Only crypto balances can be withdrawn.', '#/account') +
        '<div class="card" style="padding:24px;text-align:center">' + icM('wallet', 26) + '<h3>No crypto balance</h3>' +
        '<p class="small muted">USD and Whalecoin cannot be withdrawn directly. Convert Whalecoin to USDT or BTC first, then withdraw from your crypto balance.</p>' +
        '<a href="#/account/convert" class="btn btn-primary">Convert WC to USDT or BTC</a></div>';
    }
    var nets = []; try { nets = DB.settings.networks || []; } catch (e) {}
    var opts = rows.map(function (c) { return '<option value="' + escM(c) + '">' + escM(coinLabel(c, u.depositBalances[c])) + ' (' + moneyM(u.depositBalances[c]) + ')</option>'; }).join('');
    return headM('Withdraw crypto', 'Withdrawals are paid only from your crypto deposit balance. USD and Whalecoin are not withdrawable.', '#/account') +
      idBanner(u) +
      '<div class="card mh-grid"><div class="mh-col">' +
        '<div class="field"><label class="label">Withdraw from</label><select class="input" id="mhWdCoin">' + opts + '</select><div class="help" id="mhWdAvail"></div></div>' +
        '<div class="field"><label class="label">Network</label><select class="input" id="mhWdNet">' + (nets.length ? nets.map(function (n) { return '<option value="' + escM(n) + '">' + escM(n) + '</option>'; }).join('') : '<option value="TRC20">TRC20</option>') + '</select></div>' +
        '<div class="field"><label class="label">Crypto wallet address</label><input class="input" id="mhWdAddr" placeholder="Paste your wallet address"/></div>' +
        '<div class="field"><label class="label">Amount (USD)</label><div class="mh-input"><span>$</span><input class="input" id="mhWdAmount" type="number" min="5" step="0.01" placeholder="0.00"/><button type="button" class="ac-max" id="mhWdMax">Max</button></div><div class="help" id="mhWdHint"></div></div>' +
        '<div class="field"><label class="label">Withdrawal PIN</label><input class="input" id="mhWdPin" type="password" inputmode="numeric" maxlength="6" placeholder="4–6 digit PIN"/></div>' +
        '<label class="checkline" style="margin-bottom:12px"><input type="checkbox" id="mhWdConfirm"/><span>I confirm this address is correct. Blockchain transfers cannot be reversed.</span></label>' +
        '<button class="btn btn-primary btn-block btn-lg" data-act="mh-withdraw">' + icM('send', 15) + ' Request withdrawal</button></div>' +
      '<div class="mh-col mh-side"><div class="card-title">Crypto balances</div>' +
        rows.map(function (c) { return '<div class="mh-row"><span>' + escM(c) + '</span><b>' + moneyM(u.depositBalances[c]) + '</b></div>'; }).join('') +
        '<div class="tiny muted" style="margin-top:10px">Withdrawals are reviewed and paid within 24 hours.</div></div></div>';
  }

  function bindWithdraw() {
    var coin = document.getElementById('mhWdCoin');
    var amount = document.getElementById('mhWdAmount');
    if (!coin || !amount) return;
    var u = acct(me());
    function avail() { return Number(u.depositBalances[coin.value]) || 0; }
    function update() {
      document.getElementById('mhWdAvail').textContent = 'Available: ' + moneyM(avail()) + ' || ' + coin.value;
      document.getElementById('mhWdHint').textContent = 'Minimum $5.00 · Available ' + moneyM(avail()) + '.';
    }
    coin.onchange = update; amount.oninput = update;
    document.getElementById('mhWdMax').onclick = function () { amount.value = avail().toFixed(2); update(); };
    update();
  }

  async function doWithdraw() {
    var u = acct(me());
    var coin = (document.getElementById('mhWdCoin') || {}).value || '';
    var net = (document.getElementById('mhWdNet') || {}).value || '';
    var addr = String((document.getElementById('mhWdAddr') || {}).value || '').trim();
    var amt = roundM(Number((document.getElementById('mhWdAmount') || {}).value || 0));
    var pin = String((document.getElementById('mhWdPin') || {}).value || '');
    if (!addr || addr.length < 12) return toastM('Enter a valid crypto address', 'err');
    if (!(amt >= 5)) return toastM('Minimum withdrawal is $5.00', 'err');
    if (amt > (Number(u.depositBalances[coin]) || 0) + 0.001) return toastM('Not enough ' + coin, 'err');
    if (!/^\d{4,6}$/.test(pin)) return toastM('Enter your 4–6 digit PIN', 'err');
    if (!(document.getElementById('mhWdConfirm') || {}).checked) return toastM('Confirm the wallet address', 'err');
    var h = await pinHash(pin);
    if (u.pin && h !== u.pin) return toastM('Incorrect PIN', 'err');
    u.depositBalances[coin] = roundM((Number(u.depositBalances[coin]) || 0) - amt);
    if (u.depositBalances[coin] <= 0.004) delete u.depositBalances[coin];
    var id = nowIdM('wd_');
    DB.withdrawals.unshift({ id: id, userId: u.id, network: net, address: addr, coin: coin, crypto: true, usd: amt, coins: roundM(amt / RATE), status: 'pending', createdAt: Date.now(), note: '' });
    ledgerM(u, 'Withdrawal request · ' + moneyM(amt) + ' || ' + coin, -amt, 0, { withdrawalId: id });
    try { notify(u.id, 'Withdrawal submitted', moneyM(amt) + ' || ' + coin + ' is pending review.', '#/account', 'download'); } catch (e) {}
    try { notify('usr_admin', 'New crypto withdrawal', u.fullName + ' requested ' + moneyM(amt) + ' || ' + coin + '.', '#/admin/withdrawals', 'download'); } catch (e) {}
    saveM(); toastM('Withdrawal request submitted', 'ok'); renderM();
  }

  /* ---------------------------------------------------------- send to another user */
  function sendPage() {
    var u = acct(me()); if (!u) return '';
    var a = ia(u);
    return headM('Send to another user', 'Send USD from your investment total assets or payout balance. Your transaction PIN is required.', '#/transfer') +
      idBanner(u) +
      '<div class="card" style="max-width:620px">' +
        '<div class="field"><label class="label">Recipient account ID</label><input class="input" id="mhSendTo" placeholder="e.g. WC4K7P2" autocapitalize="characters"/><div class="help">Ask the recipient for their account ID / referral code.</div></div>' +
        '<div class="field"><label class="label">Send from</label><select class="input" id="mhSendFrom"><option value="inv_usd">Total assets balance · ' + moneyM(a.usd) + '</option><option value="inv_payout">Total profit balance · ' + moneyM(a.payout) + '</option></select></div>' +
        '<div class="field"><label class="label">Amount (USD)</label><input class="input" id="mhSendAmount" type="number" min="0" step="0.01" placeholder="0.00"/></div>' +
        '<div class="field"><label class="label">Transaction PIN</label><input class="input" id="mhSendPin" type="password" inputmode="numeric" maxlength="6" placeholder="4–6 digit PIN"/></div>' +
        '<button class="btn btn-primary btn-block" data-act="mh-send">' + icM('send', 15) + ' Send now</button>' +
        '<div class="tiny muted" style="margin-top:8px">Only investment balances can be sent to another user. Internal transfers between your own accounts do not need a PIN.</div></div>';
  }

  async function doSend() {
    var u = acct(me());
    var toId = String((document.getElementById('mhSendTo') || {}).value || '').trim().replace(/^@/, '').toUpperCase();
    var from = (document.getElementById('mhSendFrom') || {}).value || 'inv_usd';
    var amt = roundM(Number((document.getElementById('mhSendAmount') || {}).value || 0));
    var pin = String((document.getElementById('mhSendPin') || {}).value || '');
    var a = ia(u);
    if (!toId) return toastM('Enter the recipient account ID', 'err');
    var other = null;
    try {
      other = (DB.users || []).find(function (x) {
        return String(x.accountId || x.referralCode || '').toUpperCase() === toId || String(x.username || '').toUpperCase() === toId || String(x.email || '').toUpperCase() === toId;
      });
    } catch (e) {}
    if (!other || other.id === u.id) return toastM('Recipient account ID not found', 'err');
    var srcVal = from === 'inv_payout' ? Number(a.payout) : Number(a.usd);
    if (!(amt > 0)) return toastM('Enter an amount', 'err');
    if (amt > srcVal + 0.001) return toastM('Not enough in that balance', 'err');
    if (!/^\d{4,6}$/.test(pin)) return toastM('Enter your transaction PIN', 'err');
    var h = await pinHash(pin);
    if (u.pin && h !== u.pin) return toastM('Incorrect PIN', 'err');
    if (from === 'inv_payout') a.payout = roundM(a.payout - amt); else a.usd = roundM(a.usd - amt);
    var oa = ia(other);
    oa.usd = roundM((Number(oa.usd) || 0) + amt);
    ledgerM(u, 'Sent ' + moneyM(amt) + ' to ' + (other.accountId || other.referralCode), -amt, 0, { toUser: other.id });
    /* the receiver's balance and ledger both move with the same write, so a
       refresh can never show the money leaving one account and not arriving */
    ledgerM(other, 'Received ' + moneyM(amt) + ' from @' + u.username, amt, 0, { fromUser: u.id });
    try { notify(other.id, 'Investment transfer received', moneyM(amt) + ' was added to your investment total assets by @' + u.username + '.', '#/investment', 'briefcase'); } catch (e) {}
    saveM(); toastM('Sent ' + moneyM(amt) + ' to ' + (other.accountId || other.referralCode), 'ok'); renderM();
  }

  /* ---------------------------------------------------------- routes */
  function ensureRoutes() {
    if (typeof VIEWS === 'undefined' || typeof AFTER === 'undefined') return false;
    if (VIEWS.__wcMoneyHub) return true;

    var baseAccount = VIEWS.account;
    var baseWallet = VIEWS.wallet;
    var baseInvestment = VIEWS.investment;
    if (!baseAccount || !baseWallet || !baseInvestment) return false;

    VIEWS.account = function (parts) {
      var sub = (parts && parts[1]) || '';
      if (sub === 'convert') return convertPage();
      if (sub === 'transfer') return transferPage('account');
      var html = baseAccount.apply(this, arguments);
      try { html = html.replace('<div class="ac-grid">', idBanner(acct(me())) + '<div class="ac-grid">'); } catch (e) {}
      return html;
    };
    VIEWS.wallet = function (parts) {
      var sub = (parts && parts[1]) || '';
      if (sub === 'convert') return convertPage();
      if (sub === 'transfer') return transferPage('account');
      return baseWallet.apply(this, arguments);
    };
    VIEWS.transfer = function () { return transferPage('account'); };
    VIEWS.withdraw = function () { return withdrawPage(); };
    VIEWS.investment = function (parts) {
      var sub = (parts && parts[1]) || '';
      if (sub === 'transfer') return transferPage('investment');
      if (sub === 'send') return sendPage();
      return baseInvestment.apply(this, arguments);
    };
    var baseVendor = VIEWS.vendor;
    if (baseVendor) {
      VIEWS.vendor = function (parts) {
        var html = baseVendor.apply(this, arguments);
        try {
          var u = me();
          if (u && u.role !== 'admin' && hasVendor(u) && !(parts && parts[1])) {
            html = '<div class="card mh-vcap"><div><div class="tiny muted" style="letter-spacing:.06em">VENDOR CAPITAL</div><div class="mh-vcap-v">' + moneyM(u.vendorCapitalUsd || 0) + '</div><div class="tiny muted">Pays for company stock. Funded with WC from your WhaleChat account.</div></div>' +
              '<a href="#/account/transfer?to=vendor_cap" class="btn btn-primary btn-sm">' + icM('send', 14) + ' Add capital</a></div>' + html;
          }
        } catch (e) {}
        return html;
      };
    }
    VIEWS.__wcMoneyHub = true;

    var prevAccount = AFTER.account;
    AFTER.account = function (parts) {
      if (typeof prevAccount === 'function') { try { prevAccount.apply(this, arguments); } catch (e) {} }
      var sub = (parts && parts[1]) || '';
      if (sub === 'convert') bindConvert();
      if (sub === 'transfer') bindTransfer();
    };
    var prevWallet = AFTER.wallet;
    AFTER.wallet = function (parts) {
      if (typeof prevWallet === 'function') { try { prevWallet.apply(this, arguments); } catch (e) {} }
      var sub = (parts && parts[1]) || '';
      if (sub === 'convert') bindConvert();
      if (sub === 'transfer') bindTransfer();
    };
    var prevWithdraw = AFTER.withdraw;
    AFTER.withdraw = function () { bindWithdraw(); };
    var prevInvestment = AFTER.investment;
    AFTER.investment = function (parts) {
      if (typeof prevInvestment === 'function') { try { prevInvestment.apply(this, arguments); } catch (e) {} }
      var sub = (parts && parts[1]) || '';
      if (sub === 'transfer') bindTransfer();
    };
    AFTER.transfer = function () { bindTransfer(); };

    if (typeof App !== 'undefined') {
      App.mhTransfer = doTransfer;
      App.mhConvert = doConvert;
      App.mhWithdraw = doWithdraw;
      App.mhSend = doSend;
      App.acctConvert = doConvert;
      App.acctWithdraw = doWithdraw;
    }
    return true;
  }

  (function styles() {
    if (document.getElementById('wc-money-hub-css')) return;
    var st = document.createElement('style');
    st.id = 'wc-money-hub-css';
    st.textContent = [
      '.mh-grid{display:grid;grid-template-columns:1.35fr .9fr;gap:18px}',
      '.mh-col{min-width:0}.mh-side{border-left:1px solid var(--border);padding-left:16px}',
      '.mh-input{position:relative;display:flex;align-items:center}.mh-input>span{position:absolute;left:12px;color:var(--muted);font-size:12px;z-index:1;font-weight:700}',
      '.mh-input .input{padding-left:30px;padding-right:58px}',
      '.mh-preview{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);margin:4px 0 14px}',
      '.mh-preview>div{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}.mh-preview span{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-2);font-weight:700}',
      '.mh-preview b{font-size:14px;font-variant-numeric:tabular-nums}.mh-arrow{flex:none!important;color:var(--accent);font-size:16px}',
      '.mh-row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px dashed var(--border);font-size:11.5px}',
      '.mh-row:last-child{border-bottom:none}.mh-row b{font-variant-numeric:tabular-nums}',
      '.mh-vcap{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;border-color:rgba(46,230,201,.3)}.mh-vcap-v{font-size:24px;font-weight:800;font-variant-numeric:tabular-nums;margin:2px 0}',
      '@media(max-width:820px){.mh-grid{grid-template-columns:1fr}.mh-side{border-left:none;padding-left:0;border-top:1px solid var(--border);padding-top:12px}}'
    ].join('');
    document.head.appendChild(st);
  })();

  var tries = 0;
  (function boot() {
    if (ensureRoutes()) { try { renderM(); } catch (e) {} return; }
    if (tries++ < 60) setTimeout(boot, 400);
  })();
})();
