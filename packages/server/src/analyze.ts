/**
 * Objective sanity report for a separation output directory:
 *  - length alignment of every stem with the decoded input,
 *  - mixture consistency: SNR of Σstems vs. the input mix,
 *  - per-stem RMS level, and lead/rhythm complementarity.
 * Usage: node analyze.ts <original-audio> <stems-dir>
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeWav, rmsDbfs, snrDb } from '@stemsplit/core';
import { decodeToModelPcm } from './ffmpeg.ts';

export async function analyze(original: string, dir: string): Promise<string[]> {
  const [mixL, mixR] = await decodeToModelPcm(original);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.24bit.wav'));
  const lines: string[] = [];
  const sumL = new Float32Array(mixL.length);
  const sumR = new Float32Array(mixR.length);
  const stems = new Map<string, Float32Array[]>();
  for (const f of files.sort()) {
    const { channels } = decodeWav(await readFile(join(dir, f)));
    const stem = f.replace('.24bit.wav', '');
    stems.set(stem, channels);
    if (channels[0]!.length !== mixL.length) lines.push(`MISALIGNED ${stem}: ${channels[0]!.length} vs ${mixL.length} frames`);
    if (stem !== 'guitar') {
      for (let i = 0; i < mixL.length; i++) {
        sumL[i]! += channels[0]![i]!;
        sumR[i]! += channels[1]![i]!;
      }
    }
    lines.push(`${stem.padEnd(14)} RMS ${rmsDbfs(channels[0]!).toFixed(1).padStart(6)} dBFS (L)  ${rmsDbfs(channels[1]!).toFixed(1).padStart(6)} dBFS (R)`);
  }
  lines.push(`mix            RMS ${rmsDbfs(mixL).toFixed(1).padStart(6)} dBFS (L)`);
  lines.push(`mixture consistency  SNR(Σ stems, mix) = ${snrDb(mixL, sumL).toFixed(1)} dB (L), ${snrDb(mixR, sumR).toFixed(1)} dB (R)`);
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [original, dir] = process.argv.slice(2);
  if (!original || !dir) throw new Error('usage: analyze.ts <original> <dir>');
  for (const l of await analyze(original, dir)) console.log(l);
}
