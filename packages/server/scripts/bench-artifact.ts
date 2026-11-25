/**
 * Server-side speed and memory of one ONNX file, outside the registry (for comparing candidate artifacts before
 * promotion). Runs the shared engine over `seconds` of a song in this process; read peak RSS from VmHWM.
 * Usage: node bench-artifact.ts <model.onnx> <audio> [seconds=31.2] [threads=4] [graph-opt=all|disabled]
 * A model with external data (`<name>.onnx.data`) must sit next to its graph.
 */
import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-node';
import { PRIMARY_SEPARATION_MODEL, memorySource, separate } from '@stemsplit/core';
import { decodeToModelPcm } from '../src/ffmpeg.ts';

const [path, audio, secs = '31.2', threads = '4', opt = 'all'] = process.argv.slice(2);
if (!path || !audio || (opt !== 'all' && opt !== 'disabled')) {
  throw new Error('usage: bench-artifact.ts <model.onnx> <audio> [seconds] [threads] [all|disabled]');
}
const io = PRIMARY_SEPARATION_MODEL.io!;
const hwm = async () => Number(/VmHWM:\s+(\d+)/.exec(await readFile('/proc/self/status', 'utf8'))![1]) / 1024;
const [l, r] = await decodeToModelPcm(audio);
const frames = Math.min(l.length, Math.round(Number(secs) * io.sampleRate));
const before = await hwm();
const t0 = performance.now();
const session = await ort.InferenceSession.create(path, {
  executionProviders: ['cpu'], graphOptimizationLevel: opt, intraOpNumThreads: Number(threads),
  enableCpuMemArena: false, enableMemPattern: false,
});
const createSec = (performance.now() - t0) / 1000;
const afterCreate = await hwm();
const shape = [1, io.channels, io.segmentFrames];
const runner = {
  io,
  async run(input: Float32Array) {
    const out = (await session.run({ [io.inputName]: new ort.Tensor('float32', input, shape) }))[io.outputName]!;
    return new Float32Array(out.data as Float32Array);
  },
};
const t1 = performance.now();
await separate(memorySource([l.subarray(0, frames), r.subarray(0, frames)], io.sampleRate), runner, { write: () => {} });
const computeSec = (performance.now() - t1) / 1000;
const audioSec = frames / io.sampleRate;
console.log(JSON.stringify({ model: path.split('/').at(-1), opt, threads: Number(threads), audioSec, createSec: +createSec.toFixed(2),
  computeSec: +computeSec.toFixed(1), rtf: +(computeSec / audioSec).toFixed(3),
  peakMiB: { beforeSession: Math.round(before), afterCreate: Math.round(afterCreate), overall: Math.round(await hwm()) } }));
await session.release();
