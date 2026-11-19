import { WhalechatError } from '../utils/errors.js';
import { uuidv4 } from '../utils/id.js';
const USER_ID = 'demo-user';
const START = Date.UTC(2026, 0, 2, 14, 30, 0);
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff;
    };
}
const ASSET_SEEDS = [
    { symbol: 'AAPL', name: 'Apple Inc.', sector: 'Technology', price: 232.14 },
    { symbol: 'MSFT', name: 'Microsoft Corp.', sector: 'Technology', price: 428.62 },
    { symbol: 'NVDA', name: 'NVIDIA Corp.', sector: 'Semiconductors', price: 138.91 },
    { symbol: 'TSLA', name: 'Tesla Inc.', sector: 'Automotive', price: 251.44 },
    { symbol: 'AMZN', name: 'Amazon.com Inc.', sector: 'Consumer', price: 186.33 },
    { symbol: 'GOOGL', name: 'Alphabet Inc.', sector: 'Technology', price: 176.12 },
    { symbol: 'META', name: 'Meta Platforms', sector: 'Technology', price: 585.2 },
    { symbol: 'JPM', name: 'JPMorgan Chase', sector: 'Financials', price: 243.7 },
    { symbol: 'V', name: 'Visa Inc.', sector: 'Financials', price: 312.4 },
    { symbol: 'KO', name: 'Coca-Cola Co.', sector: 'Consumer', price: 62.85 },
    { symbol: 'SPY', name: 'SPDR S&P 500 ETF', sector: 'Index', price: 598.1, assetClass: 'etf' },
    { symbol: 'QQQ', name: 'Invesco QQQ Trust', sector: 'Index', price: 512.66, assetClass: 'etf' },
    { symbol: 'BTC', name: 'Bitcoin', sector: 'Crypto', price: 96450.2, assetClass: 'crypto' },
    { symbol: 'ETH', name: 'Ethereum', sector: 'Crypto', price: 3380.5, assetClass: 'crypto' },
    { symbol: 'EURUSD', name: 'Euro / US Dollar', sector: 'FX', price: 1.0482, assetClass: 'fx' },
    { symbol: 'XAUUSD', name: 'Gold Spot', sector: 'Commodities', price: 2648.3, assetClass: 'commodity' },
];
const PRODUCT_SEEDS = [
    ['Noise-Cancelling Headphones', 'Audio', 12999, 'Over-ear ANC with 40h battery.', 42],
    ['Mechanical Keyboard 75%', 'Electronics', 8999, 'Hot-swap, walnut frame, RGB.', 31],
    ['Solar Power Station 600W', 'Home', 49900, 'LiFePO4, 1200W surge, MPPT.', 12],
    ['Crossbody Camera Sling', 'Bags', 6450, 'Water-resistant canvas, 9L.', 55],
    ['Espresso Grinder Pro', 'Kitchen', 18900, '64mm flat burrs, stepless.', 18],
    ['Trail Running Shoes', 'Apparel', 13400, 'Rock plate, 6mm drop.', 64],
    ['Smart Ring Gen 3', 'Wearables', 29900, 'Sleep, HRV and temperature.', 27],
    ['Portable Espresso Maker', 'Kitchen', 7500, '9-bar hand pump, 240g.', 39],
    ['Laptop Backpack 22L', 'Bags', 11800, 'Trolley sleeve, 16" laptop.', 48],
    ['Home Assistant Hub', 'Smart Home', 9900, 'Matter + Thread border router.', 22],
    ['Studio Monitor Pair', 'Audio', 34900, '5" nearfield, DSP room EQ.', 9],
    ['Folding Solar Panel 200W', 'Home', 27900, 'ETFE, 23% efficiency.', 15],
];
function buildCandles(price, seed, count = 180) {
    const random = rng(seed);
    const candles = [];
    let value = price * 0.94;
    for (let i = count - 1; i >= 0; i -= 1) {
        const time = Math.floor((START - i * 5 * 60_000) / 1000);
        const drift = (price - value) * 0.06;
        const open = value;
        const close = Math.max(0.01, open + drift + (random() - 0.5) * price * 0.008);
        const high = Math.max(open, close) * (1 + random() * 0.003);
        const low = Math.min(open, close) * (1 - random() * 0.003);
        candles.push({ time, open, high, low, close, volume: Math.round(random() * 1_000_000) });
        value = close;
    }
    return candles;
}
/**
 * Offline-capable demo backend.
 *
 * Implements the same contract as Appwrite, keeps server-side idempotency
 * records, and rejects mutations while `isOnline()` is false so the outbox
 * queue, retries and reconciliation can be exercised end-to-end.
 */
