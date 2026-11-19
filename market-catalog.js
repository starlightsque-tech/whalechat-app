/* =========================================================================
   WhaleChat provider catalogues  (3.54.0)

   Each live provider owns a DISJOINT set of symbols:

     Binance     · 30 crypto pairs (crypto list, 24/7)
     Finnhub     · 40 US equities (+ the legacy forex/global rows)
     Twelve Data · 60 US/global equities

   The sets are checked at load time, so the same stock can never be listed
   twice under two providers. server.js seeds these rows into db.stocks and
   tags each row with `provider`; the feeds only serve rows they own.
   ========================================================================= */
'use strict';

const BINANCE = [
  ['BTCUSDT', 'Bitcoin', '#f7931a', 'Crypto'],
  ['ETHUSDT', 'Ethereum', '#627eea', 'Crypto'],
  ['BNBUSDT', 'BNB', '#f3ba2f', 'Crypto'],
  ['SOLUSDT', 'Solana', '#14f195', 'Crypto'],
  ['XRPUSDT', 'XRP', '#23292f', 'Crypto'],
  ['ADAUSDT', 'Cardano', '#0033ad', 'Crypto'],
  ['DOGEUSDT', 'Dogecoin', '#c2a633', 'Meme'],
  ['TRUMPUSDT', 'Official Trump', '#b8860b', 'Meme'],
  ['AVAXUSDT', 'Avalanche', '#e84142', 'Crypto'],
  ['LINKUSDT', 'Chainlink', '#2a5ada', 'Crypto'],
  ['DOTUSDT', 'Polkadot', '#e6007a', 'Crypto'],
  ['LTCUSDT', 'Litecoin', '#345d9d', 'Crypto'],
  ['BCHUSDT', 'Bitcoin Cash', '#8dc351', 'Crypto'],
  ['TRXUSDT', 'TRON', '#ff060a', 'Crypto'],
  ['TONUSDT', 'Toncoin', '#0098ea', 'Crypto'],
  ['SHIBUSDT', 'Shiba Inu', '#f00500', 'Meme'],
  ['SUIUSDT', 'Sui', '#4ca3ff', 'Crypto'],
  ['APTUSDT', 'Aptos', '#00b4ab', 'Crypto'],
  ['ARBUSDT', 'Arbitrum', '#28a0f0', 'Crypto'],
  ['OPUSDT', 'Optimism', '#f01a2e', 'Crypto'],
  ['NEARUSDT', 'NEAR Protocol', '#00ec97', 'Crypto'],
  ['ICPUSDT', 'Internet Computer', '#29abe2', 'Crypto'],
  ['FILUSDT', 'Filecoin', '#0090ff', 'Crypto'],
  ['ATOMUSDT', 'Cosmos', '#2e3148', 'Crypto'],
  ['ETCUSDT', 'Ethereum Classic', '#3ab83a', 'Crypto'],
  ['XLMUSDT', 'Stellar', '#7d00ff', 'Crypto'],
  ['HBARUSDT', 'Hedera', '#222222', 'Crypto'],
  ['RENDERUSDT', 'Render', '#ff4d00', 'Crypto'],
  ['INJUSDT', 'Injective', '#00a3ff', 'Crypto'],
  ['PEPEUSDT', 'Pepe', '#3dae2b', 'Meme']
];

