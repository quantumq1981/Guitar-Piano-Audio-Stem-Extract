/// <reference lib="webworker" />
/**
 * The main app's disk path (phones and tablets): separates a song with the primary artifact, streaming the song and
 * the scope's stems through OPFS (inference/disk-run.ts), so memory stays flat and a stopped run resumes.
 *
 * Session settings come from the registry (graph optimisation for the browser tier, external data, the validated
 * WASM memory cap); the model comes from the verified persistent cache (platform/model-cache.ts). Plain WASM build.
 */
import type { SegmentRunner } from '@stemsplit/core';
import { PRIMARY_SEPARATION_MODEL, graphOptimizationFor, requireIO, resumeExpectationFor } from '@stemsplit/core';
import { loadModel } from '../platform/model-cache.ts';
import { resumeDiskRun, startDiskRun, type DiskRunHooks, type DiskRunSpec } from './disk-run.ts';
import { DEVICE_RUN_DIRECTORY, DEVICE_RUN_SAMPLE_FORMAT, type FromDeviceRun, type ToDeviceRun } from './device-run-protocol.ts';
import { installWasmMemoryCap } from './wasm-memory.ts';

declare const self: DedicatedWorkerGlobalScope;

const MODEL = PRIMARY_SEPARATION_MODEL;
const IO = requireIO(MODEL);
if (MODEL.browserWasmMemoryCapPages) installWasmMemoryCap(MODEL.browserWasmMemoryCapPages);

const post = (msg: FromDeviceRun) => self.postMessage(msg);

async function openRunner(threads: number): ReturnType<DiskRunSpec['openRunner']> {
  let files: Awaited<ReturnType<typeof loadModel>> | null = await loadModel(MODEL, (loaded, total) => post({ type: 'model-progress', loaded, total }));
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(threads, navigator.hardwareConcurrency || 1)) : 1;
  const session = await ort.InferenceSession.create(files.graph, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: graphOptimizationFor(MODEL, 'browser'),
    enableMemPattern: false,
    enableCpuMemArena: false,
    ...(files.data && MODEL.externalData ? { externalData: [{ path: MODEL.externalData.file, data: files.data }] } : {}),
  });
  files = null; // the session holds its own copy
  post({ type: 'log', message: `Session ready (ORT ${ort.env.versions.web ?? '?'}, WASM, ${ort.env.wasm.numThreads} thread(s))` });
  const shape = [1, IO.channels, IO.segmentFrames];
  const runner: SegmentRunner = {
    io: IO,
    async run(input) {
      const tensor = new ort.Tensor('float32', input, shape);
      const outputs = await session.run({ [IO.inputName]: tensor });
      tensor.dispose();
      const stems = outputs[IO.outputName];
      const data = stems ? ((await stems.getData()) as Float32Array) : null;
      const copy = data ? new Float32Array(data) : null;
      for (const t of Object.values(outputs)) t.dispose();
      if (!copy || copy.length !== IO.stems.length * IO.channels * IO.segmentFrames || !copy.every(Number.isFinite)) {
        throw new Error('missing, misshapen or non-finite model output');
      }
      return copy;
    },
  };
  return { runner, release: () => session.release() };
}

const spec = (outputs: ToDeviceRun['outputs']): DiskRunSpec => ({
  directory: DEVICE_RUN_DIRECTORY,
  expectation: resumeExpectationFor(MODEL, outputs),
  modelStems: IO.stems,
  sampleFormat: DEVICE_RUN_SAMPLE_FORMAT,
  openRunner,
});

const hooks: DiskRunHooks = {
  log: (message) => post({ type: 'log', message }),
  progress: (progress) => post({ type: 'progress', progress }),
};

// ORT's pthreads re-execute a bundled module; they must leave messaging to ORT (CLAUDE.md, em-pthread guard).
if (!self.name.startsWith('em-pthread')) {
  self.onmessage = (e: MessageEvent<ToDeviceRun>) => {
    const msg = e.data;
    const job = msg.type === 'start'
      ? startDiskRun(spec(msg.outputs), hooks, { left: msg.left, right: msg.right }, msg.threads, msg.source)
      : resumeDiskRun(spec(msg.outputs), hooks, msg.threads);
    job.then(
      (result) => post({ type: 'done', clipped: result.clipped }),
      (error: unknown) => post({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
    );
  };
}
