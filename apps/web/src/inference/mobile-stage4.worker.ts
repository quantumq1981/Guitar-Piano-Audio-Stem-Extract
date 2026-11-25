/// <reference lib="webworker" />
/**
 * Opt-in experiments with the Stage IV low-memory candidate (docs/MOBILE-INFERENCE-DEVELOPMENT.md): plain WASM
 * build, 1-4 threads (STAGE4_THREAD_OPTIONS), graph optimisation disabled, external weights, both files SHA-256 verified. Every stage is
 * reported with the WebAssembly heap, so a tab the OS kills still leaves the last measured stage in the log.
 *
 *  - `test`: N synthetic windows (memory, speed, repeatability).
 *  - `song`: a whole decoded song through the shared overlap-add engine. The song is first stored in the
 *    origin-private file system (OPFS) as float32, and windows are read back from it; each stem streams into a
 *    24-bit WAV there as blocks are finalised. Memory does not grow with song length, and the run can be resumed.
 *  - `resume`: continues a stopped `song` run from its last whole block (core decideResume; bit-identical result).
 */
import {
  MOBILE_STAGE4_CANDIDATE,
  RUN_INPUT_FILE,
  RUN_MANIFEST_FILE,
  RUN_MANIFEST_VERSION,
  STAGE4_RESUME_EXPECTATION,
  decideResume,
  encodeInterleavedF32,
  interleavedFileSource,
  maxAbsDifference,
  parseRunManifest,
  planChunks,
  separate,
  stage4TestSignal,
  stemFormatOf,
  stage4Threads,
  wavStemSink,
  WASM_CAP_LADDER_PAGES,
  type PinnedFile,
  type RunManifest,
  type SegmentRunner,
} from '@stemsplit/core';
import { installWasmMemoryCap } from './wasm-memory.ts';
import { STAGE4_STEM_DIRECTORY, STAGE4_STEM_SAMPLE_FORMAT, type Stage4Request, type Stage4Message } from './stage4-protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: Stage4Message) => self.postMessage(msg);
const report = (message: string) => post({ message });
const mib = (bytes: number) => (bytes / 2 ** 20).toFixed(0) + ' MiB';
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;

// Track (and cap) every WebAssembly.Memory this worker creates. Installed before ORT is imported.
const wasmMemory = installWasmMemoryCap(WASM_CAP_LADDER_PAGES);
const heap = () => wasmMemory.heap();

async function fetchVerified(file: PinnedFile): Promise<Uint8Array> {
  const response = await fetch(import.meta.env.BASE_URL + 'models/' + file.file);
  if (!response.ok) throw new Error(`${file.file}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== file.bytes) throw new Error(`${file.file}: ${bytes.byteLength} bytes, expected ${file.bytes}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  if (hash !== file.sha256) throw new Error(`${file.file}: checksum mismatch`);
  return bytes;
}

type Ort = typeof import('onnxruntime-web/wasm');
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;

async function openSession(requestedThreads: number): Promise<{ ort: Ort; session: Session }> {
  const c = MOBILE_STAGE4_CANDIDATE;
  const threads = stage4Threads(requestedThreads, { crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency });
  report(`Environment: ${navigator.userAgent} · crossOriginIsolated ${String(self.crossOriginIsolated)} · ${navigator.hardwareConcurrency} cores`);
  report(`Downloading Stage IV model (${mib(c.graph.bytes + c.data.bytes)}, two files)…`);
  let graph: Uint8Array | null = await fetchVerified(c.graph);
  let data: Uint8Array | null = await fetchVerified(c.data);
  report('Integrity PASS (graph + weights); loading ONNX Runtime WASM…');
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'warning';
  const reduced = threads < requestedThreads ? ` (${requestedThreads} requested; ${self.crossOriginIsolated ? `${navigator.hardwareConcurrency} cores` : 'page not cross-origin isolated'})` : '';
  report(`Creating session (ORT ${ort.env.versions.web ?? '?'}, WASM, ${threads} thread${threads === 1 ? '' : 's'}${reduced}, graph optimisation disabled)…`);
  const start = performance.now();
  const session = await ort.InferenceSession.create(graph, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: c.session.graphOptimizationLevel,
    enableMemPattern: c.session.enableMemPattern,
    enableCpuMemArena: c.session.enableCpuMemArena,
    externalData: [{ path: c.data.file, data }],
  });
  graph = null;
  data = null;
  report(`Session ready in ${((performance.now() - start) / 1000).toFixed(1)} s · ${heap()} · ${wasmMemory.capNote}`);
  return { ort, session };
}

