# Mobile inference development — Engineering handoff

Checkpoint: 2026-11-26 UTC (Stage V: step 1 done, Stage IV is the primary everywhere; step 2 done, phones separate on device in the main app; see "Stage V step 2 — done"). Earlier: 2026-11-24 (Stage IV; first physical iPhone pass recorded). PR #12 and the Stage IV PR stacked on it remain open; experimental work is not production-approved. Stage IV below supersedes the Stage III remaining-work list.

## Stage I — Original Claude development
Read [CLAUDE.md](../CLAUDE.md), [original engineering specification](../Guitar%20-Piano-ASE-Separation%20App.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [API.md](API.md). Preserve these historical documents. Stage I deliberately routes phones to server because native CPU peak RSS was 2.40 GiB with arena/pattern disabled, 4.7 GiB with defaults. Original browser/server parity was 64.3 dB; original server RTF 0.45–0.68 on four vCPU. Stage II investigates whether local six-stem inference can become practical without paid hosting; it does not invalidate the original safeguards.

## Architecture and invariants
- packages/core: pure TypeScript routing, memory budgets, shared separation engine, overlap-add, registry and API contract.
- packages/server: ORT Node, FFmpeg, CLI, FIFO jobs and HTTP API.
- apps/web: React PWA, capability probe, inference worker, model cache, stem player. GitHub Pages has no server unless VITE_API_BASE is configured. Service worker provides COOP/COEP. Use base-relative paths.
- Fixed input mix [1,2,343980], 44.1 kHz stereo, 7.8 seconds; output stems [1,6,2,343980] ordered drums,bass,other,vocals,guitar,piano. 25% overlap, stride 257985 frames. Do not shorten input by padding and claim activation savings.
- Production registry canonical htdemucs_6s-folded: 284797240 bytes, SHA256 a3f5050696cda4b2344d465123acb21ee699dad7d0634dba1d282497a04ac86a. Experimental folded FP16-weight source: 143359115 bytes, SHA256 1333aa4a748126703b2824286c6a38dd0774491f7b2ad9fb802eba190191946f. FP16 storage is not FP16 execution. Source hosted at https://quantumq1981.github.io/Guitar-Piano-Audio-Stem-Extract/models/mobile.onnx. Candidate generated separately in CI; do not assume source SHA applies to candidate.
- Preserve one canonical model across production tiers, per-stem >=40 dB parity contract, job transitions, existing routing, crash safeguards, disabled arena and memory pattern. Verify upstream checkpoint and dataset licensing before commercial distribution; registry metadata alone is insufficient.
- Lead/rhythm DSP heuristic is not ML; piano refinement remains unavailable. Do not promise these as solved.

## Stage II — chronological experiments
| PR | Work and outcome |
|---|---|
| 6 | GPU diagnostic and safeguards; physical iPhone reported WebGPU, shader-f16, isolation and synthetic compute pass; 1024 MiB buffer/binding limits are not available RAM. |
| 7 | CI builds folded FP16-weight candidate using scripts/fold_webgpu.py; avoid general offline optimization that expands weight Casts. |
| 8 | Hosted experimental model and benchmark; verified download, Safari interrupted at session creation with optimization all. |
| 9 | Disabled graph optimization, persistent logs, inference gated on init; Safari returned transformer_memcpy provider assignment error at /real_istft/Slice_1. |
| 10 | Basic optimization only; verified download then Safari interrupted at init. Cause not proven; memory or runtime defect possible. |
| 11 | Offline small integer constant folding, CPU parity, graph report and candidate artifact. |
| 12 | Targeted ISTFT floating constant folding, dead-node pruning, two CPU fixtures, Chromium gate; then runtime matrix and PSS/repeated parity tests. Open, unmerged. |

PR #12: https://github.com/quantumq1981/Guitar-Piano-Audio-Stem-Extract/pull/12
Branch mobile/phase-7-istft. Initial head d37d46a8e5a0b091b9ffd9cc7ec43f1d63c1b438. Runtime matrix commits 53bcd78 and 93351b5; profiling commits e531948 and e32ce77. Documentation commit follows these.

### Failure history
Run 45320159687: graph preparation and CPU parity passed; Chromium WebGPU initialization failed: transformer_memcpy.cc:254 !node_provider_type.empty() was false. Provider type for Expand node with name '/real_istft/Expand' is not set. This reproduces provider assignment failure outside Safari. Do not confuse it with OOM.
Run 45325334423: current WASM passed (4.1971 s init, 23.5646 s total); pinned 1.23.2 WASM passed (2.6746 s init, 22.057 s total). Current WebGPU same Expand error; pinned WebGPU threw numeric error 260851112. These are synthetic single-window Chromium tests, not mobile tests.

### Final Stage II checkpoint — run 45325896555, job 138215288412
https://github.com/quantumq1981/Guitar-Piano-Audio-Stem-Extract/actions/runs/45325896555
Overall failure at pinned WASM numerical parity step. Graph folding, CPU parity, native reference generation, compatibility matrix and artifact upload passed.
| Configuration | Init s | Total s | Baseline KiB PSS | Peak KiB PSS |
|---|---:|---:|---:|---:|
| Current WASM | 4.6677 | 26.7551 | 178810 | 1285903 |
| Pinned WASM | 2.9449 | 24.317 | 174757 | 1265383 |
| Pinned WASM validation | 2.9888 | incomplete | 170503 | 1299059 |

PSS sampled every 250 ms across Chromium processes; sampled peak can miss transients and is not native RSS or physical iOS memory. Pinned validation peak ~1.24 GiB, above original 1 GiB conservative mobile budget. Both WebGPU paths still fail.
Validation used deterministic stereo 440/660 Hz tones plus seeded noise, native source model with graph optimization disabled, candidate browser model, one thread. First inference completed, then parity gate stopped at bass: drums 43.5883094372 dB, max abs 0.000111149624; bass 29.7740388068 dB, max abs 0.0000118680982. Other/vocals/guitar/piano not evaluated; repeated inference not completed. Gate fails when SNR <40 AND maxAbs >1e-5. Low reference energy may explain low SNR; not proven. Do not relax production parity blindly. Diagnostic artifact: https://github.com/quantumq1981/Guitar-Piano-Audio-Stem-Extract/actions/runs/45325896555/artifacts/14889931567

## Lessons from the owner's Tab Translator Pro stem splitter (absorbed; that repository is no longer attached)
These notes are all that is needed from it: do not look for the repository.
- SCNet four-stem compact 2.8 s versus 11 s window is a precedent for re-export with fixed time-axis matrices; documented quality tradeoff ~2 dB SDR. Not a guitar/piano separator or direct HTDemucs substitute.
- Plain ORT 1.23.2 WASM build for old Safari: ORT ≥ 1.24 ships an Abseil whose hash seeds JavaScriptCore mis-optimises on ARM64 before Safari 17.5 (microsoft/onnxruntime#33426: random "Could not find OrtValue" at session creation). WebGPU in WebKit stalled in the asyncify build (#26827). This repo already runs the pinned 1.23.2 in CI (`ORT_PINNED=1`); Safari 27.2 on the owner's iPhone runs the app's ORT 1.31.1 fine.
- Int16 transferable audio, incremental overlap-add and worker termination reduce retained audio/heap; Int16 is lossy and can clip, so preserve float fidelity or explicitly validate quantization.
- SHA-keyed cache, verify cached/fresh bytes, evict corrupt entries, quota failures nonfatal; no heavy main-thread fallback. Close AudioContext, cancel stale requests, persist interrupted-run marker. Do not blindly transplant WebAssembly.Memory monkeypatch.
- Browser PSS benchmarks and real musical fixtures are useful; Chromium is not physical Safari. Shared beat grid, score/audio DTW alignment, guitar transcription and MusicXML/MIDI/CSMPN integration are later opportunities.

## Stage III — completed diagnostic checkpoint

[Actions run 45327479654](https://github.com/quantumq1981/Guitar-Piano-Audio-Stem-Extract/actions/runs/45327479654) validated commit `1d84d61`. The workflow reports per-stem reference RMS, error RMS, maximum absolute error, SNR, global SNR, repeat consistency and sampled phase memory before returning the strict 40 dB per-stem result. The `1e-5` reference RMS marker labels near-silent outputs and has no effect on the gate. [Browser logs and native report](https://github.com/quantumq1981/Guitar-Piano-Audio-Stem-Extract/actions/runs/45327479654/artifacts/14890762298).

The native ONNX Runtime 1.32.0 CPU reference used the same seeded stereo fixture, one thread and disabled graph optimization for the source and the candidate. All six native outputs matched exactly (max absolute delta 0). Chromium tested the same candidate bytes (`454cc7c73cbb8ac875d836c06abb9dc180e1e6092ef30b2cd1db3836269fc769`) three times in each single-thread WASM version. Within each version, runs 2 and 3 matched run 1 exactly.

A separate local Node replay used the same WASM bundles and fixture to run the source and candidate independently with optimizations disabled. Source and candidate PCM were byte-for-byte identical in WASM 1.31.1 and again in WASM 1.23.2. On this stimulus, the native-to-WASM gap is present with either graph.

| Stem | Native reference RMS | WASM 1.31.1 SNR (dB) | WASM 1.23.2 SNR (dB) | 40 dB gate |
|---|---:|---:|---:|---|
| Drums | 3.035e-3 | 43.59 | 43.59 | Pass |
| Bass | 3.588e-5 | 29.77 | 29.77 | Fail |
| Other | 2.879e-3 | 34.88 | 34.88 | Fail |
| Vocals | 4.680e-4 | 24.96 | 24.96 | Fail |
| Guitar | 5.852e-5 | 40.09 | 40.08 | Pass |
| Piano | 5.505e-2 | 63.55 | 63.55 | Pass |

Global SNR was 57.73 dB for both configurations. The piano reference dominated the aggregate. Bass, other and vocals failed every run. Bass had the lowest reference RMS and about `1.19e-5` maximum absolute error. The synthetic fixture measures numerical agreement and repeatability. Musical separation quality still needs a fixture with known stems.

| WASM version | Init (s) | Inference runs (s) | Session create PSS (KiB) | Inference PSS by run (KiB) | Session cleanup peak (KiB) |
|---|---:|---|---:|---|---:|
| 1.31.1 | 3.23 | 14.85 / 14.45 / 14.25 | 799019 | 1173082 / 1240562 / 1256306 | 1256478 |
| 1.23.2 | 1.96 | 14.67 / 14.59 / 14.64 | 789575 | 1298600 / 1194380 / 1210444 | 1210668 |

The highest sampled Chromium process-tree PSS in validation was about 1.20 GiB for 1.31.1 and 1.24 GiB for 1.23.2, both above the project’s 1 GiB mobile budget. Samples run every 250 ms on the Linux CI runner. Physical iOS memory is still unmeasured. WebGPU failed during session creation in both versions with the same errors as before.

## Stage III — remaining work (superseded by Stage IV below; items 1, 2 and the ISTFT part of 5 are done)
1. Keep PR #12 experimental. Add a cleared real-music fixture with meaningful guitar and piano energy. Compare the source and candidate in Chromium WASM and native CPU on identical samples. Measure per-stem numerical parity separately from separation quality and leakage.
2. Repeat phase-specific memory profiling on source and candidate. Investigate a shorter re-export or external DSP ISTFT where measured savings justify it. Preflight constant-folded shapes and bytes with a global budget, and preserve learned weight Casts.
3. If memory and accuracy justify it, add an isolated experimental WASM worker with matching pinned JS/WASM assets, one thread, disabled graph optimization, a verified cache, transferable buffers, cancellation and crash recovery. Terminate the worker after completion or failure. Keep production routing and its safeguards.
4. Test physical iOS, iPadOS and Android after the CI and memory gates. Start with session creation, then move to a single window, multiple windows and full tracks. Use OPFS or bounded audio streaming and incremental output for full tracks.
5. Investigate WebGPU independently. Analyze ISTFT Expand, Range and ScatterND dependencies and provider assignment, or externalize ISTFT with verified parity.
6. Run `npm test`, `npm run typecheck` and `npm run build:web` before production changes. Review licenses, model hashes and musical quality before promoting any model.

## Stage IV — exact memory rewrites and the parity root cause (branch `claude/sweet-pascal-h1pafr`)

Numbers are **[M]** measured in a 4 vCPU Linux container on the CI fixtures and candidate bytes. "Touched" is WASM heap pages that hold any non-zero byte (`scripts/mobile-webgpu-check.mjs` reports `wasmHeapMiB`; touched pages come from the Node harness). Emscripten grows the heap in geometric steps, and grown pages stay non-resident until written, so `buffer.byteLength` overstates what a phone commits. Chromium figures are sampled process-tree PSS, as in Stage III. None of this is physical iOS memory.

### Results

| Model | WASM touched after 3 runs (1.23.2 / 1.31.1) | Chromium peak PSS (1.31.1 / 1.23.2) | Heap after session create | Native peak, ORT defaults with reuse on | Min per-stem SNR, WASM vs native source (music fixture) |
|---|---:|---:|---:|---:|---:|
| PR #12 candidate (`454cc7c7…`) | 813 / 814 MiB | 1203 / 1158 MiB | 431 / 433 MiB | +607 MiB | 37.4 dB (guitar), **fail** |
| Exact passes only (no reduction rewrite) | 528 / 474 MiB | 908 / 985 MiB | 144 / 167 MiB | — | identical to PR #12, **fail** |
| **Stage IV candidate** (`candidate-memory.onnx` + `.data`) | **475 / 476–508 MiB** | **911 / 930 MiB** | **147 / 172 MiB** | **+203 MiB** | **61.9 dB, pass** |

Stage IV candidate in Chromium (both WASM versions, music fixture, three runs, all pass): per-stem SNR is 61.9–94.3 dB against native **source** and 84–120 dB against native CPU running **the same graph**. Repeats are bit-identical. Separation SDR against the known fixture stems is unchanged to 0.01 dB (drums 13.6, bass 16.2, other 1.4, vocals 10.5, guitar 0.0, piano 6.9; the music is synthetic, so the absolute values are out of distribution). On 7.8 s windows of four of the owner's MP3s (Alicia Keys, D'Angelo, *Feel Like Makin' Love*, *The Urban Theme*; only numbers kept), the PR #12 candidate fell to 29.6–35.6 dB on near-silent stems in two songs. The Stage IV candidate gave ≥ 58.2 dB against native source and ≥ 75.7 dB against native on the same graph, on every stem of every song. WASM time per window is unchanged (≈ 23–29 s, single thread). Native kernel time is 11.6 → 9.4 s. Files: 1.15 MB graph + 129 MB external data (was 143 MB).

### What each pass does and why (`scripts/mobile_memory.py`, unit tests in `scripts/test_mobile_memory.py`)

| Pass | Finding that motivated it | Effect | Exactness |
|---|---|---|---|
| `slice_attention` | Self-attention scores + softmax = 2 × 220.5 MiB of the 564 MiB live peak (8 heads × 2688² fp32) | Per head and per query chunk (≤ 8 MiB score matrix) | bit-exact: CPU at 1 and 4 threads, WASM 1.23.2 and 1.31.1 |
| `fold_input_independent` | ~6,400 ISTFT nodes (680 ScatterND + Expand/Range) only compute the window envelope | One 2.7 MiB constant; executed nodes 8560 → 4110 | bit-exact |
| `split_conv_transpose` | ORT CPU ConvTranspose materialises the whole column buffer (+126 MiB at decoder.3, measured in WASM). Conv tiles its im2col and needs nothing | Split along output channels, ≤ 16 MiB column buffer | bit-exact |
| `schedule_static_nodes` | ORT's reverse-DFS order runs an input-independent node before its consumer's whole data path; the 32 MiB ISTFT basis cast was alive across both decoders | Input-independent nodes lead the node list, so they run just in time | bit-exact |
| `constants_to_initializers` + `--external-data` | Session create held three copies of the weights (fetch buffer, parsed protobuf, tensors) | WASM heap after create 431 → 147 MiB | bit-exact |
| `accurate_reductions` | **Parity root cause** (below) | Two-level ReduceMean; GroupNorm (InstanceNormalization over 2–8.3M elements) → block sums + one BatchNormalization | not bit-exact; ≥ 61.6 dB per stem vs source on CPU (music), better agreement across runtimes |
| `opaque_shapes` | **ORT buffer-reuse trap** (below) | Native peak with default reuse 384 → 203 MiB; WASM touched 617/665 → 475/508 MiB | bit-exact |

The live-memory simulator (`Profile.live_peak`: profiled ORT order, exact shapes, view aliasing, ConvTranspose scratch) matches native peak RSS with reuse off to within 1–4 MiB (201.6 vs 201, 222.8 vs 222, 268 vs 272). Measure native peaks with `MALLOC_MMAP_THRESHOLD_=131072`: glibc's dynamic mmap threshold otherwise fragments blocks under 32 MiB and inflates RSS (+1037 vs +272 MiB for the same model).

### Parity root cause — do not re-derive

1. **Control:** native vs native, changing only optimization level and threads, agrees to 84–133 dB per stem, with errors around −140 dB re mix. WASM vs native gave 25–64 dB, with errors up to −61 dB re mix. The gap is a real kernel difference, not a fixture artefact.
2. **Intermediates and single-op isolation:** with identical real inputs, every WASM kernel matches native within 134–154 dB except two. **ReduceMean** (77.3 dB, 688k elements) and **InstanceNormalization** (81.5 dB, 516k elements) diverge. Against float64 truth, native scores 101–107 dB and WASM 77–81 dB: onnxruntime-web accumulates long float32 sums less accurately. The model normalises its input and every DConv GroupNorm (up to 8,255,520 elements per instance) with them, and the error is amplified downstream.
3. **Fix:** two-level reductions over √L-sized blocks. Mean and E[x²] come from block sums, so there are no full-size temporaries. Variance is E[x²] − E[x]², clamped at 0; the worst mean²/var at any GroupNorm input is 0.71 on both fixtures, so cancellation costs ≤ 1.7×. Normalisation is one BatchNormalization, a single output allocation like the original op. Rewriting only the ≥ 1M-element reductions gives min 51.9 dB; all ≥ 16k elements gives 81–113 dB WASM vs native on the same graph, even on the tone fixture.
4. **Why the tone/noise fixture alone cannot gate:** most stems are near silent there (bass −64 dB re mix), and the network amplifies any rounding change. Even native rewritten vs native source drops to 43 dB on it, while the music fixture gives ≥ 61.6 dB. The 40 dB per-stem contract is evaluated on `scripts/mobile_fixture.py` (deterministic synthesis, all six stems at −3 to −18 dB re mix, no licence needed). The tone fixture stays as a diagnostic.

### The ORT buffer-reuse trap — do not re-derive

When ORT's planner can size two tensors at load time and they are equal, it keeps the first one's buffer after its last use until the second is created. In this U-Net every encoder-sized buffer then waits idle across the bottleneck for its mirrored decoder layer, and the STFT basis waits for the ISTFT basis. With all shapes made static (`--static-shapes`), the native peak is 1560 MiB with reuse vs 222 MiB without, and WASM touched memory is 1668 MiB. Even the dynamic-shape graph lost 183 MiB to it. Python ORT can turn reuse off (`enable_mem_reuse = False`); **onnxruntime-web 1.23.2/1.31.1 and onnxruntime-node cannot** (no session option or config key). Symbolic input dims alone do not help, because constant Reshape targets inside the graph keep shapes static. `opaque_shapes` hides the sizes exactly: symbolic input dims, every Reshape target read through an Identity, and large fp16 weight casts fed through such a Reshape. **Graph optimisation must stay disabled** for this candidate, or constant folding makes shapes static again. Not useful: memory pattern on (run 2 regrows to 763–771 MiB heap).

### WebGPU status

With the ISTFT folded and `--static-shapes`, **WebGPU session creation succeeds in Chromium for both 1.23.2 and 1.31.1** (2.7 / 3.4 s), for the first time in this project. Inference then stops on SwiftShader only because it lacks `shader-f16`, which the fp16→fp32 weight Casts need. The physical iPhone reported shader-f16 in PR 6. With dynamic shapes, partitioning still fails, now at `/real_istft/Slice_2041` (initializer data, shape-derived `ends`). Static shapes are incompatible with the WASM memory goal (reuse trap), so WebGPU needs its own graph variant, GPU-memory measurement and a physical-device test.

## Stage IV — device test on GitHub Pages

A physical-iPhone report from 2026-11-24 (screenshot: "Downloading verified model (143 MB)… Integrity PASS; initializing WebGPU session (basic graph optimization)…", then the tab was closed and the page showed "Previous test was interrupted") ran the **older WebGPU experiment from PR 10**, not Stage IV. Pages then hosted only `models/mobile.onnx`, and the benchmark had no Stage IV path. It reproduces the Stage II PR 10 failure (WebGPU, basic optimisation, which re-expands fp16 weights) and says nothing about the Stage IV candidate.

The Pages build now regenerates the Stage IV candidate from the verified `mobile.onnx`: `scripts/mobile_graph.py`, then `scripts/mobile_memory.py --external-data --accurate-reductions --no-verify`. It fails the deploy unless both files match the SHA-256 pins in `packages/core/src/models/mobile-experimental.ts` (`MOBILE_STAGE4_CANDIDATE`). The rebuild is deterministic: CI (Python 3.11) and a local rebuild (Python 3.13) produce the same bytes. It serves `models/candidate-memory.onnx` + `.data` (130 MB). The experimental card has **Stage IV: load + 1 window** and **Stage IV: load + 3 windows**. They run `apps/web/src/inference/mobile-stage4.worker.ts`:
- Plain WASM build (`onnxruntime-web/wasm`, not JSEP/asyncify), one thread, graph optimisation disabled, both files verified.
- Shared WebAssembly memory capped at 1 GiB, then 768 MiB if that reservation fails (`capWasmMemoryDescriptor`); ORT asks for 4 GiB.
- Screen wake lock while the test runs.
- Every stage is logged with the WASM heap (reserved and touched) to the crash-marker log.

Real app in headless Chromium (Vite preview, 4 vCPU), "load + 3 windows" **[M]**:

| Stage | WASM heap (touched) | Time |
|---|---:|---:|
| Session ready | 172 MiB (138) | 8.0 s |
| Window 1 | 515 MiB (479) | 26.7 s |
| Window 2 | 515 MiB (479) | 25.3 s, bit-identical to window 1 |
| Window 3 | 616 MiB (510) | 24.5 s, bit-identical to window 1 |

What to record from a device run: the full log text (environment line with the Safari version, every heap line, the last stage before any interruption), the model and iOS version, and whether other tabs were open. If it fails at "Creating session" with a RangeError, the memory cap ladder was refused. If the tab closes during a window, the last heap line is the best available estimate of the kill threshold.

### First physical-device result — iPhone, 2026-11-24 **[M]**

The owner ran the hosted test on an iPhone over 5G (Pages deploy of PR #14). Both runs passed. Safari logged its user agent as `Macintosh; Intel Mac OS X 10_15_7 … Version/27.2 Safari/605.1.15`, the desktop-class UA. It also logged `crossOriginIsolated true` and 4 cores, and ORT 1.31.1 WASM with one thread. The shared-memory maximum was capped at 1024 MiB, and Safari accepted that.

| Run | Download + verify | Session ready | Window times (7.8 s each) | WASM heap (touched) after last window | Repeat vs window 1 |
|---|---:|---:|---|---:|---|
| load + 1 window | 9 s (130 MB) | 3.9 s | 11.9 s | 515 MiB (479) | — |
| load + 3 windows | — | 2.9 s | 12.3 / 12.8 / 12.9 s | 616 MiB (510) | max \|Δ\| 0, both repeats |

- **Six-stem htdemucs runs in mobile Safari, on device and offline-capable, with no server.** It is the same graph and weights CI validated (≥ 61.9 dB per stem against native).
- The per-window real-time factor is 1.53–1.66 (single thread), about 2× faster than the 4 vCPU CI container (24.5–26.7 s). With the 25 % overlap (5.85 s stride), a full song would take ≈ 2.1× its length, so ≈ 8.5 min for 4 min of audio **[E]**.
- The WASM heap is byte-for-byte the same sequence as in Chromium (172 → 515 → 515 → 616 MiB reserved, 138 → 479 → 479 → 510 MiB touched). The same malloc in the same WASM binary gives the same layout, so the CI numbers predict the device heap. What the CI cannot measure is the WebContent process total and iOS's limit.
- Not yet tested: full songs (stem storage is the new memory term), multi-threading, other iPhones (iOS < 17.5 needs ORT 1.23.2, microsoft/onnxruntime#33426), iPad, Android.

### On-device full-song separation (experimental card) **[M]**

"Separate a song on this device" in the experimental card does the following:
1. Decodes the chosen file on the page at 44.1 kHz (the existing `decodeForModel`: mono duplicated, 5.1 folded).
2. Checks that `navigator.storage.estimate()` leaves room for the stems.
3. Transfers the planar channels to `mobile-stage4.worker.ts`.
4. Runs the shared core engine (`separate()`, 25 % overlap-add) with the Stage IV session.
5. Streams every finalised block into six **24-bit WAV files in OPFS** through sync access handles. `wavStemSink` in `packages/core/src/codec/stem-wav-sink.ts` (headless-tested) writes each header with the first block and checks contiguity and completeness.
6. The page shows an `<audio>` player and a download link per stem. Each reads the disk-backed OPFS `File`, so the stems are never copied into memory. "Delete stems from this device" removes them.
7. **Leftovers are found and freed.** The page scans the stem directory on load and after every run. `storedStem` (core, headless-tested) reads each file's 44-byte header and size:
   - six complete, equal-length files are shown as playable stems, including after a reload;
   - anything else is listed as "unfinished stems from a stopped run", with its size and the Delete button. This covers a run that was cancelled, hidden or killed with the tab.

   A new song frees the old stems **before** the storage-quota check. Before this fix (Codex review on #16), a stopped run's files had no Delete control, and the quota check counted them. On a nearly full phone every retry failed.

What the run holds in memory does not grow with song length, apart from the decoded input (≈ 85 MB for 4 min stereo):
- the WASM heap;
- one window of overlap-add state (16.5 MB);
- one block's PCM per stem.

Real app in headless Chromium (iPhone user agent, 390 px), 45 s of *D'Angelo – Lady* as lossless WAV:

| Check | Result |
|---|---|
| Windows | 8, 3:46–3:51 total (≈ 28 s per window on the 4 vCPU container; the iPhone did 12–13 s per window) |
| WASM heap over the song | 172 → 515 → 616 MiB reserved, touched 479 → 510 MiB, flat for windows 3–8 |
| Stems | 6 × 11 MiB WAV (24-bit), 1,984,500 frames each, no clipping |
| Browser WAV24 vs native onnxruntime-node, same engine and model, float | drums 93.8 · bass 95.0 · other 85.6 · vocals 94.8 · guitar 89.7 · piano 89.2 dB |
| Same with 16-bit stems (first version) | 44.6–73.6 dB vs float; the quiet "other" stem (−31.7 dB re mix) was limited by 16-bit quantisation, not the model (63.3 dB against native quantised to 16-bit) |
| 5 s mono file | 1 window, six stems, delete clears OPFS |
| Run reloaded after window 1, then a retry with a simulated quota that fits the new stems only if the old ones are freed (1.4 MB free otherwise) | Before the fix: 9 MB of partial stems and no Delete control; the retry failed with "stems need 8 MB, 1 MB available". After: "Unfinished stems … (9 MB)" with Delete; the retry logged "Removed the previous stems (9 MB)" and finished. The finished stems were still playable after a reload, and Delete emptied OPFS. `navigator.storage.estimate()` reflected the removal immediately in Chromium. |

**Safari Private Browsing blocks the song path [M].** The first iPhone attempt failed at once, before the model downloaded, with `UnknownError: The operation failed for an unknown transient reason (e.g. out of memory)` and a 0 MiB heap. The tab was a Private Browsing window. Reproduced in Playwright WebKit:

| | Ephemeral session (as Private Browsing) | Persistent session (normal tab) |
|---|---|---|
| `navigator.storage.getDirectory()`, page and worker | that exact `UnknownError` | ok; sync access handle writes |
| `navigator.storage.estimate()` | still reports a 1 GiB quota | 1 GiB |

So the quota check cannot catch it. On load, the card now calls `getDirectory()`, which creates nothing. If storage is blocked, it explains why and disables the song controls; the Stage IV memory test needs no storage and stays available. The same real app in a persistent WebKit session (JavaScriptCore, Linux, 4 vCPU) separated a 5 s file end to end: session 5.6 s, window 19 s, heap 515 MiB reserved / 478 MiB touched, six stems.

An in-memory fallback for private windows was not built. 24-bit stems are 1.6 MB per second of song (≈ 380 MB for 4 min) on top of the ≈ 616 MiB heap, which is too much for a phone tab.

A capability gotcha that a first version shipped: `createSyncAccessHandle` exists only in dedicated workers, so checking `FileSystemFileHandle.prototype` on the page rejects every browser. The page checks only `navigator.storage.getDirectory`, and the worker checks for sync access.

The time estimate shown before a run uses the iPhone's 12.5 s per window. A 4-min song is 41 windows, so about 9 min on that phone **[E]**.

### First full song on a physical iPhone — 2026-11-25 **[M]**
The owner ran the song test in a normal Safari tab, after the private-window failure above. These numbers come from the on-screen log.

| | Result |
|---|---|
| Song | 43.2 s m4a (0.7 MB), 2 channels, 8 windows |
| Total | 3:05 from the first window to the last, 4.3× the song length |
| Per window | 22.2–23.4 s (windows 3→8), and 70 s for the first three; steady from the start |
| WASM heap | 616 MiB reserved, 508–510 MiB touched, flat over windows 3–8. Same as the window test. |
| Output | 1,905,367 frames, 6 × 11 MiB 24-bit WAV (69 MB), no clipping; played from OPFS in Safari |

**Speed:** about 23 s per window is ≈ 1.8× the window test's 11.9–12.9 s. The time is constant from window 1, which does not fit thermal throttling, since that would build up over the run. **Low Power Mode was on (confirmed by the owner)**, and it lowers CPU speed, so it is the likely cause. Treat this run as the Low Power Mode figure: ≈ 4.3× the song length, ≈ 17 min for 4 min of audio **[E]**. A rerun with Low Power Mode off gives the normal baseline.

The Safari version was not in the screenshots.

### ~6.7-min song on the iPhone — 2026-11-25: stopped, not completed
With Low Power Mode off, at 1 thread, the owner started a ~6.7-min song (69 windows, i.e. 400–405 s of audio) and then left Safari. The card stops a run when the page is hidden ("Stopped: page hidden"), so it did not finish. How many windows completed is not recorded; the card keeps its log in localStorage, so the next run overwrites it.
- **Nothing was measured.** The "about 15 minutes" came from the card's own estimate (69 × 12.5 s), not from a run.
- **Still measured so far:** the longest completed device run is the 43.2 s song (8 windows, above). Per-window time at full power is known only from the window test (11.9–12.9 s at 1 thread).
- **Not yet proven on the phone:** a long song run to completion, its memory over many windows, and ≈ 640 MB of stems written (six 24-bit stereo stems of 400–405 s, computed).
- **Product finding:** a long song needs about 15 min of foreground time, and nothing tells the user that leaving stops the run. iOS also suspends background tabs, and may kill them under memory pressure, so a run cannot simply continue in the background. Stage V therefore includes resuming a stopped run (step 2b).

### WASM threads (experimental card selector) **[M]**
ORT's WASM build runs multi-threaded when the page is cross-origin isolated, which Pages already is (`public/sw.js`). The card now has a **WASM threads** selector: 1 / 2 / 4, remembered per device, default 1. `stage4Threads()` in core lowers the request to 1 on a non-isolated page and caps it at `navigator.hardwareConcurrency`. The log's session line names the thread count that was actually used.

Container: 4 vCPU. Per-window time, one 7.8 s window:

| Threads | Chromium gate script (`ORT_THREADS`, music fixture) | Real app, Chromium | Real app, WebKit (JavaScriptCore) |
|---|---|---|---|
| 1 | 18.0 s · heap 515 MiB | 18.0 s · touched 479 MiB | 17.5 s · touched 479 MiB |
| 2 | 9.7–10.0 s · heap 515 MiB | 10.1 s · touched 539 MiB | 9.0 s · touched 476 MiB |
| 4 | 5.5–6.8 s · heap 618 MiB | 5.7 s · touched 508 MiB | 5.7 s · touched 492 MiB |

- **Parity does not change with threads.** The minimum per stem was 84.1 dB vs native and 62.0 dB vs source at 1, 2 and 4 threads, and repeats were bit-identical.
- **Peak Chromium PSS:** 905 / 904 / 1002 MiB.
- **Full song path:** a 4-thread song run completed in both engines, with six stems written.
- **Bundled app:** Vite's ORT bundle started its pthread workers without changes, and the `em-pthread` guard held.
- **Not measured yet:** the iPhone. It has performance and efficiency cores and reports 4 to the page, so expect less than the container's scaling. The selector is live on Pages (PR #19); measuring it is Stage V step 0.

## Stage V — the next stage: on-device separation in the main app (handoff for the next session)
**Goal:** a phone gets free, private six-stem separation in the normal UI, with no server. Today the main app sends every phone to a server (`phone_form_factor` is a hard blocker in `packages/core/src/capability/routing.ts`). The free Pages build has no server (`API_BASE === null`), so on a phone the main app cannot separate at all; only the experimental card can. Proven in that card on the iPhone: a full 43.2 s song (8 windows, heap flat), OPFS streaming and playback, and 11.9–12.9 s per window at 1 thread (window test). Proven in Chromium and WebKit: identical parity at 1/2/4 threads. **Not yet proven on the phone: a long song run to completion.**

**Step 0 — iPhone thread test (owner, ~5 min, before code).** Low Power Mode off. In the experimental card (home → "Device check & diagnostics"), set WASM threads to 1, 2 and 4 and run "Stage IV: load + 1 window" once each. Record the "Window 1 PASS in …" seconds and the heap line. The fastest count whose heap stays at or below ≈ 620 MiB becomes the default (`MOBILE_STAGE4_CANDIDATE.session.numThreads`, `STAGE4_THREAD_OPTIONS`). Then, at that count, run a 4–7-min song **to completion**, keeping Safari in the foreground with the screen on, and capture the end of the log. This is the long-run measurement that is still missing.

**Step 1 — owner decision: model policy (ask before writing code).** The rule is one artifact on every tier.
- **(A) Recommended: Stage IV becomes the single artifact everywhere.** The parity chain, with the contract at 40 dB per stem:
  - Stage IV vs its source, the fp16-weight model (`htdemucs_6s-folded-fp16w`): ≥ 61.9 dB on the music fixture and ≥ 58.2 dB on the owner's songs **[M]**.
  - That fp16-weight model vs today's production `htdemucs_6s-folded` (fp32): ≥ 49.2 dB **[M]** (ARCHITECTURE.md).
  - Stage IV vs production directly is **not measured**. Run `compare-models.ts` first; expect ≈ 49 dB **[E]**, since the fp16 weights dominate.

  The work:
  - run that direct comparison; promotion needs it;
  - a registry entry with two pinned files (graph + `.data`), and switch `PRIMARY_SEPARATION_MODEL`;
  - the server runner (onnxruntime-node) loads the graph with its external data;
  - re-measure server speed and memory (the earlier server RTF of ≈ 0.63 used the fp32 folded model);
  - `compare-models.ts` parity, then switch all tiers together.
- **(B) Phone-only exception.** Server and desktop keep `htdemucs_6s-folded`, and phones run Stage IV. This breaks the invariant, so CLAUDE.md and ARCHITECTURE.md must state the exception explicitly.

**Step 2 — core (pure, headless-tested).**
- **Routing:** replace the unconditional `phone_form_factor` blocker with evidence-based rules. A phone runs on the device when the page is cross-origin isolated, OPFS is writable (not Private Browsing; the page probes it, core takes it as a capability), the artifact is Stage IV, and there is no crash flag. Keep `crash_flag`, `battery_low` and the server option.
- **Limits:** `LOCAL_LIMITS.maxDurationSecWasm = 30` predates streaming; replace it with a measured cap. ≈ 13 s per 5.85 s of song at 1 thread puts a 10-min song at ≈ 22 min; pick a cap with the owner. Add a storage check: stems need stems × (44 + frames × 2 channels × 3 bytes), so move that `need` calculation from `MobileBenchmark.tsx` into core.
- **Memory projection:** `projectPeakMemory` assumes `inputCopies: 2, retainedOutputStems: 6`. With OPFS streaming, retained stems are ≈ 0. Model the Stage IV heap as measured (616 MiB reserved / 510 MiB touched on the iPhone), plus the decoded input (≈ 85 MB for 4 min).
- **Stem choice:** on the device only `full` (six stems) exists; `guitar` (lead/rhythm) stays server-only. To save storage, let the user pick which stems to keep and write only those. All six are computed anyway; only writing is skipped.

**Step 2b — resume a stopped run (owner's 6.7-min run was lost by switching apps).** Today `MobileBenchmark.tsx` terminates the worker on `visibilitychange` (hidden), and the stems so far stay in OPFS as `partial`.
- **Resume.** The stems are written in order, so a partial file holds every frame up to the last finalised block: frames written = (size − 44) / frame bytes, and `storedStem` already gives the expected total. On return, restart the engine at the window covering the first unwritten frame, recompute the window before it (the overlap-add needs its tail) and append.
- **Core (pure, tested).** `separate()` needs a start option (a chunk index or frame). The test: a resumed run must equal an uninterrupted run bit for bit.
- **Keep the input.** The decoded song must survive a reload: store it in OPFS (float32 or 16-bit PCM; validate if lossy), or re-decode the original file the user picks again, checked by size + hash.
- **Possibly don't terminate on hide.** iOS freezes a backgrounded tab's JavaScript, and if the tab is not killed, the worker can continue on return. Measure this on the device. Resume covers the killed case either way.
- **UX.** Say plainly that leaving Safari pauses or stops the run, show "Resume" for a partial run, and keep the wake lock.

**Step 3 — web.**
- **Main worker:** `apps/web/src/inference/worker.ts` loads one file with `graphOptimizationLevel: 'all'` and up to 4 threads. For Stage IV it must use the settings from `mobile-stage4.worker.ts`: graph optimisation disabled, external data, the capped `WebAssembly.Memory` and the `em-pthread` guard. The simplest route is to move that worker's session code into the main path.
- **Model cache:** the card fetches the 124 MiB model every run and relies on the HTTP cache (Pages: `max-age=600` plus ETag). The main app needs a verified persistent cache for both files: extend `platform/model-cache.ts` (one file today) to the pair, with SHA-256 check and corrupt-entry eviction.
- **Playback:** `audio/stem-player.ts` decodes stems into `AudioBuffer`s. Six decoded stems of a 6.7-min song are ≈ 850 MB of float32, which is too much for a phone. Play from the OPFS `File`s (media elements kept in sync, or decode on demand), and export or download straight from OPFS.
- **Keep from the card:** the wake lock, the stop on a hidden page, the crash marker, the stored-stem scan and delete (`storedStem`), freeing old stems before the quota check, and the Private Browsing explanation.

**Step 4 — verify.**
- `npm test`, `npm run typecheck`, `npm run build:web`, plus the mobile-graph CI gate.
- The real app in Playwright Chromium and WebKit. WebKit setup: `PLAYWRIGHT_BROWSERS_PATH=<scratch> node <global playwright>/cli.js install webkit && … install-deps webkit`. Use `launchPersistentContext` for a normal tab and `newContext()` for Private-Browsing behaviour.
- Then the iPhone, in a normal tab with Low Power Mode off.

### Stage V progress — 2026-11-25 (branch `claude/nice-ptolemy-rfgfsf`)
Done in this session: the measurement that the step 1 decision needs, and step 2b (resume), both of which are needed whether the owner picks A or B. Step 0 numbers are still missing; the step 1 decision is still open.

**Step 1 evidence: Stage IV vs production fp32, measured directly [M].** `compare-models.ts` (onnxruntime-node CPU, 4 threads; the candidate opened with `--candidate-graph-opt disabled`, as the browser runs it), all 8 MP3s in the repo root, 3 windows each, the three verified files (production `a3f50506…`, fp16w `1333aa4a…`, Stage IV `a343b853…` + `514978cf…`). The script now also prints each worst stem's level and its error level re mix.
- **Minimum per stem, fp32 → Stage IV, all 8 songs: 40.1 dB** (piano, *Feel Like Makin' Love*). Next: 45.5 (piano, *Get To Know Ya*), 45.8 (drums, *Whenever Wherever Whatever*); every other song ≥ 47.8 on every stem. It passes the 40 dB contract, by 0.1 dB. The handoff's "≈ 49 dB **[E]**" was wrong.
- **Decomposed on the three lowest songs:**

  | Song, worst stem | fp32 → fp16w | fp16w → Stage IV | fp32 → Stage IV | Stem level | Error level |
  |---|---:|---:|---:|---:|---:|
  | *Feel Like Makin' Love*, piano | **39.3** | 59.6 | 40.1 | −63.5 dB re mix | −103.6 dB re mix |
  | *Get To Know Ya*, piano | 45.5 | 65.9 | 45.5 | −50.1 | −95.6 |
  | *Whenever Wherever Whatever*, drums | 45.7 | 66.3 | 45.8 | −57.8 | −103.6 |

  - **The Stage IV rewrites cost nothing measurable.** fp32 → Stage IV equals fp32 → fp16w within 0.8 dB on every stem of every song. fp16w → Stage IV is ≥ 50.1 dB everywhere (≥ 59.6 on all but one near-silent bass).
  - **The fp16-weight model alone fails the literal contract on this song (39.3 dB).** ARCHITECTURE.md's "fp16w ≥ 49.2 dB vs fp32" held on the clips it was measured on, not in general; corrected there.
  - **Every figure below 49 dB is on a stem at −50 dB re mix or quieter** (no piano or drums in that window). The absolute error stays at about −96 to −104 dB re mix. Stems above −25 dB re mix are ≥ 53.1 dB. Errors on loud stems reach about −63 dB re mix (fp16 weight rounding).
  - **Why this matters for the contract:** per-stem SNR on a near-silent stem measures how quiet the stem is. It is the same effect as the tone fixture (above), now on real music. For comparison: native vs native errors are about −140 dB re mix, and the WASM reduction defect that Stage IV fixed produced errors up to −61 dB re mix.
- **Proposal for the owner (not applied):** keep 40 dB SNR as the rule, and also pass a stem whose error is ≤ −90 dB re mix (equivalently: quiet stems are judged by absolute error). On these data every case then passes with ≥ 5.6 dB margin, and the old WASM defect (−61 dB) still fails. Without an amendment, option A promotes an artifact whose own fp16 source fails the contract on a real song, and any new song may fail it.

**Step 2b: resume a stopped run — built [M].**
- **Core (`packages/core/src/separation/resume.ts`, headless-tested):**
  - `separate({ startChunk })`: re-runs chunk k − 1 into a fresh accumulator only to rebuild the overlap tail, discards its block, then continues. The proof is in the file header: before chunk k − 1 is added, its accumulator region [S, N) is zero, and O < S, so the tail depends on chunk k − 1 alone. `StreamingOverlapAdd` takes a first chunk index.
  - `decideResume(manifest, expectation, sizes)`: from file sizes only. It trusts whole frames, up to the last stride boundary every stem reached. That covers a write torn mid-block, stems that stopped at different blocks, and a missing or torn header (restart at 0). Model, geometry, format, stem order or input mismatch → `unusable` with a reason, never a wrong resume.
  - `RunManifest` (`run.json`, strict type guard `isRunManifest`), `interleavedFileSource` / `encodeInterleavedF32` (stored song, float32 LE interleaved, lossless), `wavStemSink(..., { resumeFrom })`, `runStorageNeed` (the storage `need` moved from the card into core, now counting the stored song), `STAGE4_RESUME_EXPECTATION`.
  - Tests (`packages/core/test/resume.test.ts`, 18): stop before every chunk of five song lengths, decide from the real byte sizes, truncate, resume → **stem files byte-identical** to an uninterrupted run; torn writes; mismatches; manifest fuzzing. Mutation check: removing the tail re-run fails 4 of the 5 multi-chunk cases (and the ETA test).
- **Worker (`mobile-stage4.worker.ts`):**
  - A new song is first written to OPFS as `input.f32` (1 MiB blocks), then `run.json`, then windows are read back from the file. The worker drops its copy of the song after that, so its memory no longer includes the decoded song (not measured on a device).
  - `resume` reads the sizes, truncates and continues. The stored song is deleted when the stems are complete.
  - Resuming at another thread count is allowed and logged. Quality is the same (≥ 84 dB at every count), but bit-identity at the seam is only guaranteed at the same count.
- **Card:** after a stop, a reload or a killed tab, it shows "N of M windows are finished" and a **Resume** button with the time left. It says that switching apps or locking the phone stops the run. Download names come from `run.json`, so they survive a reload. A killed tab still shows "Previous test was interrupted" first: acknowledge it, then Resume.
- **Real app, headless Chromium, 4 threads, 45 s of *D'Angelo – Lady* (8 windows)** (`scripts/e2e/stage4-resume.mjs`): **PASS.**
  - Run A, uninterrupted: 8 windows, about 60 s, heap 515–613 MiB reserved / 491–507 MiB touched.
  - Run B: stopped by a hidden page after window 2, then reloaded, and the card offered "2 of 8 windows are finished". Resumed. Then the renderer was **crashed** mid-window 6 (CDP `Page.crash`, so no events run). A new tab showed the interruption marker and "5 of 8"; it was acknowledged and resumed to the end.
  - All six stems are **byte-identical** (SHA-256) to run A, and `input.f32` was removed.
  - **Bug the test found, now fixed:** `Worker.terminate()` releases OPFS sync-access-handle locks asynchronously. Resume 250 ms after a stop failed with `NoModificationAllowedError`. The worker now retries the lock (50 ms … 3.2 s, about 6 s in total). The page's scan tells "locked" from "missing", so it never shows a false "0 of 8", and it rescans until the locks clear.
  - **Test gotcha:** in Chromium a reload or navigation is not a kill. It fires `visibilitychange` first, so the card stops cleanly. Use `Page.crash`.
  - **WebKit (JavaScriptCore, persistent profile, 4 threads, `--webkit`): PASS.**
    - Same steps; the kill is approximated by closing the whole browser mid-window 6. WebKit ran the page-hidden stop first, so no interruption marker was left.
    - Resume point "5 of 8", and all six stems byte-identical to WebKit's own uninterrupted run.
    - Chromium and WebKit hashes differ from each other (different float kernels, as before); each engine is exact against itself.
    - One benign console line ("access control checks" on a blob URL): an `<audio>` element whose object URL the rescan had revoked.
- **Storage cost:** the stored song is 8 bytes per frame, about 85 MB for 4 min (+22 % over the 24-bit stems), held only until the stems are complete. The quota check counts it.
- **Not done:** whether iOS freezes or kills a hidden tab's worker (the card still stops on hide; resume makes that cheap); the physical-iPhone test.
- **Not run here:** `python -m unittest scripts/test_mobile_memory.py` (the sandbox has no `onnx` package; no Python changed; CI runs it).

**Next session:** step 1 is done (below). Build step 2 (phone routing, limits, memory projection with the measured v2 heap), then 3 and 4. Step 0 iPhone thread numbers are still welcome but no longer block.

### Stage V step 1 — done: option A, Stage IV is the primary on every tier (2026-11-25) [M]
**Owner decisions (2026-11-25):** option A; the level-aware parity rule; and a standing rule to make improvements by judgment, documented and easy to retrace.

**What changed (rollback = one line: `PRIMARY_SEPARATION_MODEL = HTDEMUCS_6S_FOLDED` in `registry.ts`):**
- **Core**
  - The parity contract is now `stemParity()` in `dsp/metrics.ts`: per stem, SNR ≥ 40 dB, **or** error ≤ −90 dB re mix. It works from energies, so a silent reference stem is judged by its error, and NaN output always fails. Tests in `test/parity.test.ts`. `compare-models.ts` uses it and exits non-zero on any failing window.
  - Registry: `HTDEMUCS_6S_STAGE4`, with an `externalData` pinned file, per-tier `graphOptimization` (server/native `all`, browser `disabled`), `browserWasmMemoryCapPages` and `epSupport.webgpu: 'unsupported'`. `downloadBytes()` counts graph + data.
  - Bug fixed: routing's storage check and `projectPeakMemory` used `model.bytes`, the 1.2 MB graph only. A routing test caught it.
  - `MOBILE_STAGE4_CANDIDATE` now derives from the registry entry. `decideResume` identifies a model by graph SHA-256, not by its id label, so stored runs on a phone stay resumable across the rename.
  - Routing skips WebGPU for a model that cannot be placed there.
  - `LOCAL_LIMITS.maxDurationSecWasm` is raised from 30 s to 90 s. The 30 s came from a "5–10× slower" estimate; measured v2 WASM at 4 threads runs about real time.
- **Server:** `ensureModel` fetches and verifies both files and stores the data under the name the graph records (data first, so a graph without data is never "ready"). `createOrtRunner` verifies both and takes graph optimisation from the registry. New `scripts/bench-artifact.ts` benches any ONNX file outside the registry.
- **Web**
  - `platform/model-cache.ts` caches every file of an artifact under its SHA-256. A cached entry with the wrong size is evicted and downloaded again, and other versions are dropped. Headless tests are in `apps/web/test/model-cache.test.ts`.
  - The main `worker.ts` is registry-driven:
    - plain WASM build (JSEP only for `webgpu`);
    - graph optimisation `disabled` for the browser;
    - `externalData`, with the download buffers dropped after `create()`;
    - the capped `WebAssembly.Memory` from the shared `inference/wasm-memory.ts`, also used by the card.
- **CI:** the `separate.yml` model-cache key follows the primary.

**Measured**
- **Promotion gate:** 16 / 16 PASS (8 songs × 3 windows × both session settings). Every stem passes on SNR alone, min 40.1 dB; the amendment is headroom for new material.
- **Server bench:** RTF 0.44–0.46 vs 0.58–0.62 for v1, peak RSS 1.50–1.59 vs 2.76 GiB. Optimisation `all` is about 7 % faster than `disabled` on the server, with the same memory and parity.
- **CLI:** `models fetch` from the registry URLs into an empty directory, then a full 267 s song, works end to end.
- **Headless Chromium, main app** (`browser-smoke.mjs --server`): device path, 6 stems in 27.6 s for a 10 s clip. **Browser WASM vs server CPU: 91.8 dB**, up from 64.3 dB with v1, because the tiers now run one graph. The server path gives 7 stems.

**Production bug found and fixed on the way:** `local-client.ts` aborted local runs on Compute Pressure `critical`. Chromium derives that state from CPU utilisation, so the run's own 4-thread load reached `critical` 15 s in, and the client terminated the worker 5 s later, mid-window. It looked like a hang (1 thread passed). This was latent for every Chromium desktop run at full threads, and the v1 E2E passed only because older headless Chromium lacked `PressureObserver`. The guard is removed, with the reasoning in the file header. Bisection, in order: 1 thread passes; `proxy`/`logLevel` are not it; block transfer is not it; the card at 4 threads passes; the observer was logged going fair → serious → critical.

**Hosting note:** the registry URLs point at the GitHub Pages copy. `pages.yml` rebuilds it deterministically and refuses to deploy unless the SHA-256 pins match, and every loader verifies the pins, so drift fails loudly. An immutable GitHub Release asset would be sturdier long term.

**Not changed (next PR: Stage V step 2):**
- Phones still route to the server (`phone_form_factor`).
- `budget.ts` still uses the v1 activation estimates (2000 MiB). That over-estimates v2, so routing errs towards the server, never towards unsafe.
- Main-app playback still decodes stems into memory.

### Stage V step 2 — done: phones and tablets separate on device in the main app (2026-11-26)
**Routing (core, `capability/routing.ts`), by evidence instead of form factor.** A non-desktop device (phone or tablet) takes the **disk path** when all of these hold:
- the artifact has a measured `browserHeapBytes` (v2: 616 MiB, iPhone);
- OPFS is writable (`caps.opfsWritable`, probed with `getDirectory()`; false in Safari Private Browsing);
- the page is cross-origin isolated;
- the battery is fine and the device does not report 2 GiB or less;
- the song is ≤ `LOCAL_LIMITS.maxDurationSecMobile` (600 s);
- the disk-run projection fits the platform ceiling;
- storage holds the model (when not cached) plus the projected stems plus the stored song.

Notes on these rules:
- `deviceMemory` unknown is **not** a blocker on this path: the heap was measured on an iPhone, which does not report it.
- New reasons: `mobile_profile_unmeasured`, `storage_not_writable`, `insufficient_storage_for_stems`. `phone_form_factor` and `device_memory_unknown_mobile` are gone.
- The owner's iPhone sends a desktop-class UA ("Macintosh … Version/27.2"), so `classifyUserAgent` calls it a **tablet**. The rules key on "not desktop" for that reason, and a test pins it.
- The crash marker blocks only the in-memory (desktop) path. A killed disk run resumes, so phones are never locked out. Desktop without a server: the banner offers "Try on this device again", which clears the marker; before, the lock-out was permanent.

**Memory (`projectDiskRunPeak` in `memory/budget.ts`).** The projection is the larger of two phases, which do not overlap:
- **decode:** the file plus `DISK_RUN_DECODE_COPIES` = 3 decoded copies. The AudioBuffer and the transfer copies are certain; one resampler temporary is an allowance **[E]**.
- **separation:** the measured heap plus overlap-add state plus one block in flight.

Results: 665 MiB for a 45 s song, ≤ 1 GiB at the 10-minute cap.

**Also in core:**
- `deviceOutputs(scope)`: Full writes 6 stems, Quick writes 4 (guitar and piano folded into other), so 33 % less storage.
- `resumeExpectationFor(model, outputs)`: the written outputs are part of a stored run's identity.
- `deviceThreads()`: 1 on phones and tablets until step 0 is measured; up to 4 on desktop.
- `estimateDeviceSeconds()`: from the measured seconds per window (iPhone 12.5 s at 1 thread; 4 vCPU 18.0 / 10.1 / 5.7 s at 1 / 2 / 4).

**Web**
- `inference/disk-run.ts` is the worker-side runner, extracted from the card: store the song, write `run.json`, separate from the stored file into the scope's projected stems, resume, lock retry. The card and the main app share it.
- `device-run.worker.ts` opens the session from the verified persistent model cache, with registry settings.
- `inference/disk-run-client.ts` handles the lifecycle:
  - page hidden → pause;
  - battery low → pause;
  - a wake lock while running;
  - no crash marker.
- `platform/disk-store.ts` scans the stored run (complete / stopped / unusable / busy) and deletes it.
- In the session, the stored run's bytes count as free, because a new run replaces it. That is the card's lesson: free before the quota check.
- UI:
  - `components/StoredStems.tsx` (was `StoredRun.tsx` before the redesign) plays finished stems straight from OPFS and saves them (share sheet → Files on iOS, else a download). They survive reloads.
  - The panel shows a paused run with **Resume**; "Delete from this device" frees the space.
  - A **Pause** button appears while a run is going.
  - The choose screen shows the estimate, the space needed and that leaving Safari pauses the run (since the redesign; before, a routing banner).

**Verified** (`scripts/e2e/device-disk-run.mjs`, real app, Playwright iPhone 15 emulation, 45 s of *D'Angelo – Lady*, 1 thread): **PASS in Chromium and in WebKit [M].**

| Check | Chromium | WebKit (JavaScriptCore, persistent profile) |
|---|---|---|
| Routing | disk path, projected peak 665 MiB | same |
| Full scope, uninterrupted: per-stem SNR vs server CLI, same clip | 85.1–95.0 dB | 93.7–107.0 dB |
| Full stems vs the experimental card's stems | byte-identical (same SHA-256) | byte-identical |
| Quick scope: `other` (other + guitar + piano) vs server quick | 90.3 dB | 96.7 dB |
| Quick: vocals, drums, bass vs full | byte-identical (projection only sums into `other`) | byte-identical |
| Stored song after completion | removed | removed |
| Stems after a reload | offered | offered |
| Quick paused after 2 / 8 windows → reload → Resume | "2 of 8 windows are finished"; resumed stems byte-identical | same |

Bugs found by these runs and fixed:
- **Resume did nothing in WebKit after a reload.** The stored-run panel appeared before the capability probe resolved, and `resumeStored` silently returned while `caps` was null. It now waits for the probe; after the fix, Resume starts within 1 s.
- **The old stems stayed on screen** while a new run deleted them. They are now hidden first.
- **Pause was only offered once windows were running.** It is now shown for the whole run, model download included.

Cosmetic: WebKit logs "Context is stopped" on a reload after a pause (an audio context torn down by the navigation).

**Not done:**
- A **mixer** with synchronised playback of all stems from disk. Six decoded stems of a long song do not fit in phone memory; options are a streamed mix-down to one file, or synced media elements. Each stem plays on its own today.
- Step 0 (iPhone 1/2/4 threads).
- The physical-iPhone test of the main app.
- Whether iOS freezes rather than kills a hidden tab.
- An immutable hosting URL for the model.

**Later (unchanged):** further exact memory cuts (chunk the frequency-branch DConv along its 512-row batch; run the ISTFT tail per source; both remove 63 MiB tensors); other devices (iPads, older iOS → ORT 1.23.2, Android Chrome); WebGPU (static shapes, shader-f16, GPU-process memory on iOS).

## Stage IV — remaining work (historical list; Stage V above supersedes items 1, 2 and 4)


1. ~~Physical iPhone: session create, one window, repeated windows~~ **done 2026-11-24 (above).** Still to test: other iPhones/iPads (old iOS → ORT 1.23.2) and Android Chrome. Read `[stems …]`-style labels from the start: record ORT version, Safari version and touched heap. For Safari < 17.5 use the pinned ORT 1.23.2 plain build (microsoft/onnxruntime#33426; see the lessons section).
2. App integration behind the experimental benchmark (Stage III item 3). The worker loads graph + `.data` with `externalData`, each file SHA-256-verified and cached, and drops its reference to the data buffer after `create()`. Use one thread, graph optimisation disabled, a verified cache, transferable buffers, cancellation, crash marker and worker termination. The registry needs two pinned hashes (graph + data).
3. Further exact memory cuts. Chunk the frequency-branch DConv along its 512-row batch (every op there is per row; replace constant batch dims in Reshape targets with 0). Run the ISTFT tail per source (batch 12 → 2). Both remove 63 MiB tensors, the new peak.
4. Full tracks: **built**, and the first physical-iPhone song passed (43.2 s, memory flat, above). Next: rerun with Low Power Mode off for the speed baseline, and a 4-min song (≈ 41 windows, ≈ 380 MB of stems). Threads are built (selector above, Chromium and WebKit verified); measure 2 and 4 on the iPhone, then pick the default. Original note: one session reused across windows (touched memory 479–510 MiB over 3 windows on the iPhone). Store stems without holding six float32 copies of the song, which is 508 MB for 4 min stereo: Int16 (254 MB, validate quantisation) or OPFS streaming (≈ 0). Recycle the worker if the heap creeps. Then try 2–4 threads for speed, since the device reported crossOriginIsolated true and 4 cores.
5. WebGPU variant: static shapes, plus a shader-f16 device or fp32 weights for SwiftShader, plus GPU-process memory measurement on iOS.
6. Promotion rule unchanged: one artifact on every tier, parity ≥ 40 dB per stem (now on the music fixture), `npm test`, `npm run typecheck`, `npm run build:web`, licences and musical quality before production.

## Files and reproduction
scripts/fold_webgpu.py; scripts/mobile_graph.py; scripts/mobile_memory.py (Stage IV passes + simulator); scripts/test_mobile_memory.py; scripts/mobile_fixture.py (music fixture); scripts/mobile-webgpu-check.mjs (`ORT_MODEL`, `ORT_MODEL_DATA`, `ORT_FIXTURE`, `ORT_RUNS`, `ORT_THREADS`; reports `wasmHeapMiB` per phase; validation fails unless every requested run completed); .github/workflows/mobile-graph.yml; apps/web/src/inference/mobile-bench.worker.ts; apps/web/src/components/MobileBenchmark.tsx (experimental card: song path, stored-stem scan, Private Browsing probe, threads); apps/web/src/inference/mobile-stage4.worker.ts + stage4-protocol.ts; packages/core/src/models/mobile-experimental.ts (Stage IV pins, `stage4Threads`, memory cap); packages/core/src/codec/stem-wav-sink.ts (`wavStemSink`, `storedStem`); packages/core/src/models/registry.ts; packages/core/src/capability/routing.ts; packages/core/src/memory/budget.ts; packages/core/src/separation/engine.ts.
CI downloads the source, checks SHA-256, runs `python scripts/mobile_graph.py source.onnx candidate.onnx graph-report.json`, then the unit tests and `python scripts/mobile_memory.py candidate.onnx candidate-memory.onnx memory-report.json --external-data --accurate-reductions`. It uploads `experimental-mobile-graph` (both candidates and both reports), and installs Playwright Chromium and ORT 1.23.2 in `ort-compat`. The workflow generates `reference-input.bin`, `reference-source.bin` and `reference-candidate.bin` and runs the WASM and WebGPU compatibility matrix. The gate is the Stage IV candidate with `ORT_FIXTURE=music ORT_VALIDATE=1` for `ORT_PINNED=0` and `1`, compared against native source and native same-graph references. The PR #12 candidate on the tone fixture runs as a non-gating diagnostic. `browser-compatibility-results` is uploaded even when validation fails. Keep the same fixture, model hashes and runtime versions for comparisons. Artifacts expire after seven days.

## Deferred product direction
Potential Bandleader HQ integration with Tab Translator Pro, Chord Sheet Maker Pro, stage sheets, repertoire and gig prospecting; future Linux workstation with GPU for hybrid inference and commercial subscription platform. These are proposals, not implemented features. No paid infrastructure required for current research. Public GitHub inbox processing exposes uploaded audio; do not use for private recordings.

## Fresh-session prompt
Read CLAUDE.md, docs/ARCHITECTURE.md and this file (main branch; all Stage IV work through PR #19 is merged). Check the latest PRs and Actions runs before changing anything. Start Stage V:
1. Step 1 is decided and built: option A (Stage IV is the primary on every tier) and the level-aware parity rule, see "Stage V step 1 — done". Step 2b (resume) is built.
2. Steps 2 and most of 3 are built ("Stage V step 2 — done"): phones run on device in the main app with resume, playback and save from OPFS. Next:
   - the physical-iPhone test of the main app;
   - step 0 thread numbers (they set `deviceThreads` and `DEVICE_SECONDS_PER_WINDOW`);
   - a synced mixer from disk;
   - an immutable model URL.
3. The owner's standing rule (2026-11-25): make improvements by judgment, document them, keep every change easy to retrace.

Keep main-app routing for non-phone devices and the server path working. Do not repeat completed experiments. Tag numbers [M]/[V]/[E], and do not claim device results from Chromium or WebKit runs. Record measured results here as work progresses. Tab Translator Pro is not attached; its lessons are in the section above.
