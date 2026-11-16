/* =========================================================================
   WhaleChat typography — fluid, legible text on every viewport
   - every size scales with the viewport (clamp) instead of fixed px
   - weights raised one step so small copy is readable on mobile + desktop
   - no oversized headings on wide screens, no microscopic text on phones
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || document.getElementById('wc-typography-style')) return;
  const st = document.createElement('style');
  st.id = 'wc-typography-style';
  st.textContent = `
  /* fluid type scale: ~15px on a 360px phone, ~16.5–17px on desktop */
  :root{
    --wc-fs-xs: clamp(12px, 11.55px + 0.13vw, 13px);
    --wc-fs-sm: clamp(13.5px, 13px + 0.15vw, 14.5px);
    --wc-fs-base: clamp(15px, 14.2px + 0.22vw, 16.5px);
    --wc-fs-lg: clamp(16.5px, 15.6px + 0.3vw, 18px);
    --wc-fs-xl: clamp(20px, 18.4px + 0.55vw, 23px);
    --wc-fs-2xl: clamp(24px, 21px + 0.9vw, 30px);
  }

  html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
  body{font-size:var(--wc-fs-base);font-weight:500;line-height:1.55;letter-spacing:.002em}

  /* headings + titles: bolder, still fluid */
  h1,h2,h3,h4,h5,h6{font-weight:750;letter-spacing:-.015em}
  .brand-name{font-weight:800;font-size:clamp(18px,17px + .4vw,21px)}
  .section-title{font-weight:800;font-size:var(--wc-fs-xl);line-height:1.25}
  .card-title{font-weight:750;font-size:var(--wc-fs-lg)}
  .page-title{font-weight:800;font-size:var(--wc-fs-2xl)}

  /* body copy, helper text and labels */
  .small{font-size:var(--wc-fs-sm);font-weight:500}
  .tiny{font-size:var(--wc-fs-xs) !important;font-weight:550;line-height:1.6;letter-spacing:.005em}
  .muted,.text-muted{font-weight:500}
  .label{font-size:var(--wc-fs-xs) !important;font-weight:700;letter-spacing:.012em}
  .help,.hint{font-weight:500;font-size:var(--wc-fs-sm)}
  .badge{font-weight:750;font-size:var(--wc-fs-xs);letter-spacing:.02em}
  .chip{font-weight:700;font-size:var(--wc-fs-sm)}
  .kv .k{font-weight:600;font-size:var(--wc-fs-sm)}
  .kv .v{font-weight:600;font-size:var(--wc-fs-sm)}

  /* buttons + inputs */
  .btn{font-size:var(--wc-fs-base);font-weight:700}
  .btn-sm{font-size:var(--wc-fs-sm);font-weight:700}
  .btn-xs{font-size:var(--wc-fs-xs);font-weight:700;height:32px}
  button{font-weight:600}
  input,select,textarea{font-size:var(--wc-fs-base);font-weight:500}
  input::placeholder,textarea::placeholder{font-weight:500;opacity:.95}
  .nav-item,.tab,.bnav span{font-weight:600}
  .bnav span{font-size:clamp(10px,9.6px + .12vw,11px) !important;font-weight:650}

  /* tables, lists, stat blocks */
  table th{font-size:var(--wc-fs-xs);font-weight:750;letter-spacing:.015em}
  table td{font-size:var(--wc-fs-sm);font-weight:500}
  .kpi span{font-size:var(--wc-fs-xs);font-weight:700}
  .kpi b{font-weight:800;font-size:var(--wc-fs-lg)}
  .inv-table th,.bot-admin-table th,.shares-ledger th{font-weight:750}
  .inv-table td,.bot-admin-table td,.shares-ledger td{font-weight:500}

  /* trading + finance numbers stay crisp and legible */
  .inv-price,.inv-big,.wc-price,.pc-price,.shares-price,.shares-earn{font-weight:800;letter-spacing:-.015em}
  .wc-pos-line,.pc-row,.pc-hover,.pc-side b,.ta-side b{font-weight:600}
  .mkt-stat span,.bot-engine-grid span,.bot-profile-stats span{font-weight:750}
  .mkt-stat b,.bot-engine-grid b,.bot-profile-stats b{font-weight:650}

  /* charts / widgets labels */
  .pc-pill,.shares-perf-pills .pc-pill{font-weight:700;font-size:clamp(10px,9.7px + .1vw,11.5px)}
  .tradingview-widget-container,.tv-lightweight-charts{font-weight:500}

  /* mobile: never go below 12px, slightly tighter headings */
  @media (max-width:560px){
    :root{
      --wc-fs-xs: 12px;
      --wc-fs-sm: 13.5px;
      --wc-fs-base: 15px;
      --wc-fs-lg: 16.5px;
      --wc-fs-xl: 19px;
      --wc-fs-2xl: 23px;
    }
    body{line-height:1.58}
    .tiny{font-size:12px !important}
    .btn{font-size:15px}
    .btn-sm{font-size:13.5px}
    table td{font-size:13px}
  }

  /* ---------------------- user text-size preference ---------------------- */
  html[data-textsize="compact"]{
    --wc-fs-xs:11.5px; --wc-fs-sm:12.75px; --wc-fs-base:14px;
    --wc-fs-lg:15.5px; --wc-fs-xl:18px; --wc-fs-2xl:22px;
  }
  html[data-textsize="compact"] body{font-size:14px}
  html[data-textsize="compact"] .pc-price{font-size:20px}
  html[data-textsize="compact"] .shares-earn{font-size:clamp(28px,26px + .5vw,34px)}

  html[data-textsize="large"]{
    --wc-fs-xs:13.5px; --wc-fs-sm:15.5px; --wc-fs-base:17.5px;
    --wc-fs-lg:19.5px; --wc-fs-xl:25px; --wc-fs-2xl:34px;
  }
  html[data-textsize="large"] body{font-size:17.5px;line-height:1.6}
  html[data-textsize="large"] .tiny{line-height:1.65}
  html[data-textsize="large"] .pc-price{font-size:28px}
  html[data-textsize="large"] .shares-earn{font-size:clamp(36px,34px + .7vw,44px)}
  html[data-textsize="large"] .btn{min-height:46px}
  html[data-textsize="large"] .btn-sm{min-height:40px}
  html[data-textsize="large"] .btn-xs{min-height:34px}

  /* appearance control */
  .ts-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}
  .ts-opt{display:flex;flex-direction:column;align-items:center;gap:3px;padding:12px 8px;
    border:1px solid var(--border);border-radius:12px;background:var(--surface-2);
    cursor:pointer;color:var(--text);text-align:center;transition:border-color .15s,background .15s,box-shadow .15s}
  .ts-opt b{font-size:var(--wc-fs-sm);font-weight:750}
  .ts-opt i{font-style:normal;font-size:var(--wc-fs-xs);color:var(--muted);line-height:1.4}
  .ts-opt .ts-a{font-weight:800;line-height:1;color:var(--muted)}
  .ts-opt .ts-a-sm{font-size:14px}
  .ts-opt .ts-a{font-size:18px}
  .ts-opt .ts-a-lg{font-size:23px}
  .ts-opt:hover{border-color:rgba(46,230,201,.35)}
  .ts-opt.on{border-color:rgba(46,230,201,.55);background:rgba(46,230,201,.09);box-shadow:0 0 0 1px rgba(46,230,201,.18)}
  .ts-opt.on .ts-a{color:var(--accent)}
  .ts-opt:active{transform:translateY(1px)}
  @media(max-width:560px){
    .ts-row{grid-template-columns:repeat(3,1fr);gap:6px}
    .ts-opt{padding:10px 5px}
    .ts-opt i{display:none}
  }

  /* large desktop: cap growth so nothing looks oversized */
  @media (min-width:1440px){
    :root{
      --wc-fs-base: 16.5px;
      --wc-fs-lg: 18px;
      --wc-fs-xl: 23px;
      --wc-fs-2xl: 30px;
    }
  }
  `;
  document.head.appendChild(st);
})();
