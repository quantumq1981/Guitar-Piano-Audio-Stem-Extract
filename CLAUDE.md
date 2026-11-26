# CLAUDE.md — working notes for this repository

## Layout
- `packages/core` — pure TS, zero runtime deps. Routing (`capability/routing.ts`), memory budgets (`memory/budget.ts`),
  chunked overlap-add engine (`dsp/chunking.ts`, `separation/engine.ts`), WAV codec, FFT + lead/rhythm heuristic,
  API contract + validators (`api/contract.ts`), job state machine, model registry (`models/registry.ts`).
- `packages/server` — Tier 1: onnxruntime-node runner, FFmpeg adapters, pipeline, file-backed JobStore, FIFO worker,
  node:http API, CLI (`src/cli.ts`). `scripts/` holds measurement tools (mem-probe, compare-models, segment-consistency).
- `apps/web` — Tier 2 React PWA: capability probe, inference worker (onnxruntime-web), server client, stem player, SW.
- `docs/ARCHITECTURE.md` (design + measured numbers), `docs/API.md` (contract). `scripts/fold_webgpu.py`, `scripts/e2e/`.
- Mobile inference: on-device separation runs in the main app (phones/tablets on the disk path since 2026-11-26); the experimental
  card stays for device tests. `docs/MOBILE-INFERENCE-DEVELOPMENT.md` is the handoff ("Stage V"); read it first.
  `scripts/mobile_graph.py` (PR #12 folding), `scripts/mobile_memory.py` (Stage IV exact memory passes, two-level reductions,
  live-memory simulator; tests `python -m unittest scripts/test_mobile_memory.py`), `scripts/mobile_fixture.py` (licence-free
  six-stem music fixture), `scripts/mobile-webgpu-check.mjs` (Chromium WASM/WebGPU gate), `.github/workflows/mobile-graph.yml`.

## Commands
- `npm test` (vitest, all workspaces) · `npm run typecheck` (tsc 7 strict, per package) · `npm run build:web`
- `npm run models:fetch` → `models/htdemucs_6s-stage4.onnx` + `models/candidate-memory.onnx.data` (gitignored, both sha256-pinned)
- Real separation: `node packages/server/src/cli.ts separate <file> --scope guitar --format wav24`
- Resume E2E: copy the Stage IV pair into `apps/web/dist/models/`, `vite preview --port 4173`, then
  `NODE_PATH=/opt/node-tools/node_modules node scripts/e2e/stage4-resume.mjs http://localhost:4173 <clip.wav> --threads 4`
- Server-side bench of any ONNX file: `node packages/server/scripts/bench-artifact.ts <model.onnx> <audio> [secs] [threads] [all|disabled]`
- Browser E2E: build web with `VITE_MODEL_MIRROR=/__models VITE_API_BASE=http://localhost:8787`, hard-link the graph to
  `apps/web/dist/__models/<graph sha256>.onnx` and the data to `apps/web/dist/__models/<data sha256>.onnx.data`,
  `vite preview --port 4173`, `stemsplit serve`, then `node scripts/e2e/browser-smoke.mjs http://localhost:4173 <clip.wav> <server-vocals.wav> --server`

## Deploy
- Phone-only, free (primary): `.github/workflows/separate.yml` — push audio to `inbox/` (or workflow_dispatch with a path) → matrix job per file
  (`scripts/ci/pick-audio.mjs`, unit-tested) → `cli.ts separate --no-limit` → artifact `stems - <name>` (7 days). Pages workflow ignores `inbox/**`.
