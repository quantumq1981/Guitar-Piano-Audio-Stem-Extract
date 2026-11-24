/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';
import { HTDEMUCS_6S_FOLDED_FP16W, requireIO } from '@stemsplit/core';
declare const self: DedicatedWorkerGlobalScope;
ort.env.wasm.numThreads = 1;
const report = (message: string) => self.postMessage({message});
async function run(infer: boolean) {
  const model = HTDEMUCS_6S_FOLDED_FP16W;
  const io = requireIO(model);
  let session: ort.InferenceSession | undefined;
  let input: ort.Tensor | undefined;
  let outputs: ort.InferenceSession.ReturnType | undefined;
  try {
    report('Downloading verified model (143 MB)…');
    const response = await fetch(import.meta.env.BASE_URL + 'models/mobile.onnx');
    if (!response.ok) throw new Error('Model HTTP ' + response.status);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== model.bytes) throw new Error('Incorrect model size');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== model.sha256) throw new Error('Model checksum mismatch');
    report('Integrity PASS; initializing WebGPU session…');
    const start = performance.now();
    session = await ort.InferenceSession.create(new Uint8Array(bytes), {executionProviders: ['webgpu'], graphOptimizationLevel: 'all', enableMemPattern: false, enableCpuMemArena: false});
    report('Session initialized: ' + ((performance.now()-start)/1000).toFixed(2) + ' s');
    if (infer) {
      report('Running one synthetic 7.8-second stereo window…');
      const samples = new Float32Array(io.channels * io.segmentFrames);
      for (let i=0; i<samples.length; i++) samples[i] = 0.05 * Math.sin(i * 2 * Math.PI * 440 / io.sampleRate);
      input = new ort.Tensor('float32', samples, [1, io.channels, io.segmentFrames]);
      const t = performance.now();
      outputs = await session.run({[io.inputName]: input});
      const result = outputs[io.outputName];
      if (!result) throw new Error('Missing stems output');
      const data = await result.getData();
      if (!(data instanceof Float32Array) || data.length !== io.stems.length * io.channels * io.segmentFrames || !data.every(Number.isFinite)) throw new Error('Invalid output');
      report('Inference PASS: ' + ((performance.now()-t)/1000).toFixed(2) + ' s; six finite stems');
    }
  } finally {
    input?.dispose();
    if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
    await session?.release();
  }
}
if (!self.name.startsWith('em-pthread')) self.onmessage = (e: MessageEvent<boolean>) => {
  run(e.data).then(() => self.postMessage({done:true,message:'Benchmark complete'})).catch(error => self.postMessage({done:true,message:'FAIL: '+String(error)}));
};
