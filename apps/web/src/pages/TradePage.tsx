import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import {
  formatMoney,
  whalechatRuntime,
  whalechatStore,
  useWhalechatSync,
  useWallet,
} from '@whalechat/shared';
import { PriceChart, PortfolioChart, Sparkline } from '../components/Charts';

export function TradePage() {
  const assets = useStore(whalechatStore, (s) => s.assets);
  const quotes = useStore(whalechatStore, (s) => s.quotes);
  const candles = useStore(whalechatStore, (s) => s.candles);
  const portfolio = useStore(whalechatStore, (s) => s.portfolio);
  const [selected, setSelected] = useState<string>('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [quantity, setQuantity] = useState('1');
  const [limit, setLimit] = useState('');
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { availableMinor, wallet } = useWallet();
  const { online } = useWhalechatSync();

  useEffect(() => {
    if (!selected && assets[0]) setSelected(assets[0].symbol);
  }, [assets, selected]);

  useEffect(() => {
    if (!selected) return;
    void whalechatRuntime.loadCandles(selected);
    void whalechatRuntime.loadQuotes(assets.map((a) => a.symbol));
  }, [selected, assets]);

  const quote = selected ? quotes[selected] : undefined;
  const list = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return assets;
    return assets.filter(
      (asset) => asset.symbol.toLowerCase().includes(needle) || asset.name.toLowerCase().includes(needle),
    );
  }, [assets, filter]);

  const chartCandles = selected ? candles[selected] ?? [] : [];
  const positive = (quote?.change ?? 0) >= 0;

  async function submitTrade() {
    if (!selected) return;
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      setNotice({ kind: 'error', text: 'Enter a quantity greater than zero.' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const trade = await whalechatRuntime.placeTrade({
        symbol: selected,
        side,
        quantity: qty,
        limitPrice: limit ? Number(limit) : null,
        currency: 'USD',
      });
      setNotice({
        kind: 'ok',
        text: online
          ? `${side === 'buy' ? 'Bought' : 'Sold'} ${qty} ${selected} @ ${formatMoney({ amountMinor: Math.round((trade.filledPrice ?? quote?.price ?? 0) * 100), currency: 'USD' })}`
          : `Queued offline: ${side} ${qty} ${selected}. Funds are locked until sync.`,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Trade failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
      <div className="space-y-4">
        <section className="card card-pad">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-2xl font-bold">{selected || 'Markets'}</h2>
                {quote && (
                  <span className="pill bg-white/10 text-slate-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-mint live-dot" />
                    {quote.source}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400">
                {assets.find((a) => a.symbol === selected)?.name ?? 'Select a symbol'}
              </p>
            </div>
            {quote && (
              <div className="text-right">
                <div className="text-3xl font-bold tabular-nums">{formatMoney({ amountMinor: Math.round(quote.price * 100), currency: quote.currency })}</div>
                <div className={`text-sm font-semibold ${positive ? 'text-mint' : 'text-coral'}`}>
                  {positive ? '+' : ''}{quote.change.toFixed(2)} ({positive ? '+' : ''}{quote.changePercent.toFixed(2)}%)
                </div>
              </div>
            )}
          </div>
          <div className="mt-3 h-[260px] rounded-xl border border-white/5 bg-abyss/40 p-2">
            <PriceChart candles={chartCandles} positive={positive} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400 sm:grid-cols-4">
            <div>Open <span className="ml-1 text-slate-200">{quote ? formatMoney({ amountMinor: Math.round(quote.open * 100), currency: quote.currency }) : '—'}</span></div>
            <div>High <span className="ml-1 text-slate-200">{quote ? formatMoney({ amountMinor: Math.round(quote.high * 100), currency: quote.currency }) : '—'}</span></div>
            <div>Low <span className="ml-1 text-slate-200">{quote ? formatMoney({ amountMinor: Math.round(quote.low * 100), currency: quote.currency }) : '—'}</span></div>
            <div>Volume <span className="ml-1 text-slate-200">{quote ? Intl.NumberFormat('en', { notation: 'compact' }).format(quote.volume) : '—'}</span></div>
          </div>
        </section>

        <section className="card card-pad">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-semibold">All markets</h3>
            <input className="input max-w-[220px]" placeholder="Search symbol or name" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="max-h-[420px] overflow-auto scroll-thin">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-deep/95 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2">Symbol</th>
                  <th>Price</th>
                  <th>24h</th>
                  <th className="hidden sm:table-cell">Trend</th>
                </tr>
              </thead>
              <tbody>
                {list.map((asset) => {
                  const q = quotes[asset.symbol];
                  const up = (q?.change ?? 0) >= 0;
                  const closes = (candles[asset.symbol] ?? []).slice(-30).map((c) => c.close);
                  return (
                    <tr
                      key={asset.symbol}
                      onClick={() => setSelected(asset.symbol)}
                      className={`cursor-pointer border-t border-white/5 transition hover:bg-white/5 ${selected === asset.symbol ? 'bg-white/5' : ''}`}
                    >
                      <td className="py-2">
                        <div className="font-semibold">{asset.symbol}</div>
                        <div className="max-w-[180px] truncate text-xs text-slate-500">{asset.name}</div>
                      </td>
                      <td className="tabular-nums">{q ? formatMoney({ amountMinor: Math.round(q.price * 100), currency: q.currency }) : '—'}</td>
                      <td className={`tabular-nums ${up ? 'text-mint' : 'text-coral'}`}>
                        {q ? `${up ? '+' : ''}${q.changePercent.toFixed(2)}%` : '—'}
                      </td>
                      <td className="hidden sm:table-cell">
                        <Sparkline values={closes.length > 1 ? closes : [0, 0]} positive={up} />
                      </td>
                    </tr>
                  );
                })}
                {list.length === 0 && (
                  <tr><td colSpan={4} className="py-6 text-center text-xs text-slate-500">No instruments cached yet. Connect once to load the market list.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="space-y-4">
        <section className="card card-pad">
          <div className="mb-3 grid grid-cols-2 gap-2">
            <button className={`btn ${side === 'buy' ? 'bg-mint text-abyss' : 'bg-white/5 text-slate-300'}`} onClick={() => setSide('buy')}>Buy</button>
            <button className={`btn ${side === 'sell' ? 'bg-coral text-white' : 'bg-white/5 text-slate-300'}`} onClick={() => setSide('sell')}>Sell</button>
          </div>
          <label className="label">Quantity</label>
          <input className="input" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          <label className="label mt-3">Limit price (optional)</label>
          <input className="input" inputMode="decimal" placeholder={quote ? quote.price.toFixed(2) : 'Market'} value={limit} onChange={(e) => setLimit(e.target.value)} />
          <div className="mt-3 rounded-xl bg-white/5 p-3 text-xs text-slate-400">
            <div className="flex justify-between"><span>Available</span><span className="text-slate-200">{formatMoney({ amountMinor: availableMinor, currency: 'USD' })}</span></div>
            <div className="mt-1 flex justify-between"><span>Estimated total</span><span className="text-slate-200">{formatMoney({ amountMinor: Math.round((Number(quantity) || 0) * (Number(limit) || quote?.price || 0) * 100), currency: 'USD' })}</span></div>
            <div className="mt-1 flex justify-between"><span>Wallet</span><span className="text-slate-200">{wallet ? wallet.id.slice(0, 12) : 'offline cache'}</span></div>
          </div>
          {!online && <p className="mt-2 text-xs text-gold">Offline: the order is queued with an idempotency key and funds are locked locally.</p>}
          <button className="btn-primary mt-3 w-full" disabled={busy || !quote} onClick={() => void submitTrade()}>
            {busy ? 'Submitting…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${selected || 'asset'}`}
          </button>
          {notice && (
            <p className={`mt-2 rounded-lg px-3 py-2 text-xs ${notice.kind === 'ok' ? 'bg-mint/10 text-mint' : 'bg-coral/10 text-coral'}`}>
              {notice.text}
            </p>
          )}
        </section>

        <section className="card card-pad">
          <h3 className="mb-2 font-semibold">Portfolio</h3>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-2xl font-bold">{portfolio ? formatMoney(portfolio.totalValue) : formatMoney({ amountMinor: availableMinor, currency: 'USD' })}</span>
            {portfolio && (
              <span className={`text-xs font-semibold ${portfolio.totalPnl.amountMinor >= 0 ? 'text-mint' : 'text-coral'}`}>
                {portfolio.totalPnl.amountMinor >= 0 ? '+' : ''}{formatMoney(portfolio.totalPnl)}
              </span>
            )}
          </div>
          <PortfolioChart history={portfolio?.history ?? []} />
          <ul className="mt-2 space-y-1 text-xs">
            {(portfolio?.positions ?? []).map((position) => (
              <li key={position.symbol} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
                <span className="font-semibold">{position.symbol}</span>
                <span className="text-slate-400">{position.quantity} @ {position.averagePrice.toFixed(2)}</span>
                <span className={position.unrealizedPnlMinor >= 0 ? 'text-mint' : 'text-coral'}>
                  {position.unrealizedPnlMinor >= 0 ? '+' : ''}{formatMoney({ amountMinor: position.unrealizedPnlMinor, currency: 'USD' })}
                </span>
              </li>
            ))}
            {(!portfolio || portfolio.positions.length === 0) && <li className="text-slate-500">No open positions yet.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
