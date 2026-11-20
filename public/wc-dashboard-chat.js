/* =========================================================================
   WhaleChat · account page chat shortcut (wc-dashboard-chat)
   -------------------------------------------------------------------------
   3.66.1 — automatic chat-button generation on the account page is OFF.

   Root cause of the duplicated "Your chats" cards:
     the old module inserted the strip as a SIBLING of .wallet-card
       card.parentNode.insertBefore(strip, card.nextSibling)
     but guarded against duplicates by looking INSIDE the card
       card.querySelector('[data-wc-chat-strip]')
     The guard could therefore never match, and a 1200 ms setInterval
     appended another card on every tick — five copies after six seconds,
     more the longer the page stayed open.

   This module now:
     · never generates a button or a card on its own,
     · removes every strip / injected chat button an older build left,
     · keeps the account page clean across re-renders.

   Set window.WC_ACCOUNT_CHAT_SHORTCUT = true before boot to opt back IN to
   exactly ONE chat button on the balance card (idempotent, never duplicated).
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcDashboardChat) return;
  window.__wcDashboardChat = true;

  var ENABLED = window.WC_ACCOUNT_CHAT_SHORTCUT === true;

  /* ---- cleanup: undo anything an older build injected ------------------- */
  function purge() {
    try {
      var strips = document.querySelectorAll('.wc-dash-chat-strip, [data-wc-chat-strip]');
      for (var i = 0; i < strips.length; i++) {
        if (strips[i] && strips[i].parentNode) strips[i].parentNode.removeChild(strips[i]);
      }
      /* keep at most one generated chat button per account card */
      var buttons = document.querySelectorAll('.wallet-card .wallet-actions .btn[data-wc-chat]');
      for (var j = 1; j < buttons.length; j++) {
        if (buttons[j] && buttons[j].parentNode) buttons[j].parentNode.removeChild(buttons[j]);
      }
      if (!ENABLED) {
        for (var k = 0; k < buttons.length; k++) {
          if (buttons[k] && buttons[k].parentNode) buttons[k].parentNode.removeChild(buttons[k]);
        }
      }
    } catch (e) {}
  }

  /* ---- optional single button (opt-in only) ---------------------------- */
  function styles() {
    if (document.getElementById('wc-dash-chat-css')) return;
    var st = document.createElement('style');
    st.id = 'wc-dash-chat-css';
    st.textContent = '.wallet-card .wallet-actions .btn[data-wc-chat]{background:linear-gradient(135deg,#2ee6c9,#48b9ff)!important;' +
      'border:1px solid rgba(46,230,201,.7)!important;color:#04231e!important;font-weight:800!important;' +
      'box-shadow:0 10px 24px -14px rgba(46,230,201,.9);position:relative}';
    document.head.appendChild(st);
  }

  function chatIcon() {
    try { if (typeof ic === 'function') return ic('chat', 15); } catch (e) {}
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">' +
      '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-4-.9L3 21l1.9-4.1a8.4 8.4 0 0 1-.9-3.9 8.4 8.4 0 0 1 8.4-8.4A8.4 8.4 0 0 1 21 11.5z"/></svg>';
  }

  function addButton() {
    if (!ENABLED) return;
    var cards = document.querySelectorAll('.wallet-card');
    Array.prototype.forEach.call(cards, function (card) {
      var acts = card.querySelector('.wallet-actions');
      if (!acts || acts.querySelector('[data-wc-chat]')) return;
      var a = document.createElement('a');
      a.className = 'btn';
      a.href = '#/home';
      a.setAttribute('data-wc-chat', '1');
      a.setAttribute('aria-label', 'Open your chats');
      a.setAttribute('title', 'Open your chats');
      a.innerHTML = '<span class="wc-chat-ic">' + chatIcon() + '</span>Chat';
      acts.appendChild(a);
    });
  }

  function tick() { purge(); addButton(); }

  if (ENABLED) styles();
  tick();
  document.addEventListener('DOMContentLoaded', tick);
  /* purge only while the account page re-renders — no generation loop */
  setInterval(function () { try { tick(); } catch (e) {} }, 2000);
})();
