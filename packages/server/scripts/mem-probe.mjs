import * as ort from 'onnxruntime-node';
import { readFileSync } from 'node:fs';
const [arena, pattern, chunks, threads] = process.argv.slice(2);
const hwm = () => Number(/VmHWM:\s+(\d+)/.exec(readFileSync('/proc/self/status','utf8'))[1]) / 1024;
const s = await ort.InferenceSession.create('models/htdemucs_6s-folded.onnx', {
  executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: Number(threads),
  enableCpuMemArena: arena === '1', enableMemPattern: pattern === '1' });
const after = hwm();
const N = 343980; const x = new Float32Array(2*N); for (let i=0;i<x.length;i++) x[i]=Math.sin(i*0.01)*0.3;
const res = [];
for (let i = 0; i < Number(chunks); i++) { const t=performance.now(); await s.run({ mix: new ort.Tensor('float32', x, [1,2,N]) }); res.push(`${(performance.now()-t|0)}ms/${hwm()|0}MiB`); }
console.log(`arena=${arena} pattern=${pattern} threads=${threads} session=${after|0}MiB runs: ${res.join(' ')}`);
