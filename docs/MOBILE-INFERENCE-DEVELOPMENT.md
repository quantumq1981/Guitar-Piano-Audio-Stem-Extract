# Mobile inference development — Stage II handoff

Checkpoint: 2026-11-24 UTC. PR #12 remains open; experimental work is not production-approved.

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

### Latest checkpoint — run 45325896555, job 138215288412
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

## Stage III — next actions in order
1. Keep PR #12 open. Improve diagnostic gate to report all six stems on every run before failing; include reference RMS, error RMS, max absolute error, global SNR, repeat consistency and phase-specific memory. Keep strict 40 dB contract; explicitly label near-silent stems and investigate absolute errors without silently passing them.
2. Compare native source vs native candidate with identical optimization settings and fixture; then candidate native vs pinned and current WASM using identical bytes. Pin and record runtime versions. Test real licensed musical clips with meaningful guitar and piano energy. Separate numerical parity from ground-truth separation SDR/leakage.
3. Measure session-create, inference, repeated-window and cleanup memory separately; track process tree and PSS sampling coverage. Compare source and candidate; investigate shorter re-export or external DSP ISTFT if needed. Avoid unbounded constant folding (preflight shape/bytes, global budget); never fold learned weight Casts.
4. If memory/accuracy justify it, add isolated experimental WASM worker using matching pinned JS/WASM assets, single thread, disabled graph optimization, verified cache, transferable buffers, cancellation and crash recovery. Terminate worker on completion/failure; no main-thread retry. Keep production routing unchanged.
5. Physical iOS/iPadOS/Android test only after CI evidence and conservative memory assessment; start session-only then one window, then multi-window, then full song. Do not infer phone compatibility from Chromium success. OPFS or bounded audio streaming and incremental output for full tracks.
6. WebGPU research independent: analyze ISTFT Expand/Range/ScatterND dependencies, provider assignment and bounded folding, or externalize ISTFT with verified parity. No more blind optimization-level changes on phone.
7. Run npm test, npm run typecheck, npm run build:web before production changes. Review licenses, model hashes and real music quality before promoting any model.

## Files and reproduction
scripts/fold_webgpu.py; scripts/mobile_graph.py; scripts/mobile-webgpu-check.mjs; .github/workflows/mobile-graph.yml; apps/web/src/inference/mobile-bench.worker.ts; apps/web/src/components/MobileBenchmark.tsx; packages/core/src/models/registry.ts; packages/core/src/capability/routing.ts; packages/core/src/memory/budget.ts; packages/core/src/separation/engine.ts.
CI downloads source, checks SHA, runs python scripts/mobile_graph.py source.onnx candidate.onnx graph-report.json, uploads experimental-mobile-graph, installs Playwright Chromium and isolated ORT 1.23.2 in ort-compat, generates reference-input.bin and reference-output.bin, runs matrix with ORT_PINNED=0/1 ORT_PROVIDER=wasm/webgpu, then ORT_PINNED=1 ORT_PROVIDER=wasm ORT_VALIDATE=1 node scripts/mobile-webgpu-check.mjs. Inspect current branch before editing. Artifacts expire after seven days. User primarily works on mobile; CI is preferred over requiring desktop tools.

## Deferred product direction
Potential Bandleader HQ integration with Tab Translator Pro, Chord Sheet Maker Pro, stage sheets, repertoire and gig prospecting; future Linux workstation with GPU for hybrid inference and commercial subscription platform. These are proposals, not implemented features. No paid infrastructure required for current research. Public GitHub inbox processing exposes uploaded audio; do not use for private recordings.

## Fresh-session prompt
Read CLAUDE.md, docs/ARCHITECTURE.md and this file on the PR #12 branch. Inspect latest PR and Actions logs before modifying anything. Continue at Stage III step 1, preserve production behavior and leave Tab Translator Pro untouched. Do not repeat completed experiments or claim mobile readiness from CI. Update this handoff with measured results as work progresses.
