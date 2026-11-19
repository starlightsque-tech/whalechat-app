#!/usr/bin/env node
/** Structural smoke test for the single-file offline build. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const file = path.resolve('apps/web/dist-offline/index.html');
const html = await readFile(file, 'utf8');
const checks = [
  ['singlefile marker', html.includes('name="singlefile-offline"')],
  ['module registry', html.includes('__modules') && html.includes('__require')],
  ['file:// hash router polyfill', html.includes('file-offline') || html.includes('pushState')],
  ['no external scripts', !/<script[^>]*\bsrc\s*=/.test(html)],
  ['no modulepreload tags', !/<link[^>]*rel=["']modulepreload/i.test(html)],
  ['inline styles present', /<style>/.test(html)],
  ['reasonable size (>150 KB)', Buffer.byteLength(html) > 150_000],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failed += 1;
}
console.log(`\n${(Buffer.byteLength(html) / 1024).toFixed(0)} KB — ${file}`);
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('Offline bundle is self-contained.');
