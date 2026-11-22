/* =========================================================================
   WhaleChat Account Centre
   The consumer account (deposit balance per coin, $ balance, WC balance)
   and the flows that move money between it and the investment account.
   Loaded after investment-hub.js so it owns #/wallet and #/account.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcAccountCentre) return;
  window.__wcAccountCentre = true;

  var RATE = (typeof COIN_USD === 'number') ? COIN_USD : 0.5; // 1 WC = $0.50
  var COINS = ['USDT', 'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'TRX', 'LTC', 'USDC', 'ADA', 'MATIC'];

  function escA(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function moneyA(n) { return '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
  function wcA(n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function iconA(name, size) { try { return (typeof ic === 'function') ? ic(name, size || 16) : ''; } catch (e) { return ''; } }
  function saveA() { try { persist(); } catch (e) {} try { sync(); } catch (e) {} }
  function toastA(msg, type) { try { toast(msg, type || 'ok'); } catch (e) {} }
  function renderA() { try { render(); } catch (e) {} }
  function nowId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function coinFromText(text, mode) {
    var s = String(text || '').toUpperCase();
    for (var i = 0; i < COINS.length; i++) {
      var c = COINS[i];
      if (new RegExp('\\b' + c + '\\b').test(s)) return c;
    }
    return mode === 'bank' ? 'USD' : 'USD';
  }

  function ensureAccount(u) {
    if (!u) return null;
    if (!(Number(u.walletUsd) >= 0)) u.walletUsd = Number(u.walletUsd) || 0;
    if (!u.depositBalances || typeof u.depositBalances !== 'object' || Array.isArray(u.depositBalances)) {
      var map = {};
      try {
        (DB.deposits || []).forEach(function (d) {
          if (!d || d.userId !== u.id || d.status !== 'approved') return;
          /* deposits approved before the deposit-balance flow were already
             credited to the WC wallet — never count them twice. */
          if (d.creditedToDeposit !== true) { d.creditedToDeposit = false; return; }
          var coin = String(d.coin || coinFromText(d.methodName || d.method, d.method)).toUpperCase();
          var usd = Number(d.usd);
          if (!(usd > 0)) usd = (Number(d.coins) || 0) * RATE;
          map[coin] = round2((map[coin] || 0) + usd);
        });
      } catch (e) {}
      u.depositBalances = map;
    }
    if (!Array.isArray(u.acctLedger)) u.acctLedger = [];
    return u;
  }

  function investAcct(u) {
    try {
      if (typeof account === 'function') return account(u);
    } catch (e) {}
    if (!u.investAcct) u.investAcct = { usd: 0, payout: 0, wcBalance: 0, portfolios: { stock: 0, wc: 0, b2b: 0, bot: 0 }, tools: {}, b2b: {}, b2bFav: [], b2bAlerts: [], b2bProfit: 0, disputes: [], requests: [], ledger: [], autoReinvest: false };
    var a = u.investAcct;
    if (!a.portfolios) a.portfolios = { stock: 0, wc: 0, b2b: 0, bot: 0 };
    if (!Array.isArray(a.ledger)) a.ledger = [];
    ['usd', 'payout', 'wcBalance'].forEach(function (k) { if (!(Number(a[k]) >= 0)) a[k] = Number(a[k]) || 0; });
    return a;
  }

  function coinRows(u) {
    var keys = Object.keys(u.depositBalances || {});
    return keys.map(function (k) { return { coin: k, usd: Number(u.depositBalances[k]) || 0 }; })
      .filter(function (r) { return r.usd > 0.004; })
      .sort(function (a, b) { return b.usd - a.usd; });
  }

  function ledgerA(u, label, usdDelta, wcDelta, meta) {
    ensureAccount(u);
    u.acctLedger.unshift({ id: nowId('al_'), label: label, usd: round2(usdDelta), wc: round2(wcDelta), meta: meta || null, at: Date.now() });
    if (u.acctLedger.length > 200) u.acctLedger.length = 200;
  }

  function headA(title, sub, back) {
    return '<div class="page-head"><div class="row" style="gap:10px;align-items:flex-start">' +
      (back ? '<a href="' + back + '" class="btn-icon" aria-label="Back">' + iconA('back', 18) + '</a>' : '') +
      '<div><h1 style="margin:0">' + escA(title) + '</h1><p class="muted" style="margin:3px 0 0">' + escA(sub) + '</p></div></div></div>';
  }

  /* ---------------------------------------------------------------- home */
  function accountHome(params) {
    var u = ensureAccount(me());
    if (!u) return '';
    var a = investAcct(u);
    var rows = coinRows(u);
    var depTotal = rows.reduce(function (s, r) { return s + r.usd; }, 0);
    var pendingDep = [];
    try { pendingDep = (DB.deposits || []).filter(function (d) { return d.userId === u.id && d.status === 'pending'; }); } catch (e) {}
    var pendingWd = [];
    try { pendingWd = (DB.withdrawals || []).filter(function (w) { return w.userId === u.id && w.status === 'pending'; }); } catch (e) {}

    var depBody = rows.length
      ? rows.map(function (r) {
          var lbl = (window.WC_COIN && window.WC_COIN.label) ? window.WC_COIN.label(r.coin, r.usd) : (moneyA(r.usd) + ' of ' + r.coin);
          return '<div class="ac-coin"><span class="ac-coin-dot">' + escA(r.coin.slice(0, 1)) + '</span>' +
            '<b>' + escA(lbl) + '</b>' +
            '<small>' + moneyA(r.usd) + ' · ' + wcA(r.usd / RATE) + ' WC</small></div>';
        }).join('')
      : '<div class="ac-empty">No crypto yet.<br><span>Your crypto deposits appear here, coin by coin, after approval.</span></div>';

    var actions = [
      ['download', 'Deposit', '#/deposit', 'primary'],
      ['send', 'Withdraw', '#/withdraw', ''],
      ['trend', 'Invest', '#/investment', ''],
      ['refresh', 'Convert', '#/account/convert', ''],
      ['wallet', 'Transfer', '#/account/transfer', ''],
      ['gift', 'Referrals', '#/referrals', ''],
      ['more', 'More', '#/account/more', '']
    ];

    var activity = [];
    try {
      (DB.deposits || []).filter(function (d) { return d.userId === u.id; }).slice(0, 6).forEach(function (d) {
        activity.push({ at: d.createdAt, title: 'Deposit · ' + (d.coin || coinFromText(d.methodName, d.method)), sub: (d.methodName || d.method || '') + ' · ' + d.status, usd: d.status === 'approved' ? Number(d.usd) : 0, badge: d.status });
      });
    } catch (e) {}
    (u.acctLedger || []).slice(0, 8).forEach(function (l) {
      activity.push({ at: l.at, title: l.label, sub: l.usd ? moneyA(l.usd) : (wcA(l.wc) + ' WC'), usd: 0, badge: '' });
    });
    activity.sort(function (x, y) { return (y.at || 0) - (x.at || 0); });
    activity = activity.slice(0, 7);

    return headA('Whalechat account', 'Your spendable balances, deposits and account actions.') +
      '<div class="ac-grid">' +
        '<div class="ac-card ac-card-dep"><div class="ac-card-top"><span>Crypto balance</span><span class="ac-ic">' + iconA('wallet', 17) + '</span></div>' +
          '<div class="ac-big">' + moneyA(depTotal) + '</div>' +
          '<div class="ac-sub">' + rows.length + ' coin' + (rows.length === 1 ? '' : 's') + ' · total value · convert to WC to spend or invest</div>' +
          '<div class="ac-coins">' + depBody + '</div>' +
          '<a href="#/account/convert" class="ac-link">Convert crypto to WC →</a></div>' +
        '<div class="wc-quick-row" data-ac-quick-row>' +
          '<a href="#/home" class="wc-quick-btn"><span class="wc-quick-ic">' + iconA('chat', 18) + '</span>' +
            '<span class="wc-quick-t"><b>Chat</b><small>Open your chat page</small></span>' + iconA('chevron', 15) + '</a>' +
          '<a href="#/invest/shares" class="wc-quick-btn wc-quick-inv"><span class="wc-quick-ic">' + iconA('trend', 18) + '</span>' +
            '<span class="wc-quick-t"><b>WC-Investing</b><small>Open your WC-Investing account</small></span>' + iconA('chevron', 15) + '</a>' +
        '</div>' +
        (Number(u.walletUsd) > 0.004 ? '<div class="ac-card ac-card-usd"><div class="ac-card-top"><span>Old $ balance</span><span class="ac-ic">' + iconA('download', 17) + '</span></div>' +
          '<div class="ac-big">' + moneyA(u.walletUsd) + '</div>' +
          '<div class="ac-sub">From the previous account system. Move it to your WC balance to use it.</div>' +
          '<div class="ac-minirow"><span>≈ ' + wcA(u.walletUsd / RATE) + ' WC</span><span>1 WC = $' + RATE.toFixed(2) + '</span></div>' +
          '<a href="#/account/convert" class="ac-link">Move to WC balance →</a></div>' : '') +
        '<div class="ac-card ac-card-wc"><div class="ac-card-top"><span>WC balance</span><span class="ac-ic">WC</span></div>' +
          '<div class="ac-big">' + wcA(u.balance) + ' <em>WC</em></div>' +
          '<div class="ac-sub">≈ ' + moneyA(Number(u.balance || 0) * RATE) + ' USD · used for all purchases and vendor payments</div>' +
          '<div class="ac-minirow"><span>Spendable</span><span>WC</span></div>' +
          '<a href="#/account/transfer?to=inv_usd" class="ac-link">Send WC to investment trade capital →</a>' +
          '<a href="#/account/transfer?to=vendor_cap" class="ac-link">Send WC to vendor capital →</a>' +
          '<a href="#/account/convert" class="ac-link">Convert WC to USDT / BTC to withdraw →</a></div>' +
      '</div>' +

      '<div class="card ac-actions-card"><div class="card-title" style="margin:0 0 10px">Account actions</div>' +
        '<div class="ac-actions">' + actions.map(function (x) {
          return '<a href="' + x[2] + '" class="ac-action ' + (x[3] === 'primary' ? 'on' : '') + '"><span>' + iconA(x[0], 18) + '</span><b>' + x[1] + '</b></a>';
        }).join('') + '</div>' +
        '<div class="ac-note">' + iconA('shield', 13) + ' Crypto converts to WC here. WC goes to your investment trade capital or vendor capital as USD. Only the investment total profit balance comes back as WC.</div></div>' +

      (pendingDep.length || pendingWd.length ? '<div class="card"><div class="section-title"><h3>Pending requests</h3><span class="badge badge-warn">' + (pendingDep.length + pendingWd.length) + '</span></div>' +
        pendingDep.map(function (d) {
          return '<div class="ac-row"><div><b>Deposit · ' + moneyA(d.usd) + ' || ' + escA(d.coin || coinFromText(d.methodName, d.method)) + '</b><small>' + escA(d.methodName || d.method || '') + ' · ' + (typeof timeAgo === 'function' ? timeAgo(d.createdAt) + ' ago' : '') + '</small></div><span class="badge badge-warn">pending</span></div>';
        }).join('') +
        pendingWd.map(function (w) {
          return '<div class="ac-row"><div><b>Withdrawal · ' + wcA(w.coins) + ' WC</b><small>' + escA(w.network || '') + ' · ' + (typeof timeAgo === 'function' ? timeAgo(w.createdAt) + ' ago' : '') + '</small></div><span class="badge badge-warn">pending</span></div>';
        }).join('') + '</div>' : '') +

      '<div class="card"><div class="section-title"><h3>Recent activity</h3><a href="#/wallet/activity" class="tiny">Full history →</a></div>' +
        (activity.length ? activity.map(function (x) {
          return '<div class="ac-row"><div><b>' + escA(x.title) + '</b><small>' + escA(x.sub) + ' · ' + (typeof timeAgo === 'function' ? timeAgo(x.at) + ' ago' : '') + '</small></div>' +
            (x.badge ? '<span class="badge ' + (x.badge === 'approved' ? 'badge-success' : x.badge === 'rejected' ? 'badge-danger' : 'badge-warn') + '">' + escA(x.badge) + '</span>' : (x.usd > 0 ? '<span class="tiny muted">' + moneyA(x.usd) + '</span>' : '')) + '</div>';
        }).join('') : '<div class="ac-empty">No activity yet.</div>') + '</div>' +

      '<div class="ac-foot"><a href="#/investment" class="btn btn-ghost btn-sm">' + iconA('briefcase', 14) + ' Investment account</a>' +
        '<a href="#/market" class="btn btn-ghost btn-sm">' + iconA('bag', 14) + ' Marketplace</a>' +
        '<a href="#/settings" class="btn btn-ghost btn-sm">' + iconA('settings', 14) + ' Settings</a></div>';
  }

  /* ------------------------------------------------------------- convert */
  function convertPage() {
    var u = ensureAccount(me());
    if (!u) return '';
    var rows = coinRows(u);
    var opts = rows.map(function (r) {
      return '<option value="coin:' + escA(r.coin) + '">Deposit balance · ' + moneyA(r.usd) + ' || ' + escA(r.coin) + '</option>';
    }).join('');
    opts += '<option value="usd">$ balance · ' + moneyA(u.walletUsd) + '</option>';
    var hasDeposit = rows.length > 0;
    return headA('Convert balance', 'Move funds between your deposit balance, $ balance and Whalecoin balance.', '#/account') +
      '<div class="ac-form-grid"><div class="card">' +
        '<div class="field"><label class="label">Convert from</label><select class="input" id="acCvFrom">' + opts + '</select>' +
          (hasDeposit ? '' : '<div class="help">No coin deposits yet — you can still convert your $ balance to Whalecoin.</div>') + '</div>' +
        '<div class="field"><label class="label">Convert to</label><select class="input" id="acCvTo">' +
          '<option value="usd">$ balance (USD)</option><option value="wc">Whalecoin balance (WC)</option></select></div>' +
        '<div class="field"><label class="label">Amount (USD)</label><div class="ac-inputwrap">' +
          '<span>$</span><input class="input" id="acCvAmount" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"/>' +
          '<button type="button" class="ac-max" id="acCvMax">Max</button></div>' +
          '<div class="help" id="acCvHint">Select a source balance and enter an amount.</div></div>' +
        '<div class="ac-preview"><div><span>You convert</span><b id="acCvIn">$0.00</b></div><div class="ac-arrow">→</div>' +
          '<div><span>You receive</span><b id="acCvOut">$0.00</b></div></div>' +
        '<button class="btn btn-primary btn-block btn-lg" data-act="acct-convert">' + iconA('refresh', 15) + ' Convert now</button>' +
        '<div class="ac-note">' + iconA('shield', 13) + ' Conversion rate: 1 WC = $' + RATE.toFixed(2) + '. Converts instantly.</div></div>' +
      '<div class="card"><div class="card-title">Your balances</div>' +
        '<div class="ac-list">' + (rows.length ? rows.map(function (r) { return '<div class="ac-row"><div><b>' + moneyA(r.usd) + ' || ' + escA(r.coin) + '</b><small>Deposit balance</small></div><span class="tiny muted">' + wcA(r.usd / RATE) + ' WC</span></div>'; }).join('') : '') +
          '<div class="ac-row"><div><b>' + moneyA(u.walletUsd) + '</b><small>$ balance</small></div><span class="tiny muted">' + wcA(u.walletUsd / RATE) + ' WC</span></div>' +
          '<div class="ac-row"><div><b>' + wcA(u.balance) + ' WC</b><small>Whalecoin balance</small></div><span class="tiny muted">' + moneyA(Number(u.balance || 0) * RATE) + '</span></div>' +
        '</div></div></div>';
  }

  /* ------------------------------------------------------------ transfer */
  function transferPage() {
    var u = ensureAccount(me());
    if (!u) return '';
    var a = investAcct(u);
    return headA('Transfer to investment', 'Move USD from your Whalechat account $ balance into your investment account total assets balance.', '#/account') +
      '<div class="ac-form-grid"><div class="card">' +
        '<div class="field"><label class="label">From</label><div class="ac-source"><b>$ balance</b><span>' + moneyA(u.walletUsd) + ' available</span></div></div>' +
        '<div class="ac-to"><span class="ac-to-ic">' + iconA('briefcase', 18) + '</span><div><b>Investment account</b><small>Total assets balance · ' + moneyA(a.usd) + '</small></div></div>' +
        '<div class="field"><label class="label">Amount (USD)</label><div class="ac-inputwrap"><span>$</span>' +
          '<input class="input" id="acTrAmount" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"/>' +
          '<button type="button" class="ac-max" id="acTrMax">Max</button></div>' +
          '<div class="help" id="acTrHint">Only your $ balance can fund the investment account.</div></div>' +
        '<div class="ac-preview"><div><span>From $ balance</span><b id="acTrIn">$0.00</b></div><div class="ac-arrow">→</div>' +
          '<div><span>To total assets</span><b id="acTrOut">$0.00</b></div></div>' +
        '<button class="btn btn-primary btn-block btn-lg" data-act="acct-transfer">' + iconA('send', 15) + ' Transfer now</button>' +
        '<div class="ac-note">' + iconA('info', 13) + ' Investment accounts fund portfolio top-ups and tool subscriptions only.</div></div>' +
      '<div class="card"><div class="card-title">Where the money goes</div>' +
        '<div class="ac-list"><div class="ac-row"><div><b>' + moneyA(u.walletUsd) + '</b><small>Whalechat $ balance</small></div></div>' +
          '<div class="ac-row"><div><b>' + moneyA(a.usd) + '</b><small>Investment total assets</small></div></div>' +
          '<div class="ac-row"><div><b>' + wcA(a.wcBalance) + ' WC</b><small>Investment Whalecoin</small></div></div>' +
          '<div class="ac-row"><div><b>' + moneyA(a.payout) + '</b><small>Investment payout</small></div></div></div>' +
        '<a href="#/investment" class="btn btn-ghost btn-sm" style="margin-top:10px;width:100%">Open investment account</a></div></div>';
  }

  /* ---------------------------------------------------------------- more */
  function morePage() {
    var u = ensureAccount(me());
    var items = [
      ['clock', 'Wallet activity', 'All wallet transactions', '#/wallet/activity'],
      ['briefcase', 'Investment account', 'Total assets, payout and WC', '#/investment'],
      ['bag', 'Marketplace', 'Buy and sell products', '#/market'],
      ['box', 'My orders', 'Purchases and delivery', '#/orders'],
      ['bell', 'Notifications', 'Account alerts', '#/notifications'],
      ['users', 'Referrals', 'Invite friends and earn', '#/referrals'],
      ['settings', 'Settings', 'Security and preferences', '#/settings'],
      ['help', 'Support', 'Chat with our team', '#/support'],
      ['user', 'Profile', 'Your public profile', '#/profile']
    ];
    return headA('More', 'Shortcuts to the rest of your Whalechat account.', '#/account') +
      '<div class="card"><div class="ac-more">' + items.map(function (x) {
        return '<a href="' + x[3] + '" class="ac-more-item"><span class="ac-more-ic">' + iconA(x[0], 18) + '</span><div><b>' + x[1] + '</b><small>' + x[2] + '</small></div><i>›</i></a>';
      }).join('') + '</div></div>' +
      '<div class="card"><div class="card-title">Account</div><div class="ac-list">' +
        '<div class="ac-row"><div><b>@' + escA(u.username) + '</b><small>' + escA(u.email || '') + '</small></div><span class="badge">' + escA(u.role || 'user') + '</span></div>' +
        '<div class="ac-row"><div><b>' + escA(u.referralCode || '—') + '</b><small>Your referral code</small></div></div>' +
      '</div></div>';
  }

  /* ------------------------------------------------------------- activity */
  function activityPage() {
    var u = ensureAccount(me());
    if (!u) return '';
    var list = [];
    try {
      (DB.txs || []).filter(function (t) { return t.userId === u.id; }).forEach(function (t) {
        list.push({ at: t.createdAt, title: t.label, sub: (t.coins >= 0 ? '+' : '') + wcA(t.coins) + ' WC', up: t.coins >= 0 });
      });
    } catch (e) {}
    (u.acctLedger || []).forEach(function (l) {
      list.push({ at: l.at, title: l.label, sub: (l.usd ? moneyA(l.usd) + ' · ' : '') + (l.wc ? wcA(l.wc) + ' WC' : ''), up: (l.usd + l.wc) >= 0 });
    });
    list.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    return headA('Wallet activity', 'Every balance movement on your Whalechat account.', '#/account') +
      '<div class="card">' + (list.length ? list.slice(0, 80).map(function (x) {
        return '<div class="ac-row"><div><b>' + escA(x.title) + '</b><small>' + (typeof timeAgo === 'function' ? timeAgo(x.at) + ' ago · ' : '') + (typeof dateLabel === 'function' ? dateLabel(x.at) : '') + '</small></div>' +
          '<span class="tiny ' + (x.up ? 'up' : '') + '">' + escA(x.sub) + '</span></div>';
      }).join('') : '<div class="ac-empty">No activity yet.</div>') + '</div>';
  }

  /* ------------------------------------------------------------- handlers */
  function bindConvert() {
    var from = document.getElementById('acCvFrom');
    var to = document.getElementById('acCvTo');
    var amt = document.getElementById('acCvAmount');
    if (!from || !to || !amt) return;
    var u = ensureAccount(me());
    function available() {
      var v = from.value || '';
      if (v.indexOf('coin:') === 0) return Number(u.depositBalances[v.slice(5)]) || 0;
      return Number(u.walletUsd) || 0;
    }
    function syncTarget() {
      var isUsdSource = from.value === 'usd';
      if (isUsdSource && to.value === 'usd') to.value = 'wc';
      Array.prototype.forEach.call(to.options, function (o) { o.disabled = isUsdSource && o.value === 'usd'; });
    }
    function upd() {
      var v = Number(amt.value) || 0;
      var out = to.value === 'wc' ? v / RATE : v;
      document.getElementById('acCvIn').textContent = moneyA(v);
      document.getElementById('acCvOut').textContent = to.value === 'wc' ? wcA(out) + ' WC' : moneyA(out);
      var avail = available();
      document.getElementById('acCvHint').textContent = 'Available: ' + moneyA(avail) + '. Rate: 1 WC = $' + RATE.toFixed(2) + '.';
      if (v > avail + 0.001) document.getElementById('acCvHint').textContent = 'Amount exceeds available ' + moneyA(avail) + '.';
    }
    from.onchange = function () { syncTarget(); upd(); };
    to.onchange = upd; amt.oninput = upd;
    document.getElementById('acCvMax').onclick = function () { amt.value = available().toFixed(2); upd(); };
    syncTarget(); upd();
  }

  function bindTransfer() {
    var amt = document.getElementById('acTrAmount');
    if (!amt) return;
    var u = ensureAccount(me());
    function upd() {
      var v = Number(amt.value) || 0;
      document.getElementById('acTrIn').textContent = moneyA(v);
      document.getElementById('acTrOut').textContent = moneyA(v);
      document.getElementById('acTrHint').textContent = v > u.walletUsd + 0.001
        ? 'Amount exceeds your $ balance (' + moneyA(u.walletUsd) + ').'
        : 'Available $ balance: ' + moneyA(u.walletUsd) + '.';
    }
    amt.oninput = upd;
    document.getElementById('acTrMax').onclick = function () { amt.value = Number(u.walletUsd || 0).toFixed(2); upd(); };
    upd();
  }

  /* ------------------------------------------------------------- routing */
  function ensureViews() {
    if (typeof VIEWS === 'undefined') return false;
    if (VIEWS.__wcAccountCentre) return true;

    VIEWS.account = function (parts) {
      var sub = (parts && parts[1]) || '';
      if (sub === 'convert') return convertPage();
      if (sub === 'transfer') return transferPage();
      if (sub === 'more') return morePage();
      return accountHome();
    };
    VIEWS.wallet = function (parts) {
      var sub = (parts && parts[1]) || '';
      if (sub === 'activity') return activityPage();
      return accountHome();
    };
    VIEWS.__wcAccountCentre = true;

    if (typeof AFTER !== 'undefined') {
      AFTER.account = function (parts) {
        var sub = (parts && parts[1]) || '';
        if (sub === 'convert') bindConvert();
        if (sub === 'transfer') bindTransfer();
      };
      AFTER.wallet = function (parts) {
        if ((parts && parts[1]) === 'activity') return;
      };
    }

    if (typeof App !== 'undefined') {
      App.acctConvert = function () {
        var u = ensureAccount(me());
        var from = (document.getElementById('acCvFrom') || {}).value || '';
        var to = (document.getElementById('acCvTo') || {}).value || 'wc';
        var amt = round2(Number((document.getElementById('acCvAmount') || {}).value || 0));
        if (!(amt > 0)) return toastA('Enter an amount greater than zero', 'err');
        var isCoin = from.indexOf('coin:') === 0;
        var coin = isCoin ? from.slice(5) : 'USD';
        var avail = isCoin ? Number(u.depositBalances[coin]) || 0 : Number(u.walletUsd) || 0;
        if (amt > avail + 0.001) return toastA('Not enough in that balance', 'err');
        if (isCoin && to === 'usd') {
          u.depositBalances[coin] = round2(avail - amt);
          if (u.depositBalances[coin] <= 0.004) delete u.depositBalances[coin];
          u.walletUsd = round2(u.walletUsd + amt);
          ledgerA(u, 'Converted ' + moneyA(amt) + ' || ' + coin + ' to $ balance', amt, 0, { from: coin, to: 'USD' });
        } else if (isCoin && to === 'wc') {
          u.depositBalances[coin] = round2(avail - amt);
          if (u.depositBalances[coin] <= 0.004) delete u.depositBalances[coin];
          var got = round2(amt / RATE);
          u.balance = round2(Number(u.balance || 0) + got);
          ledgerA(u, 'Converted ' + moneyA(amt) + ' || ' + coin + ' to ' + wcA(got) + ' WC', -amt, got, { from: coin, to: 'WC' });
          try { if (typeof tx === 'function') tx(u.id, 'convert', 'Convert ' + coin + ' to WhaleCoin', got, { usd: amt, coin: coin }); } catch (e) {}
        } else {
          if (to === 'usd') return toastA('Choose Whalecoin as the destination', 'err');
          u.walletUsd = round2(u.walletUsd - amt);
          var gotWc = round2(amt / RATE);
          u.balance = round2(Number(u.balance || 0) + gotWc);
          ledgerA(u, 'Converted ' + moneyA(amt) + ' $ balance to ' + wcA(gotWc) + ' WC', -amt, gotWc, { from: 'USD', to: 'WC' });
          try { if (typeof tx === 'function') tx(u.id, 'convert', 'Convert $ to WhaleCoin', gotWc, { usd: amt }); } catch (e) {}
        }
        saveA(); toastA('Conversion complete', 'ok'); renderA();
      };

      App.acctTransfer = function () {
        var u = ensureAccount(me());
        var a = investAcct(u);
        var amt = round2(Number((document.getElementById('acTrAmount') || {}).value || 0));
        if (!(amt > 0)) return toastA('Enter an amount greater than zero', 'err');
        if (amt > Number(u.walletUsd || 0) + 0.001) return toastA('Not enough in your $ balance', 'err');
        u.walletUsd = round2(u.walletUsd - amt);
        a.usd = round2(Number(a.usd || 0) + amt);
        ledgerA(u, 'Transfer to investment total assets', -amt, 0, { to: 'investment' });
        try { if (typeof tx === 'function') tx(u.id, 'invest-transfer', 'Transfer to investment account', 0, { usd: amt }); } catch (e) {}
        try {
          if (typeof notify === 'function') notify(u.id, 'Transfer complete', moneyA(amt) + ' moved to your investment account.', '#/investment', 'briefcase');
        } catch (e) {}
        saveA(); toastA('Transferred ' + moneyA(amt) + ' to your investment account', 'ok'); renderA();
      };
    }
    return true;
  }

  /* --------------------------------------------------------------- styles */
  (function styles() {
    if (document.getElementById('wc-account-centre-css')) return;
    var st = document.createElement('style');
    st.id = 'wc-account-centre-css';
    st.textContent = [
      '.ac-grid{display:grid;grid-template-columns:1.25fr 1fr 1fr;gap:14px;margin-bottom:14px}',
      '.ac-card{position:relative;overflow:hidden;border:1px solid var(--border);border-radius:18px;padding:18px;background:linear-gradient(160deg,var(--surface-2),var(--surface));display:flex;flex-direction:column;min-height:190px}',
      '.ac-card::after{content:"";position:absolute;right:-45px;top:-55px;width:150px;height:150px;border-radius:50%;background:rgba(46,230,201,.07);pointer-events:none}',
      '.ac-card-dep{border-color:rgba(46,230,201,.32)}.ac-card-usd{border-color:rgba(58,160,255,.28)}.ac-card-wc{border-color:rgba(255,200,97,.25)}',
      '.ac-card-top{display:flex;justify-content:space-between;align-items:center;font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}',
      '.ac-ic{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:rgba(46,230,201,.12);color:var(--accent);font-size:10px;font-weight:800}',
      '.ac-big{font-family:var(--display);font-size:30px;font-weight:800;letter-spacing:-.03em;margin-top:10px;line-height:1.1;font-variant-numeric:tabular-nums}',
      '.ac-big em{font-size:13px;font-style:normal;color:var(--muted);font-weight:700}',
      '.ac-sub{font-size:11px;color:var(--muted);line-height:1.5;margin-top:4px;min-height:32px}',
      '.ac-coins{margin-top:8px;display:flex;flex-direction:column;gap:4px;max-height:118px;overflow:auto}',
      '.ac-coin{display:flex;align-items:center;gap:7px;padding:5px 0;border-top:1px dashed var(--border)}',
      '.ac-coin:first-child{border-top:none}',
      '.ac-coin-dot{width:20px;height:20px;border-radius:6px;background:rgba(46,230,201,.14);color:var(--accent);font-size:9px;font-weight:800;display:flex;align-items:center;justify-content:center;flex:none}',
      '.ac-coin b{font-size:12px;font-variant-numeric:tabular-nums}.ac-coin b i{font-style:normal;color:var(--accent);font-size:10.5px}',
      '.ac-coin small{margin-left:auto;font-size:9.5px;color:var(--muted-2)}',
      '.ac-minirow{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:8px;padding-top:7px;border-top:1px dashed var(--border)}',
      '.ac-link{margin-top:auto;padding-top:10px;font-size:11px;font-weight:700;color:var(--accent);text-decoration:none}',
      '.ac-empty{font-size:11px;color:var(--muted);padding:8px 0}.ac-empty span{font-size:10px;color:var(--muted-2)}',
      '.ac-actions-card{margin-bottom:14px}',
      '.ac-actions{display:grid;grid-template-columns:repeat(7,1fr);gap:8px}',
      '.ac-action{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:13px 6px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);color:var(--text);text-decoration:none;font-size:11px;transition:transform .15s,border-color .15s}',
      '.ac-action span{color:var(--accent);line-height:0}.ac-action b{font-weight:700}',
      '.ac-action:hover{border-color:var(--accent);transform:translateY(-1px)}',
      '.ac-action.on{background:linear-gradient(150deg,rgba(46,230,201,.18),rgba(58,160,255,.08));border-color:rgba(46,230,201,.5)}',
      '.ac-note{display:flex;gap:6px;align-items:flex-start;font-size:10.5px;color:var(--muted);margin-top:10px;line-height:1.55}',
      '.ac-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 0;border-bottom:1px dashed var(--border)}',
      '.ac-row:last-child{border-bottom:none}.ac-row div{display:flex;flex-direction:column;min-width:0}',
      '.ac-row b{font-size:12px;font-weight:650}.ac-row small{font-size:10px;color:var(--muted)}',
      '.ac-foot{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}',
      '.ac-form-grid{display:grid;grid-template-columns:1.3fr 1fr;gap:14px}',
      '.ac-inputwrap{position:relative;display:flex;align-items:center}.ac-inputwrap>span{position:absolute;left:12px;color:var(--muted);font-size:13px;z-index:1}',
      '.ac-inputwrap .input{padding-left:26px;padding-right:60px}.ac-max{position:absolute;right:7px;border:none;background:rgba(46,230,201,.14);color:var(--accent);font-size:10px;font-weight:800;padding:5px 8px;border-radius:6px;cursor:pointer}',
      '.ac-preview{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);margin:4px 0 14px}',
      '.ac-preview div{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}.ac-preview span{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-2);font-weight:700}',
      '.ac-preview b{font-size:15px;font-variant-numeric:tabular-nums}.ac-arrow{flex:none!important;color:var(--accent);font-size:16px}',
      '.ac-source,.ac-to{display:flex;flex-direction:column;gap:2px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);margin-bottom:12px}',
      '.ac-source b,.ac-to b{font-size:13px}.ac-source span,.ac-to small{font-size:10.5px;color:var(--muted)}',
      '.ac-to{flex-direction:row;align-items:center;gap:10px}.ac-to-ic{width:34px;height:34px;border-radius:10px;background:rgba(46,230,201,.12);color:var(--accent);display:flex;align-items:center;justify-content:center;flex:none}',
      '.ac-to div{display:flex;flex-direction:column;gap:2px}',
      '.ac-list{display:flex;flex-direction:column}',
      '.ac-more{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.ac-more-item{display:flex;align-items:center;gap:10px;padding:11px;border:1px solid var(--border);border-radius:11px;background:var(--surface-2);text-decoration:none;color:var(--text)}',
      '.ac-more-ic{width:32px;height:32px;border-radius:9px;background:rgba(46,230,201,.1);color:var(--accent);display:flex;align-items:center;justify-content:center;flex:none}',
      '.ac-more-item div{display:flex;flex-direction:column;gap:1px;min-width:0}.ac-more-item b{font-size:11.5px}.ac-more-item small{font-size:9.5px;color:var(--muted)}',
      '.ac-more-item i{margin-left:auto;font-style:normal;color:var(--muted-2)}',
      '@media(max-width:980px){.ac-grid{grid-template-columns:1fr 1fr}.ac-card-dep{grid-column:1/-1}.ac-actions{grid-template-columns:repeat(4,1fr)}.ac-form-grid{grid-template-columns:1fr}}',
      '@media(max-width:560px){.ac-grid{grid-template-columns:1fr}.ac-card-dep{grid-column:auto}.ac-actions{grid-template-columns:1fr 1fr}.ac-big{font-size:25px}.ac-more{grid-template-columns:1fr}.ac-form-grid{gap:10px}}'
    ].join('');
    document.head.appendChild(st);
  })();

  var tries = 0;
  (function boot() {
    if (ensureViews()) {
      try { renderA(); } catch (e) {}
      return;
    }
    if (tries++ < 60) setTimeout(boot, 400);
  })();
})();
