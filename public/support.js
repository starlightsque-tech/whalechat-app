(function () {
  try {
    const el = document.createElement('style');
    el.textContent = '.refund-list{display:flex;flex-direction:column;gap:8px;max-height:260px;overflow:auto;padding:4px}' +
      '.refund-row{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);cursor:pointer}' +
      '.refund-row:hover{border-color:var(--accent)}' +
      '.refund-row input{width:16px;height:16px;flex:0 0 auto}';
    document.head.appendChild(el);
  } catch (e) {}
})();

/* =============================================================================
   Company support, vendor↔user chat restrictions and stock refunds
   -----------------------------------------------------------------------------
   - The circled order action opens the company's live support chat.
   - Vendors and shoppers can never message each other directly; any attempt
     routes to company support (live widget, with in-app admin chat fallback).
   - Vendors can select unsold company stock and request one refund covering
     several products. Admin approval restores the units to company stock and
     credits the vendor's balance.
   ========================================================================== */
'use strict';

function isVendorAccount(u) {
  return !!(u && (u.vendorId || (typeof vendorOf === 'function' && vendorOf(u.id))));
}

/* ---------------- live company support ---------------- */
App.liveSupport = function (orderId) {
  const o = orderId ? (DB.orders || []).find(x => x.id === orderId) : null;
  const tryOpen = () => {
    try {
      if (window.Tawk_API && typeof window.Tawk_API.maximize === 'function') {
        if (typeof smartsuppIdentify === 'function') smartsuppIdentify();
        try { window.Tawk_API.visitor = { name: (me() || {}).fullName || '', email: (me() || {}).email || '' }; } catch (e) {}
        try {
          if (o && window.Tawk_API.addEvent) window.Tawk_API.addEvent('order_reference', { ref: o.ref, status: o.status });
        } catch (e) {}
        window.Tawk_API.maximize();
        return true;
      }
    } catch (e) {}
    return false;
  };
  if (tryOpen()) { toast('Opening live support chat…', 'ok'); return; }
  // widget still loading: use the existing retry flow, but fall back to the
  // in-app company support conversation instead of a dead end.
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (tryOpen()) { clearInterval(timer); toast('Opening live support chat…', 'ok'); }
    else if (tries > 8) {
      clearInterval(timer);
      toast('Live chat is loading slowly — opening in-app support', 'ok');
      App.supportChat();
    }
  }, 350);
};

function supportOnlyView() {
  return `<div class="card empty" style="max-width:560px;margin:40px auto">
    <div class="ic">${ic('shield', 28)}</div>
    <h3>Direct vendor chat is disabled</h3>
    <p class="small muted" style="line-height:1.7">Shoppers and vendors can only talk to the WhaleChat support team. Our team handles every order, refund and delivery question, so nothing gets lost between a store and a buyer.</p>
    <div class="row gap8 mt16" style="justify-content:center;flex-wrap:wrap">
      <button class="btn btn-primary" data-act="live-support">${ic('chat', 15)} Open live support</button>
      <a href="#/home" class="btn btn-ghost">Back to app</a>
    </div>
  </div>`;
}

/* guard every navigation path into a vendor↔shopper conversation */
const _openChat = App.openChat;
App.openChat = function (id) {
  if (!id) return;
  const u = me();
  const other = findUser(id);
  if (u && other && u.role !== 'admin' && other.role !== 'admin' && u.id !== other.id) {
    const uVendor = isVendorAccount(u);
    const oVendor = isVendorAccount(other);
    if (uVendor !== oVendor) {
      toast('Vendor and shopper chats are disabled — connecting you to company support', 'ok', 3600);
      return App.liveSupport();
    }
  }
  return _openChat.call(App, id);
};

const _chatView = VIEWS.chat;
VIEWS.chat = function (parts) {
  const u = me();
  const other = findUser(parts[1] || '');
  if (u && other && u.role !== 'admin' && other.role !== 'admin' && u.id !== other.id) {
    if (isVendorAccount(u) !== isVendorAccount(other)) return supportOnlyView();
  }
  return _chatView.apply(this, arguments);
};

/* ---------------- vendor refund requests ---------------- */
LT.refundPendingForPurchase = function (purchaseId) {
  return (DB.refunds || []).some(r => r.status === 'pending' && (
    r.purchaseId === purchaseId || (r.items || []).some(i => i.purchaseId === purchaseId)
  ));
};