function runner(ort: Ort, session: Session): SegmentRunner {
  const { io } = MOBILE_STAGE4_CANDIDATE;
  const shape = [1, io.channels, io.segmentFrames];
  return {
    io,
    async run(input) {
      const tensor = new ort.Tensor('float32', input, shape);
      const outputs = await session.run({ [io.inputName]: tensor });
      tensor.dispose();
      const stems = outputs[io.outputName];
      const data = stems ? ((await stems.getData()) as Float32Array) : null;
      const copy = data ? new Float32Array(data) : null;
      for (const t of Object.values(outputs)) t.dispose();
      if (!copy || copy.length !== io.stems.length * io.channels * io.segmentFrames || !copy.every(Number.isFinite)) {
        throw new Error('missing, misshapen or non-finite model output');
      }
      return copy;
    },
  };
}

async function runTest(windows: number, threads: number): Promise<void> {
  const { ort, session } = await openSession(threads);
  try {
    const { segmentFrames, channels } = MOBILE_STAGE4_CANDIDATE.io;
    const run = runner(ort, session);
    const mix = stage4TestSignal(segmentFrames, channels);
    let first: Float32Array | null = null;
    for (let w = 1; w <= windows; w++) {
      report(`Running window ${w}/${windows} (7.8 s stereo)…`);
      const start = performance.now();
      const result = await run.run(mix);
      const seconds = (performance.now() - start) / 1000;
      let repeat = '';
      if (first === null) first = result;
      else repeat = ` · repeat vs window 1: max |Δ| ${maxAbsDifference(first, result)}`;
      report(`Window ${w} PASS in ${seconds.toFixed(1)} s (real-time factor ${(seconds / 7.8).toFixed(2)}) · ${heap()}${repeat}`);
    }
  } finally {
    await session.release();
  }
  report(`Session released · ${heap()}`);
  post({ done: true, message: 'Stage IV test complete' });
}

const EXPECTED = STAGE4_RESUME_EXPECTATION;
const STEM_FILES = MOBILE_STAGE4_CANDIDATE.io.stems.map((stem) => `${stem}.wav`);
/** Frames per input write: 1 MiB of interleaved float32 stereo, so the song is never copied whole. */
const INPUT_BLOCK_FRAMES = 131_072;

async function runDirectory(fresh: boolean): Promise<FileSystemDirectoryHandle> {
  if (typeof FileSystemFileHandle === 'undefined' || !('createSyncAccessHandle' in FileSystemFileHandle.prototype)) {
    throw new Error('This browser cannot write files from a worker (OPFS sync access handles are missing)');
  }
  // Safari Private Browsing rejects this with UnknownError ("unknown transient reason (e.g. out of memory)").
  const root = await navigator.storage.getDirectory().catch((error: unknown) => {
    throw new Error(`On-device storage is blocked in this window (${String(error).replace(/\.$/, '')}); Safari does this in Private Browsing`);
  });
  if (fresh) await root.removeEntry(STAGE4_STEM_DIRECTORY, { recursive: true }).catch(() => {});
  return root.getDirectoryHandle(STAGE4_STEM_DIRECTORY, { create: fresh });
}

/** Waits between attempts to lock a file still held by a stopped worker: terminate() releases OPFS sync access
 * handles asynchronously (measured in Chromium: Resume 250 ms after a stop failed with NoModificationAllowedError). */
const LOCK_RETRY_MS = [50, 100, 200, 400, 800, 1600, 3200];

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

async function runSong(left: Float32Array | null, right: Float32Array | null, threads: number, source: RunManifest['source']): Promise<void> {
  if (!left || !right) throw new Error('No audio received');
  const { io } = MOBILE_STAGE4_CANDIDATE;
  const totalFrames = left.length;
  const plan = planChunks(totalFrames, io.segmentFrames, EXPECTED.overlapRatio);
  report(`Song: ${(totalFrames / io.sampleRate).toFixed(1)} s · ${plan.chunks.length} windows · stems stream to on-device storage as 24-bit WAV`);
  const dir = await runDirectory(true);
  const input = await openSync(dir, RUN_INPUT_FILE, true);
  try {
    for (let start = 0; start < totalFrames; start += INPUT_BLOCK_FRAMES) {
      const frames = Math.min(INPUT_BLOCK_FRAMES, totalFrames - start);
      writeAll(input!, RUN_INPUT_FILE, encodeInterleavedF32([left, right], start, frames), start * io.channels * 4);
    }
    input!.flush();
  } finally {
    input!.close();
  }
  left = null; // windows are read back from the stored song from here on
  right = null;
  const manifest: RunManifest = {
    version: RUN_MANIFEST_VERSION,
    ...EXPECTED,
    totalFrames,
    sampleFormat: STAGE4_STEM_SAMPLE_FORMAT,
    source,
    threads,
    createdAt: new Date().toISOString(),
  };
  const json = await openSync(dir, RUN_MANIFEST_FILE, true);
  try {
    writeAll(json!, RUN_MANIFEST_FILE, new TextEncoder().encode(JSON.stringify(manifest)), 0);
    json!.flush();
  } finally {
    json!.close();
  }
  report(`Stored the song on the device (${mib(totalFrames * io.channels * 4)}), so a stopped run can resume`);
  await separateStored(dir, manifest, { startChunk: 0, keepFrames: 0, keepBytes: 0 }, threads);
}