const FINNHUB = [
  ['AAPL', 'Apple Inc.', 'Technology', '#a2aaad', 'NASDAQ'],
  ['MSFT', 'Microsoft Corporation', 'Technology', '#00a4ef', 'NASDAQ'],
  ['NVDA', 'NVIDIA Corporation', 'Technology', '#76b900', 'NASDAQ'],
  ['AMZN', 'Amazon.com, Inc.', 'Consumer', '#ff9900', 'NASDAQ'],
  ['GOOGL', 'Alphabet Inc.', 'Technology', '#4285f4', 'NASDAQ'],
  ['META', 'Meta Platforms, Inc.', 'Technology', '#0866ff', 'NASDAQ'],
  ['TSLA', 'Tesla, Inc.', 'Automotive', '#e82127', 'NASDAQ'],
  ['AVGO', 'Broadcom Inc.', 'Technology', '#cc092f', 'NASDAQ'],
  ['JPM', 'JPMorgan Chase & Co.', 'Financials', '#6b4f2a', 'NYSE'],
  ['V', 'Visa Inc.', 'Financials', '#1a1f71', 'NYSE'],
  ['MA', 'Mastercard Incorporated', 'Financials', '#eb001b', 'NYSE'],
  ['UNH', 'UnitedHealth Group', 'Healthcare', '#002677', 'NYSE'],
  ['XOM', 'Exxon Mobil Corporation', 'Energy', '#ec1c24', 'NYSE'],
  ['JNJ', 'Johnson & Johnson', 'Healthcare', '#d51900', 'NYSE'],
  ['WMT', 'Walmart Inc.', 'Consumer', '#0071ce', 'NYSE'],
  ['PG', 'Procter & Gamble', 'Consumer', '#003da5', 'NYSE'],
  ['HD', 'The Home Depot, Inc.', 'Consumer', '#f96302', 'NYSE'],
  ['CVX', 'Chevron Corporation', 'Energy', '#1f6db4', 'NYSE'],
  ['BAC', 'Bank of America Corp.', 'Financials', '#e11b22', 'NYSE'],
  ['KO', 'The Coca-Cola Company', 'Consumer', '#f40009', 'NYSE'],
  ['PEP', 'PepsiCo, Inc.', 'Consumer', '#004b93', 'NASDAQ'],
  ['COST', 'Costco Wholesale', 'Consumer', '#e31837', 'NASDAQ'],
  ['DIS', 'The Walt Disney Company', 'Media', '#113ccf', 'NYSE'],
  ['CSCO', 'Cisco Systems, Inc.', 'Technology', '#1ba0d7', 'NASDAQ'],
  ['ADBE', 'Adobe Inc.', 'Technology', '#ff0000', 'NASDAQ'],
  ['CRM', 'Salesforce, Inc.', 'Technology', '#00a1e0', 'NYSE'],
  ['NFLX', 'Netflix, Inc.', 'Media', '#e50914', 'NASDAQ'],
  ['AMD', 'Advanced Micro Devices', 'Technology', '#ed1c24', 'NASDAQ'],
  ['INTC', 'Intel Corporation', 'Technology', '#0071c5', 'NASDAQ'],
  ['QCOM', 'Qualcomm Incorporated', 'Technology', '#3253dc', 'NASDAQ'],
  ['TXN', 'Texas Instruments', 'Technology', '#cc0000', 'NASDAQ'],
  ['ORCL', 'Oracle Corporation', 'Technology', '#f80000', 'NYSE'],
  ['IBM', 'IBM Corporation', 'Technology', '#006699', 'NYSE'],
  ['GE', 'GE Aerospace', 'Industrials', '#2c5aa0', 'NYSE'],
  ['CAT', 'Caterpillar Inc.', 'Industrials', '#ffcd11', 'NYSE'],
  ['BA', 'The Boeing Company', 'Industrials', '#0039a6', 'NYSE'],
  ['MCD', "McDonald's Corporation", 'Consumer', '#ffc72c', 'NYSE'],
  ['NKE', 'NIKE, Inc.', 'Consumer', '#111111', 'NYSE'],
  ['UBER', 'Uber Technologies, Inc.', 'Technology', '#000000', 'NYSE'],
  ['PYPL', 'PayPal Holdings, Inc.', 'Financials', '#003087', 'NASDAQ']
];

