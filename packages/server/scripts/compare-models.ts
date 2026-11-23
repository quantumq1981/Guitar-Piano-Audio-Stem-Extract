/**
 * Per-stem SNR between two ONNX artifacts on real audio segments — the gate for
 * promoting a new artifact (it must replace the old one on every tier at once).
 * Usage: node compare-models.ts <reference.onnx> <candidate.onnx> <audio> [segments=3]
 */
import * as ort from 'onnxruntime-node';
import { PRIMARY_SEPARATION_MODEL, snrDb } from '@stemsplit/core';
import { decodeToModelPcm } from '../src/ffmpeg.ts';

const [refPath, candPath, audio, segs = '3'] = process.argv.slice(2);
if (!refPath || !candPath || !audio) throw new Error('usage: compare-models.ts <ref.onnx> <cand.onnx> <audio> [segments]');
const io = PRIMARY_SEPARATION_MODEL.io!;
const n = io.segmentFrames;
const opts = { executionProviders: ['cpu'], enableCpuMemArena: false, enableMemPattern: false, intraOpNumThreads: 4 } as const;
const [ref, cand] = await Promise.all([ort.InferenceSession.create(refPath, opts), ort.InferenceSession.create(candPath, opts)]);
const [l, r] = await decodeToModelPcm(audio);
const worst = new Map<string, number>();
for (let s = 0; s < Number(segs); s++) {
  const start = Math.floor(((s + 1) / (Number(segs) + 1)) * (l.length - n));
  const x = new Float32Array(2 * n);
  x.set(l.subarray(start, start + n), 0);
  x.set(r.subarray(start, start + n), n);
  const feed = { mix: new ort.Tensor('float32', x, [1, 2, n]) };
  const a = (await ref.run(feed)).stems!.data as Float32Array;
  const b = (await cand.run(feed)).stems!.data as Float32Array;
  io.stems.forEach((stem, i) => {
    const v = snrDb(a.subarray(i * 2 * n, (i + 1) * 2 * n), b.subarray(i * 2 * n, (i + 1) * 2 * n));
    worst.set(stem, Math.min(worst.get(stem) ?? Infinity, v));
  });
}
for (const [stem, v] of worst) console.log(`${stem.padEnd(8)} worst-segment SNR ${v.toFixed(1)} dB`);
