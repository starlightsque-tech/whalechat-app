/* =========================================================================
   WhaleChat readability — larger, higher-contrast text and clearer buttons
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || document.getElementById('wc-readability-style')) return;
  const st = document.createElement('style');
  st.id = 'wc-readability-style';
  st.textContent = `
  :root{--muted:#b3ccdc;--muted-2:#95b0c2}
  html[data-theme="light"]{--muted:#445c6a;--muted-2:#5f7889}
  body{font-size:15.5px}
  .tiny{font-size:12.5px !important;line-height:1.6}
  .small{font-size:14px}
  .muted{color:var(--muted)}
  .label{color:var(--text);font-weight:700;font-size:13px;letter-spacing:.01em}
  .btn{font-weight:700;font-size:15px}
  .btn-sm{font-size:13.5px}
  .btn-xs{font-size:12.5px;height:31px}
  .btn-ghost,.btn-icon{border-color:var(--border-strong)}
  .btn-ghost{background:var(--surface-3)}
  .chip{font-size:13px;font-weight:700;color:var(--text)}
  .card-title{font-size:15px}
  .nav-item{font-size:15px}
  .bnav span{font-size:10.5px !important}
  .badge{font-weight:700}
  input,select,textarea{font-size:15px}
  input::placeholder,textarea::placeholder{color:var(--muted-2);opacity:1}
  .kv .k,.between .tiny.muted,.card .tiny.muted{color:var(--muted)}
  .inv-price,.inv-big{letter-spacing:-.02em}
  .lt-card .tiny{font-size:12px !important}
  .bot-admin-table th,.inv-table th{font-size:11.5px;color:var(--muted)}
  .bot-admin-table td,.inv-table td{font-size:12.5px}
  @media(max-width:560px){.tiny{font-size:12.25px !important}.btn-sm{font-size:13.5px}}
  `;
  document.head.appendChild(st);
})();
