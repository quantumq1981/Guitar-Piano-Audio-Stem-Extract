import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Cross-origin isolation (COOP + COEP) is required for SharedArrayBuffer, i.e.
 * multithreaded WASM. `require-corp` (not `credentialless`, which Safari lacks):
 * every cross-origin fetch we make is CORS-mode, which require-corp permits.
 * On hosts that cannot set headers (GitHub Pages) public/sw.js injects them.
 *
 * ORT's WASM binary is referenced via `new URL(…, import.meta.url)` inside
 * onnxruntime-web, so Vite emits it as a content-hashed asset under /assets/,
 * which the service worker caches cache-first for offline use.
 */
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // GitHub Pages project sites live under /<repo>/; the Pages workflow sets VITE_BASE.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