async function runResume(threads: number): Promise<void> {
  const dir = await runDirectory(false).catch(() => {
    throw new Error('No stopped run is stored on this device');
  });
  const manifestFile = await (await dir.getFileHandle(RUN_MANIFEST_FILE).catch(() => {
    throw new Error('The stored run has no run.json; it was started by an older version and cannot resume');
  })).getFile();
  const manifest = parseRunManifest(await manifestFile.text());
  if (!manifest) throw new Error('The stored run.json is not valid');
  const sizes: (number | null)[] = [];
  for (const name of [RUN_INPUT_FILE, ...STEM_FILES]) {
    const handle = await openSync(dir, name, false);
    sizes.push(handle ? handle.getSize() : null);
    handle?.close();
  }
  const decision = decideResume(manifest, EXPECTED, { inputBytes: sizes[0]!, stemBytes: sizes.slice(1) });
  if (decision.kind === 'unusable') throw new Error(`Cannot resume: ${decision.reason}. Delete the stems and start again`);
  if (decision.kind === 'complete') {
    post({ done: true, message: 'The stored run is already complete' });
    return;
  }
  const done = decision.startChunk;
  report(`Resuming ${manifest.source.name}: ${done} of ${decision.plan.chunks.length} windows were finished` +
    (done > 0 ? `; re-running window ${done} to rebuild the overlap, then continuing` : '; starting from the first window') +
    (threads !== manifest.threads ? ` · ${threads} threads now, ${manifest.threads} before (same quality; not bit-identical at the seam)` : ''));
  await separateStored(dir, manifest, decision, threads);
}

interface ResumePoint {
  readonly startChunk: number;
  readonly keepFrames: number;
  readonly keepBytes: number;
}

/** Separates the stored song into the stems from `at.startChunk`, after truncating every stem to `at.keepBytes`. */
async function separateStored(dir: FileSystemDirectoryHandle, manifest: RunManifest, at: ResumePoint, threads: number): Promise<void> {
  const { startChunk, keepFrames, keepBytes } = at;
  const { io } = MOBILE_STAGE4_CANDIDATE;
  const stems = await Promise.all(STEM_FILES.map((name) => openSync(dir, name, true))) as FileSystemSyncAccessHandle[];
  const input = (await openSync(dir, RUN_INPUT_FILE, false))!;
  let session: Awaited<ReturnType<typeof openSession>>['session'] | null = null;
  let finished = false;
  try {
    for (const h of stems) h.truncate(keepBytes);
    const opened = await openSession(threads);
    session = opened.session;
    const sink = wavStemSink(io.stems.length, manifest.totalFrames, stemFormatOf(manifest), (stem, offset, bytes) => writeAll(stems[stem]!, STEM_FILES[stem]!, bytes, offset), { resumeFrom: keepFrames });
    const source = interleavedFileSource(manifest.totalFrames, io.sampleRate, io.channels, (offset, into) => input.read(into, { at: offset }));
    await separate(source, runner(opened.ort, opened.session), sink, {
      overlapRatio: manifest.overlapRatio,
      startChunk,
      onProgress: (p) => report(`Window ${p.chunk}/${p.chunks} done · ${clock(p.elapsedMs)} elapsed · about ${clock(p.etaMs ?? 0)} left · ${heap()}`),
    });
    const summary = sink.finish();
    for (const h of stems) h.flush();
    finished = true;
    const clipped = io.stems.filter((_, i) => (summary.peaks[i] ?? 0) > 1);
    report(`All ${summary.frames} frames written · ${io.stems.length} × ${mib(summary.fileBytes)}` +
      (clipped.length ? ` · clipped (peak above full scale): ${clipped.join(', ')}` : ' · no clipping') +
      (startChunk > 0 ? ' (peaks cover this session only)' : ''));
  } finally {
    for (const h of stems) h.close();
    input.close();
    await session?.release();
  }
  // The stored song is only needed to resume; free its space once the stems are complete.
  if (finished) await dir.removeEntry(RUN_INPUT_FILE).catch(() => {});
  report(`Session released · ${heap()}`);
  post({ done: true, message: startChunk > 0 ? 'Resumed song separation complete' : 'Song separation complete' });
}

if (!self.name.startsWith('em-pthread')) {
  self.onmessage = (e: MessageEvent<Stage4Request>) => {
    const msg = e.data;
    const job = msg.type === 'song' ? runSong(msg.left, msg.right, msg.threads, msg.source)
      : msg.type === 'resume' ? runResume(msg.threads)
      : runTest(Math.max(1, Math.min(5, msg.windows)), msg.threads);
    job.catch((error: unknown) => post({ done: true, message: `FAIL: ${String(error)} · ${heap()}` }));
  };
}
