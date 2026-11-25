/**
 * Runtime-agnostic separation driver.
 *
 * The browser worker (onnxruntime-web), the Node server (onnxruntime-node) and a
 * future native wrapper all call `separate()` with their own SegmentRunner, so
 * chunk geometry, padding, windowing and stem projection are identical on every
 * tier — the remaining cross-tier difference is EP floating-point behaviour only.
 */
import type { ModelIO, StemName } from '../models/registry.ts';
import type { ChunkPlan, ChunkSpan, FinalizedBlock } from '../dsp/chunking.ts';
import { StreamingOverlapAdd, planChunks } from '../dsp/chunking.ts';

/** Runs exactly one fixed-size segment through the model. */
export interface SegmentRunner {
  readonly io: ModelIO;
  /**
   * @param input planar stereo, length channels × segmentFrames ([L…, R…]).
   * @returns flat [stem][channel][frame], length stems × channels × segmentFrames.
   */
  run(input: Float32Array): Promise<Float32Array>;
}

/** Random-access source of planar frames (memory, file, OPFS…). */
export interface FrameSource {
  readonly totalFrames: number;
  readonly sampleRate: number;
  /** Fill `out[ch]` (length ≥ frames) with frames [start, start+frames). */
  read(start: number, frames: number, out: readonly Float32Array[]): Promise<void> | void;
}

export interface StemSink {
  /** Called once per finalised block, in ascending frame order. */
  write(block: FinalizedBlock): Promise<void> | void;
}

export interface SeparationProgress {
  /** Chunks finished, counting those a resumed run skipped. */
  readonly chunk: number;
  readonly chunks: number;
  readonly fraction: number;
  /** Time in this call only (a resumed run's ETA is based on the chunks it ran itself). */
  readonly elapsedMs: number;
  readonly etaMs: number | null;
}

export interface SeparateOptions {
  readonly overlapRatio?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: SeparationProgress) => void;
  /**
   * Called before each chunk; throw (or return a rejected promise) to stop.
   * The browser uses this for visibility, battery and thermal checks.
   */
  readonly beforeChunk?: (chunk: ChunkSpan, plan: ChunkPlan) => Promise<void> | void;
  readonly now?: () => number;
  /**
   * First chunk to emit (default 0). For k > 0 the engine first re-runs chunk k − 1 and discards its block, which
   * rebuilds the overlap tail exactly, so blocks from frame plan.chunks[k].start on are bit-identical to an
   * uninterrupted run with a deterministic runner. Get k from `decideResume()`; the sink must already hold frames
   * [0, plan.chunks[k].start).
   */
  readonly startChunk?: number;
}

export class SeparationAbortedError extends Error {
  constructor(reason: string) {
    super(`Separation aborted: ${reason}`);
    this.name = 'SeparationAbortedError';
  }
}

export async function separate(source: FrameSource, runner: SegmentRunner, sink: StemSink, opts: SeparateOptions = {}): Promise<ChunkPlan> {
  const { io } = runner;
  if (source.sampleRate !== io.sampleRate) {
    throw new RangeError(`Source is ${source.sampleRate} Hz; model requires ${io.sampleRate} Hz. Resample before separation.`);
  }
  const now = opts.now ?? (() => Date.now());
  const plan = planChunks(source.totalFrames, io.segmentFrames, opts.overlapRatio ?? 0.25);
  const startChunk = opts.startChunk ?? 0;
  if (!Number.isSafeInteger(startChunk) || startChunk < 0 || startChunk >= plan.chunks.length) {
    throw new RangeError(`startChunk must be in [0, ${plan.chunks.length}), got ${startChunk}`);
  }
  const ola = new StreamingOverlapAdd(plan, io.stems.length, io.channels, Math.max(0, startChunk - 1));
  const n = io.segmentFrames;
  const input = new Float32Array(io.channels * n);
  const views = Array.from({ length: io.channels }, (_, c) => input.subarray(c * n, (c + 1) * n));
  const t0 = now();

  const process = async (chunk: ChunkSpan) => {
    if (opts.signal?.aborted) throw new SeparationAbortedError(String(opts.signal.reason ?? 'signal'));
    await opts.beforeChunk?.(chunk, plan);
    input.fill(0);
    await source.read(chunk.start, chunk.validFrames, views);
    return ola.add(chunk, await runner.run(input));
  };

  if (startChunk > 0) await process(plan.chunks[startChunk - 1]!); // overlap tail only; its frames are on disk
  const ran = startChunk > 0 ? 1 : 0;
  for (const chunk of plan.chunks.slice(startChunk)) {
    await sink.write(await process(chunk));

    const done = chunk.index + 1;
    const runHere = done - startChunk + ran;
    const elapsedMs = now() - t0;
    opts.onProgress?.({
      chunk: done,
      chunks: plan.chunks.length,
      fraction: done / plan.chunks.length,
      elapsedMs,
      etaMs: (elapsedMs / runHere) * (plan.chunks.length - done),
    });
  }
  return plan;
}

/** In-memory FrameSource over planar channels. */
export function memorySource(channels: readonly Float32Array[], sampleRate: number): FrameSource {
  const totalFrames = channels[0]?.length ?? 0;
  return {
    totalFrames,
    sampleRate,
    read(start, frames, out) {
      for (let c = 0; c < out.length; c++) {
        const src = channels[c] ?? channels[0]!;
        out[c]!.set(src.subarray(start, start + frames), 0);
      }
    },
  };
}

/**
 * Projects model stems onto delivered stems. `quick` folds guitar+piano back
 * into `other`; this is a sum, so mixture consistency is preserved.
 */
export type StemProjection = ReadonlyMap<StemName, readonly number[]>;

export function buildProjection(modelStems: readonly StemName[], wanted: readonly StemName[]): StemProjection {
  const index = (s: StemName): number => {
    const i = modelStems.indexOf(s);
    if (i < 0) throw new Error(`Model does not produce stem "${s}"`);
    return i;
  };
  const map = new Map<StemName, number[]>();
  const hasGuitar = wanted.includes('guitar') || wanted.includes('guitar_lead') || wanted.includes('guitar_rhythm');
  const hasPiano = wanted.includes('piano');
  for (const stem of wanted) {
    if (stem === 'guitar_lead' || stem === 'guitar_rhythm') continue; // produced downstream from `guitar`
    if (stem === 'other') {
      const parts = [index('other')];
      if (!hasGuitar && modelStems.includes('guitar')) parts.push(index('guitar'));
      if (!hasPiano && modelStems.includes('piano')) parts.push(index('piano'));
      map.set('other', parts);
    } else {
      map.set(stem, [index(stem)]);
    }
  }
  if ((wanted.includes('guitar_lead') || wanted.includes('guitar_rhythm')) && !map.has('guitar')) {
    map.set('guitar', [index('guitar')]);
  }
  return map;
}

export function projectBlock(block: FinalizedBlock, projection: StemProjection): Map<StemName, Float32Array[]> {
  const out = new Map<StemName, Float32Array[]>();
  for (const [stem, sources] of projection) {
    const first = block.planes[sources[0]!]!;
    const channels = first.map((ch) => new Float32Array(ch));
    for (let s = 1; s < sources.length; s++) {
      const add = block.planes[sources[s]!]!;
      for (let c = 0; c < channels.length; c++) {
        const dst = channels[c]!;
        const src = add[c]!;
        for (let i = 0; i < dst.length; i++) dst[i]! += src[i]!;
      }
    }
    out.set(stem, channels);
  }
  return out;
}
