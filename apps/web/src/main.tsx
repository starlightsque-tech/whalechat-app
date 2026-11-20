import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import { configureWebWhalechat } from './lib/whalechat';
import './index.css';

async function boot() {
  await configureWebWhalechat();
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root');
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </React.StrictMode>,
  );
}

void boot();