- GitHub Pages: `.github/workflows/pages.yml` (Source must be "GitHub Actions"). Build env `VITE_BASE=/<repo>/`, optional repo variable `VITE_API_BASE` (https).
- All web paths must be base-relative (`import.meta.env.BASE_URL`, SW uses registration scope). Never hard-code `/`.
- Pages cannot set headers: `public/sw.js` injects COOP/COEP (`require-corp`) and `main.tsx` reloads once for isolation.
- Phone-only hosting: `deploy/oracle/` (primary; free Ampere A1 VM). `setup.sh` is idempotent: Node 22 (sha256-verified tarball), ffmpeg, Caddy + sslip.io TLS, systemd `stemsplit` on 127.0.0.1:8787 (`serve --host`), iptables 80/443. Users paste `cloud-init.sh` (curl | bash of main). Tested in an Ubuntu 24.04 container (x64, no systemd); not yet on real OCI/arm64.
- `deploy/huggingface-space/` needs a PAID HF plan since July 2026 (free accounts: ZeroGPU Gradio only). PWA `create()` retries 502/503/504 while a sleeping host wakes.
- Production builds without `VITE_API_BASE` have no server (`API_BASE === null`); server-routed jobs are disabled with an explanation.
- Pages also serves experimental `models/mobile.onnx` and the Stage IV `models/candidate-memory.onnx` + `.data` (rebuilt in pages.yml,
  deploy fails unless SHA-256 matches `MOBILE_STAGE4_CANDIDATE` in `packages/core/src/models/mobile-experimental.ts`). Device test:
  experimental card (home → "Device check & diagnostics", or `#diagnostics`) → "Stage IV: load + N windows" (`apps/web/src/inference/mobile-stage4.worker.ts`). The same card has
  "Separate a song on this device": core `separate()` + Stage IV session, stems streamed to OPFS as 24-bit WAV via `wavStemSink`
  (`packages/core/src/codec/stem-wav-sink.ts`); main-app routing is unchanged (phones still go to the server). The page scans
  OPFS on load and after every run (`storedStem` = complete / partial / invalid from the header + size), so a stopped run's
  files can be deleted. It frees old stems BEFORE the quota check: otherwise a phone near its quota fails every retry.
  A run stores the song as `input.f32` + `run.json` first, so a stopped/killed run can **Resume** (core `decideResume`,
  bit-identical; changing the overlap, stem order or graph makes stored runs `unusable`, never wrong).
  Safari Private Browsing (WebKit ephemeral session) rejects `navigator.storage.getDirectory()` with UnknownError
  "unknown transient reason (e.g. out of memory)" while `estimate()` still reports a 1 GiB quota. The card probes
  `getDirectory()` on load and disables the song path with an explanation (measured in Playwright WebKit).
- The card's WASM threads selector (1/2/4, `STAGE4_THREAD_OPTIONS`, default 1; `stage4Threads()` drops to 1 without
  cross-origin isolation and caps at `hardwareConcurrency`). Measured: identical parity at every count; window time on
  4 vCPU 18.0 / 10.1 / 5.7 s (Chromium app) and 17.5 / 9.0 / 5.7 s (WebKit app), touched heap 476-539 MiB.

## Conventions / invariants
- Node runs `.ts` directly (type stripping): **erasable syntax only** (no enums, namespaces, parameter properties); import with `.ts` extensions.
- Business logic goes in `packages/core` and must stay headless-testable. UI/browser APIs only in `apps/web/src/platform|audio|inference`.
- One model artifact everywhere (since 2026-11-25: `htdemucs_6s-stage4`, graph + external data). Changing it = new registry entry
  with sha256 (both files) + parity (`stemParity`: ≥ 40 dB SNR or error ≤ −90 dB re mix; `compare-models.ts` exits non-zero) and
  switching all tiers at once. Session settings per tier come from the registry (`graphOptimizationFor`), never hard-coded.
- Do not abort local runs on Compute Pressure: Chromium's `critical` is CPU utilisation, i.e. our own threads (measured).
- Device runs on phones/tablets go through OPFS (disk path), never in-memory: decode → transfer → worker stores `input.f32` and
  drops it BEFORE creating the session (the two memory phases must not overlap). A new run's stored predecessor counts as free space.
- Disk-path E2E: `VITE_MODEL_MIRROR=/__models` build + model under `dist/__models/`, server-CLI references under `dist/__ref/<scope>/`,
  `vite preview`, then `node scripts/e2e/device-disk-run.mjs http://localhost:4173 <clip.wav> [--webkit]`.
- Every job status change goes through `transition()`; never assign `status` directly.
- Tag numbers in docs as [M]easured / [V]endor / [E]stimate. Do not present estimates as facts.
- Per-stem SNR on a stem ≤ −50 dB re mix measures how quiet the stem is, not model error: read `compare-models.ts`'s
  error-re-mix column too (real music, 2026-11-25: fp16w vs fp32 is 39.3 dB at −63.5 dB re mix, error −103.6 dB re mix).
