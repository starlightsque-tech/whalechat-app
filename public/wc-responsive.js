/* =========================================================================
   WhaleChat · responsive + readability pass (wc-responsive)
   -------------------------------------------------------------------------
   Every page must fit the device: nothing hidden under the screen edge, no
   horizontal scrolling, text and buttons large and bold enough to read, and
   the same rules in online and offline mode (the offline banner is accounted
   for in the bottom padding). The classic dark premium look is preserved.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcResponsive) return;
  window.__wcResponsive = true;

  function patchViewport() {
    var m = document.querySelector('meta[name="viewport"]');
    if (!m) {
      m = document.createElement('meta');
      m.name = 'viewport';
      document.head.appendChild(m);
    }
    m.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
  }

  var CSS = [
    /* no element may push the page wider than the screen */
    'html,body{max-width:100%;overflow-x:hidden}',
    '*,*::before,*::after{box-sizing:border-box}',
    'img,video,canvas,svg{max-width:100%}',
    /* safe-area aware page padding (notches, rounded corners, home bar) */
    '.content{padding-left:max(14px,env(safe-area-inset-left))!important;' +
      'padding-right:max(14px,env(safe-area-inset-right))!important;' +
      'padding-bottom:calc(var(--nav-h,64px) + 96px + env(safe-area-inset-bottom))!important}',
    '.topbar{padding-left:max(10px,env(safe-area-inset-left))!important;padding-right:max(10px,env(safe-area-inset-right))!important}',
    '.bottomnav{padding-bottom:calc(env(safe-area-inset-bottom) + 2px)!important}',
    /* long words, emails, tickers and addresses wrap instead of clipping */
    '.card,.ih-card,.wallet-card,.inv-mcard,.section-title,.page-head,.between,.row{min-width:0}',
    '.ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
    '.card p,.card div,.card span,.card li,.card td,.card th{overflow-wrap:anywhere}',
    '.page-head{flex-wrap:wrap;gap:8px}',
    '.section-title{overflow-wrap:anywhere}',
    /* readable type: no micro text, stronger weights */
    'body{font-weight:500;-webkit-text-size-adjust:100%;text-size-adjust:100%}',
    '.tiny{font-size:max(10.5px,0.72rem)!important;line-height:1.5!important;font-weight:600}',
    '.small{font-size:max(12px,0.8rem)!important;line-height:1.5!important;font-weight:600}',
    '.muted{font-weight:500}',
    'label,.label,.card-title{font-weight:700}',
    '.card-title{letter-spacing:.01em}',
    'input,select,textarea{font-size:max(16px,1rem)!important}', /* stops iOS zoom */
    /* buttons: tappable, bold, never clipped */
    '.btn,button.btn,a.btn{font-weight:700;letter-spacing:.01em;white-space:normal;text-align:center;' +
      'min-height:42px;display:inline-flex;align-items:center;justify-content:center;gap:6px;line-height:1.25}',
    '.btn-sm{min-height:38px;font-weight:700}',
    '.btn-xs{min-height:32px;font-weight:700}',
    '.btn-icon{min-width:42px;min-height:42px}',
    '.wallet-actions{grid-template-columns:repeat(auto-fit,minmax(104px,1fr))!important}',
    '.wallet-actions .btn{min-height:46px!important;font-size:max(12px,0.78rem)!important;font-weight:800!important;' +
      'white-space:normal!important;padding:8px 8px!important}',
    /* data tables scroll inside their card, never off the page */
    '.table-wrap,.tbl-wrap{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}',
    'table.tbl{min-width:0}',
    /* chips and tab rows scroll horizontally rather than overflow the body */
    '.chip-row,.inv-cats{max-width:100%;overflow-x:auto;flex-wrap:nowrap;padding-bottom:4px;' +
      'scrollbar-width:none;-webkit-overflow-scrolling:touch}',
    '.chip-row::-webkit-scrollbar,.inv-cats::-webkit-scrollbar{display:none}',
    '.chip{flex:0 0 auto;font-weight:700}',
    /* charts and market cards stay inside the viewport */
    '.inv-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,148px),1fr))!important;gap:10px!important}',
    '.inv-mcard{min-width:0}',
    '.wtc-host,.lt-chart,.bigchart,.pro-chart{max-width:100%;overflow:hidden}',
    /* floating chat button clears the nav + home bar on every device */
    '.support-fab,.wc-chat-fab,#tawk-bubble,.tawk-min-container{max-width:calc(100vw - 24px)}',
    '@media(max-width:640px){.support-fab,.wc-chat-fab{bottom:calc(var(--nav-h,64px) + 18px + env(safe-area-inset-bottom))!important;right:max(12px,env(safe-area-inset-right))!important}}',
    /* the offline strip must not cover page content */
    'html.wc-is-offline .content{padding-bottom:calc(var(--nav-h,64px) + 128px + env(safe-area-inset-bottom))!important}',
    'html.wc-is-offline body{padding-top:0}',
    '@media(max-width:420px){.content{padding-left:max(11px,env(safe-area-inset-left))!important;padding-right:max(11px,env(safe-area-inset-right))!important}}'
  ].join('\n');

  function inject() {
    if (document.getElementById('wc-responsive-css')) return;
    var st = document.createElement('style');
    st.id = 'wc-responsive-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  patchViewport();
  inject();
  document.addEventListener('DOMContentLoaded', function () { patchViewport(); inject(); });
  window.addEventListener('resize', function () {
    /* if the reader rotated or resized, the layout is already fluid — just
       make sure charts and viewport settle */
    try { window.dispatchEvent(new Event('wc:resize')); } catch (e) {}
  });
  window.WC_RESPONSIVE = true;
})();
