
---
Engineering Prompt: Mobile-First Web Stem-Separation Application (Guitar & Piano Focus) for Claude

Role & Primary Objective
You are a senior audio-ML systems architect specialising in resource-constrained inference. Design and specify a mobile-first, browser-based audio stem-separation application that isolates guitar (rhythm and lead) and piano from mixed music. The primary target is a Progressive Web App (PWA) that runs on phones and tablets, with a server-side offload tier as the guaranteed execution path for devices that cannot complete inference locally. A desktop/local path is a secondary, optional optimisation, not the baseline assumption. Every architectural decision must be justified against mobile memory ceilings, battery/thermal limits, and browser tab lifecycle constraints.

Prioritised Delivery Tiers (Design in This Order)

1. Tier 1 – Server-side separation (mandatory, default for mobile). Phones, devices reporting ≤ 4 GB RAM via navigator.deviceMemory, and browsers with a prior crash flag always route to the server. The server runs the same ONNX models as the client so outputs are byte-comparable; running different models on device and server creates an unfixable “server sounds different” debugging trap. Use a queue-backed container (e.g., Cloudflare Container with onnxruntime-node and FFmpeg) rather than synchronous request handling.
2. Tier 2 – In-browser inference for capable devices (progressive enhancement). Desktop Chrome/Edge and high-memory tablets attempt local separation via onnxruntime-web with WebGPU preferred, WASM fallback. Use the 4-stem htdemucs_ft ONNX model as the browser default, not the 6-stem model, because the 6-stem variant adds guitar/piano heads that increase memory pressure without guaranteeing mobile usability. If WebGPU is unavailable, cap on-device processing to short clips and warn the user.
3. Tier 3 – Native mobile wrapper (optional, for on-device privacy). If true on-device separation is required without a browser tab, specify a React Native / native iOS+Android path using onnxruntime-mobile with the same ONNX files; demucs-onnx explicitly supports this export path. Do not attempt to run the full pipeline inside a mobile browser WebView.

Core Separation Capabilities (Tiered by Execution Path)

Stage Server (Tier 1) Browser (Tier 2) Native (Tier 3)
Primary 6-stem (drums, bass, vocals, other, guitar, piano) ✅ htdemucs_6s or WebGPU-folded 6-stem ONNX ⚠️ Only if memory probe passes; otherwise 4-stem ✅ htdemucs_6s ONNX
Guitar lead/rhythm split ✅ MVSep Lead/Rhythm one-stage (Lead SI-SDR ≈ 6.43 dB, rhythm leakage ≈ 0.72 %) ❌ Never locally on mobile ⚠️ Optional if thermal budget allows
Piano refinement ✅ Banquet query-based model (outperforms HT-Demucs on piano at 24.9 M params) ❌ Server-only ❌ Server-recommended

Critical rule: The lead/rhythm guitar split and Banquet piano refinement are server-only operations on the mobile path. They are the computationally expensive stages that make the desktop product distinct, and they must never be attempted inside a phone browser.

Expected User Workflow (Mobile-First)

1. Open PWA on a phone or tablet. The client runs a capability probe: navigator.deviceMemory, WebGPU availability, and a localStorage crash-recovery flag.
2. Upload or record audio (MP3, WAV, FLAC, AAC, M4A, OGG; 16–48 kHz; mono or stereo). The client displays a routing banner: “Processing on this device” vs. “Processing on our servers” based on the probe.
3. Select separation scope: Quick (4-stem: vocals, drums, bass, other), Full (6-stem + guitar/piano), or Guitar-focused (6-stem → lead/rhythm split, server-only).
4. Processing: For server-routed jobs, show a queue position and estimated wall time (CPU inference runs at roughly 1–1.5× song length; cap server jobs at 6 minutes to stay within a 15-minute Durable Object alarm wall). For device-routed jobs, show per-chunk progress and a memory-pressure warning if the decoded buffer plus model weights exceed a conservative threshold.
5. Preview & export: Stem auditioning (solo/mute) using AudioBuffer / Web Audio; export WAV (16/24-bit), FLAC, or MP3. Server jobs return stems via R2/S3 with a 7-day expiry and a signed download URL.

Supported Input/Output Formats

