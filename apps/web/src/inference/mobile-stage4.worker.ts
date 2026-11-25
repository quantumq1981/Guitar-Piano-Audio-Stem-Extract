/// <reference lib="webworker" />
/**
 * Opt-in experiments with the Stage IV low-memory candidate (docs/MOBILE-INFERENCE-DEVELOPMENT.md): plain WASM
 * build, 1-4 threads (STAGE4_THREAD_OPTIONS), graph optimisation disabled, external weights, both files SHA-256 verified. Every stage is
 * reported with the WebAssembly heap, so a tab the OS kills still leaves the last measured stage in the log.
 *
 *  - `test`: N synthetic windows (memory, speed, repeatability).
 *  - `song`: a whole decoded song through the shared overlap-add engine. Each stem streams into a 24-bit WAV in
 *    the origin-private file system (OPFS) as blocks are finalised, so memory does not grow with song length.
 */
import {
  MOBILE_STAGE4_CANDIDATE,
  capWasmMemoryDescriptor,
  maxAbsDifference,
  memorySource,
  planChunks,
  separate,
  stage4TestSignal,
  stage4Threads,
  touchedBytes,
  wavStemSink,
  WASM_CAP_LADDER_PAGES,
  type PinnedFile,
  type SegmentRunner,
} from '@stemsplit/core';
import { STAGE4_STEM_DIRECTORY, STAGE4_STEM_SAMPLE_FORMAT, type Stage4Request, type Stage4Message } from './stage4-protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: Stage4Message) => self.postMessage(msg);
const report = (message: string) => post({ message });
const mib = (bytes: number) => (bytes / 2 ** 20).toFixed(0) + ' MiB';
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;

// Track (and cap) every WebAssembly.Memory this worker creates. Installed before ORT is imported.
const memories: WebAssembly.Memory[] = [];
let capNote = 'no shared memory requested';
const NativeMemory = WebAssembly.Memory;
function CappedMemory(descriptor: WebAssembly.MemoryDescriptor): WebAssembly.Memory {
  let lastError: unknown;
  for (const cap of WASM_CAP_LADDER_PAGES) {
    const capped = capWasmMemoryDescriptor(descriptor, cap);
    try {
      const memory = new NativeMemory(capped);
      memories.push(memory);
      capNote = capped === descriptor ? 'requested maximum kept' : `maximum capped at ${mib(cap * 65_536)}`;
      return memory;
    } catch (error) {
      if (!(error instanceof RangeError) || capped === descriptor) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
CappedMemory.prototype = NativeMemory.prototype;
(WebAssembly as unknown as { Memory: unknown }).Memory = CappedMemory;

function heap(): string {
  const reserved = memories.reduce((sum, m) => sum + m.buffer.byteLength, 0);
  const touched = memories.reduce((sum, m) => sum + touchedBytes(m.buffer), 0);
  return `WASM heap ${mib(reserved)} (touched ${mib(touched)})`;
}

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
  report(`Session ready in ${((performance.now() - start) / 1000).toFixed(1)} s · ${heap()} · ${capNote}`);
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

async function runSong(left: Float32Array, right: Float32Array, threads: number): Promise<void> {
  const { io } = MOBILE_STAGE4_CANDIDATE;
  const plan = planChunks(left.length, io.segmentFrames);
  report(`Song: ${(left.length / io.sampleRate).toFixed(1)} s · ${plan.chunks.length} windows · stems stream to on-device storage as 24-bit WAV`);
  if (typeof FileSystemFileHandle === 'undefined' || !('createSyncAccessHandle' in FileSystemFileHandle.prototype)) {
    throw new Error('This browser cannot write files from a worker (OPFS sync access handles are missing)');
  }
  // Safari Private Browsing rejects this with UnknownError ("unknown transient reason (e.g. out of memory)").
  const root = await navigator.storage.getDirectory().catch((error: unknown) => {
    throw new Error(`On-device storage is blocked in this window (${String(error).replace(/\.$/, '')}); Safari does this in Private Browsing`);
  });
  await root.removeEntry(STAGE4_STEM_DIRECTORY, { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle(STAGE4_STEM_DIRECTORY, { create: true });
  const files = io.stems.map((stem) => `${stem}.wav`);
  const handles = await Promise.all(files.map(async (name) => (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle()));
  const { ort, session } = await openSession(threads);
  try {
    const sink = wavStemSink(io.stems.length, left.length, { sampleRate: io.sampleRate, channels: io.channels, sampleFormat: STAGE4_STEM_SAMPLE_FORMAT },
      (stem, offset, bytes) => {
        const written = handles[stem]!.write(bytes, { at: offset });
        if (written !== bytes.length) throw new Error(`Short write to ${files[stem]} (${written} of ${bytes.length} bytes): storage full?`);
      });
    await separate(memorySource([left, right], io.sampleRate), runner(ort, session), sink, {
      onProgress: (p) => report(`Window ${p.chunk}/${p.chunks} done · ${clock(p.elapsedMs)} elapsed · about ${clock(p.etaMs ?? 0)} left · ${heap()}`),
    });
    const summary = sink.finish();
    for (const h of handles) h.flush();
    const clipped = io.stems.filter((_, i) => (summary.peaks[i] ?? 0) > 1);
    report(`All ${summary.frames} frames written · ${io.stems.length} × ${mib(summary.fileBytes)}` +
      (clipped.length ? ` · clipped (peak above full scale): ${clipped.join(', ')}` : ' · no clipping'));
  } finally {
    for (const h of handles) h.close();
    await session.release();
  }
  report(`Session released · ${heap()}`);
  post({ done: true, message: 'Song separation complete' });
}

if (!self.name.startsWith('em-pthread')) {
  self.onmessage = (e: MessageEvent<Stage4Request>) => {
    const msg = e.data;
    const job = msg.type === 'song' ? runSong(msg.left, msg.right, msg.threads) : runTest(Math.max(1, Math.min(5, msg.windows)), msg.threads);
    job.catch((error: unknown) => post({ done: true, message: `FAIL: ${String(error)} · ${heap()}` }));
  };
}
