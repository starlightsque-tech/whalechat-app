#!/usr/bin/env node
/* =========================================================================
   Export whalechat_state from Supabase to a dated JSON file, prune old ones.

     DATABASE_URL=postgres://... npm run backup:state
     DATABASE_URL=... node scripts/backup-state.mjs --out=./backups --retention=14

   Or with a Supabase Management token instead of a database URL:

     SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=abcdefgh \
       node scripts/backup-state.mjs --via=management

   The file is the whole app database (rev + db JSONB), so a restore is a
   single upsert — see docs/BACKUP.md.
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};

const OUT_DIR = path.resolve(arg('out', process.env.BACKUP_OUT_DIR || 'backups'));
const RETENTION = Math.max(1, Number(arg('retention', process.env.BACKUP_RETENTION_DAYS || 14)));
const VIA = arg('via', 'auto');
const QUIET = args.includes('--quiet');

const log = (...a) => { if (!QUIET) console.log(...a); };

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

async function readViaDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const pg = (await import('pg')).default;
  const needsSsl = /sslmode=require|sslmode=no-verify/i.test(url) || /supabase\.(co|com)/i.test(url) || /\.render\.com/i.test(url);
  const conn = needsSsl ? url.replace(/([?&])sslmode=[^&]*/i, '$1').replace(/[?&]$/, '') : url;
  const pool = new pg.Pool({
    connectionString: conn,
    max: 1,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 20000
  });
  try {
    const r = await pool.query('select rev, updated_at, db from whalechat_state where id = 1');
    const row = r.rows[0];
    if (!row) return { rev: 0, updatedAt: null, db: null, source: 'database (no row yet)' };
    return { rev: row.rev, updatedAt: row.updated_at, db: row.db, source: 'database' };
  } finally {
    await pool.end().catch(() => {});
  }
}

async function readViaManagement() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = process.env.SUPABASE_PROJECT_REF || 'eiikmbuzxfnsmtcrfgut';
  if (!token) return null;
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'select rev, updated_at, db from whalechat_state where id = 1' })
  });
  if (!res.ok) throw new Error('management query failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { rev: 0, updatedAt: null, db: null, source: 'management (no row yet)' };
  return { rev: row.rev, updatedAt: row.updated_at, db: row.db, source: 'management' };
}

function prune(dir, retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  let removed = [];
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^whalechat-state-(\d{4})-(\d{2})-(\d{2})\.json$/);
    if (!m) continue;
    const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (at < cutoff) {
      try { fs.unlinkSync(path.join(dir, name)); removed.push(name); } catch (e) {}
    }
  }
  return removed;
}

(async () => {
  let data = null;
  if (VIA === 'management') data = await readViaManagement();
  else {
    data = await readViaDatabase();
    if (!data && VIA === 'auto') data = await readViaManagement();
  }
  if (!data) {
    console.error('No source: set DATABASE_URL (recommended) or SUPABASE_ACCESS_TOKEN.');
    process.exit(2);
  }
  if (!data.db) {
    console.error('whalechat_state has no data yet — nothing to back up (rev ' + (data.rev || 0) + ').');
    process.exit(3);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const day = stamp(new Date());
  const file = path.join(OUT_DIR, `whalechat-state-${day}.json`);
  const payload = {
    exportedAt: new Date().toISOString(),
    source: data.source,
    rev: data.rev,
    updatedAt: data.updatedAt,
    users: Array.isArray(data.db.users) ? data.db.users.length : 0,
    db: data.db
  };
  const text = JSON.stringify(payload);
  fs.writeFileSync(file, text);

  const sha = crypto.createHash('sha256').update(text).digest('hex');
  fs.writeFileSync(file.replace(/\.json$/, '.sha256'), sha + '  ' + path.basename(file) + '\n');

  const removed = prune(OUT_DIR, RETENTION);
  const kept = fs.readdirSync(OUT_DIR).filter((f) => /^whalechat-state-.*\.json$/.test(f)).sort();

  log('backup written  ' + file);
  log('  rev           ' + payload.rev + ' (updated ' + (payload.updatedAt || 'unknown') + ')');
  log('  users         ' + payload.users);
  log('  size          ' + (text.length / 1024).toFixed(1) + ' KB');
  log('  sha256        ' + sha.slice(0, 16) + '…');
  log('  source        ' + data.source);
  if (removed.length) log('  pruned        ' + removed.length + ' file(s) older than ' + RETENTION + ' days');
  log('  retention     ' + kept.length + '/' + RETENTION + ' day(s) on disk');

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `file=${file}\nday=${day}\nrev=${payload.rev}\nusers=${payload.users}\nsha256=${sha}\n`);
  }
})().catch((e) => {
  console.error('backup failed:', e.message);
  process.exit(1);
});
