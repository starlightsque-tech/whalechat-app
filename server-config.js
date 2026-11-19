'use strict';
/* =========================================================================
   WhaleChat · server configuration  (3.64.0)
   -------------------------------------------------------------------------
   ONE place for every server the app talks to. Nothing here is a secret:
   API keys, Telesign credentials and Appwrite server keys are read from the
   environment only (see .env.example) and are never written to the client.

   Configured servers
     · Appwrite   https://nyc.cloud.appwrite.io/v1  project 6aff3eda000983f5a975
                  database 6aff488e0006a3fe39e0 · bucket 6aff48620020a44c714f
     · Appwrite   sync function + storage bucket (database + files)
     · Telesign   REST Verify (SMS OTP) + SMS notifications
     · Brevo      transactional email (order receipts, verification, alerts)
     · Finnhub    REST + WebSocket quotes
     · Twelve Data REST quotes / candles
     · Binance    public combined WebSocket (crypto, no key)

   The old sync-server defaults (trycloudflare tunnel, localhost:8090) are
   gone: `syncServer` is the Appwrite site origin unless PUBLIC_URL is set.
   ========================================================================= */

const APPWRITE_ENDPOINT = String(process.env.APPWRITE_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1').replace(/\/+$/, '');
const APPWRITE_PROJECT_ID = String(process.env.APPWRITE_PROJECT_ID || '6aff3eda000983f5a975').trim();

const DEFAULTS = {
  release: '3.65.0',
  appName: 'WhaleChat',

  /* where the PWA is served from (used by the service worker + install flow) */
  publicUrl: String(process.env.PUBLIC_URL || '').replace(/\/+$/, ''),

  appwrite: {
    endpoint: APPWRITE_ENDPOINT,
    projectId: APPWRITE_PROJECT_ID,
    databaseId: String(process.env.APPWRITE_DATABASE_ID || '6aff488e0006a3fe39e0').trim(),
    bucketId: String(process.env.APPWRITE_BUCKET_ID || '6aff48620020a44c714f').trim(),
    /* collections created by scripts/deploy-appwrite-collections.mjs */
    collections: {
      orders: 'orders',
      offlineOrders: 'offline_orders',
      portfolios: 'portfolios',
      syncLog: 'sync_log'
    }
  },

  telesign: (function () {
    /* TELESIGN_BASIC accepts the pair as "customerId:apiKey"; the individual
       variables still win when both are present. */
    const combined = String(process.env.TELESIGN_BASIC || '').trim();
    const cut = combined.indexOf(':');
    const idFromCombined = cut > 0 ? combined.slice(0, cut) : '';
    const keyFromCombined = cut > 0 ? combined.slice(cut + 1) : '';
    return {
    baseUrl: String(process.env.TELESIGN_BASE_API || 'https://rest-ww.telesign.com/v1').replace(/\/+$/, ''),
    customerId: String(process.env.TELESIGN_CUSTOMER_ID || idFromCombined || '').trim(),
    apiKey: String(process.env.TELESIGN_API_KEY || keyFromCombined || '').trim(),
    verifyTemplate: String(process.env.TELESIGN_VERIFY_TEMPLATE || 'Your WhaleChat code is $$CODE$$. It expires in 5 minutes.'),
    senderId: String(process.env.TELESIGN_SENDER_ID || ''),
    codeTtlMs: Number(process.env.TELESIGN_CODE_TTL_MS || 5 * 60 * 1000)
    };
  })(),

  brevo: {
    apiKey: String(process.env.BREVO_API_KEY || '').trim(),
    senderEmail: String(process.env.BREVO_SENDER_EMAIL || 'no-reply@whalechat.app').trim(),
    senderName: String(process.env.BREVO_SENDER_NAME || 'WhaleChat').trim()
  },

  market: {
    finnhubKey: String(process.env.FINNHUB_API_KEY || '').trim(),
    twelveDataKey: String(process.env.TWELVEDATA_API_KEY || '').trim(),
    binanceWs: process.env.BINANCE_WS || 'wss://data-stream.binance.vision/stream'
  },

  reconciliation: {
    /* market orders within this band honour the offline execution price */
    tolerancePct: Number(process.env.WC_OFFLINE_TOLERANCE_PCT || 2),
    /* how many queued orders are pushed in one round trip */
    batchSize: Number(process.env.WC_OFFLINE_BATCH || 25)
  },

  email: {
    /* Appwrite sends verification + recovery mail; Brevo sends trade receipts */
    verificationFromAppwrite: true,
    receiptsViaBrevo: true
  }
};

function publicConfig() {
  return {
    release: DEFAULTS.release,
    appName: DEFAULTS.appName,
    appwrite: {
      endpoint: DEFAULTS.appwrite.endpoint,
      projectId: DEFAULTS.appwrite.projectId,
      databaseId: DEFAULTS.appwrite.databaseId,
      bucketId: DEFAULTS.appwrite.bucketId,
      collections: DEFAULTS.appwrite.collections
    },
    market: { binanceWs: DEFAULTS.market.binanceWs },
    reconciliation: { tolerancePct: DEFAULTS.reconciliation.tolerancePct },
    features: {
      telesign: !!(DEFAULTS.telesign.customerId && DEFAULTS.telesign.apiKey),
      brevo: !!DEFAULTS.brevo.apiKey,
      appwriteEmail: !!DEFAULTS.appwrite.projectId
    }
  };
}

function configured() {
  return {
    appwrite: !!(DEFAULTS.appwrite.projectId && (process.env.APPWRITE_API_KEY || '')),
    telesign: !!(DEFAULTS.telesign.customerId && DEFAULTS.telesign.apiKey),
    brevo: !!DEFAULTS.brevo.apiKey,
    finnhub: !!DEFAULTS.market.finnhubKey,
    twelveData: !!DEFAULTS.market.twelveDataKey
  };
}

module.exports = { DEFAULTS, publicConfig, configured, APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID };
