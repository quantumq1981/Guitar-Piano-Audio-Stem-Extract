/// <reference lib="webworker" />
/**
 * Worker-side runner for on-device separations that stream through the origin-private file system (OPFS):
 * the song is stored once as float32 (`input.f32`), windows are read back from it, every output stem streams into a
 * 24-bit WAV as blocks are finalised, and `run.json` identifies the run so a stopped one resumes bit-identically
 * (core separation/resume.ts). Memory does not grow with song length.
 *
 * Shared by the experimental card (mobile-stage4.worker.ts, all six stems) and the main app's disk path
 * (device-run.worker.ts, the scope's projected stems). Only the session and the reporting differ, so they are hooks.
 */
import {
  RUN_INPUT_FILE,
  RUN_MANIFEST_FILE,
  RUN_MANIFEST_VERSION,
  buildProjection,
  decideResume,
  encodeInterleavedF32,
  interleavedFileSource,
  isStemName,
  parseRunManifest,
  planChunks,
  projectBlock,
  separate,
  stemFormatOf,
  wavStemSink,
  type FinalizedBlock,
  type ResumeExpectation,
  type RunManifest,
  type SegmentRunner,
  type SeparationProgress,
  type StemName,
  type StemSink,
  type WavSampleFormat,
} from '@stemsplit/core';

export interface DiskRunSpec {
  /** OPFS directory of this kind of run; one run is stored at a time. */
  readonly directory: string;
  /** Model identity and the outputs to write, in file order (`expectation.stems`). */
  readonly expectation: ResumeExpectation;
  /** Stem order of the model's output tensor. */
  readonly modelStems: readonly StemName[];
  readonly sampleFormat: WavSampleFormat;
  /** Opens the session; called after the song is stored, so the decoded copy is gone before the heap grows. */
  openRunner(threads: number): Promise<{ readonly runner: SegmentRunner; release(): Promise<void> }>;
}

export interface DiskRunHooks {
  log(message: string): void;
  progress?(p: SeparationProgress): void;
}

export interface DiskRunResult {
  readonly frames: number;
  /** Output stems whose float output exceeded full scale before 24-bit conversion. */
  readonly clipped: readonly string[];
  readonly resumedFromChunk: number;
}

/** Frames per input write: 1 MiB of interleaved float32 stereo, so the song is never copied whole. */
const INPUT_BLOCK_FRAMES = 131_072;
/** Waits between attempts to lock a file still held by a stopped worker: terminate() releases OPFS sync access
 * handles asynchronously (measured in Chromium: Resume 250 ms after a stop failed with NoModificationAllowedError). */
const LOCK_RETRY_MS = [50, 100, 200, 400, 800, 1600, 3200];

const mib = (bytes: number) => (bytes / 2 ** 20).toFixed(0) + ' MiB';
const fileOf = (stem: string) => `${stem}.wav`;

async function runDirectory(name: string, fresh: boolean): Promise<FileSystemDirectoryHandle> {
  if (typeof FileSystemFileHandle === 'undefined' || !('createSyncAccessHandle' in FileSystemFileHandle.prototype)) {
    throw new Error('This browser cannot write files from a worker (OPFS sync access handles are missing)');
  }
  // Safari Private Browsing rejects this with UnknownError ("unknown transient reason (e.g. out of memory)").
  const root = await navigator.storage.getDirectory().catch((error: unknown) => {
    throw new Error(`On-device storage is blocked in this window (${String(error).replace(/\.$/, '')}); Safari does this in Private Browsing`);
  });
  if (fresh) await root.removeEntry(name, { recursive: true }).catch(() => {});
  return root.getDirectoryHandle(name, { create: fresh });
}

