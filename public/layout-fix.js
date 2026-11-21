/* =========================================================================
   WhaleChat mobile grid fix  (wc-layout-fix)

   The market cards contain a sparkline SVG with a 90x30 viewBox and no width
   attribute. Browsers give such an SVG a 300px intrinsic width, which becomes
   the grid column's min-content size — on a phone the two-column grid then
   overflowed the screen and cards were cut off. These rules let every card
   shrink to its column and keep the market grid inside the viewport.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcLayoutFix) return;
  window.__wcLayoutFix = true;

  var st = document.createElement('style');
  st.id = 'wc-layout-fix-style';
  st.textContent = [
    '.inv-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}',
    '.inv-grid>*{min-width:0}',
    '.inv-mcard{min-width:0;overflow:hidden}',
    '.inv-mcard .grow{min-width:0}',
    '.inv-sparkwrap{min-width:0;overflow:hidden}',
    '.inv-mcard svg.inv-spark{width:100%;max-width:100%;min-width:0;display:block}',
    '.b2bm-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}',
    '.b2bm-grid>*{min-width:0}',
    '.shares-svg{max-width:100%}',
    '.wcpl-hud{grid-template-columns:repeat(2,minmax(0,1fr))!important}',
    '@media(max-width:640px){.page-head{flex-wrap:wrap}.page-head>.between{flex-wrap:wrap;gap:8px}.page-head>.between>.row{flex-wrap:wrap;min-width:0}.page-head .section-title{font-size:23px;line-height:1.15}.page-head .badge{max-width:100%}}',
    '@media(max-width:370px){.inv-grid{grid-template-columns:1fr!important}.b2bm-grid{grid-template-columns:1fr!important}}',
    '@media(min-width:760px){.inv-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important}.wcpl-hud{grid-template-columns:repeat(4,minmax(0,1fr))!important}}',
    '@media(min-width:1120px){.inv-grid{grid-template-columns:repeat(4,minmax(0,1fr))!important}}'
  ].join('\n');
  if (!document.getElementById('wc-layout-fix-style')) document.head.appendChild(st);
})();
