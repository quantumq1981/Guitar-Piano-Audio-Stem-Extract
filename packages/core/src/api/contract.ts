/**
 * Server-tier job API contract (v1). Shared verbatim by the PWA, the CLI and any
 * future native wrapper. Validation is hand-rolled type guards so the core stays
 * dependency-free and runs in workers, Node and React Native alike.
 *
 * Endpoints (see docs/API.md for the full contract):
 *   POST   /v1/jobs                      CreateJobRequest  → 201 CreateJobResponse
 *   PUT    /v1/jobs/:id/input            raw audio bytes   → 202 JobRecord
 *   GET    /v1/jobs/:id?since=<rev>      long-poll (≤ 25 s) → 200 JobRecord
 *   GET    /v1/jobs/:id/stems/:file      signed download   → 200 audio/*
 *   DELETE /v1/jobs/:id                  cancel + purge     → 204
 *   GET    /v1/models                    model manifest     → 200 ModelManifest
 */
import type { ModelArtifact, StemName } from '../models/registry.ts';
import { isStemName } from '../models/registry.ts';

export const API_VERSION = 'v1';

export const SEPARATION_SCOPES = ['quick', 'full', 'guitar'] as const;
export type SeparationScope = (typeof SEPARATION_SCOPES)[number];

export const OUTPUT_FORMATS = ['wav16', 'wav24', 'flac', 'mp3'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const INPUT_EXTENSIONS = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'] as const;
export type InputExtension = (typeof INPUT_EXTENSIONS)[number];

export const SERVER_LIMITS = {
  /** 6 minutes. Keeps worst-case wall time inside one Durable Object alarm cycle with margin. */
  maxDurationSec: 360,
  /**
   * 64 MiB (spec said 40 MB). A 6-minute 16-bit 44.1 kHz stereo WAV is 63.5 MB,
   * so 40 MB would reject valid WAV input long before the duration cap.
   */
  maxUploadBytes: 64 * 1024 * 1024,
  minSampleRate: 16_000,
  maxSampleRate: 48_000,
  resultTtlSec: 7 * 24 * 3600,
  longPollMaxSec: 25,
} as const;

export const LOCAL_LIMITS = {
  /** Browser inference cap with WebGPU; longer inputs auto-route to the server. */
  maxDurationSecWebGpu: 90,
  /** Without WebGPU, WASM is ~5–10× slower; keep jobs short enough to survive tab throttling. */
  maxDurationSecWasm: 30,
  /** Disable local inference below this battery level when not charging. */
  minBatteryLevel: 0.2,
} as const;

export interface SeparationOptions {
  /** Banquet piano refinement — server-only. */
  readonly refinePiano: boolean;
  readonly formats: readonly OutputFormat[];
}

export interface CreateJobRequest {
  readonly scope: SeparationScope;
  readonly options: SeparationOptions;
  readonly input: {
    readonly filename: string;
    readonly bytes: number;
    readonly contentType: string;
    /** Client-side estimate; the server re-measures after decode and is authoritative. */
    readonly durationSec: number | null;
  };
  /** Client's pinned primary-model sha256; server rejects on mismatch to prevent drift. */
  readonly clientModelSha256: string | null;
  /** Idempotency key so background-sync retries do not create duplicate jobs. */
  readonly idempotencyKey: string;
}

export const JOB_STATUSES = [
  'awaiting_upload',
  'queued',
  'decoding',
  'separating',
  'refining',
  'encoding',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobStage = 'decode' | 'separate' | 'lead_rhythm' | 'piano_refine' | 'encode';

export interface StemArtifact {
  readonly stem: StemName;
  readonly format: OutputFormat;
  readonly bytes: number;
  /** Signed, expiring URL. */
  readonly url: string;
  readonly expiresAt: string;
  readonly producedBy: string;
}

export interface JobWarning {
  readonly code:
    | 'piano_refinement_unavailable'
    | 'lead_rhythm_heuristic'
    | 'input_resampled'
    | 'input_downmixed'
    | 'input_upmixed'
    | 'clipping_in_output';
  readonly message: string;
}

export interface JobError {
  readonly code:
    | 'input_too_long'
    | 'input_too_large'
    | 'unsupported_format'
    | 'decode_failed'
    | 'model_mismatch'
    | 'inference_failed'
    | 'stage_unavailable'
    | 'internal';
  readonly message: string;
  readonly retryable: boolean;
}

export interface JobRecord {
  readonly id: string;
  /** Monotonic revision; clients long-poll with ?since=<revision>. */
  readonly revision: number;
  readonly status: JobStatus;
  readonly scope: SeparationScope;
  readonly options: SeparationOptions;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly queuePosition: number | null;
  readonly progress: { readonly stage: JobStage; readonly fraction: number } | null;
  readonly etaSec: number | null;
  readonly durationSec: number | null;
  readonly modelSha256: string;
  readonly stems: readonly StemArtifact[];
  readonly warnings: readonly JobWarning[];
  readonly error: JobError | null;
}

export interface CreateJobResponse {
  readonly job: JobRecord;
  readonly upload: {
    readonly method: 'PUT';
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  };
}

export interface ModelManifest {
  readonly apiVersion: typeof API_VERSION;
  readonly primary: ModelArtifact;
  readonly all: readonly ModelArtifact[];
}

export interface ApiError {
  readonly error: { readonly code: string; readonly message: string };
}

/** Stems a scope delivers, and how each is formed from model outputs. */
export const SCOPE_OUTPUTS: Readonly<Record<SeparationScope, readonly StemName[]>> = {
  quick: ['vocals', 'drums', 'bass', 'other'],
  full: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'],
  guitar: ['vocals', 'drums', 'bass', 'guitar_lead', 'guitar_rhythm', 'piano', 'other'],
};

export function scopeRequiresServer(scope: SeparationScope, options: Pick<SeparationOptions, 'refinePiano'>): boolean {
  return scope === 'guitar' || options.refinePiano;
}

// ───────────────────────────── validation ─────────────────────────────

export type Validation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v);
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

export function validateCreateJobRequest(body: unknown): Validation<CreateJobRequest> {
  const errors: string[] = [];
  if (!isRecord(body)) return { ok: false, errors: ['body must be a JSON object'] };

  if (!oneOf(SEPARATION_SCOPES, body.scope)) errors.push(`scope must be one of ${SEPARATION_SCOPES.join(', ')}`);

  const options = body.options;
  let formats: OutputFormat[] = [];
  let refinePiano = false;
  if (!isRecord(options)) {
    errors.push('options must be an object');
  } else {
    if (typeof options.refinePiano !== 'boolean') errors.push('options.refinePiano must be boolean');
    else refinePiano = options.refinePiano;
    if (!Array.isArray(options.formats) || options.formats.length === 0) {
      errors.push('options.formats must be a non-empty array');
    } else {
      for (const f of options.formats) {
        if (!oneOf(OUTPUT_FORMATS, f)) errors.push(`unsupported format ${String(f)}`);
        else if (!formats.includes(f)) formats.push(f);
      }
    }
  }

  const input = body.input;
  if (!isRecord(input)) {
    errors.push('input must be an object');
  } else {
    if (typeof input.filename !== 'string' || input.filename.length === 0 || input.filename.length > 255) {
      errors.push('input.filename must be a 1–255 character string');
    } else if (!oneOf(INPUT_EXTENSIONS, extensionOf(input.filename))) {
      errors.push(`input extension must be one of ${INPUT_EXTENSIONS.join(', ')}`);
    }
    if (typeof input.bytes !== 'number' || !Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
      errors.push('input.bytes must be a positive integer');
    } else if (input.bytes > SERVER_LIMITS.maxUploadBytes) {
      errors.push(`input.bytes exceeds ${SERVER_LIMITS.maxUploadBytes}`);
    }
    if (typeof input.contentType !== 'string') errors.push('input.contentType must be a string');
    if (input.durationSec !== null && (typeof input.durationSec !== 'number' || !(input.durationSec > 0))) {
      errors.push('input.durationSec must be a positive number or null');
    } else if (typeof input.durationSec === 'number' && input.durationSec > SERVER_LIMITS.maxDurationSec) {
      errors.push(`input.durationSec exceeds ${SERVER_LIMITS.maxDurationSec}s`);
    }
  }

  if (body.clientModelSha256 !== null && !(typeof body.clientModelSha256 === 'string' && /^[0-9a-f]{64}$/.test(body.clientModelSha256))) {
    errors.push('clientModelSha256 must be a lowercase hex sha256 or null');
  }
  if (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.idempotencyKey)) {
    errors.push('idempotencyKey must match [A-Za-z0-9_-]{8,128}');
  }

  if (errors.length > 0) return { ok: false, errors };
  const inp = input as Record<string, unknown>;
  return {
    ok: true,
    value: {
      scope: body.scope as SeparationScope,
      options: { refinePiano, formats },
      input: {
        filename: inp.filename as string,
        bytes: inp.bytes as number,
        contentType: inp.contentType as string,
        durationSec: (inp.durationSec as number | null) ?? null,
      },
      clientModelSha256: (body.clientModelSha256 as string | null) ?? null,
      idempotencyKey: body.idempotencyKey as string,
    },
  };
}

export function isJobRecord(v: unknown): v is JobRecord {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === 'string' &&
    typeof v.revision === 'number' &&
    oneOf(JOB_STATUSES, v.status) &&
    oneOf(SEPARATION_SCOPES, v.scope) &&
    Array.isArray(v.stems) &&
    v.stems.every((s) => isRecord(s) && isStemName(s.stem) && oneOf(OUTPUT_FORMATS, s.format) && typeof s.url === 'string') &&
    Array.isArray(v.warnings) &&
    (v.error === null || (isRecord(v.error) && typeof v.error.code === 'string'))
  );
}

export function stemFileName(stem: StemName, format: OutputFormat): string {
  const ext = format === 'wav16' || format === 'wav24' ? 'wav' : format;
  return `${stem}.${format === 'wav24' ? '24bit.' : ''}${ext}`;
}
