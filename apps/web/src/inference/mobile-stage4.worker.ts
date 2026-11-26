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
  STAGE4_RESUME_EXPECTATION,
  maxAbsDifference,
  stage4TestSignal,
  stage4Threads,
  WASM_CAP_LADDER_PAGES,
  type PinnedFile,
  type RunManifest,
  type SegmentRunner,
} from '@stemsplit/core';
import { installWasmMemoryCap } from './wasm-memory.ts';
import { resumeDiskRun, startDiskRun, type DiskRunHooks, type DiskRunSpec } from './disk-run.ts';
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

/** The card writes all six model stems to its own directory (the main app's disk path uses another one). */
const SPEC: DiskRunSpec = {
  directory: STAGE4_STEM_DIRECTORY,
  expectation: STAGE4_RESUME_EXPECTATION,
  modelStems: MOBILE_STAGE4_CANDIDATE.io.stems,
  sampleFormat: STAGE4_STEM_SAMPLE_FORMAT,
  async openRunner(threads) {
    const { ort, session } = await openSession(threads);
    return { runner: runner(ort, session), release: () => session.release() };
  },
};

const HOOKS: DiskRunHooks = {
  log: report,
  progress: (p) => report(`Window ${p.chunk}/${p.chunks} done · ${clock(p.elapsedMs)} elapsed · about ${clock(p.etaMs ?? 0)} left · ${heap()}`),
};

async function runSong(left: Float32Array, right: Float32Array, threads: number, source: RunManifest['source']): Promise<void> {
  await startDiskRun(SPEC, HOOKS, { left, right }, threads, source);
  report(`Session released · ${heap()}`);
  post({ done: true, message: 'Song separation complete' });
}

async function runResume(threads: number): Promise<void> {
  const result = await resumeDiskRun(SPEC, HOOKS, threads);
  report(`Session released · ${heap()}`);
  post({ done: true, message: result.resumedFromChunk > 0 ? 'Resumed song separation complete' : 'Song separation complete' });
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
