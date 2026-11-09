#!/usr/bin/env node
/* Decode the base64-committed image assets into real files at build time.
   Run automatically by Render / Docker before the server starts. */
'use strict';
const fs = require('fs');
const path = require('path');
const dir = path.resolve(__dirname, '..', 'public', 'assets');
let made = 0;
for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith('.b64')) continue;
  const target = path.join(dir, name.slice(0, -4));
  try {
    if (fs.existsSync(target) && fs.statSync(target).size > 0) continue;
    fs.writeFileSync(target, Buffer.from(fs.readFileSync(path.join(dir, name), 'utf8').trim(), 'base64'));
    made++;
  } catch (e) { console.error('[assets] failed', name, e.message); }
}
console.log('[assets] decoded', made, 'file(s)');

/* The app bundle is committed in <120KB text parts (API/arg limits); join them. */
const pub = path.resolve(__dirname, '..', 'public');
const appFile = path.join(pub, 'whalechat.html');
const parts = fs.readdirSync(pub).filter((f) => /^whalechat\.html\.part\d+$/.test(f)).sort();
if (parts.length && (!fs.existsSync(appFile) || fs.statSync(appFile).size === 0)) {
  fs.writeFileSync(appFile, parts.map((f) => fs.readFileSync(path.join(pub, f), 'utf8')).join(''));
  console.log('[assets] assembled whalechat.html from', parts.length, 'parts');
}
