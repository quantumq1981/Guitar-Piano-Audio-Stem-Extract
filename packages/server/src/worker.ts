/**
 * Single-session FIFO worker. One htdemucs_6s session peaks at ~2.4 GiB, so a
 * container runs exactly one job at a time; horizontal scale = more containers.
 */
import type { JobStage, JobStatus, SegmentRunner, StemArtifact } from '@stemsplit/core';
import { SERVER_LIMITS, estimateServerSeconds, isTerminal, transition } from '@stemsplit/core';
import type { JobStore } from './job-store.ts';
import { PipelineError, runPipeline } from './pipeline.ts';

const STAGE_STATUS: Readonly<Record<JobStage, JobStatus>> = {
  decode: 'decoding',
  separate: 'separating',
  lead_rhythm: 'refining',
  piano_refine: 'refining',
  encode: 'encoding',
};

export interface WorkerOptions {
  readonly store: JobStore;
  readonly runner: SegmentRunner;
  readonly modelLabel: string;
  /** Measured compute-seconds per audio-second on this host (for ETAs). */
  readonly rtf: number;
  readonly signUrl: (jobId: string, file: string, expiresAt: Date) => string;
  readonly log?: (msg: string) => void;
}

export class JobWorker {
  readonly #opts: WorkerOptions;
  readonly #queue: string[] = [];
  readonly #controllers = new Map<string, AbortController>();
  #running: string | null = null;

  constructor(opts: WorkerOptions) {
    this.#opts = opts;
  }

  get depth(): number {
    return this.#queue.length + (this.#running ? 1 : 0);
  }

  async enqueue(id: string): Promise<void> {
    const { store } = this.#opts;
    const job = store.get(id);
    const eta = estimateServerSeconds(job.durationSec ?? 180, {
      rtf: this.#opts.rtf,
      leadRhythm: job.scope === 'guitar',
      pianoRefine: job.options.refinePiano,
    });
    this.#queue.push(id);
    await store.setStatus(id, 'queued', (d) => {
      d.queuePosition = this.#queue.length + (this.#running ? 1 : 0);
      d.etaSec = eta;
    });
    void this.#drain();
  }

  async cancel(id: string): Promise<void> {
    const { store } = this.#opts;
    const idx = this.#queue.indexOf(id);
    if (idx >= 0) this.#queue.splice(idx, 1);
    this.#controllers.get(id)?.abort('cancelled');
    const job = store.get(id);
    if (!isTerminal(job.status)) await store.setStatus(id, 'cancelled', (d) => (d.queuePosition = null));
    await this.#refreshPositions();
  }

  async #refreshPositions(): Promise<void> {
    const { store } = this.#opts;
    for (let i = 0; i < this.#queue.length; i++) {
      const id = this.#queue[i]!;
      const position = i + 1 + (this.#running ? 1 : 0);
      if (store.get(id).queuePosition !== position) await store.update(id, (d) => (d.queuePosition = position));
    }
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    const id = this.#queue.shift();
    if (!id) return;
    this.#running = id;
    try {
      await this.#refreshPositions();
      await this.#process(id);
    } finally {
      this.#running = null;
      this.#controllers.delete(id);
      void this.#drain();
    }
  }

  async #process(id: string): Promise<void> {
    const { store, log = () => {} } = this.#opts;
    const ac = new AbortController();
    this.#controllers.set(id, ac);
    const job = store.get(id);
    if (job.status !== 'queued') return;
    const started = Date.now();
    let lastWrite = 0;
    let status: JobStatus = 'queued';
    log(`job ${id}: start (${job.scope})`);
    try {
      const result = await runPipeline({
        inputPath: store.inputPath(id),
        outDir: store.outDir(id),
        scope: job.scope,
        options: job.options,
        runner: this.#opts.runner,
        modelLabel: this.#opts.modelLabel,
        signal: ac.signal,
        onStage: (stage, fraction) => {
          const next = STAGE_STATUS[stage];
          const now = Date.now();
          // Status changes always persist; progress within a stage is throttled to 2 Hz.
          if (next === status && now - lastWrite < 500 && fraction < 1) return;
          lastWrite = now;
          const elapsed = (now - started) / 1000;
          void store
            .update(id, (d) => {
              // Pipeline may skip `refining`; the shared table allows separating → encoding.
              if (d.status !== next) d.status = transition(d.status, next);
              d.queuePosition = null;
              d.progress = { stage, fraction };
              if (d.etaSec !== null) d.etaSec = Math.max(0, Math.round((job.etaSec ?? 0) - elapsed));
            })
            .catch((err: unknown) => log(`job ${id}: progress update rejected: ${String(err)}`));
          status = next;
        },
      });
      const expiresAt = new Date(Date.now() + SERVER_LIMITS.resultTtlSec * 1000);
      const stems: StemArtifact[] = result.stems.map((s) => ({
        stem: s.stem,
        format: s.format,
        bytes: s.bytes,
        url: this.#opts.signUrl(id, s.path.split('/').at(-1)!, expiresAt),
        expiresAt: expiresAt.toISOString(),
        producedBy: s.producedBy,
      }));
      await store.update(id, (d) => {
        d.status = transition(d.status, 'succeeded');
        d.progress = null;
        d.etaSec = 0;
        d.durationSec = result.durationSec;
        d.stems = stems;
        d.warnings = [...result.warnings];
      });
      log(`job ${id}: succeeded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    } catch (e) {
      if (ac.signal.aborted) return;
      const err =
        e instanceof PipelineError
          ? { code: e.code, message: e.message, retryable: e.retryable }
          : { code: 'internal' as const, message: e instanceof Error ? e.message : String(e), retryable: true };
      log(`job ${id}: failed ${err.code}: ${err.message}`);
      const current = store.get(id);
      if (!isTerminal(current.status)) {
        await store.update(id, (d) => {
          d.status = transition(d.status, 'failed');
          d.progress = null;
          d.error = err;
        });
      }
    }
  }
}
