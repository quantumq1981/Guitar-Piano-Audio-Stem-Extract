# CLAUDE.md — working notes for this repository

## Layout
- `packages/core` — pure TS, zero runtime deps. Routing (`capability/routing.ts`), memory budgets (`memory/budget.ts`),
  chunked overlap-add engine (`dsp/chunking.ts`, `separation/engine.ts`), WAV codec, FFT + lead/rhythm heuristic,
  API contract + validators (`api/contract.ts`), job state machine, model registry (`models/registry.ts`).
- `packages/server` — Tier 1: onnxruntime-node runner, FFmpeg adapters, pipeline, file-backed JobStore, FIFO worker,
  node:http API, CLI (`src/cli.ts`). `scripts/` holds measurement tools (mem-probe, compare-models, segment-consistency).
- `apps/web` — Tier 2 React PWA: capability probe, inference worker (onnxruntime-web), server client, stem player, SW.
- `docs/ARCHITECTURE.md` (design + measured numbers), `docs/API.md` (contract). `scripts/fold_webgpu.py`, `scripts/e2e/`.

## Commands
- `npm test` (vitest, all workspaces) · `npm run typecheck` (tsc 7 strict, per package) · `npm run build:web`
- `npm run models:fetch` → `models/htdemucs_6s-folded.onnx` (gitignored, sha256-pinned in the registry)
- Real separation: `node packages/server/src/cli.ts separate <file> --scope guitar --format wav24`
- Browser E2E: build web with `VITE_MODEL_MIRROR=/__models`, hard-link the model to `apps/web/dist/__models/<sha256>.onnx`,
  `vite preview --port 4173`, `stemsplit serve`, then `node scripts/e2e/browser-smoke.mjs http://localhost:4173 <clip.wav> <server-vocals.wav> --server`

## Deploy
- GitHub Pages: `.github/workflows/pages.yml` (Source must be "GitHub Actions"). Build env `VITE_BASE=/<repo>/`, optional repo variable `VITE_API_BASE` (https).
- All web paths must be base-relative (`import.meta.env.BASE_URL`, SW uses registration scope). Never hard-code `/`.
- Pages cannot set headers: `public/sw.js` injects COOP/COEP (`require-corp`) and `main.tsx` reloads once for isolation.
- Production builds without `VITE_API_BASE` have no server (`API_BASE === null`); server-routed jobs are disabled with an explanation.

## Conventions / invariants
- Node runs `.ts` directly (type stripping): **erasable syntax only** (no enums, namespaces, parameter properties); import with `.ts` extensions.
- Business logic goes in `packages/core` and must stay headless-testable. UI/browser APIs only in `apps/web/src/platform|audio|inference`.
- One model artifact everywhere. Changing it = new registry entry with sha256 + parity (≥ 40 dB SNR, `compare-models.ts`) and switching all tiers at once.
- Every job status change goes through `transition()`; never assign `status` directly.
- Tag numbers in docs as [M]easured / [V]endor / [E]stimate. Do not present estimates as facts.
- ORT sessions: `enableCpuMemArena: false`, `enableMemPattern: false` (measured 2.4 GiB vs 4.7 GiB peak).
- Inference worker must not install `onmessage` when `self.name` starts with `em-pthread` (ORT thread re-entry deadlock).
- The MP3s in the repo root are the owner's test material; never commit derived stems (`out/` is gitignored).

## Status (2026-11-23)
Done: core + tests (67), server pipeline/API/CLI verified on real tracks (RTF ≈ 0.63, 4 vCPU), PWA builds and runs
device (WASM) + server paths in headless Chromium, browser↔server parity 64.3 dB, fp16w folded candidate built (143 MB, ≥ 49 dB).
Open: WebGPU memory profiling on real devices; Cloudflare DO/R2 adapter; OPFS streaming on device; ML lead/rhythm; Banquet (licence);
Dockerfile untested: Docker Hub and ECR public both returned 429 rate limits from the sandbox.
