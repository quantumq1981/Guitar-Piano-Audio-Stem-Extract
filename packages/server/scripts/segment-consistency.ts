/** Isolates model behaviour from overlap-add: Σ stems vs. input for single raw segments. */
import { PRIMARY_SEPARATION_MODEL, snrDb } from '@stemsplit/core';
import { decodeToModelPcm } from '../src/ffmpeg.ts';
import { modelPath } from '../src/models.ts';
import { createOrtRunner } from '../src/ort-runner.ts';

const [input] = process.argv.slice(2);
if (!input) throw new Error('usage: segment-consistency.ts <audio>');
const io = PRIMARY_SEPARATION_MODEL.io!;
const n = io.segmentFrames;
const [l, r] = await decodeToModelPcm(input);
const runner = await createOrtRunner(PRIMARY_SEPARATION_MODEL, modelPath(PRIMARY_SEPARATION_MODEL), { skipHashCheck: true, intraOpThreads: 4 });
for (const startSec of [30, 60, 90]) {
  const s = startSec * io.sampleRate;
  const x = new Float32Array(2 * n);
  x.set(l.subarray(s, s + n), 0);
  x.set(r.subarray(s, s + n), n);
  const y = await runner.run(x);
  const sum = new Float32Array(n);
  for (let stem = 0; stem < io.stems.length; stem++) for (let k = 0; k < n; k++) sum[k]! += y[stem * 2 * n + k]!;
  // Exclude 1 s at each edge to separate edge effects from steady-state behaviour.
  const inner = (a: Float32Array) => a.subarray(io.sampleRate, n - io.sampleRate);
  console.log(`segment @${startSec}s: SNR(Σ,mix) full=${snrDb(x.subarray(0, n), sum).toFixed(1)} dB, inner=${snrDb(inner(x.subarray(0, n)), inner(sum)).toFixed(1)} dB`);
}
await runner.release();
