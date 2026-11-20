/* Live market data for the Appwrite-hosted sync function.
   Key-free sources: Yahoo Finance (equities/FX/indices) and Binance (crypto).
   Shapes match the 3.57.5 client: quotes map, single quote, provider candles. */
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YAHOO_INDEX = {
  US30: '^DJI', US100: '^NDX', US500: '^GSPC', UK100: '^FTSE', DE40: '^GDAXI',
  JP225: '^N225', HK50: '^HSI', GOLD: 'GC=F', SILVER: 'SI=F', OIL: 'CL=F',
};
const FX = new Set(['EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD','EURGBP','EURJPY','GBPJPY','AUDJPY','CADJPY','CHFJPY','EURCHF','EURCAD','GBPCAD','GBPCHF','GBPAUD','AUDCAD','AUDCHF','AUDNZD','NZDJPY','NZDCAD','USDSEK','USDNOK','USDMXN','USDZAR','USDTRY','USDINR']);
const CRYPTO = new Set(['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','DOT','LINK','MATIC','LTC','TRX','SHIB','ATOM','UNI','BCH','ETC','XLM','NEAR','APT','ARB','OP','SUI','PEPE','FIL','ICP','INJ','TIA','SEI']);
const QUOTE_TTL = 15000;
const CANDLE_TTL = 60000;
const quoteCache = new Map();
const candleCache = new Map();

async function yahooGet(path, timeout = 12000) {
  const hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  let last = { ok: false, status: 0 };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const host of hosts) {
      last = await getJSON(host + path, timeout);
      if (last.ok && last.json) return last;
      if (last.status !== 429 && last.status !== 0) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return last;
}

async function getJSON(url, timeout = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA, accept: 'application/json', 'accept-language': 'en-US,en;q=0.9', referer: 'https://finance.yahoo.com/', origin: 'https://finance.yahoo.com' } });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { ok: r.ok, status: r.status, json };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  } finally { clearTimeout(timer); }
}

function yahooSymbol(sym) {
  const s = String(sym || '').toUpperCase();
  if (YAHOO_INDEX[s]) return YAHOO_INDEX[s];
  if (FX.has(s)) return s.slice(0, 3) + s.slice(3) + '=X';
  return s;
}
function isCrypto(sym) {
  const s = String(sym || '').toUpperCase();
  return s.endsWith('USDT') || CRYPTO.has(s) || CRYPTO.has(s.replace(/USDT$/, ''));
}
function binanceSymbol(sym) {
  const s = String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.endsWith('USDT') ? s : s + 'USDT';
}

function quoteShape(sym, price, prevClose, extra) {
  const p = Number(price);
  if (!(p > 0)) return null;
  const prev = Number(prevClose) > 0 ? Number(prevClose) : p;
  const open = Number(extra && extra.open) > 0 ? Number(extra.open) : prev;
  const updatedAt = Number(extra && extra.at) || Date.now();
  return {
    symbol: sym,
    price: p,
    prevClose: prev,
    open,
    dayHigh: Number(extra && extra.high) > 0 ? Number(extra.high) : Math.max(p, open),
    dayLow: Number(extra && extra.low) > 0 ? Number(extra.low) : Math.min(p, open),
    vol: Number(extra && extra.vol) || 0,
    dir: p > prev ? 1 : p < prev ? -1 : 0,
    updatedAt,
    source: (extra && extra.source) || 'yahoo',
    delayed: !!(extra && extra.delayed),
  };
}


const CNBC_MAP = {
  US30: '.DJI', US100: '.NDX', US500: '.SPX', UK100: '.FTSE', DE40: '.GDAXI',
  JP225: '.N225', HK50: '.HSI', GOLD: '@GC.1', SILVER: '@SI.1', OIL: '@CL.1',
};
function cnbcSymbol(sym) {
  const s = String(sym || '').toUpperCase();
  if (CNBC_MAP[s]) return CNBC_MAP[s];
  if (FX.has(s)) return '';
  return s;
}

async function fromCNBC(symbols) {
  const out = {};
  const map = {};
  symbols.forEach((s) => { const c = cnbcSymbol(s); if (c) map[c] = s; });
  const list = Object.keys(map);
  if (!list.length) return out;
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40);
    const r = await getJSON('https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols=' +
      encodeURIComponent(chunk.join('|')) + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json');
    if (!r.ok || !r.json) continue;
    const arr = (r.json.ITVQuoteResult && r.json.ITVQuoteResult.ITVQuote) || [];
    (Array.isArray(arr) ? arr : [arr]).forEach((row) => {
      if (!row || !row.symbol) return;
      const sym = map[String(row.symbol).toUpperCase()];
      if (!sym) return;
      const last = Number(String(row.last || '').replace(/,/g, ''));
      const change = Number(String(row.change || '0').replace(/,/g, ''));
      const q = quoteShape(sym, last, change ? last - change : last, {
        open: Number(String(row.open || '0').replace(/,/g, '')),
        high: Number(String(row.high || '0').replace(/,/g, '')),
        low: Number(String(row.low || '0').replace(/,/g, '')),
        vol: Number(String(row.volume || '0').replace(/[^0-9.]/g, '')),
        source: 'cnbc', delayed: false,
      });
      if (q) out[sym] = q;
    });
  }
  return out;
}

