/* =========================================================================
   WhaleChat scroll stability + seamless refresh + screen fit
   - the app never scrolls by itself: background re-renders (sync, prices,
     notifications) keep the exact scroll position, focus and typed values
   - content that is briefly shorter while images load no longer makes the
     page jump to the top
   - the user's own scrolling always wins (touch / wheel / keys / scrollbar)
   - fits every phone / tablet / desktop width, bold high-contrast text
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__WC_SCROLL_STABLE__) return;
  window.__WC_SCROLL_STABLE__ = true;

  /* ---------- 1. user activity tracking --------------------------------- */
  let lastUserScroll = 0;
  const markUser = () => { lastUserScroll = Date.now(); };
  ['touchstart', 'touchmove', 'wheel', 'mousedown', 'keydown', 'pointerdown'].forEach((ev) =>
    window.addEventListener(ev, markUser, { passive: true, capture: true }));

  let lastHash = location.hash;
  let navigating = false;
  window.addEventListener('hashchange', () => { navigating = true; lastHash = location.hash; });

  /* ---------- 2. wrap the master render ---------------------------------- */
  function wrap() {
    if (typeof window.render !== 'function' || window.render.__wcStable) return !!(window.render && window.render.__wcStable);
    const original = window.render;
    const stable = function () {
      const isNav = navigating || location.hash !== lastHash;
      navigating = false; lastHash = location.hash;
      const c = document.getElementById('content');
      const keepTop = c ? c.scrollTop : 0;
      const keepWin = window.scrollY || 0;
      const keepH = c ? c.scrollHeight : 0;
      const result = original.apply(this, arguments);
      if (isNav) return result;               /* a new page starts at the top, as expected */
      const nc = document.getElementById('content');
      if (!nc) return result;
      /* hold the old height so the browser cannot clamp the scroll position */
      const inner = nc.firstElementChild;
      if (inner && keepH > nc.clientHeight) inner.style.minHeight = keepH + 'px';
      const started = Date.now();
      const apply = () => {
        if (lastUserScroll > started) return false;
        if (Math.abs(nc.scrollTop - keepTop) > 1) nc.scrollTop = keepTop;
        if (keepWin && Math.abs((window.scrollY || 0) - keepWin) > 1) window.scrollTo(0, keepWin);
        return true;
      };
      apply();
      requestAnimationFrame(apply);
      setTimeout(apply, 120);
      setTimeout(() => { apply(); if (inner) inner.style.minHeight = ''; }, 900);
      return result;
    };
    stable.__wcStable = true;
    window.render = stable;
    return true;
  }
  if (!wrap()) {
    let n = 0;
    const t = setInterval(() => { n++; if (wrap() || n > 60) clearInterval(t); }, 200);
  }

  /* ---------- 3. scrollIntoView only when the user asked for it ---------- */
  const nativeSIV = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function () {
    if (Date.now() - lastUserScroll > 1500) return;  /* not triggered by a tap — ignore */
    return nativeSIV.apply(this, arguments);
  };

  /* ---------- 4. screen fit + bold, clearly visible UI ------------------- */
  if (!document.getElementById('wc-screen-fit-style')) {
    const st = document.createElement('style');
    st.id = 'wc-screen-fit-style';
    st.textContent = `
  html,body{max-width:100%;overflow-x:hidden;-webkit-text-size-adjust:100%;text-size-adjust:100%}
  #content{overflow-anchor:none;overscroll-behavior:contain}
  img,video,canvas,svg,table{max-width:100%}
  .card,.field,.input-wrap,.between,.row{min-width:0}
  .card *{overflow-wrap:anywhere}
  input,select,textarea{font-size:max(16px,1em) !important;font-weight:600}
  body{font-weight:500;-webkit-font-smoothing:antialiased}
  .muted,.tiny.muted{font-weight:600}
  .label,.card-title,b,strong{font-weight:800}
  .btn{font-weight:800;min-height:42px}
  .btn-sm{min-height:36px}
  .bnav span{font-weight:700}
  @media (max-width:420px){
    .btn{padding-left:12px;padding-right:12px}
    .card{padding-left:12px;padding-right:12px}
  }
  @media (min-width:900px){ body{font-size:16.5px} }
  /* instant taps: no double-tap-zoom wait, immediate press feedback */
  a,button,.btn,[data-act],[onclick],summary,label,.bnav a,select{touch-action:manipulation;-webkit-tap-highlight-color:transparent}
  .btn,button,[data-act]{transition:transform .08s ease,filter .08s ease}
  .btn:active,button:active,[data-act]:active{transform:scale(.97);filter:brightness(1.12)}
  .wc-busy{pointer-events:none;opacity:.75}`;
    document.head.appendChild(st);
  }
})();
