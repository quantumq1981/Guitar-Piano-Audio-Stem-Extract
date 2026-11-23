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

## GitHub Pages

Pages serves the **built** app from `apps/web/dist`, not the repository files. Before this is set up, the Pages URL just shows this README.

1. **Settings → Pages → Build and deployment → Source: "GitHub Actions"**. This is a one-time switch from "Deploy from a branch".
2. Push to `main`, or run **Actions → "Deploy PWA to GitHub Pages" → Run workflow**.
3. Open `https://<owner>.github.io/<repo>/`. On first load the service worker installs and reloads the page once to turn on cross-origin isolation (see below).

What works on Pages alone:

| Device | Quick / Full, ≤ 90 s (WebGPU) or ≤ 30 s (WASM) | Guitar focus, longer tracks, piano refine |
|---|---|---|
| Desktop Chrome / Edge | ✅ on-device (downloads the 285 MB model from Hugging Face once, then caches it) | needs a server |
| Phone / tablet | needs a server (by design: the model needs about 2.4 GiB of RAM) | needs a server |

To enable the server path, run `stemsplit serve` somewhere reachable over **HTTPS**. Then set the repository variable **`VITE_API_BASE`** (Settings → Secrets and variables → Actions → Variables) to that URL and re-run the workflow.

- **HTTPS is required:** an https page cannot call an http API (mixed content).
- **For quick testing**, tunnel a local server, for example `cloudflared tunnel --url http://localhost:8787`.
- **CORS:** the server allows all origins by default. Set `STEMSPLIT_CORS_ORIGIN=https://<owner>.github.io` to lock it down.
- **Signed links:** set `STEMSPLIT_PUBLIC_URL` to the tunnel URL so download links point at it.

Why the service-worker reload: multithreaded WASM needs `crossOriginIsolated`, which normally requires COOP/COEP response headers. Pages cannot set headers, so `public/sw.js` adds them to every same-origin response. Hosts that can set headers (Cloudflare Pages, Netlify) use `public/_headers` instead.

## Phone-only setup (no desktop needed)

Phones always process on a server, because the model needs about 2.4 GiB of RAM and a phone browser can't safely use that much. The simplest always-on, free, HTTPS server is a **Hugging Face Space**, and every step below works in a phone browser.

1. **Create the Space.** On huggingface.co: **New → Space**, choose SDK **Docker → Blank** and hardware **CPU basic (free)**, and make it **Public**. The PWA calls it directly, and private Spaces would need a login.
2. **Add the files.** In the Space's **Files** tab, add `README.md` and `Dockerfile` with the contents of `deploy/huggingface-space/` from this repo, replacing the default files. The build takes about 5–10 minutes.
3. **Configure the Space.** Under the Space's **Settings**:
   - **Secret** `STEMSPLIT_SIGNING_SECRET`: any long random string. It signs the download links.
   - **Variable** `STEMSPLIT_CORS_ORIGIN`: `https://quantumq1981.github.io`
4. **Check it.** Open `https://<hf-user>-<space-name>.hf.space/v1/health`. It should return `{"ok":true,...}`.
5. **Point the PWA at it.** On GitHub: **Settings → Secrets and variables → Actions → Variables → New**. Set `VITE_API_BASE` to `https://<hf-user>-<space-name>.hf.space`, then run **Actions → Deploy PWA to GitHub Pages → Run workflow**.
6. **Install the app.** On the phone, open `https://quantumq1981.github.io/Guitar-Piano-Audio-Stem-Extract/` and use **Share → Add to Home Screen**.

What to expect on the free tier:

- **Speed:** about 1–1.3× the track length (2 vCPU), so a 4-minute song takes about 5 minutes.
- **Sleeping:** the Space sleeps after a period without traffic. The first job afterwards shows "Waking the processing server…" for a minute or two; the app retries automatically.
- **Storage:** job files live in the container's `/tmp`, so a Space restart deletes results early.
- **Access control:** the API has no authentication yet. Anyone who finds the Space URL can submit jobs, which costs you nothing on the free tier but is shared capacity. Paid "CPU upgrade" hardware (8 vCPU) runs about 4× faster.