LT.refundablePurchases = function (vendor) {
  return (DB.purchases || []).filter(b => b.vendorId === vendor.id && b.status !== 'refunded')
    .map(b => {
      const inv = (DB.products || []).find(x => x.id === b.inventoryId);
      const company = (DB.companyProducts || []).find(c => c.id === b.companyProductId);
      const available = inv ? Math.min(Number(inv.stock) || 0, Number(b.qty) || 0) : 0;
      return { purchase: b, inv, company, available, unitCoins: (Number(b.totalCoins) || 0) / Math.max(1, Number(b.qty) || 1) };
    })
    .filter(x => x.available > 0 && !LT.refundPendingForPurchase(x.purchase.id));
};

App.vendorRefundRequest = function () {
  const u = me();
  const v = vendorOf(u.id);
  if (!v) return toast('Vendor account required', 'err');
  const rows = LT.refundablePurchases(v);
  if (!rows.length) return toast('No unsold company stock available to refund', 'err');
  const totalCoins = rows.reduce((n, r) => n + r.available * r.unitCoins, 0);
  const body = rows.map(r => `<label class="refund-row">
      <input type="checkbox" name="rfItem" value="${r.purchase.id}" data-coins="${(r.available * r.unitCoins).toFixed(2)}"/>
      <span style="width:42px;height:42px;border-radius:9px;overflow:hidden;flex:0 0 auto;background:var(--surface-2)">${r.inv.image ? `<img src="${r.inv.image}" style="width:100%;height:100%;object-fit:cover"/>` : ''}</span>
      <span class="grow" style="min-width:0">
        <span class="small" style="font-weight:650;display:block">${esc(r.purchase.name)}</span>
        <span class="tiny muted">${r.available} of ${r.purchase.qty} units unsold · ${coins(r.unitCoins)} WC each</span>
      </span>
      <span class="small" style="font-weight:700;white-space:nowrap">${coins((r.available * r.unitCoins))} WC</span>
    </label>`).join('');
  openModal(modalShell('Request a refund', `
    <div class="panel" style="padding:12px;margin-bottom:12px">
      <div class="tiny" style="font-weight:600;color:var(--accent)">${ic('refresh', 12)} Stock return</div>
      <div class="tiny muted mt6" style="line-height:1.7">Select the products you want to return. If admin approves, the units go back to company stock and the amount you paid is credited to your Whale Coin balance. Only unsold units can be refunded.</div>
    </div>
    <div class="field"><label class="label">Products to refund</label>
      <div class="refund-list">${body}</div>
      <div class="help">${rows.length} eligible product${rows.length === 1 ? '' : 's'} · up to ${coins(totalCoins)} WC</div>
    </div>
    <div class="field"><label class="label">Reason for refund</label>
      <textarea class="input" id="vendorRefundReason" style="min-height:78px" placeholder="Tell admin why you are returning this stock (required)"></textarea></div>
    <div class="between panel" style="padding:10px 12px">
      <span class="tiny muted">Selected refund</span><b id="vendorRefundTotal">0 WC</b>
    </div>`,
    `<button class="btn btn-ghost" data-close>Cancel</button>
     <button class="btn btn-primary" data-act="vendor-refund-submit" data-id="${v.id}">${ic('refresh', 15)} Submit request</button>`), { width: '520px' });
  const upd = () => {
    const total = $$('input[name="rfItem"]:checked').reduce((n, el) => n + (Number(el.getAttribute('data-coins')) || 0), 0);
    const el = document.getElementById('vendorRefundTotal');
    if (el) el.textContent = coins(total) + ' WC';
  };
  $$('input[name="rfItem"]').forEach(el => { el.onchange = upd; });
  upd();
};

