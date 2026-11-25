/**
 * Per-stem parity between two ONNX artifacts on real audio segments — the gate for promoting a new artifact (it must
 * replace the old one on every tier at once). The verdict is core `stemParity`: SNR >= 40 dB, or the error at least
 * 90 dB below the mix (quiet stems). Exits non-zero when any stem fails in any window, or the output is not finite.
 * Usage: node compare-models.ts <reference.onnx> <candidate.onnx> <audio> [segments=3] [--candidate-graph-opt disabled]
 *
 * `--candidate-graph-opt disabled` opens the candidate as the browser runs it. Required for the Stage IV mobile
 * graph: optimisation constant-folds its opaque Reshape targets, which makes shapes static again (CLAUDE.md).
 * A candidate with external data (`<name>.onnx.data`) must sit next to its graph; ORT loads it by name.
 */
import * as ort from 'onnxruntime-node';
import { PARITY_MAX_ERROR_DB_RE_MIX, PARITY_MIN_SNR_DB, PRIMARY_SEPARATION_MODEL, stemEnergies, stemParity, type ParityVerdict } from '@stemsplit/core';
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
/** Per stem: every window's verdict under the core parity contract (stemParity), and the lowest-SNR window. */
interface StemReport {
  worst: ParityVerdict | null;
  levelDb: number;
  failures: string[];
}
const reports = new Map<string, StemReport>(io.stems.map((stem) => [stem, { worst: null, levelDb: Number.NaN, failures: [] }]));
const rank = (v: ParityVerdict) => (Number.isNaN(v.snrDb) ? -Infinity : v.snrDb); // invalid output ranks lowest
for (let s = 0; s < Number(segs); s++) {
  const start = Math.floor(((s + 1) / (Number(segs) + 1)) * (l.length - n));
  const x = new Float32Array(2 * n);
  x.set(l.subarray(start, start + n), 0);
  x.set(r.subarray(start, start + n), n);
  const feed = { mix: new ort.Tensor('float32', x, [1, 2, n]) };
  const a = (await ref.run(feed)).stems!.data as Float32Array;
  const b = (await cand.run(feed)).stems!.data as Float32Array;
  io.stems.forEach((stem, i) => {
    const e = stemEnergies(a.subarray(i * 2 * n, (i + 1) * 2 * n), b.subarray(i * 2 * n, (i + 1) * 2 * n), x);
    const v = stemParity(e);
    const report = reports.get(stem)!;
    if (!v.pass) report.failures.push(`window ${s + 1}: ${v.reason}`);
    if (report.worst === null || rank(v) < rank(report.worst)) {
      report.worst = v;
      report.levelDb = 10 * Math.log10(e.reference / e.mix);
    }
  });
}
let failed = false;
for (const [stem, { worst, levelDb, failures }] of reports) {
  const v = worst!;
  const verdict = failures.length > 0 ? 'FAIL' : `pass${v.pass && v.by !== 'snr' ? ` (${v.by})` : ''}`;
  console.log(`${stem.padEnd(8)} ${verdict.padEnd(18)} worst-segment SNR ${v.snrDb.toFixed(1)} dB (reference stem ${levelDb.toFixed(1)} dB re mix, ` +
    `error ${v.errorDbReMix.toFixed(1)} dB re mix)`);
  for (const f of failures) console.log(`         ${f}`);
  failed ||= failures.length > 0;
}
console.log(failed ? 'FAIL: parity contract not met' : `PASS: every stem in every window (SNR >= ${PARITY_MIN_SNR_DB} dB or error <= ${PARITY_MAX_ERROR_DB_RE_MIX} dB re mix)`);
if (failed) process.exitCode = 1;
