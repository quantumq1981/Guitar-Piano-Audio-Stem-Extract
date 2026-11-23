/**
 * File-backed job store with revisioned records and long-poll waiters.
 *
 * This is the reference implementation of the queue primitive. In the Cloudflare
 * deployment the same interface is implemented by one Durable Object per job
 * (storage = DO storage, waiters = DO alarms + hibernatable requests); the
 * transition table in @stemsplit/core is shared verbatim.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CreateJobRequest, JobRecord, JobStatus } from '@stemsplit/core';
import { SERVER_LIMITS, isTerminal, transition } from '@stemsplit/core';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type JobDraft = Mutable<JobRecord>;

interface Waiter {
  readonly since: number;
  readonly resolve: (job: JobRecord) => void;
  readonly timer: NodeJS.Timeout;
}

export class JobNotFoundError extends Error {
  constructor(id: string) {
    super(`Job ${id} not found`);
    this.name = 'JobNotFoundError';
  }
}

export class JobStore {
  readonly dataDir: string;
  readonly #jobs = new Map<string, JobRecord>();
  readonly #idempotency = new Map<string, string>();
  readonly #waiters = new Map<string, Set<Waiter>>();
  readonly #now: () => Date;
  /** Serialises disk writes per job so concurrent updates cannot tear job.json. */
  readonly #writes = new Map<string, Promise<void>>();

  constructor(dataDir: string, now: () => Date = () => new Date()) {
    this.dataDir = dataDir;
    this.#now = now;
  }

  /** Reload persisted jobs; anything mid-flight when the process died is failed (retryable). */
  async load(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    for (const id of await readdir(this.dataDir)) {
      try {
        const job = JSON.parse(await readFile(join(this.jobDir(id), 'job.json'), 'utf8')) as JobRecord;
        this.#jobs.set(job.id, job);
        if (!isTerminal(job.status) && job.status !== 'awaiting_upload' && job.status !== 'queued') {
          await this.update(job.id, (d) => {
            d.status = transition(d.status, 'failed');
            d.error = { code: 'internal', message: 'Server restarted during processing', retryable: true };
          });
        }
      } catch {
        // Not a job directory or a torn write; ignore.
      }
    }
  }

  jobDir(id: string): string {
    if (!/^[a-z0-9]{20,40}$/.test(id)) throw new JobNotFoundError(id);
    return join(this.dataDir, id);
  }
  inputPath(id: string): string {
    return join(this.jobDir(id), 'input');
  }
  outDir(id: string): string {
    return join(this.jobDir(id), 'stems');
  }

  async create(req: CreateJobRequest, modelSha256: string): Promise<{ job: JobRecord; created: boolean }> {
    const existing = this.#idempotency.get(req.idempotencyKey);
    if (existing) {
      const job = this.#jobs.get(existing);
      if (job) return { job, created: false };
    }
    const id = randomBytes(16).toString('hex');
    const now = this.#now().toISOString();
    const job: JobRecord = {
      id,
      revision: 1,
      status: 'awaiting_upload',
      scope: req.scope,
      options: req.options,
      createdAt: now,
      updatedAt: now,
      queuePosition: null,
      progress: null,
      etaSec: null,
      durationSec: req.input.durationSec,
      modelSha256,
      stems: [],
      warnings: [],
      error: null,
    };
    await mkdir(this.jobDir(id), { recursive: true });
    this.#jobs.set(id, job);
    this.#idempotency.set(req.idempotencyKey, id);
    await this.#persist(job);
    return { job, created: true };
  }

  get(id: string): JobRecord {
    const job = this.#jobs.get(id);
    if (!job) throw new JobNotFoundError(id);
    return job;
  }

  all(): readonly JobRecord[] {
    return [...this.#jobs.values()];
  }

  async update(id: string, mutate: (draft: JobDraft) => void): Promise<JobRecord> {
    const current = this.get(id);
    const draft: JobDraft = structuredClone(current) as JobDraft;
    mutate(draft);
    draft.revision = current.revision + 1;
    draft.updatedAt = this.#now().toISOString();
    const next: JobRecord = draft;
    this.#jobs.set(id, next);
    await this.#persist(next);
    this.#notify(next);
    return next;
  }

  async setStatus(id: string, to: JobStatus, mutate?: (draft: JobDraft) => void): Promise<JobRecord> {
    return this.update(id, (d) => {
      d.status = transition(d.status, to);
      mutate?.(d);
    });
  }

  /** Resolve as soon as revision > since, or with the current record after timeoutMs. */
  waitForChange(id: string, since: number, timeoutMs: number): Promise<JobRecord> {
    const job = this.get(id);
    if (job.revision > since || isTerminal(job.status)) return Promise.resolve(job);
    return new Promise((resolve) => {
      const set = this.#waiters.get(id) ?? new Set<Waiter>();
      this.#waiters.set(id, set);
      const waiter: Waiter = {
        since,
        resolve,
        timer: setTimeout(() => {
          set.delete(waiter);
          resolve(this.get(id));
        }, timeoutMs),
      };
      set.add(waiter);
    });
  }

  /** Expire jobs past TTL and delete their files. */
  async sweep(ttlSec: number = SERVER_LIMITS.resultTtlSec): Promise<number> {
    const cutoff = this.#now().getTime() - ttlSec * 1000;
    let n = 0;
    for (const job of this.#jobs.values()) {
      if (job.status !== 'expired' && Date.parse(job.createdAt) < cutoff) {
        if (isTerminal(job.status) || job.status === 'awaiting_upload') {
          await this.update(job.id, (d) => {
            d.status = transition(d.status, 'expired');
            d.stems = [];
          });
          await rm(this.outDir(job.id), { recursive: true, force: true });
          await rm(this.inputPath(job.id), { force: true });
          n++;
        }
      }
    }
    return n;
  }

  #notify(job: JobRecord): void {
    const set = this.#waiters.get(job.id);
    if (!set) return;
    for (const w of set) {
      if (job.revision > w.since) {
        clearTimeout(w.timer);
        set.delete(w);
        w.resolve(job);
      }
    }
  }

  async #persist(job: JobRecord): Promise<void> {
    const path = join(this.jobDir(job.id), 'job.json');
    const previous = this.#writes.get(job.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      // Always write the latest in-memory record; an older queued write must not win.
      const latest = this.#jobs.get(job.id) ?? job;
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(latest));
      await rename(tmp, path);
    });
    this.#writes.set(job.id, next.catch(() => {}));
    await next;
  }
}
