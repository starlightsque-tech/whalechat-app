import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useStore } from 'zustand';
import { formatMoney, whalechatRuntime, whalechatStore, useWallet } from '@whalechat/shared';
import Svg, { Path } from 'react-native-svg';

function Chart({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <View className="h-40 items-center justify-center rounded-xl bg-white/5"><Text className="text-xs text-slate-500">Chart loads online</Text></View>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const path = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (values.length - 1)) * 320},${140 - ((v - min) / span) * 120}`)
    .join(' ');
  return (
    <View className="h-40 rounded-xl bg-white/5 p-1">
      <Svg viewBox="0 0 320 150" width="100%" height="100%">
        <Path d={path} fill="none" stroke="#34d3a6" strokeWidth={2} />
      </Svg>
    </View>
  );
}

export default function TradeScreen() {
  const assets = useStore(whalechatStore, (s) => s.assets);
  const quotes = useStore(whalechatStore, (s) => s.quotes);
  const candles = useStore(whalechatStore, (s) => s.candles);
  const [selected, setSelected] = useState('AAPL');
  const [quantity, setQuantity] = useState('1');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [notice, setNotice] = useState<string | null>(null);
  const { availableMinor } = useWallet();

  useEffect(() => {
    if (assets[0] && !assets.some((a) => a.symbol === selected)) setSelected(assets[0].symbol);
    void whalechatRuntime.loadCandles(selected);
  }, [assets, selected]);

  const quote = quotes[selected];
  const values = (candles[selected] ?? []).map((c) => c.close);
  const up = (quote?.change ?? 0) >= 0;

  async function submit() {
    setNotice(null);
    try {
      const trade = await whalechatRuntime.placeTrade({
        symbol: selected,
        side,
        quantity: Number(quantity) || 0,
        limitPrice: null,
        currency: 'USD',
      });
      setNotice(trade.status === 'pending_sync' ? 'Queued offline — funds locked until sync.' : `${side} ${selected} filled`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Trade failed');
    }
  }

  return (
    <ScrollView className="flex-1 bg-abyss" contentContainerStyle={{ padding: 14, gap: 12 }}>
      <View className="rounded-2xl border border-white/10 bg-deep p-4">
        <View className="flex-row items-end justify-between">
          <View>
            <Text className="text-xl font-bold text-white">{selected}</Text>
            <Text className="text-xs text-slate-400">{assets.find((a) => a.symbol === selected)?.name ?? ''}</Text>
          </View>
          <View className="items-end">
            <Text className="text-2xl font-bold text-white">{quote ? formatMoney({ amountMinor: Math.round(quote.price * 100), currency: 'USD' }) : '—'}</Text>
            <Text className={`text-xs font-semibold ${up ? 'text-mint' : 'text-coral'}`}>
              {quote ? `${up ? '+' : ''}${quote.changePercent.toFixed(2)}%` : ''}
            </Text>
          </View>
        </View>
        <View className="mt-3"><Chart values={values} /></View>
      </View>

      <View className="rounded-2xl border border-white/10 bg-deep p-3">
        <Text className="mb-2 text-xs uppercase text-slate-500">Watchlist</Text>
        {assets.slice(0, 8).map((asset) => {
          const q = quotes[asset.symbol];
          const positive = (q?.change ?? 0) >= 0;
          return (
            <Pressable key={asset.symbol} onPress={() => setSelected(asset.symbol)} className={`flex-row items-center justify-between rounded-lg px-2 py-2 ${selected === asset.symbol ? 'bg-white/10' : ''}`}>
              <View>
                <Text className="text-sm font-semibold text-white">{asset.symbol}</Text>
                <Text className="max-w-[160px] text-[10px] text-slate-500" numberOfLines={1}>{asset.name}</Text>
              </View>
              <Text className="text-sm text-white">{q ? formatMoney({ amountMinor: Math.round(q.price * 100), currency: 'USD' }) : '—'}</Text>
              <Text className={`w-16 text-right text-xs ${positive ? 'text-mint' : 'text-coral'}`}>{q ? `${positive ? '+' : ''}${q.changePercent.toFixed(2)}%` : ''}</Text>
            </Pressable>
          );
        })}
      </View>

      <View className="rounded-2xl border border-white/10 bg-deep p-4">
        <View className="flex-row gap-2">
          {(['buy', 'sell'] as const).map((option) => (
            <Pressable key={option} onPress={() => setSide(option)} className={`flex-1 rounded-xl py-2 ${side === option ? (option === 'buy' ? 'bg-mint' : 'bg-coral') : 'bg-white/5'}`}>
              <Text className={`text-center text-sm font-semibold ${side === option && option === 'buy' ? 'text-abyss' : 'text-white'}`}>{option.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
        <Text className="mb-1 mt-3 text-[10px] uppercase text-slate-500">Quantity</Text>
        <TextInput
          value={quantity}
          onChangeText={setQuantity}
          keyboardType="decimal-pad"
          className="rounded-xl border border-white/10 bg-abyss px-3 py-2 text-sm text-white"
          placeholderTextColor="#64748b"
        />
        <Text className="mt-2 text-xs text-slate-500">Available {formatMoney({ amountMinor: availableMinor, currency: 'USD' })}</Text>
        <Pressable onPress={() => void submit()} className="mt-3 rounded-xl bg-mint py-3">
          <Text className="text-center text-sm font-bold text-abyss">Place {side} order</Text>
        </Pressable>
        {notice && <Text className="mt-2 text-xs text-gold">{notice}</Text>}
      </View>
    </ScrollView>
  );
}
