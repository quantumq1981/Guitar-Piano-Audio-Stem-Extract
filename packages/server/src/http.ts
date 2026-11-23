/**
 * HTTP surface of the v1 job API (node:http, no framework). See docs/API.md.
 *
 * Security notes:
 *  - Upload and download URLs are HMAC-signed with an expiry; job ids are 128-bit random.
 *  - Uploads are streamed to disk with a hard byte cap (413 on overflow).
 *  - Stem filenames are matched against an allow-list regex; no path traversal.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { CreateJobResponse, ModelArtifact, ModelManifest } from '@stemsplit/core';
import { API_VERSION, MODEL_REGISTRY, SERVER_LIMITS, isTerminal, validateCreateJobRequest } from '@stemsplit/core';
import { JobNotFoundError } from './job-store.ts';
import type { JobStore } from './job-store.ts';
import type { JobWorker } from './worker.ts';

export interface HttpOptions {
  readonly store: JobStore;
  readonly worker: JobWorker;
  readonly primary: ModelArtifact;
  /** Base URL embedded in signed links; a function so it can be bound after listen(). */
  readonly publicBaseUrl: string | (() => string);
  readonly signingSecret: string;
  /** Allowed CORS origin(s); '*' for development. */
  readonly corsOrigin: string;
  readonly log?: (msg: string) => void;
}

