import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const validate = process.env.ORT_VALIDATE === '1';
const provider = process.env.ORT_PROVIDER || 'webgpu';
const pinned = process.env.ORT_PINNED === '1';
const workspaceRuntime = 'apps/web/node_modules/onnxruntime-web';
const runtime = resolve(pinned ? 'ort-compat/node_modules/onnxruntime-web' :
  existsSync(workspaceRuntime) ? workspaceRuntime : 'node_modules/onnxruntime-web');
const { version } = JSON.parse(readFileSync(resolve(runtime, 'package.json'), 'utf8'));
const fixtureFiles = new Set([
  '/candidate.onnx', '/reference-input.bin', '/reference-source.bin', '/reference-candidate.bin',
]);

const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
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

function setPhase(next) {
  sampleMemory();
  phase = next;
  memory[phase] = { peakKiB: null, samples: 0, processReads: 0, processesSeen: 0 };
  sampleMemory();
}

let browser;
let timer;
console.log(JSON.stringify({ event: 'runtime', provider, pinned, version, wasmThreads: 1 }));
try {
  browser = await chromium.launch({
    args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  page.on('console', message => console.log(message.text()));
  await page.exposeFunction('markBenchmarkPhase', setPhase);
  await page.goto('http://127.0.0.1:' + server.address().port);
  setPhase('baseline');
  timer = setInterval(sampleMemory, 250);

  const result = await page.evaluate(async ({ provider, validate }) => {
    if (provider === 'webgpu' && (!navigator.gpu || !await navigator.gpu.requestAdapter())) {
      throw Error('No WebGPU adapter in CI');
    }
    const ort = await import(provider === 'wasm' ? '/ort.wasm.min.mjs' : '/ort.webgpu.bundle.min.mjs');
    ort.env.wasm.numThreads = 1;
    await window.markBenchmarkPhase('session-create');
    const start = performance.now();
    const session = await ort.InferenceSession.create('/candidate.onnx', {
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
      await window.markBenchmarkPhase('fixture');
      const loadFixture = async name => {
        const response = await fetch(name);
        if (!response.ok) throw Error('Reference HTTP ' + response.status + ' for ' + name);
        return new Float32Array(await response.arrayBuffer());
      };
      const [mix, nativeSource, nativeCandidate] = validate ? await Promise.all([
        loadFixture('/reference-input.bin'),
        loadFixture('/reference-source.bin'),
        loadFixture('/reference-candidate.bin'),
      ]) : [Float32Array.from({ length: samplesPerStem }, (_, i) =>
        0.05 * Math.sin(2 * Math.PI * (i < frames ? 440 : 660) * i / 44100))];
      if (mix.length !== samplesPerStem || !mix.every(Number.isFinite) ||
          (validate && [nativeSource, nativeCandidate].some(ref =>
        ref.length !== names.length * samplesPerStem || !ref.every(Number.isFinite)))) {
        throw Error('Invalid reference shape or values');
      }

      const runs = [];
      let firstOutput;
      for (let run = 1; run <= (validate ? 3 : 1); run++) {
        await window.markBenchmarkPhase('inference-' + run);
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
            await window.markBenchmarkPhase('compare-' + run);
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
      return { pass: !validate || runs.every(run => run.pass), initSeconds, runs };
    } finally {
      await window.markBenchmarkPhase('session-cleanup');
      await session.release();
    }
  }, { provider, validate });
  console.log(JSON.stringify({ event: 'result', provider, pinned, version, ...result }));
  if (!result.pass) process.exitCode = 1;
} finally {
  try {
    if (browser) {
      setPhase('browser-cleanup');
      await browser.close();
    }
  } finally {
    clearInterval(timer);
    sampleMemory();
    console.log(JSON.stringify({ event: 'memory', metric: 'sampled Chromium process-tree PSS', sampleIntervalMs: 250, phases: memory }));
    server.close();
  }
}