App.vendorRefundSubmit = function (vendorId) {
  const u = me();
  const v = vendorOf(u.id);
  if (!v || v.id !== vendorId) return toast('Vendor account required', 'err');
  const selected = $$('input[name="rfItem"]:checked').map(el => el.value);
  if (!selected.length) return toast('Select at least one product', 'err');
  const reason = ((document.getElementById('vendorRefundReason') || {}).value || '').trim();
  if (reason.length < 5) return toast('Add a short reason for the refund', 'err');

  const rows = LT.refundablePurchases(v).filter(r => selected.includes(r.purchase.id));
  if (!rows.length) return toast('Those products are no longer refundable', 'err');
  const items = rows.map(r => ({
    purchaseId: r.purchase.id,
    companyProductId: r.purchase.companyProductId,
    inventoryId: r.purchase.inventoryId,
    name: r.purchase.name,
    qty: r.available,
    unitCoins: Math.round(r.unitCoins * 100) / 100,
    coins: Math.round(r.available * r.unitCoins * 100) / 100,
    usd: Math.round((r.available * r.unitCoins) * LT_COIN * 100) / 100
  }));
  const totalCoins = Math.round(items.reduce((n, i) => n + i.coins, 0) * 100) / 100;
  const totalUsd = Math.round(items.reduce((n, i) => n + i.usd, 0) * 100) / 100;

  DB.refunds = DB.refunds || [];
  DB.refunds.unshift({
    id: uid('rfd'), kind: 'stock_return', vendorId: v.id, items,
    name: items.map(i => i.name).join(', '),
    qty: items.reduce((n, i) => n + i.qty, 0),
    coins: totalCoins, usd: totalUsd,
    reason: reason.slice(0, 400), status: 'pending', createdAt: Date.now()
  });
  notify('usr_admin', 'Refund request · ' + items.length + ' product' + (items.length === 1 ? '' : 's'),
    `@${v.username} requested a refund of ${coins(totalCoins)} WC for ${items.map(i => i.qty + '× ' + i.name).join(', ')}.`,
    '#/admin/refunds', 'refresh');
  notify(u.id, 'Refund request submitted', 'Admin will review your stock return. You will be notified when it is approved or declined.', '#/vendor', 'refresh');
  try { AUDIT.log('Vendor refund requested', items.length + ' products · ' + coins(totalCoins) + ' WC · @' + v.username); } catch (e) {}
  try { sync(); } catch (e) {}
  closeModal();
  toast('Refund request submitted for review', 'ok', 3200);
  render();
};

/* vendor hub card */
const _vendorViewForSupport = VIEWS.vendor;
VIEWS.vendor = function (parts) {
  const html = _vendorViewForSupport.apply(this, arguments);
  try {
    if (parts[1]) return html;
    const u = me();
    if (!u) return html;
    const v = vendorOf(u.id);
    if (!v) return html;
    const pending = (DB.refunds || []).filter(r => r.vendorId === v.id && r.status === 'pending');
    const eligible = LT.refundablePurchases(v);
    return html + `<div class="card mt14">
      <div class="between" style="align-items:center;flex-wrap:wrap;gap:10px">
        <div><div class="card-title" style="margin:0 0 4px">Stock returns & refunds</div>
          <div class="tiny muted">Return unsold company stock and get the amount back in Whale Coin.</div></div>
        <button class="btn ${eligible.length ? 'btn-primary' : 'btn-ghost'}" data-act="vendor-refund-request" ${eligible.length ? '' : 'disabled'}>${ic('refresh', 15)} Request refund</button>
      </div>
      <div class="row gap8 mt10" style="flex-wrap:wrap">
        <span class="badge">${eligible.length} product${eligible.length === 1 ? '' : 's'} eligible</span>
        <span class="badge ${pending.length ? 'badge-warn' : ''}">${pending.length} pending</span>
      </div>
      ${pending.length ? `<div class="inv-list mt10">${pending.map(r => `<div class="inv-row">
        <div class="grow" style="min-width:0"><div class="small" style="font-weight:600">${esc(r.items ? r.items.map(i => i.name).join(', ') : r.name)}</div>
          <div class="tiny muted">${r.qty} units · ${coins(r.coins)} WC · submitted ${timeAgo(r.createdAt)}</div></div>
        <span class="badge badge-warn">Pending review</span></div>`).join('')}</div>` : ''}
      <div class="tiny muted mt10">Admin approval removes the returned units from your inventory and restores them to the Company Marketplace stock.</div>
    </div>`;
  } catch (e) { console.error('vendor refund card', e); return html; }
};

