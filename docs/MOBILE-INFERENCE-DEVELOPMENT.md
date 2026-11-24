# Mobile inference development — Engineering handoff

Checkpoint: 2026-11-24 UTC (Stage IV; first physical iPhone pass recorded). PR #12 and the Stage IV PR stacked on it remain open; experimental work is not production-approved. Stage IV below supersedes the Stage III remaining-work list.

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

## Cross-repository research (read-only)
Tab Translator Pro: https://github.com/quantumq1981/Tab-Translator-Pro/tree/main. Consult SYNHARMONICS-V2.md if available, stem-model-core.js, stem-model.js, stem-worker.js, tests/bench/ort-pin.mjs, tests/bench/scnet-e2e.mjs, tests/bench/split-mem-e2e.mjs, docs/AUDIT-2026-11-18.md, docs/SCORE-AUDIO-LINK.md, docs/AUDIO-TO-TAB-PLAN.md. No changes authorized to that repository.
- SCNet four-stem compact 2.8 s versus 11 s window is a precedent for re-export with fixed time-axis matrices; documented quality tradeoff ~2 dB SDR. Not a guitar/piano separator or direct HTDemucs substitute.
- Plain vendored ORT 1.23.2 WASM single-thread, arena/pattern off, compact graph optimization disabled; separate WebGPU path. Safari issues microsoft/onnxruntime#33426 and #26827 are relevant leads, not proof of our failure cause.
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

## Stage IV — remaining work (in order)
1. ~~Physical iPhone: session create, one window, repeated windows~~ **done 2026-11-24 (above).** Still to test: other iPhones/iPads (old iOS → ORT 1.23.2) and Android Chrome. Read `[stems …]`-style labels from the start: record ORT version, Safari version and touched heap. The WASM path should stay on the pinned 1.23.2 plain build, because of microsoft/onnxruntime#33426 (JSC on Safari < 17.5; see Tab Translator Pro `stem-model-core.js`).
2. App integration behind the experimental benchmark (Stage III item 3). The worker loads graph + `.data` with `externalData`, each file SHA-256-verified and cached, and drops its reference to the data buffer after `create()`. Use one thread, graph optimisation disabled, a verified cache, transferable buffers, cancellation, crash marker and worker termination. The registry needs two pinned hashes (graph + data).
3. Further exact memory cuts. Chunk the frequency-branch DConv along its 512-row batch (every op there is per row; replace constant batch dims in Reshape targets with 0). Run the ISTFT tail per source (batch 12 → 2). Both remove 63 MiB tensors, the new peak.
4. Full tracks (next): one session reused across windows (touched memory 479–510 MiB over 3 windows on the iPhone). Store stems without holding six float32 copies of the song, which is 508 MB for 4 min stereo: Int16 (254 MB, validate quantisation) or OPFS streaming (≈ 0). Recycle the worker if the heap creeps. Then try 2–4 threads for speed, since the device reported crossOriginIsolated true and 4 cores.
5. WebGPU variant: static shapes, plus a shader-f16 device or fp32 weights for SwiftShader, plus GPU-process memory measurement on iOS.
6. Promotion rule unchanged: one artifact on every tier, parity ≥ 40 dB per stem (now on the music fixture), `npm test`, `npm run typecheck`, `npm run build:web`, licences and musical quality before production.

## Files and reproduction
scripts/fold_webgpu.py; scripts/mobile_graph.py; scripts/mobile_memory.py (Stage IV passes + simulator); scripts/test_mobile_memory.py; scripts/mobile_fixture.py (music fixture); scripts/mobile-webgpu-check.mjs (`ORT_MODEL`, `ORT_MODEL_DATA`, `ORT_FIXTURE`, `ORT_RUNS`; reports `wasmHeapMiB` per phase; validation fails unless every requested run completed); .github/workflows/mobile-graph.yml; apps/web/src/inference/mobile-bench.worker.ts; apps/web/src/components/MobileBenchmark.tsx; packages/core/src/models/registry.ts; packages/core/src/capability/routing.ts; packages/core/src/memory/budget.ts; packages/core/src/separation/engine.ts.
CI downloads the source, checks SHA-256, runs `python scripts/mobile_graph.py source.onnx candidate.onnx graph-report.json`, then the unit tests and `python scripts/mobile_memory.py candidate.onnx candidate-memory.onnx memory-report.json --external-data --accurate-reductions`. It uploads `experimental-mobile-graph` (both candidates and both reports), and installs Playwright Chromium and ORT 1.23.2 in `ort-compat`. The workflow generates `reference-input.bin`, `reference-source.bin` and `reference-candidate.bin` and runs the WASM and WebGPU compatibility matrix. The gate is the Stage IV candidate with `ORT_FIXTURE=music ORT_VALIDATE=1` for `ORT_PINNED=0` and `1`, compared against native source and native same-graph references. The PR #12 candidate on the tone fixture runs as a non-gating diagnostic. `browser-compatibility-results` is uploaded even when validation fails. Keep the same fixture, model hashes and runtime versions for comparisons. Artifacts expire after seven days.

## Deferred product direction
Potential Bandleader HQ integration with Tab Translator Pro, Chord Sheet Maker Pro, stage sheets, repertoire and gig prospecting; future Linux workstation with GPU for hybrid inference and commercial subscription platform. These are proposals, not implemented features. No paid infrastructure required for current research. Public GitHub inbox processing exposes uploaded audio; do not use for private recordings.

## Fresh-session prompt
Read CLAUDE.md, docs/ARCHITECTURE.md and this file on the newest mobile branch (Stage IV: `claude/sweet-pascal-h1pafr`, stacked on PR #12). Inspect latest PR and Actions logs before modifying anything. Continue at Stage IV remaining work, item 1. Preserve production behavior and leave Tab Translator Pro untouched. Do not repeat completed experiments or claim mobile readiness from CI. Update this handoff with measured results as work progresses.
