#!/usr/bin/env node
/* =========================================================================
   Deploy the WhaleChat sync function (Appwrite Functions edition of
   server.js) to the configured Appwrite project.

   Env:
     APPWRITE_ENDPOINT       default https://nyc.cloud.appwrite.io/v1
     APPWRITE_PROJECT_ID     default 6aff3eda000983f5a975
     APPWRITE_API_KEY        server key with functions.* + storage.* scopes
     APPWRITE_FUNCTION_ID    default whalechat-sync
     WC_APPWRITE_KEY         key the function uses to read/write the bucket
                             (defaults to APPWRITE_API_KEY)

   Optional function variables are forwarded when present:
     FINNHUB_API_KEY, TWELVEDATA_API_KEY, BREVO_API_KEY, MAIL_FROM,
     TELESIGN_CUSTOMER_ID, TELESIGN_API_KEY, TELESIGN_BASE_API,
     WC_OFFLINE_TOLERANCE_PCT, BINANCE_WS, WC_BUCKET, APPWRITE_DATABASE_ID,
     WC_OFFLINE_COLLECTION

   Usage: APPWRITE_API_KEY=... npm run deploy:appwrite:function
   ========================================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (e) {}

const ENDPOINT = String(process.env.APPWRITE_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1').replace(/\/+$/, '');
const PROJECT = String(process.env.APPWRITE_PROJECT_ID || '6aff3eda000983f5a975').trim();
const KEY = String(process.env.APPWRITE_API_KEY || '').trim();
const FN_ID = String(process.env.APPWRITE_FUNCTION_ID || 'whalechat-sync').trim();
const FN_NAME = process.env.APPWRITE_FUNCTION_NAME || 'WhaleChat Sync';
const RUNTIME = process.env.APPWRITE_FUNCTION_RUNTIME || 'node-18.0';
const SRC = path.join(ROOT, 'appwrite-function');

if (!KEY) {
  console.error('Missing APPWRITE_API_KEY (functions.*, storage.* scopes).');
  process.exit(2);
}
if (!fs.existsSync(SRC)) {
  console.error('appwrite-function/ not found');
  process.exit(2);
}

const H = { 'X-Appwrite-Project': PROJECT, 'X-Appwrite-Key': KEY, 'X-Appwrite-Response-Format': '1.9.5' };

async function req(pathname, opts = {}) {
  const res = await fetch(ENDPOINT + pathname, { ...opts, headers: { ...H, 'content-type': 'application/json', ...(opts.headers || {}) } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: res.ok, status: res.status, json, text };
}

async function ensureFunction() {
  const got = await req('/functions/' + FN_ID);
  if (got.ok) { console.log('[fn] exists', FN_ID); return got.json; }
  const made = await req('/functions', {
    method: 'POST',
    body: JSON.stringify({
      functionId: FN_ID,
      name: FN_NAME,
      runtime: RUNTIME,
      execute: ['any'],
      entrypoint: 'index.js',
      timeout: 60,
      logging: true
    })
  });
  if (made.ok) { console.log('[fn] created', FN_ID); return made.json; }
  if (made.status === 403 || made.status === 401) {
    throw new Error('function create refused (' + made.status + '): ' + made.text.slice(0, 200) +
      '\n  → the API key needs the functions.write scope, and the project must have a free function slot.');
  }
  throw new Error('function create failed: ' + made.status + ' ' + made.text.slice(0, 300));
}

function tarball() {
  const out = path.join(os.tmpdir(), 'whalechat-function-' + Date.now() + '.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', SRC, '.'], { stdio: 'inherit' });
  return out;
}

async function uploadDeployment() {
  const file = tarball();
  const size = fs.statSync(file).size;
  console.log('[fn] uploading', (size / 1024).toFixed(1), 'KB');
  const res = await fetch(ENDPOINT + '/functions/' + FN_ID + '/deployments', {
    method: 'POST',
    headers: { ...H, 'content-type': 'multipart/form-data; boundary=----wc' },
    body: (() => {
      const boundary = '----wc';
      const head = Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="entrypoint"\r\n\r\nindex.js\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="activate"\r\n\r\ntrue\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="code"; filename="code.tar.gz"\r\n' +
        'Content-Type: application/gzip\r\n\r\n'
      );
      const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
      return Buffer.concat([head, fs.readFileSync(file), tail]);
    })()
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (!res.ok) throw new Error('deployment failed: ' + res.status + ' ' + text.slice(0, 300));
  console.log('[fn] deployment', json.status || 'created', json.$id || '');
  return json;
}

const VARS = [
  'FINNHUB_API_KEY', 'TWELVEDATA_API_KEY', 'BREVO_API_KEY', 'MAIL_FROM', 'MAIL_FROM_NAME',
  'TELESIGN_CUSTOMER_ID', 'TELESIGN_API_KEY', 'TELESIGN_BASE_API', 'WC_OFFLINE_TOLERANCE_PCT',
  'BINANCE_WS', 'WC_BUCKET', 'APPWRITE_DATABASE_ID', 'WC_SYNC_DB', 'WC_COLLECTION_PREFIX',
  'WC_SYNC_TRUST_BODY_USER', 'WC_OFFLINE_COLLECTION', 'PUBLIC_URL'
];

async function syncVars() {
  const values = {
    WC_APPWRITE_KEY: process.env.WC_APPWRITE_KEY || KEY,
    APPWRITE_DATABASE_ID: process.env.APPWRITE_DATABASE_ID || '6aff488e0006a3fe39e0',
    WC_SYNC_DB: process.env.WC_SYNC_DB || '6aff488e0006a3fe39e0',
    WC_COLLECTION_PREFIX: process.env.WC_COLLECTION_PREFIX ?? 'wc_',
  };
  for (const k of VARS) if (process.env[k]) values[k] = process.env[k];
  for (const [key, value] of Object.entries(values)) {
    /* Appwrite >=1.6 requires a variableId; creating it twice is a 409 we then update. */
    const made = await req('/functions/' + FN_ID + '/variables', { method: 'POST', body: JSON.stringify({ variableId: key, key, value, secret: true }) });
    if (made.ok) console.log('   var', key);
    else if (made.status === 409) {
      await req('/functions/' + FN_ID + '/variables/' + key, { method: 'PUT', body: JSON.stringify({ key, value, secret: true } ) });
      console.log('   var updated', key);
    } else console.log('   !var', key, made.status, (made.text || '').slice(0, 160));
  }

  /* the function's own runtime key needs storage + database scopes */
  const scopes = ['files.read', 'files.write', 'users.read', 'databases.read', 'databases.write', 'collections.read', 'collections.write', 'documents.read', 'documents.write'];
  const current = await req('/functions/' + FN_ID);
  const name = (current.json && current.json.name) || FN_NAME;
  const runtime = (current.json && current.json.runtime) || RUNTIME;
  const upd = await req('/functions/' + FN_ID, { method: 'PUT', body: JSON.stringify({ name, runtime, scopes, execute: ['any'], entrypoint: 'index.js', timeout: 60, logging: true, enabled: true }) });
  if (upd.ok) console.log('   scopes set');
  else console.log('   !scopes', upd.status, (upd.text || '').slice(0, 160));
}

try {
  console.log('[appwrite]', ENDPOINT, 'project', PROJECT);
  await ensureFunction();
  await syncVars();
  const dep = await uploadDeployment();
  const domain = `${ENDPOINT.replace('/v1', '')}/v1/functions/${FN_ID}/executions`;
  console.log('[fn] execute domain: https://' + PROJECT + '.' + new URL(ENDPOINT).host + '/v1/functions/' + FN_ID);
  console.log('[fn] done', dep.$id || '');
} catch (e) {
  console.error('[fn] ' + e.message);
  process.exit(1);
}
