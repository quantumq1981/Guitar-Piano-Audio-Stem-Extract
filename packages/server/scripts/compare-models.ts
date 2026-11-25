/**
 * Per-stem SNR between two ONNX artifacts on real audio segments — the gate for
 * promoting a new artifact (it must replace the old one on every tier at once).
 * Usage: node compare-models.ts <reference.onnx> <candidate.onnx> <audio> [segments=3] [--candidate-graph-opt disabled]
 *
 * `--candidate-graph-opt disabled` opens the candidate as the browser runs it. Required for the Stage IV mobile
 * graph: optimisation constant-folds its opaque Reshape targets, which makes shapes static again (CLAUDE.md).
 * A candidate with external data (`<name>.onnx.data`) must sit next to its graph; ORT loads it by name.
 */
import * as ort from 'onnxruntime-node';
import { PRIMARY_SEPARATION_MODEL, snrDb } from '@stemsplit/core';
import { decodeToModelPcm } from '../src/ffmpeg.ts';

const args = process.argv.slice(2);
const flag = args.indexOf('--candidate-graph-opt');
const candidateGraphOpt = flag >= 0 ? args.splice(flag, 2)[1] : undefined;
if (candidateGraphOpt !== undefined && candidateGraphOpt !== 'disabled' && candidateGraphOpt !== 'all') {
  throw new Error(`--candidate-graph-opt must be "disabled" or "all", got ${candidateGraphOpt}`);
}
const [refPath, candPath, audio, segs = '3'] = args;
if (!refPath || !candPath || !audio) throw new Error('usage: compare-models.ts <ref.onnx> <cand.onnx> <audio> [segments]');
const io = PRIMARY_SEPARATION_MODEL.io!;
const n = io.segmentFrames;
const opts = { executionProviders: ['cpu'], enableCpuMemArena: false, enableMemPattern: false, intraOpNumThreads: 4 } as const;
const candOpts = candidateGraphOpt ? { ...opts, graphOptimizationLevel: candidateGraphOpt } : opts;
const [ref, cand] = await Promise.all([ort.InferenceSession.create(refPath, opts), ort.InferenceSession.create(candPath, candOpts)]);
const [l, r] = await decodeToModelPcm(audio);
/** Worst segment per stem, with that segment's reference stem level relative to the mix (a quiet stem scores
 * lower SNR for the same absolute error, so the level says whether a low figure is a quiet-stem artefact). */
const worst = new Map<string, { snr: number; levelDb: number }>();
const energy = (v: Float32Array) => v.reduce((sum, x) => sum + x * x, 0);
for (let s = 0; s < Number(segs); s++) {
  const start = Math.floor(((s + 1) / (Number(segs) + 1)) * (l.length - n));
  const x = new Float32Array(2 * n);
  x.set(l.subarray(start, start + n), 0);
  x.set(r.subarray(start, start + n), n);
  const feed = { mix: new ort.Tensor('float32', x, [1, 2, n]) };
  const a = (await ref.run(feed)).stems!.data as Float32Array;
  const b = (await cand.run(feed)).stems!.data as Float32Array;
  const mixEnergy = energy(x);
  io.stems.forEach((stem, i) => {
    const refStem = a.subarray(i * 2 * n, (i + 1) * 2 * n);
    const v = snrDb(refStem, b.subarray(i * 2 * n, (i + 1) * 2 * n));
    const prev = worst.get(stem);
    // NaN (non-finite model output) is the worst possible result: it is kept, and never replaced by a finite window.
    if (prev === undefined || (!Number.isNaN(prev.snr) && (Number.isNaN(v) || v < prev.snr))) {
      worst.set(stem, { snr: v, levelDb: 10 * Math.log10(energy(refStem) / mixEnergy) });
    }
  });
}
for (const [stem, w] of worst) {
  // Error level re mix = stem level − SNR: the absolute size of the difference, independent of how quiet the stem is.
  console.log(`${stem.padEnd(8)} worst-segment SNR ${w.snr.toFixed(1)} dB (reference stem ${w.levelDb.toFixed(1)} dB re mix, ` +
    `error ${(w.levelDb - w.snr).toFixed(1)} dB re mix)`);
}
const invalid = [...worst].filter(([, w]) => Number.isNaN(w.snr)).map(([stem]) => stem);
if (invalid.length > 0) {
  console.error(`INVALID: non-finite candidate output on ${invalid.join(', ')}`);
  process.exitCode = 1;
}
