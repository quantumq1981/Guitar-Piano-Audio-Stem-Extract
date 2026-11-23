import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

const BASE = import.meta.env.BASE_URL;
const RELOAD_FLAG = 'stemsplit.coiReloaded';

/**
 * The service worker injects COOP/COEP (static hosts like GitHub Pages cannot).
 * A page loaded before the SW controlled it is not cross-origin isolated, so
 * reload exactly once after the SW takes control. The sessionStorage flag stops
 * a loop on browsers that never become isolated.
 */
async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE });
  if (globalThis.crossOriginIsolated) {
    sessionStorage.removeItem(RELOAD_FLAG);
    return;
  }
  if (sessionStorage.getItem(RELOAD_FLAG)) return;
  const reload = () => {
    sessionStorage.setItem(RELOAD_FLAG, '1');
    location.reload();
  };
  if (navigator.serviceWorker.controller) reload();
  else navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
}

if (import.meta.env.PROD) {
  window.addEventListener('load', () => {
    registerServiceWorker().catch((e: unknown) => console.warn('Service worker registration failed', e));
  });
}
