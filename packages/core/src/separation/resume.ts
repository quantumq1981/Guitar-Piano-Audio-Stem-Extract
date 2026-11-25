/**
 * Resuming an on-device separation that stopped part-way (the tab was hidden, killed or reloaded).
 *
 * Why a resumed run is bit-identical to an uninterrupted one (S = stride, O = overlap, N = segment, O < S):
 *  - after chunk i, frames [0, (i+1)·S) are final, and wavStemSink has written exactly those frames, in order;
 *  - the overlap tail that chunk k inherits is acc[S, N) of chunk k−1 slid to [0, O). Before chunk k−1 is added,
 *    acc[O, N) is zero (the slide clears it) and S ≥ O, so that tail is 0 + output·weight of chunk k−1 alone;
 *  - so `separate({ startChunk: k })` re-runs chunk k−1 into a fresh accumulator, discards its block, and
 *    continues. 0 + x = x exactly, and the model's repeats are bit-identical (measured), so every later block
 *    matches. The engine test checks this at every stop point.
 *
 * Files in the run directory: `run.json` (RunManifest), the interleaved float32 input, and one WAV per stem.
 */
import type { ChunkPlan } from '../dsp/chunking.ts';
import { planChunks } from '../dsp/chunking.ts';
import { WAV_HEADER_BYTES, bytesPerSample, type WavFormat, type WavSampleFormat } from '../codec/wav.ts';
import type { FrameSource } from './engine.ts';

export const RUN_MANIFEST_VERSION = 1;
export const RUN_MANIFEST_FILE = 'run.json';
export const RUN_INPUT_FILE = 'input.f32';
/** Input samples are float32, little-endian, interleaved by frame: lossless, and one read per window. */
export const INPUT_BYTES_PER_SAMPLE = 4;

const SAMPLE_FORMATS: readonly WavSampleFormat[] = ['pcm16', 'pcm24', 'float32'];

export interface RunManifest {
  readonly version: typeof RUN_MANIFEST_VERSION;
  /** Artifact that produced the stems; a resumed run must use the same bytes. */
  readonly modelId: string;
  readonly graphSha256: string;
  readonly totalFrames: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly segmentFrames: number;
  readonly overlapRatio: number;
  readonly sampleFormat: WavSampleFormat;
  /** Stem names in model order; file `i` is `${stems[i]}.wav`. */
  readonly stems: readonly string[];
  /** The song the user chose, for display and download names only (the input file is what is separated). */
  readonly source: { readonly name: string; readonly bytes: number };
  /** WASM threads the run started with. Resuming at another count is numerically equivalent (≥ 84 dB per stem,
   * measured), but bit-identity across the seam is only guaranteed at the same count. */
  readonly threads: number;
  /** ISO-8601. */
  readonly createdAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Type guard for a parsed `run.json`. Anything malformed is rejected, never coerced. */
export function isRunManifest(v: unknown): v is RunManifest {
  if (!isObject(v) || v['version'] !== RUN_MANIFEST_VERSION) return false;
  const source = v['source'];
  const stems = v['stems'];
  const overlap = v['overlapRatio'];
  return isNonEmptyString(v['modelId']) && typeof v['graphSha256'] === 'string' && /^[0-9a-f]{64}$/.test(v['graphSha256']) &&
    isPositiveInt(v['totalFrames']) && isPositiveInt(v['sampleRate']) && isPositiveInt(v['channels']) &&
    isPositiveInt(v['segmentFrames']) && v['segmentFrames'] >= 2 &&
    typeof overlap === 'number' && overlap >= 0 && overlap < 0.5 &&
    SAMPLE_FORMATS.includes(v['sampleFormat'] as WavSampleFormat) &&
    Array.isArray(stems) && stems.length > 0 && stems.every(isNonEmptyString) && new Set(stems).size === stems.length &&
    isObject(source) && typeof source['name'] === 'string' && typeof source['bytes'] === 'number' &&
    Number.isSafeInteger(source['bytes']) && source['bytes'] >= 0 &&
    isPositiveInt(v['threads']) && typeof v['createdAt'] === 'string';
}

/** Parses `run.json` text; null when it is not valid JSON or not a RunManifest. */
export function parseRunManifest(text: string): RunManifest | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRunManifest(value) ? value : null;
  } catch {
    return null;
  }
}

