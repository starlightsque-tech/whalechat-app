import { useState } from 'react';
import { useStore } from 'zustand';
import { formatMoney, whalechatRuntime, whalechatStore, useWallet } from '@whalechat/shared';
import { PortfolioChart } from '../components/Charts';

export function WalletPage() {
  const { wallet, currency, balanceMinor, availableMinor, pendingMinor, ledger, portfolio, pendingSyncCount, transfer } = useWallet();
  const reservations = useStore(whalechatStore, (s) => s.reservations);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  async function submitTransfer(event: React.FormEvent) {
    event.preventDefault();
    setNotice(null);
    const minor = Math.round(Number(amount) * 100);
    if (!to.trim() || !Number.isFinite(minor) || minor <= 0) {
      setNotice('Enter a recipient and a positive amount.');
      return;
    }
    try {
      await transfer(to.trim(), minor, 'Whalechat transfer');
      setTo('');
      setAmount('');
      setNotice(pendingSyncCount + 1 > 0 ? 'Transfer queued — funds locked until it settles.' : 'Transfer sent.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Transfer failed');
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <section className="card card-pad">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Available balance</p>
              <p className="text-4xl font-bold">{formatMoney({ amountMinor: availableMinor, currency })}</p>
              <p className="mt-1 text-xs text-slate-500">
                Total {formatMoney({ amountMinor: balanceMinor, currency })} · {reservations.filter((r) => r.status === 'held').length} local holds
              </p>
            </div>
            <div className="flex gap-2 text-xs">
              <div className="rounded-xl bg-white/5 px-3 py-2">
                <p className="text-slate-500">Pending sync</p>
                <p className="mt-0.5 font-semibold text-gold">{formatMoney({ amountMinor: pendingMinor, currency })}</p>
              </div>
              <div className="rounded-xl bg-white/5 px-3 py-2">
                <p className="text-slate-500">Portfolio</p>
                <p className="mt-0.5 font-semibold text-mint">{portfolio ? formatMoney(portfolio.totalValue) : '—'}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="card card-pad">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">Portfolio performance</h3>
            <button className="text-xs text-mint" onClick={() => void whalechatRuntime.refreshWallet()}>Reconcile</button>
          </div>
          <PortfolioChart history={portfolio?.history ?? []} />
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(portfolio?.positions ?? []).map((position) => (
              <div key={position.symbol} className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2 text-xs">
                <span className="font-semibold">{position.symbol}</span>
                <span className="text-slate-400">×{position.quantity}</span>
                <span className={position.unrealizedPnlMinor >= 0 ? 'text-mint' : 'text-coral'}>
                  {position.unrealizedPnlMinor >= 0 ? '+' : ''}{formatMoney({ amountMinor: position.unrealizedPnlMinor, currency })}
                </span>
              </div>
            ))}
            {(!portfolio || portfolio.positions.length === 0) && <p className="text-xs text-slate-500">No positions yet.</p>}
          </div>
        </section>

        <section className="card card-pad">
          <h3 className="mb-3 font-semibold">Transactions</h3>
          <div className="max-h-[380px] overflow-auto scroll-thin">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-deep/95 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="py-2">Type</th><th>Description</th><th className="text-right">Amount</th><th className="text-right">Balance</th></tr>
              </thead>
              <tbody>
                {ledger.map((entry) => (
                  <tr key={entry.id} className="border-t border-white/5">
                    <td className="py-2 text-xs text-slate-400">{entry.type.replace('_', ' ')}</td>
                    <td className="max-w-[220px] truncate text-xs">{entry.description}</td>
                    <td className={`text-right text-xs font-semibold ${entry.type.includes('debit') || entry.type.includes('out') ? 'text-coral' : 'text-mint'}`}>
                      {formatMoney(entry.amount)}
                    </td>
                    <td className="text-right text-xs tabular-nums text-slate-400">{formatMoney({ amountMinor: entry.balanceAfterMinor, currency: entry.amount.currency })}</td>
                  </tr>
                ))}
                {ledger.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-xs text-slate-500">Ledger loads from cache, then server.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <aside className="space-y-4">
        <section className="card card-pad">
          <h3 className="mb-3 font-semibold">Send funds</h3>
          <form onSubmit={(e) => void submitTransfer(e)} className="space-y-3">
            <div>
              <label className="label">Recipient user id</label>
              <input className="input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="user_…" />
            </div>
            <div>
              <label className="label">Amount ({currency})</label>
              <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <button className="btn-primary w-full" type="submit">Send transfer</button>
            {notice && <p className="text-xs text-gold">{notice}</p>}
          </form>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            Transfers are financial operations: they are written to the outbox with an idempotency key,
            the amount is locked locally, and the server executes it at most once.
          </p>
        </section>

        <section className="card card-pad">
          <h3 className="mb-2 font-semibold">Wallets</h3>
          <ul className="space-y-2 text-sm">
            {Object.values(wallet?.balances ?? {}).map((amount, index) => {
              const code = Object.keys(wallet?.balances ?? {})[index] ?? currency;
              return (
                <li key={code} className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2">
                  <span className="font-semibold">{code}</span>
                  <span className="tabular-nums">{formatMoney({ amountMinor: amount, currency: code })}</span>
                </li>
              );
            })}
            {!wallet && <li className="text-xs text-slate-500">No wallet cached yet.</li>}
          </ul>
          <p className="mt-3 text-[11px] text-slate-500">Vault id {wallet?.id ?? '—'} · version {wallet?.version ?? 0}</p>
        </section>
      </aside>
    </div>
  );
}
