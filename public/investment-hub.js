/* =========================================================================
   WhaleChat Investment Hub — account quick actions, investment account,
   transfers, portfolio top-ups, tools, B2B, history, disputes and statements.
   Client-side ledgers live on u.investAcct and sync with the existing DB.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcInvestHub) return;
  window.__wcInvestHub = true;

  var RATE = 0.5; // 1 WC = $0.50
  var b2bFilter = 'All';
  function escH(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function money(n) { return '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
  function wc(n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
  function nowId(p) { return (typeof uid === 'function') ? uid(p) : p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function save() { try { persist(); } catch (e) {} try { sync(); } catch (e) {} }
  function toastH(msg, type) { try { toast(msg, type || 'ok'); } catch (e) {} }
  function account(u) {
    try { if (typeof DB !== 'undefined' && DB && !DB.settings) DB.settings = {}; } catch (e) {}
    if (!u.investAcct) {
      u.investAcct = {
        usd: 0, payout: 0, wcBalance: 0,
        portfolios: { stock: 0, wc: 0, b2b: 0, bot: 0 },
        tools: {}, b2b: {}, b2bFav: [], b2bAlerts: [], b2bProfit: 0, disputes: [], requests: [], ledger: [], autoReinvest: false
      };
    }
    var a = u.investAcct;
    if (!a.portfolios) a.portfolios = { stock: 0, wc: 0, b2b: 0, bot: 0 };
    ['stock', 'wc', 'b2b', 'bot'].forEach(function (k) { if (!(Number(a.portfolios[k]) >= 0)) a.portfolios[k] = 0; });
    if (!a.tools) a.tools = {};
    if (!a.b2b) a.b2b = {};
    if (!Array.isArray(a.b2bFav)) a.b2bFav = [];
    if (!Array.isArray(a.b2bAlerts)) a.b2bAlerts = [];
    if (!(Number(a.b2bProfit) >= 0)) a.b2bProfit = Number(a.b2bProfit) || 0;
    if (!Array.isArray(a.disputes)) a.disputes = [];
    if (!Array.isArray(a.requests)) a.requests = [];
    if (!Array.isArray(a.ledger)) a.ledger = [];
    return a;
  }
  function ledger(u, label, usdDelta, wcDelta, meta) {
    var a = account(u);
    a.ledger.unshift({ id: nowId('il_'), label: label, usd: Number(usdDelta) || 0, coins: Number(wcDelta) || 0, meta: meta || null, at: Date.now() });
    if (a.ledger.length > 300) a.ledger.length = 300;
  }
  function userTx(u, type, label, coinsAmt, meta) {
    if (typeof tx === 'function') { try { tx(u.id, type, label, coinsAmt, meta || {}); } catch (e) {} }
  }
  function notifyH(u, title, body, link, icon) {
    if (typeof notify === 'function') { try { notify(u.id, title, body, link || '#/investment', icon || 'wallet'); } catch (e) {} }
  }
  async function requirePin(u, title, sub) {
    if (!u.pin) return true;
    if (typeof askPin !== 'function' || typeof hash !== 'function') return true;
    var pin = await askPin({ title: title, sub: sub || 'Enter your transaction PIN' });
    if (!pin) return false;
    var h = await hash('pin::' + pin);
    if (h !== u.pin) { toastH('Incorrect PIN', 'err'); return false; }
    return true;
  }
  function total(a, u) {
    var p = a.portfolios || {};
    return (Number(a.usd) || 0) + (Number(a.payout) || 0) + (Number(p.b2b) || 0) + ((Number(u && u.balance) || 0) * RATE);
  }

  function depositSummary(u) {
    var map = {};
    try {
      (DB.deposits || []).filter(function (d) { return d.userId === u.id && d.status === 'approved'; }).forEach(function (d) {
        var coin = String(d.coin || d.methodLabel || d.method || 'USD').toUpperCase().replace(/ .*/, '');
        var usd = Number(d.amountUsd);
        if (!(usd > 0)) usd = (Number(d.coins) || 0) * RATE;
        map[coin] = (map[coin] || 0) + usd;
      });
    } catch (e) {}
    var keys = Object.keys(map);
    if (!keys.length) return '$0.00';
    return keys.map(function (k) { return money(map[k]) + ' || ' + k; }).join('<br>');
  }

  function quickActionsHTML() {
    var items = [
      ['download', 'Deposit', '#/deposit'], ['send', 'Withdraw', '#/withdraw'],
      ['briefcase', 'Invest', '#/investment'], ['refresh', 'Convert', '#/investment/convert'],
      ['trend', 'Transfer', '#/investment/transfer'], ['gift', 'Referrals', '#/referrals'], ['more', 'More', '#/investment/more']
    ];
    return '<div class="card ih-quick"><div class="card-title" style="margin:0 0 8px">Quick actions</div><div class="ih-quickgrid">' +
      items.map(function (x) { return '<a href="' + x[2] + '" class="ih-quickbtn"><span>' + (typeof ic === 'function' ? ic(x[0], 17) : '') + '</span><b>' + x[1] + '</b></a>'; }).join('') +
      '</div>' +
      '<details class="ih-overview"><summary>Account overview — all account buttons</summary><div class="ih-overview-grid">' +
        [['Deposit','#/deposit'],['Withdraw','#/withdraw'],['Investment account','#/investment'],['Stock trading','#/invest'],['WC-Investing','#/invest/shares'],['Bot trading','#/invest/bots'],['B2B-Investing','#/investment/b2b'],['Tools','#/investment/tools'],['Referrals','#/referrals'],['Settings','#/settings'],['Notifications','#/notifications'],['Marketplace','#/market'],['Orders','#/orders'],['Wallet','#/wallet']]
          .map(function(x){return '<a href="'+x[1]+'" class="ih-ovbtn">'+x[0]+'</a>';}).join('') +
      '</div></details></div>';
  }

  function head(title, sub, back) {
    return '<div class="page-head"><div class="row" style="gap:10px;align-items:center">' +
      (back ? '<a href="' + back + '" class="btn-icon">' + (typeof ic === 'function' ? ic('back', 18) : '←') + '</a>' : '') +
      '<div><h1 style="margin:0">' + escH(title) + '</h1><p class="muted" style="margin:2px 0 0">' + escH(sub) + '</p></div></div></div>';
  }

  function investmentHome(u) {
    var a = account(u);
    return head('Investment account', 'Your investment portfolio, transfers and specialist balances.', '#/profile') +
      '<div class="ih-cards">' +
        '<div class="ih-card"><span>Total assets</span><b>' + money(total(a, u)) + '</b><small>' + wc(total(a, u) / RATE) + ' WC equivalent</small></div>' +
        '<div class="ih-card"><span>Total assets balance</span><b>' + money(a.usd) + '</b><small>Available for top-ups</small></div>' +
        '<div class="ih-card"><span>Payout balance</span><b>' + money(a.payout) + '</b><small>Profits received</small></div>' +
        '<div class="ih-card"><span>WhaleCoin balance</span><b>' + wc(a.wcBalance || 0) + ' WC</b><small>Investment account WC</small></div>' +
      '</div>' +
      '<div class="card ih-actions"><div class="card-title" style="margin:0 0 8px">Investment account actions</div><div class="ih-btn-grid">' +
        [['Transfer', '#/investment/transfer'], ['Convert', '#/investment/convert'], ['Stock Trading', '#/invest'], ['WC-Investing', '#/invest/shares'], ['B2B-Investing', '#/investment/b2b'], ['Tools', '#/investment/tools'], ['History', '#/investment/history'], ['More', '#/investment/more']]
          .map(function (x) { return '<a href="' + x[1] + '" class="btn btn-ghost btn-sm">' + x[0] + '</a>'; }).join('') +
      '</div></div>' +
      '<div class="card ih-actions"><div class="card-title" style="margin:0 0 8px">Portfolio top-ups</div><div class="ih-btn-grid">' +
        [['Top up Bot trade capital', 'bot'], ['Top up Stock trading', 'stock'], ['Top up WC-Investing', 'wc'], ['Top up B2B-Investing', 'b2b']]
          .map(function (x) { return '<a href="#/investment/topup?to=' + x[1] + '" class="btn btn-soft btn-sm">' + x[0] + '</a>'; }).join('') +
      '</div></div>' +
      '<div class="card"><div class="card-title">Live portfolio balances</div><div class="ih-list">' +
        [['Stock trading', a.portfolios.stock], ['WC-Investing', a.portfolios.wc], ['B2B-Investing', a.portfolios.b2b], ['Bot trading', a.portfolios.bot]]
          .map(function (x) { return '<div class="ih-row"><span>' + x[0] + '</span><b>' + money(x[1]) + '</b><span class="tiny muted">' + wc(x[1] / RATE) + ' WC</span></div>'; }).join('') +
      '</div></div>';
  }

  function transferPage(u) {
    var a = account(u);
    return head('Transfer & convert', 'Move funds between your wallet and investment account.', '#/investment') +
      '<div class="card"><div class="field"><label class="label">Action</label><select class="input" id="ihTrMode">' +
        '<option value="wc2usd">WC wallet → investment USD</option><option value="usd2wc">Investment USD → WC wallet</option><option value="send">Send investment USD to another user</option>' +
      '</select></div>' +
      '<div class="field" id="ihUserWrap" style="display:none"><label class="label">Recipient username, email or account ID</label><input class="input" id="ihTrUser" placeholder="@username / email / ID"/></div>' +
      '<div class="field"><label class="label">Amount</label><input class="input" id="ihTrAmount" type="number" step="0.01" min="0" placeholder="0.00"/><div class="tiny muted" id="ihTrPreview">Rate: 1 WC = $0.50</div></div>' +
      '<button class="btn btn-primary" data-act="ih-transfer" style="width:100%">Continue</button></div>' +
      '<div class="card"><div class="card-title">Balances</div><div class="ih-list"><div class="ih-row"><span>WC wallet</span><b>' + wc(u.balance) + ' WC</b></div><div class="ih-row"><span>Investment total assets</span><b>' + money(a.usd) + '</b></div><div class="ih-row"><span>Payout balance</span><b>' + money(a.payout) + '</b></div></div></div>';
  }

  function convertPage(u) {
    var a = account(u);
    return head('Convert investment assets', 'Convert payout or total assets to WhaleCoin inside your investment account.', '#/investment') +
      '<div class="card"><div class="field"><label class="label">Convert from</label><select class="input" id="ihCvFrom"><option value="payout">Payout balance — ' + money(a.payout) + '</option><option value="total">Total assets balance — ' + money(a.usd) + '</option></select></div>' +
      '<div class="field"><label class="label">Amount (USD)</label><input class="input" id="ihCvAmount" type="number" step="0.01" min="0" placeholder="0.00"/><div class="tiny muted" id="ihCvPreview">Rate: 1 WC = $0.50</div></div>' +
      '<button class="btn btn-primary" data-act="ih-convert" style="width:100%">Convert now</button></div>' +
      '<div class="card"><div class="ih-list"><div class="ih-row"><span>Investment WC balance</span><b>' + wc(a.wcBalance || 0) + ' WC</b></div><div class="ih-row"><span>Payout balance</span><b>' + money(a.payout) + '</b></div><div class="ih-row"><span>Total assets</span><b>' + money(a.usd) + '</b></div></div></div>';
  }

  function topupPage(u, params) {
    var a = account(u); var to = (params && params.to) || 'stock';
    var labels = { stock: 'Stock trading', wc: 'WC-Investing', b2b: 'B2B-Investing', bot: 'Bot trade capital' };
    return head('Top up ' + (labels[to] || 'portfolio'), 'Move USD from your investment total-assets balance.', '#/investment') +
      '<div class="card"><div class="field"><label class="label">Top up to</label><select class="input" id="ihTopTo">' +
        Object.keys(labels).map(function (k) { return '<option value="' + k + '"' + (k === to ? ' selected' : '') + '>' + labels[k] + '</option>'; }).join('') +
      '</select></div><div class="field"><label class="label">Amount (USD)</label><input class="input" id="ihTopAmount" type="number" step="0.01" min="0" placeholder="0.00"/></div>' +
      '<button class="btn btn-primary" data-act="ih-topup" style="width:100%">Send to portfolio</button>' +
      '<div class="tiny muted mt6">Available investment balance: ' + money(a.usd) + '</div></div>' +
      '<div class="card"><div class="card-title">Current portfolio balances</div><div class="ih-list">' +
        Object.keys(labels).map(function (k) { return '<div class="ih-row"><span>' + labels[k] + '</span><b>' + money(a.portfolios[k]) + '</b></div>'; }).join('') + '</div></div>';
  }

  /* ---- subscription catalogue (owned by the shared registry) ------------- */
  function toolCatalog() { try { return (window.WC_SUBS ? WC_SUBS.catalog() : []) || []; } catch (e) { return []; } }
  function toolById(id) { return toolCatalog().find(function (t) { return t.id === id; }); }
  function subIs(id) { try { return window.WC_SUBS ? WC_SUBS.is(id) : false; } catch (e) { return false; } }
  function subStatus(id, u) { try { return window.WC_SUBS ? WC_SUBS.status(id, u) : 'none'; } catch (e) { return 'none'; } }
  function subBadge(id, u) {
    var st = subStatus(id, u);
    var cls = st === 'active' ? 'badge-success' : st === 'expired' || st === 'paused' ? 'badge-warn' : '';
    var txt = st === 'active' ? 'Subscribed' : st === 'paused' ? 'Paused' : st === 'expired' ? 'Expired' : 'Not subscribed';
    return '<span class="badge ' + cls + '" data-sub-badge="' + escH(id) + '">' + txt + '</span>';
  }
  function renewTools(u) { try { if (window.WC_SUBS) WC_SUBS.renew(); } catch (e) {} }

  /* Owned bot traders — shown on the Tools page so a user sees one shared
     subscription state instead of a second Subscribe button. */
  function ownedBotTiers() {
    var st = (window.WC_BOTS && window.WC_BOTS.state) || null;
    return ((st && st.tiers) || []).filter(function (t) { return t && t.owned; });
  }

  function toolsPage(u) {
    var a = account(u);
    try { if (window.WC_SUBS) WC_SUBS.reconcile({ silent: true }); } catch (e) {}
    var tiers = ownedBotTiers();
    return head('Trading tools', 'One subscription per tool — subscribing here activates it on every page.', '#/investment') +
      '<div class="card"><div class="tiny muted">Investment balance: <b>' + money(a.usd) + '</b> · subscriptions renew automatically every 30 days.</div>' +
        '<div class="tiny muted mt6">A tool you subscribe to on the stock trading page or the bots page shows as <b>Subscribed</b> here too, so you are never charged twice.</div></div>' +
      '<div class="ih-tools">' + toolCatalog().map(function (t) {
        var st = subStatus(t.id, u);
        var on = st === 'active';
        var rec = (window.WC_SUBS ? WC_SUBS.record(t.id) : null) || {};
        var where = [];
        if (rec.source === 'bots') where.push('activated on bots page');
        if (rec.source === 'stock') where.push('activated on stock page');
        return '<div class="ih-tool' + (on ? ' ih-tool-on' : '') + '">' +
          '<div class="between" style="align-items:flex-start"><div><b>' + escH(t.name) + '</b>' +
            '<div class="tiny muted">' + escH(t.desc || '') + '</div>' +
            (where.length ? '<div class="tiny up">' + where.join(' · ') + '</div>' : '') +
            (on && rec.expiresAt ? '<div class="tiny muted">Active until ' + new Date(Number(rec.expiresAt)).toLocaleDateString() + '</div>' : '') +
            (t.bot ? '<div class="tiny muted">Also available in Bot trading</div>' : '') +
          '</div>' + subBadge(t.id, u) + '</div>' +
          '<div class="ih-tool-foot"><b>' + money(t.price) + ' / month</b>' +
          '<div class="row" style="gap:6px">' +
            (on ? '<button class="btn btn-xs btn-ghost" data-act="ih-tool-toggle" data-tool="' + t.id + '">Turn off</button>'
                : '<button class="btn btn-xs btn-primary" data-act="ih-tool-sub" data-tool="' + t.id + '">Subscribe</button>') +
          '</div></div></div>';
      }).join('') + '</div>' +
      '<div class="card"><div class="card-title">Bot traders</div>' +
        (tiers.length
          ? '<div class="ih-list">' + tiers.map(function (t) {
              return '<div class="ih-row"><div class="grow"><b>' + escH(t.name) + '</b><div class="tiny muted">' + money(t.priceUsd) + ' / ' + escH(t.billingCycle || 'month') + '</div></div><span class="badge badge-success">Subscribed</span></div>';
            }).join('') + '</div>'
          : '<div class="tiny muted">No bot trader subscribed yet. <a href="#/invest/bots">Open Bot trading</a> — a bot you subscribe to there is marked subscribed here as well.</div>') +
      '</div>';
  }

  /* =======================================================================
     B2B investing desk
     -----------------------------------------------------------------------
     Balance model (single source of truth):
       capital  a.portfolios.b2b → deposits in + principal returned on sells
                                   − money spent on buys
       assets   computed        → live market worth of every open holding
       profit   a.b2bProfit     → realised payout on each sell (proceeds − basis)
     ======================================================================= */
  var B2B_LISTS = [
    { id: 'contract', name: 'Company contract', desc: 'Every asset the WhaleChat company contract can fill right now.' },
    { id: 'fav', name: 'Favourites', desc: 'Assets you starred on the desk.' },
    { id: 'crypto', name: 'Crypto', desc: '24/7 digital assets.' },
    { id: 'stocks', name: 'Stocks', desc: 'US equities with live pricing.' },
    { id: 'indices', name: 'Indices', desc: 'Index baskets.' },
    { id: 'forex', name: 'Forex', desc: 'Currency pairs.' }
  ];

  function b2bAssets() {
    var list = [];
    try { list = (INV.visibleStocks ? INV.visibleStocks() : INV.stocks()) || []; } catch (e) { list = []; }
    return list.slice(0, 200);
  }
  function b2bQuote(t) { try { return INV.quote(t); } catch (e) { return null; } }
  function b2bLabel(s) { return (s && (s.displayTicker || s.name)) || (s && s.ticker) || ''; }
  function b2bCategory(s) {
    var sec = String((s && s.sector) || '').toLowerCase();
    if ((s && s.crypto) || sec.indexOf('crypto') >= 0) return 'Crypto';
    if (sec.indexOf('forex') >= 0 || sec.indexOf('currency') >= 0) return 'Forex';
    if (sec.indexOf('index') >= 0 || sec.indexOf('indices') >= 0) return 'Indices';
    return 'Stocks';
  }
  function b2bPath(ticker) {
    var vals = [];
    try { vals = INV.series(ticker, '1D') || []; } catch (e) {}
    if (!vals || vals.length < 2) return '';
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var spread = (max - min) || 1;
    return vals.map(function (v, i) { return ((i / (vals.length - 1)) * 300).toFixed(1) + ',' + (58 - ((v - min) / spread) * 52).toFixed(1); }).join(' ');
  }
  function b2bUnits(n) { return Number(Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 6 }); }
  function b2bPriceOf(t, fallback) {
    var q = b2bQuote(t) || {};
    return Number(q.price) > 0 ? Number(q.price) : (Number(fallback) || 0);
  }
  function b2bHoldings(a) {
    var out = [];
    Object.keys(a.b2b || {}).forEach(function (t) {
      var h = a.b2b[t];
      if (!h || !(Number(h.units) > 0)) return;
      var price = b2bPriceOf(t, h.avgPrice);
      var units = Number(h.units) || 0;
      var basis = units * (Number(h.avgPrice) || price);
      var value = units * price;
      out.push({ ticker: t, units: units, avgPrice: Number(h.avgPrice) || price, price: price, basis: basis, value: value, pl: value - basis });
    });
    return out.sort(function (x, y) { return y.value - x.value; });
  }
  function b2bAssetsValue(a) {
    return b2bHoldings(a).reduce(function (s, h) { return s + h.value; }, 0);
  }
  function b2bProfit(a) { return Number(a.b2bProfit) || 0; }
  function b2bCapital(a) { return Number(a.portfolios.b2b) || 0; }
  function b2bAvatar(s) {
    return '<div class="b2b-ic">' + escH(String(s && (s.displayTicker || s.ticker) || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()) + '</div>';
  }

  /* ---- shared header for the desk ---------------------------------------- */
  function b2bHead(u, title, sub, back) {
    var a = account(u);
    return head(title, sub, back || '#/investment/b2b') +
      '<div class="b2b-balbar">' +
        '<div><span>Capital</span><b>' + money(b2bCapital(a)) + '</b></div>' +
        '<div><span>Assets</span><b>' + money(b2bAssetsValue(a)) + '</b></div>' +
        '<div><span>Profit</span><b class="' + (b2bProfit(a) >= 0 ? 'up' : 'down') + '">' + money(b2bProfit(a)) + '</b></div>' +
      '</div>';
  }

  function b2bCard(s, a) {
    var q = b2bQuote(s.ticker) || {}; var fav = (a.b2bFav || []).indexOf(s.ticker) >= 0;
    return '<div class="b2b-card">' +
      '<div class="between"><a href="#/investment/b2b/buy?asset=' + encodeURIComponent(s.ticker) + '" class="b2b-name">' + escH(b2bLabel(s)) + '</a>' +
      '<button class="b2b-star ' + (fav ? 'on' : '') + '" data-act="ih-b2b-fav" data-t="' + escH(s.ticker) + '" title="Favourite">' + (fav ? '★' : '☆') + '</button></div>' +
      '<div class="tiny muted">' + escH(b2bCategory(s)) + '</div>' +
      '<div class="b2b-price" data-b2b-price="' + escH(s.ticker) + '">' + (q.price > 0 ? money(q.price) : '—') + '</div>' +
      '<div class="tiny ' + ((q.changePct || 0) >= 0 ? 'up' : 'down') + '">' + ((q.changePct || 0) >= 0 ? '+' : '') + (Number(q.changePct) || 0).toFixed(2) + '%</div>' +
      '<svg viewBox="0 0 300 60" class="b2b-spark"><polyline points="' + b2bPath(s.ticker) + '" fill="none" stroke="' + ((q.changePct || 0) >= 0 ? '#22c55e' : '#ef4444') + '" stroke-width="1.6"/></svg>' +
    '</div>';
  }

  /* ---- 1. dashboard ------------------------------------------------------ */
  function b2bDash(u, params) {
    var a = account(u);
    var holdings = b2bHoldings(a);
    var assetsVal = holdings.reduce(function (s, h) { return s + h.value; }, 0);
    var favs = (a.b2bFav || []).map(function (t) { return (INV.stock ? INV.stock(t) : null); }).filter(Boolean);
    var alerts = a.b2bAlerts || [];

    var holdRows = holdings.map(function (h) {
      return '<a class="ih-row b2b-holdrow" href="#/investment/b2b/sell?asset=' + encodeURIComponent(h.ticker) + '">' +
        '<div class="grow" style="min-width:0"><b>' + escH(h.ticker) + '</b>' +
          '<div class="tiny muted">' + b2bUnits(h.units) + ' units · entry ' + money(h.avgPrice) + '</div></div>' +
        '<div style="text-align:right"><b data-b2b-hold="' + escH(h.ticker) + '" data-b2b-units="' + h.units + '">' + money(h.value) + '</b>' +
          '<div class="tiny ' + (h.pl >= 0 ? 'up' : 'down') + '">' + (h.pl >= 0 ? '+' : '') + money(h.pl) + '</div></div>' +
        '<span class="btn btn-xs btn-danger">Sell</span></a>';
    }).join('');

    return head('B2B-Investing', 'Company-contract desk: buy, sell, fund and move your balances.', '#/investment') +
      '<div class="ih-cards">' +
        '<div class="ih-card"><span>Capital balance</span><b>' + money(b2bCapital(a)) + '</b><small>Deposits in · buys are paid from here</small></div>' +
        '<div class="ih-card"><span>Total assets balance</span><b>' + money(assetsVal) + '</b><small>' + holdings.length + ' open holding' + (holdings.length === 1 ? '' : 's') + ' at live price</small></div>' +
        '<div class="ih-card"><span>Profit balance</span><b class="' + (b2bProfit(a) >= 0 ? 'up' : 'down') + '">' + money(b2bProfit(a)) + '</b><small>Payout credited on every sell</small></div>' +
        '<div class="ih-card"><span>Account value</span><b>' + money(b2bCapital(a) + assetsVal + b2bProfit(a)) + '</b><small>Capital + assets + profit</small></div>' +
      '</div>' +

      /* buy and sell are deliberately separate buttons */
      '<div class="b2b-pair">' +
        '<a href="#/investment/b2b/buy" class="b2b-bigbtn buy" data-b2b-cta="buy">' +
          '<span>' + (typeof ic === 'function' ? ic('trend', 20) : '') + '</span><b>Buy</b><small>Open the buy page</small></a>' +
        '<a href="#/investment/b2b/sell" class="b2b-bigbtn sell" data-b2b-cta="sell">' +
          '<span>' + (typeof ic === 'function' ? ic('wallet', 20) : '') + '</span><b>Sell</b><small>' + (holdings.length ? holdings.length + ' holding' + (holdings.length === 1 ? '' : 's') + ' to sell' : 'No holdings yet') + '</small></a>' +
      '</div>' +

      '<div class="card ih-actions"><div class="ih-btn-grid">' +
        '<a href="#/investment/b2b/assets" class="btn btn-ghost btn-sm" data-b2b-nav="assets">Asset lists</a>' +
        '<a href="#/investment/b2b/topup" class="btn btn-ghost btn-sm" data-b2b-nav="topup">Top up</a>' +
        '<a href="#/investment/b2b/transfer" class="btn btn-ghost btn-sm" data-b2b-nav="transfer">Transfer</a>' +
        '<a href="#/investment/history" class="btn btn-ghost btn-sm">History</a>' +
      '</div></div>' +

      '<div class="card"><div class="card-title">Your holdings</div>' +
        (holdRows ? '<div class="ih-list">' + holdRows + '</div>' : '<div class="tiny muted">No B2B holdings yet — open the buy page to start.</div>') +
      '</div>' +
      (favs.length ? '<div class="card"><div class="card-title">Favourites</div><div class="b2b-grid">' + favs.map(function (s) { return b2bCard(s, a); }).join('') + '</div></div>' : '') +
      (alerts.length ? '<div class="card"><div class="card-title">Price alerts</div><div class="ih-list">' + alerts.map(function (x) {
          return '<div class="ih-row"><span class="grow">' + escH(x.ticker) + '<div class="tiny muted">buy ≤ ' + money(x.buy || 0) + ' · sell ≥ ' + money(x.sell || 0) + (x.email !== false ? ' · email on' : '') + '</div></span>' +
            '<a class="btn btn-xs btn-ghost" href="#/investment/b2b/buy?asset=' + encodeURIComponent(x.ticker) + '">Buy</a>' +
            '<button class="btn btn-xs btn-ghost" data-act="ih-b2b-alert-clear" data-t="' + escH(x.ticker) + '">Remove</button></div>';
        }).join('') + '</div></div>' : '');
  }

  /* ---- 2. buy page ------------------------------------------------------- */
  function b2bBuyPage(u, params) {
    var a = account(u);
    var assets = b2bAssets();
    var picked = String((params && params.asset) || '').toUpperCase();
    var sel = assets.find(function (s) { return s.ticker === picked; }) || (INV.stock && picked ? INV.stock(picked) : null) || assets[0] || null;
    if (!sel) return b2bHead(u, 'Buy assets', 'No tradable asset is available right now.') + '<div class="card"><div class="tiny muted">The company contract has no assets loaded.</div></div>';
    var q = b2bQuote(sel.ticker) || {};
    var price = Number(q.price) || 0;
    var alert = (a.b2bAlerts || []).find(function (x) { return x.ticker === sel.ticker; }) || {};

    return b2bHead(u, 'Buy ' + b2bLabel(sel), 'Paid from your B2B capital balance.', '#/investment/b2b') +
      '<div class="card">' +
        '<div class="field"><label class="label">Asset</label><select class="input" id="ihB2bBuyAsset" data-act="ih-b2b-buy-asset">' +
          assets.map(function (s) { return '<option value="' + escH(s.ticker) + '"' + (s.ticker === sel.ticker ? ' selected' : '') + '>' + escH(b2bLabel(s)) + ' · ' + escH(b2bCategory(s)) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="b2b-quote"><div><span class="tiny muted">Live price</span><b data-b2b-price="' + escH(sel.ticker) + '" data-b2b-unitprice>' + (price > 0 ? money(price) : '—') + '</b></div>' +
          '<div><span class="tiny muted">Today</span><b class="' + ((q.changePct || 0) >= 0 ? 'up' : 'down') + '">' + ((q.changePct || 0) >= 0 ? '+' : '') + (Number(q.changePct) || 0).toFixed(2) + '%</b></div>' +
          '<div><span class="tiny muted">Capital available</span><b>' + money(b2bCapital(a)) + '</b></div></div>' +
        '<div class="field"><label class="label">Amount to invest (USD)</label>' +
          '<input class="input" id="ihB2bBuyAmount" type="number" step="0.01" min="0" placeholder="0.00" data-b2b-amount/>' +
          '<div class="tiny muted mt6" id="ihB2bBuyPreview">Units are bought at the live price.</div></div>' +
        '<button class="btn btn-primary" data-act="ih-b2b-buy" data-t="' + escH(sel.ticker) + '" style="width:100%">Buy ' + escH(b2bLabel(sel)) + '</button>' +
        '<div class="tiny muted mt6">Buys are paid from your capital balance. The assets balance then shows their live market worth.</div>' +
      '</div>' +
      '<div class="card"><div class="card-title">Price alerts</div>' +
        '<div class="row" style="gap:8px"><div class="field grow"><label class="label">Buy below (USD)</label><input class="input" id="ihB2bBuyAlert" type="number" step="0.0001" value="' + (alert.buy || '') + '"/></div>' +
        '<div class="field grow"><label class="label">Sell above (USD)</label><input class="input" id="ihB2bSellAlert" type="number" step="0.0001" value="' + (alert.sell || '') + '"/></div></div>' +
        '<label class="row" style="gap:8px;align-items:center;font-size:12px"><input type="checkbox" id="ihB2bAlertEmail" ' + (alert.email === false ? '' : 'checked') + '/> Email me when a target is hit</label>' +
        '<button class="btn btn-soft" data-act="ih-b2b-alert" data-t="' + escH(sel.ticker) + '" style="width:100%;margin-top:8px">Save alerts</button>' +
        '<div class="tiny muted mt6">You get an in-app notification and an email with a <b>Buy now</b> and a <b>Sell now</b> link.</div></div>' +
      '<div class="card"><div class="card-title">Browse</div><div class="b2b-grid">' + assets.slice(0, 12).map(function (s) { return b2bCard(s, a); }).join('') + '</div></div>';
  }

  /* ---- 3. sell page ------------------------------------------------------ */
  function b2bSellPage(u, params) {
    var a = account(u);
    var holdings = b2bHoldings(a);
    var picked = String((params && params.asset) || '').toUpperCase();
    if (picked) holdings = holdings.filter(function (h) { return h.ticker === picked; });

    if (!Object.keys(a.b2b || {}).length) {
      return b2bHead(u, 'Sell assets', 'Nothing to sell yet.', '#/investment/b2b') +
        '<div class="card"><div class="tiny muted">You have no B2B holdings. Open the buy page to buy your first asset.</div>' +
        '<a class="btn btn-primary" href="#/investment/b2b/buy" style="width:100%;margin-top:10px">Open buy page</a></div>';
    }

    var rows = holdings.map(function (h) {
      return '<div class="card b2b-sellcard">' +
        '<div class="between" style="align-items:flex-start"><div><b>' + escH(h.ticker) + '</b>' +
          '<div class="tiny muted">' + b2bUnits(h.units) + ' units · entry ' + money(h.avgPrice) + '</div></div>' +
          '<div style="text-align:right"><b data-b2b-hold="' + escH(h.ticker) + '" data-b2b-units="' + h.units + '">' + money(h.value) + '</b>' +
          '<div class="tiny ' + (h.pl >= 0 ? 'up' : 'down') + '">' + (h.pl >= 0 ? '+' : '') + money(h.pl) + ' payout</div></div></div>' +
        '<div class="row" style="gap:8px;margin-top:8px;align-items:flex-end">' +
          '<div class="field grow" style="margin:0"><label class="label">Units to sell</label>' +
            '<input class="input" id="ihB2bSellUnits_' + escH(h.ticker) + '" type="number" step="0.00000001" min="0" max="' + h.units + '" placeholder="' + b2bUnits(h.units) + '"/></div>' +
          '<button class="btn btn-danger" data-act="ih-b2b-sell" data-t="' + escH(h.ticker) + '">Sell</button>' +
          '<button class="btn btn-ghost" data-act="ih-b2b-sell" data-t="' + escH(h.ticker) + '" data-all="1">Sell all</button>' +
        '</div></div>';
    }).join('');

    return b2bHead(u, 'Sell assets', 'Proceeds are credited to your B2B profit balance; your principal returns to capital.', '#/investment/b2b') +
      (picked ? '' : '<div class="card"><div class="tiny muted">Showing every open holding. Tap a row on the dashboard to sell one asset at a time.</div></div>') +
      rows;
  }

  /* ---- 4. asset lists (multi-select buy) --------------------------------- */
  function b2bAssetListsPage(u, params) {
    var a = account(u);
    var listId = (params && params.list) || 'contract';
    var all = b2bAssets();
    var favIds = a.b2bFav || [];
    var list = all;
    if (listId === 'fav') list = all.filter(function (s) { return favIds.indexOf(s.ticker) >= 0; });
    else if (listId !== 'contract') {
      var want = listId.charAt(0).toUpperCase() + listId.slice(1);
      list = all.filter(function (s) { return b2bCategory(s) === want; });
    }
    var listDef = B2B_LISTS.find(function (l) { return l.id === listId; }) || B2B_LISTS[0];

    var chips = B2B_LISTS.map(function (l) {
      var n = l.id === 'contract' ? all.length : l.id === 'fav' ? favIds.length : all.filter(function (s) { return b2bCategory(s) === (l.id.charAt(0).toUpperCase() + l.id.slice(1)); }).length;
      return '<a class="chip b2b-cat ' + (l.id === listId ? 'on' : '') + '" href="#/investment/b2b/assets?list=' + l.id + '">' + escH(l.name) + ' <span class="tiny muted">' + n + '</span></a>';
    }).join('');

    var rows = list.map(function (s) {
      var q = b2bQuote(s.ticker) || {};
      var fav = favIds.indexOf(s.ticker) >= 0;
      return '<label class="b2b-pickrow">' +
        '<input type="checkbox" data-b2b-pick value="' + escH(s.ticker) + '"/>' +
        b2bAvatar(s) +
        '<div class="grow" style="min-width:0"><b>' + escH(b2bLabel(s)) + '</b><div class="tiny muted">' + escH(b2bCategory(s)) + '</div></div>' +
        '<div style="text-align:right"><b data-b2b-price="' + escH(s.ticker) + '">' + (q.price > 0 ? money(q.price) : '—') + '</b>' +
        '<div class="tiny ' + ((q.changePct || 0) >= 0 ? 'up' : 'down') + '">' + ((q.changePct || 0) >= 0 ? '+' : '') + (Number(q.changePct) || 0).toFixed(2) + '%</div></div>' +
        '<button type="button" class="b2b-star ' + (fav ? 'on' : '') + '" data-act="ih-b2b-fav" data-t="' + escH(s.ticker) + '">' + (fav ? '★' : '☆') + '</button>' +
      '</label>';
    }).join('');

    return b2bHead(u, 'Asset lists', listDef.desc, '#/investment/b2b') +
      '<div class="row b2b-cats" style="gap:6px;flex-wrap:wrap;margin-bottom:8px">' + chips + '</div>' +
      '<div class="card"><div class="between"><div class="card-title" style="margin:0">' + escH(listDef.name) + '</div>' +
        '<button class="btn btn-xs btn-ghost" data-act="ih-b2b-select-all">Select all</button></div>' +
        (rows ? '<div class="b2b-picklist">' + rows + '</div>' : '<div class="tiny muted">This list is empty.</div>') +
      '</div>' +
      '<div class="card b2b-buybar">' +
        '<div class="between"><b><span id="ihB2bPickedCount">0</span> selected</b><span class="tiny muted">Capital ' + money(b2bCapital(a)) + '</span></div>' +
        '<div class="field" style="margin:8px 0 0"><label class="label">Total to invest (USD) — split evenly</label>' +
          '<input class="input" id="ihB2bMultiAmount" type="number" step="0.01" min="0" placeholder="0.00"/></div>' +
        '<button class="btn btn-primary" data-act="ih-b2b-buy-multi" style="width:100%;margin-top:8px">Buy selected assets</button>' +
        '<div class="tiny muted mt6">Each selected asset receives an equal share of the amount you enter.</div>' +
      '</div>';
  }

  /* ---- 5. top up --------------------------------------------------------- */
  function b2bTopupPage(u) {
    var a = account(u);
    return head('Top up B2B capital', 'Fund the B2B investing account. Buys are paid from this capital balance.', '#/investment/b2b') +
      '<div class="card">' +
        '<div class="field"><label class="label">Take the money from</label><select class="input" id="ihB2bTopFrom">' +
          '<option value="usd">Investment account balance · ' + money(a.usd) + '</option>' +
          '<option value="wc">WhaleCoin wallet · ' + wc(u.balance) + ' WC</option>' +
        '</select></div>' +
        '<div class="field"><label class="label">Amount (USD)</label><input class="input" id="ihB2bTopAmount" type="number" step="0.01" min="0" placeholder="0.00"/></div>' +
        '<button class="btn btn-primary" data-act="ih-b2b-topup" style="width:100%">Top up capital</button>' +
        '<div class="tiny muted mt6">WhaleCoin is converted at 1 WC = $0.50.</div>' +
      '</div>' +
      '<div class="card"><div class="ih-list">' +
        '<div class="ih-row"><span>Capital balance</span><b>' + money(b2bCapital(a)) + '</b></div>' +
        '<div class="ih-row"><span>Total assets balance</span><b>' + money(b2bAssetsValue(a)) + '</b></div>' +
        '<div class="ih-row"><span>Profit balance</span><b>' + money(b2bProfit(a)) + '</b></div>' +
      '</div></div>';
  }

  /* ---- 6. transfer ------------------------------------------------------- */
  function b2bTransferPage(u) {
    var a = account(u);
    return head('B2B transfer', 'Move profit between your B2B desk and your investment account.', '#/investment/b2b') +
      '<div class="card">' +
        '<div class="field"><label class="label">Transfer</label><select class="input" id="ihB2bTrMode">' +
          '<option value="profit2invest">B2B profit → investment profit balance</option>' +
          '<option value="profit2capital">B2B profit → B2B capital balance</option>' +
        '</select></div>' +
        '<div class="field"><label class="label">Amount (USD)</label><input class="input" id="ihB2bTrAmount" type="number" step="0.01" min="0" placeholder="0.00"/>' +
          '<div class="tiny muted mt6">B2B profit available: ' + money(b2bProfit(a)) + '</div></div>' +
        '<button class="btn btn-primary" data-act="ih-b2b-transfer" style="width:100%">Transfer</button>' +
      '</div>' +
      '<div class="card"><div class="ih-list">' +
        '<div class="ih-row"><span>B2B profit balance</span><b>' + money(b2bProfit(a)) + '</b></div>' +
        '<div class="ih-row"><span>Investment profit (payout) balance</span><b>' + money(a.payout) + '</b></div>' +
        '<div class="ih-row"><span>B2B capital balance</span><b>' + money(b2bCapital(a)) + '</b></div>' +
      '</div></div>';
  }

  /* ---- 7. asset detail (kept for old links) ------------------------------ */
  function b2bPage(u, params) {
    if (params && params.asset) return b2bBuyPage(u, params);
    return b2bDash(u, params);
  }

  function historyPage(u) {
    var a = account(u);
    return head('Investment history', 'Transfers, top-ups, tools and portfolio movements.', '#/investment') +
      '<div class="card"><div class="ih-list">' + (a.ledger.length ? a.ledger.map(function (x) {
        return '<div class="ih-row"><div class="grow"><b>' + escH(x.label) + '</b><div class="tiny muted">' + new Date(x.at).toLocaleString() + '</div></div><div style="text-align:right"><b class="' + (x.usd >= 0 ? 'up' : 'down') + '">' + (x.usd >= 0 ? '+' : '') + money(x.usd) + '</b>' + (x.coins ? '<div class="tiny muted">' + (x.coins >= 0 ? '+' : '') + wc(x.coins) + ' WC</div>' : '') + '</div></div>';
      }).join('') : '<div class="empty" style="padding:18px"><p>No investment transactions yet.</p></div>') + '</div></div>';
  }

  function morePage(u) {
    return head('More', 'Loans, cards, statements, disputes and help.', '#/investment') +
      '<div class="card"><div class="ih-btn-grid">' +
        '<a href="#/investment/statement" class="btn btn-ghost btn-sm">Account statement</a>' +
        '<a href="#/investment/disputes" class="btn btn-ghost btn-sm">Transaction dispute</a>' +
        '<a href="#/how-it-works" class="btn btn-ghost btn-sm">FAQ &amp; trade guide</a>' +
        '<button class="btn btn-ghost btn-sm" data-act="ih-request" data-kind="loan">Request a loan</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="ih-request" data-kind="card">Request a WhaleChat card</button>' +
      '</div></div>' +
      '<div class="card"><div class="card-title">Submitted requests</div>' + (account(u).requests.length ? account(u).requests.map(function (r) { return '<div class="ih-row"><span>' + escH(r.kind === 'loan' ? 'Loan request' : 'Card request') + '</span><span class="badge badge-warn">' + escH(r.status) + '</span></div>'; }).join('') : '<div class="tiny muted">No requests yet.</div>') + '</div>';
  }

  function statementPage(u) {
    var a = account(u);
    return head('Account statement', 'Summary from your account creation to today.', '#/investment') +
      '<div class="card"><div class="ih-list">' +
        '<div class="ih-row"><span>Account created</span><b>' + new Date(u.createdAt || Date.now()).toLocaleDateString() + '</b></div>' +
        '<div class="ih-row"><span>Main WC balance</span><b>' + wc(u.balance) + ' WC</b></div>' +
        '<div class="ih-row"><span>Investment total assets</span><b>' + money(a.usd) + '</b></div>' +
        '<div class="ih-row"><span>Payout balance</span><b>' + money(a.payout) + '</b></div>' +
        '<div class="ih-row"><span>Total deposits</span><b>' + wc(u.totalDeposits || 0) + ' WC</b></div>' +
        '<div class="ih-row"><span>Total withdrawals</span><b>' + wc(u.totalWithdrawals || 0) + ' WC</b></div>' +
        '<div class="ih-row"><span>Referrals</span><b>' + (DB.users || []).filter(function (x) { return x.referredBy === u.id; }).length + '</b></div>' +
      '</div><button class="btn btn-soft" data-act="ih-print" style="width:100%;margin-top:10px">Print / save statement</button></div>';
  }

  function disputesPage(u) {
    var a = account(u);
    return head('Transaction dispute', 'Submit a deposit, withdrawal, transfer or account issue.', '#/investment') +
      '<div class="card"><div class="field"><label class="label">Dispute type</label><select class="input" id="ihDspType"><option>Deposit issue</option><option>Withdrawal issue</option><option>Transaction dispute</option><option>Account issue</option><option>Asset reversal</option></select></div>' +
      '<div class="field"><label class="label">Transaction reference (optional)</label><input class="input" id="ihDspRef" placeholder="ID or description"/></div>' +
      '<div class="field"><label class="label">Describe the issue</label><textarea class="input" id="ihDspText" rows="4" placeholder="Tell us what happened..."></textarea></div>' +
      '<button class="btn btn-primary" data-act="ih-dispute" style="width:100%">Submit dispute</button></div>' +
      '<div class="card"><div class="card-title">My disputes</div>' + (a.disputes.length ? a.disputes.map(function (d) { return '<div class="ih-row"><div class="grow"><b>' + escH(d.type) + '</b><div class="tiny muted">' + escH(d.text).slice(0, 100) + '</div></div><span class="badge ' + (d.status === 'resolved' ? 'badge-success' : d.status === 'declined' ? 'badge-danger' : 'badge-warn') + '">' + escH(d.status) + '</span></div>'; }).join('') : '<div class="tiny muted">No disputes submitted.</div>') + '</div>';
  }

  function serverDetailsPage() {
    var d = (typeof DB !== 'undefined' && DB.settings) ? DB.settings : {};
    var sd = d.serverDetails || {};
    function row(label, id, val, type) { return '<div class="field"><label class="label">' + label + '</label><input class="input" id="' + id + '" type="' + (type || 'text') + '" value="' + escH(val == null ? '' : val) + '"/></div>'; }
    return head('Server details', 'Editable app and deployment metadata for administrators.', '#/admin') +
      '<div class="card">' +
        row('App name', 'sdAppName', sd.appName || 'WhaleChat') +
        row('App creation date', 'sdCreatedAt', sd.createdAt || '2026-11-09', 'date') +
        row('Environment', 'sdEnv', sd.environment || 'production') +
        row('Region / host', 'sdRegion', sd.region || '') +
        row('Database', 'sdDatabase', sd.database || 'Postgres (whalechat_state)') +
        row('Storage', 'sdStorage', sd.storage || 'S3 / Render disk') +
        row('Public URL', 'sdUrl', sd.publicUrl || (typeof location !== 'undefined' ? location.origin : '')) +
        row('Support email', 'sdSupport', sd.supportEmail || 'support@whalechat.app', 'email') +
        '<div class="field"><label class="label">Notes</label><textarea class="input" id="sdNotes" rows="3">' + escH(sd.notes || '') + '</textarea></div>' +
        '<button class="btn btn-primary" data-act="ih-server-save" style="width:100%">Save server details</button>' +
        '<div class="tiny muted mt6">Runtime version: ' + escH(typeof APP_VERSION !== 'undefined' ? APP_VERSION : '3.38.x') + ' · build: ' + escH(typeof APP_BUILD !== 'undefined' ? APP_BUILD : '') + '</div>' +
      '</div>';
  }

  function adminTools() {
    var catalog = toolCatalog();
    var subs = [];
    (DB.users || []).forEach(function (u) {
      var a = account(u);
      catalog.forEach(function (t) {
        var s = a.tools[t.id];
        if (s) subs.push({ u: u, t: t, s: s });
      });
    });
    return head('Tool pricing & subscribers', 'Manage subscription prices and see every active tool subscriber.', '#/admin') +
      '<div class="card"><div class="card-title">Prices (USD / 30 days)</div>' +
        catalog.map(function (t) { return '<div class="ih-row"><div class="grow"><b>' + escH(t.name) + '</b><div class="tiny muted">' + escH(t.id) + '</div></div><input class="input" style="max-width:110px" id="ihPrice_' + escH(t.id) + '" type="number" step="0.01" min="0" value="' + Number(t.price).toFixed(2) + '"/></div>'; }).join('') +
        '<button class="btn btn-primary" style="margin-top:10px" data-act="ih-admin-tools-save">Save prices</button></div>' +
      '<div class="card"><div class="card-title">Subscribers</div><div class="ih-list">' +
        (subs.length ? subs.map(function (x) {
          var active = x.s.active && Number(x.s.expiresAt) > Date.now();
          return '<div class="ih-row"><div class="grow"><b>@' + escH(x.u.username) + ' · ' + escH(x.t.name) + '</b><div class="tiny muted">' + (active ? 'active until ' + new Date(x.s.expiresAt).toLocaleDateString() : (x.s.paused ? 'paused' : 'inactive/expired')) + ' · ' + money(x.s.price || x.t.price) + '/mo</div></div><span class="badge ' + (active ? 'badge-success' : 'badge-warn') + '">' + (active ? 'ON' : (x.s.paused ? 'PAUSED' : 'OFF')) + '</span><div class="ih-tool-adminbtns">' + [['pause','Pause'],['extend','+30d'],['refund','Refund'],['cancel','Cancel']].map(function(a){return '<button class="btn btn-xs btn-ghost" data-act="ih-admin-tool" data-uid="'+escH(x.u.id)+'" data-tool="'+escH(x.t.id)+'" data-op="'+a[0]+'">'+a[1]+'</button>';}).join('') + '</div></div>';
        }).join('') : '<div class="tiny muted">No tool subscribers yet.</div>') + '</div></div>';
  }

  function adminB2BInventory() {
    var assets = b2bAssets(); var inv = (DB.settings && DB.settings.b2bInventory) || {};
    return head('B2B company inventory', 'Available asset units in the WhaleChat company contract.', '#/admin') +
      '<div class="card"><div class="ih-list">' + assets.map(function (s) {
        var v = Number(inv[s.ticker]); if (!(v >= 0)) v = 100000;
        return '<div class="ih-row"><b class="grow">' + escH(s.displayTicker || s.ticker) + '</b><input class="input" style="max-width:140px" id="inv_' + escH(s.ticker) + '" type="number" step="0.00000001" min="0" value="' + v + '"/></div>';
      }).join('') + '</div><button class="btn btn-primary" data-act="ih-admin-b2b-save" style="margin-top:10px">Save inventory</button></div>';
  }

  function adminDisputes() {
    var rows = [];
    (DB.users || []).forEach(function (u) { account(u).disputes.forEach(function (d) { rows.push({ u: u, d: d }); }); });
    return head('Investment disputes', 'Review user investment and transaction disputes.', '#/admin') +
      '<div class="card"><div class="ih-list">' + (rows.length ? rows.map(function (x) {
        return '<div class="ih-row"><div class="grow"><b>@' + escH(x.u.username) + ' · ' + escH(x.d.type) + '</b><div class="tiny muted">' + escH(x.d.text) + '</div></div><select class="input" style="max-width:140px" onchange="App.ihAdminDispute(null,{uid:\'' + escH(x.u.id) + '\',id:\'' + escH(x.d.id) + '\'},event)"><option' + (x.d.status === 'pending' ? ' selected' : '') + '>pending</option><option' + (x.d.status === 'review' ? ' selected' : '') + '>review</option><option' + (x.d.status === 'processing' ? ' selected' : '') + '>processing</option><option' + (x.d.status === 'resolved' ? ' selected' : '') + '>resolved</option><option' + (x.d.status === 'declined' ? ' selected' : '') + '>declined</option></select></div>';
      }).join('') : '<div class="tiny muted">No disputes.</div>') + '</div></div>';
  }

  function stockStrip(u) {
    var a = account(u);
    var profit = 0;
    try { (DB.trades || []).filter(function (t) { return t.userId === u.id && t.status === 'Completed' && t.type !== 'live'; }).forEach(function (t) { profit += Number(t.plUsd) || ((Number(t.pnlCoins) || 0) * RATE); }); } catch (e) {}
    var cap = Number(a.portfolios.stock) || (Number(u.balance) || 0) * RATE;
    return '<div class="ih-cards">' +
      '<div class="ih-card"><span>Trade capital balance</span><b>' + money(cap) + '</b><small>' + wc(cap / RATE) + ' WC</small></div>' +
      '<div class="ih-card"><span>Profit balance</span><b class="' + (profit >= 0 ? 'up' : 'down') + '">' + money(profit) + '</b><small>Closed trade P/L</small></div>' +
      '<div class="ih-card"><span>Leftover capital</span><b>' + money(0) + '</b><small>Returned after losses</small></div>' +
    '</div><div class="card ih-actions"><div class="ih-btn-grid">' +
      [['Stocks','#/invest/market'],['Trade now','#/invest/market'],['Transfer','#/investment/transfer'],['Bot traders','#/invest/bots'],['History','#/invest/orders'],['Watchlist','#/invest/watchlist']]
        .map(function(x){return '<a href="'+x[1]+'" class="btn btn-ghost btn-sm">'+x[0]+'</a>';}).join('') + '</div></div>';
  }

  function botStrip(u) {
    var a = account(u); var st = (window.WC_BOTS && window.WC_BOTS.state) || {};
    var capital = Number(st.balance) ? Number(st.balance) * RATE : Number(a.portfolios.bot) || 0;
    var profit = Number(st.session && st.session.profitCoins ? st.session.profitCoins : 0) * RATE;
    var leftover = Number(st.session && st.session.leftoverCoins ? st.session.leftoverCoins : 0) * RATE;
    return '<div class="ih-cards">' +
      '<div class="ih-card"><span>Trade capital balance</span><b>' + money(capital) + '</b></div>' +
      '<div class="ih-card"><span>Profit balance</span><b class="' + (profit >= 0 ? 'up' : 'down') + '">' + money(profit) + '</b></div>' +
      '<div class="ih-card"><span>Leftover capital</span><b>' + money(leftover) + '</b></div></div>' +
      '<div class="card ih-actions"><div class="ih-btn-grid">' +
      [['Start trading','#/invest/bots'],['Stop trading','#/invest/bots'],['Transfer','#/investment/transfer'],['Turn on/off bot','#/invest/bots'],['Settings','#/invest/bots'],['History','#/investment/history']]
        .map(function(x){return '<a href="'+x[1]+'" class="btn btn-ghost btn-sm">'+x[0]+'</a>';}).join('') + '</div></div>';
  }

  function sharesStrip(u) {
    var a = account(u); var st = (window.WC_SHARES && window.WC_SHARES.state) || {};
    var sum = st.summary || {};
    var capital = Number(sum.investedUsd) || Number(a.portfolios.wc) || 0;
    var profit = Number(sum.totalEarnedUsd) || 0;
    var leftover = Math.max(0, capital - Math.abs(profit));
    return '<div class="ih-cards">' +
      '<div class="ih-card"><span>Capital balance</span><b>' + money(capital) + '</b></div>' +
      '<div class="ih-card"><span>Profits</span><b class="' + (profit >= 0 ? 'up' : 'down') + '">' + money(profit) + '</b></div>' +
      '<div class="ih-card"><span>Leftover capital</span><b>' + money(leftover) + '</b></div></div>' +
      '<div class="card ih-actions"><div class="ih-btn-grid">' +
      [['Invest now','#/invest/shares'],['Active plans','#/invest/shares'],['Transfer','#/investment/transfer'],['ROI progress','#/invest/shares'],['History','#/investment/history']]
        .map(function(x){return '<a href="'+x[1]+'" class="btn btn-ghost btn-sm">'+x[0]+'</a>';}).join('') + '</div></div>';
  }

  function ensureView() {
    if (typeof VIEWS === 'undefined') return false;
    if (VIEWS.__wcInvestHub) return true;
    VIEWS.investment = function (parts, params) {
      var u = me(); if (!u) return '';
      var sub = (parts && parts[1]) || '';
      if (sub === 'transfer') return transferPage(u);
      if (sub === 'convert') return convertPage(u);
      if (sub === 'topup') return topupPage(u, params);
      if (sub === 'tools') return toolsPage(u);
      if (sub === 'b2b') {
        var b2bSub = (parts && parts[2]) || '';
        if (b2bSub === 'buy') return b2bBuyPage(u, params);
        if (b2bSub === 'sell') return b2bSellPage(u, params);
        if (b2bSub === 'assets' || b2bSub === 'lists') return b2bAssetListsPage(u, params);
        if (b2bSub === 'topup') return b2bTopupPage(u);
        if (b2bSub === 'transfer') return b2bTransferPage(u);
        return b2bPage(u, params);
      }
      if (sub === 'history') return historyPage(u);
      if (sub === 'more') return morePage(u);
      if (sub === 'statement') return statementPage(u);
      if (sub === 'disputes') return disputesPage(u);
      return investmentHome(u);
    };
    var baseAdmin = VIEWS.admin;
    if (baseAdmin) {
      VIEWS.admin = function (parts) {
        if ((parts && parts[1]) === 'invest-disputes') return adminDisputes();
        if ((parts && parts[1]) === 'tools') return adminTools();
        if ((parts && parts[1]) === 'server-details') return serverDetailsPage();
        if ((parts && parts[1]) === 'b2b-inventory') return adminB2BInventory();
        return baseAdmin.apply(this, arguments);
      };
    }
    var baseProfile = VIEWS.profile;
    VIEWS.profile = function () {
      var html = baseProfile.apply(this, arguments);
      var u = me();
      if (u && u.role !== 'admin') {
        if (html.indexOf('<a href="#/deposit" class="btn">Deposit</a><a href="#/withdraw" class="btn">Withdraw</a>') >= 0) {
          html = html.replace('<a href="#/deposit" class="btn">Deposit</a><a href="#/withdraw" class="btn">Withdraw</a>', '<a href="#/deposit" class="btn">Deposit</a><a href="#/investment" class="btn">Investment account</a><a href="#/withdraw" class="btn">Withdraw</a>');
        }
        var strip = '<div class="ih-cards ih-account-strip">' +
          '<div class="ih-card"><span>Deposit balance</span><b>' + depositSummary(u) + '</b><small>Deposited coin assets</small></div>' +
          '<div class="ih-card"><span>$ balance</span><b>' + money(u.walletUsd || 0) + '</b><small>USD wallet balance</small></div>' +
          '<div class="ih-card"><span>WhaleCoin balance</span><b>' + wc(u.balance) + ' WC</b><small>Spendable WC</small></div>' +
        '</div>';
        html = html.replace('<div class="card mb16 profile-banner">', strip + '<div class="card mb16 profile-banner">');
        if (html.indexOf('Quick navigation') >= 0) {
          html = html.replace('<div class="section-title mt22"><h3>Quick navigation</h3></div>', quickActionsHTML() + '<div class="section-title mt22"><h3>Quick navigation</h3></div>');
        }
      }
      return html;
    };
    if (typeof INV !== 'undefined' && INV.viewDash && !INV.__wcStockStrip) {
      var baseDash = INV.viewDash;
      INV.viewDash = function () { return stockStrip(me()) + baseDash.apply(this, arguments); };
      INV.__wcStockStrip = true;
    }
    var baseInvestView = VIEWS.invest;
    if (baseInvestView) {
      VIEWS.invest = function (parts, params) {
        var html = baseInvestView.apply(this, arguments);
        var sub = (parts && parts[1]) || '';
        if (sub === 'bots') html = botStrip(me()) + html;
        else if (sub === 'shares') html = sharesStrip(me()) + html;
        return html;
      };
    }
    VIEWS.__wcInvestHub = true;
    return true;
  }

  if (typeof App !== 'undefined') {
    App.ihTransfer = async function () {
      var u = me(); var a = account(u);
      var mode = (document.getElementById('ihTrMode') || {}).value || 'wc2usd';
      var amount = Number((document.getElementById('ihTrAmount') || {}).value || 0);
      if (!(amount > 0)) return toastH('Enter an amount', 'err');
      if (!await requirePin(u, 'Confirm transfer', 'Enter your PIN to move funds')) return;
      if (mode === 'wc2usd') {
        if (u.balance < amount) return toastH('Not enough WC', 'err');
        u.balance = Math.round((u.balance - amount) * 100) / 100;
        a.usd = Math.round((a.usd + amount * RATE) * 100) / 100;
        ledger(u, 'WC → investment', amount * RATE, -amount); userTx(u, 'invest-transfer', 'Investment top-up', -amount, { usd: amount * RATE });
      } else if (mode === 'usd2wc') {
        if (a.usd < amount) return toastH('Not enough investment USD', 'err');
        a.usd = Math.round((a.usd - amount) * 100) / 100;
        u.balance = Math.round((u.balance + amount / RATE) * 100) / 100;
        ledger(u, 'Investment → WC', -amount, amount / RATE); userTx(u, 'invest-transfer', 'Investment withdrawal to WC', amount / RATE, { usd: -amount });
      } else {
        var id = String((document.getElementById('ihTrUser') || {}).value || '').trim().replace(/^@/, '');
        var other = (DB.users || []).find(function (x) { return x.id === id || x.username === id || x.email === id; });
        if (!other || other.id === u.id) return toastH('Recipient not found', 'err');
        if (a.usd < amount) return toastH('Not enough investment USD', 'err');
        a.usd = Math.round((a.usd - amount) * 100) / 100;
        account(other).usd = Math.round((account(other).usd + amount) * 100) / 100;
        ledger(u, 'Sent to @' + other.username, -amount, 0); ledger(other, 'Received from @' + u.username, amount, 0);
        notifyH(other, 'Investment transfer received', money(amount) + ' was added to your investment account.', '#/investment');
      }
      save(); toastH('Transfer complete', 'ok'); render();
    };
    App.ihConvert = function () {
      var u = me(); var a = account(u);
      var from = (document.getElementById('ihCvFrom') || {}).value || 'payout';
      var amt = Number((document.getElementById('ihCvAmount') || {}).value || 0);
      if (!(amt > 0)) return toastH('Enter an amount', 'err');
      var src = from === 'total' ? 'usd' : 'payout';
      if ((Number(a[src]) || 0) < amt) return toastH('Not enough in that balance', 'err');
      a[src] = Math.round((a[src] - amt) * 100) / 100;
      a.wcBalance = Math.round((Number(a.wcBalance) + amt / RATE) * 100) / 100;
      ledger(u, 'Convert ' + money(amt) + ' to investment WC', -amt, amt / RATE, { from: src }); save(); toastH('Converted to WC', 'ok'); render();
    };
    App.ihTopup = function () {
      var u = me(); var a = account(u);
      var to = (document.getElementById('ihTopTo') || {}).value || 'stock';
      var amount = Number((document.getElementById('ihTopAmount') || {}).value || 0);
      if (!(amount > 0)) return toastH('Enter an amount', 'err');
      if (a.usd < amount) return toastH('Not enough investment balance', 'err');
      a.usd = Math.round((a.usd - amount) * 100) / 100;
      a.portfolios[to] = Math.round(((a.portfolios[to] || 0) + amount) * 100) / 100;
      if (to !== 'b2b') {
        u.balance = Math.round((Number(u.balance) + amount / RATE) * 100) / 100;
        userTx(u, 'invest-topup', 'Investment top-up · ' + to, amount / RATE, { portfolio: to, usd: amount });
      }
      ledger(u, 'Top-up ' + to, -amount, to !== 'b2b' ? amount / RATE : 0, { portfolio: to }); save(); toastH('Portfolio topped up', 'ok'); render();
    };
    /* ---- tools: one shared subscription, never a second charge ---------- */
    App.ihToolSub = async function (id, ds) {
      var u = me(); if (!window.WC_SUBS) return toastH('Subscriptions not available', 'err');
      var t = toolById(ds.tool); if (!t) return;
      if (WC_SUBS.is(t.id)) return toastH(t.name + ' is already subscribed — no second payment taken', 'ok');
      var r = await WC_SUBS.subscribe(t.id, { source: 'tools' });
      if (r.already) return toastH(t.name + ' is already subscribed', 'ok');
      if (!r.ok) return toastH(r.error === 'cancelled' ? 'Subscription cancelled' : (r.error || 'Could not subscribe'), 'err');
      toastH(t.name + ' activated on every page', 'ok');
      render();
    };
    App.ihToolToggle = async function (id, ds) {
      if (!window.WC_SUBS) return;
      if (WC_SUBS.is(ds.tool)) {
        var r = await WC_SUBS.cancel(ds.tool);
        if (!r.ok && r.error !== 'cancelled') return toastH(r.error || 'Could not turn off', 'err');
        if (r.ok) toastH('Tool turned off', 'ok');
      } else {
        var s = await WC_SUBS.subscribe(ds.tool, { source: 'tools' });
        if (s.ok) toastH('Tool activated', 'ok');
        else if (!s.already && s.error !== 'cancelled') toastH(s.error || 'Could not subscribe', 'err');
      }
      render();
    };

    /* ---- B2B desk: buy / sell / multi-buy / top-up / transfer ----------- */
    function b2bInventory() { DB.settings = DB.settings || {}; return (DB.settings.b2bInventory = DB.settings.b2bInventory || {}); }
    function b2bAvail(t) { var v = Number(b2bInventory()[t]); return v >= 0 ? v : 100000; }
    function b2bFill(t, amount) {
      /* one authoritative buy fill: capital pays, units land, inventory drops */
      var u = me(); var a = account(u);
      var q = null; try { q = INV.quote(t); } catch (e) {}
      if (!t || !q || !(q.price > 0)) return { error: 'No live quote for ' + t };
      amount = Math.round((Number(amount) || 0) * 100) / 100;
      if (!(amount > 0)) return { error: 'Enter an amount' };
      if (b2bCapital(a) < amount) return { error: 'Not enough capital — top up your B2B capital first' };
      var units = amount / q.price;
      var avail = b2bAvail(t);
      if (units > avail) return { error: 'The company contract does not have enough ' + t + ' available' };
      a.portfolios.b2b = Math.round((b2bCapital(a) - amount) * 100) / 100;
      b2bInventory()[t] = Math.round((avail - units) * 1e8) / 1e8;
      var h = a.b2b[t] || { units: 0, avgPrice: q.price };
      h.avgPrice = ((Number(h.units) * Number(h.avgPrice)) + amount) / (Number(h.units) + units);
      h.units = Number(h.units) + units;
      a.b2b[t] = h;
      ledger(u, 'B2B buy ' + t, -amount, 0, { ticker: t, units: units, price: q.price });
      return { units: units, price: q.price, amount: amount };
    }
    App.ihB2bBuy = function (id, ds) {
      var t = ((ds && ds.t) || '').toUpperCase();
      if (!t) { var sel = document.getElementById('ihB2bBuyAsset'); t = sel ? String(sel.value || '').toUpperCase() : ''; }
      var amount = Number((document.getElementById('ihB2bBuyAmount') || {}).value || 0);
      var r = b2bFill(t, amount);
      if (r.error) return toastH(r.error, 'err');
      save(); toastH('Bought ' + b2bUnits(r.units) + ' ' + t + ' at ' + money(r.price), 'ok'); render();
    };
    App.ihB2bSell = function (id, ds) {
      var u = me(); var a = account(u); var t = String((ds && ds.t) || '').toUpperCase();
      var h = a.b2b[t]; if (!h || !(Number(h.units) > 0)) return toastH('No holding to sell', 'err');
      var q = null; try { q = INV.quote(t); } catch (e) {}
      if (!q || !(q.price > 0)) return toastH('No live quote for ' + t, 'err');
      var units = ds && ds.all ? Number(h.units) : Number((document.getElementById('ihB2bSellUnits_' + t) || {}).value || 0);
      if (!(units > 0)) units = Number(h.units);
      if (units > Number(h.units) + 1e-9) units = Number(h.units);
      var proceeds = units * q.price;
      var basis = units * (Number(h.avgPrice) || q.price);
      var payout = proceeds - basis;
      /* payout (profit or loss) is credited to the profit balance, principal back to capital */
      a.b2bProfit = Math.round((b2bProfit(a) + payout) * 100) / 100;
      a.portfolios.b2b = Math.round((b2bCapital(a) + basis) * 100) / 100;
      h.units = Math.round((Number(h.units) - units) * 1e8) / 1e8;
      if (h.units <= 1e-8) delete a.b2b[t]; else a.b2b[t] = h;
      b2bInventory()[t] = Math.round((b2bAvail(t) + units) * 1e8) / 1e8;
      ledger(u, 'B2B sell ' + t + (units < Number(h.units) + units ? ' (partial)' : ''), 0, 0, { ticker: t, units: units, price: q.price, proceeds: proceeds, payout: payout });
      save();
      toastH('Sold ' + b2bUnits(units) + ' ' + t + ' · payout ' + (payout >= 0 ? '+' : '') + money(payout) + ' to profit balance', 'ok');
      render();
    };
    App.ihB2bBuyMulti = function () {
      var picked = [];
      document.querySelectorAll('[data-b2b-pick]:checked').forEach(function (el) { picked.push(String(el.value || '').toUpperCase()); });
      if (!picked.length) return toastH('Select at least one asset', 'err');
      var total = Number((document.getElementById('ihB2bMultiAmount') || {}).value || 0);
      if (!(total > 0)) return toastH('Enter the total amount to invest', 'err');
      var share = Math.floor((total / picked.length) * 100) / 100;
      if (!(share > 0)) return toastH('Amount is too small to split', 'err');
      var ok = [], failed = [];
      picked.forEach(function (t) {
        var r = b2bFill(t, share);
        if (r.error) failed.push(t + ': ' + r.error); else ok.push(t);
      });
      if (ok.length) { save(); toastH('Bought ' + ok.length + ' asset' + (ok.length === 1 ? '' : 's') + ' · ' + money(share) + ' each', 'ok'); }
      if (failed.length) toastH(failed[0], 'err');
      render();
    };
    App.ihB2bSelectAll = function () {
      var boxes = document.querySelectorAll('[data-b2b-pick]');
      var allOn = Array.prototype.every.call(boxes, function (b) { return b.checked; });
      Array.prototype.forEach.call(boxes, function (b) { b.checked = !allOn; });
      App.ihB2bPicked();
    };
    App.ihB2bPicked = function () {
      var n = document.querySelectorAll('[data-b2b-pick]:checked').length;
      var el = document.getElementById('ihB2bPickedCount'); if (el) el.textContent = String(n);
    };
    App.ihB2bTopup = function () {
      var u = me(); var a = account(u);
      var from = (document.getElementById('ihB2bTopFrom') || {}).value || 'usd';
      var amount = Number((document.getElementById('ihB2bTopAmount') || {}).value || 0);
      if (!(amount > 0)) return toastH('Enter an amount', 'err');
      if (from === 'wc') {
        var need = Math.round((amount / RATE) * 100) / 100;
        if ((Number(u.balance) || 0) < need) return toastH('Not enough WhaleCoin', 'err');
        u.balance = Math.round((Number(u.balance) - need) * 100) / 100;
        ledger(u, 'WC → B2B capital', amount, -need, { source: 'wc' });
      } else {
        if ((Number(a.usd) || 0) < amount) return toastH('Not enough investment balance', 'err');
        a.usd = Math.round((Number(a.usd) - amount) * 100) / 100;
        ledger(u, 'Investment → B2B capital', -amount, 0, { source: 'usd' });
      }
      a.portfolios.b2b = Math.round((b2bCapital(a) + amount) * 100) / 100;
      save(); toastH('B2B capital topped up · ' + money(amount), 'ok'); render();
    };
    App.ihB2bTransfer = function () {
      var u = me(); var a = account(u);
      var mode = (document.getElementById('ihB2bTrMode') || {}).value || 'profit2invest';
      var amount = Number((document.getElementById('ihB2bTrAmount') || {}).value || 0);
      if (!(amount > 0)) return toastH('Enter an amount', 'err');
      if (b2bProfit(a) < amount) return toastH('Not enough B2B profit balance', 'err');
      a.b2bProfit = Math.round((b2bProfit(a) - amount) * 100) / 100;
      if (mode === 'profit2capital') {
        a.portfolios.b2b = Math.round((b2bCapital(a) + amount) * 100) / 100;
        ledger(u, 'B2B profit → capital', 0, 0, { amount: amount, to: 'capital' });
        toastH('Moved ' + money(amount) + ' to B2B capital', 'ok');
      } else {
        a.payout = Math.round((Number(a.payout) + amount) * 100) / 100;
        ledger(u, 'B2B profit → investment profit balance', 0, 0, { amount: amount, to: 'payout' });
        toastH('Moved ' + money(amount) + ' to your investment profit balance', 'ok');
      }
      save(); render();
    };
    App.ihB2bFav = function (id, ds) {
      var u = me(); var a = account(u); var t = String((ds && ds.t) || '').toUpperCase();
      var i = a.b2bFav.indexOf(t);
      if (i >= 0) a.b2bFav.splice(i, 1); else a.b2bFav.push(t);
      save(); toastH(i >= 0 ? 'Removed from favourites' : 'Saved to favourites', 'ok'); render();
    };
    App.ihB2bCat = function (id, ds) { b2bFilter = ds.cat || 'All'; render(); };
    App.ihB2bAlert = function (id, ds) {
      var u = me(); var a = account(u);
      var t = String((ds && ds.t) || '').toUpperCase();
      var buy = Number((document.getElementById('ihB2bBuyAlert') || {}).value) || 0;
      var sell = Number((document.getElementById('ihB2bSellAlert') || {}).value) || 0;
      var emailEl = document.getElementById('ihB2bAlertEmail');
      var byEmail = emailEl ? !!emailEl.checked : true;
      if (buy <= 0 && sell <= 0) return toastH('Enter a buy or sell target', 'err');
      var ex = (a.b2bAlerts || []).find(function (x) { return x.ticker === t; });
      if (ex) { ex.buy = buy; ex.sell = sell; ex.email = byEmail; ex.buyHit = false; ex.sellHit = false; ex.buyHitAt = 0; ex.sellHitAt = 0; }
      else a.b2bAlerts.push({ id: nowId('al_'), ticker: t, buy: buy, sell: sell, email: byEmail, buyHit: false, sellHit: false, createdAt: Date.now() });
      save(); toastH('Price alert saved' + (byEmail ? ' · email enabled' : ''), 'ok'); render();
    };
    App.ihB2bAlertClear = function (id, ds) {
      var u = me(); var a = account(u); var t = String((ds && ds.t) || '').toUpperCase();
      a.b2bAlerts = a.b2bAlerts.filter(function (x) { return x.ticker !== t; }); save(); render();
    };
    App.ihB2bBuyAsset = function (id, ds, ev) {
      var v = (ev && ev.target && ev.target.value) || '';
      if (v) location.hash = '#/investment/b2b/buy?asset=' + encodeURIComponent(v);
    };
    App.ihDispute = function () {
      var u = me(); var a = account(u);
      var type = (document.getElementById('ihDspType') || {}).value || 'Transaction dispute';
      var ref = (document.getElementById('ihDspRef') || {}).value || '';
      var text = (document.getElementById('ihDspText') || {}).value || '';
      if (!text.trim()) return toastH('Describe the issue', 'err');
      a.disputes.unshift({ id: nowId('dp_'), type: type, ref: ref, text: text, status: 'pending', createdAt: Date.now() });
      save(); toastH('Dispute submitted', 'ok'); render();
    };
    App.ihAdminDispute = function (id, ds, ev) {
      var u = (DB.users || []).find(function (x) { return x.id === ds.uid; }); if (!u) return;
      var d = account(u).disputes.find(function (x) { return x.id === ds.id; }); if (!d) return;
      d.status = (ev && ev.target && ev.target.value) || ds.status || 'pending'; d.updatedAt = Date.now();
      notifyH(u, 'Dispute updated', 'Your dispute status is now ' + d.status + '.', '#/investment/disputes');
      save(); toastH('Dispute updated', 'ok');
    };
    App.ihRequest = function (id, ds) {
      var u = me(); var a = account(u);
      a.requests.unshift({ id: nowId('rq_'), kind: ds.kind, status: 'pending', createdAt: Date.now() });
      save(); toastH('Request submitted', 'ok'); render();
    };
    App.ihAdminToolAction = function (id, ds) {
      var u = (DB.users || []).find(function (x) { return x.id === ds.uid; }); if (!u) return;
      var a = account(u); var s = a.tools[ds.tool]; var t = toolById(ds.tool);
      if (!s) return;
      if (ds.op === 'pause') { s.paused = !s.paused; s.active = !s.paused; if (s.active && !(Number(s.expiresAt) > Date.now())) s.expiresAt = Date.now() + 30 * 864e5; }
      else if (ds.op === 'cancel') { delete a.tools[ds.tool]; }
      else if (ds.op === 'refund') { var amt = Number(s.price || (t && t.price) || 0); if (amt > 0) { a.usd = Math.round((a.usd + amt) * 100) / 100; ledger(u, 'Admin refund · ' + (t ? t.name : ds.tool), amt, 0); } delete a.tools[ds.tool]; }
      else if (ds.op === 'extend') { s.active = true; s.paused = false; s.expiresAt = Math.max(Date.now(), Number(s.expiresAt) || 0) + 30 * 864e5; s.reminded = false; }
      notifyH(u, 'Tool subscription updated', (t ? t.name : ds.tool) + ': ' + ds.op, '#/investment/tools', 'shield');
      save(); toastH('Subscription updated', 'ok'); render();
    };
    App.ihAdminB2bSave = function () {
      DB.settings.b2bInventory = DB.settings.b2bInventory || {};
      b2bAssets().forEach(function (s) {
        var el = document.getElementById('inv_' + s.ticker);
        var v = Number(el && el.value);
        if (v >= 0) DB.settings.b2bInventory[s.ticker] = v;
      });
      save(); toastH('B2B inventory updated', 'ok'); render();
    };
    App.ihServerSave = function () {
      if (!DB.settings) DB.settings = {};
      var get = function (id) { return (document.getElementById(id) || {}).value || ''; };
      DB.settings.serverDetails = {
        appName: get('sdAppName'), createdAt: get('sdCreatedAt'), environment: get('sdEnv'), region: get('sdRegion'),
        database: get('sdDatabase'), storage: get('sdStorage'), publicUrl: get('sdUrl'), supportEmail: get('sdSupport'), notes: get('sdNotes'),
        updatedAt: Date.now()
      };
      save(); toastH('Server details saved', 'ok'); render();
    };
    App.ihAdminToolsSave = function () {
      var catalog = toolCatalog();
      catalog.forEach(function (t) {
        var el = document.getElementById('ihPrice_' + t.id);
        var v = Number(el && el.value);
        if (v >= 0) t.price = Math.round(v * 100) / 100;
      });
      save(); toastH('Tool prices updated', 'ok'); render();
    };
    App.ihPrint = function () { try { window.print(); } catch (e) {} };
  }

  /* ---- live price painter for every B2B surface -------------------------- */
  function paintB2BPrices() {
    try {
      document.querySelectorAll('[data-b2b-price]').forEach(function (el) {
        var t = el.getAttribute('data-b2b-price'); if (!t) return;
        var q = b2bQuote(t); if (!q || !(Number(q.price) > 0)) return;
        var txt = money(q.price);
        if (el.textContent !== txt) el.textContent = txt;
      });
      document.querySelectorAll('[data-b2b-hold]').forEach(function (el) {
        var t = el.getAttribute('data-b2b-hold');
        var units = Number(el.getAttribute('data-b2b-units')) || 0;
        var q = b2bQuote(t); if (!q || !(Number(q.price) > 0)) return;
        var txt = money(units * q.price);
        if (el.textContent !== txt) el.textContent = txt;
      });
      var amt = document.querySelector('[data-b2b-amount]');
      if (amt) {
        var here = String((location.hash || '').split('?asset=')[1] || '').split('&')[0];
        var q2 = here ? b2bQuote(decodeURIComponent(here).toUpperCase()) : null;
        var pv = document.getElementById('ihB2bBuyPreview');
        if (pv && q2 && Number(q2.price) > 0 && Number(amt.value) > 0) {
          var unitsPreview = Number(amt.value) / Number(q2.price);
          var t2 = 'You get about ' + b2bUnits(unitsPreview) + ' units at ' + money(q2.price) + '.';
          if (pv.textContent !== t2) pv.textContent = t2;
        }
      }
    } catch (e) {}
  }
  function watchB2B() {
    document.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t) return;
      if (t.matches && t.matches('[data-b2b-pick]')) { try { App.ihB2bPicked(); } catch (e) {} }
      if (t.matches && t.matches('[data-b2b-amount]')) paintB2BPrices();
      if (t.id === 'ihB2bBuyAsset' && t.value) location.hash = '#/investment/b2b/buy?asset=' + encodeURIComponent(t.value);
    }, false);
    document.addEventListener('input', function (ev) {
      var t = ev.target;
      if (t && t.matches && (t.matches('[data-b2b-amount]') || t.id === 'ihB2bMultiAmount')) paintB2BPrices();
    }, false);
    setInterval(paintB2BPrices, 3000);
  }

  (function styles() {
    if (document.getElementById('ih-style')) return;
    var st = document.createElement('style'); st.id = 'ih-style';
    st.textContent = `
    .ih-quick{margin:14px 0}
    .ih-quickgrid,.ih-btn-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
    .ih-quickbtn{display:flex;flex-direction:column;gap:7px;align-items:flex-start;padding:11px;border:1px solid var(--border);
      border-radius:11px;background:var(--surface-2);color:var(--text);text-decoration:none}
    .ih-quickbtn span{color:var(--accent)} .ih-quickbtn b{font-size:11.5px}
    .ih-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin-bottom:12px}
    .ih-card{display:flex;flex-direction:column;gap:3px;padding:12px;border-radius:12px;border:1px solid var(--border);background:var(--surface-2)}
    .ih-card span{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-2);font-weight:700}
    .ih-card b{font-size:17px} .ih-card small{font-size:10px;color:var(--muted)}
    .ih-list{display:flex;flex-direction:column}
    .ih-row{display:flex;gap:8px;align-items:center;padding:9px 0;border-top:1px solid var(--border);font-size:12px}
    .ih-row:first-child{border-top:none}
    .ih-row b{font-variant-numeric:tabular-nums}
    .ih-tools{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:9px}
    .ih-tool{padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2)}
    .ih-tool-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px}
    @media(max-width:560px){
      .ih-card b{font-size:15px}.ih-row{font-size:11.5px;flex-wrap:wrap}
      .ih-quickgrid,.ih-btn-grid{grid-template-columns:1fr 1fr}
      .ih-tool-foot{flex-wrap:wrap}
      .ih-tool .between{flex-wrap:wrap;gap:6px}
      .ih-row select{max-width:100%!important;width:100%}
      .ih-quickbtn{padding:10px}
      .ih-card{padding:10px}
    }
    @media(max-width:380px){.ih-quickgrid,.ih-btn-grid{grid-template-columns:1fr}}
    .shares-dash,.bot-dash{display:none!important}
    .ih-overview{margin-top:10px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2)}
    .ih-overview summary{cursor:pointer;padding:10px 11px;font-size:11.5px;font-weight:700;color:var(--text)}
    .ih-overview-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:0 10px 10px}
    .ih-ovbtn{display:block;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--surface);text-decoration:none;color:var(--text);font-size:11px}
    .ih-tool-adminbtns{display:flex;gap:4px;flex-wrap:wrap;width:100%;margin-top:5px}
    @media(min-width:600px){.ih-overview-grid{grid-template-columns:1fr 1fr 1fr}}
    .b2b-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:12px}
    .b2b-card{padding:10px;border:1px solid var(--border);border-radius:11px;background:var(--surface-2);display:flex;flex-direction:column;gap:3px}
    .b2b-name{font-size:12px;font-weight:700;color:var(--text);text-decoration:none}
    .b2b-star{margin-left:auto;background:none;border:none;color:var(--muted);font-size:16px;cursor:pointer}
    .b2b-star.on{color:#ffc861}
    .b2b-price{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums}
    .b2b-spark{width:100%;height:44px;margin-top:2px}
    .b2b-bigspark{width:100%;height:110px}
    .b2b-cat.on{border-color:var(--accent);color:var(--accent)}
    @media(max-width:420px){.b2b-grid{grid-template-columns:1fr 1fr}}
    /* --- B2B desk ------------------------------------------------------- */
    .b2b-balbar{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0 0 12px;padding:10px 12px;
      border:1px solid var(--border);border-radius:12px;background:var(--surface-2)}
    .b2b-balbar div{display:flex;flex-direction:column;gap:2px;min-width:0}
    .b2b-balbar span{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-2);font-weight:700}
    .b2b-balbar b{font-size:14px;font-variant-numeric:tabular-nums}
    .b2b-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
    .b2b-bigbtn{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:16px 14px;border-radius:14px;
      text-decoration:none;border:1px solid var(--border);background:var(--surface-2);color:var(--text)}
    .b2b-bigbtn b{font-size:19px;letter-spacing:-.01em}
    .b2b-bigbtn small{font-size:10.5px;color:var(--muted)}
    .b2b-bigbtn span{color:var(--accent);line-height:0}
    .b2b-bigbtn.buy{border-color:rgba(34,197,94,.45);background:linear-gradient(160deg,rgba(34,197,94,.16),rgba(34,197,94,.04))}
    .b2b-bigbtn.buy b{color:#22c55e}
    .b2b-bigbtn.sell{border-color:rgba(239,68,68,.42);background:linear-gradient(160deg,rgba(239,68,68,.14),rgba(239,68,68,.03))}
    .b2b-bigbtn.sell b{color:#ef4444}
    .b2b-bigbtn:active{transform:scale(.985)}
    .b2b-quote{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:4px 0 12px;padding:10px;
      border-radius:11px;border:1px solid var(--border);background:var(--surface-2)}
    .b2b-quote>div{display:flex;flex-direction:column;gap:2px;min-width:0}
    .b2b-quote b{font-size:14px;font-variant-numeric:tabular-nums}
    .b2b-picklist{display:flex;flex-direction:column;max-height:58vh;overflow:auto}
    .b2b-pickrow{display:flex;gap:9px;align-items:center;padding:9px 0;border-top:1px solid var(--border);cursor:pointer}
    .b2b-pickrow:first-child{border-top:none}
    .b2b-pickrow input[type=checkbox]{width:17px;height:17px;flex:none;accent-color:var(--accent)}
    .b2b-pickrow b{font-size:12.5px}
    .b2b-ic{width:30px;height:30px;flex:none;border-radius:9px;display:flex;align-items:center;justify-content:center;
      font-size:10.5px;font-weight:800;letter-spacing:.02em;background:var(--surface);border:1px solid var(--border);color:var(--accent)}
    .b2b-buybar{position:sticky;bottom:8px;z-index:5;box-shadow:0 -6px 22px rgba(0,0,0,.18)}
    .b2b-sellcard{margin-bottom:9px}
    .b2b-holdrow{text-decoration:none;color:var(--text)}
    .ih-tool-on{border-color:rgba(34,197,94,.4)}
    @media(max-width:420px){
      .b2b-balbar b{font-size:12.5px}
      .b2b-bigbtn{padding:13px 11px}.b2b-bigbtn b{font-size:17px}
      .b2b-quote{grid-template-columns:1fr 1fr}
    }
    `;
    document.head.appendChild(st);
  })();

  var tries = 0;
  (function boot() {
    if (ensureView()) {
      try {
        if (typeof ADMIN_NAV !== 'undefined' && !ADMIN_NAV.some(function (n) { return n.key === 'admin-invest-disputes'; })) {
          ADMIN_NAV.splice(Math.max(0, ADMIN_NAV.length - 2), 0, { key: 'admin-invest-disputes', label: 'Invest disputes', icon: 'shield', href: '#/admin/invest-disputes' });
          ADMIN_NAV.splice(Math.max(0, ADMIN_NAV.length - 2), 0, { key: 'admin-tools-pricing', label: 'Tool pricing', icon: 'settings', href: '#/admin/tools' });
          ADMIN_NAV.splice(Math.max(0, ADMIN_NAV.length - 2), 0, { key: 'admin-server-details', label: 'Server details', icon: 'shield', href: '#/admin/server-details' });
          ADMIN_NAV.splice(Math.max(0, ADMIN_NAV.length - 2), 0, { key: 'admin-b2b-inventory', label: 'B2B inventory', icon: 'box', href: '#/admin/b2b-inventory' });
        }
      } catch (e) {}
      try { [BOTTOM_NAV, USER_NAV, VENDOR_NAV].forEach(function(arr){ if(!Array.isArray(arr))return; arr.forEach(function(n){ if(n && n.key==='invest') n.href='#/investment'; }); }); } catch(e){}
      try { watchB2B(); paintB2BPrices(); } catch (e) {}
      setInterval(function () {
        try {
          var u = me(); if (!u) return; var a = account(u); var changed = false;
          (a.b2bAlerts || []).forEach(function (al) {
            var q = null; try { q = INV.quote(al.ticker); } catch (e) {}
            if (!q || !(q.price > 0)) return;
            if (al.buy > 0 && !al.buyHit && q.price <= al.buy) { al.buyHit = true; changed = true; if (!al.buyHitAt) al.buyHitAt = Date.now(); notifyH(u, 'Buy target reached', al.ticker + ' is ' + money(q.price) + ' — tap to buy now.', '#/investment/b2b/buy?asset=' + encodeURIComponent(al.ticker), 'trend'); }
            if (al.sell > 0 && !al.sellHit && q.price >= al.sell) { al.sellHit = true; changed = true; if (!al.sellHitAt) al.sellHitAt = Date.now(); notifyH(u, 'Sell target reached', al.ticker + ' is ' + money(q.price) + ' — tap to sell now.', '#/investment/b2b/sell?asset=' + encodeURIComponent(al.ticker), 'wallet'); }
          });
          if (changed) save();
        } catch (e) {}
      }, 10000);
      setTimeout(function(){ try { render(); } catch(e){} }, 300);
      if (typeof Remote === 'undefined' || !Remote.enabled) {
        try { if (typeof me === 'function' && me()) renewTools(me()); } catch (e) {}
        setInterval(function () { try { if (typeof me === 'function' && me()) renewTools(me()); } catch (e) {} }, 60000);
      }
      return;
    }
    if (tries++ < 40) setTimeout(boot, 500);
  })();
})();
