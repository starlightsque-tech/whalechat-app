'use strict';
/* Retired in 3.30.0 — the stock page chart is now the TradingView technical
   analysis + mini chart module (public/trade-analysis.js). No server-side chart
   provider is required; this file is kept only so older deployments that still
   require ./finnhub keep booting. */
console.warn('[finnhub] retired — chart data is rendered by TradingView widgets');
module.exports = {};
