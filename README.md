# Guitar & Piano Stem Extract

Mobile-first stem separation that isolates **guitar (lead and rhythm)** and **piano** from mixed music.

| Tier | What | Where |
|---|---|---|
| 1 | Server separation, the guaranteed path for phones and tablets | `packages/server` (Node, onnxruntime-node, FFmpeg) |
| 2 | In-browser separation for capable desktops (WebGPU, or multithreaded WASM) | `apps/web` (React PWA, onnxruntime-web) |
| shared | Routing, memory budgets, chunked overlap-add engine, WAV codec, API contract | `packages/core` (pure TypeScript, zero dependencies) |

Every tier runs the same sha256-pinned ONNX model, `htdemucs_6s`, constant-folded for WebGPU. The shared engine means the browser and server outputs match to **64 dB SNR**.

Design and measurements: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). API and CLI: [`docs/API.md`](docs/API.md). Original brief: `Guitar -Piano-ASE-Separation App.md`.

## Quick start

Requires Node ≥ 22.18, which runs `.ts` files directly, and FFmpeg built with libsoxr.

```bash
npm install
npm test                      # 67 headless unit + API integration tests
npm run typecheck
npm run models:fetch          # 285 MB, sha256-verified into models/

# Separate a track locally (same pipeline as the server)
node packages/server/src/cli.ts separate "D'Angelo - Lady.mp3" --scope guitar --format wav24,mp3

# Run the API + PWA
STEMSPLIT_SIGNING_SECRET=dev node packages/server/src/cli.ts serve --port 8787
VITE_API_BASE=http://localhost:8787 npm run dev:web
```

## Scopes

| Scope | Stems | Runs on |
|---|---|---|
| Quick | vocals, drums, bass, other | device or server |
| Full | + guitar, piano | device or server |
| Guitar focus | + lead / rhythm guitar split | server only |

The lead/rhythm split is currently a labelled DSP heuristic (`spatial-similarity-v0`), because no openly licensed ML model exists yet. Piano refinement (Banquet) is stubbed for licensing reasons. See the architecture doc §0.
