# Stem Splitter: Mobile-First Architecture

Design document for the guitar/piano stem-separation PWA. It covers constraints first, then the architecture, the models, and the failure modes.
Every number is tagged **[M]** (measured in this repo), **[V]** (vendor-reported, not verified here), or **[E]** (estimate pending on-device measurement).

**Acronyms.** PWA: Progressive Web App. ORT: ONNX Runtime. EP: Execution Provider (ORT backend such as CPU, WASM or WebGPU). OPFS: Origin Private File System. RSS: Resident Set Size. RTF: real-time factor (compute seconds per audio second). DO: Cloudflare Durable Object. SNR: signal-to-noise ratio. SI-SDR: scale-invariant signal-to-distortion ratio.

---

## 0. Spec review: what changed and why

The source spec (`Guitar -Piano-ASE-Separation App.md`) is directionally right: server first, a capable browser second, native third. Several of its load-bearing claims fail against the actual artifacts on the Hub and against measurements on this host.

| # | Spec claim | Verdict | Evidence | Resolution |
|---|---|---|---|---|
| 1 | Browser default should be 4-stem `htdemucs_ft` because the 6-stem model "adds memory pressure" | **Inverted** | `htdemucs_ft` is a *bag of 4* models: 4 × 316 MB fp32, 4× compute. `htdemucs_6s` is a single 258 MB model **[M: Hub file sizes]** | One model everywhere: `htdemucs_6s`. "Quick" is a 4-stem *projection* of its output (other += guitar + piano), which costs nothing extra |
| 2 | A 4-stem browser default for a *guitar and piano* app | Product contradiction | 4-stem output has no guitar or piano stem | The device tier runs the 6-stem model or nothing |
| 3 | "WebGPU models ~80 MB" | False | The WebGPU-compatible `kramp/htdemucs-6s-webgpu-onnx` is 285 MB **[M]**. An fp16-weights fold we built is 143 MB **[M]** | Registry pins exact bytes and sha256 |
| 4 | ~1.1 GB RAM per segment **[V: StemSplit, M4 Pro]**; iOS abort at 1 GB | Vendor figure is about half of reality on x64 | ORT 1.31 CPU EP peaks at **2.40 GiB** steady state with arena and mem-pattern off, and **4.7 GiB** with ORT defaults by the 2nd run **[M]** | True for v1 (fp32, 2.4 GiB). **Superseded 2026-11-26:** the v2 Stage IV artifact holds a 616 MiB WASM heap, flat over a whole song, on a physical iPhone **[M]**, so phones and tablets now run on device on the disk path (stems stream to OPFS). Routing decides on that evidence, not on form factor |
| 5 | Same ONNX files ⇒ "byte-comparable" outputs | False | Kernels, FMA and reduction order differ per EP. Browser WASM vs server CPU = **64.3 dB SNR** with v1, **91.8 dB** with v2, not identical **[M]** | Parity contract is numeric (`stemParity` in core): per stem, SNR ≥ 40 dB (`PARITY_MIN_SNR_DB`) **or** error ≤ −90 dB re mix (`PARITY_MAX_ERROR_DB_RE_MIX`, owner-approved 2026-11-25 for near-silent stems) |
| 6 | Same files ⇒ no drift | Incomplete | Decoders drift too: browser `decodeAudioData` trims MP3/AAC priming differently from FFmpeg | Server jobs always upload the *original file*; the server decodes with FFmpeg |
| 7 | 40 MB upload cap with a 6-minute limit | Inconsistent | A 6-minute 16-bit 44.1 kHz stereo WAV is 63.5 MB | Cap raised to **64 MiB** |
| 8 | MVSep lead/rhythm model (lead SI-SDR ≈ 6.43 dB) | Not obtainable | No open weights or ONNX on the Hub; MVSep is a hosted service **[V]** | Slot filled by a labelled DSP heuristic (`spatial-similarity-v0`, §2.4). The ML slot stays in the registry as `unavailable` |
| 9 | Banquet piano refinement | Not deployable yet | Code is public. Weights are MoisesDB-trained, which is a non-commercial licence. No ONNX export, and the PaSST query encoder needs export too | Server-only stage stub; jobs return the 6s piano stem with a `piano_refinement_unavailable` warning |
| 10 | `navigator.deviceMemory` ≤ 4 GB routes to server | Partly unusable | Absent in Safari and Firefox; Chromium quantises it and caps it at 8 | `null` is modelled explicitly; unknown memory on mobile means server |
| 11 | `getBattery()` < 20 % gate | Partly unusable | Absent in Safari and Firefox | Applied when available; otherwise ignored, never guessed |
| 12 | Background Sync for server jobs | Chromium-only | Not in Safari or Firefox | IndexedDB outbox, flushed on Background Sync *or* the `online` event *or* at startup |
| 13 | "Abort if hidden during a chunk" | Kept | Mobile browsers freeze hidden tabs | Abort at the chunk boundary and offer "process on our servers" |

