/* =========================================================================
   WhaleChat WC-Investing admin editor  (wc-invest-admin)

   Admin console → WC-Investing:
     · edit the plan catalogue (name, daily rate, duration, min, max, blurb)
     · add, remove and reset plans
     · set the share price and the crash level
     · adjust an active user's plan rate / duration (recalculates the end
       date and projected ROI) without touching their capital

   Saves to DB.settings.investPlans / sharePriceUsd / wcCrashPct, then syncs
   so every device picks up the new catalogue.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcInvestAdmin) return;
  window.__wcInvestAdmin = true;

  var P = window.WC_INVEST || {};
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d || 0); }
  function usd(v) { return '$' + (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }
  function toast2(m, t) { try { if (typeof toast === 'function') toast(m, t || 'ok'); } catch (e) {} }
  function saveAll() {
    try { if (typeof persist === 'function') persist(); } catch (e) {}
    try { if (typeof sync === 'function') sync(); } catch (e) {}
    try { if (typeof render === 'function') render(); } catch (e) {}
  }
  function settings() { try { if (!DB.settings) DB.settings = {}; return DB.settings; } catch (e) { return {}; } }
  function plans() {
    var s = settings();
    if (!Array.isArray(s.investPlans) || !s.investPlans.length) {
      s.investPlans = (P.defaults || []).map(function (p) { return Object.assign({}, p); });
    }
    return s.investPlans;
  }

  function field(label, name, value, opts) {
    opts = opts || {};
    return '<div class="field wcia-f"><label class="label">' + esc(label) + '</label>' +
      '<input class="input" data-f="' + name + '" type="' + (opts.type || 'text') + '"' +
      (opts.step ? ' step="' + opts.step + '"' : '') + (opts.min !== undefined ? ' min="' + opts.min + '"' : '') +
      ' value="' + esc(value == null ? '' : value) + '" placeholder="' + esc(opts.ph || '') + '"/></div>';
  }

  function planRows() {
    return plans().map(function (p, i) {
      return '<div class="card wcia-plan" data-plan-row="' + i + '" data-plan-id="' + esc(p.id) + '">' +
        '<div class="between" style="gap:8px;align-items:center;margin-bottom:8px">' +
          '<b>' + esc(p.name || p.id) + '</b>' +
          '<span class="badge badge-accent">' + num(p.ratePct) + '%/day</span>' +
        '</div>' +
        '<div class="wcia-grid">' +
          field('Plan name', 'name', p.name) +
          field('Daily rate %', 'ratePct', p.ratePct, { type: 'number', step: '0.01', min: 0 }) +
          field('Duration (days)', 'days', p.days, { type: 'number', step: '1', min: 1 }) +
          field('Minimum (USD)', 'minUsd', p.minUsd, { type: 'number', step: '0.01', min: 0 }) +
          field('Maximum (USD)', 'maxUsd', p.maxUsd, { type: 'number', step: '0.01', min: 0 }) +
          field('Short description', 'blurb', p.blurb) +
        '</div>' +
        '<div class="row" style="gap:8px;justify-content:flex-end;margin-top:8px">' +
          '<button class="btn btn-ghost btn-sm" data-wcia-del="' + i + '">Delete plan</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function activeRows() {
    var rows = [];
    var users = [];
    try { users = (DB.users || []); } catch (e) {}
    users.forEach(function (u) {
      var w = u && u.investAcct && u.investAcct.wcInvest;
      if (!w || !Array.isArray(w.plans)) return;
      w.plans.forEach(function (inv) {
        if (!inv || inv.status !== 'active') return;
        rows.push({ user: u, inv: inv });
      });
    });
    if (!rows.length) return '<div class="tiny muted">No active WC-Investing plans right now.</div>';
    return rows.slice(0, 100).map(function (r, i) {
      var inv = r.inv;
      var price = P.sharePrice ? P.sharePrice() : num(inv.entryPriceUsd);
      return '<div class="card wcia-active" data-active-row="' + i + '" data-user-id="' + esc(r.user.id) + '" data-plan-id="' + esc(inv.id) + '">' +
        '<div class="between" style="gap:8px;flex-wrap:wrap">' +
          '<div><b>' + esc(r.user.fullName || r.user.username || r.user.id) + '</b> <span class="tiny muted">@' + esc(r.user.username || '') + '</span>' +
            '<div class="tiny muted">' + esc(inv.planName || inv.planId) + ' · ' + usd(inv.capitalUsd) + ' · started ' + new Date(Number(inv.startedAt) || Date.now()).toLocaleDateString() + '</div></div>' +
          '<div class="tiny">projected <b class="up">' + usd(inv.projectedRoiUsd) + '</b></div>' +
        '</div>' +
        '<div class="wcia-grid" style="margin-top:8px">' +
          field('Daily rate %', 'ratePct', inv.ratePct, { type: 'number', step: '0.01', min: 0 }) +
          field('Duration (days)', 'days', inv.days, { type: 'number', step: '1', min: 1 }) +
        '</div>' +
        '<div class="row" style="gap:8px;justify-content:flex-end;margin-top:8px">' +
          '<button class="btn btn-primary btn-sm" data-wcia-active-save="' + i + '">Update plan</button>' +
        '</div>' +
        '<div class="tiny muted">Share price now ' + usd(price) + ' · ends ' + new Date(Number(inv.endsAt) || Date.now()).toLocaleDateString() + '</div>' +
      '</div>';
    }).join('');
  }

  function body() {
    var s = settings();
    return '<div class="card"><div class="between" style="flex-wrap:wrap;gap:10px">' +
        '<div><div class="card-title" style="margin:0">Plan catalogue</div>' +
        '<div class="tiny muted">These are the WC-Investing plans users can activate. Changes apply to new activations immediately.</div></div>' +
        '<div class="row" style="gap:8px"><button class="btn btn-ghost btn-sm" data-wcia-reset="1">Reset defaults</button>' +
        '<button class="btn btn-primary btn-sm" data-wcia-save="1">Save all plans</button></div></div></div>' +
      '<div id="wciaPlans">' + planRows() + '</div>' +
      '<button class="btn btn-soft" data-wcia-add="1" style="width:100%;margin-bottom:14px">+ Add a plan</button>' +
      '<div class="card"><div class="card-title">Market settings</div>' +
        '<div class="wcia-grid">' +
          field('WhaleChat share price (USD)', 'sharePriceUsd', s.sharePriceUsd || '', { type: 'number', step: '0.0001', min: 0, ph: 'e.g. 12.45' }) +
          field('Crash level (% of entry price)', 'wcCrashPct', s.wcCrashPct || 50, { type: 'number', step: '1', min: 1 }) +
        '</div>' +
        '<button class="btn btn-primary btn-sm" data-wcia-settings="1">Save market settings</button>' +
        '<div class="tiny muted" style="margin-top:6px">Crash level default 50%. If the average price over a plan ends below this percentage of its entry price, the plan is a total loss.</div>' +
      '</div>' +
      '<div class="card"><div class="between" style="flex-wrap:wrap;gap:10px">' +
        '<div><div class="card-title" style="margin:0">Active user plans</div>' +
        '<div class="tiny muted">Adjust the rate or duration of a plan that is already running. Capital is untouched; the end date and projected ROI are recalculated.</div></div></div>' +
        '<div id="wciaActive" style="margin-top:10px">' + activeRows() + '</div></div>';
  }

  function adminShell(inner) {
    var nav = '';
    try {
      nav = '<div class="admin-nav">' + ADMIN_NAV.map(function (n) {
        var key = n.href.replace('#/admin', '') || '';
        var on = key === '/wc-investing';
        return '<a href="' + n.href + '" class="' + (on ? 'on' : '') + '">' + n.label + '</a>';
      }).join('') + '</div>';
    } catch (e) {}
    return '<div class="page-head"><div><span class="badge badge-accent mb10">' + (typeof ic === 'function' ? ic('trend', 12) : '') + ' Admin console</span>' +
      '<h1 style="font-size:24px">WC-Investing plans</h1>' +
      '<p>Edit rates, durations, limits, market price and running plans.</p></div>' +
      '<div class="row gap8"><a href="#/invest/shares" class="btn btn-ghost btn-sm">Open WC-Investing</a></div></div>' +
      nav + '<style>' +
      '.wcia-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}' +
      '.wcia-f{margin:0}.wcia-plan,.wcia-active{margin-bottom:10px}' +
      '</style>' + inner;
  }

  try {
    if (typeof ADMIN_NAV !== 'undefined' && !ADMIN_NAV.some(function (n) { return n.key === 'admin-wc-investing'; })) {
      ADMIN_NAV.splice(Math.max(0, ADMIN_NAV.length - 2), 0,
        { key: 'admin-wc-investing', label: 'WC-Investing', icon: 'trend', href: '#/admin/wc-investing' });
    }
  } catch (e) {}

  try {
    var prevView = VIEWS.admin;
    VIEWS.admin = function (parts, params) {
      if ((parts && parts[1] || '') === 'wc-investing') {
        var u = (typeof me === 'function') ? me() : null;
        if (!u || u.role !== 'admin') {
          return '<div class="card empty"><div class="ic">' + (typeof ic === 'function' ? ic('lock', 26) : '') + '</div><h3>Admin access only</h3><p>This area is restricted to WhaleChat administrators.</p><a href="#/home" class="btn btn-primary">Back to app</a></div>';
        }
        return adminShell(body());
      }
      return prevView.apply(this, arguments);
    };
  } catch (e) {}

  function rowPlans() {
    if (!DB.settings.investPlans) plans();
    return DB.settings.investPlans;
  }

  function readPlansFromDom() {
    var out = [];
    var nodes = document.querySelectorAll('[data-plan-row]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var get = function (f) { var el = node.querySelector('[data-f="' + f + '"]'); return el ? el.value : ''; };
      var id = node.getAttribute('data-plan-id');
      var p = {
        id: id,
        name: String(get('name') || '').trim().slice(0, 40),
        ratePct: num(get('ratePct')),
        days: Math.max(1, Math.round(num(get('days'), 1))),
        minUsd: Math.max(0, num(get('minUsd'))),
        maxUsd: Math.max(0, num(get('maxUsd'))),
        blurb: String(get('blurb') || '').trim().slice(0, 120)
      };
      if (!p.name) p.name = id;
      if (p.maxUsd && p.minUsd && p.maxUsd < p.minUsd) p.maxUsd = p.minUsd;
      out.push(p);
    }
    return out;
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var save = t.closest('[data-wcia-save]');
    if (save) {
      var list = readPlansFromDom();
      if (!list.length) return toast2('Keep at least one plan', 'err');
      var ids = {};
      for (var i = 0; i < list.length; i++) {
        if (ids[list[i].id]) return toast2('Two plans share an id — reload and retry', 'err');
        ids[list[i].id] = 1;
      }
      DB.settings.investPlans = list;
      saveAll();
      return toast2('WC-Investing plans saved', 'ok');
    }
    var add = t.closest('[data-wcia-add]');
    if (add) {
      var arr = rowPlans();
      var n = 1;
      while (arr.some(function (p) { return p.id === 'custom' + n; })) n++;
      arr.push({ id: 'custom' + n, name: 'Custom plan ' + n, ratePct: 5, days: 14, minUsd: 10, maxUsd: 10000, blurb: 'Custom plan.' });
      saveAll();
      return;
    }
    var del = t.closest('[data-wcia-del]');
    if (del) {
      var idx = Number(del.getAttribute('data-wcia-del'));
      var arr2 = rowPlans();
      if (arr2.length <= 1) return toast2('A catalogue needs at least one plan', 'err');
      if (typeof confirm === 'function' && !confirm('Delete “' + (arr2[idx] && arr2[idx].name) + '”? Users keep plans they already activated.')) return;
      arr2.splice(idx, 1);
      saveAll();
      return;
    }
    var reset = t.closest('[data-wcia-reset]');
    if (reset) {
      if (typeof confirm === 'function' && !confirm('Reset the catalogue to the three default plans?')) return;
      DB.settings.investPlans = (P.defaults || []).map(function (p) { return Object.assign({}, p); });
      saveAll();
      return toast2('Default plans restored', 'ok');
    }
    var set = t.closest('[data-wcia-settings]');
    if (set) {
      var sp = document.querySelector('[data-f="sharePriceUsd"]');
      var cp = document.querySelector('[data-f="wcCrashPct"]');
      var price = num(sp && sp.value);
      var crash = num(cp && cp.value, 50);
      if (price > 0) DB.settings.sharePriceUsd = price; else delete DB.settings.sharePriceUsd;
      if (crash >= 1 && crash < 100) DB.settings.wcCrashPct = crash;
      saveAll();
      return toast2('Market settings saved', 'ok');
    }
    var upd = t.closest('[data-wcia-active-save]');
    if (upd) {
      var node = upd.closest('[data-active-row]');
      if (!node) return;
      var userId = node.getAttribute('data-user-id');
      var planId = node.getAttribute('data-plan-id');
      var user = null;
      try { user = (DB.users || []).filter(function (u) { return u && u.id === userId; })[0]; } catch (e) {}
      var w = user && user.investAcct && user.investAcct.wcInvest;
      var inv = null;
      if (w && Array.isArray(w.plans)) w.plans.forEach(function (p) { if (p && p.id === planId) inv = p; });
      if (!inv) return toast2('Plan not found', 'err');
      var rateEl = node.querySelector('[data-f="ratePct"]');
      var daysEl = node.querySelector('[data-f="days"]');
      var rate = Math.max(0, num(rateEl && rateEl.value, inv.ratePct));
      var days = Math.max(1, Math.round(num(daysEl && daysEl.value, inv.days)));
      inv.ratePct = rate;
      inv.days = days;
      inv.endsAt = (Number(inv.startedAt) || Date.now()) + days * 864e5;
      if (P.dailyRoiExact) inv.dailyRoiUsd = P.dailyRoiExact(Number(inv.entryPriceUsd) || 0, rate);
      if (P.totalRoi) inv.projectedRoiUsd = P.totalRoi(Number(inv.entryPriceUsd) || 0, rate, days, Number(inv.capitalUsd) || 0);
      saveAll();
      return toast2('Plan updated for ' + (user.fullName || user.username || 'user'), 'ok');
    }
  }, true);
})();