export function stemFormatOf(m: RunManifest): WavFormat {
  return { sampleRate: m.sampleRate, channels: m.channels, sampleFormat: m.sampleFormat };
}

export function inputFileBytes(totalFrames: number, channels: number): number {
  return totalFrames * channels * INPUT_BYTES_PER_SAMPLE;
}

/** Bytes of one stem file holding `frames` frames (header included). */
export function stemFileBytes(frames: number, format: WavFormat): number {
  return WAV_HEADER_BYTES + frames * format.channels * bytesPerSample(format.sampleFormat);
}

export interface RunStorageNeed {
  readonly stems: number;
  readonly input: number;
  readonly total: number;
}

/** On-device storage a run needs: every stem file plus the stored input. */
export function runStorageNeed(totalFrames: number, stemCount: number, format: WavFormat): RunStorageNeed {
  if (!Number.isSafeInteger(totalFrames) || totalFrames < 0) throw new RangeError(`Invalid frame count ${totalFrames}`);
  const stems = stemCount * stemFileBytes(totalFrames, format);
  const input = inputFileBytes(totalFrames, format.channels);
  return { stems, input, total: stems + input };
}

/** What the current page expects a resumable run to have been made with. */
export interface ResumeExpectation {
  readonly modelId: string;
  readonly graphSha256: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly segmentFrames: number;
  readonly overlapRatio: number;
  readonly stems: readonly string[];
}

/** Sizes found on disk. `stemBytes[i]` is null when stem file i does not exist. */
export interface StoredRunFiles {
  readonly inputBytes: number | null;
  readonly stemBytes: readonly (number | null)[];
}

export type ResumeDecision =
  | { readonly kind: 'complete'; readonly plan: ChunkPlan }
  | {
    readonly kind: 'resume';
    readonly plan: ChunkPlan;
    /** First chunk to emit; the engine re-runs `startChunk − 1` only to rebuild the overlap tail. */
    readonly startChunk: number;
    /** Frames every stem keeps; truncate each file to `keepBytes` before resuming. */
    readonly keepFrames: number;
    readonly keepBytes: number;
  }
  | { readonly kind: 'unusable'; readonly reason: string };

/**
 * Decides how to continue a stored run. Pure: the caller reads `run.json` and file sizes, then truncates and
 * restarts the engine as told. Stem files are trusted only up to whole frames, and only up to the last stride
 * boundary every stem reached (a kill can land between two stems' writes of one block, or inside a write).
 */
