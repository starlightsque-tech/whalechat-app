/* =========================================================================
   WhaleChat · dashboard chat shortcut (wc-dashboard-chat)
   -------------------------------------------------------------------------
   Adds a clear Chat button to the account balance card (next to WC-invest /
   vendor) so a user can open their chat page straight from the dashboard.
   The button is keyboard reachable, screen-reader labelled and matches the
   premium card styling.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcDashboardChat) return;
  window.__wcDashboardChat = true;

  function styles() {
    if (document.getElementById('wc-dash-chat-css')) return;
    var st = document.createElement('style');
    st.id = 'wc-dash-chat-css';
    st.textContent = [
      '.wallet-card .wallet-actions .btn[data-wc-chat]{',
      '  background:linear-gradient(135deg,#2ee6c9,#48b9ff)!important;border:1px solid rgba(46,230,201,.7)!important;',
      '  color:#04231e!important;font-weight:800!important;box-shadow:0 10px 24px -14px rgba(46,230,201,.9);',
      '  position:relative}',
      '.wallet-card .wallet-actions .btn[data-wc-chat] .wc-chat-ic{display:inline-flex;align-items:center;justify-content:center}',
      '.wallet-card .wallet-actions .btn[data-wc-chat] .wc-chat-dot{position:absolute;top:6px;right:7px;width:7px;height:7px;' +
        'border-radius:50%;background:#0b3a33;box-shadow:0 0 0 2px rgba(255,255,255,.55);animation:wcChatPulse 2.2s infinite}',
      '@keyframes wcChatPulse{0%,100%{opacity:.45;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}',
      '.wc-dash-chat-strip{display:flex;align-items:center;gap:10px;margin-top:12px;padding:12px 14px;border-radius:16px;' +
        'background:linear-gradient(120deg,rgba(46,230,201,.12),rgba(72,185,255,.07));border:1px solid rgba(46,230,201,.28)}',
      '.wc-dash-chat-strip b{font-size:13px;font-weight:800;display:block}',
      '.wc-dash-chat-strip .tiny{color:var(--muted);font-weight:600}',
      '.wc-dash-chat-strip .btn{margin-left:auto;flex:0 0 auto}',
      '@media(max-width:420px){.wc-dash-chat-strip{flex-wrap:wrap}.wc-dash-chat-strip .btn{margin-left:0;width:100%}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function chatIcon() {
    try { if (typeof ic === 'function') return ic('chat', 15); } catch (e) {}
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">' +
      '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-4-.9L3 21l1.9-4.1a8.4 8.4 0 0 1-.9-3.9 8.4 8.4 0 0 1 8.4-8.4A8.4 8.4 0 0 1 21 11.5z"/></svg>';
  }

  function addButton() {
    var cards = document.querySelectorAll('.wallet-card');
    if (!cards.length) return;
    Array.prototype.forEach.call(cards, function (card) {
      var acts = card.querySelector('.wallet-actions');
      if (!acts) return;
      if (!acts.querySelector('[data-wc-chat]')) {
        var a = document.createElement('a');
        a.className = 'btn';
        a.href = '#/home';
        a.setAttribute('data-wc-chat', '1');
        a.setAttribute('aria-label', 'Open your chats');
        a.setAttribute('title', 'Open your chats');
        a.innerHTML = '<span class="wc-chat-ic">' + chatIcon() + '</span>Chat<span class="wc-chat-dot"></span>';
        acts.appendChild(a);
      }
      /* one-tap strip under the balance for extra visibility */
      if (!card.querySelector('[data-wc-chat-strip]') && card.parentNode) {
        var strip = document.createElement('a');
        strip.className = 'wc-dash-chat-strip';
        strip.href = '#/home';
        strip.setAttribute('data-wc-chat-strip', '1');
        strip.innerHTML = '<span class="wc-chat-ic" style="display:flex;align-items:center;justify-content:center;width:34px;height:34px;' +
          'border-radius:50%;background:rgba(46,230,201,.16);color:#2ee6c9">' + chatIcon() + '</span>' +
          '<span><b>Your chats</b><span class="tiny">Message friends, vendors and support</span></span>' +
          '<span class="btn btn-sm btn-primary">Open chat</span>';
        if (card.nextSibling) card.parentNode.insertBefore(strip, card.nextSibling);
        else card.parentNode.appendChild(strip);
      }
    });
  }

  styles();
  setInterval(function () { try { addButton(); } catch (e) {} }, 1200);
  document.addEventListener('DOMContentLoaded', addButton);
  addButton();
})();
