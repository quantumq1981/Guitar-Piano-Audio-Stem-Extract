import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const validate = process.env.ORT_VALIDATE === '1';
const provider = process.env.ORT_PROVIDER || 'webgpu';
const pinned = process.env.ORT_PINNED === '1';
const workspaceRuntime = 'apps/web/node_modules/onnxruntime-web';
const runtime = resolve(pinned ? 'ort-compat/node_modules/onnxruntime-web' :
  existsSync(workspaceRuntime) ? workspaceRuntime : 'node_modules/onnxruntime-web');
const { version } = JSON.parse(readFileSync(resolve(runtime, 'package.json'), 'utf8'));
// ORT_MODEL selects the graph (default candidate.onnx). ORT_MODEL_DATA names its external-data file, which
// must sit next to it under the name recorded in the graph.
const modelFile = basename(process.env.ORT_MODEL || 'candidate.onnx');
const dataFile = process.env.ORT_MODEL_DATA ? basename(process.env.ORT_MODEL_DATA) : '';
// ORT_FIXTURE selects the validation fixture prefix: <prefix>-input.bin (the mix), <prefix>-source.bin (native
// CPU output of the source model) and <prefix>-candidate.bin (native CPU output of the model under test).
const fixture = basename(process.env.ORT_FIXTURE || 'reference');
const runCount = Math.max(1, Number(process.env.ORT_RUNS || (validate ? 3 : 1)));
// ORT_THREADS > 1 runs the WASM provider multi-threaded. That needs SharedArrayBuffer, so the server then sends
// the cross-origin isolation headers (Pages gets them from public/sw.js).
const wasmThreads = Math.max(1, Math.floor(Number(process.env.ORT_THREADS || 1)));
const fixtureFiles = new Set([
  '/' + modelFile, ...(dataFile ? ['/' + dataFile] : []),
  ...['input', 'source', 'candidate'].map(kind => `/${fixture}-${kind}.bin`),
]);

const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (wasmThreads > 1) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  if (name === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body>Mobile inference benchmark</body></html>');
    return;
  }
  if (!fixtureFiles.has(name) && !/^\/ort[\w.-]+\.(mjs|wasm)$/.test(name)) {
    res.writeHead(404).end();
    return;
  }
  const file = fixtureFiles.has(name) ? resolve(name.slice(1)) : resolve(runtime, 'dist', name.slice(1));
  try {
    res.setHeader('Content-Length', statSync(file).size);
    res.setHeader('Content-Type', name.endsWith('.mjs') ? 'text/javascript' :
      name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
    createReadStream(file).on('error', error => res.destroy(error)).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const memory = {};
let phase;

function sampleMemory() {
  const measurement = memory[phase];
  if (!measurement || process.platform !== 'linux') return;
  const childrenByParent = new Map();
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
      const parent = stat.slice(stat.lastIndexOf(')') + 2).split(' ', 2)[1];
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent).push(pid);
    } catch {
      // Processes can exit between directory enumeration and reading stat.
    }
  }
  const descendants = [...(childrenByParent.get(String(process.pid)) ?? [])];
  let observedKiB = 0;
  let measuredProcesses = 0;
  for (const pid of descendants) {
    descendants.push(...(childrenByParent.get(pid) ?? []));
    try {
      const pss = readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8').match(/^Pss:\s+(\d+) kB/m);
      if (pss) {
        observedKiB += Number(pss[1]);
        measuredProcesses++;
      }
    } catch {
      // Coverage counts include children that exited or could not be read.
    }
  }
  measurement.samples++;
  if (measuredProcesses) {
    measurement.peakKiB = Math.max(measurement.peakKiB ?? 0, observedKiB);
  }
  measurement.processReads += measuredProcesses;
  measurement.processesSeen += descendants.length;
}

// The page reports its WebAssembly heap size (bytes of every WebAssembly.Memory it created) when it enters a
// phase. A WASM heap never shrinks, so the size reported on entering the next phase is the previous phase's
// maximum. Unlike sampled PSS this is exact and independent of the browser's process model.
function setPhase(next, wasmHeapBytes) {
  sampleMemory();
  if (phase && memory[phase] && Number.isFinite(wasmHeapBytes)) memory[phase].wasmHeapMiB = +(wasmHeapBytes / 2 ** 20).toFixed(1);
  phase = next;
  memory[phase] = { peakKiB: null, samples: 0, processReads: 0, processesSeen: 0 };
  sampleMemory();
}