async function yahooChartQuote(sym) {
  const path = '/v8/finance/chart/' + encodeURIComponent(yahooSymbol(sym)) + '?range=1d&interval=5m&includePrePost=false';
  const r = await yahooGet(path);
  const result = r.ok && r.json && r.json.chart && r.json.chart.result && r.json.chart.result[0];
  if (!result) return null;
  const meta = result.meta || {};
  const closes = ((result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || []).filter((x) => Number(x) > 0);
  const price = Number(meta.regularMarketPrice) || Number(closes[closes.length - 1]);
  const prev = Number(meta.chartPreviousClose) || Number(meta.previousClose) || Number(closes[0]) || price;
  const q = quoteShape(sym, price, prev, {
    open: Number(meta.regularMarketOpen) || Number(closes[0]),
    high: Number(meta.regularMarketDayHigh) || Math.max.apply(null, closes.concat([price])),
    low: Number(meta.regularMarketDayLow) || Math.min.apply(null, closes.concat([price])),
    vol: Number(meta.regularMarketVolume) || 0,
    at: Number(meta.regularMarketTime) ? Number(meta.regularMarketTime) * 1000 : Date.now(),
    source: 'yahoo', delayed: true,
  });
  return q;
}

async function fromYahoo(symbols) {
  const out = {};
  const queue = symbols.slice(0, 60);
  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      if (!sym) break;
      const q = await yahooChartQuote(sym);
      if (q) out[sym] = q;
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  return out;
}

async function nasdaqQuote(sym) {
  const s = String(sym || '').toUpperCase();
  if (!/^[A-Z.]+$/.test(s)) return null;
  const r = await getJSON('https://api.nasdaq.com/api/quote/' + encodeURIComponent(s) + '/info?assetclass=stocks', 10000);
  if (!r.ok || !r.json || !r.json.data) return null;
  const d = r.json.data;
  const p = d.primaryData || {};
  const last = Number(String(p.lastSalePrice || '').replace(/[^0-9.]/g, ''));
  if (!(last > 0)) return null;
  const net = Number(String(p.netChange || '0').replace(/[^0-9.-]/g, ''));
  return quoteShape(sym, last, net ? last - net : last, {
    volume: Number(String(p.volume || '0').replace(/[^0-9.]/g, '')),
    source: 'nasdaq', delayed: false,
  });
}

async function fromBinance(symbols) {
  const out = {};
  if (!symbols.length) return out;
  const map = {};
  symbols.forEach((s) => { map[binanceSymbol(s)] = s; });
  const list = Object.keys(map).slice(0, 100);
  const url = 'https://data-api.binance.vision/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(list));
  const r = await getJSON(url);
  if (!r.ok || !Array.isArray(r.json)) return out;
  r.json.forEach((row) => {
    const sym = map[row.symbol];
    if (!sym) return;
    const q = quoteShape(sym, row.lastPrice, row.openPrice || row.prevClosePrice, {
      open: row.openPrice, high: row.highPrice, low: row.lowPrice,
      vol: row.quoteVolume || row.volume, source: 'binance', delayed: false,
    });
    if (q) out[sym] = q;
  });
  return out;
}

async function quotes(symbols) {
  const list = Array.from(new Set((symbols || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))).slice(0, 80);
  const out = {};
  const now = Date.now();
  const missing = [];
  for (const s of list) {
    const hit = quoteCache.get(s);
    if (hit && now - hit.at < QUOTE_TTL) out[s] = hit.q;
    else missing.push(s);
  }
  const crypto = missing.filter(isCrypto);
  const equity = missing.filter((s) => !isCrypto(s));
  const [b, cn] = await Promise.all([fromBinance(crypto), fromCNBC(equity)]);
  const stillMissing = equity.filter((s) => !cn[s]);
  const y = stillMissing.length ? await fromYahoo(stillMissing) : {};
  const afterYahoo = equity.filter((s) => !cn[s] && !y[s]);
  const nd = {};
  for (const s of afterYahoo.slice(0, 8)) {
    const q = await nasdaqQuote(s);
    if (q) nd[s] = q;
  }
  for (const q of Object.values(Object.assign({}, y, cn, nd, b))) {
    out[q.symbol] = q;
    quoteCache.set(q.symbol, { q, at: now });
  }
  const sources = [];
  if (Object.keys(cn || {}).length) sources.push('cnbc');
  if (Object.keys(y || {}).length) sources.push('yahoo');
  if (Object.keys(nd || {}).length) sources.push('nasdaq');
  if (Object.keys(b || {}).length) sources.push('binance');
  return { ok: true, quotes: out, source: sources.join('+') || 'none', at: now, configured: { cnbc: true, yahoo: true, nasdaq: true, binance: true, finnhub: false } };
}

const TF_MAP = {
  '1m': ['1m', '1d'], '5m': ['5m', '5d'], '15m': ['15m', '5d'], '30m': ['30m', '1mo'],
  '1H': ['60m', '1mo'], '4H': ['60m', '3mo'], '1D': ['1d', '1y'], '1W': ['1wk', '5y'],
};

async function yahooCandles(sym, tf) {
  const pair = TF_MAP[tf] || TF_MAP['1H'];
  const path = '/v8/finance/chart/' + encodeURIComponent(yahooSymbol(sym)) +
    '?range=' + pair[1] + '&interval=' + pair[0] + '&includePrePost=false';
  const r = await yahooGet(path);
  const result = r.ok && r.json && r.json.chart && r.json.chart.result && r.json.chart.result[0];
  if (!result || !Array.isArray(result.timestamp)) return null;
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const candles = [];
  for (let i = 0; i < result.timestamp.length; i += 1) {
    const o = Number(q.open && q.open[i]);
    const h = Number(q.high && q.high[i]);
    const l = Number(q.low && q.low[i]);
    const c = Number(q.close && q.close[i]);
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    candles.push({ time: result.timestamp[i], open: o, high: h, low: l, close: c, volume: Number(q.volume && q.volume[i]) || 0 });
  }
  return candles;
}

async function binanceCandles(sym, tf) {
  const map = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1H': '1h', '4H': '4h', '1D': '1d', '1W': '1w' };
  const url = 'https://data-api.binance.vision/api/v3/klines?symbol=' + encodeURIComponent(binanceSymbol(sym)) +
    '&interval=' + encodeURIComponent(map[tf] || '1h') + '&limit=500';
  const r = await getJSON(url);
  if (!r.ok || !Array.isArray(r.json)) return null;
  return r.json.map((row) => ({
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
    volume: Number(row[5]) || 0,
  })).filter((c) => c.open > 0 && c.close > 0);
}

async function candles(sym, tf) {
  const symbol = String(sym || '').trim().toUpperCase();
  const timeframe = String(tf || '1H');
  const key = symbol + '::' + timeframe;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < CANDLE_TTL) return hit.value;
  const list = isCrypto(symbol) ? await binanceCandles(symbol, timeframe) : await yahooCandles(symbol, timeframe);
  if (!list || !list.length) return { ok: false, error: 'no_candles', symbol, tf: timeframe };
  const value = {
    ok: true,
    symbol,
    tf: timeframe,
    source: isCrypto(symbol) ? 'binance' : 'yahoo',
    delayed: !isCrypto(symbol),
    candles: list,
  };
  candleCache.set(key, { value, at: Date.now() });
  return value;
}

async function history(symbols, limit) {
  const list = (symbols || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean).slice(0, 10);
  const out = {};
  let source = '';
  for (const symbol of list) {
    const c = await candles(symbol, '5m');
    if (!c.ok) continue;
    source = c.source;
    out[symbol] = c.candles.slice(-(Number(limit) || 500)).map((x) => ({
      t: x.time * 1000, p: x.close, real: true, source: c.source,
    }));
  }
  return { ok: true, history: out, source: source || 'provider', at: Date.now() };
}

async function diag() {
  const cnbc = await getJSON('https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols=AAPL&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json');
  const yahoo = await yahooGet('/v8/finance/chart/AAPL?range=5d&interval=60m');
  const nasdaq = await getJSON('https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks', 12000);
  return {
    cnbc: { ok: cnbc.ok, status: cnbc.status, head: String(cnbc.text || '').slice(0, 120) },
    yahoo: { ok: yahoo.ok, status: yahoo.status },
    nasdaq: { ok: nasdaq.ok, status: nasdaq.status, head: JSON.stringify(nasdaq.json || {}).slice(0, 160) },
  };
}

module.exports = { quotes, candles, history, isCrypto, yahooSymbol, diag, _test: { fromYahoo, fromBinance, getJSON } };
