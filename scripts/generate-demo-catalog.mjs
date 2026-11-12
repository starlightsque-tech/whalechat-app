#!/usr/bin/env node
/* =============================================================================
   Demo catalogue generator
   -----------------------------------------------------------------------------
   Reads catalog/demo-catalog.source.json (sellers + product models), assigns each
   demo seller a distinct 10–50 product range, derives per-seller pricing and
   stock, encodes the generated product/portrait renders, and writes
   public/demo-catalog.json — the file the app fetches to seed its storefronts.

   Usage:
     node scripts/generate-demo-catalog.mjs                    # build + encode
     node scripts/generate-demo-catalog.mjs --skip-images      # JSON only
     node scripts/generate-demo-catalog.mjs --assets <dir>     # custom renders

   The renders live in assets-src/demo/{products,sellers}/<slug>.png and are
   produced with the image generator (see README "Demo media"). Committed
   output is public/demo/{products,sellers}/<slug>.jpg.b64 plus
   public/demo-catalog.json.
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'catalog', 'demo-catalog.source.json');
const OUT_JSON = path.join(ROOT, 'public', 'demo-catalog.json');
const MIN_PER_SELLER = 10;
const MAX_PER_SELLER = 50;

const argv = process.argv.slice(2);
const getFlag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const SKIP_IMAGES = argv.includes('--skip-images');
const ASSETS = path.resolve(ROOT, getFlag('--assets') || path.join('assets-src', 'demo'));

/* deterministic PRNG so re-running the generator never reshuffles storefronts */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seedText) {
  let a = hash(seedText);
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(list, rand) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const sellers = source.sellers || [];
const models = source.models || [];
const errors = [];

if (!sellers.length) errors.push('no sellers in source');
if (!models.length) errors.push('no product models in source');

const seenSlugs = new Set();
for (const s of sellers) {
  if (!s.slug || seenSlugs.has(s.slug)) errors.push(`duplicate/empty seller slug: ${s.slug}`);
  seenSlugs.add(s.slug);
  const n = Number(s.productCount);
  if (!Number.isInteger(n) || n < MIN_PER_SELLER || n > MAX_PER_SELLER) {
    errors.push(`${s.slug}: productCount must be an integer ${MIN_PER_SELLER}–${MAX_PER_SELLER} (got ${s.productCount})`);
  }
  if (n > models.length) errors.push(`${s.slug}: wants ${n} products but only ${models.length} models exist`);
}
const seenModels = new Set();
for (const m of models) {
  if (!m.slug || seenModels.has(m.slug)) errors.push(`duplicate/empty model slug: ${m.slug}`);
  seenModels.add(m.slug);
  if (!m.name || !m.category) errors.push(`${m.slug}: name and category are required`);
  if (!(Number(m.basePriceUsd) > 0)) errors.push(`${m.slug}: basePriceUsd must be > 0`);
}
if (errors.length) {
  console.error('\nDemo catalogue is invalid:');
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}

/* ---- assign each seller a distinct slice, weighted to their specialities ---- */
const CATEGORIES = [...new Set(models.map((m) => m.category))];
const byCategory = new Map(CATEGORIES.map((c) => [c, models.filter((m) => m.category === c)]));

function assignModels(seller) {
  const primary = (seller.primaryCategories || []).filter((c) => byCategory.has(c));
  const rest = CATEGORIES.filter((c) => !primary.includes(c));
  const ordered = [];
  const rand = rng('assign:' + seller.slug);
  for (const cat of [...primary, ...rest]) {
    const pool = shuffled(byCategory.get(cat) || [], rand);
    for (const m of pool) if (!ordered.includes(m)) ordered.push(m);
  }
  return ordered.slice(0, Number(seller.productCount));
}

const round2 = (n) => Math.round(n * 100) / 100;
const catalogSellers = sellers.map((seller, index) => {
  const rand = rng('store:' + seller.slug);
  const markupBase = 1 + (index % 5) * 0.035;          // 1.00 → 1.14
  const listings = assignModels(seller).map((model, i) => {
    const markup = markupBase + (rand() * 0.14 - 0.04); // slight per-product spread
    const priceUsd = Math.max(5, Math.round(model.basePriceUsd * markup));
    return {
      id: `dsp_${seller.slug}_${model.slug}`,
      modelSlug: model.slug,
      name: model.name,
      category: model.category,
      priceUsd,
      costUsd: Math.round(model.basePriceUsd * 0.72),
      stock: 6 + Math.floor(rand() * 114),
      image: `./demo/products/${model.slug}.jpg`,
      description: model.description,
      color: model.color || '',
      rating: round2(4.3 + rand() * 0.6),
      reviews: 18 + Math.floor(rand() * 460),
      active: true,
      demo: true,
      sort: i
    };
  });
  return {
    slug: seller.slug,
    userId: `bot_seller_${seller.slug}`,
    vendorId: `vnd_demo_${seller.slug}`,
    name: seller.name,
    storeName: seller.storeName,
    storeUsername: seller.storeUsername || seller.slug,
    email: seller.email,
    phone: seller.phone,
    country: seller.country,
    city: seller.city,
    address: seller.address,
    postal: seller.postal,
    tagline: seller.tagline || '',
    bio: seller.bio || '',
    avatar: `./demo/sellers/${seller.slug}.jpg`,
    primaryCategories: seller.primaryCategories || [],
    listings
  };
});

/* ---- sanity: every seller 10–50 distinct products, no shared listing id ---- */
const listingIds = new Set();
for (const s of catalogSellers) {
  if (s.listings.length < MIN_PER_SELLER || s.listings.length > MAX_PER_SELLER) {
    errors.push(`${s.slug}: ${s.listings.length} listings (must be ${MIN_PER_SELLER}–${MAX_PER_SELLER})`);
  }
  if (new Set(s.listings.map((l) => l.id)).size !== s.listings.length) errors.push(`${s.slug}: duplicate listing ids`);
  for (const l of s.listings) {
    if (listingIds.has(l.id)) errors.push(`listing id reused: ${l.id}`);
    listingIds.add(l.id);
  }
}
if (errors.length) {
  console.error('\nAssignment failed:');
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}

/* ---- encode the generated renders (if the source renders are available) ---- */
if (!SKIP_IMAGES) {
  const productsDir = path.join(ASSETS, 'products');
  const sellersDir = path.join(ASSETS, 'sellers');
  if (!fs.existsSync(productsDir) && !fs.existsSync(sellersDir)) {
    console.log(`[media] no renders at ${path.relative(ROOT, ASSETS)} — keeping committed .b64 images`);
  } else {
    console.log(`[media] encoding renders from ${path.relative(ROOT, ASSETS)}`);
    const py = spawnSync('python3', [
      path.join(ROOT, 'scripts', 'encode-demo-images.py'),
      '--src', ASSETS,
      '--out', path.join(ROOT, 'public', 'demo')
    ], { stdio: 'inherit' });
    if (py.status !== 0) {
      console.error('[media] image encoding failed (pip install pillow) — aborting so images never drift from the catalogue');
      process.exit(py.status || 1);
    }
  }
}

/* ---- write the runtime catalogue ------------------------------------------ */
const missingImages = [];
for (const s of catalogSellers) {
  if (!fs.existsSync(path.join(ROOT, 'public', 'demo', 'sellers', `${s.slug}.jpg.b64`))) missingImages.push(`seller ${s.slug}`);
  for (const l of s.listings) {
    if (!fs.existsSync(path.join(ROOT, 'public', 'demo', 'products', `${l.modelSlug}.jpg.b64`))) missingImages.push(`product ${l.modelSlug}`);
  }
}
if (missingImages.length) {
  console.warn(`[media] ${missingImages.length} image(s) not committed yet: ${missingImages.slice(0, 6).join(', ')}${missingImages.length > 6 ? '…' : ''}`);
}

const catalog = {
  version: Number(source.version) || 1,
  generatedAt: new Date().toISOString(),
  note: 'Generated by scripts/generate-demo-catalog.mjs — do not edit by hand.',
  categories: CATEGORIES,
  sellers: catalogSellers,
  totals: {
    sellers: catalogSellers.length,
    listings: catalogSellers.reduce((n, s) => n + s.listings.length, 0),
    models: models.length,
    categories: CATEGORIES.length
  }
};
fs.writeFileSync(OUT_JSON, JSON.stringify(catalog, null, 2) + '\n');

/* ---- report --------------------------------------------------------------- */
console.log('\nDemo storefronts');
for (const s of catalogSellers) {
  const cats = [...new Set(s.listings.map((l) => l.category))].join(', ');
  console.log(`  ${s.storeName.padEnd(22)} ${String(s.listings.length).padStart(2)} products  · ${s.city.padEnd(12)} · ${cats}`);
}
console.log(`\n[ok] ${catalog.totals.sellers} sellers · ${catalog.totals.listings} listings · ${catalog.totals.models} models · v${catalog.version}`);
console.log(`[ok] wrote ${path.relative(ROOT, OUT_JSON)} (${(fs.statSync(OUT_JSON).size / 1024).toFixed(1)} KB)`);