- ORT sessions: `enableCpuMemArena: false`, `enableMemPattern: false` (measured 2.4 GiB vs 4.7 GiB peak).
- Mobile graphs (Stage IV, measured): onnxruntime-web sums long float32 reductions less accurately than native (77-81 vs 101-107 dB
  vs float64); any graph run in WASM needs two-level ReduceMean/GroupNorm (`--accurate-reductions`) to meet the 40 dB contract.
  Gate per-stem parity on the music fixture: near-silent stems of tone/noise fixtures fail even native-vs-native rewrites.
- ORT plans same-size buffer reuse whenever shapes are static and holds dead encoder buffers for the decoder (+1.3 GiB with static
  shapes, +183 MiB even dynamic). Web/Node bindings cannot disable it: keep `opaque_shapes`, graph optimisation disabled, and never
  ship `--static-shapes` for WASM. Measure WASM memory as touched pages, not `buffer.byteLength` (geometric growth slack).
- Inference worker must not install `onmessage` when `self.name` starts with `em-pthread` (ORT thread re-entry deadlock).
- `Worker.terminate()` releases OPFS sync-access-handle locks asynchronously (Chromium, measured): retry
  `NoModificationAllowedError` when reopening a stopped run's files. In Chromium a reload is not a kill (visibilitychange
  fires first); E2E kills use CDP `Page.crash`.
- The MP3s in the repo root are the owner's test material; never commit derived stems (`out/` is gitignored).

