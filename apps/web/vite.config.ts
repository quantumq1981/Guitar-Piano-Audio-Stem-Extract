import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Cross-origin isolation (COOP + COEP) is required for SharedArrayBuffer, i.e.
 * multithreaded WASM. `credentialless` keeps cross-origin model fetches from
 * Hugging Face working without CORP headers on their CDN.
 *
 * ORT's WASM binary is referenced via `new URL(…, import.meta.url)` inside
 * onnxruntime-web, so Vite emits it as a content-hashed asset under /assets/,
 * which the service worker caches cache-first for offline use.
 */
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
