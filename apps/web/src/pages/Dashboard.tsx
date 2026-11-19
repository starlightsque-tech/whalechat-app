import { Link } from 'react-router-dom';
import { useStore } from 'zustand';
import { formatMoney, whalechatStore } from '@whalechat/shared';
import { useWallet } from '@whalechat/shared';
import { useWhalechatSync } from '@whalechat/shared';
import { PortfolioChart } from '../components/Charts';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card card-pad">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-bold">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Dashboard() {
  const profile = useStore(whalechatStore, (s) => s.profile);
  const conversations = useStore(whalechatStore, (s) => s.conversations);
  const orders = useStore(whalechatStore, (s) => s.orders);
  const trades = useStore(whalechatStore, (s) => s.trades);
  const products = useStore(whalechatStore, (s) => s.products);
  const { portfolio, availableMinor, pendingMinor } = useWallet();
  const { connection } = useWhalechatSync();

  const unread = conversations.reduce((sum, c) => sum + c.unreadCount, 0);
  const openOrders = orders.filter((o) => !['completed', 'cancelled', 'refunded', 'failed'].includes(o.status));
  const escrow = openOrders.reduce((sum, o) => sum + (o.escrow.held ? o.total.amountMinor : 0), 0);

  return (
    <div className="space-y-4">
      <section className="card card-pad flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <p className="text-sm text-slate-400">Welcome back</p>
          <h2 className="text-2xl font-bold">{profile?.displayName ?? 'Whalechat trader'}</h2>
          <p className="mt-1 text-xs text-slate-500">
            {connection.online ? 'Live data connected' : 'Offline mode — cached data, changes queue locally'}
            {pendingMinor > 0 ? ` · ${formatMoney({ amountMinor: pendingMinor, currency: 'USD' })} locked` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <Link className="btn-primary" to="/trade">Open market</Link>
          <Link className="btn-ghost" to="/chat">Messages {unread > 0 && `(${unread})`}</Link>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Portfolio value"
          value={portfolio ? formatMoney(portfolio.totalValue) : formatMoney({ amountMinor: availableMinor, currency: 'USD' })}
          hint={portfolio ? `${portfolio.positions.length} open positions` : 'Cash only'}
        />
        <Stat label="Available cash" value={formatMoney({ amountMinor: availableMinor, currency: 'USD' })} hint="After local holds" />
        <Stat label="Escrow held" value={formatMoney({ amountMinor: escrow, currency: 'USD' })} hint={`${openOrders.length} open orders`} />
        <Stat label="Synced changes" value={String(connection.pendingCount)} hint={connection.pendingCount ? 'Queued offline' : 'Outbox empty'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card card-pad lg:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">Portfolio performance</h3>
            <Link to="/wallet" className="text-xs text-mint">Wallet →</Link>
          </div>
          <PortfolioChart history={portfolio?.history ?? []} />
        </section>
        <section className="card card-pad">
          <h3 className="mb-3 font-semibold">Recent activity</h3>
          <ul className="space-y-2 text-sm">
            {trades.slice(0, 3).map((trade) => (
              <li key={trade.id} className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2">
                <span>
                  <span className={trade.side === 'buy' ? 'text-mint' : 'text-coral'}>
                    {trade.side.toUpperCase()}
                  </span>{' '}
                  {trade.symbol}
                </span>
                <span className="text-xs text-slate-400">{trade.status}</span>
              </li>
            ))}
            {trades.length === 0 && <li className="text-xs text-slate-500">No trades yet — start from the Trade tab.</li>}
            {orders.slice(0, 2).map((order) => (
              <li key={order.id} className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2">
                <span>Order {order.id.slice(0, 12)}</span>
                <span className="text-xs text-gold">{order.status}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
            <span>{products.length} products cached</span>
            <Link to="/shop" className="text-mint">Shop →</Link>
          </div>
        </section>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { to: '/trade', title: 'Live markets', body: 'Stocks, ETFs, crypto and FX with streaming charts.' },
          { to: '/shop', title: 'Escrow checkout', body: 'Cart is local-first; payment holds release after delivery.' },
          { to: '/admin', title: 'Admin console', body: 'Users, escrow, trades and audit in one place.' },
        ].map((card) => (
          <Link key={card.to} to={card.to} className="card card-pad transition hover:border-mint/40">
            <h4 className="font-semibold">{card.title}</h4>
            <p className="mt-1 text-xs text-slate-400">{card.body}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