· Input: MP3, WAV, FLAC, AAC, M4A, OGG; 16–48 kHz; mono/stereo; on-device duration cap of 90 seconds for browser inference (longer inputs auto-route to server).
· Output: WAV PCM 16/24-bit (default), FLAC, MP3 320 kbps; time-aligned to input; server outputs written at 44.1 kHz unless the input was higher.

Processing Requirements & Browser-Specific Architecture

· Model packaging: Use demucs-onnx pre-built ONNX models on Hugging Face (7 repos) and its copy-pasteable onnxruntime-web integration guide; the package bundles bundler configs and a zero-build demo scaffold. The install footprint drops from ~2 GB (PyTorch) to ~50 MB (onnxruntime) on the client.
· Chunking: Process audio in overlapping windows (e.g., 7.8 s segments with 25 % overlap) to bound peak memory. Do not load the entire decoded song into a single tensor on mobile; stream chunks from IndexedDB or an OPFS handle.
· WebGPU compatibility: The standard htdemucs_6s ONNX export contains an inverse-STFT ConstantOfShape op that the WebGPU execution provider cannot place. Use the constant-folded WebGPU-compatible variant (kramp/htdemucs-6s-webgpu-onnx), which is bit-identical to the base model but runs on WebGPU. For the 4-stem browser default, verify the htdemucs_ft export loads without transformer_memcpy session-creation errors; if it fails, fall back to WASM and downgrade to a shorter clip cap.
· Memory budget (hard constraints):
  · iOS Safari: Tabs are killed well before 2.5 GB; treat ~1.5 GB as the practical ceiling and abort locally if projected peak exceeds 1 GB.
  · WASM fallback: The heap caps around 1 GB; never attempt full-song WASM separation.
  · Server: Container CPU inference at ~7 s compute per 7 s audio on a 4-thread standard instance is acceptable; cap uploads at 40 MB / 6 minutes to respect the Durable Object wall limit.

Interface & Performance Considerations (Mobile as the Design Driver)

· PWA requirements: Service-worker-cached shell, offline model caching (WebGPU models ~80 MB after first load), background-sync queuing for server jobs, and Web Share API for exporting stems to other apps.
· Battery & thermal: Disable local inference when navigator.getBattery() reports < 20 % and not charging, and abort if the page becomes hidden during a chunk (mobile browsers throttle background tabs aggressively).
· Server-offload contract: The client must poll or subscribe to job status without keeping a socket open indefinitely; Durable Object alarms are the recommended queue primitive because they avoid polling loops.
· Quality target: Server outputs must match the desktop reference pipeline for the stages they share. The browser tier’s 4-stem output is explicitly lower fidelity than the server’s 6-stem + refinement path; communicate this in the UI rather than hiding it.

Deliverables to Produce in the Response

1. A tiered routing diagram (textual) showing the capability probe → local/server decision → queue → model selection → output path.
2. A concrete ONNX model inventory with Hugging Face repo identifiers and WebGPU compatibility notes (4-stem browser default, 6-stem WebGPU variant, MVSep lead/rhythm, Banquet).
3. A memory budget table covering iOS Safari, Android Chrome WebGPU, Android Chrome WASM, and server container peak RSS.
4. A PWA service-worker and caching strategy for model weights and intermediate audio.
5. A risk register focused on mobile-specific failure modes: silent tab kills, WASM heap exhaustion, WebGPU transformer_memcpy session failures, and thermal throttling.
6. A CLI/API contract for the server tier so the PWA and any future native wrapper share the same job submission and stem retrieval interface.

Constraints & Non-Goals

· Do not design a desktop-first application with a mobile afterthought. The prompt’s priority order is server-mobile → capable-browser → native; any architecture that assumes a 2.5 GB heap on the client is rejected.
· Do not run the lead/rhythm split or Banquet piano refinement in a mobile browser. These are server-only on the mobile path.
· Do not use different model checkpoints on client and server for the same stem stage. Use the same ONNX files everywhere to prevent output drift.
· The application must function without a cloud dependency for Tier 2 once models are cached, but Tier 1 is the guaranteed path for the majority of mobile users.

Tone & Format
Respond as a mobile systems engineering design document: lead with constraints, then architecture, then model choices, then failure modes. Use tables for budgets and a numbered tier structure. Define acronyms on first use (PWA, ORT, OPFS, RSS, EP). Cite concrete memory and latency numbers where available; flag where numbers are estimates rather than measured.
