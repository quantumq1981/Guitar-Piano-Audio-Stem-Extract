# Server Tier Contract (v1)

One contract is shared by the PWA, the `stemsplit` CLI and any future native wrapper.
The types and validators live in `packages/core/src/api/contract.ts`, the single source of truth, and are imported by both the client and the server.

---

## Lifecycle

```
awaiting_upload ─▶ queued ─▶ decoding ─▶ separating ─▶ [refining] ─▶ encoding ─▶ succeeded
       │              │          │            │              │            │
       └──────────────┴──────────┴────────────┴──────────────┴────────────┴─▶ failed | cancelled
succeeded | failed | cancelled ─▶ expired (after 7 days)
```

The transition table is enforced by `transition()` in `packages/core/src/jobs/state-machine.ts`; illegal jumps throw.

---

## Endpoints

| Method and path | Body / query | Success | Errors |
|---|---|---|---|
| `GET /v1/models` | — | `200 ModelManifest` (primary artifact + registry) | — |
| `GET /v1/health` | — | `200 {ok, queueDepth}` | — |
| `POST /v1/jobs` | `CreateJobRequest` JSON | `201 CreateJobResponse`; `200` on idempotent replay | `422 invalid_request`, `409 model_mismatch` |
| `PUT <upload.url>` | raw audio bytes (signed URL, 1 h expiry) | `202 JobRecord` (queued) | `403 bad_signature`, `409 already_uploaded`, `413 input_too_large`, `400 empty_upload` |
| `GET /v1/jobs/:id?since=<revision>` | long-poll up to 25 s; returns immediately if the revision advanced or the job is terminal | `200 JobRecord` | `404 job_not_found` |
| `GET <stem.url>` | signed URL, 7-day expiry | `200 audio/*` with `Cross-Origin-Resource-Policy: cross-origin` | `403`, `404`, `409 not_ready` |
| `DELETE /v1/jobs/:id` | — | `204` (cancels if running, purges files) | `404` |

Every error body has the shape `{ "error": { "code": string, "message": string } }`.

### `CreateJobRequest`

```jsonc
{
  "scope": "quick" | "full" | "guitar",
  "options": { "refinePiano": false, "formats": ["wav24", "mp3"] },   // wav16 | wav24 | flac | mp3
  "input": { "filename": "song.mp3", "bytes": 3481246, "contentType": "audio/mpeg", "durationSec": 207.8 },
  "clientModelSha256": "a3f50506…",   // or null; mismatch → 409
  "idempotencyKey": "[A-Za-z0-9_-]{8,128}"
}
```

### Scopes

Server-only means routing always sends the job to the server.

| Scope | Stems delivered | Server-only? |
|---|---|---|
| `quick` | vocals, drums, bass, other (other = other + guitar + piano) | no |
| `full` | vocals, drums, bass, guitar, piano, other | no |
| `guitar` | vocals, drums, bass, guitar_lead, guitar_rhythm, piano, other | **yes** |
| any scope with `refinePiano: true` | same stems as the scope | **yes** |

### `JobRecord` highlights

- `revision` is monotonic; clients long-poll with `?since=revision`.
- `queuePosition`, `progress {stage, fraction}` and `etaSec` drive the UI.
- `modelSha256` names the artifact that produced the stems.
- `stems[]` entries are `{stem, format, bytes, url, expiresAt, producedBy}`. `producedBy` names the model and any heuristic, for example `htdemucs_6s-stage4@…+spatial-similarity-v0`.
- `warnings[]` codes: `lead_rhythm_heuristic`, `piano_refinement_unavailable`, `input_resampled`, `input_downmixed`, `input_upmixed`, `clipping_in_output`.
- `error` is `{code, message, retryable}`. Codes: `input_too_long`, `decode_failed`, `inference_failed`, `unsupported_format`, `internal`, and others.

### Limits

| Limit | Value |
|---|---|
| Duration | ≤ 360 s |
| Upload size | ≤ 64 MiB |
| Input sample rate | 16–48 kHz |
| Output sample rate | 44.1 kHz, or the input rate if higher |
| Retention | 7 days |
| Long-poll | ≤ 25 s per request |

---

## CLI

The CLI uses the same engine and model as the server.

```bash
npm run models:fetch                                   # download + sha256-verify the canonical model (graph + external data)
node packages/server/src/cli.ts separate song.mp3 --scope guitar --format wav24,mp3 -o out/song
node packages/server/src/cli.ts serve --port 8787 --data .data/jobs   # env: STEMSPLIT_SIGNING_SECRET, STEMSPLIT_PUBLIC_URL, STEMSPLIT_CORS_ORIGIN
node packages/server/src/cli.ts submit song.mp3 --server http://localhost:8787 --scope full
node packages/server/src/cli.ts bench song.mp3 --seconds 31.2 --threads 4
node packages/server/src/cli.ts models list
```

`separate` writes `manifest.json` next to the stems. It records the input, scope, model sha256, warnings and per-stem peak levels.
