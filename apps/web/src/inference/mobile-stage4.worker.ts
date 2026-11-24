/// <reference lib="webworker" />
/**
 * Opt-in device test of the Stage IV low-memory candidate (docs/MOBILE-INFERENCE-DEVELOPMENT.md): plain WASM
 * build, one thread, graph optimisation disabled, external weights, both files SHA-256 verified. It reports the
 * WebAssembly heap at every stage, so a tab the OS kills still leaves the last measured stage in the log.
 * It is not used for separation.
 */
import {
  capWasmMemoryDescriptor,
  maxAbsDifference,
  MOBILE_STAGE4_CANDIDATE,
  stage4TestSignal,
  touchedBytes,
  WASM_CAP_LADDER_PAGES,
  type PinnedFile,
} from '@stemsplit/core';

declare const self: DedicatedWorkerGlobalScope;

const report = (message: string) => self.postMessage({ message });
const mib = (bytes: number) => (bytes / 2 ** 20).toFixed(0) + ' MiB';

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

async function run(windows: number): Promise<void> {
  const c = MOBILE_STAGE4_CANDIDATE;
  report(`Environment: ${navigator.userAgent} · crossOriginIsolated ${String(self.crossOriginIsolated)} · ${navigator.hardwareConcurrency} cores`);
  report(`Downloading Stage IV model (${mib(c.graph.bytes + c.data.bytes)}, two files)…`);
  let graph: Uint8Array | null = await fetchVerified(c.graph);
  let data: Uint8Array | null = await fetchVerified(c.data);
  report('Integrity PASS (graph + weights); loading ONNX Runtime WASM…');
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.numThreads = c.session.numThreads;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'warning';
  report(`Creating session (ORT ${ort.env.versions.web ?? '?'}, WASM, 1 thread, graph optimisation disabled)…`);
  let session: Awaited<ReturnType<typeof ort.InferenceSession.create>> | undefined;
  try {
    let start = performance.now();
    session = await ort.InferenceSession.create(graph, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: c.session.graphOptimizationLevel,
      enableMemPattern: c.session.enableMemPattern,
      enableCpuMemArena: c.session.enableCpuMemArena,
      externalData: [{ path: c.data.file, data }],
    });
    graph = null;
    data = null;
    report(`Session ready in ${((performance.now() - start) / 1000).toFixed(1)} s · ${heap()} · ${capNote}`);
    const { segmentFrames, channels, inputName, outputName, stems } = c.io;
    const mix = stage4TestSignal(segmentFrames, channels);
    let first: Float32Array | null = null;
    for (let w = 1; w <= windows; w++) {
      report(`Running window ${w}/${windows} (7.8 s stereo)…`);
      const input = new ort.Tensor('float32', mix, [1, channels, segmentFrames]);
      start = performance.now();
      const outputs = await session.run({ [inputName]: input });
      const seconds = (performance.now() - start) / 1000;
      const tensor = outputs[outputName];
      const result = tensor ? ((await tensor.getData()) as Float32Array) : null;
      input.dispose();
      for (const t of Object.values(outputs)) t.dispose();
      if (!result || result.length !== stems.length * channels * segmentFrames || !result.every(Number.isFinite)) {
        throw new Error(`window ${w}: missing, misshapen or non-finite output`);
      }
      let repeat = '';
      if (first === null) first = result.slice();
      else repeat = ` · repeat vs window 1: max |Δ| ${maxAbsDifference(first, result)}`;
      report(`Window ${w} PASS in ${seconds.toFixed(1)} s (real-time factor ${(seconds / 7.8).toFixed(2)}) · ${heap()}${repeat}`);
    }
  } finally {
    await session?.release();
  }
  report(`Session released · ${heap()}`);
}

if (!self.name.startsWith('em-pthread')) {
  self.onmessage = (e: MessageEvent<{ windows: number }>) => {
    run(Math.max(1, Math.min(5, e.data.windows)))
      .then(() => self.postMessage({ done: true, message: 'Stage IV test complete' }))
      .catch((error: unknown) => self.postMessage({ done: true, message: `FAIL: ${String(error)} · ${heap()}` }));
  };
}
