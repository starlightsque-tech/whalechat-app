'use strict';
/* =========================================================================
   WhaleChat · Appwrite orders adapter
   -------------------------------------------------------------------------
   Thin, bounded REST client for the `orders` / `offline_orders` collections.
   Used only by the reconciliation engine:

     findOrder(clientOrderId)  → document | null   (idempotency guard)
     createOrder(doc)          → document
     listOrders(userId, limit) → documents

   It is a NO-OP when APPWRITE_API_KEY is missing, so the app still reconciles
   against its local ledger and syncs to Appwrite as soon as a key exists.

   Env:
     APPWRITE_ENDPOINT    https://nyc.cloud.appwrite.io/v1
     APPWRITE_PROJECT_ID  6aff3eda000983f5a975
     APPWRITE_API_KEY     server key (databases.* scopes)
   ========================================================================= */

const cfg = require('./server-config');

const ENDPOINT = cfg.DEFAULTS.appwrite.endpoint;
const PROJECT = cfg.DEFAULTS.appwrite.projectId;
const KEY = String(process.env.APPWRITE_API_KEY || '').trim();
const DB = cfg.DEFAULTS.appwrite.databaseId;
const ORDERS = cfg.DEFAULTS.appwrite.collections.orders;
const OFFLINE = cfg.DEFAULTS.appwrite.collections.offlineOrders;

function configured() { return !!(KEY && PROJECT); }

async function api(pathname, opts) {
  if (!configured()) return { ok: false, status: 0, json: null, error: 'appwrite_not_configured' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(ENDPOINT + pathname, Object.assign({
      headers: Object.assign({
        'X-Appwrite-Project': PROJECT,
        'X-Appwrite-Key': KEY,
        'X-Appwrite-Response-Format': '1.9.5',
        'content-type': 'application/json'
      }, (opts && opts.headers) || {}),
      signal: ctl.signal
    }, opts || {}));
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: e.message };
  } finally { clearTimeout(timer); }
}

async function findOrder(clientOrderId) {
  if (!configured()) return null;
  /* JSON query object (Appwrite 1.6+/2.x); the string DSL is rejected */
  const q = encodeURIComponent(JSON.stringify({ method: 'equal', attribute: 'clientOrderId', values: [String(clientOrderId)] }));
  const res = await api('/databases/' + DB + '/collections/' + OFFLINE + '/documents?queries[]=' + q + '&limit=1');
  if (!res.ok) return null;
  const docs = (res.json && res.json.documents) || [];
  return docs[0] || null;
}

async function createOrder(doc) {
  if (!configured()) return null;
  const id = String(doc.clientOrderId || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 36);
  const body = {
    $id: id,
    ...doc
  };
  let res = await api('/databases/' + DB + '/collections/' + OFFLINE + '/documents', {
    method: 'POST',
    body: JSON.stringify({ documentId: id, data: doc })
  });
  if (!res.ok && res.status === 409) {
    /* already stored — that is exactly the idempotent outcome we want */
    return { $id: id, duplicate: true };
  }
  if (!res.ok && res.status === 404) {
    /* collection missing: best-effort mirror into the main orders collection */
    res = await api('/databases/' + DB + '/collections/' + ORDERS + '/documents', {
      method: 'POST',
      body: JSON.stringify({ documentId: id, data: doc })
    });
  }
  return (res.ok && res.json) || null;
}

async function listOrders(userId, limit) {
  if (!configured()) return [];
  const n = Math.min(100, Math.max(1, Number(limit) || 25));
  const q = encodeURIComponent(JSON.stringify({ method: 'equal', attribute: 'userId', values: [String(userId || '')] }));
  const res = await api('/databases/' + DB + '/collections/' + OFFLINE + '/documents?queries[]=' + q + '&limit=' + n);
  return (res.ok && res.json && res.json.documents) || [];
}

async function health() {
  if (!configured()) return { configured: false, endpoint: ENDPOINT, projectId: PROJECT };
  const res = await api('/databases/' + DB + '/collections/' + OFFLINE + '/documents?limit=1');
  return { configured: true, endpoint: ENDPOINT, projectId: PROJECT, databaseId: DB, collection: OFFLINE, ok: res.ok, status: res.status };
}

module.exports = { configured, findOrder, createOrder, listOrders, health };
