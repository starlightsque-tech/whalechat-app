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
  function escH(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function money(n) { return '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
  function wc(n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
  function nowId(p) { return (typeof uid === 'function') ? uid(p) : p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function save() { try { persist(); } catch (e) {} try { sync(); } catch (e) {} }
  function toastH(msg, type) { try { toast(msg, type || 'ok'); } catch (e) {} }
  function account(u) {
    if (!u.investAcct) {
      u.investAcct = {
        usd: 0, payout: 0,
        portfolios: { stock: 0, wc: 0, b2b: 0, bot: 0 },
        tools: {}, b2b: {}, disputes: [], requests: [], ledger: [], autoReinvest: false
      };
    }
    var a = u.investAcct;
    if (!a.portfolios) a.portfolios = { stock: 0, wc: 0, b2b: 0, bot: 0 };
    ['stock', 'wc', 'b2b', 'bot'].forEach(function (k) { if (!(Number(a.portfolios[k]) >= 0)) a.portfolios[k] = 0; });
    if (!a.tools) a.tools = {};
    if (!a.b2b) a.b2b = {};
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

  function quickActionsHTML() {
    var items = [
      ['download', 'Deposit', '#/deposit'], ['send', 'Withdraw', '#/withdraw'],
      ['trend', 'Transfer', '#/investment/transfer'], ['briefcase', 'Invest', '#/investment'],
      ['gift', 'Referrals', '#/referrals'], ['more', 'More', '#/investment/more']
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
        '<div class="ih-card"><span>WC balance</span><b>' + wc(u.balance) + ' WC</b><small>Main WhaleChat wallet</small></div>' +
      '</div>' +
      '<div class="card ih-actions"><div class="card-title" style="margin:0 0 8px">Investment account actions</div><div class="ih-btn-grid">' +
        [['Transfer', '#/investment/transfer'], ['Convert', '#/investment/transfer'], ['Stock Trading', '#/invest'], ['WC-Investing', '#/invest/shares'], ['B2B-Investing', '#/investment/b2b'], ['Tools', '#/investment/tools'], ['History', '#/investment/history'], ['More', '#/investment/more']]
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
  function b2bPage(u) {
    var a = account(u); var assets = b2bAssets();
    var holdings = Object.keys(a.b2b).map(function (t) { var h = a.b2b[t]; if (!h || !(h.units > 0)) return ''; var q = null; try { q = INV.quote(t); } catch (e) {} var p = q ? q.price : h.avgPrice; return '<div class="ih-row"><div class="grow"><b>' + escH(t) + '</b><div class="tiny muted">' + Number(h.units).toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' units · entry ' + money(h.avgPrice) + '</div></div><div style="text-align:right"><b>' + money(h.units * p) + '</b><div class="tiny muted">' + wc(h.units * p / RATE) + ' WC</div></div><button class="btn btn-xs btn-danger" data-act="ih-b2b-sell" data-t="' + escH(t) + '">Sell</button></div>'; }).join('');
    return head('B2B-Investing', 'Buy and sell 24/7 digital assets from your B2B portfolio balance.', '#/investment') +
      '<div class="ih-cards"><div class="ih-card"><span>B2B capital</span><b>' + money(a.portfolios.b2b) + '</b></div><div class="ih-card"><span>Holdings value</span><b>' + money(Object.keys(a.b2b).reduce(function (sum, t) { var h = a.b2b[t]; var q = null; try { q = INV.quote(t); } catch (e) {} return sum + (h.units || 0) * ((q && q.price) || h.avgPrice || 0); }, 0)) + '</b></div></div>' +
      '<div class="card"><div class="card-title">Buy asset</div><div class="field"><label class="label">Asset</label><select class="input" id="ihB2bAsset">' + assets.map(function (s) { return '<option value="' + escH(s.ticker) + '">' + escH(s.displayTicker || s.ticker) + ' — $' + (Number((INV.quote(s.ticker) || {}).price) || 0).toFixed(4) + '</option>'; }).join('') + '</select></div><div class="field"><label class="label">Amount (USD from B2B balance)</label><input class="input" id="ihB2bAmount" type="number" step="0.01" min="0" placeholder="0.00"/></div><button class="btn btn-primary" data-act="ih-b2b-buy" style="width:100%">Buy now</button></div>' +
      '<div class="card"><div class="card-title">Your assets</div>' + (holdings ? '<div class="ih-list">' + holdings + '</div>' : '<div class="empty" style="padding:18px"><p>No B2B holdings yet.</p></div>') + '</div>';
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

  function adminDisputes() {
    var rows = [];
    (DB.users || []).forEach(function (u) { account(u).disputes.forEach(function (d) { rows.push({ u: u, d: d }); }); });
    return head('Investment disputes', 'Review user investment and transaction disputes.', '#/admin') +
      '<div class="card"><div class="ih-list">' + (rows.length ? rows.map(function (x) {
        return '<div class="ih-row"><div class="grow"><b>@' + escH(x.u.username) + ' · ' + escH(x.d.type) + '</b><div class="tiny muted">' + escH(x.d.text) + '</div></div><select class="input" style="max-width:140px" onchange="App.ihAdminDispute(null,{uid:\'' + escH(x.u.id) + '\',id:\'' + escH(x.d.id) + '\'},event)"><option' + (x.d.status === 'pending' ? ' selected' : '') + '>pending</option><option' + (x.d.status === 'review' ? ' selected' : '') + '>review</option><option' + (x.d.status === 'processing' ? ' selected' : '') + '>processing</option><option' + (x.d.status === 'resolved' ? ' selected' : '') + '>resolved</option><option' + (x.d.status === 'declined' ? ' selected' : '') + '>declined</option></select></div>';
      }).join('') : '<div class="tiny muted">No disputes.</div>') + '</div></div>';
  }

  function ensureView() {
    if (typeof VIEWS === 'undefined') return false;
    if (VIEWS.__wcInvestHub) return true;
    VIEWS.investment = function (parts, params) {
      var u = me(); if (!u) return '';
      var sub = (parts && parts[1]) || '';
      if (sub === 'transfer') return transferPage(u);
      if (sub === 'topup') return topupPage(u, params);
      if (sub === 'tools') return toolsPage(u);
      if (sub === 'b2b') return b2bPage(u);
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
        if (html.indexOf('Quick navigation') >= 0) {
          html = html.replace('<div class="section-title mt22"><h3>Quick navigation</h3></div>', quickActionsHTML() + '<div class="section-title mt22"><h3>Quick navigation</h3></div>');
        }
      }
      return html;
    };
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
      var t = (document.getElementById('ihB2bAsset') || {}).value;
      var amount = Number((document.getElementById('ihB2bAmount') || {}).value || 0);
      var q = null; try { q = INV.quote(t); } catch (e) {}
      if (!t || !q || !(q.price > 0)) return toastH('Select a live asset', 'err');
      if (!(amount > 0)) return toastH('Enter an amount', 'err');
      if (a.portfolios.b2b < amount) return toastH('Top up B2B capital first', 'err');
      a.portfolios.b2b = Math.round((a.portfolios.b2b - amount) * 100) / 100;
      var usd = amount;
      var units = usd / q.price;
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
      a.portfolios.b2b = Math.round((a.portfolios.b2b + usd) * 100) / 100;
      delete a.b2b[ds.t];
      ledger(u, 'B2B sell ' + ds.t, usd, 0); save(); toastH('Sold ' + ds.t, 'ok'); render();
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
        }
      } catch (e) {}
      try { [BOTTOM_NAV, USER_NAV, VENDOR_NAV].forEach(function(arr){ if(!Array.isArray(arr))return; arr.forEach(function(n){ if(n && n.key==='invest') n.href='#/investment'; }); }); } catch(e){}
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