/* ---------------- admin refund list (multi-product aware) ---------------- */
function adminRefunds() {
  const list = DB.refunds || [];
  const pending = list.filter(r => r.status === 'pending');
  const approved = list.filter(r => r.status === 'approved');
  const itemsOf = (r) => r.items && r.items.length ? r.items : [{ name: r.name, qty: r.qty }];
  return `<div class="grid-kpi k4 mb16">
      ${[['Pending refunds', pending.length, 'clock'], ['Approved', approved.length, 'check'],
         ['Refunded value', coins(approved.reduce((s, r) => s + (Number(r.coins) || 0), 0)) + ' WC', 'wallet'],
         ['Requests total', list.length, 'refresh']]
        .map(([k, v, i]) => `<div class="kpi"><div class="ic">${ic(i, 15)}</div><div class="v" style="font-size:17px">${v}</div><div class="k">${k}</div></div>`).join('')}
    </div>
    <div class="card">
      <div class="between mb16"><div><h3 style="font-size:15px">Company purchase refunds</h3>
        <p class="tiny muted mt6">Approve to return the vendor's unsold units to company stock and credit the amount back to their balance.</p></div>
        <span class="badge badge-warn">${pending.length} pending</span></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Vendor</th><th>Products</th><th>Qty</th><th>Amount</th><th>Reason</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>
      ${list.length ? list.map(r => {
        const v = vendorById(r.vendorId); const vu = v ? findUser(v.userId) : null;
        const its = itemsOf(r);
        return `<tr>
          <td><div style="font-weight:600">@${esc(v ? v.username : '—')}</div><div class="tiny muted">${esc(vu ? vu.fullName : '')}</div></td>
          <td>${its.map(i => `<div class="small" style="font-weight:600">${esc(i.name)} <span class="tiny muted">×${i.qty}</span></div>`).join('')}</td>
          <td>${r.qty}</td>
          <td><div style="font-weight:600">${coins(r.coins)} WC</div><div class="tiny muted">${usd(r.usd)}</div></td>
          <td class="tiny muted" style="max-width:180px">${esc(r.reason || '—')}</td>
          <td>${statusBadge(r.status)}</td>
          <td><div class="row gap6" style="justify-content:flex-end">
            ${r.status === 'pending' ? `<button class="btn btn-xs btn-primary" data-act="refund-approve" data-id="${r.id}">Approve</button>
              <button class="btn btn-xs btn-danger" data-act="refund-reject" data-id="${r.id}">Reject</button>` : ''}
            <button class="btn btn-xs btn-ghost" data-act="refund-del" data-id="${r.id}">${ic('trash', 12)}</button>
          </div></td></tr>`;
      }).join('') : `<tr><td colspan="7" class="center muted" style="padding:30px">No refund requests yet</td></tr>`}
      </tbody></table></div>
    </div>`;
}

/* approval supports both the new multi-item requests and older single ones */
const _refundApprove = App.refundApprove;
App.refundApprove = async function (id) {
  const r = (DB.refunds || []).find(x => x.id === id);
  if (!r || r.status !== 'pending') return;
  if (!r.items || !r.items.length) return _refundApprove.call(App, id);

  const v = vendorById(r.vendorId);
  const vu = v ? findUser(v.userId) : null;
  if (!vu) return toast('Vendor account not found', 'err');
  for (const it of r.items) {
    const inv = (DB.products || []).find(x => x.id === it.inventoryId);
    const company = (DB.companyProducts || []).find(c => c.id === it.companyProductId);
    if (!inv || (Number(inv.stock) || 0) < it.qty) return toast('Cannot approve — vendor no longer holds ' + it.qty + ' × ' + it.name, 'err');
    if (!company) return toast('Cannot approve — ' + it.name + ' is no longer in the company catalogue', 'err');
  }
  if (!await confirmDialog({
    title: 'Approve refund?',
    body: `Return ${r.items.length} product line${r.items.length === 1 ? '' : 's'} to company stock and credit ${coins(r.coins)} WC to @${v.username}?`,
    ok: 'Approve refund'
  })) return;

  r.items.forEach(it => {
    const inv = DB.products.find(x => x.id === it.inventoryId);
    const company = DB.companyProducts.find(c => c.id === it.companyProductId);
    inv.stock -= it.qty;
    if (inv.stock <= 0) DB.products = DB.products.filter(x => x.id !== inv.id);
    company.stock = (Number(company.stock) || 0) + it.qty;
    const purchase = (DB.purchases || []).find(x => x.id === it.purchaseId);
    if (purchase) { purchase.status = 'refunded'; purchase.refundedAt = Date.now(); }
  });
  (DB.users || []).forEach(x => {
    if (Array.isArray(x.cart)) x.cart = x.cart.filter(c => DB.products.some(p => p.id === c.productId));
  });

  vu.balance = Math.round((Number(vu.balance || 0) + r.coins) * 100) / 100;
  tx(vu.id, 'refund', 'Company refund · ' + r.items.length + ' product' + (r.items.length === 1 ? '' : 's'), r.coins, { refundId: r.id });
  r.status = 'approved'; r.reviewedAt = Date.now(); r.reviewedBy = me().id;
  v.completedSales = v.completedSales || 0;
  try { AUDIT.log('Refund approved', r.items.length + ' products · ' + coins(r.coins) + ' WC · @' + v.username); } catch (e) {}
  notify(vu.id, 'Refund approved 💸', `${coins(r.coins)} WC has been credited back to your balance. ${r.qty} unit${r.qty === 1 ? '' : 's'} returned to company stock.`, '#/wallet', 'refresh');
  notify('usr_admin', 'Refund completed', `${r.items.length} product line${r.items.length === 1 ? '' : 's'} returned to company stock · ${coins(r.coins)} WC refunded to @${v.username}.`, '#/admin/refunds', 'check');
  sync();
  toast('Refund approved — stock restored and balance credited', 'ok', 3600);
  render();
};