const STEM_FILE_RE = /^[a-z_]+(\.24bit)?\.(wav|flac|mp3)$/;
const MIME: Readonly<Record<string, string>> = { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg' };

export function sign(secret: string, resource: string, expiresAtMs: number): string {
  return createHmac('sha256', secret).update(`${resource}\n${expiresAtMs}`).digest('base64url');
}

export function verify(secret: string, resource: string, expiresAtMs: number, signature: string, nowMs = Date.now()): boolean {
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < nowMs) return false;
  const expected = Buffer.from(sign(secret, resource, expiresAtMs));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function signedUrl(base: string, secret: string, path: string, expiresAt: Date): string {
  const exp = expiresAt.getTime();
  return `${base}${path}?exp=${exp}&sig=${sign(secret, path, exp)}`;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'body_too_large', 'JSON body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body is not valid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

export function createApiServer(opts: HttpOptions): Server {
  const { store, worker, primary, signingSecret, publicBaseUrl, log = () => {} } = opts;
  if (primary.sha256 === null) throw new Error('Primary model must be pinned by sha256');
  const primarySha = primary.sha256;
  const baseUrl = typeof publicBaseUrl === 'function' ? publicBaseUrl : () => publicBaseUrl;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('access-control-allow-origin', opts.corsOrigin);
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-max-age', '600');
    // The PWA is cross-origin isolated (COEP); stems must opt in to cross-origin embedding.
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== API_VERSION) throw new HttpError(404, 'not_found', 'Unknown route');

    // GET /v1/models
    if (parts.length === 2 && parts[1] === 'models' && req.method === 'GET') {
      const manifest: ModelManifest = { apiVersion: API_VERSION, primary, all: MODEL_REGISTRY };
      send(res, 200, manifest);
      return;
    }
    // GET /v1/health
    if (parts.length === 2 && parts[1] === 'health' && req.method === 'GET') {
      send(res, 200, { ok: true, queueDepth: worker.depth });
      return;
    }
    if (parts[1] !== 'jobs') throw new HttpError(404, 'not_found', 'Unknown route');

    // POST /v1/jobs
    if (parts.length === 2 && req.method === 'POST') {
      const v = validateCreateJobRequest(await readJson(req));
      if (!v.ok) throw new HttpError(422, 'invalid_request', v.errors.join('; '));
      if (v.value.clientModelSha256 !== null && v.value.clientModelSha256 !== primarySha) {
        throw new HttpError(409, 'model_mismatch', `Client model ${v.value.clientModelSha256} ≠ server ${primarySha}; refresh the model cache.`);
      }
      const { job, created } = await store.create(v.value, primarySha);
      const expiresAt = new Date(Date.now() + 3600_000);
      const body: CreateJobResponse = {
        job,
        upload: {
          method: 'PUT',
          url: signedUrl(baseUrl(), signingSecret, `/v1/jobs/${job.id}/input`, expiresAt),
          headers: { 'content-type': v.value.input.contentType || 'application/octet-stream' },
          expiresAt: expiresAt.toISOString(),
        },
      };
      send(res, created ? 201 : 200, body);
      return;
    }

    const id = parts[2]!;
    // PUT /v1/jobs/:id/input
    if (parts.length === 4 && parts[3] === 'input' && req.method === 'PUT') {
      const resource = `/v1/jobs/${id}/input`;
      if (!verify(signingSecret, resource, Number(url.searchParams.get('exp')), url.searchParams.get('sig') ?? '')) {
        throw new HttpError(403, 'bad_signature', 'Upload URL is invalid or expired');
      }
      const job = store.get(id);
      if (job.status !== 'awaiting_upload') throw new HttpError(409, 'already_uploaded', `Job is ${job.status}`);
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > SERVER_LIMITS.maxUploadBytes) {
        throw new HttpError(413, 'input_too_large', `Upload exceeds ${SERVER_LIMITS.maxUploadBytes} bytes`);
      }
      let received = 0;
      const target = store.inputPath(id);
      try {
        await pipeline(
          req,
          async function* (source) {
            for await (const chunk of source) {
              received += (chunk as Buffer).length;
              if (received > SERVER_LIMITS.maxUploadBytes) throw new HttpError(413, 'input_too_large', 'Upload exceeds limit');
              yield chunk as Buffer;
            }
          },
          createWriteStream(target),
        );
      } catch (e) {
        await rm(target, { force: true });
        throw e;
      }
      if (received === 0) throw new HttpError(400, 'empty_upload', 'Upload body is empty');
      await worker.enqueue(id);
      send(res, 202, store.get(id));
      return;
    }

    // GET /v1/jobs/:id/stems/:file
    if (parts.length === 5 && parts[3] === 'stems' && req.method === 'GET') {
      const file = parts[4]!;
      const resource = `/v1/jobs/${id}/stems/${file}`;
      if (!STEM_FILE_RE.test(file)) throw new HttpError(404, 'not_found', 'Unknown stem file');
      if (!verify(signingSecret, resource, Number(url.searchParams.get('exp')), url.searchParams.get('sig') ?? '')) {
        throw new HttpError(403, 'bad_signature', 'Download URL is invalid or expired');
      }
      const job = store.get(id);
      if (job.status !== 'succeeded') throw new HttpError(409, 'not_ready', `Job is ${job.status}`);
      const path = join(store.outDir(id), file);
      const info = await stat(path).catch(() => null);
      if (!info) throw new HttpError(404, 'not_found', 'Stem file missing');
      res.writeHead(200, {
        'content-type': MIME[file.split('.').at(-1)!] ?? 'application/octet-stream',
        'content-length': info.size,
        'content-disposition': `attachment; filename="${file}"`,
        'cache-control': 'private, max-age=3600',
      });
      await pipeline(createReadStream(path), res);
      return;
    }

    // GET /v1/jobs/:id?since=<rev>
    if (parts.length === 3 && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? '0');
      const job = Number.isFinite(since) && since > 0 ? await store.waitForChange(id, since, SERVER_LIMITS.longPollMaxSec * 1000) : store.get(id);
      res.setHeader('cache-control', 'no-store');
      send(res, 200, job);
      return;
    }

    // DELETE /v1/jobs/:id
    if (parts.length === 3 && req.method === 'DELETE') {
      const job = store.get(id);
      if (!isTerminal(job.status)) await worker.cancel(id);
      await rm(store.outDir(id), { recursive: true, force: true });
      await rm(store.inputPath(id), { force: true });
      res.writeHead(204).end();
      return;
    }
    throw new HttpError(405, 'method_not_allowed', `${req.method} not supported here`);
  };

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const err =
        e instanceof HttpError
          ? e
          : e instanceof JobNotFoundError
            ? new HttpError(404, 'job_not_found', e.message)
            : new HttpError(500, 'internal', e instanceof Error ? e.message : String(e));
      if (err.status >= 500) log(`HTTP ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) send(res, err.status, { error: { code: err.code, message: err.message } });
      else res.destroy();
    });
  });
}
