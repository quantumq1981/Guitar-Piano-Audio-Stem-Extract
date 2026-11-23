---
title: Stem Splitter API
emoji: 🎸
colorFrom: yellow
colorTo: indigo
sdk: docker
app_port: 8787
pinned: false
license: mit
short_description: Guitar/piano stem separation API (htdemucs_6s, ONNX)
---

# Stem Splitter: processing server

This Space runs `stemsplit serve`, the Tier 1 server for the Stem Splitter PWA, built from
https://github.com/quantumq1981/Guitar-Piano-Audio-Stem-Extract.

- Health check: `GET /v1/health`
- Model manifest: `GET /v1/models`
- Full API contract: `docs/API.md` in the GitHub repo

The Space has no app of its own; the PWA calls it. To rebuild from the latest `main`, use Settings → Factory rebuild.
