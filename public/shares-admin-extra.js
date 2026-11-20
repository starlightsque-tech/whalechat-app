/* =========================================================================
   WhaleChat Shares · admin extras (3.46)
   Adds two cards under "WhaleChat share investment plans" (Admin → Stocks):
   1. Share settings: base share price, volatility, pause new investments
   2. Investments: search users' share investments, change the daily return
      or end date, or cancel with/without a principal refund
   Every change is written to admin_logs by the server.
   ========================================================================= */
(function () {
  'use strict';
  if (window.__wcSharesAdminExtra) return; window.__wcSharesAdminExtra = true;

  function url(p) { try { if (typeof Remote !== 'undefined' && Remote && Remote.url) return Remote.url(p); } catch (e) {} return p; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function note(m, t) { try { if (typeof toast === 'function') toast(m, t || 'ok'); } catch (e) {} }
  function jget(p) { return fetch(url(p), { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }); }
  function jpost(p, b) { return fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
  function isAdminUser() { try { var u = me(); return !!(u && u.role === 'admin'); } catch (e) { return false; } }
  function money(n) { n = Number(n); return isFinite(n) ? '$' + n.toFixed(2) : '—'; }
  function day(t) { try { return new Date(t).toISOString().slice(0, 10); } catch (e) { return ''; } }
  var st = { status: 'active', q: '' };

  function settingsHtml(s) {
    return '<div class="card" id="sharesExtraSettings" style="margin-top:12px"><div class="between"><div><div class="card-title" style="margin:0">WhaleChat share settings</div>' +
      '<div class="tiny muted" style="margin-top:3px">Controls the simulated WhaleChat share price and whether users can start new share investments.</div></div>' +
      (s.investmentsPaused ? '<span class="badge badge-danger">Investments paused</span>' : '<span class="badge badge-ok">Open</span>') + '</div>' +
      '<div class="row" style="gap:10px;flex-wrap:wrap;margin-top:10px">' +
      '<div class="field"><label class="label">Base share price (USD)</label><input class="input" id="shxBase" type="number" min="0.01" step="0.01" value="' + esc(s.basePriceUsd) + '" style="max-width:160px"/></div>' +
      '<div class="field"><label class="label">Volatility per tick (%)</label><input class="input" id="shxVol" type="number" min="0" max="10" step="0.1" value="' + esc(s.volatilityPct) + '" style="max-width:140px"/></div>' +
      '<div class="field"><label class="label">Current price</label><div class="small" style="padding-top:8px"><b>' + money(s.priceUsd) + '</b></div></div></div>' +
      '<label class="row" style="gap:8px;margin-top:8px"><input type="checkbox" id="shxReset"/> <span class="small">Move the current price to the base price now</span></label>' +
      '<label class="row" style="gap:8px;margin-top:8px"><input type="checkbox" id="shxPause"' + (s.investmentsPaused ? ' checked' : '') + '/> <span class="small">Pause new share investments</span></label>' +
      '<div class="field" style="margin-top:8px"><label class="label">Pause reason shown to users</label><input class="input" id="shxReason" maxlength="200" value="' + esc(s.pauseReason || '') + '"/></div>' +
      '<div class="row" style="gap:8px;margin-top:10px"><button class="btn btn-primary btn-sm" data-shx="settings">Save settings</button></div>' +
      '<div class="tiny muted" style="margin-top:8px">Running investments keep their entry price. The price moves randomly around the base price; volatility sets how far it moves each tick.</div></div>';
  }
  function invRow(v) {
    return '<tr data-inv="' + esc(v.id) + '"><td class="tiny"><b>' + esc(v.username || v.fullName || v.userId) + '</b><div class="muted">' + esc(v.email || '') + '</div></td>' +
      '<td class="tiny">' + esc(v.planName) + '<div class="muted">' + esc(v.status) + '</div></td>' +
      '<td class="tiny">' + money(v.amountUsd) + '<div class="muted">earned ' + money(v.accruedUsd) + '</div></td>' +
      '<td>' + (v.status === 'active' ? '<input class="input" style="width:70px;padding:4px 6px" type="number" min="0" step="0.01" data-if="dailyReturnPct" value="' + esc(v.dailyReturnPct) + '"/>' : esc(v.dailyReturnPct)) + '</td>' +
      '<td class="tiny">' + esc(day(v.startAt)) + '</td>' +
      '<td>' + (v.status === 'active' ? '<input class="input" style="width:140px;padding:4px 6px" type="date" data-if="endAt" value="' + esc(day(v.endAt)) + '"/>' : esc(day(v.endAt))) + '</td>' +
      '<td>' + (v.status === 'active' ? '<div class="row" style="gap:4px;flex-wrap:wrap"><button class="btn btn-xs btn-primary" data-shx="edit" data-id="' + esc(v.id) + '">Save</button><button class="btn btn-xs btn-ghost" data-shx="cancel" data-id="' + esc(v.id) + '">Cancel</button></div>' : '') + '</td></tr>';
  }
  function invHtml(d) {
    var rows = (d && d.investments) || [];
    return '<div class="card" id="sharesExtraInv" style="margin-top:12px"><div class="card-title" style="margin:0">Share investments</div>' +
      '<div class="tiny muted" style="margin-top:3px">Change the daily return or end date of a running investment, or cancel it. Users are notified of every change.</div>' +
      '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap"><select class="input" id="shxStatus" style="max-width:140px">' +
      ['active', 'completed', 'cancelled', 'all'].map(function (s) { return '<option value="' + s + '"' + (st.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
      '<input class="input" id="shxQ" placeholder="Search user, email or plan" value="' + esc(st.q) + '" style="max-width:240px"/><button class="btn btn-sm" data-shx="search">Search</button>' +
      '<span class="tiny muted" style="align-self:center">' + ((d && d.total) || 0) + ' found</span></div>' +
      '<div class="table-wrap" style="margin-top:10px;max-height:460px;overflow:auto"><table class="tbl"><thead><tr><th>User</th><th>Plan</th><th>Amount</th><th>Daily %</th><th>Start</th><th>End</th><th></th></tr></thead><tbody>' +
      (rows.map(invRow).join('') || '<tr><td colspan="7" class="tiny muted">No investments.</td></tr>') + '</tbody></table></div></div>';
  }

  var busy = false;
  function render() {
    var anchor = $('sharesAdminCard');
    if (!anchor || !isAdminUser() || busy) return;
    if ($('sharesExtraWrap') && $('sharesExtraWrap').previousElementSibling === anchor) return;
    busy = true;
    var wrap = $('sharesExtraWrap') || document.createElement('div');
    wrap.id = 'sharesExtraWrap';
    anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    wrap.innerHTML = '<div class="card" style="margin-top:12px"><div class="tiny muted">Loading share settings…</div></div>';
    refresh(wrap).then(function () { busy = false; }, function () { busy = false; });
  }
  function refresh(wrap) {
    wrap = wrap || $('sharesExtraWrap'); if (!wrap) return Promise.resolve();
    return Promise.all([
      jget('/api/shares/admin'),
      jget('/api/shares/admin/investments?status=' + encodeURIComponent(st.status) + '&q=' + encodeURIComponent(st.q))
    ]).then(function (r) {
      if (!r[0] || !r[0].ok || !r[0].settings) { wrap.innerHTML = '<div class="card" style="margin-top:12px"><div class="tiny muted">Unlock your admin session to manage share settings.</div><button class="btn btn-sm btn-primary mt6" data-shx="retry">Retry</button></div>'; bind(wrap); return; }
      wrap.innerHTML = settingsHtml(r[0].settings) + invHtml(r[1]);
      bind(wrap);
    }).catch(function () {
      wrap.innerHTML = '<div class="card" style="margin-top:12px"><div class="tiny muted">Could not load share settings — check your connection and retry.</div><button class="btn btn-sm btn-primary mt6" data-shx="retry">Retry</button></div>';
      bind(wrap);
    });
  }
  function bind(wrap) {
    wrap.querySelectorAll('[data-shx]').forEach(function (b) {
      b.onclick = function () {
        var act = b.getAttribute('data-shx'), id = b.getAttribute('data-id');
        if (act === 'retry') return refresh(wrap);
        if (act === 'search') { st.status = $('shxStatus').value; st.q = $('shxQ').value.trim(); return refresh(wrap); }
        if (act === 'settings') {
          var body = { basePriceUsd: $('shxBase').value, volatilityPct: $('shxVol').value, resetPriceToBase: $('shxReset').checked, investmentsPaused: $('shxPause').checked, pauseReason: $('shxReason').value.trim() };
          return jpost('/api/shares/admin/settings', body).then(function (r) { if (r && r.ok) { note('Share settings saved', 'ok'); refresh(wrap); } else note((r && r.error) || 'Save failed', 'err'); });
        }
        var row = b.closest('tr');
        if (act === 'edit') {
          var endV = row.querySelector('[data-if="endAt"]').value;
          var body2 = { id: id, action: 'edit', dailyReturnPct: row.querySelector('[data-if="dailyReturnPct"]').value, endAt: endV ? Date.parse(endV + 'T23:59:00') : '' };
          return jpost('/api/shares/admin/investment', body2).then(function (r) { if (r && r.ok) { note('Investment updated', 'ok'); refresh(wrap); } else note((r && r.error) || 'Update failed', 'err'); });
        }
        if (act === 'cancel') {
          if (!confirm('Cancel this investment? Accrued earnings are forfeited.')) return;
          var refund = confirm('Refund the principal to the user\'s WC-Investing capital?\nOK = refund, Cancel = no refund');
          return jpost('/api/shares/admin/investment', { id: id, action: 'cancel', refund: refund }).then(function (r) { if (r && r.ok) { note('Investment cancelled', 'ok'); refresh(wrap); } else note((r && r.error) || 'Cancel failed', 'err'); });
        }
      };
    });
  }
  setInterval(render, 1500);
})();
