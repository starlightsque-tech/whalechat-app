/* =========================================================================
   WhaleChat WC-Investing UI  (wc-invest-ui)
   Pages: dashboard · invest (plan list + amount + duration) · active plans ·
   ROI progress · transfer · history.  Every toolbar button has its own route
   so a click always navigates and re-renders.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcInvestUi) return;
  window.__wcInvestUi = true;

  var P = window.WC_INVEST;
  if (!P) return;

  var RATE = 0.5;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function usd(v) { return '$' + (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }
  function wcv(v) { return (Math.round(((Number(v) || 0) / RATE) * 100) / 100).toFixed(2); }
  function ic(n, s) { try { return typeof window.ic === 'function' ? window.ic(n, s) : ''; } catch (e) { return ''; } }
  function me2() { try { return me(); } catch (e) { return null; } }

  function head(title, sub, back) {
    return '<div class="page-head"><div class="row" style="gap:10px;align-items:center">' +
      (back ? '<a href="' + back + '" class="btn-icon">' + ic('back', 18) + '</a>' : '') +
      '<div><h1 style="margin:0">' + esc(title) + '</h1><p class="muted" style="margin:2px 0 0">' + esc(sub) + '</p></div></div></div>';
  }

  function money2(v) { return '<span>' + usd(v) + '</span><small class="tiny muted">' + wcv(v) + ' WC</small>'; }

  function planRow(inv) {
    var s = P.progress(inv, P.sharePrice());
    return '<div class="wci-plan">' +
      '<div class="between" style="align-items:flex-start"><div style="min-width:0">' +
        '<b>' + esc(inv.planName) + '</b> <span class="badge badge-success">' + s.pct.toFixed(1) + '%</span>' +
        '<div class="tiny muted">' + usd(inv.capitalUsd) + ' capital · ' + inv.ratePct + '%/day · ' + inv.days + ' days · ' +
          (s.daysLeft > 0 ? s.daysLeft + ' day' + (s.daysLeft === 1 ? '' : 's') + ' left' : 'maturing') + '</div>' +
      '</div><div style="text-align:right">' +
        '<b class="up">+' + usd(s.accruedUsd) + '</b>' +
        '<div class="tiny muted">of ' + usd(s.totalRoiUsd) + ' projected</div>' +
      '</div></div>' +
      '<div class="wci-bar"><i style="width:' + Math.max(0, Math.min(100, s.pct)) + '%"></i></div>' +
      '<div class="tiny muted" style="margin-top:6px">Entry ' + usd(inv.entryPriceUsd) + ' · ' + Number(inv.shares || 0).toFixed(6) + ' shares · matures ' + new Date(Number(inv.endsAt)).toLocaleDateString() + '</div>' +
      '<div class="wci-chartwrap">' + P.chart(P.series(inv, 24), { height: 78, color: '#2ee6c9', uid: inv.id }) + '</div>' +
      '<div class="between tiny"><span class="muted">20%</span><span class="up">ROI ' + usd(s.accruedUsd) + '</span><span class="muted">100%</span></div>' +
    '</div>';
  }

  /* ------------------------------ dashboard ------------------------------- */
  P.viewDashboard = function () {
    var s = P.summary();
    var plans = s.active.slice(0, 3);
    return head('WC-Investing', 'WhaleChat Shares plans, profits and ROI.', '#/investment') +
      '<div class="ih-cards">' +
        '<div class="ih-card"><span>Capital balance</span><b>' + usd(s.capital) + '</b><small>' + wcv(s.capital) + ' WC · used to activate plans</small></div>' +
        '<div class="ih-card"><span>Profits</span><b class="' + (s.profit >= 0 ? 'up' : 'down') + '">' + usd(s.profit) + '</b><small>' + wcv(s.profit) + ' WC · credited at maturity</small></div>' +
        '<div class="ih-card"><span>Leftover capital</span><b>' + usd(s.leftover) + '</b><small>' + wcv(s.leftover) + ' WC · returned after a loss</small></div>' +
        '<div class="ih-card"><span>Active plans</span><b>' + s.activeCount + '</b><small>' + usd(s.investedUsd) + ' working · +' + usd(s.accruedUsd) + ' ROI</small></div>' +
      '</div>' +

      '<div class="card ih-actions"><div class="ih-btn-grid">' +
        '<a href="#/invest/shares/invest" class="btn btn-primary btn-sm" data-wci-go="invest">Invest now</a>' +
        '<a href="#/invest/shares/active" class="btn btn-ghost btn-sm" data-wci-go="active">Active plans</a>' +
        '<a href="#/invest/shares/transfer" class="btn btn-ghost btn-sm" data-wci-go="transfer">Transfer</a>' +
        '<a href="#/invest/shares/roi" class="btn btn-ghost btn-sm" data-wci-go="roi">ROI progress</a>' +
        '<a href="#/invest/shares/history" class="btn btn-ghost btn-sm" data-wci-go="history">History</a>' +
      '</div></div>' +

      '<div class="card"><div class="between"><div class="card-title" style="margin:0">Auto reinvestment</div>' +
        '<button class="wci-switch ' + (s.autoReinvest ? 'on' : '') + '" data-act="wci-auto-reinvest" aria-pressed="' + s.autoReinvest + '"><i></i><span>' + (s.autoReinvest ? 'ON' : 'OFF') + '</span></button></div>' +
        '<div class="tiny muted" style="margin-top:6px">When on, a plan that matures is automatically re-activated with the same capital. Profits go to the profit balance; a loss returns the remaining capital to leftover capital, and a total loss closes the plan.</div></div>' +

      '<div class="card"><div class="between"><div class="card-title" style="margin:0">Active plans</div>' +
        '<a href="#/invest/shares/active" class="tiny">View all →</a></div>' +
        (plans.length ? plans.map(planRow).join('') : '<div class="tiny muted">No active plan yet — press <b>Invest now</b> to activate one.</div>') +
      '</div>' +

      '<div class="card"><div class="between"><div class="card-title" style="margin:0">ROI progress</div>' +
        '<a href="#/invest/shares/roi" class="tiny">Open chart →</a></div>' +
        '<div class="wci-chartwrap">' + P.chart(P.combinedSeries(24), { height: 110, color: '#2ee6c9', uid: 'dash' }) + '</div>' +
        '<div class="tiny muted">Total ROI accrued across every active plan: <b class="up">+' + usd(s.accruedUsd) + '</b></div></div>';
  };

  /* -------------------------------- invest -------------------------------- */
  P.viewInvest = function (params) {
    var s = P.summary();
    var plans = P.catalog();
    var sel = (params && params.plan) || (plans[0] && plans[0].id) || '';
    var price = P.sharePrice();
    var selPlan = P.plan(sel) || plans[0] || { id: '', name: '', ratePct: 0, days: 1, minUsd: 0 };
    return head('Invest in WhaleChat Shares', 'Choose a plan, enter the amount in dollars and activate it.', '#/invest/shares') +
      '<div class="wci-live">Share price now <b>' + usd(price) + '</b> · ' + wcv(price) + ' WC · capital available <b>' + usd(s.capital) + '</b></div>' +

      '<div class="card"><div class="card-title">1 · Choose a plan</div>' +
        '<div class="wci-plangrid">' + plans.map(function (p) {
          return '<a class="wci-plancard' + (p.id === sel ? ' on' : '') + '" href="#/invest/shares/invest?plan=' + encodeURIComponent(p.id) + '">' +
            '<div class="between"><b>' + esc(p.name) + '</b><span class="badge badge-accent">' + Number(p.ratePct) + '%/day</span></div>' +
            '<div class="tiny muted">' + Number(p.days) + ' days · ' + esc(p.blurb || '') + '</div>' +
            '<div class="tiny">Min ' + usd(p.minUsd) + ' · Max ' + usd(p.maxUsd) + '</div>' +
          '</a>';
        }).join('') + '</div></div>' +

      '<div class="card"><div class="card-title">2 · Amount and duration</div>' +
        '<div class="field"><label class="label">Amount to invest (USD)</label>' +
          '<div class="input-wrap"><span class="inv-prefix">$</span>' +
          '<input class="input" id="wciAmount" type="number" step="0.01" min="0" placeholder="' + Number(selPlan.minUsd || 0).toFixed(2) + '" data-wci-amount/></div>' +
          '<div class="tiny muted mt6">Charged from your WC-Investing capital · <span id="wciAmountWc">' + wcv(0) + ' WC</span></div></div>' +
        '<div class="field"><label class="label">Duration in days (optional)</label>' +
          '<input class="input" id="wciDays" type="number" step="1" min="1" placeholder="' + Number(selPlan.days || 1) + ' (plan default)" data-wci-days/>' +
          '<div class="tiny muted mt6">Leave empty to use the plan duration of ' + Number(selPlan.days) + ' days.</div></div>' +
        '<div class="wci-preview" id="wciPreview"></div>' +
        '<button class="btn btn-primary" data-act="wci-invest" data-plan="' + esc(selPlan.id) + '" style="width:100%;margin-top:10px">Activate ' + esc(selPlan.name || 'plan') + '</button>' +
      '</div>' +

      '<div class="card wc-guide-link"><div class="between" style="gap:10px;align-items:center;flex-wrap:wrap">' +
          '<div><div class="card-title" style="margin:0">How is my payout calculated?</div>' +
          '<div class="tiny muted" style="margin-top:3px">Worked examples and formulas are in the FAQ &amp; Trade Guide.</div></div>' +
          '<div class="row" style="gap:6px"><a class="btn btn-soft btn-sm" href="#/how-it-works">Trade Guide</a><a class="btn btn-ghost btn-sm" href="#/investment/faq?q=wc-payout">FAQ</a></div>' +
        '</div></div>';
  };

  /* ------------------------------ active list ----------------------------- */
  P.viewActive = function () {
    var s = P.summary();
    if (!s.active.length) {
      return head('Active investment plans', 'Plans that are counting right now.', '#/invest/shares') +
        '<div class="card"><div class="tiny muted">No active plan yet.</div>' +
        '<a class="btn btn-primary" href="#/invest/shares/invest" style="width:100%;margin-top:10px">Invest now</a></div>';
    }
    return head('Active investment plans', s.activeCount + ' plan' + (s.activeCount === 1 ? '' : 's') + ' counting · +' + usd(s.accruedUsd) + ' ROI accrued', '#/invest/shares') +
      '<div class="card"><div class="tiny muted">Total working capital <b>' + usd(s.investedUsd) + '</b> · projected ROI <b class="up">' +
        usd(s.active.reduce(function (t, p) { return t + (Number(p.projectedRoiUsd) || 0); }, 0)) + '</b></div></div>' +
      s.active.map(planRow).join('');
  };

  /* -------------------------------- ROI page ------------------------------ */
  P.viewRoi = function (params) {
    var s = P.summary();
    var sel = (params && params.plan) || '__all__';
    var one = null;
    s.active.forEach(function (p) { if (p.id === sel) one = p; });
    var series = one ? P.series(one, 30) : P.combinedSeries(30);
    var accrued = one ? P.progress(one, P.sharePrice()).accruedUsd : s.accruedUsd;
    var pills = '<a class="chip wci-pill' + (sel === '__all__' ? ' on' : '') + '" href="#/invest/shares/roi">All plans</a>' +
      s.active.map(function (p) {
        return '<a class="chip wci-pill' + (p.id === sel ? ' on' : '') + '" href="#/invest/shares/roi?plan=' + encodeURIComponent(p.id) + '">' + esc(p.planName) + '</a>';
      }).join('');
    return head('ROI progress', 'Return on every active plan, accrued live.', '#/invest/shares') +
      '<div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:8px">' + pills + '</div>' +
      '<div class="card"><div class="between"><div class="card-title" style="margin:0">' + (one ? esc(one.planName) : 'All active plans') + '</div>' +
        '<b class="up">+' + usd(accrued) + '</b></div>' +
        '<div class="wci-chartwrap big">' + P.chart(series, { height: 150, color: one ? '#2ee6c9' : '#3aa0ff', uid: 'roi' }) + '</div>' +
        '<div class="tiny muted" style="margin-top:6px">' + (one
          ? 'Capital ' + usd(one.capitalUsd) + ' · ' + one.ratePct + '%/day · ' + one.days + ' days · projected ' + usd(one.projectedRoiUsd)
          : 'Accrued across ' + s.activeCount + ' plan' + (s.activeCount === 1 ? '' : 's') + ' · working capital ' + usd(s.investedUsd)) + '</div></div>' +
      (s.active.length ? '<div class="card"><div class="card-title">Per plan</div>' + s.active.map(function (p) {
        var pr = P.progress(p, P.sharePrice());
        return '<a class="ih-row" href="#/invest/shares/roi?plan=' + encodeURIComponent(p.id) + '"><div class="grow"><b>' + esc(p.planName) + '</b>' +
          '<div class="tiny muted">' + usd(p.capitalUsd) + ' · ' + pr.pct.toFixed(1) + '% of ' + p.days + ' days</div></div>' +
          '<b class="up">+' + usd(pr.accruedUsd) + '</b></a>';
      }).join('') + '</div>' : '');
  };

  /* ------------------------------- transfer ------------------------------- */
  P.viewTransfer = function () {
    var s = P.summary();
    return head('WC-Investing transfer', 'Move USD between your WC-Investing balances and the investment account.', '#/invest/shares') +
      '<div class="card">' +
        '<div class="field"><label class="label">Transfer</label><select class="input" id="wciTrMode">' +
          '<option value="profit2invest">Profit balance → investment USD balance</option>' +
          '<option value="profit2capital">Profit balance → capital balance</option>' +
          '<option value="leftover2capital">Leftover capital → capital balance</option>' +
          '<option value="leftover2invest">Leftover capital → investment USD balance</option>' +
        '</select></div>' +
        '<div class="field"><label class="label">Amount (USD)</label><input class="input" id="wciTrAmount" type="number" step="0.01" min="0" placeholder="0.00"/>' +
          '<div class="tiny muted mt6">Profit ' + usd(s.profit) + ' · Leftover ' + usd(s.leftover) + ' · Capital ' + usd(s.capital) + '</div></div>' +
        '<button class="btn btn-primary" data-act="wci-transfer" style="width:100%">Transfer</button>' +
      '</div>' +
      '<div class="card"><div class="ih-list">' +
        '<div class="ih-row"><span>Profit balance</span><b>' + money2(s.profit) + '</b></div>' +
        '<div class="ih-row"><span>Leftover capital</span><b>' + money2(s.leftover) + '</b></div>' +
        '<div class="ih-row"><span>Capital balance</span><b>' + money2(s.capital) + '</b></div>' +
        '<div class="ih-row"><span>Investment USD balance</span><b>' + money2((me2() && me2().investAcct && me2().investAcct.usd) || 0) + '</b></div>' +
      '</div></div>' +
      '<div class="card"><div class="tiny muted">USD is the unit for every portfolio balance. Transfer USD back to your WhaleChat account and it is converted to WC automatically.</div>' +
        '<a class="btn btn-ghost btn-sm" href="#/investment/transfer" style="width:100%;margin-top:8px">Transfer to WhaleChat WC balance</a></div>';
  };

  /* -------------------------------- history ------------------------------- */
  P.viewHistory = function () {
    var w = P.wallet();
    var rows = (w && w.history) || [];
    return head('WC-Investing history', 'Plan activations, ROI credits and transfers.', '#/invest/shares') +
      '<div class="card">' + (rows.length ? '<div class="ih-list">' + rows.map(function (h) {
        return '<div class="ih-row"><div class="grow"><b>' + esc(h.label) + '</b><div class="tiny muted">' + new Date(h.at).toLocaleString() + '</div></div>' +
          '<b class="' + ((Number(h.usd) || 0) >= 0 ? 'up' : 'down') + '">' + ((Number(h.usd) || 0) >= 0 ? '+' : '') + usd(h.usd) + '</b></div>';
      }).join('') + '</div>' : '<div class="tiny muted">No WC-Investing activity yet.</div>') + '</div>';
  };

  /* -------------------------------- actions ------------------------------- */
  if (typeof App !== 'undefined') {
    App.wciInvest = function (id, ds) {
      var planId = (ds && ds.plan) || '';
      var amount = Number((document.getElementById('wciAmount') || {}).value) || 0;
      var daysEl = document.getElementById('wciDays');
      var days = daysEl ? Number(daysEl.value) || 0 : 0;
      var r = P.activate({ planId: planId, capitalUsd: amount, days: days });
      if (r.error) return (typeof toast === 'function' ? toast(r.error, 'err') : null);
      if (typeof toast === 'function') toast('Plan activated · ' + usd(amount) + ' working now', 'ok');
      if (typeof go === 'function') go('invest/shares/active'); else if (typeof render === 'function') render();
    };

    App.wciTransfer = function () {
      var mode = (document.getElementById('wciTrMode') || {}).value || 'profit2invest';
      var amount = Number((document.getElementById('wciTrAmount') || {}).value) || 0;
      var r = P.transfer({ mode: mode, amountUsd: amount });
      if (r.error) return (typeof toast === 'function' ? toast(r.error, 'err') : null);
      if (typeof toast === 'function') toast('Transfer complete', 'ok');
      if (typeof render === 'function') render();
    };

    App.wciAutoReinvest = function () {
      var w = P.wallet();
      if (!w) return;
      w.autoReinvest = !w.autoReinvest;
      try { if (typeof persist === 'function') persist(); } catch (e) {}
      try { if (typeof sync === 'function') sync(); } catch (e) {}
      if (typeof toast === 'function') toast('Auto reinvestment ' + (w.autoReinvest ? 'on' : 'off'), 'ok');
      if (typeof render === 'function') render();
    };
  }

  /* live preview on the invest page (amount → WC + projection) */
  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (!t || !t.matches || !t.matches('[data-wci-amount], [data-wci-days]')) return;
    var amountEl = document.getElementById('wciAmount');
    var daysEl = document.getElementById('wciDays');
    var amount = Number(amountEl && amountEl.value) || 0;
    var hash = String(location.hash || '');
    var m = hash.match(/plan=([^&]+)/);
    var plan = P.plan(m ? decodeURIComponent(m[1]) : '') || P.catalog()[0];
    if (!plan) return;
    var days = Number(daysEl && daysEl.value) || Number(plan.days) || 1;
    var price = P.sharePrice();
    var daily = price * (Number(plan.ratePct) / 100);
    var total = daily * days * amount;
    var wcEl = document.getElementById('wciAmountWc');
    if (wcEl) wcEl.textContent = wcv(amount) + ' WC';
    var pv = document.getElementById('wciPreview');
    if (pv) {
      pv.innerHTML = '<div class="between"><span>Daily ROI</span><b>' + usd(daily) + '</b></div>' +
        '<div class="between"><span>Total ROI (' + days + ' days)</span><b class="up">+' + usd(total) + '</b></div>' +
        '<div class="between"><span>Payout at maturity</span><b>' + usd(amount + total) + '</b></div>' +
        '<div class="between"><span>Cost in WhaleCoin</span><b>' + wcv(amount) + ' WC</b></div>';
    }
  }, false);

  /* ---- routes: every toolbar button lands on its own page ---------------- */
  function patchRoutes() {
    if (typeof VIEWS === 'undefined' || !VIEWS.invest) return false;
    if (VIEWS.__wcInvestUiRouted) return true;
    var base = VIEWS.invest;
    VIEWS.invest = function (parts, params) {
      if ((parts[1] || '') === 'shares') {
        var sub = parts[2] || '';
        if (sub === 'invest' || sub === 'plans') return P.viewInvest(params);
        if (sub === 'active') return P.viewActive(params);
        if (sub === 'roi' || sub === 'progress') return P.viewRoi(params);
        if (sub === 'transfer') return P.viewTransfer(params);
        if (sub === 'history') return P.viewHistory(params);
        return P.viewDashboard(params);
      }
      return base.apply(this, arguments);
    };
    VIEWS.__wcInvestUiRouted = true;
    return true;
  }
  var rtry = 0;
  (function routeBoot() {
    if (patchRoutes()) {
      try { patchExistingButtons(); } catch (e) {}
      try {
        setInterval(function () { P.sweep(); paintLive(); }, 5000);
      } catch (e) {}
      return;
    }
    if (rtry++ < 80) return setTimeout(routeBoot, 400);
  })();

  /* the old dashboard strip pointed three buttons at the same URL — make any
     leftover link resolve to the matching page instead of doing nothing */
  function patchExistingButtons() {
    var map = {
      'invest/shares#invest': 'invest/shares/invest',
      'active plans': 'invest/shares/active',
      'roi progress': 'invest/shares/roi'
    };
    document.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (href !== '#/invest/shares') return;
      var label = String(a.textContent || '').trim().toLowerCase();
      var target = map[label];
      if (!target) return;
      ev.preventDefault();
      try { go(target); } catch (e) { location.hash = '#/' + target; }
    }, false);
  }

  /* repaint counters/charts without a full re-render */
  function paintLive() {
    try {
      var h = String(location.hash || '');
      if (h.indexOf('#/invest/shares') !== 0) return;
      if (typeof render === 'function') render();
    } catch (e) {}
  }
  P.paintLive = paintLive;

  /* ---- styles ------------------------------------------------------------ */
  (function styles() {
    if (document.getElementById('wci-style')) return;
    var st = document.createElement('style'); st.id = 'wci-style';
    st.textContent = `
    .wci-live{margin:0 0 10px;padding:9px 11px;border:1px solid var(--border);border-radius:11px;background:var(--surface-2);font-size:12px}
    .wci-plangrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
    .wci-plancard{display:block;padding:11px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);text-decoration:none;color:var(--text)}
    .wci-plancard.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
    .wci-plancard b{font-size:12.5px}
    .wci-preview{margin-top:10px;padding:10px;border:1px dashed var(--border);border-radius:11px;font-size:12px;display:flex;flex-direction:column;gap:5px}
    .wci-preview .between{display:flex;justify-content:space-between}
    .wci-plan{padding:11px 0;border-top:1px solid var(--border)}
    .wci-plan:first-of-type{border-top:none}
    .wci-bar{height:7px;border-radius:99px;background:var(--surface-2);overflow:hidden;margin-top:8px}
    .wci-bar i{display:block;height:100%;background:linear-gradient(90deg,#2ee6c9,#3aa0ff);border-radius:99px;transition:width .4s}
    .wci-chartwrap{margin-top:8px}
    .wci-chartwrap.big{margin-top:10px}
    .wci-chart{width:100%;height:86px;display:block}
    .wci-chartwrap.big .wci-chart{height:150px}
    .wci-pill.on{border-color:var(--accent);color:var(--accent)}
    .wci-switch{display:inline-flex;align-items:center;gap:7px;padding:5px 9px;border-radius:99px;border:1px solid var(--border);
      background:var(--surface-2);color:var(--muted);font-size:11px;font-weight:700;cursor:pointer}
    .wci-switch i{width:30px;height:17px;border-radius:99px;background:var(--border);position:relative;transition:.2s}
    .wci-switch i:after{content:'';position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:99px;background:#fff;transition:.2s}
    .wci-switch.on{color:#22c55e;border-color:rgba(34,197,94,.45)}
    .wci-switch.on i{background:#22c55e}
    .wci-switch.on i:after{left:15px}
    @media(max-width:560px){.wci-plangrid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(st);
  })();
})();
