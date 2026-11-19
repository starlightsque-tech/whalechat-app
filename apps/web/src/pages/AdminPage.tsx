import { useEffect, useState } from 'react';
import {
  formatMoney,
  whalechatRuntime,
  whalechatStore,
  type AdminOverview,
  type UserProfile,
} from '@whalechat/shared';
import { useStore } from 'zustand';

export function AdminPage() {
  const overview = useStore(whalechatStore, (s) => s.adminOverview);
  const orders = useStore(whalechatStore, (s) => s.orders);
  const trades = useStore(whalechatStore, (s) => s.trades);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [list, stats] = await Promise.all([whalechatRuntime.adminUsers(), whalechatRuntime.adminOverview()]);
      setUsers(list);
      whalechatStore.getState().setAdmin(stats as AdminOverview);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Admin APIs need an authenticated admin session.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(action: Parameters<typeof whalechatRuntime.adminAction>[0]) {
    try {
      await whalechatRuntime.adminAction(action);
      setMessage('Action queued. Admins are verified server-side before it executes.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Action failed');
    }
  }

  return (
    <div className="space-y-4">
      <section className="card card-pad flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold">Admin console</h2>
          <p className="text-xs text-slate-400">Full control: users, escrow, trades, wallets and audit.</p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </section>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Users', overview?.users ?? users.length],
          ['Active 24h', overview?.activeUsers24h ?? '—'],
          ['Orders', overview?.orders ?? orders.length],
          ['Trades 24h', overview?.trades24h ?? trades.length],
          ['Escrow', overview ? formatMoney({ amountMinor: overview.escrowHeldMinor, currency: 'USD' }) : '—'],
          ['Tickets', overview?.openTickets ?? '—'],
        ].map(([label, value]) => (
          <div key={String(label)} className="card card-pad">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 truncate text-lg font-bold">{value}</p>
          </div>
        ))}
      </div>

      {message && <p className="rounded-xl border border-gold/30 bg-gold/10 px-3 py-2 text-xs text-gold">{message}</p>}

      <section className="card card-pad">
        <h3 className="mb-3 font-semibold">Users</h3>
        <div className="overflow-auto scroll-thin">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="py-2">User</th><th>Role</th><th>Status</th><th>Phone</th><th className="text-right">Actions</th></tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t border-white/5">
                  <td className="py-2">
                    <div className="font-medium">{user.displayName}</div>
                    <div className="text-xs text-slate-500">{user.email}</div>
                  </td>
                  <td className="text-xs">{user.role}</td>
                  <td>
                    <span className={`pill ${user.status === 'active' ? 'bg-mint/15 text-mint' : 'bg-coral/15 text-coral'}`}>{user.status}</span>
                  </td>
                  <td className="text-xs">{user.phoneVerified ? '✓ verified' : user.phone ?? '—'}</td>
                  <td className="space-x-1 text-right">
                    {user.status === 'active' ? (
                      <button className="rounded-lg bg-coral/15 px-2 py-1 text-[11px] text-coral" onClick={() => void act({ type: 'suspend', userId: user.id, reason: 'admin console' })}>Suspend</button>
                    ) : (
                      <button className="rounded-lg bg-mint/15 px-2 py-1 text-[11px] text-mint" onClick={() => void act({ type: 'reinstate', userId: user.id })}>Reinstate</button>
                    )}
                  </td>
                </tr>
              ))}
              {users.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-xs text-slate-500">No admin session or users cached.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card card-pad">
          <h3 className="mb-2 font-semibold">Latest orders</h3>
          <ul className="space-y-2 text-xs">
            {orders.slice(0, 6).map((order) => (
              <li key={order.id} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
                <span>{order.id.slice(0, 14)}</span>
                <span className="text-slate-400">{formatMoney(order.total)}</span>
                <span className="text-gold">{order.status}</span>
              </li>
            ))}
            {orders.length === 0 && <li className="text-slate-500">No orders.</li>}
          </ul>
        </section>
        <section className="card card-pad">
          <h3 className="mb-2 font-semibold">Latest trades</h3>
          <ul className="space-y-2 text-xs">
            {trades.slice(0, 6).map((trade) => (
              <li key={trade.id} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
                <span className="font-semibold">{trade.symbol}</span>
                <span className={trade.side === 'buy' ? 'text-mint' : 'text-coral'}>{trade.side}</span>
                <span>{formatMoney(trade.notional)}</span>
                <span className="text-slate-400">{trade.status}</span>
              </li>
            ))}
            {trades.length === 0 && <li className="text-slate-500">No trades.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
