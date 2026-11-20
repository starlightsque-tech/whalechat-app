import { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { useStore } from 'zustand';
import { formatMoney, whalechatRuntime, whalechatStore } from '@whalechat/shared';

export default function ShopScreen() {
  const products = useStore(whalechatStore, (s) => s.products);
  const cart = useStore(whalechatStore, (s) => s.cart);
  const orders = useStore(whalechatStore, (s) => s.orders);
  const [notice, setNotice] = useState<string | null>(null);
  const totals = whalechatRuntime.cartTotals();

  return (
    <View className="flex-1 bg-abyss">
      <FlatList
        data={products}
        numColumns={2}
        keyExtractor={(item) => item.id}
        columnWrapperStyle={{ gap: 8, paddingHorizontal: 12 }}
        contentContainerStyle={{ paddingVertical: 12, gap: 8 }}
        renderItem={({ item }) => (
          <View className="flex-1 rounded-2xl border border-white/10 bg-deep p-3">
            <View className="mb-2 h-16 items-center justify-center rounded-xl bg-tide/50"><Text className="text-2xl">🛍</Text></View>
            <Text className="text-xs font-semibold text-white" numberOfLines={2}>{item.title}</Text>
            <Text className="mt-1 text-sm font-bold text-mint">{formatMoney(item.price)}</Text>
            <Pressable onPress={() => whalechatRuntime.addToCart(item)} className="mt-2 rounded-lg bg-mint py-1.5">
              <Text className="text-center text-[11px] font-bold text-abyss">Add to cart</Text>
            </Pressable>
          </View>
        )}
        ListFooterComponent={
          <View className="px-3 pb-4">
            <View className="mt-2 rounded-2xl border border-white/10 bg-deep p-4">
              <Text className="text-sm font-semibold text-white">Cart ({cart.length})</Text>
              {cart.map((item) => (
                <View key={item.productId} className="mt-1 flex-row items-center justify-between">
                  <Text className="flex-1 text-xs text-slate-300" numberOfLines={1}>{item.title} ×{item.quantity}</Text>
                  <Text className="text-xs text-slate-400">{formatMoney(item.unitPrice)}</Text>
                </View>
              ))}
              <Text className="mt-2 text-sm font-bold text-white">Total {formatMoney({ amountMinor: totals.totalMinor, currency: totals.currency })}</Text>
              <Pressable
                className={`mt-2 rounded-xl py-2.5 ${cart.length ? 'bg-mint' : 'bg-white/10'}`}
                disabled={!cart.length}
                onPress={async () => {
                  try {
                    const order = await whalechatRuntime.checkout();
                    setNotice(order.status === 'pending_sync' ? 'Queued offline — funds locked until sync.' : 'Order placed in escrow.');
                  } catch (error) {
                    setNotice(error instanceof Error ? error.message : 'Checkout failed');
                  }
                }}
              >
                <Text className="text-center text-sm font-bold text-abyss">Checkout with escrow</Text>
              </Pressable>
              {notice && <Text className="mt-2 text-[11px] text-gold">{notice}</Text>}
              {orders.length > 0 && (
                <Text className="mt-2 text-[10px] text-slate-500">Last order {orders[0]?.id.slice(0, 12)} · {orders[0]?.status}</Text>
              )}
            </View>
          </View>
        }
      />
    </View>
  );
}
