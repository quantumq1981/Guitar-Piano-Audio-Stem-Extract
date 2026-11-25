/**
 * Fixed-window chunking with linear cross-fade overlap-add.
 *
 * Geometry (N = segment, O = overlap, S = N − O = stride):
 *
 *   chunk 0   [0 ............ N)
 *   chunk 1           [S ............ S+N)
 *   chunk 2                   [2S ............ 2S+N)
 *                     |<-O->|
 *
 * Weights: linear fade-in over the first O samples and fade-out over the last O
 * samples, except the first chunk (no fade-in) and the last chunk (no fade-out).
 * Adjacent fades are complementary (k/(O−1) + (O−1−k)/(O−1) = 1), so every
 * sample's weights sum to 1; we still divide by the accumulated weight to stay
 * robust to float rounding.
 *
 * Streaming: after chunk i, every sample before start(i+1) is final. The
 * accumulator therefore holds exactly N frames per (stem, channel) regardless of
 * song length — the property that keeps mobile peak memory bounded.
 */

export interface ChunkPlan {
  readonly totalFrames: number;
  readonly segmentFrames: number;
  readonly overlapFrames: number;
  readonly strideFrames: number;
  readonly chunks: readonly ChunkSpan[];
}

export interface ChunkSpan {
  readonly index: number;
  /** Absolute start frame in the source. */
  readonly start: number;
  /** Frames of real audio in this chunk (≤ segmentFrames; remainder is zero-padded). */
  readonly validFrames: number;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}

export function planChunks(totalFrames: number, segmentFrames: number, overlapRatio = 0.25): ChunkPlan {
  if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0) {
    throw new RangeError(`totalFrames must be a positive integer, got ${totalFrames}`);
  }
  if (!Number.isSafeInteger(segmentFrames) || segmentFrames < 2) {
    throw new RangeError(`segmentFrames must be an integer ≥ 2, got ${segmentFrames}`);
  }
  if (!(overlapRatio >= 0 && overlapRatio < 0.5)) {
    // ≥ 0.5 would let three chunks overlap one sample; the streaming accumulator assumes two.
    throw new RangeError(`overlapRatio must be in [0, 0.5), got ${overlapRatio}`);
  }
  const overlapFrames = Math.floor(segmentFrames * overlapRatio);
  const strideFrames = segmentFrames - overlapFrames;
  const count = totalFrames <= segmentFrames ? 1 : Math.ceil((totalFrames - segmentFrames) / strideFrames) + 1;

  const chunks: ChunkSpan[] = [];
  for (let index = 0; index < count; index++) {
    const start = index * strideFrames;
    chunks.push({
      index,
      start,
      validFrames: Math.min(segmentFrames, totalFrames - start),
      isFirst: index === 0,
      isLast: index === count - 1,
    });
  }
  return { totalFrames, segmentFrames, overlapFrames, strideFrames, chunks };
}

/** Weight for frame `k` (0-based, within the segment) of a chunk. */
export function chunkWeight(k: number, overlapFrames: number, segmentFrames: number, isFirst: boolean, isLast: boolean): number {
  if (overlapFrames <= 1) return 1;
  if (!isFirst && k < overlapFrames) return k / (overlapFrames - 1);
  const tail = segmentFrames - overlapFrames;
  if (!isLast && k >= tail) return (segmentFrames - 1 - k) / (overlapFrames - 1);
  return 1;
}

export interface FinalizedBlock {
  /** Absolute start frame. */
  readonly start: number;
  readonly frames: number;
  /** planes[stem][channel] → Float32Array(frames). Freshly allocated; safe to retain. */
  readonly planes: readonly (readonly Float32Array[])[];
}

/**
 * Bounded-memory overlap-add accumulator.
 *
 * `add()` must be called once per chunk, in plan order, with the model output
 * laid out as [stem][channel][frame] in a flat Float32Array of length
 * stems × channels × segmentFrames.
 */
export class StreamingOverlapAdd {
  readonly #plan: ChunkPlan;
  readonly #stems: number;
  readonly #channels: number;
  readonly #acc: Float32Array[];
  readonly #wsum: Float32Array;
  #nextChunk = 0;

  /**
   * @param firstChunk index of the first chunk this accumulator will receive (default 0). A resumed run starts at
   * `startChunk − 1` and discards that chunk's block: it is added only to rebuild the overlap tail (resume.ts).
   */
  constructor(plan: ChunkPlan, stems: number, channels: number, firstChunk = 0) {
    if (stems < 1 || channels < 1) throw new RangeError('stems and channels must be ≥ 1');
    if (!Number.isSafeInteger(firstChunk) || firstChunk < 0 || firstChunk >= plan.chunks.length) {
      throw new RangeError(`firstChunk must be in [0, ${plan.chunks.length}), got ${firstChunk}`);
    }
    this.#nextChunk = firstChunk;
    this.#plan = plan;
    this.#stems = stems;
    this.#channels = channels;
    this.#acc = Array.from({ length: stems * channels }, () => new Float32Array(plan.segmentFrames));
    this.#wsum = new Float32Array(plan.segmentFrames);
  }

  get done(): boolean {
    return this.#nextChunk >= this.#plan.chunks.length;
  }

  /** Bytes held by the accumulator (for memory budgeting). */
  get residentBytes(): number {
    return (this.#acc.length + 1) * this.#plan.segmentFrames * 4;
  }

  add(chunk: ChunkSpan, output: Float32Array): FinalizedBlock {
    const { segmentFrames: n, overlapFrames: o, strideFrames: s, totalFrames } = this.#plan;
    if (chunk.index !== this.#nextChunk) {
      throw new Error(`Chunks must be added in order: expected ${this.#nextChunk}, got ${chunk.index}`);
    }
    const expected = this.#stems * this.#channels * n;
    if (output.length !== expected) {
      throw new RangeError(`Model output length ${output.length} ≠ stems×channels×segment = ${expected}`);
    }

    const valid = chunk.validFrames;
    for (let k = 0; k < valid; k++) {
      this.#wsum[k]! += chunkWeight(k, o, n, chunk.isFirst, chunk.isLast);
    }
    for (let plane = 0; plane < this.#acc.length; plane++) {
      const acc = this.#acc[plane]!;
      const base = plane * n;
      for (let k = 0; k < valid; k++) {
        acc[k]! += output[base + k]! * chunkWeight(k, o, n, chunk.isFirst, chunk.isLast);
      }
    }

    const finalFrames = chunk.isLast ? totalFrames - chunk.start : s;
    const planes: Float32Array[][] = [];
    for (let stem = 0; stem < this.#stems; stem++) {
      const channels: Float32Array[] = [];
      for (let ch = 0; ch < this.#channels; ch++) {
        const acc = this.#acc[stem * this.#channels + ch]!;
        const out = new Float32Array(finalFrames);
        for (let k = 0; k < finalFrames; k++) {
          const w = this.#wsum[k]!;
          out[k] = w > 1e-8 ? acc[k]! / w : 0;
        }
        channels.push(out);
      }
      planes.push(channels);
    }

    // Slide: the pending overlap [S, N) becomes [0, O) for the next chunk.
    if (!chunk.isLast) {
      for (const acc of this.#acc) {
        acc.copyWithin(0, s, n);
        acc.fill(0, o);
      }
      this.#wsum.copyWithin(0, s, n);
      this.#wsum.fill(0, o);
    }
    this.#nextChunk++;
    return { start: chunk.start, frames: finalFrames, planes };
  }
}
