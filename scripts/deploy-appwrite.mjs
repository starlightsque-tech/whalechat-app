#!/usr/bin/env node
/* =========================================================================
   Deploy the WhaleChat client to Appwrite Sites.

   Required environment (never commit these):
     APPWRITE_API_KEY      server API key with sites.* + storage.* scopes
     APPWRITE_PROJECT_ID   your Appwrite project id
   Optional:
     APPWRITE_ENDPOINT     default https://cloud.appwrite.io/v1
     APPWRITE_SITE_ID      default whalechat
     APPWRITE_SITE_NAME    default WhaleChat

   Usage:
     APPWRITE_PROJECT_ID=... APPWRITE_API_KEY=... npm run deploy:appwrite

   The app is assembled first (`node scripts/prepare-assets.js`), then the
   public/ folder is packaged as a tar.gz and uploaded as a static deployment.
   ========================================================================= */
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const ENDPOINT = String(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1').replace(/\/+$/, '');
const PROJECT = String(process.env.APPWRITE_PROJECT_ID || '').trim();
const KEY = String(process.env.APPWRITE_API_KEY || '').trim();
const SITE_ID = String(process.env.APPWRITE_SITE_ID || 'whalechat').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
const SITE_NAME = String(process.env.APPWRITE_SITE_NAME || 'WhaleChat').trim();

if (!PROJECT || !KEY) {
  console.error('Missing APPWRITE_PROJECT_ID / APPWRITE_API_KEY.');
  console.error('Create an API key in Appwrite Console → Project Settings → API Keys');
  console.error('with sites.*, storage.* and databases.* scopes, then run again.');
  process.exit(2);
}

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
  if (got.ok) return got.json;
  console.log('[appwrite] creating site', SITE_ID);
  const made = await req('/sites', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: JSON.stringify({
      siteId: SITE_ID,
      name: SITE_NAME,
      framework: 'other',
      buildRuntime: 'node-22',
      adapter: 'static',
      installCommand: '',
      buildCommand: '',
      outputDirectory: './',
      enabled: true
    })
  });
  if (!made.ok) throw new Error('create site failed: ' + made.status + ' ' + (made.json && made.json.message || made.text));
  return made.json;
}

function packagePublic() {
  const out = path.join(os.tmpdir(), 'whalechat-site-' + Date.now() + '.tar.gz');
  execFileSync('tar', [
    '--exclude=node_modules', '--exclude=.git', '--exclude=*.apk',
    '--exclude=*.b64', '--exclude=*.part[0-9]*', '--exclude=*.map',
    '-czf', out, '-C', PUB, '.'
  ], { stdio: 'inherit' });
  const size = fs.statSync(out).size;
  console.log('[appwrite] packaged', (size / 1024 / 1024).toFixed(1) + ' MB →', out);
  return out;
}

(async () => {
  console.log('[appwrite] endpoint', ENDPOINT, '· project', PROJECT);
  try {
    execFileSync('node', [path.join(ROOT, 'scripts', 'prepare-assets.js')], { stdio: 'inherit' });
  } catch (e) {
    console.error('[appwrite] build failed — aborting');
    process.exit(1);
  }
  await ensureSite();
  const tarPath = packagePublic();
  const form = new FormData();
  form.append('installCommand', '');
  form.append('buildCommand', '');
  form.append('outputDirectory', './');
  form.append('activate', 'true');
  form.append('code', new Blob([fs.readFileSync(tarPath)], { type: 'application/gzip' }), path.basename(tarPath));
  const dep = await req('/sites/' + encodeURIComponent(SITE_ID) + '/deployments', { method: 'POST', body: form });
  if (!dep.ok) {
    console.error('[appwrite] deployment failed:', dep.status, dep.json && dep.json.message || dep.text);
    process.exit(1);
  }
  const id = dep.json && dep.json.$id;
  console.log('[appwrite] deployment', id, 'status', dep.json && dep.json.status);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await req('/sites/' + encodeURIComponent(SITE_ID) + '/deployments/' + encodeURIComponent(id));
    const status = st.json && st.json.status;
    console.log('[appwrite] status:', status || st.status);
    if (status === 'ready' || status === 'active') {
      console.log('[appwrite] deployed →', 'https://' + SITE_ID + '.' + ENDPOINT.replace(/^https?:\/\//, '').replace(/\/v1$/, ''));
      process.exit(0);
    }
    if (status === 'failed' || status === 'canceled') {
      console.error('[appwrite] build logs:', (st.json && st.json.buildLogs) || '');
      process.exit(1);
    }
  }
  console.log('[appwrite] deployment still building — check the Appwrite console → Deployments.');
})().catch((e) => { console.error('[appwrite] error:', e.message); process.exit(1); });
