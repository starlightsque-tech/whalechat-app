#!/usr/bin/env node
/* =========================================================================
   Deploy the standalone WhaleChat Admin console (admin-panel/index.html) to
   the Appwrite Sites project `whalechat-admin`.

   Env:
     APPWRITE_API_KEY      server key with sites.* scopes
     APPWRITE_PROJECT_ID   default 6aff3eda000983f5a975
     APPWRITE_ENDPOINT     default https://nyc.cloud.appwrite.io/v1
     APPWRITE_ADMIN_SITE_ID default whalechat-admin

   Usage: APPWRITE_API_KEY=... npm run deploy:appwrite:admin
   ========================================================================= */
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'admin-panel');
const ENDPOINT = String(process.env.APPWRITE_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1').replace(/\/+$/, '');
const PROJECT = String(process.env.APPWRITE_PROJECT_ID || '6aff3eda000983f5a975').trim();
const KEY = String(process.env.APPWRITE_API_KEY || '').trim();
const SITE_ID = String(process.env.APPWRITE_ADMIN_SITE_ID || 'whalechat-admin').trim().toLowerCase();
const SITE_NAME = process.env.APPWRITE_ADMIN_SITE_NAME || 'WhaleChat Admin';

if (!KEY) { console.error('Missing APPWRITE_API_KEY (sites.* scopes).'); process.exit(2); }
if (!fs.existsSync(path.join(SRC, 'index.html'))) { console.error('admin-panel/index.html not found'); process.exit(2); }

const headers = { 'X-Appwrite-Project': PROJECT, 'X-Appwrite-Key': KEY, 'X-Appwrite-Response-Format': '1.9.5' };

async function req(pathname, opts) {
  const res = await fetch(ENDPOINT + pathname, Object.assign({ headers }, opts || {}));
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: res.ok, status: res.status, json, text };
}

async function ensureSite() {
  const got = await req('/sites/' + encodeURIComponent(SITE_ID));
  if (got.ok) { console.log('[admin] site exists', SITE_ID); return got.json; }
  const made = await req('/sites', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: JSON.stringify({
      siteId: SITE_ID, name: SITE_NAME, framework: 'other', buildRuntime: 'node-22',
      adapter: 'static', installCommand: '', buildCommand: '', outputDirectory: './', enabled: true
    })
  });
  if (!made.ok) throw new Error('create site failed: ' + made.status + ' ' + (made.json && made.json.message || made.text));
  return made.json;
}

(async () => {
  console.log('[admin] endpoint', ENDPOINT, '· project', PROJECT, '· site', SITE_ID);
  await ensureSite();
  const tar = path.join(os.tmpdir(), 'whalechat-admin-' + Date.now() + '.tar.gz');
  execFileSync('tar', ['-czf', tar, '-C', SRC, '.'], { stdio: 'inherit' });
  const form = new FormData();
  form.append('installCommand', '');
  form.append('buildCommand', '');
  form.append('outputDirectory', './');
  form.append('activate', 'true');
  form.append('code', new Blob([fs.readFileSync(tar)], { type: 'application/gzip' }), 'admin-site.tar.gz');
  const dep = await req('/sites/' + encodeURIComponent(SITE_ID) + '/deployments', { method: 'POST', body: form });
  if (!dep.ok) throw new Error('deployment failed: ' + dep.status + ' ' + (dep.json && dep.json.message || dep.text).slice(0, 300));
  const id = dep.json && dep.json.$id;
  console.log('[admin] deployment', id, dep.json && dep.json.status);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await req('/sites/' + encodeURIComponent(SITE_ID) + '/deployments/' + encodeURIComponent(id));
    const status = st.json && st.json.status;
    console.log('[admin] status:', status);
    if (status === 'ready' || status === 'active') {
      const host = SITE_ID + '.' + ENDPOINT.replace(/^https?:\/\//, '').replace(/\/v1$/, '');
      console.log('[admin] deployed → https://' + host);
      process.exit(0);
    }
    if (status === 'failed' || status === 'canceled') {
      console.error('[admin] build logs:', (st.json && st.json.buildLogs) || '');
      process.exit(1);
    }
  }
  console.log('[admin] still building — check the Appwrite console.');
})().catch((e) => { console.error('[admin] error:', e.message); process.exit(1); });