## Status (2026-11-26, latest) — app redesign: one screen per step
- Owner approved the design canvas (https://claude.ai/artifact/NLjadeumgETCo9wJf1rcDR): home → choose stems → working → paused / stems.
- Pure flow logic in `packages/core/src/ui/flow.ts` (`screenFor`, `scopeOptions`, `planFor`, `partProgress`, plain-language
  `problemCopy`, `pauseMessage`; tests `packages/core/test/flow.test.ts`). Components only render it: `Home`, `ChooseStems`,
  `Working`, `PausedRun`, `StoredStems`, `StemMixer`, shared `components/ui.tsx`. `RoutingBanner`/`StoredRun` are gone.
- Never show a control this build cannot run: "Guitar focus" and "Always use our server" appear only with `VITE_API_BASE`;
  "Refine piano" is hidden (Banquet not built; the server would return the stem unrefined). Routing reasons and memory
  projection moved to the diagnostics screen (`#diagnostics`) with the GPU check and the experimental card.
- System fonts only: COEP `require-corp` blocks web-font CDNs, and the PWA must work offline.
- E2E selectors changed: `device-disk-run.mjs` (home rows, `.working[data-phase=local] progress`), `browser-smoke.mjs`
  (`.file-pick input`, `.stem-row__name`), `stage4-resume.mjs` (opens `#diagnostics`).

## Status (2026-11-26) — Stage V step 2: phones and tablets separate on device in the main app
- Routing by evidence (`capability/routing.ts`): non-desktop → **disk path** when the artifact has a measured `browserHeapBytes`,
  `caps.opfsWritable`, isolation, battery, ≤ 600 s, `projectDiskRunPeak` ≤ ceiling, storage for model + projected stems + song.
  The owner's iPhone UA is desktop-class → classified **tablet**; rules key on "not desktop". Crash flag guards desktop only.
- Disk path: `inference/disk-run.ts` (shared with the card) + `device-run.worker.ts` + `disk-run-client.ts` (hidden/battery → pause,
  wake lock) + `platform/disk-store.ts` + `components/StoredStems.tsx` / `PausedRun.tsx` (play/save from OPFS, Resume, Delete). Quick ("4 stems") writes 4.
- Merged as PR #24 and live on Pages (2026-11-26). Follow-up (Codex): `runOnDisk` checks battery and visibility once at start,
  since a resume skips routing and the page can be hidden during decode (`apps/web/test/disk-run-client.test.ts`).
- Next: physical-iPhone test of the main app, step 0 thread numbers, a synced mixer from disk, an immutable model URL.

## Status (2026-11-25, latest) — Stage V step 1 done: Stage IV is the primary on every tier
- Owner chose option A and the level-aware parity rule, plus a standing rule: improve by judgment, document, keep it retraceable.
- `PRIMARY_SEPARATION_MODEL = HTDEMUCS_6S_STAGE4` (graph + external data from Pages, both SHA-pinned; server opt `all`,
  browser `disabled`). Rollback: point it back at `HTDEMUCS_6S_FOLDED`; every loader handles both.
- Gate 16/16 PASS (min 40.1 dB). Server RTF 0.44–0.46 vs 0.58–0.62, peak 1.5–1.6 vs 2.8 GiB. Browser↔server 91.8 dB (v1 64.3).
- Fixed: the Compute Pressure abort killed every 4-thread desktop run (our own load reads as `critical`); storage/memory
  budgets counted only the 1.2 MB graph. WASM device cap 30 → 90 s (measured basis).
- Next: Stage V step 2 (phones on device in the main app), then 3–4. Handoff: "Stage V step 1 — done".

## Status (2026-11-25, later) — Stage V started; waiting on the owner
- Measured Stage IV vs production fp32 directly (8 songs × 3 windows, `compare-models.ts --candidate-graph-opt disabled`):
  min 40.1 dB per stem, on a near-silent piano (−63.5 dB re mix). fp32 → fp16w alone gives 39.3 dB there: the fp16 weights,
  not the Stage IV rewrites, set it (fp32→Stage IV tracks fp32→fp16w within 0.8 dB). Every sub-49 dB stem is ≤ −50 dB re mix,
  error ≈ −96…−104 dB re mix. Proposed (owner decides): pass a stem at ≥ 40 dB SNR OR error ≤ −90 dB re mix.
- Step 2b built: resumable on-device runs (`separation/resume.ts`: `separate({startChunk})`, `decideResume`, `run.json`,
  song stored in OPFS as `input.f32`, deleted when the stems are complete). Byte-identical to an uninterrupted run (unit tests at
  every stop point + `scripts/e2e/stage4-resume.mjs` in Chromium and WebKit). The card shows Resume after a stop, reload or killed tab.
- Still open: step 0 iPhone thread numbers; step 1 A/B decision plus the parity amendment; steps 2–4.

## Status (2026-11-25) — next: Stage V in the handoff
On-device full songs work on the owner's iPhone (Safari, normal tab, 1 thread, experimental card):
- 43.2 s: 8 windows, heap 616 MiB reserved / 508-510 touched, flat (Low Power Mode on: ~23 s per window).
- ~6.7 min with Low Power Mode off: STOPPED, not completed. The owner left Safari, and the card stops a run when the page is
  hidden. "~15 min" was the card's estimate, not a measurement. No long song has completed on the phone yet; resume is Stage V step 2b.
- Private Browsing blocks OPFS; the card explains it (#18). The stored-stem cleanup is #17.
- The threads selector (#19) is live; iPhone 1/2/4-thread numbers are still to be measured (Stage V step 0).
- Open owner decision: Stage IV as the one artifact on every tier (A, recommended) or a phone-only exception (B).
  Stage IV vs production fp32 is not yet measured directly (chain: >= 61.9 dB vs fp16w, fp16w >= 49.2 dB vs fp32).
- Tab Translator Pro is no longer attached; its lessons live in the handoff.

## Status (2026-11-24)
Mobile Stage IV (stacked on PR #12, experimental): exact rewrites + two-level reductions + external data. WASM touched memory
813 -> 475 MiB, Chromium peak PSS 1203/1158 -> 911/930 MiB, session-create heap 431 -> 147 MiB. WASM-vs-native parity fixed
(music fixture >= 61.9 dB per stem vs source, >= 84 dB same graph; owner's songs >= 58.2 / >= 75.7 dB). WebGPU sessions now
initialise in Chromium with static shapes (inference needs shader-f16). **Physical iPhone (Safari 27.2) passed** the hosted test:
session 2.9-3.9 s, 11.9-12.9 s per 7.8 s window (1 thread), WASM heap 616 MiB / touched 510 MiB, repeats bit-identical.
On-device full-song separation built in the experimental card (Chromium: memory flat over a 45 s song, browser WAV24
vs native >= 85.6 dB per stem).

## Status (2026-11-23)
Done: core + tests (67), server pipeline/API/CLI verified on real tracks (RTF ≈ 0.63, 4 vCPU), PWA builds and runs
device (WASM) + server paths in headless Chromium, browser↔server parity 64.3 dB, fp16w folded candidate built (143 MB, ≥ 49 dB).
Open: WebGPU memory profiling on real devices; Cloudflare DO/R2 adapter; OPFS streaming on device; ML lead/rhythm; Banquet (licence);
Dockerfile untested: Docker Hub and ECR public both returned 429 rate limits from the sandbox.
