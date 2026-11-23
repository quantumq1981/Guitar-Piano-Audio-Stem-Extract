/**
 * Browser client for the v1 job API. Long-polls with ?since=<revision>
 * (bounded 25 s requests — no indefinitely open sockets), resumes across
 * transient network errors with capped exponential backoff.
 */
import type { CreateJobRequest, CreateJobResponse, JobRecord, ModelManifest } from '@stemsplit/core';
import { isJobRecord, isTerminal } from '@stemsplit/core';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  let code = 'http_error';
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    /* non-JSON error */
  }
  throw new ApiError(res.status, code, message);
}

export class ServerClient {
  readonly baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async manifest(): Promise<ModelManifest> {
    return (await check(await fetch(`${this.baseUrl}/v1/models`))).json() as Promise<ModelManifest>;
  }

  /**
   * Create a job, riding out a sleeping host. Free-tier hosts (Hugging Face
   * Spaces) sleep when idle and answer 502/503/504, or drop the connection, for
   * up to a minute or two while waking. Safe to retry: the idempotency key
   * makes a duplicate POST return the same job.
   */
  async create(req: CreateJobRequest, opts: { onWaiting?: (attempt: number) => void; maxWaitMs?: number } = {}): Promise<CreateJobResponse> {
    const deadline = Date.now() + (opts.maxWaitMs ?? 180_000);
    let delay = 2000;
    for (let attempt = 1; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetch(`${this.baseUrl}/v1/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
      } catch {
        res = null; // network error / connection reset while the host boots
      }
      const waking = res === null || res.status === 502 || res.status === 503 || res.status === 504;
      if (!waking || Date.now() + delay > deadline) {
        if (res === null) throw new ApiError(0, 'network', 'Could not reach the processing server');
        return (await check(res)).json() as Promise<CreateJobResponse>;
      }
      opts.onWaiting?.(attempt);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 15_000);
    }
  }

  /** XHR because fetch() still has no upload-progress events. */
  upload(created: CreateJobResponse, file: Blob, onProgress: (fraction: number) => void): Promise<JobRecord> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(created.upload.method, created.upload.url);
      for (const [k, v] of Object.entries(created.upload.headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onerror = () => reject(new ApiError(0, 'network', 'Upload failed (network)'));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const body: unknown = JSON.parse(xhr.responseText);
          if (isJobRecord(body)) resolve(body);
          else reject(new ApiError(xhr.status, 'invalid_response', 'Server returned an invalid job record'));
        } else {
          reject(new ApiError(xhr.status, 'upload_failed', xhr.responseText.slice(0, 200)));
        }
      };
      xhr.send(file);
    });
  }

  async *watch(initial: JobRecord, signal?: AbortSignal): AsyncGenerator<JobRecord> {
    let current = initial;
    let backoff = 1000;
    yield current;
    while (!isTerminal(current.status)) {
      try {
        const res = await check(await fetch(`${this.baseUrl}/v1/jobs/${current.id}?since=${current.revision}`, signal ? { signal } : {}));
        const next: unknown = await res.json();
        if (!isJobRecord(next)) throw new ApiError(res.status, 'invalid_response', 'Invalid job record');
        backoff = 1000;
        if (next.revision !== current.revision) {
          current = next;
          yield current;
        }
      } catch (e) {
        if (signal?.aborted) return;
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) throw e;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  async cancel(id: string): Promise<void> {
    await check(await fetch(`${this.baseUrl}/v1/jobs/${id}`, { method: 'DELETE' }));
  }
}