Bugs found while building, each now handled in code:

- **ORT pthread re-entry deadlock.** When bundled, ORT's Emscripten threads run `new Worker(import.meta.url, {name: 'em-pthread'})`, which re-executes *our* worker module. Our `onmessage` swallowed the thread-init messages and session creation hung forever. The worker now refuses to install its handler when `self.name` starts with `em-pthread` (`apps/web/src/inference/worker.ts`).
- **Cache quota.** `Cache.put` of a 285 MB model fails in ephemeral or low-quota contexts. Caching is now best-effort; the run continues in memory.
- **Fold gotcha.** ORT `ENABLE_BASIC` offline folding, which produced the published WebGPU file, also folds fp16→fp32 `Cast`s, so an fp16-weights model silently re-inflates to fp32. `scripts/fold_webgpu.py` folds only `ConstantOfShape`.

---

## 1. Constraints

| Constraint | Value | Source |
|---|---|---|
| Model input window | 343,980 frames = 7.8 s @ 44.1 kHz stereo, fixed shape | ONNX graph **[M]** |
| Primary model RSS per session (CPU EP) | v2 (Stage IV, since 2026-11-25): 1.50–1.59 GiB peak over 31.2 s, 0.98 GiB after load. v1: 2.40–2.76 GiB peak, 435–880 MiB after load | **[M]** `packages/server/scripts/bench-artifact.ts` (VmHWM), `mem-probe.mjs` |
| Server throughput | v2: RTF 0.44–0.46 on 4 vCPU x64 (v1 in the same runs: 0.58–0.62; earlier v1 runs 0.45–0.68) | **[M]** `bench-artifact.ts`, `stemsplit bench`, full runs |
| Browser WASM throughput | v2: 10 s clip in 27.6 s including model download and session create (headless Chromium, 4 threads); v1: 31.6 s | **[M]** `scripts/e2e/browser-smoke.mjs` |
| Browser WASM heap (v2) | 616 MiB reserved / 510 MiB touched, flat over a whole song, physical iPhone and Chromium alike | **[M]** experimental card |
| iOS Safari tab kill | ~1.5 GiB | **[E]** |
| wasm32 address space | 4 GiB hard limit | spec |
| Server job duration cap | 360 s | policy |
| Upload cap | 64 MiB | policy (see §0 #7) |
| Device duration cap | Desktop: 90 s with WebGPU or threaded WASM (WASM was 30 s on an estimate until 2026-11-25; v2 WASM at 4 threads is about real time per song [M]). Phones and tablets (disk path): 600 s | policy |
| Result retention | 7 days, HMAC-signed URLs | policy |

Design rule: **no client architecture may assume more than ~1 GiB of headroom on mobile.** The measured 2.4 GiB v1 session made the server mandatory for phones *and* tablets. The v2 artifact's measured browser heap is 616 MiB, so since 2026-11-26 a phone or tablet runs on device when the evidence holds: the artifact has a measured `browserHeapBytes`, OPFS is writable (not Safari Private Browsing), the page is cross-origin isolated, and the disk-run projection fits the ceiling. The projection is the larger of the decode phase (file + 3 decoded copies) and separation (heap + overlap-add state); 665 MiB for a 45 s song, ≤ 1 GiB at the 10-minute cap.

---

## 2. Architecture

### 2.1 Tiered routing (deliverable 1)

```
 ┌────────────── PWA (apps/web) ──────────────┐
 │ capability probe (platform/probe.ts)       │  deviceMemory | WebGPU adapter + fallback flag |
 │  → CapabilitySnapshot (pure data)          │  crossOriginIsolated | battery | crash marker |
 └───────────────┬────────────────────────────┘  storage quota | model cached? | online
                 ▼
     decideRoute()  — pure, in @stemsplit/core, every rule emits a reason code
                 │
   server if ANY: force-server · scope=guitar or refinePiano · crash flag ·
                  phone · deviceMemory ≤ 4 · unknown memory on mobile ·
                  battery < 20 % (not charging) · duration > cap (90 s GPU / 30 s WASM) ·
                  no WebGPU and not cross-origin isolated · projected peak > platform ceiling ·
                  model not browser-eligible · storage < 1.5 × model
                 │
       ┌─────────┴──────────┐
       ▼                    ▼
  DEVICE (Tier 2)       SERVER (Tier 1)  ← guaranteed path
  worker.ts              online? ──no──▶ IndexedDB outbox ─▶ Background Sync / `online` / startup
  ├ loadModel(): Cache Storage,           │yes
  │  sha256-verified                      ▼
  ├ ORT web: webgpu | wasm          POST /v1/jobs (model sha256 check → 409 on drift)
  ├ separate() ← same core engine   PUT signed upload URL (streamed, capped)
  ├ guards: hidden tab, battery,    ─▶ JobStore (revisioned) ─▶ FIFO worker, 1 session per container
  │  CPU pressure, crash marker           decode (FFmpeg + SoX resample) → separate (same core engine)
  └ stems → Web Audio player              → lead/rhythm → [piano refine] → encode (wav16/24, flac, mp3)
                                    GET /v1/jobs/:id?since=rev  (25 s long-poll, no open sockets)
                                    GET signed stem URLs (7-day TTL) → Web Audio player / share
```

A native wrapper (Tier 3) reuses `@stemsplit/core` unchanged with an `onnxruntime-react-native` `SegmentRunner`. It is subject to the same memory budget: 2.4 GiB on a phone is only plausible for an app in the foreground, which needs on-device profiling first.

### 2.2 One engine, every tier

`separate(source, runner, sink)` in `packages/core/src/separation/engine.ts` owns chunk geometry, zero padding, cross-fade weights and stem projection. Each tier supplies only a `SegmentRunner`: onnxruntime-node, onnxruntime-web, or a future React Native runner. The remaining cross-tier difference is EP floating point, which the measured 64.3 dB parity confirms is negligible.

### 2.3 Chunking and bounded memory

- Chunks are N = 343,980 frames with 25 % overlap (O = 85,995) and stride S = 257,985. The chunk count is `ceil((T − N)/S) + 1`, so there is no wasted trailing chunk.
- Weights are linear complementary fades. The first chunk has no fade-in and the last has no fade-out, so the weights sum to exactly 1.
- `StreamingOverlapAdd` holds **N frames per (stem, channel)** regardless of song length: about 13 × 1.38 MB = 17.9 MB for 6 stems, and identical for a 10 s clip or a 6 min song.
- The server streams finalised blocks straight into float32 WAV masters on disk.

### 2.4 Lead/rhythm guitar: `spatial-similarity-v0` (heuristic, labelled)

Rhythm guitars are usually double-tracked and panned wide, so L and R are decorrelated. Leads are usually a single take near centre, so L and R are coherent.

The mask is the Avendano–Jot similarity ψ = 2|Φ_LR| / (Φ_LL + Φ_RR), with cross-spectra smoothed recursively in time (α = 0.8) and pooled over ±2 bins. Pooling raises the effective number of averages, which removes the upward bias of coherence estimates on independent noise; a test caught this. The mask is m = ψ².

Both channels are packed into one complex FFT (Z = X_L + iX_R, mask applied to Z). Rhythm = input − lead in the time domain, so **lead + rhythm == guitar exactly**. It fails on mono mixes, centre-panned rhythm and stereo-chorused leads. Every guitar job carries the `lead_rhythm_heuristic` warning.

### 2.5 Mixture consistency

htdemucs_6s does not enforce Σ stems = mix. On raw single segments, Σ stems vs mix gives 17.5–20 dB SNR, and full-song outputs give 17.0–18.9 dB **[M]**. This is a model property: overlap-add adds no measurable loss (`packages/server/scripts/segment-consistency.ts`). Floats are not normalised; clipped peaks raise `clipping_in_output`. A future option is to add the residual `mix − Σ stems` to `other`.

---

## 3. Model inventory (deliverable 2)

| Registry id | Role | Hub repo / file | Bytes | sha256 | CPU | WASM | WebGPU | Tiers | Status |
|---|---|---|---|---|---|---|---|---|---|
| `htdemucs_6s-stage4` | primary, 6 stems | graph `candidate-memory.onnx` + external data `.onnx.data` (GitHub Pages, rebuilt and SHA-checked by `pages.yml`) | 1,201,735 + 129,090,048 | `a343b853…f7fc1110` + `514978cf…9db` | ✅ [M] | ✅ [M] | ❌ [M] (dynamic-shape partitioning) | server, browser, native | **canonical v2** since 2026-11-25 (owner decision, option A) |
| `htdemucs_6s-folded` | previous primary; parity reference | `kramp/htdemucs-6s-webgpu-onnx` / `htdemucs_6s.onnx` | 284,797,240 | `a3f50506…ac86a` | ✅ [M] | ✅ [M] | ✅ [V] | server, browser, native (rollback) | **v1**; rollback = point `PRIMARY_SEPARATION_MODEL` back at it |
| `htdemucs_6s-upstream` | reference | `StemSplitio/htdemucs-6s-onnx` / `htdemucs_6s.onnx` | 258,159,781 | — | ✅ | ✅ | ❌ `ConstantOfShape` | none | not deployable |
| `htdemucs_6s-folded-fp16w` | primary v2 candidate | built from `…/htdemucs_6s_fp16weights.onnx` by `scripts/fold_webgpu.py` | 143,359,115 | `1333aa4a…1946f` | ✅ [M] | ? | ? | none yet | ≥ 49 dB vs v1 on the first clips [M]; **39.3 dB on a near-silent stem of another song** [M] (§ 8); needs real-GPU verification |
| `guitar-lead-rhythm-ml` | lead/rhythm | — | — | — | — | — | — | server | **unavailable** (no open weights) |
| `banquet-piano` | piano refinement | — (GitHub `kwatcharasupat/query-bandit`) | — | — | — | — | — | server | build-required, licence check |

Rejected for the browser: `StemSplitio/htdemucs-ft-onnx` (4 × 316 MB fp32 or 4 × 166 MB fp16, 4× compute) and `StemSplitio/htdemucs-onnx` (316 MB, no guitar or piano).

The promotion rule: a new artifact replaces the old one **on every tier in one release**. `GET /v1/models` serves the registry, and job creation rejects a client whose pinned sha256 differs (HTTP 409).

---

## 4. Memory budget (deliverable 3)

Projection = max(session-create transient, inference peak) + audio buffers (`packages/core/src/memory/budget.ts`).

| Platform | Kill threshold | Abort above | Projected peak, htdemucs_6s-folded | Decision |
|---|---|---|---|---|
| iOS Safari (WebGPU, iOS 26) | ~1.5 GiB [E] | 1.0 GiB | **2.26 GiB** (WebGPU activations assumed = CPU [E]) | server |
| Android Chrome, WebGPU, 8 GiB | ~2 GiB [E] | 1.25 GiB | 2.26 GiB | server |
| Android Chrome, WASM | ~1.5 GiB [E] | 1.0 GiB | 2.26 GiB | server |
| Desktop WebGPU | ~4 GiB [E] | 3.0 GiB | 2.26 GiB | **device** |
| Desktop WASM, cross-origin isolated | 4 GiB (wasm32) | 3.0 GiB | 2.26 GiB (ran successfully in headless Chromium [M]) | **device**, ≤ 30 s |
| Server container (CPU EP) | container limit | 3.5 GiB | **2.40 GiB peak RSS [M]** | 1 session per container; provision ≥ 4 GiB, 6 GiB recommended |

How the measured numbers break down:

- **Session load:** 435 MiB for the 272 MiB file.
- **Inference:** about 2.0 GiB of activations, independent of thread count (1, 2 and 4 threads all ≈ 2.40 GiB).
- **ORT defaults:** `enableCpuMemArena` plus `enableMemPattern` grow the peak to 4.7 GiB by the second segment for a < 20 % speedup. Both are disabled on every tier.

**Provisioning (verify against your platform):** pick an instance class with ≥ 4 GiB RAM and 4 vCPU. Cloudflare Container instance names and sizes change, so confirm current types before deploying.

---

## 5. PWA service worker and caching (deliverable 4)

| Resource | Store | Strategy | Notes |
|---|---|---|---|
| App shell (`/`, manifest, icon) | `shell-v1` | precache on install, network-first navigation with offline fallback | |
| `/assets/*` (JS, CSS, ORT `.wasm` 28.7 MB, 7.3 MB gzip) | `runtime-v1` | cache-first; content-hashed and immutable | ORT wasm is emitted by Vite as a hashed asset |
| Model weights | `models-<id>` keyed `/__models/<sha256>.onnx` | written **by the page** after streaming download with progress and sha256 verification; old versions purged | best-effort: quota failure continues in memory. Optional mirror via `VITE_MODEL_MIRROR` |
| `/v1/*` API | none | network-only | job state must never be stale |
| Shared files (Web Share Target) | `share-inbox` | POST `/share-target` stash, then redirect | |
| Offline server jobs | IndexedDB `stemsplit/outbox` | flushed on Background Sync (`flush-outbox`), `online`, or startup | idempotency key makes retries safe |
| Intermediate audio | memory today (desktop only) | — | OPFS streaming is the next step for longer device clips |

Cross-origin isolation uses `COOP: same-origin` and `COEP: require-corp`. Safari does not implement `credentialless`, and every cross-origin fetch we make (the model and the API) is CORS-mode, which `require-corp` allows. Hosts that can set headers use `vite.config.ts` and `public/_headers`. On static hosts that cannot (GitHub Pages), `public/sw.js` injects the headers into every same-origin response, and `main.tsx` reloads once after the service worker takes control. This was verified on a header-less static server under a `/<repo>/` subpath: `crossOriginIsolated` became true and an on-device WASM run completed **[M]**. All service-worker paths are relative to the registration scope.

---

## 6. Risk register (deliverable 5)

| Risk | Likelihood / impact | Detection | Mitigation in code |
|---|---|---|---|
| Silent tab kill (OOM, or iOS suspending a hidden tab) | High on mobile / lost work | no event fires; on the disk path the stored run is found at next start | **disk path (phones, tablets):** the stems so far stay in OPFS and the run resumes bit-identically from its last whole block, so a kill costs at most one window; a hidden page stops the run on purpose. **Memory path (desktop):** `localStorage` crash marker forces the server next time; without a server the banner offers to clear it |
| WASM heap exhaustion | High below 4 GiB address space | ORT `create()` / `run()` throws | v2 heap is 616 MiB (measured), capped `WebAssembly.Memory` (1 GiB, then 768 MiB); WASM only on cross-origin-isolated pages, clips ≤ 90 s; arena off; error UI offers server |
| WebGPU session-creation failure (`ConstantOfShape`, `transformer_memcpy`-class placement errors) | Medium / no local path | `InferenceSession.create` rejects | canonical artifact is the constant-folded export; registry refuses unfolded models in the browser (`model_not_browser_eligible`); fallback to server |
| Thermal throttling | Medium on laptops | none since 2026-11-25 | **Guard removed.** Chromium's Compute Pressure `critical` follows CPU utilisation, so a 4-thread run reached it from its own load (fair → serious → critical at 15 s) and was terminated mid-window; without it the same run finished [M]. A hot device downclocks: slower, nothing lost. |
| Background tab freeze | High on mobile | `visibilitychange` → hidden | abort at chunk boundary, offer server |
| Battery drain | Medium | `getBattery()` where available | gate < 20 % when not charging, and mid-run abort |
| ORT pthread deadlock under bundlers | Hit during build | session never resolves | `em-pthread` guard in the worker (§0) |
| Client/server output drift | Medium | `clientModelSha256` vs server pin (409); SNR gate in parity tests | one artifact everywhere; server decodes the original upload with FFmpeg |
| Model download corruption or truncation | Low | size + sha256 mismatch | streaming size guard, sha256 before caching |
| Server overload | Medium | queue depth, `etaSec` | FIFO, 1 session per container, horizontal scale; long-poll instead of open sockets |
| Licence exposure (Banquet / MoisesDB, MVSep) | High if shipped commercially | registry `license` field | both stages unshipped; the heuristic is original code |

---

## 7. Server contract (deliverable 6)

See [`docs/API.md`](./API.md) for the HTTP and CLI contract shared by the PWA, the CLI and any native wrapper.

---

## 8. Verification log (this repo, Linux x64, 4 vCPU)

| Check | Result |
|---|---|
| Unit and integration tests (`npm test`) | 67 / 67 pass |
| Strict typecheck (TS 7, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) | clean |
| Full guitar-scope job, 176.4 s track | 110.4 s wall, RTF 0.63, 7 stems × 2 formats, length-aligned |
| Headless Chromium, WASM device path, 10 s clip | 6 stems; **64.3 dB** SNR vs server CPU (vocals L) |
| Headless Chromium, forced-server guitar job via the PWA | 7 stems, heuristic warning surfaced |
| fp16w-folded candidate vs fp32 canonical | ≥ 49.2 dB worst-segment SNR on every stem (first clips) |
| Same, 2026-11-25, three of the owner's songs × 3 windows | **min 39.3 dB** (piano, *Feel Like Makin' Love*, stem −63.5 dB re mix, error −103 dB re mix); every stem above −25 dB re mix ≥ 53.5 dB. The low figures are all on stems ≤ −50 dB re mix. See MOBILE-INFERENCE-DEVELOPMENT.md, Stage V progress. |
| Stage IV mobile graph vs fp32 canonical, 8 songs × 3 windows | min 40.1 dB (same stem); tracks fp32→fp16w within 0.8 dB on every stem, so the fp16 weights, not the Stage IV rewrites, set it |
| **v2 promotion gate** (2026-11-25): `compare-models.ts` with the level-aware `stemParity` rule, v1 → v2, 8 songs × 3 windows, v2 opened with graph optimisation `all` (server) and `disabled` (browser) | **16 / 16 PASS**; every stem passes on SNR alone (min 40.1 dB); both settings agree to 0.1 dB on every worst case |
| v2 server bench, 31.2 s, 4 vCPU, two quiet runs each | RTF 0.44–0.46, peak 1.50–1.59 GiB (opt all); 0.48–0.49, 1.48–1.63 GiB (opt disabled); v1 0.58–0.62, 2.76 GiB |
| v2 CLI end to end (`models fetch` into an empty dir from the registry URLs, then `separate` a 267 s song) | both files downloaded and SHA-verified, data stored under the name the graph records; six stems |
| v2 headless Chromium, WASM device path + forced-server path (`browser-smoke.mjs --server`) | device 6 stems in 27.6 s; **browser WASM vs server CPU 91.8 dB** (v1: 64.3 dB); server path 7 stems |

## 9. Next steps

1. Profile WebGPU memory on real devices (an Apple Silicon Mac and a Pixel with 8 GiB RAM). This replaces the **[E]** WebGPU activation figure; until then iOS and Android stay server-only.
2. Promote `htdemucs_6s-folded-fp16w` (or the Stage IV graph built from it) after WebGPU verification: half the download. Not "same output to ≥ 49 dB": on near-silent stems it falls to 39.3 dB [M], so promotion needs the owner's decision on a level-aware parity rule (MOBILE-INFERENCE-DEVELOPMENT.md, Stage V progress).
3. Add a Cloudflare adapter: a Worker front door and one Durable Object per job implementing the `JobStore` surface, with R2 for inputs and stems (lifecycle rule: 7 days) and the container running `stemsplit serve` as the worker.
4. ~~OPFS-backed `FrameSource` and `StemSink`~~ built for the experimental card (`wavStemSink`, `interleavedFileSource`, resumable runs in `separation/resume.ts`); the main app still uses the in-memory path.
5. Lead/rhythm ML: train or licence a model and swap it into the `guitar-lead-rhythm-ml` slot. The pipeline already selects it when `availability === 'published'`.
6. Banquet: resolve the licence, export the PaSST and bandit models to ONNX, and add a parity test.
