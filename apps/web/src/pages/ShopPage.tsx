import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { formatMoney, whalechatRuntime, whalechatStore, useWallet } from '@whalechat/shared';
import type { Product } from '@whalechat/shared';

const STATUS_TONE: Record<string, string> = {
  paid_escrow: 'bg-gold/15 text-gold',
  pending_sync: 'bg-sky-400/15 text-sky-300',
  processing: 'bg-sky-400/15 text-sky-300',
  shipped: 'bg-indigo-400/15 text-indigo-300',
  delivered: 'bg-mint/15 text-mint',
  completed: 'bg-mint/15 text-mint',
  failed: 'bg-coral/15 text-coral',
  cancelled: 'bg-white/10 text-slate-400',
};

function ProductCard({ product }: { product: Product }) {
  return (
    <div className="card overflow-hidden">
      <div className="grid h-28 place-items-center bg-gradient-to-br from-tide/80 to-abyss text-3xl">
        {product.imageUrl ? <img src={product.imageUrl} alt="" className="h-full w-full object-cover" /> : '🛍'}
      </div>
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-semibold leading-tight">{product.title}</h4>
          {product.compareAtPrice && (
            <span className="pill bg-coral/15 text-coral">-{Math.round((1 - product.price.amountMinor / product.compareAtPrice.amountMinor) * 100)}%</span>
          )}
        </div>
        <p className="mt-1 line-clamp-2 text-xs text-slate-500">{product.description}</p>
        <div className="mt-2 flex items-center justify-between">
          <div>
            <div className="font-bold">{formatMoney(product.price)}</div>
            <div className="text-[10px] text-slate-500">{product.stock} in stock · ★ {product.rating.toFixed(1)}</div>
          </div>
          <button
            className="btn-primary px-3 py-1.5 text-xs"
            onClick={() => whalechatRuntime.addToCart(product)}
            disabled={product.stock <= 0}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

export function ShopPage() {
  const products = useStore(whalechatStore, (s) => s.products);
  const cart = useStore(whalechatStore, (s) => s.cart);
  const orders = useStore(whalechatStore, (s) => s.orders);
  const [category, setCategory] = useState('All');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { availableMinor } = useWallet();

  const categories = useMemo(() => ['All', ...new Set(products.map((p) => p.category))], [products]);
  const visible = category === 'All' ? products : products.filter((p) => p.category === category);
  const totals = whalechatRuntime.cartTotals();

  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      const order = await whalechatRuntime.checkout();
      setError(null);
      if (order.status === 'pending_sync') {
        setError('Offline: order queued and funds locked. It will be placed automatically on reconnect.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <section className="card card-pad">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-xl font-bold">Marketplace</h2>
              <p className="text-xs text-slate-400">Escrow-protected orders · catalog cached for offline browsing</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {categories.map((item) => (
                <button
                  key={item}
                  onClick={() => setCategory(item)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${category === item ? 'bg-mint text-abyss' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
        </section>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((product) => <ProductCard key={product.id} product={product} />)}
          {visible.length === 0 && <p className="text-xs text-slate-500">No products cached. Connect once to hydrate the catalog.</p>}
        </div>

        {orders.length > 0 && (
          <section className="card card-pad">
            <h3 className="mb-2 font-semibold">Your orders</h3>
            <ul className="space-y-2">
              {orders.map((order) => (
                <li key={order.id} className="rounded-xl bg-white/5 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">{order.id.slice(0, 16)}</span>
                    <span className={`pill ${STATUS_TONE[order.status] ?? 'bg-white/10 text-slate-400'}`}>{order.status.replace('_', ' ')}</span>
                    <span className="font-bold">{formatMoney(order.total)}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {order.items.reduce((n, i) => n + i.quantity, 0)} items · escrow {order.escrow.held ? 'held' : 'released'}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <aside className="space-y-4">
        <section className="card card-pad">
          <h3 className="mb-2 font-semibold">Cart <span className="text-xs font-normal text-slate-500">({cart.length})</span></h3>
          <ul className="space-y-2">
            {cart.map((item) => (
              <li key={item.productId} className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-2 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{item.title}</p>
                  <p className="text-xs text-slate-500">{formatMoney(item.unitPrice)}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button className="h-6 w-6 rounded bg-white/10" onClick={() => whalechatRuntime.updateCartQuantity(item.productId, item.quantity - 1)}>−</button>
                  <span className="w-6 text-center text-xs tabular-nums">{item.quantity}</span>
                  <button className="h-6 w-6 rounded bg-white/10" onClick={() => whalechatRuntime.updateCartQuantity(item.productId, item.quantity + 1)}>+</button>
                  <button className="ml-1 text-xs text-coral" onClick={() => whalechatRuntime.removeFromCart(item.productId)}>×</button>
                </div>
              </li>
            ))}
            {cart.length === 0 && <li className="py-4 text-center text-xs text-slate-500">Cart is empty.</li>}
          </ul>

          <div className="mt-3 space-y-1 border-t border-white/10 pt-3 text-xs">
            <div className="flex justify-between text-slate-400"><span>Subtotal</span><span>{formatMoney({ amountMinor: totals.subtotalMinor, currency: totals.currency })}</span></div>
            <div className="flex justify-between text-slate-400"><span>Shipping</span><span>{formatMoney({ amountMinor: totals.shippingMinor, currency: totals.currency })}</span></div>
            <div className="flex justify-between text-sm font-bold"><span>Total</span><span>{formatMoney({ amountMinor: totals.totalMinor, currency: totals.currency })}</span></div>
            <div className="flex justify-between text-slate-500"><span>Available</span><span>{formatMoney({ amountMinor: availableMinor, currency: totals.currency })}</span></div>
          </div>
          <button className="btn-primary mt-3 w-full" disabled={cart.length === 0 || busy} onClick={() => void checkout()}>
            {busy ? 'Placing order…' : 'Checkout with escrow'}
          </button>
          {error && <p className="mt-2 text-xs text-gold">{error}</p>}
        </section>

        <section className="card card-pad text-xs text-slate-400">
          <h4 className="mb-1 font-semibold text-slate-200">How escrow works</h4>
          <p>Payment is held by Whalechat until delivery. Each checkout carries a UUID idempotency key, so a dropped connection cannot charge twice.</p>
        </section>
      </aside>
    </div>
  );
}