let browser;
let timer;
console.log(JSON.stringify({ event: 'runtime', provider, pinned, version, wasmThreads, model: modelFile, externalData: dataFile || null, fixture: validate ? fixture : null, runs: runCount }));
try {
  browser = await chromium.launch({
    args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const created = [];
    const NativeMemory = WebAssembly.Memory;
    WebAssembly.Memory = function Memory(descriptor) {
      const memory = new NativeMemory(descriptor);
      created.push(memory);
      return memory;
    };
    WebAssembly.Memory.prototype = NativeMemory.prototype;
    window.wasmHeapBytes = () => created.reduce((sum, memory) => sum + memory.buffer.byteLength, 0);
  });
  page.on('console', message => console.log(message.text()));
  await page.exposeFunction('markBenchmarkPhase', setPhase);
  await page.goto('http://127.0.0.1:' + server.address().port);
  setPhase('baseline');
  timer = setInterval(sampleMemory, 250);

  const result = await page.evaluate(async ({ provider, validate, modelFile, dataFile, fixture, runCount, wasmThreads }) => {
    const mark = name => window.markBenchmarkPhase(name, window.wasmHeapBytes());
    if (provider === 'webgpu' && (!navigator.gpu || !await navigator.gpu.requestAdapter())) {
      throw Error('No WebGPU adapter in CI');
    }
    const ort = await import(provider === 'wasm' ? '/ort.wasm.min.mjs' : '/ort.webgpu.bundle.min.mjs');
    if (wasmThreads > 1 && !crossOriginIsolated) throw Error('ORT_THREADS > 1 needs a cross-origin isolated page');
    ort.env.wasm.numThreads = wasmThreads;
    await mark('session-create');
    const start = performance.now();
    const session = await ort.InferenceSession.create('/' + modelFile, {
      ...(dataFile ? { externalData: [{ path: dataFile, data: '/' + dataFile }] } : {}),
      executionProviders: [provider],
      graphOptimizationLevel: 'disabled',
      enableMemPattern: false,
      enableCpuMemArena: false,
    });
    const initSeconds = (performance.now() - start) / 1000;
    console.log(JSON.stringify({ event: 'initialized', initSeconds }));
    const frames = 343980;
    const samplesPerStem = 2 * frames;
    const names = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
    const minSnrDb = 40;
    const nearSilentRms = 1e-5;

    function metrics(reference, actual, offset, length) {
      let signal = 0;
      let error = 0;
      let maxAbs = 0;
      for (let i = offset; i < offset + length; i++) {
        const difference = actual[i] - reference[i];
        signal += reference[i] * reference[i];
        error += difference * difference;
        maxAbs = Math.max(maxAbs, Math.abs(difference));
      }
      const referenceRms = Math.sqrt(signal / length);
      const snr = error === 0 ? Infinity : 10 * Math.log10(signal / error);
      return {
        referenceRms,
        errorRms: Math.sqrt(error / length),
        maxAbs,
        snrDb: Number.isFinite(snr) ? snr : String(snr),
        nearSilent: referenceRms < nearSilentRms,
        pass: snr >= minSnrDb,
      };
    }

    function compare(reference, actual) {
      const stems = names.map((name, index) => ({
        name, ...metrics(reference, actual, index * samplesPerStem, samplesPerStem),
      }));
      return {
        global: metrics(reference, actual, 0, reference.length),
        stems,
        pass: stems.every(stem => stem.pass),
      };
    }

    try {
      await mark('fixture');
      const loadFixture = async name => {
        const response = await fetch(name);
        if (!response.ok) throw Error('Reference HTTP ' + response.status + ' for ' + name);
        return new Float32Array(await response.arrayBuffer());
      };
      const [mix, nativeSource, nativeCandidate] = validate ? await Promise.all([
        loadFixture(`/${fixture}-input.bin`),
        loadFixture(`/${fixture}-source.bin`),
        loadFixture(`/${fixture}-candidate.bin`),
      ]) : [Float32Array.from({ length: samplesPerStem }, (_, i) =>
        0.05 * Math.sin(2 * Math.PI * (i < frames ? 440 : 660) * i / 44100))];
      if (mix.length !== samplesPerStem || !mix.every(Number.isFinite) ||
          (validate && [nativeSource, nativeCandidate].some(ref =>
        ref.length !== names.length * samplesPerStem || !ref.every(Number.isFinite)))) {
        throw Error('Invalid reference shape or values');
      }

      const runs = [];
      let firstOutput;
      for (let run = 1; run <= runCount; run++) {
        await mark('inference-' + run);
        const input = new ort.Tensor('float32', mix, [1, 2, frames]);
        let output;
        const inferenceStart = performance.now();
        try {
          output = await session.run({ mix: input });
          const stems = output.stems;
          const actual = await stems.getData();
          const seconds = (performance.now() - inferenceStart) / 1000;
          if (stems.dims.join(',') !== '1,6,2,343980' || actual.length !== names.length * samplesPerStem ||
              !actual.every(Number.isFinite)) {
            throw Error('Invalid output shape or values in inference ' + run);
          }
          runs.push({ run, seconds });
          if (validate) {
            await mark('compare-' + run);
            const comparisons = {
              nativeSourceToBrowserCandidate: compare(nativeSource, actual),
              nativeCandidateToBrowserCandidate: compare(nativeCandidate, actual),
            };
            if (firstOutput) comparisons.repeatVsFirstRun = compare(firstOutput, actual);
            else firstOutput = actual.slice();
            runs.at(-1).pass = Object.values(comparisons).every(comparison => comparison.pass);
            console.log(JSON.stringify({ event: 'parity', minSnrDb, nearSilentRms, ...runs.at(-1), comparisons }));
          }
        } finally {
          input.dispose();
          if (output) Object.values(output).forEach(tensor => tensor.dispose());
        }
      }
      // A validation that ran fewer inferences than requested must not pass.
      return { pass: runs.length === runCount && (!validate || runs.every(run => run.pass)), initSeconds, runs };
    } finally {
      await mark('session-cleanup');
      await session.release();
    }
  }, { provider, validate, modelFile, dataFile, fixture, runCount, wasmThreads });
  console.log(JSON.stringify({ event: 'result', provider, pinned, version, model: modelFile, ...result }));
  if (!result.pass) process.exitCode = 1;
} finally {
  try {
    if (browser) {
      setPhase('browser-cleanup', await browser.contexts()[0]?.pages()[0]?.evaluate(() => window.wasmHeapBytes()).catch(() => NaN));
      await browser.close();
    }
  } finally {
    clearInterval(timer);
    sampleMemory();
    console.log(JSON.stringify({ event: 'memory', metric: 'sampled Chromium process-tree PSS', sampleIntervalMs: 250, phases: memory }));
    server.close();
  }
}