const BASE = {
  BTCUSDT: 96000, ETHUSDT: 3400, BNBUSDT: 650, SOLUSDT: 190, XRPUSDT: 2.2, ADAUSDT: 0.9,
  DOGEUSDT: 0.22, TRUMPUSDT: 8, AVAXUSDT: 38, LINKUSDT: 22, DOTUSDT: 7, LTCUSDT: 105,
  BCHUSDT: 450, TRXUSDT: 0.25, TONUSDT: 5.5, SHIBUSDT: 0.000022, SUIUSDT: 3.4, APTUSDT: 9,
  ARBUSDT: 0.9, OPUSDT: 1.8, NEARUSDT: 5, ICPUSDT: 10, FILUSDT: 5.5, ATOMUSDT: 9,
  ETCUSDT: 27, XLMUSDT: 0.42, HBARUSDT: 0.25, RENDERUSDT: 7, INJUSDT: 22, PEPEUSDT: 0.000018,
  AAPL: 230, MSFT: 430, NVDA: 135, AMZN: 210, GOOGL: 190, META: 580, TSLA: 350, AVGO: 175,
  JPM: 245, V: 310, MA: 520, UNH: 560, XOM: 115, JNJ: 155, WMT: 90, PG: 168, HD: 400,
  CVX: 155, BAC: 45, KO: 63, PEP: 158, COST: 900, DIS: 112, CSCO: 58, ADBE: 480, CRM: 280,
  NFLX: 900, AMD: 160, INTC: 22, QCOM: 170, TXN: 200, ORCL: 170, IBM: 220, GE: 180,
  CAT: 380, BA: 180, MCD: 290, NKE: 78, UBER: 74, PYPL: 85,
  SHOP: 118, SPOT: 480, PLTR: 68, SNOW: 130, CRWD: 350, DDOG: 125, NET: 110, ZS: 200,
  OKTA: 95, TWLO: 65, COIN: 300, HOOD: 48, SOFI: 14, RBLX: 45, U: 22, DKNG: 38, ABNB: 135,
  LYFT: 16, PANW: 190, FTNT: 95, MDB: 280, TEAM: 250, WDAY: 260, NOW: 1000, INTU: 650,
  ADSK: 300, CDNS: 280, SNPS: 520, KLAC: 700, LRCX: 900, AMAT: 180, MU: 100, ASML: 720,
  TSM: 190, ARM: 140, SMCI: 45, DELL: 120, HPQ: 35, HPE: 22, WDC: 60, STX: 95, NTAP: 120,
  JNPR: 37, AKAM: 95, EA: 145, TTWO: 180, ZM: 85, DOCU: 75, ESTC: 110, GTLB: 65, HUBS: 620,
  VEEV: 220, MSTR: 410, MARA: 22, RIOT: 12, CLSK: 15, BIDU: 95, JD: 38, PDD: 120, BABA: 95,
  NIO: 6, TCEHY: 50, SONY: 22, TM: 190, UL: 60, AZN: 72, NVO: 120, SHEL: 70, BP: 35, RYAAY: 110
};

