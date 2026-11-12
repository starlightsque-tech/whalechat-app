/* ======================= demo sellers (merchant fleet) =======================
   A shelf of demo storefronts so the marketplace has depth on day one. Each
   seller is a bot account (pass:null, isBot + isDemoSeller) owning a vendor
   profile and 10–50 distinct listings from public/demo-catalog.json. Every
   listing carries demo:true. Real buyers can order from them; the seller
   accounts simply cannot be signed into.

   Admins can re-range a storefront (10–50 products, chosen categories) from
   Admin → Demo sellers, and every store has a public profile at #/store/<id>. */
LT.sellersCfg = function () {
  if (!DB.settings) DB.settings = {};
  const base = { enabled: true, seededAt: null, catalogVersion: 0, publishedAt: null, listings: 0, sellers: 0, ranges: {}, activity: null };
  if (!DB.settings.demoSellers || typeof DB.settings.demoSellers !== 'object') DB.settings.demoSellers = Object.assign({}, base);
  const c = DB.settings.demoSellers;
  Object.keys(base).forEach(k => { if (c[k] === undefined) c[k] = base[k]; });
  if (!c.ranges || typeof c.ranges !== 'object') c.ranges = {};
  return c;
};

LT.demoCatalog = null;
LT.loadDemoCatalog = async function (force) {
  if (LT.demoCatalog && !force) return LT.demoCatalog;
  const res = await fetch('./demo-catalog.json?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('demo catalogue not available');
  const catalog = await res.json();
  if (!catalog || !Array.isArray(catalog.sellers) || !catalog.sellers.length) throw new Error('demo catalogue is empty');
  LT.demoCatalog = catalog;
  return catalog;
};

LT.demoSellerBySlug = function (slug) {
  const c = LT.demoCatalog;
  return c ? (c.sellers || []).find(s => s.slug === slug) || null : null;
};

/* a listing object for a catalogue model, keeping any existing price/stock */
LT.demoListingFromModel = function (seller, model, existing) {
  const id = 'dsp_' + seller.slug + '_' + model.slug;
  const was = existing || (DB.products || []).find(p => p.id === id);
  return {
    id, modelSlug: model.slug, name: model.name, category: model.category,
    priceUsd: was && was.priceUsd ? was.priceUsd : Math.max(5, Math.round(model.basePriceUsd * (seller.markup || 1.06))),
    costUsd: Math.round(model.basePriceUsd * 0.72),
    stock: was && Number.isFinite(Number(was.stock)) ? was.stock : 36,
    image: model.image || './demo/products/' + model.slug + '.jpg',
    description: model.description, color: model.color || '',
    rating: was && was.rating ? was.rating : 4.6, reviews: was && was.stars ? was.stars : 120,
    active: true, demo: true, model: true
  };
};

/* which catalogue models a seller publishes, honouring an admin override */
LT.demoSellerRangeModels = function (catalog, seller) {
  const ov = LT.sellersCfg().ranges[seller.slug];
  const all = catalog.models || [];
  if (!ov) {
    const slugs = new Set((seller.listings || []).map(l => l.modelSlug));
    return all.filter(m => slugs.has(m.slug));
  }
  const cats = (ov.categories && ov.categories.length) ? ov.categories : catalog.categories || [];
  const ordered = [];
  for (const cat of cats) {
    for (const m of all) if (m.category === cat && !ordered.includes(m)) ordered.push(m);
  }
  return ordered.slice(0, Math.max(10, Math.min(50, Number(ov.productCount) || 10)));
};

LT.demoRangeAvailability = function (categories) {
  const all = (LT.demoCatalog && LT.demoCatalog.models) || [];
  if (!categories || !categories.length) return all.length;
  return all.filter(m => categories.includes(m.category)).length;
};

LT.upsertDemoListing = function (seller, def, resetStock) {
  const p = (DB.products || []).find(x => x.id === def.id);
  if (!p) {
    DB.products.push({
      id: def.id, vendorId: seller.vendorId, companyProductId: null,
      name: def.name, category: def.category, priceUsd: def.priceUsd, costUsd: def.costUsd,
      stock: def.stock, image: def.image, emoji: null, description: def.description,
      color: def.color || '', active: true, starUsers: [], stars: def.reviews || 0,
      rating: def.rating || 4.6, demo: true, modelSlug: def.modelSlug,
      generated: !!def.generated, createdAt: Date.now() - Math.floor(Math.random() * 120) * 864e5
    });
    return 'added';
  }
  const stock = resetStock ? def.stock : (Number.isFinite(Number(p.stock)) ? p.stock : def.stock);
  Object.assign(p, {
    vendorId: seller.vendorId, name: def.name, category: def.category, priceUsd: def.priceUsd,
    costUsd: def.costUsd || p.costUsd, image: def.image, description: def.description,
    color: def.color || '', modelSlug: def.modelSlug, stock, active: stock > 0, demo: true
  });
  if (def.generated) p.generated = true;
  return 'updated';
};

LT.seedDemoSellers = function (catalog, resetStock) {
  const cfg = LT.sellersCfg();
  if (!Array.isArray(DB.vendors)) DB.vendors = [];
  if (!Array.isArray(DB.products)) DB.products = [];
  const now = Date.now();
  let addedSellers = 0, addedProducts = 0, updatedProducts = 0, removed = 0;

  const keepIds = new Set();
  (catalog.sellers || []).forEach(s => {
    const models = LT.demoSellerRangeModels(catalog, s);
    const defs = (cfg.ranges[s.slug] && models.length)
      ? models.map(m => LT.demoListingFromModel(s, m))
      : (s.listings || []);
    defs.forEach(l => keepIds.add(l.id));
    s.publishedCount = defs.length;

    let u = findUser(s.userId);
    if (!u) {
      u = {
        id: s.userId, username: s.storeUsername, fullName: s.name, email: s.email, phone: s.phone,
        pass: null, pin: null, avatar: s.avatar, role: 'user', balance: 0, totalDeposits: 0,
        totalWithdrawals: 0, totalEarnings: 0, vendorId: s.vendorId, cart: [], stars: [],
        country: s.country, city: s.city, address: s.address, postal: s.postal,
        settings: { notifications: false, theme: 'dark' }, verified: true, banned: false,
        completedSales: 0, rating: 4.8, isBot: true, isDemoSeller: true, bio: s.bio,
        referralCode: '', referredBy: null, referralPaid: true, trustScore: 95,
        createdAt: now - 420 * 864e5
      };
      DB.users.push(u);
      addedSellers++;
    } else {
      u.isBot = true; u.isDemoSeller = true; u.vendorId = s.vendorId;
      if (!u.avatar) u.avatar = s.avatar;
    }
    let v = DB.vendors.find(x => x.id === s.vendorId);
    if (!v) {
      v = {
        id: s.vendorId, userId: s.userId, username: s.storeUsername, name: s.storeName,
        avatar: s.avatar, banner: s.banner, rating: 4.7, trustScore: 92, sales: 0, revenue: 0,
        createdAt: now - 420 * 864e5, status: 'active', completedSales: 0,
        planMonths: 120, planId: null, expiresAt: now + 3650 * 864e5,
        tagline: s.tagline, bio: s.bio, city: s.city, country: s.country,
        demo: true, demoSlug: s.slug, markup: s.markup || 1.06, productCount: defs.length
      };
      DB.vendors.push(v);
    } else {
      v.name = s.storeName; v.username = s.storeUsername; v.avatar = s.avatar;
      v.tagline = s.tagline; v.city = s.city; v.country = s.country; v.bio = s.bio;
      v.demo = true; v.status = 'active'; v.demoSlug = s.slug;
      v.banner = s.banner; v.markup = s.markup || v.markup || 1.06;
      v.productCount = defs.length;
      if (!vendorIsActive(v)) v.expiresAt = now + 3650 * 864e5;
    }
    defs.forEach(l => {
      const res = LT.upsertDemoListing(s, l, resetStock);
      if (res === 'added') addedProducts++; else updatedProducts++;
    });
  });

  /* catalogue version bumps can retire listings — drop only demo ones that
     were never ordered, so real order history is never orphaned */
  const ordered = new Set((DB.orders || []).flatMap(o => (o.items || []).map(i => i.productId)));
  const before = DB.products.length;
  DB.products = DB.products.filter(p => {
    if (!(p.demo && String(p.id).indexOf('dsp_') === 0 && !keepIds.has(p.id))) return true;
    if (p.generated) return true;
    if (ordered.has(p.id)) { p.active = false; p.retired = true; return true; }
    return false;
  });
  removed = before - DB.products.length;
  if (removed) {
    const dead = new Set(DB.products.filter(p => p.demo).map(p => p.id));
    (DB.users || []).forEach(x => { if (Array.isArray(x.cart)) x.cart = x.cart.filter(c => dead.has(c.productId)); });
  }

  cfg.seededAt = now;
  cfg.catalogVersion = catalog.version;
  cfg.sellers = (catalog.sellers || []).length;
  cfg.listings = (catalog.sellers || []).reduce((n, s) => n + (s.publishedCount || (s.listings || []).length), 0);
  cfg.publishedAt = now;
  return { addedSellers, addedProducts, updatedProducts, removed, listings: cfg.listings, sellers: cfg.sellers };
};

LT.ensureDemoSellers = function (force) {
  const cfg = LT.sellersCfg();
  if (!cfg.enabled && !force) return Promise.resolve(null);
  if (!DB || !DB_READY) return Promise.resolve(null);
  if (LT._sellerBusy) return LT._sellerBusy;
  LT._sellerBusy = (async () => {
    const catalog = await LT.loadDemoCatalog(force);
    if (!force && cfg.catalogVersion === catalog.version && cfg.seededAt) return null;
    const res = LT.seedDemoSellers(catalog, !!force);
    try { LT.seedDemoActivity(); } catch (e) {}
    try { sync(); } catch (e) {}
    persist();
    if (location.hash.indexOf('#/admin/demo-sellers') === 0 && !force) render();
    return res;
  })().catch(e => { console.warn('[demo sellers]', e.message); return null; })
     .finally(() => { LT._sellerBusy = null; });
  return LT._sellerBusy;
};

LT.demoSellerStats = function () {
  const cfg = LT.sellersCfg();
  const sellers = (DB.vendors || []).filter(v => v.demo);
  const ids = new Set(sellers.map(v => v.id));
  const listings = (DB.products || []).filter(p => p.demo && ids.has(p.vendorId));
  const live = listings.filter(p => p.active && p.stock > 0);
  const cats = [...new Set(listings.map(p => p.category))];
  const value = live.reduce((n, p) => n + p.priceUsd * p.stock, 0);
  return { cfg, sellers, listings, live, cats, value };
};

App.demoSellersToggle = async function () {
  const cfg = LT.sellersCfg();
  cfg.enabled = !cfg.enabled;
  if (cfg.enabled) {
    const res = await LT.ensureDemoSellers(false);
    try { AUDIT.log('Demo sellers enabled', res ? res.listings + ' listings published' : 'storefronts visible'); } catch (e) {}
    toast('Demo sellers enabled — ' + (cfg.listings || 0) + ' products on the marketplace', 'ok');
  } else {
    try { AUDIT.log('Demo sellers disabled', 'storefronts hidden'); } catch (e) {}
    toast('Demo sellers turned off — their storefronts are hidden', 'ok');
  }
  const demoVendors = new Set((DB.vendors || []).filter(v => v.demo).map(v => v.id));
  (DB.products || []).forEach(p => {
    if (p.demo && demoVendors.has(p.vendorId)) p.active = cfg.enabled && p.stock > 0;
  });
  try { sync(); } catch (e) {}
  persist();
  render();
};

App.demoSellersPublish = async function () {
  if (!await confirmDialog({
    title: 'Republish demo storefronts?',
    body: 'Reloads public/demo-catalog.json, refreshes every demo seller, their photos and prices, and restores listing stock. Existing demo listings are updated in place — nothing is duplicated. Product-range overrides are kept.',
    ok: 'Republish catalogues'
  })) return;
  const cfg = LT.sellersCfg();
  cfg.enabled = true;
  const res = await LT.ensureDemoSellers(true);
  if (!res) return toast('Could not load the demo catalogue', 'err');
  try { LT.seedDemoActivity(); } catch (e) {}
  try { AUDIT.log('Demo storefronts republished', res.sellers + ' sellers · ' + res.listings + ' listings'); } catch (e) {}
  render();
  toast(res.addedProducts + ' new · ' + res.updatedProducts + ' refreshed listings', 'ok');
};

/* ---------------- demo user fleet: up to 10,000 generated shoppers ----------------
   Bulk personas for load/volume testing. Records are deliberately compact so a
   large fleet still fits in browser storage; avatars cycle through the real
   portrait set. Orders are one per selected user, marked simulated. */
const DEMO_FIRST = ['Amelia','Noah','Sofia','Liam','Mia','Ethan','Isabella','Lucas','Ava','Mateo','Chloe','Arjun',
  'Priya','Kenji','Yuki','Aisha','Omar','Zara','Tunde','Nia','Elena','Marco','Hannah','Jonas','Clara','Felix',
  'Leila','Ravi','Mei','Diego','Fatima','Samuel','Grace','Hugo','Ines','Kofi'];
const DEMO_LAST = ['Johnson','Müller','Silva','Okafor','Tanaka','Patel','Kim','Garcia','Nowak','Dubois','Rossi',
  'Hughes','Weber','Sato','Nair','Mensah','Alvarez','Kowalski','Andersen','Costa','Yilmaz','Novak','Fischer',
  'Moreno','Santos','Park','Bianchi','Jensen','Haddad','Mwangi','Reyes','Kaur','Schmidt','Lopez','Adeyemi','Osei'];
const DEMO_PLACES = [
  { country:'United States', city:'Austin', postal:'78704', prefix:'+1 512', street:'South Congress Avenue' },
  { country:'United States', city:'Chicago', postal:'60605', prefix:'+1 312', street:'North State Street' },
  { country:'United Kingdom', city:'Manchester', postal:'M1 2EF', prefix:'+44 161', street:'Hilton Street' },
  { country:'Germany', city:'Berlin', postal:'10243', prefix:'+49 30', street:'Warschauer Straße' },
  { country:'France', city:'Lyon', postal:'69002', prefix:'+33 4', street:'Rue de la République' },
  { country:'Spain', city:'Valencia', postal:'46004', prefix:'+34 963', street:'Calle de Colón' },
  { country:'Nigeria', city:'Lagos', postal:'101241', prefix:'+234 802', street:'Adeola Odeku Street' },
  { country:'Kenya', city:'Nairobi', postal:'00100', prefix:'+254 20', street:'Kimathi Street' },
  { country:'India', city:'Pune', postal:'411001', prefix:'+91 20', street:'Koregaon Park Lane' },
  { country:'Japan', city:'Osaka', postal:'530-0001', prefix:'+81 6', street:'Umeda, Kita-ku' },
  { country:'Philippines', city:'Cebu City', postal:'6000', prefix:'+63 32', street:'Osmeña Boulevard' },
  { country:'United Arab Emirates', city:'Dubai', postal:'00000', prefix:'+971 4', street:'Al Fahidi Street' },
  { country:'Brazil', city:'São Paulo', postal:'01310-100', prefix:'+55 11', street:'Avenida Paulista' },
  { country:'South Africa', city:'Cape Town', postal:'8001', prefix:'+27 21', street:'Long Street' }
];
const DEMO_AVATARS = ['./bots/lena-hoffmann.jpg','./bots/mathieu-leroy.jpg','./bots/carla-moreno.jpg',
  './bots/oliver-hughes.jpg','./bots/aiko-tanaka.jpg','./bots/miguel-santos.jpg','./bots/arjun-mehta.jpg','./bots/zofia-nowak.jpg'];
const DB_STORAGE_BUDGET = 4400000;   /* chars — leave headroom under a 5 MB localStorage */

LT.demoUsersCfg = function () {
  const cfg = LT.sellersCfg();
  if (!cfg.demoUsers || typeof cfg.demoUsers !== 'object') cfg.demoUsers = { generated: 0, lastAt: null, ordering: 0, orderAt: null };
  return cfg.demoUsers;
};
LT.demoShoppers = function () {
  return (DB.users || []).filter(u => u.isBot && !u.isDemoSeller);
};

LT.generateDemoUsers = function (count) {
  const n = Math.round(Number(count) || 0);
  if (n < 1 || n > 10000) return { ok: false, error: 'Choose between 1 and 10,000 demo users' };
  if (!DB || !DB_READY) return { ok: false, error: 'App is still loading — try again' };
  const cfg = LT.demoUsersCfg();
  const shoppers = LT.demoShoppers();
  const existingGenerated = shoppers.filter(u => u.isDemoUser).length;
  const usernames = new Set((DB.users || []).map(u => String(u.username || '').toLowerCase()));
  const maxId = shoppers.filter(u => u.isDemoUser)
    .reduce((m, u) => Math.max(m, Number(String(u.id).replace('dbu_', '')) || 0), 0);
  const start = Math.max(existingGenerated, maxId) + 1;
  const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const before = DB.users.length;
  const created = [];

  for (let i = 0; i < n; i++) {
    const idx = start + i;
    const first = DEMO_FIRST[idx % DEMO_FIRST.length];
    const last = DEMO_LAST[Math.floor(idx / DEMO_FIRST.length) % DEMO_LAST.length];
    const middle = String.fromCharCode(65 + (idx % 26));
    const place = DEMO_PLACES[idx % DEMO_PLACES.length];
    let username = 'demo.' + slug(first) + '.' + slug(last) + '.' + idx;
    let bump = 1;
    while (usernames.has(username)) username = 'demo.' + slug(first) + '.' + slug(last) + '.' + idx + '_' + (bump++);
    usernames.add(username);
    created.push({
      id: 'dbu_' + idx,
      username,
      fullName: first + ' ' + middle + '. ' + last,
      avatar: DEMO_AVATARS[idx % DEMO_AVATARS.length],
      isBot: true, isDemoUser: true,
      country: place.country, city: place.city,
      createdAt: Date.now() - (idx % 365) * 864e5
    });
  }

  DB.users.push(...created);
  const size = JSON.stringify(DB).length;
  if (size > DB_STORAGE_BUDGET) {
    DB.users.length = before;
    return { ok: false, error: 'That many users would exceed this device\'s storage. Try a smaller number (about ' + Math.max(100, Math.floor(n * DB_STORAGE_BUDGET / size)) + ').' };
  }
  cfg.generated = (cfg.generated || 0) + created.length;
  cfg.lastAt = Date.now();
  try { AUDIT.log('Demo users generated', created.length + ' accounts · ' + (existingGenerated + created.length) + ' generated total'); } catch (e) {}
  try { sync(); } catch (e) {}
  persist();
  return { ok: true, added: created.length, total: LT.demoShoppers().length, generated: cfg.generated, bytes: size };
};

LT.generateDemoUserOrders = function (count) {
  const n = Math.round(Number(count) || 0);
  if (n < 1) return { ok: false, error: 'Choose at least 1 demo user' };
  const shoppers = LT.demoShoppers();
  if (!shoppers.length) return { ok: false, error: 'Generate demo users first' };
  if (n > shoppers.length) return { ok: false, error: 'Only ' + shoppers.length + ' demo users exist' };
  const products = (DB.products || []).filter(p => p.demo && p.active && p.stock > 0);
  if (!products.length) return { ok: false, error: 'Publish the demo storefronts first' };
  const vendors = (DB.vendors || []).filter(v => v.demo);
  if (!vendors.length) return { ok: false, error: 'Publish the demo storefronts first' };

  const batch = Date.now().toString(36);
  const beforeOrders = DB.orders.length;
  const beforeSize = JSON.stringify(DB).length;
  const step = Math.max(1, Math.floor(shoppers.length / n));
  let made = 0, gmv = 0;

  for (let i = 0; i < n; i++) {
    const buyer = shoppers[Math.min(shoppers.length - 1, Math.floor(i * step))];
    const seller = vendors[i % vendors.length];
    const pool = products.filter(p => p.vendorId === seller.id);
    if (!pool.length) continue;
    const p = pool[i % pool.length];
    const daysAgo = Math.floor(Math.pow(Math.random(), 1.4) * 21);
    const at = Date.now() - daysAgo * 864e5 - Math.floor(Math.random() * 18) * 36e5;
    const qty = Math.random() < 0.8 ? 1 : 2;
    const totalUsd = Math.round(p.priceUsd * qty * 100) / 100;
    const status = daysAgo <= 1 ? (Math.random() < 0.5 ? 'pending' : 'processing')
      : daysAgo <= 4 ? (Math.random() < 0.6 ? 'processing' : 'shipped')
      : (Math.random() < 0.93 ? 'delivered' : 'cancelled');
    DB.orders.push({
      id: 'ord_du_' + batch + '_' + (i + 1),
      ref: 'WC-' + Math.random().toString(36).slice(2, 7).toUpperCase(),
      buyerId: buyer.id, vendorId: seller.id,
      items: [{ productId: p.id, name: p.name, qty, priceUsd: p.priceUsd, image: p.image, category: p.category }],
      totalUsd, totalCoins: Math.round(totalUsd / LT_COIN * 100) / 100,
      delivery: {
        fullName: buyer.fullName,
        phone: buyer.phone || '+1 555 01' + String(10 + (i % 89)),
        email: buyer.email || (buyer.username || 'demo.user') + '@example.com',
        country: buyer.country, city: buyer.city,
        address: buyer.address || ((i % 240) + 1) + ' Market Street',
        postal: buyer.postal || '00000'
      },
      status, payment: 'whale_coin', createdAt: at,
      simulated: true, isBot: true, demo: true,
      timeline: [{ status: 'processing', at, note: 'Order placed' }]
    });
    made++;
    if (!['cancelled', 'refunded'].includes(status)) gmv += totalUsd;
  }

  const size = JSON.stringify(DB).length;
  if (size > DB_STORAGE_BUDGET) {
    DB.orders.length = beforeOrders;
    return { ok: false, error: 'Those orders would exceed this device\'s storage (currently ' + Math.round(beforeSize / 1024) + ' KB). Try fewer users.' };
  }

  const cfg = LT.demoUsersCfg();
  cfg.ordering = made;
  cfg.orderAt = Date.now();
  cfg.ordersTotal = (cfg.ordersTotal || 0) + made;
  try { AUDIT.log('Demo user orders created', made + ' users ordered · $' + Math.round(gmv) + ' simulated'); } catch (e) {}
  try { sync(); } catch (e) {}
  persist();
  return { ok: true, orders: made, users: made, gmv, total: DB.orders.filter(o => o.simulated).length };
};

App.demoUsersGenerate = function () {
  const el = document.getElementById('demoUserCount');
  const res = LT.generateDemoUsers(el ? el.value : 0);
  if (!res.ok) return toast(res.error, 'err');
  toast(res.added + ' demo users created · ' + res.total + ' demo users total', 'ok', 3600);
  render();
};

App.demoUsersOrders = function () {
  const el = document.getElementById('demoOrderUsers');
  const res = LT.generateDemoUserOrders(el ? el.value : 0);
  if (!res.ok) return toast(res.error, 'err');
  toast(res.orders + ' demo users placed an order · $' + Math.round(res.gmv) + ' simulated', 'ok', 3600);
  render();
};

/* ---------------- admin: generate company-market (wholesale) products ----------------
   Targets DB.companyProducts — the stock vendors buy from. Each run appends the
   requested 50–100 distinct SKUs across electronics, sound systems, phones,
   watches, bags, chargers, power banks and solar systems. Existing company
   products are never removed or overwritten. */
const COMPANY_CATEGORY_ORDER = [
  'Phones', 'Watches', 'Sound Systems', 'JBL Players', 'Speakers', 'Headphones',
  'Bags', 'Chargers', 'Power Banks', 'Solar Lamps', 'Solar Systems', 'Fridges',
  'Laptops', 'Tablets', 'Video Games', 'Phone Pouches', 'Accessories'
];
const COMPANY_EDITIONS = ['Series II', 'Pro Edition', 'Plus', 'Studio Pack', '2026 Edition', 'Bulk Pack', 'Max'];

LT.companyCatalog = null;
LT.loadCompanyCatalogue = async function (force) {
  if (LT.companyCatalog && !force) return LT.companyCatalog;
  const res = await fetch('./company-catalog.json?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('wholesale catalogue not available');
  const cat = await res.json();
  if (!cat || !Array.isArray(cat.models) || !cat.models.length) throw new Error('wholesale catalogue is empty');
  LT.companyCatalog = cat;
  return cat;
};

LT.generateCompanyProducts = async function (count) {
  const wanted = Math.round(Number(count) || 0);
  if (wanted < 50 || wanted > 100) return { ok: false, error: 'Choose between 50 and 100 products' };
  if (!DB || !DB_READY) return { ok: false, error: 'App is still loading — try again' };
  let demo, company;
  try { demo = await LT.loadDemoCatalog(false); } catch (e) { demo = null; }
  try { company = await LT.loadCompanyCatalogue(true); } catch (e) { company = null; }
  if (!demo && !company) return { ok: false, error: 'Could not load the product catalogues' };

  const pool = [];
  ((demo && demo.models) || []).forEach(m => pool.push({
    slug: m.slug, name: m.name, category: m.category,
    retail: Number(m.basePriceUsd) || 50,
    wholesale: Math.max(4, Math.round((Number(m.basePriceUsd) || 50) * 0.6)),
    image: m.image, description: m.description, color: m.color || ''
  }));
  ((company && company.models) || []).forEach(m => pool.push({
    slug: m.slug, name: m.name, category: m.category,
    retail: Number(m.retailUsd) || Number(m.wholesaleUsd) * 1.7 || 50,
    wholesale: Math.max(3, Number(m.wholesaleUsd) || Math.round((Number(m.retailUsd) || 50) * 0.6)),
    image: m.image, description: m.description, color: m.color || ''
  }));
  if (!pool.length) return { ok: false, error: 'No products available to generate' };

  const byCat = {};
  pool.forEach(m => { (byCat[m.category] = byCat[m.category] || []).push(m); });
  const categories = COMPANY_CATEGORY_ORDER.filter(c => byCat[c] && byCat[c].length)
    .concat(Object.keys(byCat).filter(c => !COMPANY_CATEGORY_ORDER.includes(c)));

  if (!Array.isArray(DB.companyProducts)) DB.companyProducts = [];
  /* existing rows always stay; just backfill a real photo when one is missing */
  const catImage = {};
  pool.forEach(m => { if (!catImage[m.category] && m.image) catImage[m.category] = m.image; });
  DB.companyProducts.forEach(p => {
    if (!p.image && catImage[p.category]) p.image = catImage[p.category];
  });
  const names = new Set(DB.companyProducts.map(p => String(p.name || '').toLowerCase()));
  const ids = new Set(DB.companyProducts.map(p => p.id));
  const usedInCat = {};
  const batch = Date.now().toString(36);
  const added = [];
  let guard = 0;

  while (added.length < wanted && guard < wanted * 12) {
    guard++;
    const cat = categories[added.length % categories.length];
    const list = byCat[cat];
    const round = usedInCat[cat] || 0;
    usedInCat[cat] = round + 1;
    const model = list[round % list.length];
    const edition = Math.floor(round / list.length);   // 0 = base model, 1+ = edition variant

    let name = model.name;
    if (edition > 0 || names.has(name.toLowerCase())) {
      let k = Math.max(0, edition - 1);
      let candidate;
      do {
        candidate = model.name + ' · ' + COMPANY_EDITIONS[k % COMPANY_EDITIONS.length];
        k++;
      } while (names.has(candidate.toLowerCase()) && k < 40);
      if (names.has(candidate.toLowerCase())) candidate = model.name + ' · Batch ' + batch.toUpperCase();
      name = candidate;
    }
    if (names.has(name.toLowerCase())) continue;

    let id = 'cmp_' + model.slug + '_' + batch + '_' + (added.length + 1);
    let n = 1;
    while (ids.has(id)) id = 'cmp_' + model.slug + '_' + batch + '_' + (added.length + 1) + '_' + (n++);

    const factor = 1 + edition * 0.045;
    const wholesale = Math.max(3, Math.round(model.wholesale * factor));
    const stock = 30 + Math.floor(Math.random() * 150);
    DB.companyProducts.push({
      id, name, category: model.category,
      priceUsd: wholesale,
      stock,
      description: (model.description || '') + (edition > 0
        ? ' Edition variant with the same core specification, shipped in wholesale cartons.' : ''),
      image: model.image || null,
      emoji: null,
      color: model.color || '',
      retailUsd: Math.round(model.retail * factor),
      generated: true,
      batch,
      createdAt: Date.now()
    });
    ids.add(id);
    names.add(name.toLowerCase());
    added.push({ name, category: model.category });
  }

  if (!added.length) return { ok: false, error: 'Could not create new products — try again' };

  if (!DB.settings) DB.settings = {};
  const gen = DB.settings.companyGen || { total: 0, batches: [] };
  gen.total = (gen.total || 0) + added.length;
  gen.lastAt = Date.now();
  gen.lastCount = added.length;
  gen.batches = [{ at: Date.now(), count: added.length, batch }].concat(gen.batches || []).slice(0, 10);
  DB.settings.companyGen = gen;

  const byCategory = {};
  added.forEach(a => { byCategory[a.category] = (byCategory[a.category] || 0) + 1; });
  try { AUDIT.log('Company products generated', added.length + ' new wholesale SKUs · ' + Object.keys(byCategory).length + ' categories'); } catch (e) {}
  try { sync(); } catch (e) {}
  persist();
  return { ok: true, added: added.length, total: DB.companyProducts.length, byCategory };
};

/* ---------------- admin: generate brand-new demo products ----------------
   Append-only: every call adds distinct listings and never deletes, renames
   or replaces an existing product. Uses unused catalogue models first, then
   store-specific model variants once a category is exhausted. */
LT.generateDemoProducts = function (opts) {
  const catalog = LT.demoCatalog;
  if (!catalog) return { ok: false, error: 'Catalogue is still loading — try again in a moment' };
  const cfg = LT.sellersCfg();
  const wanted = Math.round(Number(opts && opts.count) || 0);
  if (wanted < 1 || wanted > 50) return { ok: false, error: 'Choose between 1 and 50 products' };
  const category = opts && opts.category && opts.category !== 'All' ? opts.category : null;
  const vendors = (DB.vendors || []).filter(v => v.demo);
  if (!vendors.length) return { ok: false, error: 'Publish the demo storefronts first' };
  const targets = (opts && opts.sellerId && opts.sellerId !== 'all')
    ? vendors.filter(v => v.id === opts.sellerId) : vendors;
  if (!targets.length) return { ok: false, error: 'That storefront is not a demo store' };
  const pool = (catalog.models || []).filter(m => !category || m.category === category);
  if (!pool.length) return { ok: false, error: 'No catalogue models in that category' };

  const usedBy = new Map();
  const usedAnywhere = new Set();
  (DB.products || []).filter(p => p.demo).forEach(p => {
    if (!usedBy.has(p.vendorId)) usedBy.set(p.vendorId, new Set());
    if (p.modelSlug) { usedBy.get(p.vendorId).add(p.modelSlug); usedAnywhere.add(p.modelSlug); }
  });

  const EDITIONS = ['Series II', 'Pro Edition', 'Studio Pack', 'Plus Edition', 'Max'];
  const added = [];
  for (let i = 0; i < wanted; i++) {
    const v = targets[i % targets.length];
    const seller = (catalog.sellers || []).find(s => s.slug === v.demoSlug) || { slug: v.demoSlug, markup: v.markup || 1.06 };
    if (!usedBy.has(v.id)) usedBy.set(v.id, new Set());
    const used = usedBy.get(v.id);
    const model = pool.find(m => !usedAnywhere.has(m.slug) && !used.has(m.slug))
      || pool.find(m => !used.has(m.slug));
    let def;
    if (model) {
      def = LT.demoListingFromModel(seller, model);
      used.add(model.slug);
      usedAnywhere.add(model.slug);
    } else {
      const base = pool[(i + added.length) % pool.length];
      let n = 2, slug;
      do { slug = base.slug + '-v' + n++; } while (used.has(slug));
      const factor = 1 + 0.06 * (n - 2);
      const price = Math.max(5, Math.round(base.basePriceUsd * (seller.markup || 1.06) * factor));
      def = LT.demoListingFromModel(seller, {
        slug, name: base.name + ' · ' + EDITIONS[(n - 2) % EDITIONS.length],
        category: base.category, basePriceUsd: Math.round(price / (seller.markup || 1.06)),
        color: base.color, image: base.image,
        description: base.description + ' Limited production run with the same core specification, a 2-year warranty and repairable parts.'
      });
      def.priceUsd = price;
      used.add(slug);
    }
    def.generated = true;
    LT.upsertDemoListing(seller, def, false);
    added.push({ vendor: v.name, name: def.name });
  }

  const liveDemo = (DB.products || []).filter(p => p.demo && p.active).length;
  cfg.generated = (cfg.generated || 0) + added.length;
  cfg.lastGeneratedAt = Date.now();
  cfg.generatedLog = [{ at: Date.now(), count: added.length, category: category || 'All', sellerId: (opts && opts.sellerId) || 'all' }]
    .concat(cfg.generatedLog || []).slice(0, 8);
  cfg.listings = (DB.vendors || []).filter(x => x.demo)
    .reduce((sum, x) => sum + (DB.products || []).filter(p => p.vendorId === x.id && p.active).length, 0);
  try { AUDIT.log('Demo products generated', added.length + ' new listings · ' + (category || 'all categories')); } catch (e) {}
  try { sync(); } catch (e) {}
  persist();
  const byVendor = {};
  added.forEach(a => { byVendor[a.vendor] = (byVendor[a.vendor] || 0) + 1; });
  return { ok: true, added: added.length, byVendor, liveDemo, total: liveDemo };
};

App.demoGenerateProducts = function () {
  const countEl = document.getElementById('dsGenCount');
  const sellerEl = document.getElementById('dsGenSeller');
  const catEl = document.getElementById('dsGenCat');
  const res = LT.generateDemoProducts({
    count: countEl ? countEl.value : 0,
    sellerId: sellerEl ? sellerEl.value : 'all',
    category: catEl ? catEl.value : 'All'
  });
  if (!res.ok) return toast(res.error, 'err');
  const stores = Object.keys(res.byVendor).length;
  toast(res.added + ' new products added to ' + stores + ' store' + (stores === 1 ? '' : 's') + ' — existing listings kept', 'ok');
  render();
};

/* ---------------- admin: edit a storefront's product range ---------------- */
LT.applySellerRange = function (vendorId, productCount, categories) {
  const v = vendorById(vendorId);
  const catalog = LT.demoCatalog;
  if (!v || !v.demo || !catalog) return { ok: false, error: 'Storefront not found' };
  const seller = (catalog.sellers || []).find(s => s.slug === (v.demoSlug || v.username));
  if (!seller) return { ok: false, error: 'Catalogue entry not found' };
  const n = Math.round(Number(productCount) || 0);
  if (n < 10 || n > 50) return { ok: false, error: 'Product range must be between 10 and 50' };
  const cats = (categories || []).filter(c => (catalog.categories || []).includes(c));
  const available = LT.demoRangeAvailability(cats);
  if (available < n) return { ok: false, error: 'Only ' + available + ' catalogue models match those categories' };

  const cfg = LT.sellersCfg();
  cfg.ranges[seller.slug] = { productCount: n, categories: cats };
  const models = LT.demoSellerRangeModels(catalog, seller);
  const keep = new Set();
  let added = 0, updated = 0;
  models.forEach(m => {
    const def = LT.demoListingFromModel(seller, m);
    keep.add(def.id);
    if (LT.upsertDemoListing(seller, def, false) === 'added') added++; else updated++;
  });
  const ordered = new Set((DB.orders || []).flatMap(o => (o.items || []).map(i => i.productId)));
  const removedIds = new Set();
  DB.products = (DB.products || []).filter(p => {
    if (!(p.demo && p.vendorId === vendorId && p.id.indexOf('dsp_') === 0)) return true;
    if (p.generated) return true;
    if (keep.has(p.id)) { p.active = p.stock > 0; p.retired = false; return true; }
    if (ordered.has(p.id)) { p.active = false; p.retired = true; return true; }
    removedIds.add(p.id);
    return false;
  });
  if (removedIds.size) {
    (DB.users || []).forEach(x => { if (Array.isArray(x.cart)) x.cart = x.cart.filter(c => !removedIds.has(c.productId)); });
  }
  v.productCount = models.length;
  v.markup = seller.markup || v.markup || 1.06;
  cfg.listings = (DB.vendors || []).filter(x => x.demo)
    .reduce((sum, x) => sum + (DB.products || []).filter(p => p.vendorId === x.id && p.active).length, 0);
  try { AUDIT.log('Demo range updated', v.name + ' · ' + models.length + ' products · ' + (cats.length ? cats.join(', ') : 'all categories')); } catch (e) {}
  try { sync(); } catch (e) {}
  persist();
  return { ok: true, count: models.length, added, updated, removed: removedIds.size };
};

App.demoSellerEdit = function (vendorId) {
  const v = vendorById(vendorId);
  const catalog = LT.demoCatalog;
  if (!v || !catalog) return toast('Storefront not ready yet', 'err');
  const seller = (catalog.sellers || []).find(s => s.slug === (v.demoSlug || v.username));
  if (!seller) return toast('Catalogue entry not found', 'err');
  const ov = LT.sellersCfg().ranges[seller.slug];
  const cats = catalog.categories || [];
  const selected = (ov && ov.categories && ov.categories.length) ? ov.categories : (seller.primaryCategories || []);
  const count = (ov && ov.productCount) || v.productCount || (seller.listings || []).length;
  openModal(modalShell('Edit product range · ' + v.name, `
    <div class="panel" style="padding:12px;margin-bottom:14px">
      <div class="between"><span class="tiny muted">Catalogue models</span><b class="small">${(catalog.models || []).length}</b></div>
      <div class="between mt6"><span class="tiny muted">Currently published</span><b class="small">${(DB.products || []).filter(p => p.vendorId === v.id).length}</b></div>
    </div>
    <div class="field"><label class="label">Products to publish (10–50)</label>
      <input class="input" id="dsRangeCount" type="number" min="10" max="50" step="1" value="${count}" inputmode="numeric"/>
      <div class="help">Each product is a different catalogue model — the store never repeats a listing.</div>
    </div>
    <div class="field"><label class="label">Categories this store draws from</label>
      <div class="checkbox-grid panel" style="padding:10px;max-height:190px;overflow:auto">
        ${cats.map(c => `<label><input type="checkbox" name="dsCat" value="${esc(c)}" ${selected.includes(c) ? 'checked' : ''}/> ${esc(c)}</label>`).join('')}
      </div>
      <div class="help">Tick at least one. Only models in the ticked categories are used.</div>
    </div>
    <div id="dsRangeAvail" class="tiny muted"></div>`,
    `<button class="btn btn-ghost" data-close>Cancel</button>
     <button class="btn btn-ghost" data-act="demo-seller-reset-range" data-id="${v.id}">Reset to default</button>
     <button class="btn btn-primary" data-act="demo-seller-save-range" data-id="${v.id}">${ic('check', 15)} Save range</button>`), { width: '520px' });
  const upd = () => {
    const picked = $$('input[name="dsCat"]:checked').map(x => x.value);
    const avail = LT.demoRangeAvailability(picked);
    const el = document.getElementById('dsRangeAvail');
    if (el) el.innerHTML = avail + ' model' + (avail === 1 ? '' : 's') + ' available in the selected categories.';
  };
  $$('input[name="dsCat"]').forEach(x => { x.onchange = upd; });
  const countEl = document.getElementById('dsRangeCount');
  if (countEl) countEl.oninput = upd;
  upd();
};

App.demoSellerSaveRange = function (vendorId) {
  const countEl = document.getElementById('dsRangeCount');
  const categories = $$('input[name="dsCat"]:checked').map(x => x.value);
  const res = LT.applySellerRange(vendorId, countEl ? countEl.value : 10, categories);
  if (!res.ok) return toast(res.error, 'err');
  closeModal();
  toast(res.count + ' products published · ' + res.added + ' new, ' + res.removed + ' retired', 'ok');
  render();
};

App.demoSellerResetRange = function (vendorId) {
  const v = vendorById(vendorId);
  if (!v || !LT.demoCatalog) return;
  const seller = (LT.demoCatalog.sellers || []).find(s => s.slug === (v.demoSlug || v.username));
  if (!seller) return;
  const cfg = LT.sellersCfg();
  delete cfg.ranges[seller.slug];
  const models = LT.demoSellerRangeModels(LT.demoCatalog, seller);
  const keep = new Set(models.map(m => 'dsp_' + seller.slug + '_' + m.slug));
  models.forEach(m => LT.upsertDemoListing(seller, LT.demoListingFromModel(seller, m), false));
  const orderedReset = new Set((DB.orders || []).flatMap(o => (o.items || []).map(i => i.productId)));
  DB.products = (DB.products || []).filter(p => {
    if (!(p.demo && p.vendorId === vendorId && p.id.indexOf('dsp_') === 0 && !keep.has(p.id))) return true;
    if (p.generated) return true;
    if (orderedReset.has(p.id)) { p.active = false; p.retired = true; return true; }
    return false;
  });
  v.productCount = models.length;
  cfg.listings = (DB.vendors || []).filter(x => x.demo)
    .reduce((sum, x) => sum + (DB.products || []).filter(p => p.vendorId === x.id && p.active).length, 0);
  try { AUDIT.log('Demo range reset', v.name + ' · ' + models.length + ' products (catalogue default)'); } catch (e) {}
  closeModal();
  try { sync(); } catch (e) {}
  persist();
  toast('Range reset to the catalogue default', 'ok');
  render();
};

/* ---------------- demo shopper activity (simulated orders) ---------------- */
LT.seedDemoActivity = function (extra) {
  const cfg = LT.sellersCfg();
  if (!extra && cfg.activity && cfg.activity.seededAt) return cfg.activity;
  try { if (typeof LT.seedBots === 'function') LT.seedBots(); } catch (e) {}
  const shoppers = (DB.users || []).filter(u => u.isBot && !u.isDemoSeller);
  const sellers = (DB.vendors || []).filter(v => v.demo);
  if (!shoppers.length || !sellers.length) return null;
  const products = (DB.products || []).filter(p => p.demo && p.active);
  if (!products.length) return null;

  const n = extra ? Math.max(1, Number(extra) || 1) : 72;
  const now = Date.now();
  const startIndex = (cfg.activity && Number(cfg.activity.orders)) || 0;
  let made = 0;
  for (let i = 0; i < n; i++) {
    const seller = sellers[Math.floor(Math.random() * sellers.length)];
    const pool = products.filter(p => p.vendorId === seller.id);
    if (!pool.length) continue;
    const p = pool[Math.floor(Math.random() * pool.length)];
    const buyer = shoppers[Math.floor(Math.random() * shoppers.length)];
    const daysAgo = extra ? Math.floor(Math.random() * 3) : Math.floor(Math.pow(Math.random(), 1.35) * 28);
    const createdAt = now - daysAgo * 864e5 - Math.floor(Math.random() * 20) * 36e5;
    const qty = Math.random() < 0.82 ? 1 : 2;
    const totalUsd = Math.round(p.priceUsd * qty * 100) / 100;
    const totalCoins = Math.round(totalUsd / LT_COIN * 100) / 100;
    let status;
    if (daysAgo <= 1) status = Math.random() < 0.5 ? 'pending' : 'processing';
    else if (daysAgo <= 4) status = Math.random() < 0.6 ? 'processing' : 'shipped';
    else status = Math.random() < 0.92 ? 'delivered' : 'cancelled';
    DB.orders.unshift({
      id: 'ord_demo_' + (startIndex + i + 1), ref: 'WC-' + Math.random().toString(36).slice(2, 7).toUpperCase(),
      buyerId: buyer.id, vendorId: seller.id,
      items: [{ productId: p.id, name: p.name, qty, priceUsd: p.priceUsd, image: p.image, emoji: null, category: p.category }],
      totalUsd, totalCoins,
      delivery: {
        fullName: buyer.fullName,
        phone: buyer.phone || '+1 555 0100',
        email: buyer.email || (buyer.username || 'demo.user') + '@example.com',
        country: buyer.country, city: buyer.city,
        address: buyer.address || '12 Market Street',
        postal: buyer.postal || '00000'
      },
      status, payment: 'whale_coin', createdAt, simulated: true, isBot: true, demo: true,
      timeline: [{ status: 'Order placed', at: createdAt, note: 'Order placed' }]
    });
    made++;
  }
  cfg.activity = { seededAt: (cfg.activity && cfg.activity.seededAt) || now, orders: ((cfg.activity && cfg.activity.orders) || 0) + made, lastAt: now };
  return cfg.activity;
};

App.demoActivityAdd = function () {
  const n = 24;
  const res = LT.seedDemoActivity(n);
  if (!res) return toast('Publish the demo storefronts first', 'err');
  try { AUDIT.log('Demo activity generated', n + ' simulated orders'); } catch (e) {}
  try { sync(); } catch (e) {}
  persist();
  toast(n + ' demo orders added across the last 3 days', 'ok');
  render();
};

LT.demoActivityStats = function () {
  const now = Date.now();
  const dayMs = 864e5;
  const shoppers = (DB.users || []).filter(u => u.isBot && !u.isDemoSeller);
  const demoVendors = (DB.vendors || []).filter(v => v.demo);
  const demoVendorIds = new Set(demoVendors.map(v => v.id));
  const demoProducts = (DB.products || []).filter(p => p.demo);
  const orders = (DB.orders || []).filter(o => o.simulated);
  const demoOrders = orders.filter(o => demoVendorIds.has(o.vendorId));
  const gmv = demoOrders.filter(o => !['cancelled', 'refunded'].includes(o.status))
    .reduce((n, o) => n + (Number(o.totalUsd) || 0), 0);

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const start = new Date(now - i * dayMs);
    start.setHours(0, 0, 0, 0);
    const end = start.getTime() + dayMs;
    const list = demoOrders.filter(o => (o.createdAt || 0) >= start.getTime() && (o.createdAt || 0) < end);
    days.push({
      label: start.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }),
      short: start.toLocaleDateString('en-US', { weekday: 'short' }),
      orders: list.length,
      gmv: list.reduce((n, o) => n + (Number(o.totalUsd) || 0), 0)
    });
  }
  const week = days.slice(7).reduce((n, d) => n + d.orders, 0);
  const prevWeek = days.slice(0, 7).reduce((n, d) => n + d.orders, 0);

  const bySeller = demoVendors.map(v => {
    const list = demoOrders.filter(o => o.vendorId === v.id);
    const paid = list.filter(o => !['cancelled', 'refunded'].includes(o.status));
    return {
      vendor: v,
      orders: list.length,
      gmv: paid.reduce((n, o) => n + (Number(o.totalUsd) || 0), 0),
      units: paid.reduce((n, o) => n + (o.items || []).reduce((k, i) => k + (Number(i.qty) || 0), 0), 0)
    };
  }).sort((a, b) => b.gmv - a.gmv);

  const catMap = {};
  demoOrders.forEach(o => (o.items || []).forEach(i => {
    const k = (i.category || 'Other');
    catMap[k] = (catMap[k] || 0) + (Number(i.qty) || 1);
  }));
  const byCategory = Object.keys(catMap).map(k => ({ category: k, units: catMap[k] })).sort((a, b) => b.units - a.units);

  const ordersByBuyer = new Map();
  demoOrders.forEach(o => {
    if (!ordersByBuyer.has(o.buyerId)) ordersByBuyer.set(o.buyerId, []);
    ordersByBuyer.get(o.buyerId).push(o);
  });
  const botByUser = new Map((DB.bots || []).map(b => [b.botId, b]));
  const byBuyer = shoppers.map(u => {
    const list = ordersByBuyer.get(u.id) || [];
    if (!list.length) return null;
    const paid = list.filter(o => !['cancelled', 'refunded'].includes(o.status));
    return {
      user: u,
      orders: list.length,
      spend: paid.reduce((n, o) => n + (Number(o.totalUsd) || 0), 0),
      lastAt: list.reduce((m, o) => Math.max(m, o.createdAt || 0), 0),
      nextAt: (botByUser.get(u.id) || {}).nextAt || 0
    };
  }).filter(Boolean).sort((a, b) => b.spend - a.spend).slice(0, 25);

  const recent = demoOrders.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 10);

  return { shoppers, demoVendors, demoProducts, orders, demoOrders, gmv, days, week, prevWeek,
           bySeller, byCategory, byBuyer, recent, shopperTotal: shoppers.length };
};

