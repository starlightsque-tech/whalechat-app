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

  var DEFAULT_TOOLS = [
    { id: 'autosecure', name: 'Auto Secure Take Profit', price: 9.99, desc: 'Automatically secures available profit before it reverses.' },
    { id: 'botassist', name: 'Bot Assisted Trading', price: 19.99, desc: 'Bot monitors active trades and helps manage entries and exits.' },
    { id: 'riskguard', name: 'Risk Shield / Take Loss Guard', price: 7.99, desc: 'Adds an extra automatic loss guard to open positions.' },
    { id: 'signals', name: 'Pro Chart Signals', price: 4.99, desc: 'Live structure and momentum signals on the 24/7 chart.' }
  ];
  function toolCatalog() {
    try {
      if (!DB.settings) DB.settings = {};
      if (!Array.isArray(DB.settings.toolCatalog) || !DB.settings.toolCatalog.length) {
        DB.settings.toolCatalog = DEFAULT_TOOLS.map(function (t) { return Object.assign({}, t); });
      }
      return DB.settings.toolCatalog;
    } catch (e) { return DEFAULT_TOOLS; }
  }
  function toolById(id) { return toolCatalog().find(function (t) { return t.id === id; }); }
  function renewTools(u) {
    var a = account(u); var now = Date.now(); var changed = false;
    toolCatalog().forEach(function (t) {
      var s = a.tools[t.id]; if (!s) return;
      if (s.active && Number(s.expiresAt) <= now) {
        if ((Number(a.usd) || 0) >= Number(t.price)) {
          a.usd = Math.round((a.usd - Number(t.price)) * 100) / 100;
          s.expiresAt = now + 30 * 864e5; s.price = Number(t.price); s.reminded = false;
          ledger(u, 'Tool auto-renewal · ' + t.name, -Number(t.price), 0);
          notifyH(u, 'Tool renewed', t.name + ' renewed for another 30 days.', '#/investment/tools', 'shield');
        } else {
          s.active = false; s.expiredAt = now;
          notifyH(u, 'Tool expired', t.name + ' expired — insufficient investment balance to renew.', '#/investment/tools', 'warn');
        }
        changed = true;
      }
      if (s.active && Number(s.expiresAt) > now && Number(s.expiresAt) - now < 3 * 864e5 && !s.reminded) {
        s.reminded = true; changed = true;
        notifyH(u, 'Tool renewal reminder', t.name + ' renews in under 3 days. Keep enough investment balance.', '#/investment/tools', 'clock');
      }
    });
    if (changed) save();
  }
  function toolsPage(u) {
    var a = account(u);
    return head('Trading tools', 'Subscriptions are paid from your investment balance and renew monthly.', '#/investment') +
      '<div class="card"><div class="tiny muted">Investment balance: <b>' + money(a.usd) + '</b></div></div>' +
      '<div class="ih-tools">' + toolCatalog().map(function (t) {
        var s = a.tools[t.id] || null; var on = s && s.active && Number(s.expiresAt) > Date.now();
        return '<div class="ih-tool"><div class="between"><div><b>' + t.name + '</b><div class="tiny muted">' + t.desc + '</div></div><span class="badge ' + (on ? 'badge-success' : 'badge-warn') + '">' + (on ? 'ON' : 'OFF') + '</span></div>' +
          '<div class="ih-tool-foot"><b>' + money(t.price) + ' / month</b>' +
          '<div class="row" style="gap:6px">' + (on ? '<button class="btn btn-xs btn-ghost" data-act="ih-tool-toggle" data-tool="' + t.id + '">Turn off</button>' : '<button class="btn btn-xs btn-primary" data-act="ih-tool-sub" data-tool="' + t.id + '">Subscribe</button>') + '</div></div></div>';
      }).join('') + '</div>';
  }

  function b2bAssets() {
    try {
      var list = (INV.visibleStocks ? INV.visibleStocks() : INV.stocks());
      return list.filter(function (s) { return !/24\/7$/.test(s.name || '') || /Crypto|Stock|Indices/i.test(s.sector || ''); }).slice(0, 40);
    } catch (e) { return []; }
  }
  function b2bAssets() {
    try {
      var list = (INV.visibleStocks ? INV.visibleStocks() : INV.stocks());
      return list.slice(0, 40);
    } catch (e) { return []; }
  }
  function b2bQuote(t) { try { return INV.quote(t); } catch (e) { return null; } }
  function b2bLabel(s) { return (s && (s.displayTicker || s.name)) || s.ticker; }
  function b2bCategory(s) {
    var sec = String((s && s.sector) || '').toLowerCase();
    if (sec.indexOf('crypto') >= 0) return 'Crypto';
    if (sec.indexOf('forex') >= 0) return 'Forex';
    if (sec.indexOf('index') >= 0 || sec.indexOf('indices') >= 0) return 'Indices';
    return 'Stocks';
  }
  function b2bPath(ticker) {
    var vals = [];
    try { vals = INV.series(ticker, '1D') || []; } catch (e) {}
    if (!vals || vals.length < 2) return '';
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var spread = max - min || 1;
    return vals.map(function (v, i) { return ((i / (vals.length - 1)) * 300).toFixed(1) + ',' + (58 - ((v - min) / spread) * 52).toFixed(1); }).join(' ');
  }
  function b2bCard(s, a) {
    var q = b2bQuote(s.ticker) || {}; var fav = (a.b2bFav || []).indexOf(s.ticker) >= 0;
    return '<div class="b2b-card">' +
      '<div class="between"><a href="#/investment/b2b?asset=' + encodeURIComponent(s.ticker) + '" class="b2b-name">' + escH(b2bLabel(s)) + '</a>' +
      '<button class="b2b-star ' + (fav ? 'on' : '') + '" data-act="ih-b2b-fav" data-t="' + escH(s.ticker) + '">' + (fav ? '★' : '☆') + '</button></div>' +
      '<div class="tiny muted">' + escH(b2bCategory(s)) + '</div>' +
      '<div class="b2b-price" data-b2b-price="' + escH(s.ticker) + '">' + (q.price > 0 ? money(q.price) : '—') + '</div>' +
      '<div class="tiny ' + ((q.changePct || 0) >= 0 ? 'up' : 'down') + '">' + ((q.changePct || 0) >= 0 ? '+' : '') + (Number(q.changePct) || 0).toFixed(2) + '%</div>' +
      '<svg viewBox="0 0 300 60" class="b2b-spark"><polyline points="' + b2bPath(s.ticker) + '" fill="none" stroke="' + ((q.changePct || 0) >= 0 ? '#22c55e' : '#ef4444') + '" stroke-width="1.6"/></svg>' +
    '</div>';
  }
  function b2bPage(u, params) {
    var a = account(u); var assets = b2bAssets();
    if (b2bFilter !== 'All') assets = assets.filter(function (s) { return b2bCategory(s) === b2bFilter; });
    if (params && params.asset) {
      var asset = assets.find(function (s) { return s.ticker === String(params.asset).toUpperCase(); }) || (INV.stock ? INV.stock(String(params.asset).toUpperCase()) : null);
      if (asset) {
        var q = b2bQuote(asset.ticker) || {};
        var holding = a.b2b[asset.ticker];
        var alert = (a.b2bAlerts || []).find(function (x) { return x.ticker === asset.ticker; }) || {};
        return head(b2bLabel(asset), 'Live market data · B2B marketplace', '#/investment/b2b') +
          '<div class="ih-cards"><div class="ih-card"><span>Live price</span><b data-b2b-price="' + escH(asset.ticker) + '">' + (q.price > 0 ? money(q.price) : '—') + '</b><small class="' + ((q.changePct || 0) >= 0 ? 'up' : 'down') + '">' + ((q.changePct || 0) >= 0 ? '+' : '') + (Number(q.changePct) || 0).toFixed(2) + '% today</small></div>' +
            '<div class="ih-card"><span>Your holding</span><b>' + (holding ? Number(holding.units).toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' ' + b2bLabel(asset) : 'None') + '</b></div></div>' +
          '<div class="card"><svg viewBox="0 0 300 60" class="b2b-bigspark"><polyline id="b2bDetailPath" points="' + b2bPath(asset.ticker) + '" fill="none" stroke="' + ((q.changePct || 0) >= 0 ? '#22c55e' : '#ef4444') + '" stroke-width="1.8"/></svg></div>' +
          '<div class="card"><div class="card-title">Buy from company</div><div class="field"><label class="label">Amount (USD from B2B balance)</label><input class="input" id="ihB2bAmount" type="number" step="0.01" min="0" placeholder="0.00"/></div><button class="btn btn-primary" data-act="ih-b2b-buy" data-t="' + escH(asset.ticker) + '" style="width:100%">Buy now</button></div>' +
          (holding ? '<div class="card"><div class="card-title">Sell to company</div><button class="btn btn-danger" data-act="ih-b2b-sell" data-t="' + escH(asset.ticker) + '" style="width:100%">Sell all ' + Number(holding.units).toLocaleString(undefined, { maximumFractionDigits: 6 }) + '</button></div>' : '') +
          '<div class="card"><div class="card-title">Price alerts</div><div class="row" style="gap:8px"><div class="field grow"><label class="label">Buy below (USD)</label><input class="input" id="ihB2bBuyAlert" type="number" step="0.0001" value="' + (alert.buy || '') + '"/></div><div class="field grow"><label class="label">Sell above (USD)</label><input class="input" id="ihB2bSellAlert" type="number" step="0.0001" value="' + (alert.sell || '') + '"/></div></div><button class="btn btn-soft" data-act="ih-b2b-alert" data-t="' + escH(asset.ticker) + '" style="width:100%">Save alerts</button><div class="tiny muted mt6">We notify you in-app when the live price reaches either target.</div></div>';
      }
    }
    var holdings = Object.keys(a.b2b).map(function (t) {
      var h = a.b2b[t]; if (!h || !(Number(h.units) > 0)) return '';
      var q = b2bQuote(t) || {}; var p = q.price || h.avgPrice;
      return '<div class="ih-row"><div class="grow"><b>' + escH(t) + '</b><div class="tiny muted">' + Number(h.units).toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' units · entry ' + money(h.avgPrice) + '</div></div><div style="text-align:right"><b>' + money(h.units * p) + '</b><div class="tiny muted">' + wc(h.units * p / RATE) + ' WC</div></div><button class="btn btn-xs btn-danger" data-act="ih-b2b-sell" data-t="' + escH(t) + '">Sell</button></div>';
    }).join('');
    var alerts = (a.b2bAlerts || []).map(function (x) { return '<div class="ih-row"><span class="grow">' + escH(x.ticker) + '<div class="tiny muted">buy ≤ ' + money(x.buy || 0) + ' · sell ≥ ' + money(x.sell || 0) + '</div></span><button class="btn btn-xs btn-ghost" data-act="ih-b2b-alert-clear" data-t="' + escH(x.ticker) + '">Remove</button></div>'; }).join('');
    var cats = ['All','Crypto','Stocks','Indices','Forex'];
    return head('B2B-Investing', 'Buy and sell digital assets from the WhaleChat company contract.', '#/investment') +
      '<div class="ih-cards"><div class="ih-card"><span>Capital balance</span><b>' + money(a.portfolios.b2b) + '</b></div><div class="ih-card"><span>Total assets balance</span><b>' + money(Object.keys(a.b2b).reduce(function (sum, t) { var h = a.b2b[t]; var q = b2bQuote(t) || {}; return sum + (h.units || 0) * (q.price || h.avgPrice || 0); }, 0)) + '</b></div><div class="ih-card"><span>Profit balance</span><b class="' + ((a.b2bProfit || 0) >= 0 ? 'up' : 'down') + '">' + money(a.b2bProfit || 0) + '</b></div></div>' +
      '<div class="card ih-actions"><div class="ih-btn-grid"><a href="#/investment/b2b" class="btn btn-ghost btn-sm">Asset lists</a><a href="#/investment/b2b" class="btn btn-ghost btn-sm">Buy / Sell</a><a href="#/investment/transfer" class="btn btn-ghost btn-sm">Transfer</a><a href="#/investment/history" class="btn btn-ghost btn-sm">History</a></div></div>' +
      '<div class="row b2b-cats" style="gap:6px;flex-wrap:wrap;margin-bottom:8px">' + cats.map(function (c) { return '<button class="chip b2b-cat '+(b2bFilter===c?'on':'')+'" data-act="ih-b2b-cat" data-cat="'+c+'">' + c + '</button>'; }).join('') + '</div>' +
      '<div class="b2b-grid">' + assets.map(function (s) { return b2bCard(s, a); }).join('') + '</div>' +
      '<div class="card"><div class="card-title">Your assets</div>' + (holdings ? '<div class="ih-list">' + holdings + '</div>' : '<div class="tiny muted">No B2B holdings yet.</div>') + '</div>' +
      (alerts ? '<div class="card"><div class="card-title">Price alerts</div><div class="ih-list">' + alerts + '</div></div>' : '');
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
      if (sub === 'b2b') return b2bPage(u, params);
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
    App.ihToolSub = function (id, ds) {
      var u = me(); var a = account(u); var t = toolById(ds.tool); if (!t) return;
      if (a.usd < t.price) return toastH('Not enough investment balance', 'err');
      a.usd = Math.round((a.usd - t.price) * 100) / 100;
      a.tools[t.id] = { active: true, expiresAt: Date.now() + 30 * 864e5, price: t.price };
      ledger(u, 'Tool subscription · ' + t.name, -t.price, 0); save(); toastH(t.name + ' activated', 'ok'); render();
    };
    App.ihToolToggle = function (id, ds) {
      var u = me(); var a = account(u); var s = a.tools[ds.tool]; if (!s) return;
      s.active = !s.active; save(); render();
    };
    App.ihB2bBuy = function () {
      var u = me(); var a = account(u);
      var t = (id && ds && ds.t) ? ds.t : (document.getElementById('ihB2bAsset') || {}).value;
      var amount = Number((document.getElementById('ihB2bAmount') || {}).value || 0);
      var q = null; try { q = INV.quote(t); } catch (e) {}
      if (!t || !q || !(q.price > 0)) return toastH('Select a live asset', 'err');
      if (!(amount > 0)) return toastH('Enter an amount', 'err');
      if (a.portfolios.b2b < amount) return toastH('Top up B2B capital first', 'err');
      a.portfolios.b2b = Math.round((a.portfolios.b2b - amount) * 100) / 100;
      var usd = amount;
      var units = usd / q.price;
      var inv = (DB.settings.b2bInventory = DB.settings.b2bInventory || {});
      var avail = (Number(inv[t]) >= 0) ? Number(inv[t]) : 100000;
      if (units > avail) return toastH('Company contract does not have enough ' + t + ' available', 'err');
      inv[t] = Math.round((avail - units) * 1e8) / 1e8;
      var h = a.b2b[t] || { units: 0, avgPrice: q.price };
      h.avgPrice = ((h.units * h.avgPrice) + usd) / (h.units + units);
      h.units += units; a.b2b[t] = h;
      ledger(u, 'B2B buy ' + t, -amount, 0); save(); toastH('Bought ' + t, 'ok'); render();
    };
    App.ihB2bSell = function (id, ds) {
      var u = me(); var a = account(u); var h = a.b2b[ds.t]; if (!h) return;
      var q = null; try { q = INV.quote(ds.t); } catch (e) {}
      if (!q || !(q.price > 0)) return toastH('No live quote', 'err');
      var usd = h.units * q.price;
      var basis = h.units * h.avgPrice;
      a.b2bProfit = Math.round(((Number(a.b2bProfit) || 0) + (usd - basis)) * 100) / 100;
      a.portfolios.b2b = Math.round((a.portfolios.b2b + usd) * 100) / 100;
      var inv = (DB.settings.b2bInventory = DB.settings.b2bInventory || {});
      inv[ds.t] = Math.round(((Number(inv[ds.t]) >= 0 ? Number(inv[ds.t]) : 100000) + h.units) * 1e8) / 1e8;
      delete a.b2b[ds.t];
      ledger(u, 'B2B sell ' + ds.t, usd, 0); save(); toastH('Sold ' + ds.t, 'ok'); render();
    };
    App.ihB2bFav = function (id, ds) {
      var u = me(); var a = account(u); var i = a.b2bFav.indexOf(ds.t);
      if (i >= 0) a.b2bFav.splice(i, 1); else a.b2bFav.push(ds.t);
      save(); render();
    };
    App.ihB2bCat = function (id, ds) { b2bFilter = ds.cat || 'All'; render(); };
    App.ihB2bAlert = function (id, ds) {
      var u = me(); var a = account(u);
      var buy = Number((document.getElementById('ihB2bBuyAlert') || {}).value) || 0;
      var sell = Number((document.getElementById('ihB2bSellAlert') || {}).value) || 0;
      if (buy <= 0 && sell <= 0) return toastH('Enter a buy or sell target', 'err');
      var ex = a.b2bAlerts.find(function (x) { return x.ticker === ds.t; });
      if (ex) { ex.buy = buy; ex.sell = sell; ex.buyHit = false; ex.sellHit = false; }
      else a.b2bAlerts.push({ id: nowId('al_'), ticker: ds.t, buy: buy, sell: sell, buyHit: false, sellHit: false, createdAt: Date.now() });
      save(); toastH('Price alert saved', 'ok'); render();
    };
    App.ihB2bAlertClear = function (id, ds) {
      var u = me(); var a = account(u); a.b2bAlerts = a.b2bAlerts.filter(function (x) { return x.ticker !== ds.t; }); save(); render();
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
      setInterval(function () {
        try {
          var u = me(); if (!u) return; var a = account(u); var changed = false;
          (a.b2bAlerts || []).forEach(function (al) {
            var q = null; try { q = INV.quote(al.ticker); } catch (e) {}
            if (!q || !(q.price > 0)) return;
            if (al.buy > 0 && !al.buyHit && q.price <= al.buy) { al.buyHit = true; changed = true; notifyH(u, 'Buy target reached', al.ticker + ' is ' + money(q.price) + ' — tap to buy now.', '#/investment/b2b?asset=' + encodeURIComponent(al.ticker), 'trend'); }
            if (al.sell > 0 && !al.sellHit && q.price >= al.sell) { al.sellHit = true; changed = true; notifyH(u, 'Sell target reached', al.ticker + ' is ' + money(q.price) + ' — tap to sell now.', '#/investment/b2b?asset=' + encodeURIComponent(al.ticker), 'wallet'); }
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