export function decideResume(manifest: RunManifest, expected: ResumeExpectation, files: StoredRunFiles): ResumeDecision {
  const mismatch = (what: string) => ({ kind: 'unusable', reason: `the stored run used a different ${what}` }) as const;
  // Identity is the graph's SHA-256 (it pins the external data's name too); modelId is a label and may be renamed.
  if (manifest.graphSha256 !== expected.graphSha256) return mismatch('model');
  if (manifest.sampleRate !== expected.sampleRate || manifest.channels !== expected.channels) return mismatch('audio format');
  if (manifest.segmentFrames !== expected.segmentFrames || manifest.overlapRatio !== expected.overlapRatio) return mismatch('window geometry');
  if (manifest.stems.length !== expected.stems.length || manifest.stems.some((s, i) => s !== expected.stems[i])) return mismatch('stem order');
  if (files.stemBytes.length !== manifest.stems.length) {
    throw new RangeError(`Expected ${manifest.stems.length} stem sizes, got ${files.stemBytes.length}`);
  }
  if (files.inputBytes !== inputFileBytes(manifest.totalFrames, manifest.channels)) {
    return { kind: 'unusable', reason: files.inputBytes === null ? 'the stored song is missing' : 'the stored song is incomplete' };
  }

  const format = stemFormatOf(manifest);
  const frameBytes = format.channels * bytesPerSample(format.sampleFormat);
  const full = stemFileBytes(manifest.totalFrames, format);
  const plan = planChunks(manifest.totalFrames, manifest.segmentFrames, manifest.overlapRatio);
  let written = manifest.totalFrames;
  for (const size of files.stemBytes) {
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) throw new RangeError(`Invalid stem size ${size}`);
    if (size !== null && size > full) return { kind: 'unusable', reason: 'a stem file is longer than the song' };
    const frames = size === null || size < WAV_HEADER_BYTES ? 0 : Math.floor((size - WAV_HEADER_BYTES) / frameBytes);
    written = Math.min(written, frames);
  }
  if (written === manifest.totalFrames) return { kind: 'complete', plan };

  // Blocks end on stride boundaries (except the last, which ends the song), so whole blocks are k·S frames.
  const startChunk = Math.min(Math.floor(written / plan.strideFrames), plan.chunks.length - 1);
  const keepFrames = plan.chunks[startChunk]!.start;
  // With no frames kept, keep nothing at all: the sink writes the header with the first block.
  return { kind: 'resume', plan, startChunk, keepFrames, keepBytes: keepFrames === 0 ? 0 : WAV_HEADER_BYTES + keepFrames * frameBytes };
}

/** Synchronous or async positional read: fills `into` from byte `offset`, returns bytes read. */
export type ByteReadPort = (offset: number, into: Uint8Array) => number | Promise<number>;

/**
 * Encodes frames [start, start+frames) of planar channels as interleaved float32 little-endian bytes,
 * the RUN_INPUT_FILE layout. Encode in bounded blocks so the input is never copied whole.
 */
export function encodeInterleavedF32(channels: readonly Float32Array[], start: number, frames: number): Uint8Array {
  const n = channels.length;
  if (n < 1) throw new RangeError('At least one channel is required');
  for (const c of channels) {
    if (start < 0 || start + frames > c.length) throw new RangeError(`Frames [${start}, ${start + frames}) exceed a ${c.length}-frame channel`);
  }
  const bytes = new Uint8Array(frames * n * INPUT_BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < n; c++) view.setFloat32((f * n + c) * INPUT_BYTES_PER_SAMPLE, channels[c]![start + f]!, true);
  }
  return bytes;
}

/** FrameSource over a RUN_INPUT_FILE: one positional read per window, de-interleaved into the engine's buffers. */
export function interleavedFileSource(totalFrames: number, sampleRate: number, channels: number, read: ByteReadPort): FrameSource {
  if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0) throw new RangeError(`Invalid frame count ${totalFrames}`);
  if (!Number.isSafeInteger(channels) || channels < 1) throw new RangeError(`Invalid channel count ${channels}`);
  let scratch = new Uint8Array(0);
  return {
    totalFrames,
    sampleRate,
    async read(start, frames, out) {
      if (start < 0 || frames < 0 || start + frames > totalFrames) throw new RangeError(`Frames [${start}, ${start + frames}) outside the song`);
      if (out.length !== channels) throw new RangeError(`Expected ${channels} output channels, got ${out.length}`);
      const bytes = frames * channels * INPUT_BYTES_PER_SAMPLE;
      if (scratch.length < bytes) scratch = new Uint8Array(bytes);
      const view = scratch.subarray(0, bytes);
      const got = await read(start * channels * INPUT_BYTES_PER_SAMPLE, view);
      if (got !== bytes) throw new Error(`Short read from the stored song: ${got} of ${bytes} bytes at frame ${start}`);
      const dv = new DataView(view.buffer, view.byteOffset, bytes);
      for (let c = 0; c < channels; c++) {
        const dst = out[c]!;
        for (let f = 0; f < frames; f++) dst[f] = dv.getFloat32((f * channels + c) * INPUT_BYTES_PER_SAMPLE, true);
      }
    },
  };
}