const TWELVE = [
  ['SHOP', 'Shopify Inc.', 'Technology', '#96bf48', 'NYSE'],
  ['SPOT', 'Spotify Technology S.A.', 'Media', '#1db954', 'NYSE'],
  ['PLTR', 'Palantir Technologies', 'Technology', '#101113', 'NASDAQ'],
  ['SNOW', 'Snowflake Inc.', 'Technology', '#29b5e8', 'NYSE'],
  ['CRWD', 'CrowdStrike Holdings', 'Technology', '#e01f3d', 'NASDAQ'],
  ['DDOG', 'Datadog, Inc.', 'Technology', '#632ca6', 'NASDAQ'],
  ['NET', 'Cloudflare, Inc.', 'Technology', '#f38020', 'NYSE'],
  ['ZS', 'Zscaler, Inc.', 'Technology', '#0f7bd4', 'NASDAQ'],
  ['OKTA', 'Okta, Inc.', 'Technology', '#00297a', 'NASDAQ'],
  ['TWLO', 'Twilio Inc.', 'Technology', '#f22f46', 'NYSE'],
  ['COIN', 'Coinbase Global, Inc.', 'Financials', '#0052ff', 'NASDAQ'],
  ['HOOD', 'Robinhood Markets', 'Financials', '#00c805', 'NASDAQ'],
  ['SOFI', 'SoFi Technologies', 'Financials', '#00a4e4', 'NASDAQ'],
  ['RBLX', 'Roblox Corporation', 'Technology', '#e2231a', 'NYSE'],
  ['U', 'Unity Software Inc.', 'Technology', '#222c37', 'NYSE'],
  ['DKNG', 'DraftKings Inc.', 'Consumer', '#53d337', 'NASDAQ'],
  ['ABNB', 'Airbnb, Inc.', 'Consumer', '#ff5a5f', 'NASDAQ'],
  ['LYFT', 'Lyft, Inc.', 'Technology', '#ff00bf', 'NASDAQ'],
  ['PANW', 'Palo Alto Networks', 'Technology', '#fa582d', 'NASDAQ'],
  ['FTNT', 'Fortinet, Inc.', 'Technology', '#ee3124', 'NASDAQ'],
  ['MDB', 'MongoDB, Inc.', 'Technology', '#13aa52', 'NASDAQ'],
  ['TEAM', 'Atlassian Corporation', 'Technology', '#0052cc', 'NASDAQ'],
  ['WDAY', 'Workday, Inc.', 'Technology', '#f38b00', 'NASDAQ'],
  ['NOW', 'ServiceNow, Inc.', 'Technology', '#62d84e', 'NYSE'],
  ['INTU', 'Intuit Inc.', 'Technology', '#365ebf', 'NASDAQ'],
  ['ADSK', 'Autodesk, Inc.', 'Technology', '#0696d7', 'NASDAQ'],
  ['CDNS', 'Cadence Design Systems', 'Technology', '#b31b1b', 'NASDAQ'],
  ['SNPS', 'Synopsys, Inc.', 'Technology', '#004b87', 'NASDAQ'],
  ['KLAC', 'KLA Corporation', 'Technology', '#00a0df', 'NASDAQ'],
  ['LRCX', 'Lam Research Corporation', 'Technology', '#0071ce', 'NASDAQ'],
  ['AMAT', 'Applied Materials, Inc.', 'Technology', '#0072ce', 'NASDAQ'],
  ['MU', 'Micron Technology, Inc.', 'Technology', '#005a9c', 'NASDAQ'],
  ['ASML', 'ASML Holding N.V.', 'Technology', '#0f6cbd', 'NASDAQ'],
  ['TSM', 'Taiwan Semiconductor', 'Technology', '#d41f1f', 'NYSE'],
  ['ARM', 'Arm Holdings plc', 'Technology', '#0091bd', 'NASDAQ'],
  ['SMCI', 'Super Micro Computer', 'Technology', '#1b4f9c', 'NASDAQ'],
  ['DELL', 'Dell Technologies Inc.', 'Technology', '#007db8', 'NYSE'],
  ['HPQ', 'HP Inc.', 'Technology', '#0096d6', 'NYSE'],
  ['HPE', 'Hewlett Packard Enterprise', 'Technology', '#01a982', 'NYSE'],
  ['WDC', 'Western Digital Corp.', 'Technology', '#005195', 'NASDAQ'],
  ['STX', 'Seagate Technology', 'Technology', '#1f6db4', 'NASDAQ'],
  ['NTAP', 'NetApp, Inc.', 'Technology', '#0067b1', 'NASDAQ'],
  ['JNPR', 'Juniper Networks, Inc.', 'Technology', '#84b414', 'NYSE'],
  ['AKAM', 'Akamai Technologies', 'Technology', '#0099cc', 'NASDAQ'],
  ['EA', 'Electronic Arts Inc.', 'Media', '#ff4747', 'NASDAQ'],
  ['TTWO', 'Take-Two Interactive', 'Media', '#ffb400', 'NASDAQ'],
  ['ZM', 'Zoom Communications, Inc.', 'Technology', '#2d8cff', 'NASDAQ'],
  ['DOCU', 'DocuSign, Inc.', 'Technology', '#ffcc22', 'NASDAQ'],
  ['ESTC', 'Elastic N.V.', 'Technology', '#fec514', 'NYSE'],
  ['GTLB', 'GitLab Inc.', 'Technology', '#fc6d26', 'NASDAQ'],
  ['HUBS', 'HubSpot, Inc.', 'Technology', '#ff7a59', 'NYSE'],
  ['VEEV', 'Veeva Systems Inc.', 'Technology', '#f8892e', 'NYSE'],
  ['MSTR', 'Strategy (MicroStrategy)', 'Technology', '#d9232e', 'NASDAQ'],
  ['MARA', 'MARA Holdings, Inc.', 'Financials', '#00a3e0', 'NASDAQ'],
  ['RIOT', 'Riot Platforms, Inc.', 'Financials', '#f47b20', 'NASDAQ'],
  ['CLSK', 'CleanSpark, Inc.', 'Financials', '#00a86b', 'NASDAQ'],
  ['BIDU', 'Baidu, Inc.', 'Technology', '#2932e1', 'NASDAQ'],
  ['JD', 'JD.com, Inc.', 'Consumer', '#e1251b', 'NASDAQ'],
  ['PDD', 'PDD Holdings Inc.', 'Consumer', '#e02e24', 'NASDAQ'],
  ['BABA', 'Alibaba Group Holding', 'Consumer', '#ff6a00', 'NYSE'],
  ['NIO', 'NIO Inc.', 'Automotive', '#00b0e8', 'NYSE'],
  ['TCEHY', 'Tencent Holdings Ltd.', 'Technology', '#0052d9', 'OTC'],
  ['SONY', 'Sony Group Corporation', 'Technology', '#000000', 'NYSE'],
  ['TM', 'Toyota Motor Corporation', 'Automotive', '#eb0a1e', 'NYSE'],
  ['UL', 'Unilever PLC', 'Consumer', '#1f36c7', 'NYSE'],
  ['AZN', 'AstraZeneca PLC', 'Healthcare', '#c8102e', 'NASDAQ'],
  ['NVO', 'Novo Nordisk A/S', 'Healthcare', '#0058a0', 'NYSE'],
  ['SHEL', 'Shell plc', 'Energy', '#fdd430', 'NYSE'],
  ['BP', 'BP p.l.c.', 'Energy', '#009f3d', 'NYSE'],
  ['RYAAY', 'Ryanair Holdings plc', 'Industrials', '#073590', 'NASDAQ']
];

