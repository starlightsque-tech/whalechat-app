/* =============================================================================
   WhaleChat Service Center  (service-center.js)
   -----------------------------------------------------------------------------
   User side  (#/investment/...):
     more                       - More hub: loan, card, FAQ, transaction dispute
     loan | card                - loan / business card request forms + history
     faq                        - searchable FAQ with live-chat support buttons
     disputes                   - dispute centre (types + free text + my disputes)
     disputes/tx|withdrawal|deposit|reversal|account
     account/delete|upgrade|vendor|statement
     sr/<id>                    - one request: status, timeline, payment step
   Admin side (#/admin/...):
     help-desk                  - every queue in the app + user lookup
     requests[/<id>]            - process every service request
     user-360/<userId>          - full user view with quick fixes
     service-settings           - booking fee, agent link, pay methods, loan/card, FAQ
   Data: DB.serviceRequests (synced collection). Settings: DB.settings.serviceCenter
   ========================================================================== */
(function () {
  'use strict';
  if (window.WC_SC) return;
  var SC = window.WC_SC = {};
  var BOOT_AT = Date.now();
  var S = { sel: null, selKind: null, delVerified: false, delCode: '', vendor: {}, rev: {} };

  /* ------------------------------------------------------------ helpers */
  function E(s) { try { return esc(s); } catch (e) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); } }
  function I(n, s) { try { return ic(n, s || 16); } catch (e) { return ''; } }
  function M(n) { return '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
  function R2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function rate() { try { return Number(COIN_USD) || 0.5; } catch (e) { return 0.5; } }
  function nid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function save() { try { sync(); } catch (e) { try { persist(); } catch (e2) {} } }
  function T(msg, type) { try { toast(msg, type || 'ok'); } catch (e) {} }
  function dt(t) { return t ? new Date(t).toLocaleString() : '—'; }
  function d(t) { return t ? new Date(t).toLocaleDateString() : '—'; }
  function isAdmin() { var u = me(); return !!(u && u.role === 'admin'); }
  function user(id) { return (DB.users || []).find(function (x) { return x.id === id; }) || null; }
  try { if (typeof SYNC_COLLECTIONS !== 'undefined' && SYNC_COLLECTIONS.indexOf('serviceRequests') < 0) SYNC_COLLECTIONS.push('serviceRequests'); } catch (e) {}
  function list() { if (!Array.isArray(DB.serviceRequests)) DB.serviceRequests = []; return DB.serviceRequests; }
  function req(id) { return list().find(function (r) { return r.id === id; }) || null; }
  function mine(u) { return list().filter(function (r) { return r.userId === u.id; }).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }); }
  function api(p) { try { if (typeof Remote !== 'undefined' && Remote.url) return Remote.url(p); } catch (e) {} return p; }
  function val(id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
  function ia(u) {
    try { if (typeof INV !== 'undefined' && INV.investAcct) return INV.investAcct(u); } catch (e) {}
    u.investAcct = u.investAcct || {}; u.investAcct.portfolios = u.investAcct.portfolios || {}; return u.investAcct;
  }
  function head(title, sub, back) {
    return '<div class="page-head"><div class="row" style="gap:10px;align-items:center">' +
      (back ? '<a href="' + back + '" class="btn-icon">' + I('back', 18) + '</a>' : '') +
      '<div><h1 style="margin:0">' + E(title) + '</h1>' + (sub ? '<p class="muted" style="margin:2px 0 0">' + E(sub) + '</p>' : '') + '</div></div></div>';
  }
  function supportBtn(label) { return '<button class="btn btn-primary btn-sm" data-act="sc-live">' + I('chat', 14) + ' ' + E(label || 'Live chat support') + '</button>'; }
  function adminNotify(title, body, id) { try { notify('usr_admin', title, body, '#/admin/requests/' + id, 'shield'); } catch (e) {} }
  function userNotify(r, title, body) { try { notify(r.userId, title, body, '#/investment/sr/' + r.id, 'shield'); } catch (e) {} }

  /* ------------------------------------------------------------ settings */
  var DEF = {
    bookingFeePct: 5,
    agentLink: '',
    agentLabel: 'Connect with a coin reversal agent',
    payMethods: [],
    loan: { minUsd: 100, maxUsd: 50000, interestPct: 5, terms: [1, 3, 6, 12], note: 'Loans are reviewed individually. Approved loans are credited to your investment account balance.' },
    card: { physicalFeeUsd: 0, virtualFeeUsd: 0, note: 'Use your WhaleChat business card for online payments, ATM withdrawals and fast everyday card payments.' },
    faq: { overrides: {}, extra: [] }
  };
  function cfg() {
    var c = (DB.settings && DB.settings.serviceCenter) || {};
    var out = Object.assign({}, DEF, c);
    out.loan = Object.assign({}, DEF.loan, c.loan || {});
    out.card = Object.assign({}, DEF.card, c.card || {});
    out.faq = Object.assign({ overrides: {}, extra: [] }, c.faq || {});
    return out;
  }
  function payMethods() {
    var c = cfg();
    if (Array.isArray(c.payMethods) && c.payMethods.length) return c.payMethods;
    try { var p = (DB.settings.vendorPayments || {}).methods; if (Array.isArray(p)) return p; } catch (e) {}
    return [];
  }
  function vendorMethods() { try { var p = (DB.settings.vendorPayments || {}).methods; return Array.isArray(p) ? p : []; } catch (e) { return []; } }
  function vendorPlans() { try { return (DB.settings.vendorPlans || []).slice().sort(function (a, b) { return a.months - b.months; }); } catch (e) { return []; } }

  /* ------------------------------------------------------------ types and statuses */
  var DECLINE = {
    dispute_tx: 'Sorry, your dispute for the selected transaction was declined by admin. Kindly reach out to the customer support team for assistance or try again!',
    dispute_withdrawal: 'Sorry, your withdrawal dispute was declined by admin. Please kindly connect with the customer support team on a live chat for further assistance — click Live chat! Or try again?',
    dispute_deposit: 'Sorry, your deposit dispute was declined by admin. Kindly connect with the customer support team on a live chat for further assistance — click Live chat! Or try again?',
    dispute_reversal: 'Sorry, your request for asset reversal dispute was declined by admin. Please kindly reach out to our customer support team for further assistance — click Live chat! Or try again?'
  };
  var TYPES = {
    dispute_tx: { label: 'Transaction dispute', icon: 'refresh', retry: '#/investment/disputes/tx' },
    dispute_withdrawal: { label: 'Withdrawal issue', icon: 'send', retry: '#/investment/disputes/withdrawal' },
    dispute_deposit: { label: 'Deposit issue', icon: 'download', retry: '#/investment/disputes/deposit' },
    dispute_reversal: { label: 'Asset reversal dispute', icon: 'refresh', retry: '#/investment/disputes/reversal' },
    dispute_custom: { label: 'Other request / issue', icon: 'help', retry: '#/investment/disputes' },
    account_delete: { label: 'Delete account', icon: 'trash', retry: '#/investment/account/delete' },
    account_upgrade: { label: 'Upgrade account to latest version', icon: 'refresh', retry: '#/investment/account/upgrade' },
    account_vendor: { label: 'Upgrade to vendor profile', icon: 'store', retry: '#/investment/account/vendor' },
    account_statement: { label: 'Official account statement', icon: 'clip', retry: '#/investment/account/statement' },
    loan: { label: 'Loan request', icon: 'wallet', retry: '#/investment/loan' },
    card: { label: 'WhaleChat business card', icon: 'wallet', retry: '#/investment/card' }
  };
  function typeLabel(t) { return (TYPES[t] && TYPES[t].label) || t; }
  function isDispute(r) { return /^dispute_/.test(r.type); }

  /* status -> {label, tone, msg}. tone: warn | info | ok | bad */
  function statusInfo(r) {
    var s = r.status, disp = isDispute(r);
    var generic = {
      pending: ['Pending', 'warn', (disp ? 'Your dispute' : 'Your request') + ' was submitted and the admin has been notified. Our team will review it and get back to you via your registered email or the in-app support chat within 24–48hrs.'],
      seen: ['Seen', 'info', 'Seen — the admin has viewed your ' + (disp ? 'dispute' : 'request') + '.'],
      review: ['Under review', 'info', (disp ? 'Dispute' : 'Request') + ' is under review by admin — wait for 24–48hrs for results.'],
      processing: ['Processing', 'ok', 'Processing now — kindly wait patiently for feedback on the ' + (disp ? 'dispute' : 'request') + ' results. Thanks!'],
      resolved: ['Resolved', 'ok', 'Congratulations 🎉 your dispute has been processed and issue has been settled successfully. Thanks for your co-operation!'],
      approved: ['Approved', 'ok', 'Congratulations 🎉 your request has been approved.'],
      declined: ['Declined', 'bad', DECLINE[r.type] || 'Sorry, your request was declined by admin. Kindly reach out to the customer support team for assistance or try again!']
    };
    if (r.type === 'dispute_deposit' && s === 'resolved') return { label: 'Approved', tone: 'ok', msg: 'Congratulations 🎉 your deposit dispute was approved — the issue has been settled successfully. Thanks for your co-operation!' };
    if (r.type === 'dispute_withdrawal' && s === 'resolved') return { label: 'Solved', tone: 'ok', msg: 'Congratulations 🎉 your withdrawal dispute has been processed and completed successfully. Thanks for your co-operation!' };
    if (r.type === 'dispute_reversal' || r.type === 'account_vendor') {
      var pay = {
        awaiting_payment: ['Awaiting payment', 'warn', 'Complete your payment, then upload the payment slip and submit.'],
        payment_rejected: ['Payment slip rejected', 'bad', 'Your payment slip could not be confirmed' + (r.adminNote ? ': ' + r.adminNote : '') + '. Upload a clear payment slip and submit again.'],
        payment_submitted: ['Payment under review', 'info', 'Payment slip submitted — the admin is confirming your payment. You will be notified once it is approved.']
      };
      if (pay[s]) return { label: pay[s][0], tone: pay[s][1], msg: pay[s][2] };
      if (r.type === 'dispute_reversal') {
        if (s === 'payment_approved') return { label: 'Payment approved', tone: 'ok', msg: 'Your payment has been successfully approved. Tap the button below to connect with a coin reversal agent.' };
        if (s === 'processing') return { label: 'Processing', tone: 'ok', msg: 'You are connected with a coin reversal agent — your asset reversal is processing now. Kindly wait patiently for feedback.' };
        if (s === 'completed') return { label: 'Completed', tone: 'ok', msg: 'Asset reversed successfully and sent to your WhaleChat account balance. 🎉' };
      }
      if (r.type === 'account_vendor' && s === 'approved') return { label: 'Approved', tone: 'ok', msg: 'Congratulations 🎉 your account was upgraded to a vendor profile. Open your vendor dashboard to start selling.' };
    }
    if (r.type === 'account_delete' && s === 'approved') return { label: 'Approved', tone: 'ok', msg: 'Your account deletion request was approved and the account has been deleted.' };
    if (r.type === 'account_upgrade' && s === 'approved') return { label: 'Upgraded', tone: 'ok', msg: 'Congratulations 🎉 your account has been upgraded to the latest version of WhaleChat' + (r.version ? ' (v' + r.version + ')' : '') + '.' };
    if (r.type === 'account_statement' && s === 'resolved') return { label: 'Sent', tone: 'ok', msg: 'Your official account statement has been issued' + (r.adminNote ? ': ' + r.adminNote : '. Check your registered email or the in-app support chat.') };
    if (r.type === 'loan' && s === 'approved') return { label: 'Approved', tone: 'ok', msg: 'Congratulations 🎉 your loan was approved' + (r.disbursedUsd ? ' and ' + M(r.disbursedUsd) + ' was credited to your investment account balance' : '') + '.' };
    if (r.type === 'card' && s === 'approved') return { label: 'Card issued', tone: 'ok', msg: 'Congratulations 🎉 your WhaleChat business card has been issued.' };
    var g = generic[s] || [s, 'info', ''];
    return { label: g[0], tone: g[1], msg: g[2] };
  }
  function badge(r) { var s = statusInfo(r); return '<span class="sc-chip sc-' + s.tone + '">' + E(s.label) + '</span>'; }
  function statusBox(r) {
    var s = statusInfo(r);
    var html = '<div class="sc-status sc-' + s.tone + '"><div class="sc-status-l">' + E(s.label) + (r.seenAt && r.status !== 'pending' ? '' : '') + '</div><div>' + E(s.msg) + '</div>';
    if (r.adminNote && !/payment_rejected|resolved/.test(r.status)) html += '<div class="tiny mt6"><b>Note from admin:</b> ' + E(r.adminNote) + '</div>';
    html += '</div>';
    if (r.status === 'declined') {
      html += '<div class="row gap8 mt10" style="flex-wrap:wrap">' + supportBtn('Live chat') +
        '<a class="btn btn-ghost btn-sm" href="' + ((TYPES[r.type] && TYPES[r.type].retry) || '#/investment/disputes') + '">' + I('refresh', 14) + ' Try again</a></div>';
    }
    return html;
  }
  function setStatus(r, status, note) {
    r.status = status; r.updatedAt = Date.now();
    r.log = r.log || [];
    r.log.push({ at: Date.now(), status: status, by: (me() || {}).username || 'system', note: note || '' });
  }
  function newReq(u, type, data) {
    var r = Object.assign({ id: nid('sr_'), type: type, userId: u.id, username: u.username, email: u.email || '', status: 'pending', createdAt: Date.now(), updatedAt: Date.now(), log: [] }, data || {});
    r.log.push({ at: Date.now(), status: r.status, by: u.username, note: 'Submitted' });
    list().unshift(r);
    return r;
  }

  /* ------------------------------------------------------------ user transaction history */
  function transfersFor(u) {
    var out = [];
    (u.acctLedger || []).forEach(function (x) {
      if (x && x.meta && x.meta.toUser) {
        var o = user(x.meta.toUser);
        out.push({ key: 'tr:' + x.id, kind: 'Transfer sent', id: x.id, usd: Math.abs(Number(x.usd) || 0), status: 'completed', at: x.at, detail: 'To ' + (o ? '@' + o.username + ' · ' + (o.accountId || o.referralCode || '') : 'another user') });
      }
    });
    (DB.users || []).forEach(function (o) {
      if (o.id === u.id) return;
      (o.acctLedger || []).forEach(function (x) {
        if (x && x.meta && x.meta.toUser === u.id) out.push({ key: 'tr:' + x.id, kind: 'Transfer received', id: x.id, usd: Math.abs(Number(x.usd) || 0), status: 'completed', at: x.at, detail: 'From @' + o.username });
      });
    });
    (DB.txs || []).forEach(function (t) {
      if (t.userId === u.id && /^(transfer|send|sent|receive|received|p2p)$/i.test(String(t.type || ''))) {
        out.push({ key: 'tx:' + t.id, kind: Number(t.coins) < 0 ? 'Transfer sent' : 'Transfer received', id: t.id, usd: Math.abs(Number(t.coins) || 0) * rate(), coins: Math.abs(Number(t.coins) || 0), status: 'completed', at: t.createdAt, detail: t.label || '' });
      }
    });
    return out;
  }
  function wdMethod(w) { return String(w.coin || w.crypto || (String(w.network || '').match(/USDT|BTC|ETH|BNB|TRX|SOL|LTC|USDC/i) || ['USDT'])[0]).toUpperCase(); }
  function depRows(u, filter) {
    return (DB.deposits || []).filter(function (x) { return x.userId === u.id && (!filter || filter(x)); }).map(function (x) {
      return { key: 'dep:' + x.id, kind: 'Deposit', id: x.id, usd: Number(x.usd) || (Number(x.coins) || 0) * rate(), coins: x.coins, status: x.status, at: x.createdAt, detail: (x.methodName || x.method || x.coin || 'Deposit') + (x.note ? ' · ' + x.note : '') };
    });
  }
  function wdRows(u, filter) {
    return (DB.withdrawals || []).filter(function (x) { return x.userId === u.id && (!filter || filter(x)); }).map(function (x) {
      return { key: 'wd:' + x.id, kind: 'Withdrawal', id: x.id, usd: Number(x.usd) || (Number(x.coins) || 0) * rate(), coins: x.coins, status: x.status, at: x.createdAt, detail: wdMethod(x) + ' · ' + (x.network || '') + ' · ' + String(x.address || '').slice(0, 14) + (String(x.address || '').length > 14 ? '…' : ''), network: x.network, address: x.address, method: wdMethod(x) };
    });
  }
  function allTx(u) { return depRows(u).concat(wdRows(u)).concat(transfersFor(u)).sort(function (a, b) { return (b.at || 0) - (a.at || 0); }); }
  function txStatus(s) {
    var m = { pending: 'sc-warn', approved: 'sc-ok', completed: 'sc-ok', rejected: 'sc-bad', declined: 'sc-bad', failed: 'sc-bad', cancelled: 'sc-bad' };
    var l = { rejected: 'Declined' };
    return '<span class="sc-chip ' + (m[s] || 'sc-info') + '">' + E(l[s] || (String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1))) + '</span>';
  }
  function txList(rows, kind, emptyText) {
    if (!rows.length) return '<div class="empty" style="padding:22px"><p>' + E(emptyText) + '</p></div>';
    return '<div class="sc-txlist">' + rows.map(function (x) {
      return '<div class="sc-tx" data-act="sc-pick" data-key="' + E(x.key) + '" data-kind="' + kind + '">' +
        '<div class="sc-radio"></div><div class="grow"><b>' + E(x.kind) + ' · ' + M(x.usd) + '</b>' +
        '<div class="tiny muted">' + E(dt(x.at)) + ' · ' + E(x.detail || '') + '</div><div class="tiny muted">Ref: ' + E(x.id) + '</div></div>' + txStatus(x.status) + '</div>';
    }).join('') + '</div>';
  }
  function findTx(u, key) { return allTx(u).find(function (x) { return x.key === key; }) || null; }

  /* ------------------------------------------------------------ user pages */
  function moreHub(u) {
    var open = mine(u).filter(function (r) { return !/resolved|approved|completed|declined/.test(r.status); }).length;
    var tiles = [
      ['wallet', 'Request a loan', 'Apply for a WhaleChat loan and track approval.', '#/investment/loan'],
      ['tag', 'WhaleChat business card', 'Physical or virtual card for online payments, ATM banking and swift card payments.', '#/investment/card'],
      ['help', 'FAQ & guides', 'Detailed guides for trading, investing, vendors, deposits, withdrawals and more.', '#/investment/faq'],
      ['shield', 'Transaction dispute', 'Disputes for transactions, account, withdrawals, deposits and asset reversals.', '#/investment/disputes']
    ];
    return head('More', 'Loans, cards, help and disputes.', '#/investment') +
      '<div class="sc-tiles">' + tiles.map(function (t) {
        return '<a class="sc-tile" href="' + t[3] + '"><span class="sc-tile-ic">' + I(t[0], 22) + '</span><b>' + E(t[1]) + '</b><span class="tiny muted">' + E(t[2]) + '</span></a>';
      }).join('') + '</div>' +
      '<div class="card"><div class="between"><div class="card-title" style="margin:0">My requests &amp; disputes</div><span class="tiny muted">' + open + ' open</span></div>' + myReqList(mine(u).slice(0, 12)) + '</div>' +
      '<div class="card"><div class="row gap8" style="flex-wrap:wrap"><a class="btn btn-ghost btn-sm" href="#/investment/account/statement">' + I('clip', 14) + ' Account statement</a>' +
      '<a class="btn btn-ghost btn-sm" href="#/investment/history">' + I('clock', 14) + ' Investment history</a>' + supportBtn('Live chat support') + '</div></div>';
  }
  function myReqList(rows) {
    if (!rows.length) return '<div class="tiny muted" style="padding:10px 0">Nothing submitted yet.</div>';
    return '<div class="sc-list">' + rows.map(function (r) {
      return '<a class="sc-row" href="#/investment/sr/' + r.id + '"><span class="sc-row-ic">' + I((TYPES[r.type] || {}).icon || 'shield', 15) + '</span><div class="grow"><b>' + E(typeLabel(r.type)) + '</b><div class="tiny muted">' + E(dt(r.createdAt)) + (r.summary ? ' · ' + E(String(r.summary).slice(0, 60)) : '') + '</div></div>' + badge(r) + '</a>';
    }).join('') + '</div>';
  }

  function loanPage(u) {
    var c = cfg().loan;
    var rows = mine(u).filter(function (r) { return r.type === 'loan'; });
    return head('Request a loan', 'Fill in the details and submit. The admin reviews every request.', '#/investment/more') +
      '<div class="card">' +
        '<div class="field"><label class="label">Loan amount (USD) · ' + M(c.minUsd) + ' – ' + M(c.maxUsd) + '</label><input class="input" id="scLoanAmt" type="number" inputmode="decimal" placeholder="e.g. 1000"/></div>' +
        '<div class="field"><label class="label">Repayment term</label><select class="input" id="scLoanTerm">' + (c.terms || []).map(function (m) { return '<option value="' + m + '">' + m + ' month' + (m > 1 ? 's' : '') + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label class="label">Purpose of the loan</label><select class="input" id="scLoanPurpose"><option>Trading capital</option><option>Business / vendor stock</option><option>Personal</option><option>Education</option><option>Emergency</option><option>Other</option></select></div>' +
        '<div class="field"><label class="label">Monthly income / source of repayment</label><input class="input" id="scLoanIncome" placeholder="e.g. $2,500 salary, trading profits"/></div>' +
        '<div class="field"><label class="label">Extra details (optional)</label><textarea class="input" id="scLoanNote" rows="3" placeholder="Anything that helps us review your request"></textarea></div>' +
        '<div class="sc-calc" id="scLoanCalc">Interest rate: <b>' + E(c.interestPct) + '%</b> per term. Enter an amount to see the estimated repayment.</div>' +
        '<p class="tiny muted">' + E(c.note) + '</p>' +
        '<button class="btn btn-primary" data-act="sc-loan-submit" style="width:100%">Submit loan request</button></div>' +
      '<div class="card"><div class="card-title">My loan requests</div>' + myReqList(rows) + '</div>';
  }
  function cardPage(u) {
    var c = cfg().card;
    var rows = mine(u).filter(function (r) { return r.type === 'card'; });
    return head('WhaleChat business card', 'Physical or virtual online banking card.', '#/investment/more') +
      '<div class="card sc-cardpromo"><div class="sc-cardart"><div class="tiny">WhaleChat Business</div><div class="sc-cardnum">•••• •••• •••• ••••</div><div class="row between"><span>' + E((u.fullName || u.username || '').toUpperCase()) + '</span><span>VISA</span></div></div>' +
        '<p class="tiny muted mt10">' + E(c.note) + '</p></div>' +
      '<div class="card">' +
        '<div class="field"><label class="label">Card type</label><select class="input" id="scCardType"><option value="virtual">Virtual card — online payments' + (c.virtualFeeUsd ? ' (' + M(c.virtualFeeUsd) + ')' : '') + '</option><option value="physical">Physical card — online + ATM + POS' + (c.physicalFeeUsd ? ' (' + M(c.physicalFeeUsd) + ')' : '') + '</option><option value="both">Both virtual + physical</option></select></div>' +
        '<div class="field"><label class="label">Name on card</label><input class="input" id="scCardName" value="' + E(u.fullName || '') + '"/></div>' +
        '<div class="field"><label class="label">Phone number</label><input class="input" id="scCardPhone" value="' + E(u.phone || '') + '"/></div>' +
        '<div class="field" id="scCardAddrWrap"><label class="label">Delivery address (physical card)</label><textarea class="input" id="scCardAddr" rows="2" placeholder="Street, city, state, ZIP, country"></textarea></div>' +
        '<div class="field"><label class="label">Main use</label><select class="input" id="scCardUse"><option>Online shopping &amp; subscriptions</option><option>ATM cash withdrawals</option><option>Business payments</option><option>Travel</option><option>All of the above</option></select></div>' +
        '<div class="field"><label class="label">Expected monthly spending (USD)</label><input class="input" id="scCardSpend" type="number" inputmode="decimal" placeholder="e.g. 500"/></div>' +
        '<button class="btn btn-primary" data-act="sc-card-submit" style="width:100%">Submit card request</button></div>' +
      '<div class="card"><div class="card-title">My card requests</div>' + myReqList(rows) + '</div>';
  }

  function disputesHub(u) {
    var types = [
      ['refresh', 'Transaction dispute', 'Any deposit, withdrawal or user-to-user transfer since you joined.', '#/investment/disputes/tx'],
      ['user', 'Account issues', 'Delete account, upgrade version, vendor profile, account statement.', '#/investment/disputes/account'],
      ['send', 'Withdrawal issues', 'Pending, declined or failed withdrawals.', '#/investment/disputes/withdrawal'],
      ['download', 'Deposit issues', 'Pending, failed or declined deposits.', '#/investment/disputes/deposit'],
      ['refresh', 'Asset reversal dispute', 'Reverse a successful withdrawal back to your WhaleChat balance.', '#/investment/disputes/reversal']
    ];
    var rows = mine(u).filter(isDispute);
    return head('Transaction dispute', 'Choose the type of dispute you want to submit.', '#/investment/more') +
      '<div class="sc-list card">' + types.map(function (t) {
        return '<a class="sc-row" href="' + t[3] + '"><span class="sc-row-ic">' + I(t[0], 16) + '</span><div class="grow"><b>' + E(t[1]) + '</b><div class="tiny muted">' + E(t[2]) + '</div></div>' + I('chevron', 16) + '</a>';
      }).join('') + '</div>' +
      '<div class="card"><div class="card-title">Something different?</div>' +
        '<p class="small muted" style="line-height:1.6">Do you want to request something different? Please kindly type in the textbox and describe your request or issue, then click Submit to send your dispute. Our team will review your dispute and get back to you via your registered email or via the in-app support chat within 24–48hrs.</p>' +
        '<textarea class="input" id="scCustomText" rows="4" placeholder="Describe your request or issue…"></textarea>' +
        '<button class="btn btn-primary mt10" data-act="sc-custom-submit" style="width:100%">Submit</button></div>' +
      '<div class="card"><div class="card-title">My disputes</div>' + myReqList(rows) + '</div>';
  }
  function describeForm(kind, btn) {
    return '<div class="card sc-desc" id="scDescBox" style="display:none"><div class="card-title">Describe the issue</div>' +
      '<div class="tiny muted mb10" id="scSelInfo"></div>' +
      '<textarea class="input" id="scDescText" rows="4" placeholder="Tell us what went wrong with this transaction…"></textarea>' +
      '<button class="btn btn-primary mt10" data-act="sc-dispute-submit" data-kind="' + kind + '" style="width:100%">' + E(btn || 'Submit dispute') + '</button></div>';
  }
  function txDisputePage(u) {
    var rows = allTx(u);
    return head('Transaction dispute', 'All deposits, withdrawals and user-to-user transfers since ' + d(u.createdAt) + '.', '#/investment/disputes') +
      '<div class="card"><div class="tiny muted mb10">Select the transaction you want to dispute (' + rows.length + ' found).</div>' + txList(rows, 'dispute_tx', 'No transactions found on your account yet.') + '</div>' +
      describeForm('dispute_tx') +
      '<div class="card"><div class="card-title">My transaction disputes</div>' + myReqList(mine(u).filter(function (r) { return r.type === 'dispute_tx'; })) + '</div>';
  }
  function wdDisputePage(u) {
    var rows = wdRows(u, function (w) { return /pending|rejected|declined|failed|cancelled/.test(w.status); }).sort(function (a, b) { return b.at - a.at; });
    return head('Withdrawal issues', 'Pending, declined or failed withdrawals since you joined.', '#/investment/disputes') +
      '<div class="card">' + txList(rows, 'dispute_withdrawal', 'You have no pending, declined or failed withdrawals.') + '</div>' +
      describeForm('dispute_withdrawal', 'Submit withdrawal dispute') +
      '<div class="card"><div class="card-title">My withdrawal disputes</div>' + myReqList(mine(u).filter(function (r) { return r.type === 'dispute_withdrawal'; })) + '</div>';
  }
  function depDisputePage(u) {
    var rows = depRows(u, function (x) { return /pending|rejected|declined|failed|cancelled/.test(x.status); }).sort(function (a, b) { return b.at - a.at; });
    return head('Deposit issues', 'Pending, failed or declined deposits since you joined.', '#/investment/disputes') +
      '<div class="card">' + txList(rows, 'dispute_deposit', 'You have no pending, failed or declined deposits.') + '</div>' +
      describeForm('dispute_deposit', 'Submit deposit dispute') +
      '<div class="card"><div class="card-title">My deposit disputes</div>' + myReqList(mine(u).filter(function (r) { return r.type === 'dispute_deposit'; })) + '</div>';
  }
  function methodPicker(methods, name) {
    if (!methods.length) return '<div class="tiny muted">No payment method has been configured yet. Please contact support.</div>';
    return '<div class="sc-methods">' + methods.map(function (m, i) {
      return '<div class="sc-method' + (i === 0 ? ' on' : '') + '" data-act="sc-method" data-group="' + name + '" data-id="' + E(m.id || String(i)) + '">' +
        '<div class="sc-radio"></div><div class="grow"><b>' + E(m.label || m.name || 'Method') + '</b><div class="tiny muted">' + E(m.network || '') + '</div><div class="tiny sc-addr">' + E(m.address || '') + '</div></div>' +
        '<button class="btn btn-ghost btn-xs" data-act="sc-copy" data-text="' + E(m.address || '') + '">' + I('copy', 13) + ' Copy address</button></div>';
    }).join('') + '</div>';
  }
  function reversalPage(u) {
    var rows = wdRows(u, function (w) { return w.status === 'approved'; }).sort(function (a, b) { return b.at - a.at; });
    var pct = Number(cfg().bookingFeePct) || 5;
    return head('Asset reversal dispute', 'Reverse a successful withdrawal back to your WhaleChat account.', '#/investment/disputes') +
      '<div class="card"><div class="tiny muted mb10">Select the successful withdrawal you want reversed.</div>' + txList(rows, 'dispute_reversal', 'You have no successful withdrawals yet.') + '</div>' +
      '<div class="card" id="scRevBox" style="display:none"><div class="card-title">Withdrawal details</div><div id="scRevAuto" class="sc-kv"></div>' +
        '<div class="field mt10"><label class="label">Reversal amount (USD)</label><input class="input" id="scRevAmt" type="number" inputmode="decimal" placeholder="Amount to reverse"/></div>' +
        '<div class="sc-calc" id="scRevFee">Booking fee = ' + pct + '% × reversal amount.</div>' +
        '<div class="sc-note"><b>Why a booking fee?</b> The booking fee reserves an available coin reversal agent for your case. Once your payment is confirmed you are connected automatically with an agent who traces the transaction and performs the coin reversal, sending your assets back to your WhaleChat account balance.</div>' +
        '<div class="field mt10"><label class="label">Explain what happened (optional)</label><textarea class="input" id="scRevText" rows="3" placeholder="e.g. sent to a wrong address, scam, unauthorised withdrawal…"></textarea></div>' +
        '<div class="card-title mt10">Select a payment method</div>' + methodPicker(payMethods(), 'rev') +
        '<button class="btn btn-primary mt10" data-act="sc-rev-start" style="width:100%">I\'ll pay now</button>' +
        '<p class="tiny muted mt6">After sending the fee, come back and upload your payment slip. If you leave the app, a “Complete pending payment” reminder brings you back to this step.</p></div>' +
      '<div class="card"><div class="card-title">My asset reversal disputes</div>' + myReqList(mine(u).filter(function (r) { return r.type === 'dispute_reversal'; })) + '</div>';
  }
  function accountHub(u) {
    var opts = [
      ['trash', 'Delete account', 'Request permanent deletion of your WhaleChat account.', '#/investment/account/delete'],
      ['refresh', 'Upgrade account to the latest version', 'Get your account upgraded to the newest WhaleChat release.', '#/investment/account/upgrade'],
      ['store', 'Upgrade account to a vendor profile', 'Create your vendor profile to buy, sell and earn.', '#/investment/account/vendor'],
      ['clip', 'View account statement', 'Full history of your account from creation to today.', '#/investment/account/statement']
    ];
    var rows = mine(u).filter(function (r) { return /^account_/.test(r.type); });
    return head('Account issues', 'Choose what you need help with.', '#/investment/disputes') +
      '<div class="sc-list card">' + opts.map(function (t) {
        return '<a class="sc-row" href="' + t[3] + '"><span class="sc-row-ic">' + I(t[0], 16) + '</span><div class="grow"><b>' + E(t[1]) + '</b><div class="tiny muted">' + E(t[2]) + '</div></div>' + I('chevron', 16) + '</a>';
      }).join('') + '</div><div class="card"><div class="card-title">My account requests</div>' + myReqList(rows) + '</div>';
  }
  function deletePage(u, params) {
    var code = (params && params.code) || S.delCode || '';
    var pend = mine(u).find(function (r) { return r.type === 'account_delete' && /pending|seen|review/.test(r.status); });
    if (pend) return head('Delete account', '', '#/investment/disputes/account') + '<div class="card">' + statusBox(pend) + '<a class="btn btn-ghost btn-sm mt10" href="#/investment/sr/' + pend.id + '">View request</a></div>';
    return head('Delete account', 'Tell us why, verify your email, then submit.', '#/investment/disputes/account') +
      '<div class="card"><div class="sc-note sc-note-bad">Deleting your account is permanent. Withdraw your balances first — any remaining balance, portfolios, vendor profile and chats are removed once the admin approves.</div>' +
        '<div class="field mt10"><label class="label">Reason for deleting your account</label><textarea class="input" id="scDelReason" rows="4" placeholder="Describe why you want your account deleted…">' + E(S.delReason || '') + '</textarea></div>' +
        '<div class="field"><label class="label">Email verification</label><div class="row gap8"><input class="input" id="scDelCode" inputmode="numeric" maxlength="6" placeholder="6-digit code" value="' + E(code) + '"/>' +
        '<button class="btn btn-ghost btn-sm" data-act="sc-paste" data-target="scDelCode">' + I('copy', 13) + ' Paste</button></div>' +
        '<div class="row gap8 mt6"><button class="btn btn-soft btn-sm" data-act="sc-del-send">' + I('send', 13) + ' Send code to ' + E(String(u.email || 'my email').replace(/^(.{2}).*(@.*)$/, '$1***$2')) + '</button>' +
        '<button class="btn btn-primary btn-sm" data-act="sc-del-verify">' + I('check', 13) + ' Verify</button></div>' +
        '<div class="tiny mt6" id="scDelState">' + (S.delVerified ? '<span class="up">Email verified ✓</span>' : '<span class="muted">The email contains your code with a copy button. Copy it, paste it here and tap Verify.</span>') + '</div></div>' +
        '<button class="btn btn-danger" data-act="sc-del-submit" style="width:100%"' + (S.delVerified ? '' : ' disabled') + ' id="scDelSubmit">Submit delete request</button></div>';
  }
  function upgradePage(u) {
    var pend = mine(u).find(function (r) { return r.type === 'account_upgrade' && /pending|seen|review|processing/.test(r.status); });
    var ver = ''; try { ver = window.__scLatest || ''; } catch (e) {}
    return head('Upgrade to the latest version', 'Request an upgrade of your account to the newest WhaleChat release.', '#/investment/disputes/account') +
      (pend ? '<div class="card">' + statusBox(pend) + '</div>' : '') +
      '<div class="card"><div class="sc-kv"><div><span>Your account version</span><b>' + E(u.appVersion ? 'v' + u.appVersion : 'Legacy') + '</b></div><div><span>Latest published version</span><b id="scLatestVer">' + E(ver ? 'v' + ver : 'checking…') + '</b></div></div>' +
        '<div class="field mt10"><label class="label">Account username, ID or email</label><input class="input" id="scUpgId" value="' + E(u.username || '') + '" placeholder="username, account ID or email"/></div>' +
        '<button class="btn btn-primary" data-act="sc-upg-submit" style="width:100%"' + (pend ? ' disabled' : '') + '>Submit upgrade request</button></div>';
  }
  function vendorPage(u) {
    var v = null; try { v = typeof vendorOf === 'function' ? vendorOf(u.id) : null; } catch (e) {}
    if (v) return head('Vendor profile', '', '#/investment/disputes/account') + '<div class="card"><p>You already have a vendor profile <b>@' + E(v.username) + '</b>.</p><a class="btn btn-primary" href="#/vendor">Open vendor dashboard</a></div>';
    var pend = mine(u).find(function (r) { return r.type === 'account_vendor' && !/approved|declined/.test(r.status); });
    if (pend) return head('Vendor profile', '', '#/investment/disputes/account') + '<div class="card">' + statusBox(pend) + '<a class="btn btn-primary btn-sm mt10" href="#/investment/sr/' + pend.id + '">' + (/awaiting|rejected/.test(pend.status) ? 'Complete payment' : 'View request') + '</a></div>';
    var plans = vendorPlans();
    var note = ''; try { note = (DB.settings.vendorPayments || {}).note || ''; } catch (e) {}
    return head('Create a vendor profile', 'Upgrade your account to a vendor profile.', '#/investment/disputes/account') +
      '<div class="card">' +
        '<div class="field"><label class="label">Vendor profile username</label><input class="input" id="scVnName" placeholder="e.g. whale_store" maxlength="24"/></div>' +
        '<div class="field"><label class="label">Vendor account duration</label><select class="input" id="scVnPlan">' + plans.map(function (p) { return '<option value="' + E(p.id) + '" data-price="' + Number(p.priceUsd) + '">' + p.months + ' month' + (p.months > 1 ? 's' : '') + ' — ' + M(p.priceUsd) + '</option>'; }).join('') + '</select></div>' +
        '<div class="card-title">Select payment method</div>' + methodPicker(vendorMethods(), 'vn') +
        '<div class="field mt10"><label class="label">Amount (USD)</label><input class="input" id="scVnAmt" type="number" inputmode="decimal" value="' + (plans[0] ? Number(plans[0].priceUsd) : '') + '"/></div>' +
        (note ? '<p class="tiny muted">' + E(note) + '</p>' : '') +
        '<button class="btn btn-primary" data-act="sc-vn-start" style="width:100%">I will make payment now</button>' +
        '<p class="tiny muted mt6">After paying, upload your payment slip. If you leave the app, a “Complete pending payment” reminder brings you back to this step.</p></div>';
  }

  /* ---------- statement */
  function groupOf(id) {
    id = String(id || '');
    if (/^wallet|^coin:/.test(id) || id === 'wallet') return 'wallet';
    if (/^inv_|^investment$|^payout$/.test(id)) return 'investment';
    if (/^stock/.test(id)) return 'stock';
    if (/^wc_/.test(id)) return 'wc';
    if (/^b2b|^capital$/.test(id)) return 'b2b';
    if (/^bot/.test(id)) return 'bot';
    return '';
  }
  function amtOf(x) { var v = Math.abs(Number(x.usd) || 0); if (v) return v; var m = String(x.label || '').match(/\$([\d,]+(?:\.\d+)?)/); if (m) return Number(m[1].replace(/,/g, '')) || 0; return Math.abs(Number(x.meta && x.meta.amount) || 0); }
  function statementData(u) {
    var a = ia(u);
    var deps = (DB.deposits || []).filter(function (x) { return x.userId === u.id; }).sort(function (p, q) { return p.createdAt - q.createdAt; });
    var wds = (DB.withdrawals || []).filter(function (x) { return x.userId === u.id; }).sort(function (p, q) { return p.createdAt - q.createdAt; });
    var flows = { invIn: 0, invOut: 0, pfIn: { stock: 0, wc: 0, b2b: 0, bot: 0 }, pfOut: { stock: 0, wc: 0, b2b: 0, bot: 0 } };
    function flow(from, to, amt) {
      if (!amt) return;
      if (from === 'wallet' && to === 'investment') flows.invIn += amt;
      else if (from === 'investment' && to === 'wallet') flows.invOut += amt;
      else if ((from === 'investment' || from === 'wallet') && flows.pfIn[to] != null) flows.pfIn[to] += amt;
      else if (flows.pfOut[from] != null && (to === 'investment' || to === 'wallet')) flows.pfOut[from] += amt;
      else if (flows.pfOut[from] != null && flows.pfIn[to] != null && from !== to) { flows.pfOut[from] += amt; flows.pfIn[to] += amt; }
    }
    (u.acctLedger || []).forEach(function (x) { if (x.meta && x.meta.from && x.meta.to) flow(groupOf(x.meta.from), groupOf(x.meta.to), amtOf(x)); });
    (a.ledger || []).forEach(function (x) {
      var m = x.meta || {};
      if (m.to === 'investment') flow('wallet', 'investment', amtOf(x));
      else if (m.to === 'wallet') flow('investment', 'wallet', Math.abs(Number(x.coins) || 0) * rate() || amtOf(x));
      else if (m.portfolio) flow('investment', groupOf(m.portfolio === 'wc' ? 'wc_' : m.portfolio), amtOf(x));
      else if (m.source === 'wallet-usd') flow('wallet', 'b2b', amtOf(x));
      else if (m.to === 'payout' && /B2B/i.test(x.label)) flow('b2b', 'investment', Math.abs(Number(m.amount) || 0));
    });
    var pl = { stock: [0, 0], b2b: [0, 0], wc: [0, 0], bot: [0, 0] };
    (DB.trades || []).forEach(function (t) {
      if (t.userId !== u.id || t.status === 'Open') return;
      var v = t.pnlUsd != null ? Number(t.pnlUsd) : (t.plUsd != null ? Number(t.plUsd) : (Number(t.pnlCoins) || 0) * rate());
      if (v > 0) pl.stock[0] += v; else if (v < 0) pl.stock[1] += -v;
    });
    (a.ledger || []).forEach(function (x) { if (x.meta && x.meta.payout != null && /B2B sell/i.test(x.label)) { var v = Number(x.meta.payout) || 0; if (v > 0) pl.b2b[0] += v; else pl.b2b[1] += -v; } });
    (DB.shareInvestments || []).forEach(function (s) { if (s.userId === u.id && s.status === 'completed') pl.wc[0] += (Number(s.profitCoins) || 0) * 0.5; });
    var sess = (DB.botSessions || []).filter(function (s) { return s && s.userId === u.id; });
    if (sess.length) sess.forEach(function (s) { pl.bot[0] += (Number(s.totalProfitCoins) || 0) * 0.5; pl.bot[1] += (Number(s.totalLossCoins) || 0) * 0.5; });
    else (DB.botEvents || []).forEach(function (e) { if (e.userId === u.id && e.type === 'trade' && e.meta) { var v = (Number(e.meta.pnlCoins) || 0) * 0.5; if (v > 0) pl.bot[0] += v; else pl.bot[1] += -v; } });
    var bonusTx = (DB.txs || []).filter(function (t) { return t.userId === u.id && /bonus|referral|reward|promo/i.test(String(t.type || '')); });
    var bonusTotal = bonusTx.reduce(function (s, t) { return s + (Number(t.coins) || 0); }, 0);
    var refs = (DB.users || []).filter(function (x) { return x.referredBy === u.id; }).length;
    var v = null; try { v = typeof vendorOf === 'function' ? vendorOf(u.id) : null; } catch (e) {}
    var sold = v ? (Number(v.completedSales || v.sales) || 0) : (Number(u.completedSales) || 0);
    var stock = v ? (DB.products || []).filter(function (p) { return p.vendorId === v.id; }).reduce(function (s, p) { return s + (Number(p.stock) || 0); }, 0) : 0;
    var approvedDep = deps.some(function (x) { return x.status === 'approved'; });
    var promo = !!(u.promoEligible || u.luckyWinner || (approvedDep && !u.banned && (refs > 0 || deps.filter(function (x) { return x.status === 'approved'; }).length >= 2)));
    var join = u.joinMethod || (u.referredBy || u.pendingReferralCode ? 'Referral code / referral link' : 'Direct link');
    var refBy = u.referredBy ? user(u.referredBy) : null;
    return { a: a, deps: deps, wds: wds, flows: flows, pl: pl, bonusTx: bonusTx, bonusTotal: bonusTotal, refs: refs, vendor: v, sold: sold, stock: stock, promo: promo, join: join, refBy: refBy };
  }
  function statementHTML(u) {
    var s = statementData(u), a = s.a;
    function row(k, v2, cls) { return '<tr><td>' + E(k) + '</td><td class="' + (cls || '') + '">' + v2 + '</td></tr>'; }
    var pfs = [['stock', 'Stock trading'], ['b2b', 'B2B-Investing'], ['wc', 'WC-Investing'], ['bot', 'Bot trading']];
    return '<div class="sc-stmt" id="scStmt">' +
      '<div class="between"><div><h2 style="margin:0">WhaleChat account statement</h2><div class="tiny muted">Generated ' + E(dt(Date.now())) + '</div></div><div style="text-align:right"><b>@' + E(u.username) + '</b><div class="tiny muted">' + E(u.fullName || '') + '<br/>ID: ' + E(u.accountId || u.referralCode || u.id) + '</div></div></div>' +
      '<h3>Account</h3><table class="sc-t">' +
        row('Account created', E(dt(u.createdAt))) + row('Joined via', E(s.join) + (s.refBy ? ' (invited by @' + E(s.refBy.username) + ')' : '')) +
        row('Email', E(u.email || '—')) + row('WhaleChat WC balance', E(coins(u.balance || 0)) + ' WC ≈ ' + M((u.balance || 0) * rate())) + row('WhaleChat $ balance', M(u.walletUsd || 0)) +
        row('Investment total assets', M(a.usd)) + row('Investment payout balance', M(a.payout)) +
      '</table>' +
      '<h3>Deposits (' + s.deps.length + ')</h3>' + (s.deps.length ? '<table class="sc-t sc-t4"><tr><th>Date</th><th>Method</th><th>Amount</th><th>Status</th></tr>' + s.deps.map(function (x) { return '<tr><td>' + E(dt(x.createdAt)) + '<div class="tiny muted">' + E(x.id) + '</div></td><td>' + E(x.methodName || x.method || x.coin || '') + (x.detail ? '<div class="tiny muted">' + E(String(x.detail).slice(0, 60)) + '</div>' : '') + '</td><td>' + M(x.usd || (x.coins || 0) * rate()) + '<div class="tiny muted">' + E(coins(x.coins || 0)) + ' WC</div></td><td>' + txStatus(x.status) + '</td></tr>'; }).join('') + '</table>' : '<p class="tiny muted">No deposits.</p>') +
      '<h3>Withdrawals (' + s.wds.length + ')</h3>' + (s.wds.length ? '<table class="sc-t sc-t4"><tr><th>Date</th><th>Method / network</th><th>Amount</th><th>Status</th></tr>' + s.wds.map(function (x) { return '<tr><td>' + E(dt(x.createdAt)) + '<div class="tiny muted">' + E(x.id) + '</div></td><td>' + E(wdMethod(x)) + ' · ' + E(x.network || '') + '<div class="tiny muted sc-addr">' + E(x.address || '') + '</div></td><td>' + M(x.usd || (x.coins || 0) * rate()) + '<div class="tiny muted">' + E(coins(x.coins || 0)) + ' WC</div></td><td>' + txStatus(x.status) + '</td></tr>'; }).join('') + '</table>' : '<p class="tiny muted">No withdrawals.</p>') +
      '<h3>Investment account transfers</h3><table class="sc-t">' + row('Transferred into investment account', M(s.flows.invIn)) + row('Transferred out to WhaleChat account', M(s.flows.invOut)) + '</table>' +
      '<h3>Portfolios</h3><table class="sc-t sc-t5"><tr><th>Portfolio</th><th>In</th><th>Out</th><th>Profit</th><th>Loss</th></tr>' + pfs.map(function (p) {
        return '<tr><td>' + p[1] + '</td><td>' + M(s.flows.pfIn[p[0]]) + '</td><td>' + M(s.flows.pfOut[p[0]]) + '</td><td class="up">+' + M(s.pl[p[0]][0]) + '</td><td class="down">−' + M(s.pl[p[0]][1]) + '</td></tr>';
      }).join('') + '</table>' +
      '<h3>Rewards, referrals &amp; vendor</h3><table class="sc-t">' +
        row('Bonuses claimed', s.bonusTx.length + ' · ' + E(coins(s.bonusTotal)) + ' WC') + row('Referrals made', String(s.refs)) +
        row('Vendor profile', s.vendor ? '@' + E(s.vendor.username) : 'No') + row('Products sold', String(s.sold)) + row('Products remaining on vendor profile', String(s.stock)) +
        row('Promo / bonus reward eligibility', s.promo ? '<b class="up">Eligible</b>' : '<span class="muted">Not eligible yet</span>') +
      '</table><p class="tiny muted">This statement is generated from your account records at the time shown above.</p></div>';
  }
  function statementPage(u) {
    var pend = mine(u).filter(function (r) { return r.type === 'account_statement'; });
    return head('Account statement', 'Your account history from creation to today.', '#/investment/disputes/account') +
      '<div class="card">' + statementHTML(u) +
        '<div class="row gap8 mt10" style="flex-wrap:wrap"><button class="btn btn-primary btn-sm" data-act="sc-print">' + I('download', 14) + ' Download / print</button>' +
        '<button class="btn btn-soft btn-sm" data-act="sc-stmt-request">' + I('send', 14) + ' Request official copy</button></div></div>' +
      (pend.length ? '<div class="card"><div class="card-title">Official statement requests</div>' + myReqList(pend) + '</div>' : '');
  }

  /* ---------- single request page (also the payment "last step") */
  function srPage(u, id) {
    var r = req(id);
    if (!r || (r.userId !== u.id && u.role !== 'admin')) return head('Request', '', '#/investment/more') + '<div class="card empty"><p>Request not found.</p></div>';
    var back = isDispute(r) ? '#/investment/disputes' : (/^account_/.test(r.type) ? '#/investment/disputes/account' : '#/investment/more');
    var html = head(typeLabel(r.type), 'Submitted ' + dt(r.createdAt), back) + '<div class="card">' + statusBox(r) + '</div>';
    html += detailsCard(r, false);
    if ((r.type === 'dispute_reversal' || r.type === 'account_vendor') && /awaiting_payment|payment_rejected/.test(r.status)) html += payCard(r);
    if (r.type === 'dispute_reversal' && r.status === 'payment_approved') {
      html += '<div class="card sc-agent"><div class="sc-status sc-ok"><div class="sc-status-l">Payment approved</div>Your payment has been successfully approved.</div>' +
        '<button class="btn btn-primary mt10" data-act="sc-agent" data-id="' + r.id + '" style="width:100%">' + I('link', 15) + ' ' + E(cfg().agentLabel || 'Connect with a coin reversal agent') + '</button></div>';
    }
    if (r.type === 'account_vendor' && r.status === 'approved') html += '<div class="card"><a class="btn btn-primary" href="#/vendor" style="width:100%">Open vendor dashboard</a></div>';
    html += timeline(r);
    html += '<div class="card"><div class="row gap8" style="flex-wrap:wrap">' + supportBtn('Live chat support') + '</div></div>';
    return html;
  }
  function payCard(r) {
    var m = r.method || {};
    return '<div class="card"><div class="card-title">Complete your payment</div>' +
      '<div class="sc-kv"><div><span>Amount to pay</span><b>' + M(r.feeUsd) + '</b></div><div><span>Payment method</span><b>' + E(m.label || '') + (m.network ? ' · ' + E(m.network) : '') + '</b></div></div>' +
      '<div class="sc-payaddr"><div class="tiny muted">Payment address</div><div class="sc-addr"><b>' + E(m.address || '—') + '</b></div><button class="btn btn-ghost btn-xs mt6" data-act="sc-copy" data-text="' + E(m.address || '') + '">' + I('copy', 13) + ' Copy address</button></div>' +
      '<div class="field mt10"><label class="label">Payment slip</label><div id="scSlipPrev">' + (S.slip && S.slipFor === r.id ? '<img src="' + S.slip + '" class="sc-slip"/>' : (r.proof ? '<img src="' + r.proof + '" class="sc-slip"/>' : '<div class="tiny muted">No slip uploaded yet.</div>')) + '</div>' +
      '<button class="btn btn-soft btn-sm mt6" data-act="sc-slip" data-id="' + r.id + '">' + I('image', 14) + ' Upload payment slip</button></div>' +
      '<button class="btn btn-primary" data-act="sc-slip-submit" data-id="' + r.id + '" style="width:100%">Submit</button></div>';
  }
  function detailsCard(r, adminView) {
    var rows = [];
    function add(k, v2) { if (v2 !== undefined && v2 !== null && v2 !== '') rows.push('<div><span>' + E(k) + '</span><b>' + v2 + '</b></div>'); }
    if (adminView) { add('User', '@' + E(r.username) + (user(r.userId) ? '' : ' <span class="down">(deleted)</span>')); add('Email', E(r.email)); }
    if (r.tx) {
      add('Transaction', E(r.tx.kind) + ' · ' + M(r.tx.usd));
      add('Transaction date', E(dt(r.tx.at)));
      add('Transaction status', txStatus(r.tx.status));
      add('Reference', E(r.tx.id));
      if (r.tx.detail && r.type !== 'dispute_reversal') add('Details', E(r.tx.detail));
    }
    if (r.type === 'dispute_reversal' && r.wd) {
      add('Withdrawal submitted', E(dt(r.wd.at)));
      add('Withdrawal method', E(r.wd.method));
      add('Withdrawal network', E(r.wd.network));
      add('Receiving address', '<span class="sc-addr">' + E(r.wd.address) + '</span>');
      add('Withdrawal status', 'Approved &amp; sent to user\'s provided withdrawal details');
      add('Reversal amount', M(r.amountUsd));
      add('Booking fee (' + E(r.feePct) + '%)', M(r.feeUsd));
    }
    if (r.type === 'loan') { add('Amount', M(r.amountUsd)); add('Term', E(r.termMonths) + ' months'); add('Interest', E(r.interestPct) + '%'); add('Estimated repayment', M(r.repayUsd)); add('Purpose', E(r.purpose)); add('Income / repayment source', E(r.income)); if (r.disbursedUsd) add('Disbursed', M(r.disbursedUsd)); }
    if (r.type === 'card') { add('Card type', E(r.cardType)); add('Name on card', E(r.nameOnCard)); add('Phone', E(r.phone)); add('Delivery address', E(r.address)); add('Main use', E(r.use)); add('Monthly spending', r.spendUsd ? M(r.spendUsd) : ''); if (r.card) { add('Card number', E('•••• ' + (r.card.last4 || ''))); add('Expiry', E(r.card.expiry || '')); add('Tracking / delivery', E(r.card.tracking || '')); add('Card note', E(r.card.note || '')); } }
    if (r.type === 'account_vendor') { add('Vendor username', '@' + E(r.vendorUsername)); add('Duration', E(r.months) + ' month(s)'); add('Amount', M(r.feeUsd)); }
    if (r.type === 'account_upgrade') { add('Account entered', E(r.identifier)); add('Version before', E(r.fromVersion || 'Legacy')); if (r.version) add('Upgraded to', 'v' + E(r.version)); }
    if (r.type === 'account_delete') { add('Email verified', r.verifiedAt ? '<span class="up">Yes · ' + E(dt(r.verifiedAt)) + '</span>' : 'No'); }
    if (r.text) add(r.type === 'account_delete' ? 'Reason' : 'Description', '<span style="white-space:pre-wrap;font-weight:500">' + E(r.text) + '</span>');
    if (adminView && r.proof) add('Payment slip', '<a href="' + r.proof + '" target="_blank" rel="noopener"><img src="' + r.proof + '" class="sc-slip"/></a>');
    if (!rows.length) return '';
    return '<div class="card"><div class="card-title">Details</div><div class="sc-kv">' + rows.join('') + '</div></div>';
  }
  function timeline(r) {
    var log = (r.log || []).slice().reverse();
    if (!log.length) return '';
    return '<div class="card"><div class="card-title">Timeline</div><div class="sc-tl">' + log.map(function (l) {
      var fake = { type: r.type, status: l.status };
      return '<div class="sc-tl-i"><div class="sc-dot"></div><div><b>' + E(statusInfo(fake).label) + '</b> <span class="tiny muted">' + E(dt(l.at)) + '</span>' + (l.note ? '<div class="tiny muted">' + E(l.note) + '</div>' : '') + '</div></div>';
    }).join('') + '</div></div>';
  }

  /* ------------------------------------------------------------ FAQ */
  function faqFooter() {
    return '<div class="sc-faq-help"><span>Do you need further assistance? Kindly click the button to connect with our support team on a livechat.</span>' + supportBtn('Support') + '</div>';
  }
  function faqItems() {
    var fee = 0, lev = 5, wcUsd = rate(), g = {};
    try { fee = (typeof INV !== 'undefined' && INV.fee) ? Number(INV.fee()) || 0 : Number(DB.invest && DB.invest.feePct) || 0; } catch (e) {}
    try { lev = Math.max(1, Number(DB.invest && DB.invest.leverage) || 5); } catch (e) {}
    try { g = DB.settings.tradeGuide || {}; } catch (e) {}
    var minDep = Number(g.minDepositUsd) || 10, minWd = Number(g.minWithdrawUsd) || 10;
    var pct = Number(cfg().bookingFeePct) || 5;
    var tools = []; try { tools = (window.WC_SUBS && WC_SUBS.catalog) ? WC_SUBS.catalog() : []; } catch (e) {}
    var toolRows = (tools.length ? tools : [
      { name: 'Auto Secure Take Profit', price: 9.99, desc: 'Automatically secures available profit before it reverses.' },
      { name: 'Bot Assisted Trading', price: 19.99, desc: 'Bot monitors active trades and helps manage entries and exits.' },
      { name: 'Risk Shield / Take Loss Guard', price: 7.99, desc: 'Adds an extra automatic loss guard to open positions.' },
      { name: 'Pro Chart Signals', price: 4.99, desc: 'Live structure and momentum signals on the 24/7 chart.' }
    ]).map(function (t) { return '<tr><td><b>' + E(t.name) + '</b></td><td>' + M(t.price) + '/mo</td><td>' + E(t.desc || '') + '</td></tr>'; }).join('');
    var bots = []; try { bots = (DB.settings && DB.settings.botTiers) || []; } catch (e) {}
    if (!bots.length) bots = [{ name: 'Low-Level Grade Bot', accuracy: 45, priceUsd: 20, blurb: 'Steady starter automation for small allocations.' }, { name: 'Medium-Level Grade Bot', accuracy: 50, priceUsd: 50, blurb: 'Balanced risk with more frequent entries.' }, { name: 'Premium-Level Grade Bot', accuracy: 70, priceUsd: 120, blurb: 'Higher hit-rate for users scaling their capital.' }, { name: 'High-Performance Bot', accuracy: 85, priceUsd: 250, blurb: 'Top tier accuracy for serious allocations.' }];
    var botRows = bots.map(function (b) { return '<tr><td><b>' + E(b.name) + '</b></td><td>' + E(b.accuracy) + '%</td><td>' + M(b.priceUsd) + '/mo</td><td>' + E(b.blurb || '') + '</td></tr>'; }).join('');
    function ol(a) { return '<ol>' + a.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ol>'; }
    function ul(a) { return '<ul>' + a.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>'; }
    var L = function (h, t) { return '<a href="' + h + '">' + t + '</a>'; };
    return [
      { id: 'about', cat: 'Getting started', q: 'What is WhaleChat and how does the company operate?', a: '<p>WhaleChat combines secure chat, a vendor marketplace, a Whale Coin (WC) wallet and an investment account in one app. 1 WC = <b>' + M(wcUsd) + '</b>.</p>' + ul(['<b>WhaleChat account</b> — your main wallet: a crypto balance listed coin by coin, and your WC balance. Crypto deposits arrive here, convert to WC here, and crypto withdrawals leave from here.', '<b>Investment account</b> — trade capital in USD (WC you send from your WhaleChat account is converted to USD) plus a total profit balance. From trade capital you top up four portfolios in USD: Stock trading, WC-Investing, B2B-Investing and Bot trading. Only the total profit balance can be sent back to your WC balance (converted to WC).', '<b>Marketplace</b> — buy products from verified vendors with WC; WhaleChat handles delivery.', '<b>Vendors</b> — users with a vendor profile who stock products from the company catalogue and sell to other users. Company stock is paid from vendor capital (USD), funded by sending WC from the WhaleChat account.']) },
      { id: 'stock-trade', cat: 'Stock trading', q: 'How do I trade on stock trading (step by step)?', a: ol(['Move funds to your investment account (' + L('#/investment/transfer', 'Transfer') + ') and top up the <b>Stock trading</b> portfolio.', 'Open stock trading and choose a stock from the market list.', 'Enter the <b>amount per trade</b> (your capital for this trade).', 'Pick your <b>leverage</b> (default ' + lev + 'x). Low risk is 1x–5x; high risk is 10x–100x.', 'Set <b>Take Profit (TP)</b> and <b>Take Loss (TL / stop loss)</b> — see the next answers.', 'Choose Buy (price goes up) or Sell (price goes down) and confirm. A trade fee of <b>' + fee + '%</b> is deducted when the trade activates.', 'Follow the trade live. It closes automatically when TP or TL is hit, when the duration ends, or when you close it.']) + '<p>Full guide: ' + L('#/how-it-works', 'Trade guide') + '.</p>' },
      { id: 'tp-sl', cat: 'Stock trading', q: 'How do I set Take Profit and Take Loss?', a: '<p><b>Take Profit</b> closes the trade automatically once profit reaches the % or amount you set, so the gain is locked in. <b>Take Loss</b> closes the trade automatically when loss reaches your limit and returns the remaining capital.</p>' + ol(['In the trade ticket, turn on Take Profit and enter a target (e.g. +10%).', 'Turn on Take Loss and enter the most you are willing to lose (e.g. −10%).', 'Confirm the trade. Both levels are watched 24/7.']) + '<p>Example: $100 capital, −10% Take Loss → the trade stops at −$10 and $90 returns. <b>Without a Take Loss</b>, the price can move against you until the capital is used up and the trade closes with nothing returned.</p>' },
      { id: 'leverage', cat: 'Stock trading', q: 'How do leverage and amount per trade work?', a: '<p>Leverage multiplies the effect of the price move on your capital. <code>profit = capital × price move % × leverage</code>.</p><table class="sc-t"><tr><th>Capital</th><th>Leverage</th><th>Move</th><th>Result</th></tr><tr><td>$100</td><td>3x</td><td>+2%</td><td class="up">+$6.00</td></tr><tr><td>$100</td><td>' + lev + 'x</td><td>+2%</td><td class="up">+' + M(100 * 0.02 * lev) + '</td></tr><tr><td>$100</td><td>' + lev + 'x</td><td>−2%</td><td class="down">−' + M(100 * 0.02 * lev) + '</td></tr></table><p>Higher leverage raises both potential profit and potential loss. Use a size you are comfortable with, and always use a Take Loss when leverage is high.</p>' },
      { id: 'stock-payout', cat: 'Stock trading', q: 'How does the stock trading payout work and how is it calculated?', a: '<p><b>Payout = Capital + Profit − trade fee</b>.</p><div class="sc-formula">profit = capital × price move % × leverage<br/>payout = capital + profit − (capital × ' + fee + '%)</div><p>Example: $200 capital, ' + lev + 'x, +3% move → profit = ' + M(200 * 0.03 * lev) + ', fee = ' + M(200 * fee / 100) + ', payout = ' + M(200 + 200 * 0.03 * lev - 200 * fee / 100) + '.</p><p>Payouts are automatic and instant to the portfolio where the trade happened (stock trading capital / profit balance). Move them to your investment account any time with ' + L('#/investment/transfer', 'Transfer') + '.</p>' },
      { id: 'tools-subscribe', cat: 'Trade tools', q: 'How do I get or subscribe to trade assistance tools?', a: ol(['Open ' + L('#/investment/tools', 'Investment → Tools') + '.', 'Choose a tool and tap Subscribe. The monthly price is charged from your investment balance.', 'The tool activates immediately and renews monthly. You get a reminder before it expires and you can renew or cancel at any time.']) + '<table class="sc-t"><tr><th>Tool</th><th>Price</th><th>What it does</th></tr>' + toolRows + '</table>' },
      { id: 'tools-setup', cat: 'Trade tools', q: 'How do I set up and use bot assistance and Auto Secure Profit?', a: '<p><b>Auto Secure Take Profit</b> watches your active trades in real time. When a trade is in profit it locks the profit before the price reverses and keeps it available for you to claim. You do not need to watch the screen.</p><p><b>Bot Assisted Trading</b> monitors open trades and helps manage entries and exits. <b>Risk Shield / Take Loss Guard</b> adds an extra automatic loss limit on open positions. <b>Pro Chart Signals</b> shows momentum and structure signals on the chart.</p>' + ol(['Subscribe to the tool on the Tools page.', 'Open a stock trade — active tools show on the trade ticket with a toggle.', 'Turn the tool on for the trade (or leave it on for all trades) and confirm.', 'You can pause or turn a tool off at any time from the Tools page.']) },
      { id: 'tool-levels', cat: 'Trade tools', q: 'What are the bot tool levels and how do they differ?', a: '<p>Trading bots trade automatically with your bot capital. Higher levels have higher accuracy, which means a higher share of winning trades over time — but no bot can guarantee profit.</p><table class="sc-t"><tr><th>Level</th><th>Accuracy</th><th>Price</th><th>Best for</th></tr>' + botRows + '</table><p>Every bot trades in stakes from your bot capital. Wins go to the bot profit balance. Losses come from the stake. The bot cools down when its time limit is reached or capital runs low.</p>' },
      { id: 'bot-topup', cat: 'Trade tools', q: 'How do I top up my bot trading capital?', a: ol(['Transfer funds to your investment account.', 'Use ' + L('#/investment/topup', 'Top-up') + ' and choose <b>Bot trading</b> to allocate capital.', 'Open the bot page and tap <b>Top up capital</b>. Enter the amount from your bot capital allocation and confirm.', 'Start or resume the bot. Profit builds up in the bot profit balance.']) },
      { id: 'wc-invest', cat: 'WC-Investing', q: 'How do I invest in WhaleChat shares on WC-INVESTING?', a: ol(['Top up the <b>WC-Investing</b> portfolio from your investment account.', 'Open WC-Investing and choose an investment plan (each plan shows its duration and return rate).', 'Enter the amount and confirm. You receive shares at the current WhaleChat share price.', 'Track the accrued profit live. When the plan matures, the payout is credited automatically.']) + '<p>Shareholders benefit from platform growth. The share price can rise or fall, so profit is not guaranteed.</p>' },
      { id: 'wc-payout', cat: 'WC-Investing', q: 'How does the WC-INVESTING plan payout work and how is it calculated?', a: '<div class="sc-formula">daily profit = share price × plan rate<br/>total payout = daily profit × plan days × capital</div><p>When the plan duration completes, the principal plus the plan profit is calculated automatically and credited to your investment <b>payout balance</b>. You are notified with the exact amount. Accrued (not yet matured) profit is shown live on each active plan.</p>' },
      { id: 'b2b', cat: 'B2B-Investing', q: 'How do I buy and sell digital assets to earn on B2B-trading?', a: ol(['Top up your B2B capital (' + L('#/investment/b2b/topup', 'B2B top-up') + ').', 'Open ' + L('#/investment/b2b', 'B2B-Investing') + ', choose an asset and tap <b>Buy</b>. Enter the USD amount — you receive units at the live price (subject to available inventory).', 'When the price rises, tap <b>Sell</b> (all or part of your units).', 'The principal returns to B2B capital and the gain (or loss) goes to your <b>B2B profit balance</b>.']) + '<p>Profit = units sold × (sell price − average buy price).</p>' },
      { id: 'b2b-alerts', cat: 'B2B-Investing', q: 'How do I set price alerts for digital assets on B2B-TRADING?', a: ol(['Open an asset on the B2B desk and tap <b>Price alert</b>.', 'Enter a <b>buy target</b> (alert when price falls to or below it) and/or a <b>sell target</b> (alert when price rises to or above it).', 'Save. You get an in-app notification and an email with Buy/Sell buttons when the target is reached.', 'Alerts stay active until you remove them. An alert alone never places orders for you.', 'To have it trade for you, subscribe to <b>Auto Buy / Sell</b> on the Tools page, tick <b>Use Auto Buy/Sell</b> on the asset\'s alert and enter an amount. It then buys at your buy price from your capital balance and sells at your sell price, crediting the profit to your profit balance and returning the capital.']) },
      { id: 'balances', cat: 'Balances', q: 'What are the WC-INVESTING, stock trading and B2B portfolio balances?', a: ul(['<b>Stock trading balance</b> — trade capital plus stock profit balance, used for stock trades and receiving trade payouts.', '<b>WC-Investing balance</b> — capital available for share plans plus WC profit balance.', '<b>B2B-Investing balance</b> — B2B capital for buying digital assets plus the B2B profit balance from sales.', '<b>Bot trading</b> — bot capital allocation plus the bot profit balance.', '<b>Investment total assets</b> — the money in your investment account that is not inside any portfolio.', '<b>Payout balance</b> — matured payouts (e.g. WC-Investing plans) ready to move.']) + '<p>All balances are on ' + L('#/investment', 'the Investment page') + '.</p>' },
      { id: 'profits-to-inv', cat: 'Balances', q: 'How do I transfer stock, WC-investing, bot and B2B profits to my investment account?', a: ol(['Open ' + L('#/investment/transfer', 'Transfer') + '.', 'From: choose the profit balance (Stock profit, WC profit, B2B profit or Bot profit).', 'To: choose <b>Investment account → Total profit balance</b> (or Trade capital to reinvest).', 'Enter the amount and confirm. The transfer is instant and recorded in your history.']) },
      { id: 'inv-to-wallet', cat: 'Balances', q: 'How do I move funds between my WhaleChat account and investment account?', a: '<p><b>WhaleChat → Investment:</b> tap <b>Transfer</b> on your WhaleChat account dashboard and send WC from your WC balance to Investment trade capital (or to your vendor capital). It is converted to USD. <b>Investment → WhaleChat:</b> open ' + L('#/investment/transfer', 'Investment transfer') + ' and send USD from your <b>Total profit balance</b> to your WC balance. It is converted to WC. No other investment balance can leave the investment account.</p>' + ol(['Open the right Transfer page.', 'Pick the source and destination balances.', 'Enter the amount — the preview shows exactly what arrives — and confirm.']) },
      { id: 'deposit', cat: 'Wallet', q: 'How do I fund / make a deposit to my WhaleChat account?', a: ol(['Open ' + L('#/deposit', 'Deposit') + '.', 'Choose a payment method (e.g. USDT TRC20) and copy the company address shown.', 'Enter the amount (minimum ' + M(minDep) + ') and send the payment from your exchange or wallet.', 'Upload the payment proof / transaction hash and submit.', 'The admin confirms the deposit, and the WC is credited to your WhaleChat balance. Deposits are free.']) + '<p>Deposit pending too long or declined? Use ' + L('#/investment/disputes/deposit', 'Deposit issues') + '.</p>' },
      { id: 'withdraw', cat: 'Wallet', q: 'How do I withdraw my assets from my WhaleChat account?', a: ol(['Move profit to your WC balance from the investment total profit balance, then tap <b>Convert</b> on your WhaleChat account dashboard and convert WC to USDT or BTC.', 'Open ' + L('#/withdraw', 'Withdraw') + ', choose the crypto and network, and paste your receiving address.', 'Enter the amount (minimum ' + M(minWd) + ') and your transaction PIN, then submit.', 'The admin reviews and sends the payment. The status changes to Approved once it is sent.']) + '<p>Always double-check the network and address. A withdrawal sent to a wrong address may only be recoverable through an ' + L('#/investment/disputes/reversal', 'asset reversal dispute') + '.</p>' },
      { id: 'shop', cat: 'Marketplace', q: 'How do I shop on the WhaleChat marketplace and buy from a vendor?', a: ol(['Open the Marketplace and browse or search products.', 'Open a product to see the vendor, price in WC, stock and rating, then Add to cart.', 'Open the cart and check out: enter your delivery name, phone and address.', 'Pay with your WC balance. The order shows as Processing and you can track it in My orders.']) },
      { id: 'delivery', cat: 'Marketplace', q: 'How does delivery work?', a: '<p>After you order, the WhaleChat team reviews it, packs and ships it, and adds tracking. The order moves through <b>Processing → Shipped → Delivered</b>, and you get a notification (and an email on delivery) at each step. Vendors do not ship parcels themselves — WhaleChat handles logistics for every vendor.</p>' },
      { id: 'become-vendor', cat: 'Vendors', q: 'How do I become a WhaleChat vendor?', a: ol(['Go to ' + L('#/investment/account/vendor', 'Upgrade to vendor profile') + ' (or Become a vendor in the menu).', 'Choose a vendor username and a duration plan.', 'Select a payment method, copy the address, and tap <b>I will make payment now</b>.', 'Send the fee, come back and upload your payment slip, then submit.', 'The admin approves it and your vendor dashboard unlocks.']) },
      { id: 'vendor-role', cat: 'Vendors', q: 'What do vendors do, and how are vendors credited after a sale?', a: ul(['<b>Stock</b> — buy products from the official WhaleChat company catalogue at wholesale prices.', '<b>Price</b> — set your own selling price in USD (converted to WC automatically).', '<b>Manage</b> — your store, listings, stock levels, orders and customer chats.', '<b>Delivery</b> — handled by the WhaleChat team, so you never ship.', '<b>Credit</b> — when a buyer completes checkout, the sale amount in WC is credited to your WhaleChat balance and counted in your sales.', '<b>Renew</b> — keep your plan active to stay listed. Expired stores are hidden until renewed.']) },
      { id: 'refund', cat: 'Vendors', q: 'How do I request a refund?', a: '<p><b>Vendors (unsold stock):</b> in your vendor dashboard, open Purchases, choose the purchase and tap <b>Return &amp; refund</b>. Once the admin approves, the units go back to company stock and the WC is credited to your balance.</p><p><b>Buyers / other payments:</b> submit a ' + L('#/investment/disputes/tx', 'transaction dispute') + ' and describe the problem, or contact live support.</p>' },
      { id: 'referral', cat: 'Rewards', q: 'How does the referral system work?', a: ol(['Open ' + L('#/referrals', 'Referrals') + ' and copy your referral code or link.', 'Share it. New users enter your code at sign-up (or open your link).', 'When your invitee makes their <b>first approved deposit</b>, you receive <b>10 WC</b> automatically.']) + '<p>Your referral count also appears on your account statement.</p>' },
      { id: 'bonus', cat: 'Rewards', q: 'How do I claim a bonus reward?', a: ol(['Open ' + L('#/bonuses', 'Bonuses') + ' to see the bonuses available to you.', 'Complete the bonus task. When you qualify, you receive a one-time redeem code.', 'Enter the code on the bonus and tap Claim. The reward is credited to your WC balance instantly.']) + '<p>Each code works once and only on your account.</p>' },
      { id: 'lucky', cat: 'Rewards', q: 'How do I get listed on the lucky winners list for bonus / promo opportunities?', a: '<p>WhaleChat selects lucky winners from active accounts in good standing. You improve your chances by:</p>' + ul(['having at least one approved deposit and keeping your account active', 'trading or investing regularly in any portfolio', 'inviting friends through the referral system', 'completing bonus tasks and keeping your profile and email verified']) + '<p>Your eligibility is shown on your ' + L('#/investment/account/statement', 'account statement') + ' (“Promo / bonus reward eligibility”). Winners are notified in the app.</p>' },
      { id: 'dispute', cat: 'Support', q: 'How do I submit a transaction dispute?', a: ol(['Open More → ' + L('#/investment/disputes', 'Transaction dispute') + '.', 'Pick the type: Transaction dispute, Account issues, Withdrawal issues, Deposit issues or Asset reversal dispute (or describe something else in the textbox).', 'Select the transaction from your history, describe the issue and submit.', 'Follow the status: <b>Pending</b> → <b>Seen</b> → <b>Under review</b> (24–48hrs) → <b>Processing</b> → <b>Resolved</b> 🎉. If it is declined, use Live chat or Try again.']) },
      { id: 'reversal', cat: 'Support', q: 'How does an asset reversal dispute work?', a: ol(['Open ' + L('#/investment/disputes/reversal', 'Asset reversal dispute') + ' and select the successful withdrawal.', 'The date, method, network and receiving address fill in automatically.', 'Enter the reversal amount. The booking fee is <b>' + pct + '% × amount</b> (e.g. $500 → ' + M(500 * pct / 100) + ').', 'Choose a payment method, copy the address, tap <b>I\'ll pay now</b>, send the fee and upload the payment slip.', 'After the admin approves your payment, tap <b>Connect with a coin reversal agent</b>.', 'The status moves to Processing, then Completed when the assets are sent back to your WhaleChat balance.']) },
      { id: 'loan', cat: 'Support', q: 'How do I request a loan or a WhaleChat business card?', a: '<p>Open ' + L('#/investment/more', 'More') + ' → <b>Request a loan</b> or <b>WhaleChat business card</b>, fill in the form and submit. You can track each request’s status from the More page. Approved loans are credited to your investment account. Approved cards show their card details on the request page.</p>' },
      { id: 'pin', cat: 'Security', q: 'How do I keep my account secure?', a: ul(['Set a transaction PIN in your profile. It is required for withdrawals and transfers.', 'Never share your password, PIN or verification codes — WhaleChat staff will never ask for them.', 'Check withdrawal addresses and networks carefully before submitting.', 'Contact live support immediately if you notice activity you do not recognise.']) },
      { id: 'statement', cat: 'Account', q: 'How do I get my account statement, delete or upgrade my account?', a: '<p>Open Transaction dispute → <b>Account issues</b>. There you can view and download your full ' + L('#/investment/account/statement', 'account statement') + ', request account deletion (with email verification), request an upgrade to the latest app version, or upgrade to a vendor profile.</p>' }
    ];
  }
  function faqList() {
    var c = cfg().faq, base = faqItems();
    base = base.map(function (f) { var o = c.overrides && c.overrides[f.id]; if (o && o.hidden) return null; return o ? Object.assign({}, f, { q: o.q || f.q, a: o.a ? '<p style="white-space:pre-wrap">' + E(o.a) + '</p>' : f.a }) : f; }).filter(Boolean);
    (c.extra || []).forEach(function (x) { if (x && x.q) base.push({ id: x.id, cat: x.cat || 'More', q: x.q, a: '<p style="white-space:pre-wrap">' + E(x.a || '') + '</p>' }); });
    return base;
  }
  function faqPage(u, params) {
    var items = faqList();
    var cats = []; items.forEach(function (f) { if (cats.indexOf(f.cat) < 0) cats.push(f.cat); });
    var open = params && params.q;
    return head('FAQ & guides', 'Everything about how WhaleChat works.', '#/investment/more') +
      '<div class="card"><div class="sc-search">' + I('search', 16) + '<input id="scFaqSearch" placeholder="Search — leverage, payout, vendor, withdraw…" autocomplete="off"/></div>' +
      '<div class="sc-cats">' + cats.map(function (c) { return '<button class="sc-cat" data-act="sc-faq-cat" data-cat="' + E(c) + '">' + E(c) + '</button>'; }).join('') + '</div></div>' +
      cats.map(function (c) {
        return '<div class="sc-faq-group" data-cat="' + E(c) + '"><div class="section-title">' + E(c) + '</div>' + items.filter(function (f) { return f.cat === c; }).map(function (f) {
          return '<details class="card sc-faq" id="faq-' + E(f.id) + '"' + (open === f.id ? ' open' : '') + '><summary><b>' + E(f.q) + '</b>' + I('down', 16) + '</summary><div class="sc-faq-a">' + f.a + faqFooter() + '</div></details>';
        }).join('') + '</div>';
      }).join('') +
      '<div class="card"><div class="row between"><span class="small">Still need help?</span>' + supportBtn('Live chat support') + '</div><a class="btn btn-ghost btn-sm mt10" href="#/how-it-works">Open the full trade guide</a></div>';
  }

  /* ------------------------------------------------------------ admin */
  var ADMIN_KEYS = [
    { key: 'admin-help-desk', label: 'Help desk', icon: 'shield', href: '#/admin/help-desk' },
    { key: 'admin-requests', label: 'User requests', icon: 'clip', href: '#/admin/requests' },
    { key: 'admin-service-settings', label: 'Service settings', icon: 'settings', href: '#/admin/service-settings' }
  ];
  function adminTabs(active) {
    var nav = []; try { nav = ADMIN_NAV; } catch (e) {}
    return '<div class="admin-nav">' + nav.map(function (n) {
      var on = n.href === '#/admin/' + active;
      return '<a href="' + n.href + '" class="' + (on ? 'on' : '') + '">' + E(n.label) + '</a>';
    }).join('') + '</div>';
  }
  function adminShell(active, title, sub, body) {
    return '<div class="page-head"><div><span class="badge badge-accent mb10">' + I('shield', 12) + ' Admin console</span><h1 style="font-size:24px">' + E(title) + '</h1><p>' + E(sub) + '</p></div></div>' + adminTabs(active) + body;
  }
  function openCount(filter) { return list().filter(function (r) { return !/resolved|approved|completed|declined/.test(r.status) && (!filter || filter(r)); }).length; }
  function helpDesk(params) {
    var q = String((params && params.q) || '').trim().toLowerCase();
    var legacyDisp = 0, legacyReq = 0;
    (DB.users || []).forEach(function (u) { var a = u.investAcct || {}; legacyDisp += (a.disputes || []).filter(function (x) { return /pending|review|processing/.test(x.status); }).length; legacyReq += (a.requests || []).filter(function (x) { return x.status === 'pending'; }).length; });
    var tiles = [
      ['Disputes', openCount(isDispute), '#/admin/requests?type=dispute', 'shield'],
      ['Asset reversals', openCount(function (r) { return r.type === 'dispute_reversal'; }), '#/admin/requests?type=dispute_reversal', 'refresh'],
      ['Reversal payments to confirm', list().filter(function (r) { return r.status === 'payment_submitted'; }).length, '#/admin/requests?status=payment_submitted', 'wallet'],
      ['Loan requests', openCount(function (r) { return r.type === 'loan'; }), '#/admin/requests?type=loan', 'wallet'],
      ['Card requests', openCount(function (r) { return r.type === 'card'; }), '#/admin/requests?type=card', 'tag'],
      ['Account requests', openCount(function (r) { return /^account_/.test(r.type); }), '#/admin/requests?type=account', 'user'],
      ['Pending deposits', (DB.deposits || []).filter(function (x) { return x.status === 'pending'; }).length, '#/admin/deposits', 'download'],
      ['Pending withdrawals', (DB.withdrawals || []).filter(function (x) { return x.status === 'pending'; }).length, '#/admin/withdrawals', 'send'],
      ['Vendor applications', (DB.vendorApplications || []).filter(function (x) { return x.status === 'pending'; }).length, '#/admin/vendor-requests', 'store'],
      ['Vendor refunds', (DB.refunds || []).filter(function (x) { return x.status === 'pending'; }).length, '#/admin/refunds', 'refresh'],
      ['Orders to ship', (DB.orders || []).filter(function (x) { return x.status === 'processing' || x.status === 'pending'; }).length, '#/admin/orders', 'truck'],
      ['Reports', (DB.reports || []).filter(function (x) { return !x.status || x.status === 'open' || x.status === 'pending'; }).length, '#/admin/users', 'ban'],
      ['Legacy invest disputes', legacyDisp, '#/admin/invest-disputes', 'shield'],
      ['Legacy loan/card requests', legacyReq, '#/admin/requests?type=legacy', 'clip']
    ];
    var users = q ? (DB.users || []).filter(function (u) { return [u.username, u.email, u.fullName, u.accountId, u.referralCode, u.id, u.phone].some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; }); }).slice(0, 25) : [];
    var recent = list().slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).slice(0, 10);
    return adminShell('help-desk', 'Help desk', 'Every user request and queue in one place.', 
      '<div class="sc-stats">' + tiles.map(function (t) { return '<a class="sc-stat' + (t[1] ? ' hot' : '') + '" href="' + t[2] + '"><span>' + I(t[3], 16) + ' ' + E(t[0]) + '</span><b>' + t[1] + '</b></a>'; }).join('') + '</div>' +
      '<div class="card"><div class="card-title">Find a user to help</div><div class="row gap8"><input class="input" id="scUserQ" value="' + E(q) + '" placeholder="username, email, account ID, phone…"/><button class="btn btn-primary btn-sm" data-act="sc-user-search">Search</button></div>' +
      (q ? '<div class="sc-list mt10">' + (users.length ? users.map(function (u) { return '<a class="sc-row" href="#/admin/user-360/' + u.id + '"><span class="sc-row-ic">' + I('user', 15) + '</span><div class="grow"><b>@' + E(u.username) + '</b> <span class="tiny muted">' + E(u.fullName || '') + '</span><div class="tiny muted">' + E(u.email || '') + ' · ' + E(u.accountId || u.referralCode || '') + '</div></div>' + (u.banned ? '<span class="sc-chip sc-bad">Banned</span>' : '') + '</a>'; }).join('') : '<div class="tiny muted">No users match.</div>') + '</div>' : '') + '</div>' +
      '<div class="card"><div class="between"><div class="card-title" style="margin:0">Latest activity</div><a class="btn btn-ghost btn-xs" href="#/admin/requests">All requests</a></div>' + adminReqRows(recent) + '</div>' +
      '<div class="card"><div class="card-title">Quick links</div><div class="row gap8" style="flex-wrap:wrap">' +
        [['#/admin/service-settings', 'Service settings'], ['#/admin/users', 'Users'], ['#/admin/deposits', 'Deposits'], ['#/admin/withdrawals', 'Withdrawals'], ['#/admin/orders', 'Orders'], ['#/admin/vendor-requests', 'Vendor requests'], ['#/admin/refunds', 'Refunds'], ['#/admin/tools', 'Tool pricing'], ['#/admin/b2b-inventory', 'B2B inventory'], ['#/admin/bonuses', 'Bonuses'], ['#/admin/notifications', 'Send notice'], ['#/admin/chat', 'Support chat'], ['#/admin/settings', 'Settings']]
          .map(function (l) { return '<a class="btn btn-ghost btn-sm" href="' + l[0] + '">' + E(l[1]) + '</a>'; }).join('') + '</div></div>');
  }
  function adminReqRows(rows) {
    if (!rows.length) return '<div class="tiny muted" style="padding:10px 0">Nothing here.</div>';
    return '<div class="sc-list">' + rows.map(function (r) {
      return '<a class="sc-row" href="#/admin/requests/' + r.id + '"><span class="sc-row-ic">' + I((TYPES[r.type] || {}).icon || 'shield', 15) + '</span><div class="grow"><b>' + E(typeLabel(r.type)) + '</b> <span class="tiny muted">@' + E(r.username) + '</span><div class="tiny muted">' + E(dt(r.createdAt)) + (r.summary ? ' · ' + E(String(r.summary).slice(0, 70)) : '') + '</div></div>' + (r.seenAt ? '' : '<span class="sc-chip sc-warn">New</span> ') + badge(r) + '</a>';
    }).join('') + '</div>';
  }
  function adminRequests(params) {
    var type = (params && params.type) || '', st = (params && params.status) || '', q = String((params && params.q) || '').toLowerCase();
    if (type === 'legacy') return adminLegacy();
    var rows = list().filter(function (r) {
      if (type === 'dispute' && !isDispute(r)) return false;
      if (type === 'account' && !/^account_/.test(r.type)) return false;
      if (type && type !== 'dispute' && type !== 'account' && r.type !== type) return false;
      if (st === 'open' && /resolved|approved|completed|declined/.test(r.status)) return false;
      if (st && st !== 'open' && r.status !== st) return false;
      if (q && [r.username, r.email, r.id, r.summary, r.text].join(' ').toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    var typeOpts = [['', 'All types'], ['dispute', 'All disputes']].concat(Object.keys(TYPES).map(function (k) { return [k, TYPES[k].label]; })).concat([['account', 'All account requests'], ['legacy', 'Legacy loan/card requests']]);
    var stOpts = [['', 'All statuses'], ['open', 'Open (not closed)'], ['pending', 'Pending'], ['seen', 'Seen'], ['review', 'Under review'], ['processing', 'Processing'], ['awaiting_payment', 'Awaiting payment'], ['payment_submitted', 'Payment to confirm'], ['payment_approved', 'Payment approved'], ['resolved', 'Resolved'], ['approved', 'Approved'], ['completed', 'Completed'], ['declined', 'Declined']];
    return adminShell('requests', 'User requests', 'Disputes, asset reversals, loans, cards and account requests.',
      '<div class="card"><div class="row gap8" style="flex-wrap:wrap">' +
        '<select class="input" id="scFType" style="max-width:220px">' + typeOpts.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === type ? ' selected' : '') + '>' + E(o[1]) + '</option>'; }).join('') + '</select>' +
        '<select class="input" id="scFStatus" style="max-width:200px">' + stOpts.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === st ? ' selected' : '') + '>' + E(o[1]) + '</option>'; }).join('') + '</select>' +
        '<input class="input" id="scFQ" style="max-width:220px" placeholder="search user / text" value="' + E(q) + '"/>' +
        '<button class="btn btn-primary btn-sm" data-act="sc-filter">Filter</button></div><div class="tiny muted mt6">' + rows.length + ' request(s)</div></div>' +
      '<div class="card">' + adminReqRows(rows) + '</div>');
  }
  function adminLegacy() {
    var rows = [];
    (DB.users || []).forEach(function (u) { ((u.investAcct || {}).requests || []).forEach(function (r) { rows.push({ u: u, r: r }); }); });
    return adminShell('requests', 'Legacy loan / card requests', 'Requests submitted with the older one-tap buttons.',
      '<div class="card"><div class="sc-list">' + (rows.length ? rows.map(function (x) {
        return '<div class="sc-row"><div class="grow"><b>@' + E(x.u.username) + ' · ' + E(x.r.kind === 'loan' ? 'Loan request' : 'Card request') + '</b><div class="tiny muted">' + E(dt(x.r.createdAt)) + '</div></div>' + txStatus(x.r.status) +
          '<button class="btn btn-soft btn-xs" data-act="sc-legacy" data-uid="' + x.u.id + '" data-id="' + x.r.id + '" data-op="approved">Approve</button><button class="btn btn-danger btn-xs" data-act="sc-legacy" data-uid="' + x.u.id + '" data-id="' + x.r.id + '" data-op="declined">Decline</button>' +
          '<button class="btn btn-ghost btn-xs" data-act="admin-msg-user" data-id="' + x.u.id + '">Chat</button></div>';
      }).join('') : '<div class="tiny muted">No legacy requests.</div>') + '</div></div>');
  }
  function actionBtns(r) {
    var b = [];
    function btn(op, label, cls) { b.push('<button class="btn ' + (cls || 'btn-soft') + ' btn-sm" data-act="sc-admin-op" data-id="' + r.id + '" data-op="' + op + '">' + E(label) + '</button>'); }
    var closed = /resolved|approved|completed|declined/.test(r.status);
    if (r.type === 'dispute_reversal') {
      if (r.status === 'payment_submitted') { btn('pay_ok', 'Approve payment', 'btn-primary'); btn('pay_bad', 'Reject payment slip', 'btn-ghost'); }
      if (r.status === 'payment_approved') btn('connected', 'Mark user as connected with a reversal agent', 'btn-primary');
      if (r.status === 'processing' || r.status === 'payment_approved') btn('completed', 'Completed — asset reversed', 'btn-primary');
    } else if (r.type === 'account_vendor') {
      if (r.status === 'payment_submitted') { btn('vendor_ok', 'Approve upgrade to vendor profile', 'btn-primary'); btn('pay_bad', 'Reject payment slip', 'btn-ghost'); }
    } else if (r.type === 'account_delete') {
      if (!closed) { btn('review', 'Accept for review'); btn('delete_ok', 'Approve delete account request', 'btn-danger'); }
    } else if (r.type === 'account_upgrade') {
      if (!closed) { btn('review', 'Accept for review'); btn('upgrade_ok', 'Approve account upgrade to latest version', 'btn-primary'); }
    } else if (r.type === 'loan') {
      if (!closed) { btn('review', 'Accept for review'); btn('processing', 'Processing'); btn('loan_ok', 'Approve loan', 'btn-primary'); }
    } else if (r.type === 'card') {
      if (!closed) { btn('review', 'Accept for review'); btn('processing', 'Processing'); btn('card_ok', 'Approve & issue card', 'btn-primary'); }
    } else if (r.type === 'account_statement') {
      if (!closed) { btn('review', 'Accept for review'); btn('statement_ok', 'Mark statement sent', 'btn-primary'); }
    } else if (r.type === 'dispute_deposit') {
      if (!closed) { btn('review', 'Accept dispute for review'); btn('processing', 'Process dispute'); btn('resolved', 'Approve dispute', 'btn-primary'); }
    } else if (r.type === 'dispute_withdrawal') {
      if (!closed) { btn('review', 'Accept dispute for review'); btn('processing', 'Accept & process'); btn('resolved', 'Solved', 'btn-primary'); }
    } else if (!closed) { btn('review', 'Accept dispute for review'); btn('processing', 'Process dispute'); btn('resolved', 'Dispute solved / resolved', 'btn-primary'); }
    if (!closed) btn('declined', 'Decline / reject', 'btn-danger');
    if (closed) btn('reopen', 'Reopen', 'btn-ghost');
    return b.join('');
  }
  function adminReqDetail(id) {
    var r = req(id);
    if (!r) return adminShell('requests', 'Request', '', '<div class="card empty"><p>Request not found.</p><a class="btn btn-ghost" href="#/admin/requests">Back</a></div>');
    var u = user(r.userId);
    var tx = '';
    if (r.tx && r.tx.key) {
      var k = r.tx.key.split(':');
      if (k[0] === 'dep') tx = '<a class="btn btn-ghost btn-sm" href="#/admin/deposits">Open deposits</a>';
      if (k[0] === 'wd') tx = '<a class="btn btn-ghost btn-sm" href="#/admin/withdrawals">Open withdrawals</a>';
    }
    return adminShell('requests', typeLabel(r.type), 'Submitted by @' + r.username + ' · ' + dt(r.createdAt),
      '<div class="card"><a class="btn btn-ghost btn-xs" href="#/admin/requests">' + I('back', 12) + ' All requests</a>' +
        '<div class="mt10"><div class="tiny muted">What the user sees now</div>' + statusBox(r) + '</div>' +
        '<div class="row gap8 mt10" style="flex-wrap:wrap">' + actionBtns(r) + '</div>' +
        '<div class="row gap8 mt10" style="flex-wrap:wrap">' +
          '<button class="btn btn-ghost btn-sm" data-act="sc-admin-op" data-id="' + r.id + '" data-op="note">' + I('edit', 13) + ' Note to user</button>' +
          (u ? '<button class="btn btn-ghost btn-sm" data-act="admin-msg-user" data-id="' + u.id + '">' + I('chat', 13) + ' Chat with user</button><a class="btn btn-ghost btn-sm" href="#/admin/user-360/' + u.id + '">' + I('user', 13) + ' User 360</a>' : '') + tx +
          '<button class="btn btn-ghost btn-sm" data-act="sc-admin-op" data-id="' + r.id + '" data-op="delete">' + I('trash', 13) + ' Delete record</button></div></div>' +
      detailsCard(r, true) + timeline(r));
  }
  function user360(id) {
    var u = user(id);
    if (!u) return adminShell('help-desk', 'User', '', '<div class="card empty"><p>User not found.</p></div>');
    var a = ia(u), s = statementData(u);
    var reqs = mine(u);
    var pf = a.portfolios || {};
    return adminShell('help-desk', '@' + u.username, (u.fullName || '') + ' · ' + (u.email || ''),
      '<div class="card"><div class="sc-kv">' +
        '<div><span>Account ID</span><b>' + E(u.accountId || u.referralCode || u.id) + '</b></div><div><span>Created</span><b>' + E(dt(u.createdAt)) + '</b></div><div><span>Joined via</span><b>' + E(s.join) + '</b></div>' +
        '<div><span>Status</span><b>' + (u.banned ? '<span class="down">Banned</span>' : '<span class="up">Active</span>') + '</b></div><div><span>App version</span><b>' + E(u.appVersion ? 'v' + u.appVersion : 'Legacy') + '</b></div>' +
        '<div><span>WC balance</span><b>' + E(coins(u.balance || 0)) + ' WC</b></div><div><span>$ balance</span><b>' + M(u.walletUsd || 0) + '</b></div>' +
        '<div><span>Investment total assets</span><b>' + M(a.usd) + '</b></div><div><span>Payout balance</span><b>' + M(a.payout) + '</b></div>' +
        '<div><span>Stock / WC / B2B / Bot capital</span><b>' + [pf.stock, pf.wc, pf.b2b, pf.bot].map(M).join(' · ') + '</b></div>' +
        '<div><span>Referrals</span><b>' + s.refs + '</b></div><div><span>Vendor</span><b>' + (s.vendor ? '@' + E(s.vendor.username) : 'No') + '</b></div>' +
        '<div><span>Promo eligible</span><b>' + (s.promo ? 'Yes' : 'No') + (u.promoEligible ? ' (set by admin)' : '') + '</b></div>' +
      '</div><div class="row gap8 mt10" style="flex-wrap:wrap">' +
        '<button class="btn btn-soft btn-sm" data-act="admin-user" data-id="' + u.id + '">' + I('edit', 13) + ' Edit balances</button>' +
        '<button class="btn btn-soft btn-sm" data-act="sc-adj-inv" data-id="' + u.id + '">' + I('wallet', 13) + ' Adjust investment $</button>' +
        '<button class="btn btn-soft btn-sm" data-act="admin-credit" data-id="' + u.id + '">' + I('plus', 13) + ' Add / deduct WC</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="admin-msg-user" data-id="' + u.id + '">' + I('chat', 13) + ' Chat</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="admin-notify-user" data-id="' + u.id + '">' + I('bell', 13) + ' Notify</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="sc-promo" data-id="' + u.id + '">' + I('gift', 13) + (u.promoEligible ? ' Remove from lucky winners' : ' Add to lucky winners') + '</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="sc-reset-pin" data-id="' + u.id + '">' + I('key', 13) + ' Reset PIN</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="admin-login-as" data-id="' + u.id + '">' + I('key', 13) + ' Log in as user</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="sc-print">' + I('download', 13) + ' Print statement</button>' +
        '<button class="btn ' + (u.banned ? 'btn-soft' : 'btn-danger') + ' btn-sm" data-act="admin-ban" data-id="' + u.id + '">' + (u.banned ? 'Unban' : 'Ban') + '</button>' +
      '</div></div>' +
      '<div class="card"><div class="card-title">Requests &amp; disputes (' + reqs.length + ')</div>' + adminReqRows(reqs) + '</div>' +
      '<div class="card"><div class="card-title">Transactions</div>' + (function () { var rows = allTx(u).slice(0, 60); return rows.length ? '<div class="sc-txlist">' + rows.map(function (x) { return '<div class="sc-tx"><div class="grow"><b>' + E(x.kind) + ' · ' + M(x.usd) + '</b><div class="tiny muted">' + E(dt(x.at)) + ' · ' + E(x.detail || '') + '</div></div>' + txStatus(x.status) + '</div>'; }).join('') + '</div>' : '<div class="tiny muted">No transactions.</div>'; })() + '</div>' +
      '<div class="card">' + statementHTML(u) + '</div>');
  }
  function serviceSettings() {
    var c = cfg();
    var methods = (Array.isArray(c.payMethods) ? c.payMethods : []);
    var faq = faqItems();
    return adminShell('service-settings', 'Service settings', 'Asset reversal, payment methods, loans, cards and FAQ.',
      '<div class="card"><div class="card-title">Asset reversal</div>' +
        '<div class="field"><label class="label">Booking fee (% of reversal amount)</label><input class="input" id="scSetPct" type="number" step="0.1" value="' + E(c.bookingFeePct) + '"/></div>' +
        '<div class="field"><label class="label">Coin reversal agent link (embedded in the connect button)</label><input class="input" id="scSetLink" placeholder="https://…" value="' + E(c.agentLink) + '"/></div>' +
        '<div class="field"><label class="label">Connect button label</label><input class="input" id="scSetLabel" value="' + E(c.agentLabel) + '"/></div></div>' +
      '<div class="card"><div class="card-title">Company payment methods (booking fees)</div><p class="tiny muted">Leave empty to reuse the vendor payment methods. One method per line: <code>Label | Network | Address</code></p>' +
        '<textarea class="input" id="scSetMethods" rows="4" placeholder="USDT (TRC20) | TRC20 | Txxxxxxxx">' + E(methods.map(function (m) { return [m.label, m.network, m.address].join(' | '); }).join('\n')) + '</textarea></div>' +
      '<div class="card"><div class="card-title">Loans</div><div class="sc-grid2">' +
        '<div class="field"><label class="label">Minimum ($)</label><input class="input" id="scSetLMin" type="number" value="' + E(c.loan.minUsd) + '"/></div>' +
        '<div class="field"><label class="label">Maximum ($)</label><input class="input" id="scSetLMax" type="number" value="' + E(c.loan.maxUsd) + '"/></div>' +
        '<div class="field"><label class="label">Interest per term (%)</label><input class="input" id="scSetLInt" type="number" step="0.1" value="' + E(c.loan.interestPct) + '"/></div>' +
        '<div class="field"><label class="label">Terms in months (comma separated)</label><input class="input" id="scSetLTerms" value="' + E((c.loan.terms || []).join(', ')) + '"/></div></div>' +
        '<div class="field"><label class="label">Note shown to users</label><input class="input" id="scSetLNote" value="' + E(c.loan.note) + '"/></div></div>' +
      '<div class="card"><div class="card-title">Business cards</div><div class="sc-grid2">' +
        '<div class="field"><label class="label">Virtual card fee ($)</label><input class="input" id="scSetCV" type="number" value="' + E(c.card.virtualFeeUsd) + '"/></div>' +
        '<div class="field"><label class="label">Physical card fee ($)</label><input class="input" id="scSetCP" type="number" value="' + E(c.card.physicalFeeUsd) + '"/></div></div>' +
        '<div class="field"><label class="label">Note shown to users</label><input class="input" id="scSetCNote" value="' + E(c.card.note) + '"/></div></div>' +
      '<div class="card"><div class="card-title">FAQ</div><p class="tiny muted">Add your own questions. One block per question: first line <code>Category | Question</code>, then the answer, then a line with <code>---</code>.</p>' +
        '<textarea class="input" id="scSetFaq" rows="6">' + E((c.faq.extra || []).map(function (x) { return (x.cat || 'More') + ' | ' + x.q + '\n' + (x.a || ''); }).join('\n---\n')) + '</textarea>' +
        '<details class="mt10"><summary class="small">Hide built-in questions</summary><div class="sc-list mt6">' + faq.map(function (f) { var hid = c.faq.overrides && c.faq.overrides[f.id] && c.faq.overrides[f.id].hidden; return '<label class="row gap8 tiny"><input type="checkbox" class="scFaqHide" value="' + E(f.id) + '"' + (hid ? ' checked' : '') + '/> ' + E(f.q) + '</label>'; }).join('') + '</div></details></div>' +
      '<button class="btn btn-primary" data-act="sc-settings-save" style="width:100%">Save service settings</button>');
  }

  /* ------------------------------------------------------------ actions: user */
  App.scLive = function () { try { if (typeof App.liveSupport === 'function') return App.liveSupport(); } catch (e) {} try { App.supportChat(); } catch (e) {} };
  App.scCopy = function (id, ds) { if (ds.text) copyText(ds.text); else T('Nothing to copy', 'err'); };
  App.scPaste = function (id, ds) {
    var el = document.getElementById(ds.target);
    if (!el) return;
    if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then(function (t) { el.value = String(t || '').replace(/\D/g, '').slice(0, 6); }).catch(function () { el.focus(); T('Long-press the box and choose Paste', 'ok'); });
    else { el.focus(); T('Long-press the box and choose Paste', 'ok'); }
  };
  App.scPrint = function () {
    var el = document.getElementById('scStmt'); if (!el) return;
    var w = window.open('', '_blank');
    if (!w) return T('Allow pop-ups to download the statement', 'err');
    w.document.write('<!doc'+'type html><ht'+'ml><head><title>WhaleChat statement</title><style>body{font-family:Arial,sans-serif;color:#111;padding:24px;font-size:12px}h2{margin:0}h3{margin:18px 0 6px;border-bottom:1px solid #ccc;padding-bottom:4px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ddd;padding:5px;text-align:left;vertical-align:top}.tiny{font-size:10px;color:#666}.up{color:#0a7d33}.down{color:#b3261e}.between{display:flex;justify-content:space-between}.sc-chip{font-weight:bold}</style></head><body>' + el.innerHTML + '<script>setTimeout(function(){window.print()},300)<\/script><\/body><\/html>');
    w.document.close();
  };
  App.scPick = function (id, ds) {
    var u = me(); if (!u) return;
    S.sel = ds.key; S.selKind = ds.kind;
    document.querySelectorAll('.sc-tx').forEach(function (el) { el.classList.toggle('on', el.getAttribute('data-key') === ds.key); });
    var x = findTx(u, ds.key); if (!x) return;
    if (ds.kind === 'dispute_reversal') {
      var w = (DB.withdrawals || []).find(function (q) { return 'wd:' + q.id === ds.key; });
      var box = document.getElementById('scRevBox'), auto = document.getElementById('scRevAuto');
      if (box && auto && w) {
        auto.innerHTML = '<div><span>Withdrawal submitted</span><b>' + E(dt(w.createdAt)) + '</b></div>' +
          '<div><span>Withdrawal method</span><b>' + E(wdMethod(w)) + '</b></div>' +
          '<div><span>Withdrawal network</span><b>' + E(w.network || '') + '</b></div>' +
          '<div><span>Receiving address</span><b class="sc-addr">' + E(w.address || '') + '</b></div>' +
          '<div><span>Withdrawal status</span><b>Approved &amp; sent to user\'s provided withdrawal details</b></div>' +
          '<div><span>Amount withdrawn</span><b>' + M(x.usd) + '</b></div>';
        box.style.display = '';
        var amt = document.getElementById('scRevAmt'); if (amt) { amt.max = R2(x.usd); amt.value = R2(x.usd); revFee(); }
        box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    var dbox = document.getElementById('scDescBox'), info = document.getElementById('scSelInfo');
    if (dbox) { dbox.style.display = ''; if (info) info.innerHTML = 'Selected: <b>' + E(x.kind) + ' · ' + M(x.usd) + '</b> · ' + E(dt(x.at)) + ' · ' + E(x.status); dbox.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  };
  function revFee() {
    var amt = Number(val('scRevAmt')) || 0, pct = Number(cfg().bookingFeePct) || 5, out = document.getElementById('scRevFee');
    if (out) out.innerHTML = amt > 0 ? 'Booking fee = ' + pct + '% × ' + M(amt) + ' = <b>' + M(amt * pct / 100) + '</b>' : 'Booking fee = ' + pct + '% × reversal amount.';
  }
  App.scMethod = function (id, ds) {
    document.querySelectorAll('.sc-method[data-group="' + ds.group + '"]').forEach(function (el) { el.classList.toggle('on', el.getAttribute('data-id') === ds.id); });
  };
  function selMethod(group, methods) {
    var el = document.querySelector('.sc-method.on[data-group="' + group + '"]');
    var id = el ? el.getAttribute('data-id') : null;
    return methods.find(function (m, i) { return (m.id || String(i)) === id; }) || methods[0] || null;
  }
  App.scDisputeSubmit = function (id, ds) {
    var u = me(); if (!u) return;
    var x = S.sel ? findTx(u, S.sel) : null;
    if (!x) return T('Select a transaction first', 'err');
    var text = val('scDescText');
    if (text.length < 5) return T('Describe the issue', 'err');
    var dup = list().find(function (r) { return r.userId === u.id && r.type === ds.kind && r.tx && r.tx.key === x.key && !/resolved|approved|completed|declined/.test(r.status); });
    if (dup) { T('You already have an open dispute for this transaction', 'err'); return go('investment/sr/' + dup.id); }
    var r = newReq(u, ds.kind, { tx: x, text: text, summary: x.kind + ' ' + M(x.usd) + ' — ' + text.slice(0, 50) });
    adminNotify('New ' + typeLabel(ds.kind).toLowerCase(), '@' + u.username + ': ' + x.kind + ' ' + M(x.usd) + ' — ' + text.slice(0, 80), r.id);
    S.sel = null; save(); T('Dispute submitted', 'ok'); go('investment/sr/' + r.id);
  };
  App.scCustomSubmit = function () {
    var u = me(); var text = val('scCustomText');
    if (text.length < 5) return T('Describe your request or issue', 'err');
    var r = newReq(u, 'dispute_custom', { text: text, summary: text.slice(0, 60) });
    adminNotify('New request / issue', '@' + u.username + ': ' + text.slice(0, 90), r.id);
    save(); T('Submitted — we will get back to you within 24–48hrs', 'ok'); go('investment/sr/' + r.id);
  };
  App.scLoanSubmit = function () {
    var u = me(), c = cfg().loan;
    var amt = Number(val('scLoanAmt')), term = Number(val('scLoanTerm')) || 1;
    if (!(amt >= c.minUsd && amt <= c.maxUsd)) return T('Enter an amount between ' + M(c.minUsd) + ' and ' + M(c.maxUsd), 'err');
    var income = val('scLoanIncome'); if (!income) return T('Enter your income / repayment source', 'err');
    var repay = R2(amt * (1 + (Number(c.interestPct) || 0) / 100));
    var r = newReq(u, 'loan', { amountUsd: amt, termMonths: term, interestPct: c.interestPct, repayUsd: repay, purpose: val('scLoanPurpose'), income: income, text: val('scLoanNote'), summary: M(amt) + ' · ' + term + ' mo' });
    adminNotify('New loan request', '@' + u.username + ' requested ' + M(amt) + ' for ' + term + ' month(s).', r.id);
    save(); T('Loan request submitted', 'ok'); go('investment/sr/' + r.id);
  };
  App.scCardSubmit = function () {
    var u = me(); var type = val('scCardType'), name = val('scCardName'), addr = val('scCardAddr');
    if (!name) return T('Enter the name on the card', 'err');
    if (type !== 'virtual' && addr.length < 8) return T('Enter a delivery address for the physical card', 'err');
    var r = newReq(u, 'card', { cardType: type, nameOnCard: name, phone: val('scCardPhone'), address: addr, use: val('scCardUse'), spendUsd: Number(val('scCardSpend')) || 0, summary: type + ' card' });
    adminNotify('New card request', '@' + u.username + ' requested a ' + type + ' WhaleChat business card.', r.id);
    save(); T('Card request submitted', 'ok'); go('investment/sr/' + r.id);
  };
  App.scRevStart = function () {
    var u = me();
    var w = (DB.withdrawals || []).find(function (q) { return S.sel && 'wd:' + q.id === S.sel; });
    if (!w) return T('Select a withdrawal first', 'err');
    var amt = Number(val('scRevAmt')), max = Number(w.usd) || (Number(w.coins) || 0) * rate();
    if (!(amt > 0)) return T('Enter the reversal amount', 'err');
    if (amt > max + 0.01) return T('Reversal amount cannot exceed ' + M(max), 'err');
    var m = selMethod('rev', payMethods()); if (!m) return T('No payment method available — contact support', 'err');
    var pct = Number(cfg().bookingFeePct) || 5;
    var r = newReq(u, 'dispute_reversal', {
      status: 'awaiting_payment', payIntentAt: Date.now(),
      tx: findTx(u, S.sel), wd: { id: w.id, at: w.createdAt, method: wdMethod(w), network: w.network || '', address: w.address || '' },
      amountUsd: R2(amt), feePct: pct, feeUsd: R2(amt * pct / 100), method: { id: m.id, label: m.label || m.name, network: m.network || '', address: m.address || '' },
      text: val('scRevText'), summary: 'Reverse ' + M(amt) + ' · fee ' + M(amt * pct / 100)
    });
    r.log[0].status = 'awaiting_payment';
    S.sel = null; save(); go('investment/sr/' + r.id);
  };
  App.scVnStart = function () {
    var u = me();
    var name = val('scVnName').replace(/^@/, '');
    if (!/^[a-z0-9_.]{3,24}$/i.test(name)) return T('Vendor username: 3–24 letters, numbers, _ or .', 'err');
    if ((DB.vendors || []).some(function (v) { return String(v.username).toLowerCase() === name.toLowerCase(); })) return T('That vendor username is taken', 'err');
    var plan = vendorPlans().find(function (p) { return p.id === val('scVnPlan'); });
    if (!plan) return T('Choose a duration', 'err');
    var m = selMethod('vn', vendorMethods()); if (!m) return T('No payment method available — contact support', 'err');
    var amt = Number(val('scVnAmt')); if (!(amt > 0)) return T('Enter the amount', 'err');
    if (amt + 0.001 < Number(plan.priceUsd)) return T('The amount must be at least ' + M(plan.priceUsd) + ' for this duration', 'err');
    var r = newReq(u, 'account_vendor', { status: 'awaiting_payment', payIntentAt: Date.now(), vendorUsername: name, planId: plan.id, months: plan.months, feeUsd: R2(amt), method: { id: m.id, label: m.label, network: m.network || '', address: m.address || '' }, summary: '@' + name + ' · ' + plan.months + ' mo · ' + M(amt) });
    r.log[0].status = 'awaiting_payment';
    save(); go('investment/sr/' + r.id);
  };
  App.scSlip = async function (id) {
    try {
      var f = await pickFile({ accept: 'image/*' }); if (!f) return;
      var data = null;
      try { var b = await compressImage(f, 1100, 0.72); data = (typeof b === 'string') ? b : await fileToDataURL(b); } catch (e) { data = await fileToDataURL(f); }
      S.slip = data; S.slipFor = id;
      var p = document.getElementById('scSlipPrev'); if (p) p.innerHTML = '<img src="' + data + '" class="sc-slip"/>';
    } catch (e) { T('Could not read that image', 'err'); }
  };
  App.scSlipSubmit = function (id) {
    var u = me(); var r = req(id); if (!r || r.userId !== u.id) return;
    var proof = (S.slipFor === id && S.slip) || r.proof;
    if (!proof) return T('Upload your payment slip first', 'err');
    r.proof = proof; r.paidAt = Date.now(); r.adminNote = '';
    setStatus(r, 'payment_submitted', 'Payment slip uploaded');
    if (r.type === 'account_vendor') {
      DB.vendorApplications = DB.vendorApplications || [];
      var app = { id: (typeof uid === 'function' ? uid('vap') : nid('vap_')), kind: 'new', userId: u.id, vendorUsername: r.vendorUsername, feeUsd: r.feeUsd, planId: r.planId, months: r.months, methodId: r.method.id, methodLabel: r.method.label, address: r.method.address, proof: proof, status: 'pending', createdAt: Date.now(), serviceRequestId: r.id };
      DB.vendorApplications.unshift(app); r.vendorAppId = app.id;
    }
    S.slip = null; S.slipFor = null;
    try { localStorage.removeItem('wc_sc_pending'); } catch (e) {}
    adminNotify(r.type === 'account_vendor' ? 'Vendor upgrade payment submitted' : 'Asset reversal booking fee submitted', '@' + u.username + ' paid ' + M(r.feeUsd) + ' — confirm the payment slip.', r.id);
    save(); T('Submitted — waiting for admin confirmation', 'ok'); render();
  };
  App.scAgent = function (id) {
    var r = req(id); var link = String(cfg().agentLink || '').trim();
    if (r && !r.agentClickedAt) { r.agentClickedAt = Date.now(); save(); adminNotify('User opened the reversal agent link', '@' + r.username + ' tapped Connect with a coin reversal agent.', r.id); }
    if (!/^https?:\/\//i.test(link)) { T('The agent link is being set up — connecting you to live support', 'ok'); return App.scLive(); }
    window.open(link, '_blank', 'noopener');
  };
  App.scDelSend = async function () {
    var u = me(); S.delReason = val('scDelReason');
    if (S.delReason.length < 5) return T('Describe why you want to delete your account first', 'err');
    var st = document.getElementById('scDelState');
    try {
      var res = await fetch(api('/api/verify/send'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id, purpose: 'delete' }) });
      var j = await res.json().catch(function () { return {}; });
      if (!res.ok || !j.ok) return T(j.message || 'Could not send the code', 'err');
      if (st) st.innerHTML = '<span class="up">' + (j.emailed ? 'Code sent to ' + E(j.to) + '. ' : '') + 'A copy is also in your notifications.</span>';
      T('Verification code sent', 'ok');
    } catch (e) { T('Could not reach the server — check your connection', 'err'); }
  };
  App.scDelVerify = async function () {
    var u = me(); var code = val('scDelCode').replace(/\D/g, '');
    if (code.length !== 6) return T('Enter the 6-digit code', 'err');
    try {
      var res = await fetch(api('/api/verify/check'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id, purpose: 'delete', code: code }) });
      var j = await res.json().catch(function () { return {}; });
      if (!res.ok || !j.ok) return T(j.message || 'Incorrect code', 'err');
      S.delVerified = j.verifiedAt || Date.now(); S.delCode = code;
      var st = document.getElementById('scDelState'); if (st) st.innerHTML = '<span class="up">Email verified ✓</span>';
      var b = document.getElementById('scDelSubmit'); if (b) b.disabled = false;
      T('Email verified', 'ok');
    } catch (e) { T('Could not reach the server', 'err'); }
  };
  App.scDelSubmit = function () {
    var u = me(); if (!S.delVerified) return T('Verify your email first', 'err');
    var reason = val('scDelReason') || S.delReason || '';
    if (reason.length < 5) return T('Describe the reason', 'err');
    var r = newReq(u, 'account_delete', { text: reason, verifiedAt: S.delVerified, summary: reason.slice(0, 60) });
    S.delVerified = false; S.delCode = ''; S.delReason = '';
    adminNotify('Account deletion request', '@' + u.username + ' requested account deletion (email verified).', r.id);
    save(); T('Delete request submitted', 'ok'); go('investment/sr/' + r.id);
  };
  App.scUpgSubmit = function () {
    var u = me(); var idv = val('scUpgId').toLowerCase();
    var ok = [u.username, u.email, u.accountId, u.referralCode, u.id].some(function (v) { return v && String(v).toLowerCase() === idv.replace(/^@/, ''); });
    if (!ok) return T('Enter your own username, account ID or email', 'err');
    var r = newReq(u, 'account_upgrade', { identifier: val('scUpgId'), fromVersion: u.appVersion || '', summary: 'Upgrade ' + (u.appVersion ? 'v' + u.appVersion : 'legacy') + ' → latest' });
    adminNotify('Account upgrade request', '@' + u.username + ' requested an upgrade to the latest version.', r.id);
    save(); T('Upgrade request submitted', 'ok'); go('investment/sr/' + r.id);
  };
  App.scStmtRequest = function () {
    var u = me();
    var open = mine(u).find(function (r) { return r.type === 'account_statement' && !/resolved|declined/.test(r.status); });
    if (open) return T('You already have an open statement request', 'err');
    var r = newReq(u, 'account_statement', { summary: 'Official statement copy' });
    adminNotify('Statement request', '@' + u.username + ' requested an official account statement.', r.id);
    save(); T('Statement request submitted', 'ok'); render();
  };
  App.scFaqCat = function (id, ds) {
    var g = document.querySelector('.sc-faq-group[data-cat="' + (window.CSS && CSS.escape ? CSS.escape(ds.cat) : ds.cat) + '"]');
    if (g) g.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /* ------------------------------------------------------------ actions: admin */
  App.scUserSearch = function () { go('admin/help-desk?q=' + encodeURIComponent(val('scUserQ'))); };
  App.scFilter = function () {
    var p = []; if (val('scFType')) p.push('type=' + encodeURIComponent(val('scFType'))); if (val('scFStatus')) p.push('status=' + encodeURIComponent(val('scFStatus'))); if (val('scFQ')) p.push('q=' + encodeURIComponent(val('scFQ')));
    go('admin/requests' + (p.length ? '?' + p.join('&') : ''));
  };
  App.scLegacy = function (id, ds) {
    var u = user(ds.uid); if (!u) return;
    var r = ((u.investAcct || {}).requests || []).find(function (x) { return x.id === ds.id; }); if (!r) return;
    r.status = ds.op; r.updatedAt = Date.now();
    try { notify(u.id, 'Request ' + ds.op, 'Your ' + (r.kind === 'loan' ? 'loan' : 'card') + ' request was ' + ds.op + '.', '#/investment/more', 'shield'); } catch (e) {}
    save(); render();
  };
  /* like promptDialog, but an empty OK returns '' (only Cancel returns null) */
  function scPrompt(opts) {
    return new Promise(function (resolve) {
      openModal(modalShell(opts.title || 'Enter value', '<div class="field"><label class="label">' + esc(opts.label || '') + '</label>' +
        '<input class="input" id="sc_pd_input" type="' + (opts.type || 'text') + '" placeholder="' + esc(opts.placeholder || '') + '" value="' + esc(opts.value || '') + '"></div>',
        '<button class="btn btn-ghost" id="sc_pd_cancel">Cancel</button><button class="btn btn-primary" id="sc_pd_ok">' + esc(opts.ok || 'Save') + '</button>'));
      var inp = document.getElementById('sc_pd_input');
      var done = function (v) { closeModal(); resolve(v); };
      setTimeout(function () { try { inp.focus(); } catch (e) {} }, 60);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') done(inp.value.trim()); });
      document.getElementById('sc_pd_cancel').onclick = function () { done(null); };
      document.getElementById('sc_pd_ok').onclick = function () { done(inp.value.trim()); };
    });
  }
  App.scAdminOp = async function (id, ds) {
    if (!isAdmin()) return;
    var r = req(id); if (!r) return;
    var op = ds.op, u = user(r.userId);
    var simple = { review: 'Accepted for review', processing: 'Processing started', resolved: 'Resolved' };
    if (simple[op]) {
      setStatus(r, op, simple[op]);
      var title = { review: 'Under review', processing: 'Processing now', resolved: r.type === 'dispute_deposit' ? 'Deposit dispute approved 🎉' : 'Dispute resolved 🎉' }[op];
      userNotify(r, title + ' · ' + typeLabel(r.type), statusInfo(r).msg);
    } else if (op === 'declined') {
      var why = await scPrompt({ title: 'Decline ' + typeLabel(r.type).toLowerCase(), label: 'Note to user (optional)', placeholder: 'Reason shown to the user' });
      if (why === null) return;
      r.adminNote = why || ''; setStatus(r, 'declined', why || 'Declined');
      userNotify(r, typeLabel(r.type) + ' declined', statusInfo(r).msg);
    } else if (op === 'reopen') {
      setStatus(r, 'review', 'Reopened by admin'); userNotify(r, typeLabel(r.type) + ' reopened', statusInfo(r).msg);
    } else if (op === 'note') {
      var n = await scPrompt({ title: 'Note to user', label: 'Shown on the request page and sent as a notification', value: r.adminNote || '' });
      if (n === null) return;
      r.adminNote = n; r.updatedAt = Date.now(); r.log.push({ at: Date.now(), status: r.status, by: me().username, note: 'Admin note: ' + n });
      if (n) userNotify(r, 'Update on your ' + typeLabel(r.type).toLowerCase(), n);
    } else if (op === 'delete') {
      if (!await confirmDialog({ title: 'Delete this record?', body: 'The request is removed for the user as well.', danger: true, ok: 'Delete' })) return;
      DB.serviceRequests = list().filter(function (x) { return x.id !== id; }); save(); T('Deleted', 'ok'); return go('admin/requests');
    } else if (op === 'pay_ok') {
      if (!await confirmDialog({ title: 'Approve payment?', body: 'Confirm you received ' + M(r.feeUsd) + ' from @' + r.username + '.', ok: 'Approve payment' })) return;
      setStatus(r, 'payment_approved', 'Booking fee confirmed');
      userNotify(r, 'Payment approved ✅', 'Your payment has been successfully approved. Tap to connect with a coin reversal agent.');
    } else if (op === 'pay_bad') {
      var w = await scPrompt({ title: 'Reject payment slip', label: 'Reason (shown to the user)', placeholder: 'e.g. slip not readable / amount not received' });
      if (w === null) return;
      r.adminNote = w || ''; r.payIntentAt = Date.now(); setStatus(r, 'payment_rejected', w || 'Payment slip rejected');
      if (r.vendorAppId) { var ap = (DB.vendorApplications || []).find(function (x) { return x.id === r.vendorAppId; }); if (ap && ap.status === 'pending') { ap.status = 'rejected'; ap.note = w || ''; ap.reviewedAt = Date.now(); } r.vendorAppId = null; }
      userNotify(r, 'Payment slip rejected', 'Upload a clear payment slip and submit again.' + (w ? ' Note: ' + w : ''));
    } else if (op === 'connected') {
      setStatus(r, 'processing', 'User connected with a coin reversal agent');
      userNotify(r, 'Asset reversal processing', 'You are connected with a coin reversal agent. Your asset reversal is processing now.');
    } else if (op === 'completed') {
      var amt = await scPrompt({ title: 'Complete asset reversal', label: 'USD to credit to the user\'s WhaleChat WC balance (0 to skip)', type: 'number', value: String(r.amountUsd || 0) });
      if (amt === null) return;
      var usdAmt = Math.max(0, Number(amt) || 0);
      if (usdAmt > 0 && u) {
        var c = R2(usdAmt / rate());
        u.balance = R2((Number(u.balance) || 0) + c);
        try { tx(u.id, 'deposit', 'Asset reversal credited · ' + M(usdAmt), c, { serviceRequestId: r.id }); } catch (e) {}
        r.creditedUsd = usdAmt;
      }
      setStatus(r, 'completed', usdAmt ? 'Credited ' + M(usdAmt) : 'Completed');
      userNotify(r, 'Asset reversed successfully 🎉', 'Asset reversed successfully and sent to your WhaleChat account balance.');
    } else if (op === 'vendor_ok') {
      var app = (DB.vendorApplications || []).find(function (x) { return x.id === r.vendorAppId; });
      if (!app) return T('Linked vendor application not found', 'err');
      if (app.status === 'pending' && typeof App.vendorAppApprove === 'function') await App.vendorAppApprove(app.id);
      if (app.status !== 'approved') return;
      setStatus(r, 'approved', 'Vendor profile activated');
    } else if (op === 'delete_ok') {
      if (!u) { setStatus(r, 'approved', 'User already removed'); save(); return render(); }
      if (u.role === 'admin') return T('Admin accounts cannot be deleted here', 'err');
      if (!await confirmDialog({ title: 'Delete @' + u.username + '?', body: 'This permanently deletes the account, its vendor profile, contacts and notifications. Records of orders and transactions are kept.', danger: true, ok: 'Approve & delete' })) return;
      setStatus(r, 'approved', 'Account deleted');
      DB.users = DB.users.filter(function (x) { return x.id !== u.id; });
      DB.vendors = (DB.vendors || []).filter(function (v) { return v.userId !== u.id; });
      DB.contacts = (DB.contacts || []).filter(function (c2) { return c2.ownerId !== u.id && c2.userId !== u.id; });
      DB.notifications = (DB.notifications || []).filter(function (n2) { return n2.userId !== u.id; });
    } else if (op === 'upgrade_ok') {
      if (!u) return T('User not found', 'err');
      var ver = window.__scLatest || '';
      if (!ver) { try { var res = await fetch('release.json?t=' + Date.now(), { cache: 'no-store' }); var j = await res.json(); ver = j.version || ''; window.__scLatest = ver; } catch (e) {} }
      ver = ver || (typeof APP_VERSION !== 'undefined' ? APP_VERSION : '');
      u.appVersion = ver; u.upgradedAt = Date.now(); u.forceRefreshAt = Date.now();
      r.version = ver; setStatus(r, 'approved', 'Upgraded to v' + ver);
      userNotify(r, 'Account upgraded 🎉', 'Your account was upgraded to WhaleChat v' + ver + '. The app reloads to the latest version automatically.');
    } else if (op === 'loan_ok') {
      var dis = await scPrompt({ title: 'Approve loan', label: 'Amount to credit to the investment account (USD, 0 = approve only)', type: 'number', value: String(r.amountUsd || 0) });
      if (dis === null) return;
      var dv = Math.max(0, Number(dis) || 0);
      if (dv > 0 && u) {
        var a = ia(u); a.usd = R2((Number(a.usd) || 0) + dv);
        a.ledger = a.ledger || []; a.ledger.unshift({ id: nid('il_'), label: 'Loan disbursed · ' + M(dv), usd: dv, coins: 0, meta: { serviceRequestId: r.id }, at: Date.now() });
        r.disbursedUsd = dv;
      }
      setStatus(r, 'approved', dv ? 'Disbursed ' + M(dv) : 'Approved');
      userNotify(r, 'Loan approved 🎉', statusInfo(r).msg);
    } else if (op === 'card_ok') {
      var l4 = await scPrompt({ title: 'Issue card', label: 'Card details for the user — last 4 digits, expiry, tracking/note (e.g. 4821 | 11/29 | DHL 12345)', placeholder: '4821 | 11/29 | tracking or note' });
      if (l4 === null) return;
      var parts = String(l4 || '').split('|').map(function (s) { return s.trim(); });
      r.card = { last4: (parts[0] || '').replace(/\D/g, '').slice(-4), expiry: parts[1] || '', tracking: parts[2] || '', note: parts.slice(3).join(' | ') };
      setStatus(r, 'approved', 'Card issued');
      userNotify(r, 'Card issued 🎉', 'Your WhaleChat business card has been issued' + (r.card.last4 ? ' (•••• ' + r.card.last4 + ')' : '') + '.');
    } else if (op === 'statement_ok') {
      var nt = await scPrompt({ title: 'Statement sent', label: 'Note to user (e.g. sent to your email)', value: 'Sent to your registered email.' });
      if (nt === null) return;
      r.adminNote = nt || ''; setStatus(r, 'resolved', 'Statement sent');
      userNotify(r, 'Account statement issued', nt || 'Your official statement has been issued.');
    }
    if (!r.seenAt) r.seenAt = Date.now();
    save(); T('Updated', 'ok'); render();
  };
  App.scAdjInv = async function (id) {
    var u = user(id); if (!u) return;
    var v = await scPrompt({ title: 'Adjust investment total assets', label: 'USD amount (negative to deduct)', type: 'number', placeholder: '50' });
    if (!v) return; var amt = Number(v); if (!isFinite(amt) || !amt) return T('Enter a valid amount', 'err');
    var a = ia(u); a.usd = R2((Number(a.usd) || 0) + amt);
    a.ledger = a.ledger || []; a.ledger.unshift({ id: nid('il_'), label: 'Admin adjustment', usd: amt, coins: 0, meta: { admin: true }, at: Date.now() });
    try { notify(u.id, 'Investment account adjusted', M(Math.abs(amt)) + (amt > 0 ? ' added to' : ' deducted from') + ' your investment total assets by the WhaleChat team.', '#/investment', 'wallet'); } catch (e) {}
    save(); T('Investment balance updated', 'ok'); render();
  };
  App.scPromo = function (id) {
    var u = user(id); if (!u) return;
    u.promoEligible = !u.promoEligible; u.luckyWinner = u.promoEligible;
    if (u.promoEligible) try { notify(u.id, 'You are on the lucky winners list 🎉', 'Your account is now eligible for WhaleChat bonus and promo opportunities.', '#/bonuses', 'gift'); } catch (e) {}
    save(); T(u.promoEligible ? 'Added to lucky winners' : 'Removed from lucky winners', 'ok'); render();
  };
  App.scResetPin = async function (id) {
    var u = user(id); if (!u) return;
    if (!await confirmDialog({ title: 'Reset transaction PIN?', body: 'The user will be asked to set a new PIN.', ok: 'Reset PIN' })) return;
    u.pin = null; try { notify(u.id, 'Transaction PIN reset', 'Your transaction PIN was reset by support. Set a new PIN in your profile.', '#/profile', 'key'); } catch (e) {}
    save(); T('PIN reset', 'ok'); render();
  };
  App.scSettingsSave = function () {
    if (!isAdmin()) return;
    DB.settings = DB.settings || {};
    var methods = val('scSetMethods').split('\n').map(function (l, i) { var p = l.split('|').map(function (s) { return s.trim(); }); return p[0] && p[2] ? { id: 'scpm_' + i, label: p[0], network: p[1] || '', address: p[2] } : null; }).filter(Boolean);
    var extra = val('scSetFaq').split(/\n-{3,}\n?/).map(function (b, i) { var lines = b.trim().split('\n'); if (!lines[0]) return null; var h = lines[0].split('|'); var cat = h.length > 1 ? h[0].trim() : 'More'; var q = (h.length > 1 ? h.slice(1).join('|') : h[0]).trim(); return q ? { id: 'x' + i, cat: cat, q: q, a: lines.slice(1).join('\n').trim() } : null; }).filter(Boolean);
    var overrides = {}; document.querySelectorAll('.scFaqHide').forEach(function (cb) { if (cb.checked) overrides[cb.value] = { hidden: true }; });
    DB.settings.serviceCenter = {
      bookingFeePct: Math.max(0, Number(val('scSetPct')) || 0), agentLink: val('scSetLink'), agentLabel: val('scSetLabel') || DEF.agentLabel, payMethods: methods,
      loan: { minUsd: Number(val('scSetLMin')) || 0, maxUsd: Number(val('scSetLMax')) || 0, interestPct: Number(val('scSetLInt')) || 0, terms: val('scSetLTerms').split(',').map(function (s) { return Number(s.trim()); }).filter(function (n) { return n > 0; }), note: val('scSetLNote') },
      card: { virtualFeeUsd: Number(val('scSetCV')) || 0, physicalFeeUsd: Number(val('scSetCP')) || 0, note: val('scSetCNote') },
      faq: { overrides: overrides, extra: extra }, updatedAt: Date.now()
    };
    save(); T('Service settings saved', 'ok'); render();
  };

  /* ------------------------------------------------------------ pending payment popup */
  function pendingPayment() {
    var u = me(); if (!u || u.role === 'admin') return null;
    return list().filter(function (r) { return r.userId === u.id && r.payIntentAt && /awaiting_payment|payment_rejected/.test(r.status); }).sort(function (a, b) { return b.payIntentAt - a.payIntentAt; })[0] || null;
  }
  function maybePopup(force) {
    try {
      var r = pendingPayment(); if (!r) return;
      if (location.hash.indexOf('#/investment/sr/' + r.id) === 0) return;
      var ov = document.getElementById('overlay'); if (ov && ov.innerHTML.trim()) return;
      var key = 'wc_sc_pop_' + r.id;
      if (!force && sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
      openModal(modalShell('Complete pending payment', '<div class="sc-status sc-warn"><div class="sc-status-l">Pending payment</div>You have an unfinished payment of <b>' + M(r.feeUsd) + '</b> for your ' + E(typeLabel(r.type).toLowerCase()) + '. Upload your payment slip to finish your request.</div>',
        '<button class="btn btn-ghost" data-close>Later</button><button class="btn btn-primary" data-act="sc-resume" data-id="' + r.id + '" data-close>Complete payment</button>'), { width: '420px' });
    } catch (e) {}
  }
  App.scResume = function (id) { try { closeModal(); } catch (e) {} go('investment/sr/' + id); };

  /* ------------------------------------------------------------ routes */
  function install() {
    if (typeof VIEWS === 'undefined' || !VIEWS.__wcInvestHub || !VIEWS.investment) return false;
    if (VIEWS.__wcServiceCenter) return true;
    var baseInv = VIEWS.investment;
    VIEWS.investment = function (parts, params) {
      var u = me(); if (!u) return baseInv.apply(this, arguments);
      var sub = (parts && parts[1]) || '', p2 = (parts && parts[2]) || '';
      if (sub === 'more') return moreHub(u);
      if (sub === 'loan') return loanPage(u);
      if (sub === 'card') return cardPage(u);
      if (sub === 'faq') return faqPage(u, params);
      if (sub === 'sr' && p2) return srPage(u, p2);
      if (sub === 'statement') return statementPage(u);
      if (sub === 'disputes') {
        if (p2 === 'tx') return txDisputePage(u);
        if (p2 === 'withdrawal') return wdDisputePage(u);
        if (p2 === 'deposit') return depDisputePage(u);
        if (p2 === 'reversal') return reversalPage(u);
        if (p2 === 'account') return accountHub(u);
        return disputesHub(u);
      }
      if (sub === 'account') {
        if (p2 === 'delete') return deletePage(u, params);
        if (p2 === 'upgrade') return upgradePage(u);
        if (p2 === 'vendor') return vendorPage(u);
        if (p2 === 'statement') return statementPage(u);
        return accountHub(u);
      }
      return baseInv.apply(this, arguments);
    };
    if (typeof AFTER !== 'undefined') {
      var prevAfter = AFTER.investment;
      AFTER.investment = function (parts, params) {
        if (typeof prevAfter === 'function') { try { prevAfter.apply(this, arguments); } catch (e) {} }
        var sub = (parts && parts[1]) || '', p2 = (parts && parts[2]) || '';
        if (sub === 'loan') {
          var la = document.getElementById('scLoanAmt'), lt = document.getElementById('scLoanTerm'), lc = document.getElementById('scLoanCalc');
          var upd = function () { var c = cfg().loan, v = Number(la.value) || 0; lc.innerHTML = v > 0 ? 'Interest ' + c.interestPct + '% → estimated total repayment <b>' + M(v * (1 + c.interestPct / 100)) + '</b> over ' + lt.value + ' month(s) ≈ <b>' + M(v * (1 + c.interestPct / 100) / (Number(lt.value) || 1)) + '</b>/month.' : 'Interest rate: <b>' + c.interestPct + '%</b> per term. Enter an amount to see the estimated repayment.'; };
          if (la && lt && lc) { la.oninput = upd; lt.onchange = upd; }
        }
        if (sub === 'card') {
          var ct = document.getElementById('scCardType'), aw = document.getElementById('scCardAddrWrap');
          if (ct && aw) { var f = function () { aw.style.display = ct.value === 'virtual' ? 'none' : ''; }; ct.onchange = f; f(); }
        }
        if (sub === 'disputes' && p2 === 'reversal') { var ra = document.getElementById('scRevAmt'); if (ra) ra.oninput = revFee; }
        if (sub === 'account' && p2 === 'vendor') {
          var pl = document.getElementById('scVnPlan'), am = document.getElementById('scVnAmt');
          if (pl && am) pl.onchange = function () { var o = pl.options[pl.selectedIndex]; am.value = o ? o.getAttribute('data-price') : ''; };
        }
        if (sub === 'account' && p2 === 'delete') {
          var dr = document.getElementById('scDelReason'); if (dr) dr.oninput = function () { S.delReason = dr.value; };
          if (params && params.code && !S.delVerified) { var ci = document.getElementById('scDelCode'); if (ci) { ci.value = String(params.code).replace(/\D/g, '').slice(0, 6); try { copyText(ci.value); } catch (e) {} } }
        }
        if (sub === 'account' && p2 === 'upgrade') {
          fetch('release.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { window.__scLatest = j.version || ''; var el = document.getElementById('scLatestVer'); if (el) el.textContent = j.version ? 'v' + j.version : '—'; }).catch(function () {});
        }
        if (sub === 'faq') {
          var s = document.getElementById('scFaqSearch');
          if (s) s.oninput = function () {
            var q = s.value.trim().toLowerCase();
            document.querySelectorAll('.sc-faq').forEach(function (el) { var hit = !q || el.textContent.toLowerCase().indexOf(q) >= 0; el.style.display = hit ? '' : 'none'; if (q && hit) el.open = true; });
            document.querySelectorAll('.sc-faq-group').forEach(function (g) { g.style.display = Array.prototype.some.call(g.querySelectorAll('.sc-faq'), function (el) { return el.style.display !== 'none'; }) ? '' : 'none'; });
          };
          if (params && params.q) { var el = document.getElementById('faq-' + params.q); if (el) setTimeout(function () { el.scrollIntoView({ behavior: 'smooth' }); }, 60); }
        }
        if (sub === 'sr' && p2) {
          var r = req(p2);
          if (r && r.payIntentAt && /awaiting_payment|payment_rejected/.test(r.status)) { try { localStorage.setItem('wc_sc_pending', r.id); } catch (e) {} }
        }
      };
    }
    var baseAdmin = VIEWS.admin;
    if (baseAdmin) {
      VIEWS.admin = function (parts, params) {
        var sub = (parts && parts[1]) || '';
        if (isAdmin()) {
          if (sub === 'help-desk') return helpDesk(params);
          if (sub === 'requests') return parts[2] ? adminReqDetail(parts[2]) : adminRequests(params);
          if (sub === 'user-360' && parts[2]) return user360(parts[2]);
          if (sub === 'service-settings') return serviceSettings();
        }
        return baseAdmin.apply(this, arguments);
      };
      var prevAdminAfter = typeof AFTER !== 'undefined' ? AFTER.admin : null;
      if (typeof AFTER !== 'undefined') AFTER.admin = function (parts) {
        if (typeof prevAdminAfter === 'function') { try { prevAdminAfter.apply(this, arguments); } catch (e) {} }
        if (parts && parts[1] === 'requests' && parts[2] && isAdmin()) {
          var r = req(parts[2]);
          if (r && !r.seenAt) {
            r.seenAt = Date.now();
            if (r.status === 'pending') { setStatus(r, 'seen', 'Viewed by admin'); userNotify(r, typeLabel(r.type) + ' seen', 'The admin has viewed your ' + (isDispute(r) ? 'dispute' : 'request') + '.'); }
            save(); setTimeout(function () { try { render(); } catch (e) {} }, 30);
          }
        }
        if (parts && parts[1] === 'help-desk') { var q = document.getElementById('scUserQ'); if (q) q.onkeydown = function (e) { if (e.key === 'Enter') App.scUserSearch(); }; }
      };
    }
    try {
      if (typeof ADMIN_NAV !== 'undefined') {
        ADMIN_KEYS.slice().reverse().forEach(function (n) { if (!ADMIN_NAV.some(function (x) { return x.key === n.key; })) ADMIN_NAV.splice(1, 0, n); });
      }
    } catch (e) {}
    VIEWS.__wcServiceCenter = true;
    return true;
  }

  /* reconcile vendor applications approved/rejected from the classic Vendor requests page */
  function reconcile() {
    var changed = false;
    list().forEach(function (r) {
      if (r.type !== 'account_vendor' || !r.vendorAppId || r.status !== 'payment_submitted') return;
      var app = (DB.vendorApplications || []).find(function (x) { return x.id === r.vendorAppId; });
      if (!app) return;
      if (app.status === 'approved') { setStatus(r, 'approved', 'Vendor profile activated'); changed = true; }
      else if (app.status === 'rejected') { r.adminNote = app.note || ''; r.payIntentAt = Date.now(); r.vendorAppId = null; setStatus(r, 'payment_rejected', app.note || 'Payment rejected'); changed = true; }
    });
    return changed;
  }

  /* record how a new user joined (direct / referral code / referral link) */
  try {
    if (/[?&]ref=|\/ref\//i.test(location.href)) sessionStorage.setItem('wc_join_link', '1');
  } catch (e) {}
  function stampJoin() {
    var u = me(); if (!u || u.joinMethod || u.role === 'admin') return false;
    if (Date.now() - (Number(u.createdAt) || 0) > 15 * 60000) return false;
    var link = false; try { link = !!sessionStorage.getItem('wc_join_link'); } catch (e) {}
    u.joinMethod = (u.referredBy || u.pendingReferralCode) ? (link ? 'Referral link' : 'Referral code') : 'Direct link';
    return true;
  }
  function forcedRefresh() {
    var u = me(); if (!u) return;
    var k = 'wc_sc_refresh_' + u.id;
    if (!u.forceRefreshAt) { if (!localStorage.getItem(k)) localStorage.setItem(k, String(BOOT_AT)); return; }
    var seen = Number(localStorage.getItem(k) || 0);
    if (!seen) { localStorage.setItem(k, String(Math.max(Number(u.forceRefreshAt) || 0, BOOT_AT))); return; }
    if (u.forceRefreshAt > seen) {
      localStorage.setItem(k, String(u.forceRefreshAt));
      T('Your account was upgraded — loading the latest version…', 'ok');
      setTimeout(function () { try { if (typeof applyUpdate === 'function') applyUpdate(); else location.reload(); } catch (e) { location.reload(); } }, 1500);
    }
  }

  /* ------------------------------------------------------------ styles */
  (function css() {
    if (document.getElementById('wcServiceCenterCss')) return;
    var st = document.createElement('style'); st.id = 'wcServiceCenterCss';
    st.textContent = [
      '.sc-tiles{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}',
      '.sc-tile{display:flex;flex-direction:column;gap:6px;padding:16px;border-radius:16px;background:var(--surface);border:1px solid var(--border);color:var(--text);text-decoration:none;min-height:130px}',
      '.sc-tile:hover{border-color:var(--accent)}.sc-tile b{font-size:14.5px}',
      '.sc-tile-ic{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:var(--surface-2);color:var(--accent)}',
      '.sc-list{display:flex;flex-direction:column}.sc-row{display:flex;align-items:center;gap:10px;padding:11px 4px;border-bottom:1px solid var(--border);color:var(--text);text-decoration:none}.sc-row:last-child{border-bottom:0}',
      '.sc-row-ic{width:32px;height:32px;flex:none;border-radius:10px;display:flex;align-items:center;justify-content:center;background:var(--surface-2);color:var(--accent)}',
      '.sc-chip{display:inline-block;font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap}',
      '.sc-warn{background:rgba(255,200,97,.15);color:#ffc861}.sc-info{background:rgba(58,160,255,.15);color:#5ab1ff}.sc-ok{background:rgba(34,197,94,.15);color:#22c55e}.sc-bad{background:rgba(239,68,68,.15);color:#ef4444}',
      '.sc-status{border-radius:14px;padding:13px 14px;font-size:13.5px;line-height:1.55;border:1px solid transparent}',
      '.sc-status.sc-ok{border-color:rgba(34,197,94,.35)}.sc-status.sc-bad{border-color:rgba(239,68,68,.35)}.sc-status.sc-warn{border-color:rgba(255,200,97,.35)}.sc-status.sc-info{border-color:rgba(58,160,255,.35)}',
      '.sc-status-l{font-weight:800;text-transform:uppercase;font-size:11px;letter-spacing:.05em;margin-bottom:3px}',
      '.sc-txlist{max-height:420px;overflow:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px}',
      '.sc-tx{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border);border-radius:12px;cursor:pointer;background:var(--surface)}.sc-tx.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}',
      '.sc-radio{width:18px;height:18px;border-radius:50%;border:2px solid var(--border);flex:none}.on>.sc-radio{border-color:var(--accent);background:radial-gradient(var(--accent) 45%,transparent 50%)}',
      '.sc-methods{display:flex;flex-direction:column;gap:6px}.sc-method{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border);border-radius:12px;cursor:pointer}.sc-method.on{border-color:var(--accent)}',
      '.sc-addr{word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace}',
      '.sc-kv{display:flex;flex-direction:column}.sc-kv>div{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px dashed var(--border);font-size:13px}.sc-kv>div:last-child{border-bottom:0}.sc-kv span{color:var(--muted)}.sc-kv b{text-align:right;max-width:65%}',
      '.sc-calc,.sc-note{background:var(--surface-2);border-radius:12px;padding:10px 12px;font-size:13px;line-height:1.55;margin-top:8px}.sc-note-bad{background:rgba(239,68,68,.1);color:#ef8080}',
      '.sc-formula{font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--surface-2);border-radius:10px;padding:10px;margin:8px 0;font-size:12.5px}',
      '.sc-payaddr{margin-top:10px;padding:12px;border:1px dashed var(--accent);border-radius:12px}',
      '.sc-slip{max-width:220px;max-height:220px;border-radius:10px;display:block;margin-top:6px;border:1px solid var(--border)}',
      '.sc-tl{display:flex;flex-direction:column;gap:10px}.sc-tl-i{display:flex;gap:10px;font-size:13px}.sc-dot{width:10px;height:10px;border-radius:50%;background:var(--accent);margin-top:5px;flex:none}',
      '.sc-search{display:flex;align-items:center;gap:8px;background:var(--surface-2);border-radius:12px;padding:0 12px}.sc-search input{flex:1;background:transparent;border:0;outline:0;color:var(--text);padding:12px 0;font-size:14px}',
      '.sc-cats{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.sc-cat{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:999px;padding:5px 11px;font-size:12px;cursor:pointer}',
      '.sc-faq{padding:0;overflow:hidden}.sc-faq summary{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:14px 16px;cursor:pointer;list-style:none}.sc-faq summary::-webkit-details-marker{display:none}.sc-faq[open] summary svg{transform:rotate(180deg)}',
      '.sc-faq-a{padding:0 16px 16px;font-size:13.5px;line-height:1.65;color:var(--text)}.sc-faq-a ol,.sc-faq-a ul{padding-left:20px;margin:6px 0}.sc-faq-a li{margin:3px 0}.sc-faq-a a{color:var(--accent)}',
      '.sc-faq-help{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:12px;padding:12px;border-radius:12px;background:var(--surface-2);font-size:13px}',
      '.sc-t{width:100%;border-collapse:collapse;font-size:12.5px;margin:6px 0}.sc-t td,.sc-t th{padding:7px 6px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}.sc-t th{color:var(--muted);font-weight:600}',
      '.sc-stmt h3{font-size:14px;margin:16px 0 4px}',
      '.sc-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:8px;margin-bottom:14px}.sc-stat{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:14px;background:var(--surface);border:1px solid var(--border);color:var(--text);text-decoration:none;font-size:12.5px}.sc-stat b{font-size:22px}.sc-stat.hot{border-color:rgba(255,200,97,.5)}.sc-stat.hot b{color:#ffc861}',
      '.sc-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.sc-cardart{border-radius:16px;padding:18px;color:#fff;background:linear-gradient(135deg,#0b3a5b,#0e7c86 60%,#2ee6c9);min-height:150px;display:flex;flex-direction:column;justify-content:space-between;font-weight:700;letter-spacing:.04em}.sc-cardnum{font-size:18px;letter-spacing:.18em}',
      '@media(max-width:520px){.sc-tiles{grid-template-columns:1fr 1fr}.sc-grid2{grid-template-columns:1fr}.sc-kv b{max-width:58%}}'
    ].join('\n');
    document.head.appendChild(st);
  })();

  /* ------------------------------------------------------------ boot */
  var tries = 0;
  (function boot() {
    if (!install()) { if (tries++ < 200) return setTimeout(boot, 120); return; }
    setTimeout(function () { try { render(); } catch (e) {} }, 200);
    setTimeout(function () { maybePopup(false); }, 2500);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { try { var r = pendingPayment(); if (r) sessionStorage.removeItem('wc_sc_pop_' + r.id); } catch (e) {} setTimeout(function () { maybePopup(false); }, 700); }
    });
    window.addEventListener('hashchange', function () { setTimeout(function () { maybePopup(false); }, 900); });
    setInterval(function () {
      try {
        if (typeof DB === 'undefined' || !DB) return;
        var ch = false;
        if (isAdmin() && reconcile()) ch = true;
        if (stampJoin()) ch = true;
        if (ch) save();
        forcedRefresh();
      } catch (e) {}
    }, 5000);
  })();

  SC.statementData = statementData;
  SC.faqItems = faqItems;
  SC.list = list;
})();
