/// <reference lib="webworker" />
/**
 * Inference worker: owns the ORT session so the UI thread never blocks, and so
 * the model bytes never touch the main thread's heap.
 */
import * as ort from 'onnxruntime-web/webgpu';
import type { SegmentRunner } from '@stemsplit/core';
import { PRIMARY_SEPARATION_MODEL, SeparationAbortedError, buildProjection, memorySource, projectBlock, requireIO, separate } from '@stemsplit/core';
import { loadModel } from '../platform/model-cache.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

let abortReason: string | null = null;
let session: ort.InferenceSession | null = null;
let sessionEp: string | null = null;

const post = (msg: FromWorker, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

async function getSession(ep: 'webgpu' | 'wasm'): Promise<ort.InferenceSession> {
  if (session && sessionEp === ep) return session;
  await session?.release();
  const bytes = await loadModel(PRIMARY_SEPARATION_MODEL, (loaded, total) => post({ type: 'model-progress', loaded, total }));
  const t0 = performance.now();
  session = await ort.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: ep === 'webgpu' ? ['webgpu'] : ['wasm'],
    graphOptimizationLevel: 'all',
    enableMemPattern: false,
    enableCpuMemArena: false,
  });
  sessionEp = ep;
  post({ type: 'session-ready', ep, createMs: performance.now() - t0 });
  return session;
}

async function run(msg: Extract<ToWorker, { type: 'run' }>): Promise<void> {
  abortReason = null;
  const io = requireIO(PRIMARY_SEPARATION_MODEL);
  const sess = await getSession(msg.ep);
  const shape = [1, io.channels, io.segmentFrames];
  const runner: SegmentRunner = {
    io,
    async run(input) {
      const out = await sess.run({ [io.inputName]: new ort.Tensor('float32', input, shape) });
      const t = out[io.outputName];
      if (!t) throw new Error(`Model returned no "${io.outputName}" output`);
      const data = (await t.getData()) as Float32Array;
      const copy = new Float32Array(data);
      t.dispose();
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
