/* =========================================================================
   WhaleChat signup code bridge  (wc-otp-bridge)

   The sync host cannot send mail (Brevo blocks its IP), so the verification
   code is generated and emailed from the Cloudflare edge instead. This module
   transparently points the existing signup screen at:
       /api/verify/signup/send    → /api/otp/send
       /api/verify/signup/confirm → /api/otp/check
   The screen's own countdown, paste, auto-submit and success handling stay
   exactly as they are.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcOtpBridge) return;
  window.__wcOtpBridge = true;

  var orig = window.fetch;
  if (typeof orig !== 'function') return;

  var PAGES_ORIGIN = 'https://whalechat.pages.dev';
  function origin() {
    try { return /\.pages\.dev$/i.test(location.hostname) ? '' : PAGES_ORIGIN; } catch (e) { return PAGES_ORIGIN; }
  }
  function rewrite(url) {
    var u = String(url || '');
    var o = origin();
    if (/\/api\/verify\/signup\/send(?:[?#]|$)/.test(u)) return o + '/api/otp/send';
    if (/\/api\/verify\/signup\/confirm(?:[?#]|$)/.test(u)) return o + '/api/otp/check';
    return null;
  }

  window.fetch = function (input, init) {
    try {
      if (typeof input === 'string') {
        var next = rewrite(input);
        if (next) return orig.call(this, next, init);
      } else if (input && typeof input === 'object' && input.url) {
        var nextUrl = rewrite(input.url);
        if (nextUrl) {
          var req = new Request(nextUrl, input);
          return orig.call(this, req, init);
        }
      }
    } catch (e) {}
    return orig.apply(this, arguments);
  };
})();
