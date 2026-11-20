import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { TradePage } from './pages/TradePage';
import { ChatPage } from './pages/ChatPage';
import { ShopPage } from './pages/ShopPage';
import { WalletPage } from './pages/WalletPage';
import { AdminPage } from './pages/AdminPage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="trade" element={<TradePage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="shop" element={<ShopPage />} />
        <Route path="wallet" element={<WalletPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="*" element={<Dashboard />} />
      </Route>
    </Routes>
  );
}