export function createDemoBackend(options = {}) {
    const now = options.now ?? Date.now;
    const latency = options.latencyMs ?? 140;
    let onlineProbe = options.isOnline ?? (() => true);
    const idempotency = new Map();
    const profiles = new Map();
    profiles.set(USER_ID, {
        id: USER_ID,
        displayName: 'Ava Chen',
        email: 'ava@whalechat.com',
        phone: '+14155550123',
        phoneVerified: true,
        avatarUrl: null,
        role: 'admin',
        status: 'active',
        createdAt: new Date(START).toISOString(),
        updatedAt: new Date(START).toISOString(),
    });
    const wallet = {
        id: 'wallet-demo',
        userId: USER_ID,
        balances: { USD: 25_000_00, WC: 12_500_00 },
        locked: {},
        version: 1,
        updatedAt: new Date(START).toISOString(),
    };
    const ledger = [
        {
            id: 'ledger-seed',
            userId: USER_ID,
            type: 'deposit',
            amount: { amountMinor: 25_000_00, currency: 'USD' },
            balanceAfterMinor: 25_000_00,
            referenceId: null,
            idempotencyKey: 'seed-deposit-0001',
            description: 'Opening balance',
            createdAt: new Date(START - 86_400_000).toISOString(),
        },
    ];
    const assets = ASSET_SEEDS.map((seed) => ({
        symbol: seed.symbol,
        name: seed.name,
        exchange: seed.assetClass === 'crypto' ? 'CRYPTO' : seed.assetClass === 'fx' ? 'FX' : 'NASDAQ',
        assetClass: seed.assetClass ?? 'equity',
        currency: 'USD',
        logoUrl: '',
        sector: seed.sector,
        active: true,
        updatedAt: new Date(START).toISOString(),
    }));
    const tags = ['new', 'trending', 'sale', 'eco', 'limited'];
    const products = PRODUCT_SEEDS.map(([title, category, price, description, stock], i) => ({
        id: `product-${i + 1}`,
        sellerId: 'seller-whale',
        title,
        description,
        price: { amountMinor: price, currency: 'USD' },
        compareAtPrice: i % 4 === 0 ? { amountMinor: Math.round(price * 1.18), currency: 'USD' } : null,
        imageUrl: '',
        category,
        stock,
        rating: Math.round((3.8 + (i % 12) / 10) * 10) / 10,
        tags: [tags[i % tags.length] ?? 'new', category.toLowerCase()],
        active: true,
        updatedAt: new Date(START).toISOString(),
    }));
    const basePrices = new Map(ASSET_SEEDS.map((a) => [a.symbol, a.price]));
    const quoteState = new Map();
    ASSET_SEEDS.forEach((seed, i) => {
        const previousClose = seed.price * (1 - ((i % 5) - 2) * 0.004);
        quoteState.set(seed.symbol, {
            symbol: seed.symbol,
            price: seed.price,
            previousClose,
            open: previousClose,
            high: Math.max(seed.price, previousClose) * 1.006,
            low: Math.min(seed.price, previousClose) * 0.994,
            change: seed.price - previousClose,
            changePercent: ((seed.price - previousClose) / previousClose) * 100,
            volume: 1_000_000 + i * 250_000,
            currency: 'USD',
            source: 'simulated',
            asOf: new Date(now()).toISOString(),
            updatedAt: new Date(now()).toISOString(),
        });
    });
    const conversations = [
        {
            id: 'conv-market',
            kind: 'group',
            title: 'Market Desk',
            participantIds: [USER_ID, 'bot-market'],
            lastMessagePreview: 'NVDA just broke the 140 level — watch the volume.',
            lastMessageAt: new Date(START - 5 * 60_000).toISOString(),
            unreadCount: 2,
            updatedAt: new Date(START - 5 * 60_000).toISOString(),
        },
        {
            id: 'conv-support',
            kind: 'support',
            title: 'Whalechat Support',
            participantIds: [USER_ID, 'bot-support'],
            lastMessagePreview: 'Your escrow order is protected until delivery.',
            lastMessageAt: new Date(START - 46 * 60_000).toISOString(),
            unreadCount: 0,
            updatedAt: new Date(START - 46 * 60_000).toISOString(),
        },
        {
            id: 'conv-seller',
            kind: 'direct',
            title: 'Nordvolt Electronics',
            participantIds: [USER_ID, 'bot-seller'],
            lastMessagePreview: 'The 600W station ships tomorrow.',
            lastMessageAt: new Date(START - 3 * 3_600_000).toISOString(),
            unreadCount: 1,
            updatedAt: new Date(START - 3 * 3_600_000).toISOString(),
        },
    ];
    const messages = new Map();
    const seedMessages = [
        ['conv-market', 'bot-market', 'Morning desk — US futures are green.', 120, 'read'],
        ['conv-market', 'demo-user', 'Taking a look at NVDA and BTC today.', 96, 'read'],
        ['conv-market', 'bot-market', 'NVDA just broke the 140 level — watch the volume.', 5, 'delivered'],
        ['conv-support', 'bot-support', 'Welcome to Whalechat. How can we help?', 240, 'read'],
        ['conv-support', 'demo-user', 'Is escrow automatic on checkout?', 200, 'read'],
        ['conv-support', 'bot-support', 'Your escrow order is protected until delivery.', 46, 'read'],
        ['conv-seller', 'bot-seller', 'The 600W station ships tomorrow.', 180, 'delivered'],
    ];
    for (const [conversationId, senderId, body, minutesAgo, status] of seedMessages) {
        const list = messages.get(conversationId) ?? [];
        list.push({
            id: uuidv4(),
            clientId: null,
            conversationId,
            senderId,
            body,
            attachments: [],
            status,
            createdAt: new Date(START - minutesAgo * 60_000).toISOString(),
            updatedAt: new Date(START - minutesAgo * 60_000).toISOString(),
            serverCreatedAt: new Date(START - minutesAgo * 60_000).toISOString(),
            readBy: status === 'read' ? [USER_ID, senderId] : [senderId],
            replyToId: null,
            deletedAt: null,
        });
        messages.set(conversationId, list);
    }
    const orders = [];
    const trades = [];
    function requireOnline() {
        if (!onlineProbe()) {
            throw new WhalechatError('Network unavailable — queued for sync', 'retryable', 'OFFLINE');
        }
    }
    function wait() {
        if (latency <= 0)
            return Promise.resolve();
        return new Promise((resolve) => setTimeout(resolve, latency));
    }
    function walletResult() {
        return {
            ...wallet,
            balances: { ...wallet.balances },
            locked: { ...wallet.locked },
            updatedAt: new Date(now()).toISOString(),
        };
    }
    function debit(currency, amountMinor, type, referenceId, key, description) {
        const code = currency.toUpperCase();
        const current = wallet.balances[code] ?? 0;
        if (current < amountMinor)
            throw new WhalechatError('Insufficient funds', 'permanent', 'INSUFFICIENT_FUNDS');
        wallet.balances[code] = current - amountMinor;
        wallet.version += 1;
        wallet.updatedAt = new Date(now()).toISOString();
        ledger.unshift({
            id: uuidv4(),
            userId: USER_ID,
            type,
            amount: { amountMinor, currency: code },
            balanceAfterMinor: wallet.balances[code] ?? 0,
            referenceId,
            idempotencyKey: key,
            description,
            createdAt: new Date(now()).toISOString(),
        });
    }
    function credit(currency, amountMinor, type, referenceId, key, description) {
        const code = currency.toUpperCase();
        wallet.balances[code] = (wallet.balances[code] ?? 0) + amountMinor;
        wallet.version += 1;
        wallet.updatedAt = new Date(now()).toISOString();
        ledger.unshift({
            id: uuidv4(),
            userId: USER_ID,
            type,
            amount: { amountMinor, currency: code },
            balanceAfterMinor: wallet.balances[code] ?? 0,
            referenceId,
            idempotencyKey: key,
            description,
            createdAt: new Date(now()).toISOString(),
        });
    }
    const backend = {
        mode: 'demo',
        setOnlineProbe(fn) {
            onlineProbe = fn;
        },
        auth: {
            async getProfile() {
                await wait();
                return profiles.get(USER_ID);
            },
            async updateProfile(patch) {
                requireOnline();
                await wait();
                const current = profiles.get(USER_ID);
                const next = { ...current, ...patch, updatedAt: new Date(now()).toISOString() };
                profiles.set(USER_ID, next);
                return next;
            },
        },
        chat: {
            async listConversations() {
                await wait();
                return [...conversations].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
            },
            async listMessages(conversationId) {
                await wait();
                const items = messages.get(conversationId) ?? [];
                return { items, nextCursor: null, hasMore: false };
            },
            async sendMessage(input, meta) {
                requireOnline();
                await wait();
                const replay = idempotency.get(meta.idempotencyKey);
                if (replay)
                    return replay;
                const created = new Date(now()).toISOString();
                const message = {
                    id: uuidv4(),
                    clientId: null,
                    conversationId: input.conversationId,
                    senderId: USER_ID,
                    body: input.body,
                    attachments: input.attachments,
                    status: 'sent',
                    createdAt: created,
                    updatedAt: created,
                    serverCreatedAt: created,
                    readBy: [USER_ID],
                    replyToId: input.replyToId,
                    deletedAt: null,
                };
                const list = messages.get(input.conversationId) ?? [];
                messages.set(input.conversationId, [...list, message]);
                const conv = conversations.find((c) => c.id === input.conversationId);
                if (conv) {
                    conv.lastMessagePreview = input.body.slice(0, 120);
                    conv.lastMessageAt = created;
                    conv.updatedAt = created;
                }
                idempotency.set(meta.idempotencyKey, message);
                return message;
            },
            async markRead(_conversationId, _messageId, _meta) {
                requireOnline();
                return { ok: true };
            },
        },
        shop: {
            async listProducts() {
                await wait();
                return products;
            },
            async listOrders() {
                await wait();
                return orders;
            },
            async placeOrder(input, meta) {
                requireOnline();
                await wait();
                const replay = idempotency.get(meta.idempotencyKey);
                if (replay)
                    return replay;
                const currency = input.currency.toUpperCase();
                const subtotalMinor = input.items.reduce((sum, item) => sum + item.unitPrice.amountMinor * item.quantity, 0);
                const totalMinor = subtotalMinor + input.shippingMinor;
                const nowIso = new Date(now()).toISOString();
                const order = {
                    id: `order_${uuidv4().slice(0, 8)}`,
                    userId: USER_ID,
                    items: input.items.map((item) => ({
                        productId: item.productId,
                        title: item.title,
                        unitPrice: item.unitPrice,
                        quantity: item.quantity,
                    })),
                    subtotal: { amountMinor: subtotalMinor, currency },
                    shipping: { amountMinor: input.shippingMinor, currency },
                    total: { amountMinor: totalMinor, currency },
                    status: 'paid_escrow',
                    escrow: {
                        held: true,
                        releasedAt: null,
                        releaseAfter: new Date(now() + 7 * 86_400_000).toISOString(),
                    },
                    placedAt: nowIso,
                    updatedAt: nowIso,
                    idempotencyKey: meta.idempotencyKey,
                };
                debit(currency, totalMinor, 'order_debit', order.id, meta.idempotencyKey, `Order ${order.id} (escrow)`);
                orders.unshift(order);
                idempotency.set(meta.idempotencyKey, order);
                return order;
            },
        },
        trade: {
            async listAssets() {
                await wait();
                return assets;
            },
            async getQuotes(symbols) {
                await wait();
                return symbols.map((symbol) => quoteState.get(symbol.toUpperCase())).filter((q) => Boolean(q));
            },
            async getCandles(symbol, range = '1D') {
                await wait();
                const seed = ASSET_SEEDS.findIndex((a) => a.symbol === symbol.toUpperCase());
                const price = quoteState.get(symbol.toUpperCase())?.price ?? 100;
                const count = range === '1D' ? 180 : range === '1W' ? 240 : range === '1M' ? 300 : 360;
                return buildCandles(price, (seed + 1) * 7919, count);
            },
            async listTrades() {
                await wait();
                return trades;
            },
            async getPortfolio() {
                await wait();
                const positions = [...trades.reduce((map, trade) => {
                        if (trade.status !== 'filled')
                            return map;
                        const current = map.get(trade.symbol) ?? { quantity: 0, cost: 0 };
                        const sign = trade.side === 'buy' ? 1 : -1;
                        const qty = current.quantity + sign * trade.quantity;
                        const cost = current.cost + sign * trade.quantity * (trade.filledPrice ?? 0);
                        map.set(trade.symbol, { quantity: qty, cost });
                        return map;
                    }, new Map())]
                    .filter(([, pos]) => Math.abs(pos.quantity) > 1e-8)
                    .map(([symbol, pos]) => {
                    const marketPrice = quoteState.get(symbol)?.price ?? 0;
                    const averagePrice = pos.cost / pos.quantity;
                    return {
                        symbol,
                        quantity: pos.quantity,
                        averagePrice,
                        marketPrice,
                        marketValueMinor: Math.round(pos.quantity * marketPrice * 100),
                        unrealizedPnlMinor: Math.round((marketPrice - averagePrice) * pos.quantity * 100),
                        updatedAt: new Date(now()).toISOString(),
                    };
                });
                const positionsValue = positions.reduce((sum, p) => sum + p.marketValueMinor, 0);
                const cashMinor = wallet.balances.USD ?? 0;
                const history = Array.from({ length: 60 }, (_, i) => {
                    const random = rng(1000 + i);
                    return {
                        time: Math.floor((now() - (59 - i) * 3_600_000) / 1000),
                        valueMinor: Math.round((cashMinor + positionsValue) * (0.96 + random() * 0.08)),
                    };
                });
                return {
                    userId: USER_ID,
                    cash: { amountMinor: cashMinor, currency: 'USD' },
                    positions,
                    totalValue: { amountMinor: cashMinor + positionsValue, currency: 'USD' },
                    totalPnl: { amountMinor: positions.reduce((sum, p) => sum + p.unrealizedPnlMinor, 0), currency: 'USD' },
                    history,
                    updatedAt: new Date(now()).toISOString(),
                };
            },
            async placeTrade(input, meta) {
                requireOnline();
                await wait();
                const replay = idempotency.get(meta.idempotencyKey);
                if (replay)
                    return replay;
                const symbol = input.symbol.toUpperCase();
                const quote = quoteState.get(symbol);
                if (!quote)
                    throw new WhalechatError(`Unknown symbol ${symbol}`, 'permanent', 'UNKNOWN_SYMBOL');
                const executionPrice = input.limitPrice ?? meta.offlineExecutionPrice ?? quote.price;
                const notionalMinor = Math.round(input.quantity * executionPrice * 100);
                const feesMinor = Math.max(1, Math.round(notionalMinor * 0.0005));
                const nowIso = new Date(now()).toISOString();
                if (input.side === 'buy') {
                    debit(input.currency, notionalMinor + feesMinor, 'trade_debit', symbol, meta.idempotencyKey, `Bought ${input.quantity} ${symbol}`);
                }
                else {
                    credit(input.currency, notionalMinor - feesMinor, 'trade_credit', symbol, meta.idempotencyKey, `Sold ${input.quantity} ${symbol}`);
                }
                const trade = {
                    id: `trade_${uuidv4().slice(0, 8)}`,
                    userId: USER_ID,
                    symbol,
                    side: input.side,
                    quantity: input.quantity,
                    limitPrice: input.limitPrice,
                    filledPrice: executionPrice,
                    status: 'filled',
                    fees: { amountMinor: feesMinor, currency: input.currency },
                    notional: { amountMinor: notionalMinor, currency: input.currency },
                    idempotencyKey: meta.idempotencyKey,
                    offlineExecutionPrice: meta.offlineExecutionPrice ?? null,
                    createdAt: nowIso,
                    updatedAt: nowIso,
                };
                trades.unshift(trade);
                idempotency.set(meta.idempotencyKey, trade);
                return trade;
            },
        },
        wallet: {
            async getWallet() {
                await wait();
                return walletResult();
            },
            async listLedger() {
                await wait();
                return { items: ledger, nextCursor: null, hasMore: false };
            },
            async transfer(input, meta) {
                requireOnline();
                await wait();
                const replay = idempotency.get(meta.idempotencyKey);
                if (replay)
                    return replay;
                debit(input.currency, input.amountMinor, 'transfer_out', input.toUserId, meta.idempotencyKey, input.note || 'Wallet transfer');
                const result = { ok: true, message: `Sent to ${input.toUserId}` };
                idempotency.set(meta.idempotencyKey, result);
                return result;
            },
        },
        admin: {
            async overview() {
                await wait();
                return {
                    users: 1_284,
                    activeUsers24h: 412,
                    orders: orders.length + 318,
                    escrowHeldMinor: orders.reduce((sum, o) => sum + (o.escrow.held ? o.total.amountMinor : 0), 0),
                    trades24h: trades.length + 96,
                    volume24hMinor: 4_820_000_00,
                    openTickets: 7,
                    updatedAt: new Date(now()).toISOString(),
                };
            },
            async listUsers() {
                await wait();
                return [...profiles.values()];
            },
            async act(_action, _meta) {
                requireOnline();
                await wait();
                return { ok: true, message: 'Applied in demo mode' };
            },
            async audit() {
                return [];
            },
        },
        realtime: {
            subscribeQuotes(symbols, onQuote) {
                const tick = () => {
                    const t = now();
                    for (const symbol of symbols) {
                        const current = quoteState.get(symbol.toUpperCase());
                        if (!current)
                            continue;
                        const base = basePrices.get(symbol.toUpperCase()) ?? current.price;
                        const wave = Math.sin(t / 45_000 + symbol.length) * 0.0035;
                        const noise = (Math.random() - 0.5) * 0.0018;
                        const price = Math.max(0.01, Number((current.price + base * (wave * 0.05 + noise)).toFixed(4)));
                        const previousClose = current.previousClose;
                        const next = {
                            ...current,
                            price,
                            high: Math.max(current.high, price),
                            low: Math.min(current.low, price),
                            change: price - previousClose,
                            changePercent: ((price - previousClose) / previousClose) * 100,
                            asOf: new Date(t).toISOString(),
                            updatedAt: new Date(t).toISOString(),
                        };
                        quoteState.set(symbol.toUpperCase(), next);
                        onQuote(next);
                    }
                };
                const timer = setInterval(tick, 2_000);
                tick();
                return () => clearInterval(timer);
            },
            subscribeMessages(conversationId, onMessage) {
                let cancelled = false;
                let count = 0;
                const replies = [
                    'Got it — synced to the desk.',
                    'Copy that. I will confirm once the order fills.',
                    'Nice entry. Watching the 20-day average.',
                ];
                const timer = setInterval(() => {
                    if (cancelled)
                        return;
                    const conversation = conversations.find((c) => c.id === conversationId);
                    if (!conversation || conversation.kind === 'support')
                        return;
                    const created = new Date(now()).toISOString();
                    const message = {
                        id: uuidv4(),
                        clientId: null,
                        conversationId,
                        senderId: conversation.participantIds.find((p) => p !== USER_ID) ?? 'bot-market',
                        body: replies[count % replies.length] ?? replies[0],
                        attachments: [],
                        status: 'delivered',
                        createdAt: created,
                        updatedAt: created,
                        serverCreatedAt: created,
                        readBy: [],
                        replyToId: null,
                        deletedAt: null,
                    };
                    count += 1;
                    const list = messages.get(conversationId) ?? [];
                    messages.set(conversationId, [...list, message]);
                    onMessage(message);
                }, 25_000);
                return () => {
                    cancelled = true;
                    clearInterval(timer);
                };
            },
        },
    };
    return backend;
}
//# sourceMappingURL=backend.js.map