async function openSync(dir: FileSystemDirectoryHandle, name: string, create: boolean): Promise<FileSystemSyncAccessHandle | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await (await dir.getFileHandle(name, { create })).createSyncAccessHandle();
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      if (!create && error.name === 'NotFoundError') return null;
      const wait = LOCK_RETRY_MS[attempt];
      if (error.name !== 'NoModificationAllowedError' || wait === undefined) {
        throw error.name === 'NoModificationAllowedError'
          ? new Error(`${name} is still held by the stopped run; wait a few seconds and try again`)
          : error;
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

function writeAll(handle: FileSystemSyncAccessHandle, name: string, bytes: Uint8Array, at: number): void {
  const written = handle.write(bytes, { at });
  if (written !== bytes.length) throw new Error(`Short write to ${name} (${written} of ${bytes.length} bytes): storage full?`);
}

/** Maps model-stem blocks onto the outputs (in file order); identity when the outputs are the model's stems. */
function outputSink(spec: DiskRunSpec, sink: StemSink): StemSink {
  const outputs = spec.expectation.stems;
  const identity = outputs.length === spec.modelStems.length && outputs.every((s, i) => s === spec.modelStems[i]);
  if (identity) return sink;
  if (!outputs.every(isStemName)) throw new Error(`Unknown output stem in ${outputs.join(', ')}`);
  const projection = buildProjection(spec.modelStems, outputs as readonly StemName[]);
  return {
    write(block: FinalizedBlock) {
      const projected = projectBlock(block, projection);
      return sink.write({ start: block.start, frames: block.frames, planes: outputs.map((o) => projected.get(o as StemName)!) });
    },
  };
}

/** Stores the song, writes run.json, then separates it from the first window. The buffers are dropped after storing. */
export async function startDiskRun(
  spec: DiskRunSpec,
  hooks: DiskRunHooks,
  song: { left: Float32Array | null; right: Float32Array | null },
  threads: number,
  source: RunManifest['source'],
): Promise<DiskRunResult> {
  const { left, right } = song;
  if (!left || !right || left.length !== right.length || left.length === 0) throw new Error('No audio received');
  const { expectation: e } = spec;
  const totalFrames = left.length;
  const plan = planChunks(totalFrames, e.segmentFrames, e.overlapRatio);
  hooks.log(`Song: ${(totalFrames / e.sampleRate).toFixed(1)} s · ${plan.chunks.length} windows · ${e.stems.length} stems stream to on-device storage`);
  const dir = await runDirectory(spec.directory, true);
  const input = (await openSync(dir, RUN_INPUT_FILE, true))!;
  try {
    for (let start = 0; start < totalFrames; start += INPUT_BLOCK_FRAMES) {
      const frames = Math.min(INPUT_BLOCK_FRAMES, totalFrames - start);
      writeAll(input, RUN_INPUT_FILE, encodeInterleavedF32([left, right], start, frames), start * e.channels * 4);
    }
    input.flush();
  } finally {
    input.close();
  }
  song.left = null; // windows are read back from the stored song from here on
  song.right = null;
  const manifest: RunManifest = {
    version: RUN_MANIFEST_VERSION,
    ...e,
    totalFrames,
    sampleFormat: spec.sampleFormat,
    source,
    threads,
    createdAt: new Date().toISOString(),
  };
  const json = (await openSync(dir, RUN_MANIFEST_FILE, true))!;
  try {
    writeAll(json, RUN_MANIFEST_FILE, new TextEncoder().encode(JSON.stringify(manifest)), 0);
    json.flush();
  } finally {
    json.close();
  }
  hooks.log(`Stored the song on the device (${mib(totalFrames * e.channels * 4)}), so a stopped run can resume`);
  return separateStored(spec, hooks, dir, manifest, { startChunk: 0, keepFrames: 0, keepBytes: 0 }, threads);
}

/** Continues the stored run from its last whole block (core decideResume); a complete run returns at once. */
export async function resumeDiskRun(spec: DiskRunSpec, hooks: DiskRunHooks, threads: number): Promise<DiskRunResult> {
  const dir = await runDirectory(spec.directory, false).catch(() => {
    throw new Error('No stopped run is stored on this device');
  });
  const manifestFile = await (await dir.getFileHandle(RUN_MANIFEST_FILE).catch(() => {
    throw new Error('The stored run has no run.json; it was started by an older version and cannot resume');
  })).getFile();
  const manifest = parseRunManifest(await manifestFile.text());
  if (!manifest) throw new Error('The stored run.json is not valid');
  const sizes: (number | null)[] = [];
  for (const name of [RUN_INPUT_FILE, ...spec.expectation.stems.map(fileOf)]) {
    const handle = await openSync(dir, name, false);
    sizes.push(handle ? handle.getSize() : null);
    handle?.close();
  }
  const decision = decideResume(manifest, spec.expectation, { inputBytes: sizes[0]!, stemBytes: sizes.slice(1) });
  if (decision.kind === 'unusable') throw new Error(`Cannot resume: ${decision.reason}. Delete the stems and start again`);
  if (decision.kind === 'complete') return { frames: manifest.totalFrames, clipped: [], resumedFromChunk: decision.plan.chunks.length };
  const done = decision.startChunk;
  hooks.log(`Resuming ${manifest.source.name}: ${done} of ${decision.plan.chunks.length} windows were finished` +
    (done > 0 ? `; re-running window ${done} to rebuild the overlap, then continuing` : '; starting from the first window') +
    (threads !== manifest.threads ? ` · ${threads} threads now, ${manifest.threads} before (same quality; not bit-identical at the seam)` : ''));
  return separateStored(spec, hooks, dir, manifest, decision, threads);
}

interface ResumePoint {
  readonly startChunk: number;
  readonly keepFrames: number;
  readonly keepBytes: number;
}

/** Separates the stored song into the outputs from `at.startChunk`, after truncating every stem to `at.keepBytes`. */
async function separateStored(
  spec: DiskRunSpec,
  hooks: DiskRunHooks,
  dir: FileSystemDirectoryHandle,
  manifest: RunManifest,
  at: ResumePoint,
  threads: number,
): Promise<DiskRunResult> {
  const { startChunk, keepFrames, keepBytes } = at;
  const files = manifest.stems.map(fileOf);
  const stems = (await Promise.all(files.map((name) => openSync(dir, name, true)))) as FileSystemSyncAccessHandle[];
  const input = (await openSync(dir, RUN_INPUT_FILE, false))!;
  let opened: Awaited<ReturnType<DiskRunSpec['openRunner']>> | null = null;
  let result: DiskRunResult | null = null;
  try {
    for (const h of stems) h.truncate(keepBytes);
    opened = await spec.openRunner(threads);
    const sink = wavStemSink(files.length, manifest.totalFrames, stemFormatOf(manifest), (stem, offset, bytes) => writeAll(stems[stem]!, files[stem]!, bytes, offset), {
      resumeFrom: keepFrames,
    });
    const source = interleavedFileSource(manifest.totalFrames, manifest.sampleRate, manifest.channels, (offset, into) => input.read(into, { at: offset }));
    await separate(source, opened.runner, outputSink(spec, sink), {
      overlapRatio: manifest.overlapRatio,
      startChunk,
      ...(hooks.progress ? { onProgress: hooks.progress } : {}),
    });
    const summary = sink.finish();
    for (const h of stems) h.flush();
    const clipped = manifest.stems.filter((_, i) => (summary.peaks[i] ?? 0) > 1);
    hooks.log(`All ${summary.frames} frames written · ${files.length} × ${mib(summary.fileBytes)}` +
      (clipped.length ? ` · clipped (peak above full scale): ${clipped.join(', ')}` : ' · no clipping') +
      (startChunk > 0 ? ' (peaks cover this session only)' : ''));
    result = { frames: summary.frames, clipped, resumedFromChunk: startChunk };
  } finally {
    for (const h of stems) h.close();
    input.close();
    await opened?.release();
  }
  // The stored song is only needed to resume; free its space once the stems are complete.
  await dir.removeEntry(RUN_INPUT_FILE).catch(() => {});
  return result;
}
