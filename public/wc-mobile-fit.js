/* Handheld fit guard: nothing may extend under the right edge or the bottom
   navigation, even if a page has a wide table or action row. */
(function () {
  if (typeof document === 'undefined') return;
  if (document.getElementById('wc-mobile-fit-style')) return;
  var st = document.createElement('style');
  st.id = 'wc-mobile-fit-style';
  st.textContent = `
  @media (max-width: 1024px), (pointer: coarse) {
    html, body { max-width: 100%; overflow-x: hidden; }
    .shell, .main, .content, .page-head, .card { min-width: 0 !important; max-width: 100% !important; }
    .content { padding-left: max(12px, env(safe-area-inset-left)) !important; padding-right: max(12px, env(safe-area-inset-right)) !important; }
    .page-head .between, .section-title, .card-title { flex-wrap: wrap; gap: 8px; }
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    img, video, canvas, svg { max-width: 100%; }
    .btn, button { max-width: 100%; }
    .topbar-search { min-width: 0; }
  }`;
  document.head.appendChild(st);
})();
