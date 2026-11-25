/// <reference lib="webworker" />
/**
 * Inference worker: owns the ORT session so the UI thread never blocks, and so the model bytes never touch the
 * main thread's heap.
 *
 * Session settings come from the registry, so the same code runs either primary artifact (rollback-safe):
 *  - graph optimisation for the browser tier (Stage IV: 'disabled'; folding re-enables ORT's buffer-reuse trap);
 *  - external data (Stage IV weights) passed as bytes, dropped after create() so the heap keeps one copy;
 *  - the artifact's validated WASM memory cap, installed before ORT is imported;
 *  - the plain WASM build for 'wasm' (the build validated on the iPhone), the JSEP build only for 'webgpu'.
 */
import type { SegmentRunner } from '@stemsplit/core';
import {
  PRIMARY_SEPARATION_MODEL,
  SeparationAbortedError,
  buildProjection,
  graphOptimizationFor,
  memorySource,
  projectBlock,
  requireIO,
  separate,
} from '@stemsplit/core';
import { loadModel } from '../platform/model-cache.ts';
import type { FromWorker, ToWorker } from './protocol.ts';
import { installWasmMemoryCap } from './wasm-memory.ts';

declare const self: DedicatedWorkerGlobalScope;

type Ort = typeof import('onnxruntime-web/wasm');
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;

const MODEL = PRIMARY_SEPARATION_MODEL;
if (MODEL.browserWasmMemoryCapPages) installWasmMemoryCap(MODEL.browserWasmMemoryCapPages);

let abortReason: string | null = null;
let ort: Ort | null = null;
let session: Session | null = null;
let sessionEp: string | null = null;

const post = (msg: FromWorker, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

async function runtime(ep: 'webgpu' | 'wasm'): Promise<Ort> {
  if (ep === 'webgpu' && MODEL.epSupport.webgpu === 'unsupported') {
    throw new Error(`${MODEL.id} cannot run on WebGPU; routing should have chosen WASM`);
  }
  // One runtime per worker: switching EP after the first session would mix two ORT builds in one heap.
  if (!ort) {
    ort = (ep === 'webgpu' ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm')) as Ort;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  }
  return ort;
}

async function getSession(ep: 'webgpu' | 'wasm'): Promise<{ ort: Ort; session: Session }> {
  const rt = await runtime(ep);
  if (session && sessionEp === ep) return { ort: rt, session };
  await session?.release();
  session = null;
  let files: Awaited<ReturnType<typeof loadModel>> | null = await loadModel(MODEL, (loaded, total) => post({ type: 'model-progress', loaded, total }));
  const t0 = performance.now();
  const created = await rt.InferenceSession.create(files.graph, {
    executionProviders: ep === 'webgpu' ? ['webgpu'] : ['wasm'],
    graphOptimizationLevel: graphOptimizationFor(MODEL, 'browser'),
    enableMemPattern: false,
    enableCpuMemArena: false,
    ...(files.data && MODEL.externalData ? { externalData: [{ path: MODEL.externalData.file, data: files.data }] } : {}),
  });
  files = null; // the session holds its own copy; let the download buffers go
  session = created;
  sessionEp = ep;
  post({ type: 'session-ready', ep, createMs: performance.now() - t0 });
  return { ort: rt, session: created };
}

async function run(msg: Extract<ToWorker, { type: 'run' }>): Promise<void> {
  abortReason = null;
  const io = requireIO(MODEL);
  const { ort: rt, session: sess } = await getSession(msg.ep);
  const shape = [1, io.channels, io.segmentFrames];
  const runner: SegmentRunner = {
    io,
    async run(input) {
      const tensor = new rt.Tensor('float32', input, shape);
      const out = await sess.run({ [io.inputName]: tensor });
      tensor.dispose();
      const t = out[io.outputName];
      if (!t) throw new Error(`Model returned no "${io.outputName}" output`);
      const data = (await t.getData()) as Float32Array;
      const copy = new Float32Array(data);
      for (const v of Object.values(out)) v.dispose();
      return copy;
    },
  };
  const projection = buildProjection(io.stems, msg.wanted);
  await separate(
    memorySource([msg.left, msg.right], io.sampleRate),
    runner,
    {
      write(block) {
        const stems = [...projectBlock(block, projection)].map(([stem, [l, r]]) => [stem, l!, r!] as const);
        post({ type: 'block', start: block.start, frames: block.frames, stems }, stems.flatMap(([, l, r]) => [l.buffer, r.buffer]));
      },
    },
    {
      beforeChunk: () => {
        if (abortReason !== null) throw new SeparationAbortedError(abortReason);
      },
      onProgress: (progress) => post({ type: 'progress', progress }),
    },
  );
  post({ type: 'done' });
}

/**
 * ORT's Emscripten pthreads are spawned as `new Worker(import.meta.url, { name: 'em-pthread' })`.
 * Once bundled, that URL is *this* module, so every WASM thread re-executes this file. Installing
 * our handler there would swallow the thread-init messages and deadlock the pool (observed in
 * headless Chromium: the session never finishes creating). Threads must leave messaging to ORT.
 */
const IS_ORT_PTHREAD = self.name.startsWith('em-pthread');

if (!IS_ORT_PTHREAD) self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'abort') {
    abortReason = msg.reason;
    return;
  }
  run(msg).catch((err: unknown) => {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      aborted: err instanceof SeparationAbortedError,
    });
  });
};