function ltDemoActivityView() {
  const st = LT.demoActivityStats();
  const cfg = LT.sellersCfg();
  const bots = (function () { try { return LT.botsCfg().enabled; } catch (e) { return false; } })();
  const tabs = `<div class="admin-nav">${ADMIN_NAV.map(n => {
    const key = n.href.replace('#/admin', '') || '';
    return `<a href="${n.href}" class="${key === '/demo-activity' ? 'on' : ''}">${n.label}</a>`;
  }).join('')}</div>`;
  const max = Math.max(1, ...st.days.map(d => d.orders));
  const gmvMax = Math.max(1, ...st.days.map(d => d.gmv));
  const totalGmv = st.bySeller.reduce((n, s) => n + s.gmv, 0);
  const trend = st.prevWeek ? Math.round(((st.week - st.prevWeek) / st.prevWeek) * 100) : (st.week ? 100 : 0);
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  return `${tabs}
  <div class="page-head"><div class="between" style="align-items:flex-start;gap:12px;flex-wrap:wrap">
    <div><div class="section-title" style="margin:0">Demo activity</div>
      <div class="tiny muted">Everything demo shoppers and demo sellers have done — all simulated, never real revenue</div></div>
    <div class="row gap8">
      <a href="#/admin/bots" class="btn btn-ghost">${ic('users', 14)} Shoppers</a>
      <button class="btn btn-primary" data-act="demo-activity-add">${ic('plus', 15)} Generate orders</button>
    </div>
  </div></div>

  <div class="grid-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">
    ${[
      ['Demo sellers', st.demoVendors.length, st.demoVendors.length + ' storefronts'],
      ['Demo shoppers', st.shoppers.length, bots ? 'ordering schedule on' : 'schedule off'],
      ['Demo listings', st.demoProducts.length, st.demoProducts.filter(p => p.stock > 0).length + ' in stock'],
      ['Demo orders', st.demoOrders.length, st.week + ' in the last 7 days'],
      ['Simulated GMV', money(st.gmv), 'from non-cancelled orders'],
      ['7-day trend', (trend >= 0 ? '+' : '') + trend + '%', 'vs previous 7 days']
    ].map(([label, value, sub]) => `<div class="card" style="margin:0">
      <div class="tiny muted">${label}</div>
      <div style="font-family:var(--display);font-size:24px;font-weight:800;letter-spacing:-.03em;margin-top:4px">${value}</div>
      <div class="tiny muted" style="margin-top:2px">${sub}</div>
    </div>`).join('')}
  </div>

  <div class="card mt14">
    <div class="between" style="align-items:center;flex-wrap:wrap;gap:8px">
      <div><div class="card-title" style="margin:0">Orders · last 14 days</div>
        <div class="tiny muted">Bars are order counts, the line is simulated GMV</div></div>
      <span class="badge">${st.demoOrders.length} total</span>
    </div>
    <div style="display:flex;align-items:flex-end;gap:6px;height:170px;margin-top:18px">
      ${st.days.map(d => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:5px;min-width:0" title="${d.label}: ${d.orders} orders · ${money(d.gmv)}">
        <div class="tiny muted" style="font-size:9px">${d.orders || ''}</div>
        <div style="width:100%;max-width:30px;height:${Math.max(3, Math.round(d.orders / max * 120))}px;border-radius:6px 6px 3px 3px;background:linear-gradient(180deg,#2ee6c9,#3aa0ff);opacity:${d.orders ? 1 : .22}"></div>
        <div class="tiny muted" style="font-size:9px;white-space:nowrap">${d.short}</div>
      </div>`).join('')}
    </div>
    <div class="row gap10 mt12" style="flex-wrap:wrap">
      <span class="tiny muted">Peak day: <b style="color:var(--text)">${max} orders</b></span>
      <span class="tiny muted">GMV peak: <b style="color:var(--text)">${money(gmvMax)}</b></span>
      <span class="tiny muted">Avg order: <b style="color:var(--text)">${money(st.demoOrders.length ? st.gmv / st.demoOrders.length : 0)}</b></span>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1.35fr 1fr;gap:14px" class="demo-cols">
    <div class="card" style="margin:0">
      <div class="card-title">Storefront leaderboard</div>
      ${st.bySeller.length ? `<div class="inv-list">
        ${st.bySeller.map((s, i) => `<a class="inv-row" href="#/store/${s.vendor.id}" style="color:inherit;text-decoration:none">
          <span class="badge" style="min-width:22px;justify-content:center">${i + 1}</span>
          <span class="avatar sm" style="overflow:hidden;flex:0 0 auto;width:34px;height:34px">${s.vendor.avatar ? `<img src="${s.vendor.avatar}" style="width:100%;height:100%;object-fit:cover"/>` : ''}</span>
          <div class="grow" style="min-width:0">
            <div class="small" style="font-weight:650">${esc(s.vendor.name)}</div>
            <div class="tiny muted">${s.orders} orders · ${s.units} units · ${esc(s.vendor.city || '')}</div>
            <div style="height:4px;border-radius:3px;background:var(--surface-2);margin-top:5px;overflow:hidden">
              <div style="height:100%;width:${totalGmv ? Math.max(2, Math.round(s.gmv / totalGmv * 100)) : 0}%;background:linear-gradient(90deg,#2ee6c9,#3aa0ff)"></div></div>
          </div>
          <div style="text-align:right"><b class="small">${money(s.gmv)}</b><div class="tiny muted">${totalGmv ? Math.round(s.gmv / totalGmv * 100) : 0}% share</div></div>
        </a>`).join('')}
      </div>` : `<div class="inv-empty"><p class="small muted">No demo orders yet.</p></div>`}
    </div>

    <div class="card" style="margin:0">
      <div class="card-title">Category mix</div>
      ${st.byCategory.length ? `<div class="col gap10">
        ${st.byCategory.map(c => {
          const top = st.byCategory[0].units || 1;
          return `<div>
            <div class="between"><span class="tiny">${esc(c.category)}</span><span class="tiny muted">${c.units} units</span></div>
            <div style="height:6px;border-radius:4px;background:var(--surface-2);margin-top:4px;overflow:hidden">
              <div style="height:100%;width:${Math.max(3, Math.round(c.units / top * 100))}%;background:linear-gradient(90deg,rgba(46,230,201,.85),rgba(58,160,255,.75))"></div>
            </div></div>`;
        }).join('')}
      </div>` : `<div class="tiny muted">No category data yet.</div>`}
      <div class="divider"></div>
      <div class="between"><span class="tiny muted">Demo storefronts</span>
        <a href="#/admin/demo-sellers" class="btn btn-xs btn-soft">Manage</a></div>
      <div class="between mt8"><span class="tiny muted">Demo shoppers</span>
        <a href="#/admin/bots" class="btn btn-xs btn-soft">Manage</a></div>
      <div class="between mt8"><span class="tiny muted">Storefront state</span>
        <span class="badge ${cfg.enabled ? 'badge-success' : 'badge-warn'}">${cfg.enabled ? 'Live' : 'Hidden'}</span></div>
    </div>
  </div>

  <div class="card mt14">
    <div class="between"><div class="card-title" style="margin:0">Shopper activity</div>
      <span class="badge">${st.byBuyer.length} of ${st.shopperTotal} users</span></div>
    <div class="tiny muted" style="margin-bottom:6px">Top spenders among demo users who have ordered.</div>
    <div class="inv-list">
      ${st.byBuyer.length ? st.byBuyer.map(b => `<div class="inv-row">
        <span class="avatar sm" style="overflow:hidden;flex:0 0 auto;width:34px;height:34px">${b.user.avatar ? `<img src="${b.user.avatar}" style="width:100%;height:100%;object-fit:cover"/>` : ''}</span>
        <div class="grow" style="min-width:0">
          <div class="small" style="font-weight:650">${esc(b.user.fullName)} <span class="badge" style="font-size:9px">Demo</span></div>
          <div class="tiny muted">${esc(b.user.city)}, ${esc(b.user.country)} · ${b.orders} orders · ${b.lastAt ? 'last ' + timeAgo(b.lastAt) : 'no orders yet'}</div>
        </div>
        <div style="text-align:right"><b class="small">${money(b.spend)}</b>
          <div class="tiny muted">${b.nextAt ? 'next ' + new Date(b.nextAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'unscheduled'}</div></div>
      </div>`).join('') : `<div class="inv-empty"><p class="small muted">Demo shoppers appear once the shopper fleet is seeded.</p></div>`}
    </div>
  </div>

  <div class="card mt14">
    <div class="card-title">Recent demo orders</div>
    ${st.recent.length ? `<div class="inv-list">
      ${st.recent.map(o => {
        const buyer = findUser(o.buyerId) || {};
        const v = vendorById(o.vendorId) || {};
        const it = (o.items || [])[0] || {};
        return `<div class="inv-row" style="align-items:flex-start">
          <span class="avatar sm" style="overflow:hidden;flex:0 0 auto;width:34px;height:34px">${buyer.avatar ? `<img src="${buyer.avatar}" style="width:100%;height:100%;object-fit:cover"/>` : ''}</span>
          <div class="grow" style="min-width:0">
            <div class="small" style="font-weight:600">${esc(buyer.fullName || 'Demo shopper')} <span class="muted">→</span> ${esc(v.name || 'store')}</div>
            <div class="tiny muted ellipsis">${esc(it.name || '')}${it.qty > 1 ? ' × ' + it.qty : ''}</div>
            <div class="tiny muted">${timeAgo(o.createdAt)} · ${esc(o.ref || o.id)}</div>
          </div>
          <div style="text-align:right"><b class="small">${usd(o.totalUsd)}</b>
            <div class="tiny muted" style="text-transform:capitalize">${esc(o.status)}</div></div>
        </div>`;
      }).join('')}
    </div>` : `<div class="inv-empty"><p class="small muted">No demo orders yet — tap Generate orders.</p></div>`}
  </div>
  <style>@media(max-width:820px){.demo-cols{grid-template-columns:1fr!important}}</style>`;
}

/* ---------------- public storefront ---------------- */
const STORE_VIEW = { cat: 'All', vendorId: null };
VIEWS.store = function (parts) {
  const u = me();
  const v = vendorById(parts[1]);
  if (!v) return `<div class="empty"><div class="ic">${ic('store', 26)}</div><h3>Store not found</h3><p>This storefront may have been removed.</p><a href="#/market" class="btn btn-primary">Back to marketplace</a></div>`;
  const owner = findUser(v.userId) || {};
  if (v.demo) { try { LT.ensureDemoSellers(false); } catch (e) {} }
  const active = vendorIsActive(v) && v.status !== 'suspended';
  const all = (DB.products || []).filter(p => p.vendorId === v.id && p.active && p.stock > 0 && !p.hidden);
  if (STORE_VIEW.vendorId !== v.id) { STORE_VIEW.vendorId = v.id; STORE_VIEW.cat = 'All'; }
  const cats = ['All', ...new Set(all.map(p => p.category))];
  const filtered = all.filter(p => STORE_VIEW.cat === 'All' || p.category === STORE_VIEW.cat);
  const reviews = all.reduce((n, p) => n + (Number(p.stars) || 0), 0);
  const units = all.reduce((n, p) => n + (Number(p.stock) || 0), 0);
  const since = new Date(v.createdAt || Date.now()).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const orders = (DB.orders || []).filter(o => o.vendorId === v.id && !['cancelled', 'refunded'].includes(o.status));
  return `<div class="row gap6 tiny muted mb10" style="cursor:pointer" data-act="back">${ic('back', 14)} Back</div>
  <div class="store-hero">
    ${v.banner ? `<img src="${v.banner}" alt="${esc(v.name)} storefront" class="store-hero-img"/>` : ''}
    <div class="store-hero-fade"></div>
    ${v.demo ? `<span class="badge badge-warn store-demo-badge">${ic('shield', 11)} Demo store</span>` : ''}
  </div>
  <div class="card store-head">
    <div class="store-head-row">
      <div class="store-avatar">
        ${v.avatar ? `<img src="${v.avatar}" alt="${esc(v.name)}"/>` : `<span>${esc((v.name || 'S')[0])}</span>`}
      </div>
      <div class="grow" style="min-width:0">
        <h1 class="store-name">${esc(v.name)} ${v.demo ? '' : `<span class="badge badge-success" style="font-size:9px;vertical-align:middle">Verified</span>`}</h1>
        <div class="tiny muted">@${esc(v.username)} · ${esc(v.city || '')}${v.country ? ', ' + esc(v.country) : ''} · Member since ${since}</div>
        <div class="row gap10 mt8 wrap" style="align-items:center">
          <span class="tiny"><span style="color:var(--gold)">★★★★★</span> <b>${Number(v.rating || 4.7).toFixed(1)}</b> <span class="muted">(${reviews.toLocaleString('en-US')} reviews)</span></span>
          <span class="badge">${ic('shield', 11)} Trust ${v.trustScore || 90}/100</span>
          ${v.demo ? `<span class="badge">Demo storefront</span>` : ''}
        </div>
      </div>
      <div class="store-actions">
        ${me() && me().role === 'admin' && v.demo ? `<button class="btn btn-ghost btn-sm" data-act="demo-seller-edit" data-id="${v.id}">${ic('settings', 14)} Edit range</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-act="store-share" data-id="${v.id}">${ic('link', 14)} Share</button>
      </div>
    </div>
    <div class="store-stats">
      <div><span class="tiny muted">Products</span><b>${all.length}</b></div>
      <div><span class="tiny muted">Orders</span><b>${v.completedSales || orders.length}</b></div>
      <div><span class="tiny muted">Units in stock</span><b>${units}</b></div>
      <div><span class="tiny muted">Ships from</span><b>${esc(v.city || '—')}</b></div>
      <div><span class="tiny muted">Reply time</span><b>Under 2h</b></div>
    </div>
    <p class="store-tagline">${esc(v.tagline || '')}</p>
    <p class="small muted store-bio">${esc(v.bio || owner.bio || 'This vendor has not added a store description yet.')}</p>
    ${!active ? `<div class="err mt10">This store is temporarily unavailable — the vendor subscription has ended.</div>` : ''}
  </div>

  <div class="between wrap gap10 mt16 mb10">
    <div class="chip-row">${cats.map(c => `<button class="chip ${STORE_VIEW.cat === c ? 'on' : ''}" data-act="store-cat" data-id="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <span class="badge">${filtered.length} product${filtered.length === 1 ? '' : 's'}</span>
  </div>
  ${filtered.length ? `<div class="grid-products">${filtered.map(p => productCard(p, u)).join('')}</div>` :
    `<div class="card empty"><div class="ic">${ic('box', 26)}</div><h3>No products in this category</h3><p>Try another category or check back later.</p><button class="btn btn-primary" data-act="store-cat" data-id="All">Show all products</button></div>`}

  <div class="card mt16 store-policy">
    <div class="card-title">Store policies</div>
    <div class="store-policy-grid">
      <div><b class="small">${ic('truck', 14)} Tracked delivery</b><p class="tiny muted">Every order ships with tracking. The team approves each purchase before dispatch.</p></div>
      <div><b class="small">${ic('shield', 14)} Buyer protection</b><p class="tiny muted">Whale Coin payments are held until the order is confirmed delivered.</p></div>
      <div><b class="small">${ic('refresh', 14)} Returns</b><p class="tiny muted">Report a problem within 7 days of delivery and the store will resolve it.</p></div>
    </div>
  </div>
  <style>
    .store-hero{position:relative;height:210px;border-radius:18px;overflow:hidden;border:1px solid var(--border);background:linear-gradient(120deg,#0b3a47,#0b2230)}
    .store-hero-img{width:100%;height:100%;object-fit:cover;display:block}
    .store-hero-fade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(4,16,26,0) 35%,rgba(4,16,26,.82) 100%)}
    .store-demo-badge{position:absolute;top:12px;left:12px}
    .store-head{margin-top:-42px;position:relative;z-index:2}
    .store-head-row{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
    .store-avatar{width:88px;height:88px;border-radius:20px;overflow:hidden;border:3px solid var(--surface);background:var(--surface-2);flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:800;margin-top:-46px;box-shadow:0 10px 24px rgba(0,0,0,.35)}
    .store-avatar img{width:100%;height:100%;object-fit:cover}
    .store-name{font-size:24px;line-height:1.15;letter-spacing:-.02em;margin:0 0 4px}
    .store-actions{display:flex;gap:8px;flex-wrap:wrap}
    .store-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-top:14px;padding:12px 0}
    .store-stats b{display:block;font-size:15px;margin-top:2px}
    .store-tagline{font-size:14px;font-weight:600;margin:14px 0 0}
    .store-bio{line-height:1.7;margin:6px 0 0}
    .store-policy-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:10px}
    .store-policy-grid p{line-height:1.6;margin-top:4px}
    @media(max-width:820px){.store-stats{grid-template-columns:repeat(2,1fr)}.store-policy-grid{grid-template-columns:1fr}.store-hero{height:160px}.store-name{font-size:20px}}
  </style>`;
};

App.storeCat = function (cat) { STORE_VIEW.cat = cat; render(); };
App.storeShare = async function (vendorId) {
  const url = location.origin + location.pathname + '#/store/' + vendorId;
  try {
    if (navigator.share) { await navigator.share({ title: 'WhaleChat store', url }); return; }
    await navigator.clipboard.writeText(url); toast('Store link copied', 'ok');
  } catch (e) { toast('Could not share this store', 'err'); }
};

/* ---------------- admin pages: sellers + activity ---------------- */
function ltDemoSellersView() {
  const st = LT.demoSellerStats();
  const cfg = st.cfg;
  const tabs = `<div class="admin-nav">${ADMIN_NAV.map(n => {
    const key = n.href.replace('#/admin', '') || '';
    return `<a href="${n.href}" class="${key === '/demo-sellers' ? 'on' : ''}">${n.label}</a>`;
  }).join('')}</div>`;
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  return `${tabs}
  <div class="page-head"><div class="between" style="align-items:flex-start;gap:12px;flex-wrap:wrap">
    <div><div class="section-title" style="margin:0">Demo sellers</div>
      <div class="tiny muted">Bot-run storefronts publishing 10–50 different electronics products each</div></div>
    <div class="row gap8">
      <a href="#/admin/demo-activity" class="btn btn-ghost">${ic('trend', 15)} Activity dashboard</a>
      <button class="btn btn-ghost" data-act="demo-sellers-publish">${ic('box', 15)} Republish</button>
      <button class="btn ${cfg.enabled ? 'btn-danger' : 'btn-primary'}" data-act="demo-sellers-toggle">
        ${ic(cfg.enabled ? 'pause' : 'play', 15)} ${cfg.enabled ? 'Turn off' : 'Turn on'}</button>
    </div>
  </div></div>

  <div class="card">
    <div class="between" style="align-items:center;flex-wrap:wrap;gap:10px">
      <div><div class="card-title" style="margin:0 0 4px">Status</div>
        <div class="small ${cfg.enabled ? 'up' : 'muted'}">${cfg.enabled
          ? 'Live — storefronts are visible in the marketplace'
          : 'Hidden — their listings are kept but not shown'}</div></div>
      <span class="badge ${cfg.enabled ? 'badge-success' : 'badge-warn'}">${cfg.enabled ? 'Live' : 'Off'}</span>
    </div>
    <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
      <span class="badge">${st.sellers.length} sellers</span>
      <span class="badge">${st.listings.length} listings</span>
      <span class="badge">${st.live.length} in stock</span>
      <span class="badge">${st.cats.length} categories</span>
      <span class="badge">${money(st.value)} stock value</span>
    </div>
    <div class="inv-note tiny" style="margin-top:12px">${ic('shield', 13)}
      <span>Demo sellers are marked <b>demo</b> on the account, vendor profile and every listing. Their accounts have no
      password and cannot be signed into; real buyers can still order their products. Use <b>Edit range</b> to change how
      many products a store publishes.</span></div>
  </div>

  <div class="card">
    <div class="card-title">Generate more products</div>
    <div class="tiny muted" style="line-height:1.7;margin-bottom:10px">
      Adds brand-new listings from the catalogue and distributes them across the chosen storefronts.
      <b>Existing products are never removed or replaced</b> — this only appends, and generated products
      survive republishing and range changes.
    </div>
    <div class="row wrap" style="gap:8px;align-items:flex-end">
      <div class="field grow" style="margin:0;min-width:170px"><label class="label">Storefront</label>
        <select class="input" id="dsGenSeller">
          <option value="all">All demo sellers (${st.sellers.length})</option>
          ${st.sellers.map(v => `<option value="${v.id}">${esc(v.name)} (${st.listings.filter(p => p.vendorId === v.id).length})</option>`).join('')}
        </select></div>
      <div class="field grow" style="margin:0;min-width:150px"><label class="label">Category</label>
        <select class="input" id="dsGenCat">
          <option value="All">Any category</option>
          ${((LT.demoCatalog && LT.demoCatalog.categories) || []).map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
        </select></div>
      <div class="field" style="margin:0;width:110px"><label class="label">How many</label>
        <input class="input" id="dsGenCount" type="number" min="1" max="50" step="1" value="6" inputmode="numeric"/></div>
      <button class="btn btn-primary" data-act="demo-generate-products">${ic('plus', 15)} Generate products</button>
    </div>
    <div class="row gap8 mt10" style="flex-wrap:wrap">
      <span class="badge">${(LT.demoCatalog && LT.demoCatalog.models ? LT.demoCatalog.models.length : 0)} catalogue models</span>
      <span class="badge">${st.listings.filter(p => p.generated).length} generated so far</span>
      <span class="badge">${st.live.length} live listings</span>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Storefronts</div>
    <div class="inv-list">
      ${st.sellers.length ? st.sellers.map(v => {
        const items = st.listings.filter(p => p.vendorId === v.id);
        const u = findUser(v.userId) || {};
        const cats = [...new Set(items.map(p => p.category))];
        return `<div class="inv-row" style="align-items:flex-start">
          <span class="avatar sm" style="overflow:hidden;flex:0 0 auto;width:44px;height:44px">
            ${v.avatar ? `<img src="${v.avatar}" alt="" style="width:100%;height:100%;object-fit:cover"/>` : ''}</span>
          <div class="grow" style="min-width:0">
            <div class="small" style="font-weight:700">${esc(v.name)} <span class="badge" style="font-size:9px">Demo</span></div>
            <div class="tiny muted">@${esc(v.username)} · ${esc(v.city)}, ${esc(v.country)} · owner ${esc(u.fullName || '')}</div>
            <div class="tiny muted ellipsis">${esc(cats.join(' · '))}</div>
            <div class="tiny muted" style="line-height:1.7">${esc(v.tagline || '')}</div>
            <div class="row gap6 mt8" style="flex-wrap:wrap">
              <a href="#/store/${v.id}" class="btn btn-xs btn-ghost">${ic('store', 12)} View store</a>
              <button class="btn btn-xs btn-ghost" data-act="demo-seller-edit" data-id="${v.id}">${ic('settings', 12)} Edit range</button>
            </div>
          </div>
          <div style="text-align:right;flex:0 0 auto">
            <div class="small" style="font-weight:700">${items.length} products</div>
            <div class="tiny muted">${items.filter(p => p.stock > 0).length} in stock</div>
            <div class="tiny muted">${cats.length} categories</div>
          </div>
        </div>`;
      }).join('') : `<div class="inv-empty">${ic('store', 26)}<p class="small muted">No demo storefronts yet — republish the catalogues.</p></div>`}
    </div>
  </div>

  <div class="card">
    <div class="card-title">How it works</div>
    <div class="tiny muted" style="line-height:1.8">
      Sellers and listings come from <b>public/demo-catalog.json</b>, generated by
      <b>scripts/generate-demo-catalog.mjs</b>. Product photos, banners and owner portraits are real renders shipped
      with the app (<b>public/demo/</b>). A range override is stored in the app settings, so it survives republishing;
      reset a store to return to its catalogue default. A catalogue version bump retires listings that were removed.
    </div>
  </div>`;
}

const _adminDemoSellers = VIEWS.admin;
VIEWS.admin = function (parts, params) {
  if ((parts[1] || '') === 'demo-sellers') {
    const u = me();
    if (!u || u.role !== 'admin') return `<div class="card empty"><div class="ic">${ic('lock', 26)}</div><h3>Admin access only</h3></div>`;
    try { LT.ensureDemoSellers(false); } catch (e) {}
    return ltDemoSellersView();
  }
  if ((parts[1] || '') === 'demo-activity') {
    const u = me();
    if (!u || u.role !== 'admin') return `<div class="card empty"><div class="ic">${ic('lock', 26)}</div><h3>Admin access only</h3></div>`;
    try { LT.ensureDemoSellers(false); } catch (e) {}
    return ltDemoActivityView();
  }
  return _adminDemoSellers.apply(this, arguments);
};
if (!ADMIN_NAV.some(n => n.key === 'admin-demo-sellers')) {
  ADMIN_NAV.splice(Math.max(0, ADMIN_NAV.length - 2), 0,
    { key: 'admin-demo-sellers', label: 'Demo sellers', icon: 'store', href: '#/admin/demo-sellers' });
}
if (!ADMIN_NAV.some(n => n.key === 'admin-demo-activity')) {
  ADMIN_NAV.splice(Math.max(0, ADMIN_NAV.length - 2), 0,
    { key: 'admin-demo-activity', label: 'Demo activity', icon: 'trend', href: '#/admin/demo-activity' });
}

/* seed once the app is up, then retry in the background until it lands */
(function seedDemoStorefronts() {
  try {
    if (!DB || !DB_READY) return setTimeout(seedDemoStorefronts, 1500);
    LT.ensureDemoSellers(false);
  } catch (e) { setTimeout(seedDemoStorefronts, 4000); }
})();
setInterval(() => { try { if (DB && DB_READY) LT.ensureDemoSellers(false); } catch (e) {} }, 90 * 1000);
