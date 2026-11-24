# Mobile inference development — Engineering handoff

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

## Stage III — remaining work
1. Keep PR #12 experimental. Add a cleared real-music fixture with meaningful guitar and piano energy. Compare the source and candidate in Chromium WASM and native CPU on identical samples. Measure per-stem numerical parity separately from separation quality and leakage.
2. Repeat phase-specific memory profiling on source and candidate. Investigate a shorter re-export or external DSP ISTFT where measured savings justify it. Preflight constant-folded shapes and bytes with a global budget, and preserve learned weight Casts.
3. If memory and accuracy justify it, add an isolated experimental WASM worker with matching pinned JS/WASM assets, one thread, disabled graph optimization, a verified cache, transferable buffers, cancellation and crash recovery. Terminate the worker after completion or failure. Keep production routing and its safeguards.
4. Test physical iOS, iPadOS and Android after the CI and memory gates. Start with session creation, then move to a single window, multiple windows and full tracks. Use OPFS or bounded audio streaming and incremental output for full tracks.
5. Investigate WebGPU independently. Analyze ISTFT Expand, Range and ScatterND dependencies and provider assignment, or externalize ISTFT with verified parity.
6. Run `npm test`, `npm run typecheck` and `npm run build:web` before production changes. Review licenses, model hashes and musical quality before promoting any model.

## Files and reproduction
scripts/fold_webgpu.py; scripts/mobile_graph.py; scripts/mobile-webgpu-check.mjs; .github/workflows/mobile-graph.yml; apps/web/src/inference/mobile-bench.worker.ts; apps/web/src/components/MobileBenchmark.tsx; packages/core/src/models/registry.ts; packages/core/src/capability/routing.ts; packages/core/src/memory/budget.ts; packages/core/src/separation/engine.ts.
CI downloads the source, checks SHA-256, runs `python scripts/mobile_graph.py source.onnx candidate.onnx graph-report.json`, uploads `experimental-mobile-graph`, and installs Playwright Chromium and ORT 1.23.2 in `ort-compat`. The workflow generates `reference-input.bin`, `reference-source.bin` and `reference-candidate.bin` and runs the WASM and WebGPU compatibility matrix. It then runs `ORT_PROVIDER=wasm ORT_VALIDATE=1` with `ORT_PINNED=0` and `ORT_PINNED=1` and uploads `browser-compatibility-results` even when validation fails. Keep the same fixture, model hashes and runtime versions for comparisons. Artifacts expire after seven days.

## Deferred product direction
Potential Bandleader HQ integration with Tab Translator Pro, Chord Sheet Maker Pro, stage sheets, repertoire and gig prospecting; future Linux workstation with GPU for hybrid inference and commercial subscription platform. These are proposals, not implemented features. No paid infrastructure required for current research. Public GitHub inbox processing exposes uploaded audio; do not use for private recordings.

## Fresh-session prompt
Read CLAUDE.md, docs/ARCHITECTURE.md and this file on the PR #12 branch. Inspect latest PR and Actions logs before modifying anything. Continue at Stage III remaining work, item 1. Preserve production behavior and leave Tab Translator Pro untouched. Do not repeat completed experiments or claim mobile readiness from CI. Update this handoff with measured results as work progresses.