function stockRow(t, name, sector, color, exchange, provider) {
  return {
    ticker: t,
    displayTicker: t,
    finnhubSymbol: t,
    assetClass: 'us',
    name,
    exchange: exchange || 'NASDAQ',
    currency: 'USD',
    color: color || '#2ee6c9',
    sector: sector || 'Stock',
    provider,
    price: BASE[t] || 0,
    prevClose: BASE[t] || 0,
    synthetic: false,
    twentyFourSeven: false
  };
}
function cryptoRow(t, name, color, sector) {
  return {
    ticker: t,
    displayTicker: t.replace(/USDT$/, '/USDT'),
    finnhubSymbol: 'BINANCE:' + t,
    assetClass: 'crypto',
    name,
    exchange: 'Binance',
    currency: 'USDT',
    color: color || '#f3ba2f',
    sector: sector || 'Crypto',
    provider: 'binance',
    price: BASE[t] || 0,
    prevClose: BASE[t] || 0,
    synthetic: false,
    twentyFourSeven: true
  };
}

const rows = []
  .concat(BINANCE.map((r) => cryptoRow(r[0], r[1], r[2], r[3])))
  .concat(FINNHUB.map((r) => stockRow(r[0], r[1], r[2], r[3], r[4], 'finnhub')))
  .concat(TWELVE.map((r) => stockRow(r[0], r[1], r[2], r[3], r[4], 'twelvedata')));

/* hard guarantee: one ticker = one provider */
const seen = new Set();
const duplicates = [];
rows.forEach((r) => { if (seen.has(r.ticker)) duplicates.push(r.ticker); seen.add(r.ticker); });
if (duplicates.length) throw new Error('[market-catalog] duplicate ticker(s): ' + duplicates.join(', '));

const byTicker = new Map(rows.map((r) => [r.ticker, r]));
const BY_PROVIDER = {
  binance: rows.filter((r) => r.provider === 'binance').map((r) => r.ticker),
  finnhub: rows.filter((r) => r.provider === 'finnhub').map((r) => r.ticker),
  twelvedata: rows.filter((r) => r.provider === 'twelvedata').map((r) => r.ticker)
};

module.exports = {
  BINANCE, FINNHUB, TWELVE, BASE, rows, byTicker, BY_PROVIDER,
  counts: () => ({ binance: BY_PROVIDER.binance.length, finnhub: BY_PROVIDER.finnhub.length, twelvedata: BY_PROVIDER.twelvedata.length }),
  providerFor: (ticker) => { const r = byTicker.get(String(ticker || '').toUpperCase()); return r ? r.provider : ''; }
};
