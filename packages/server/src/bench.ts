/**
 * Memory + real-time-factor benchmark for the primary model on this host.
 * Peak RSS is read from /proc/self/status (VmHWM), which captures native ORT
 * arena allocations that process.memoryUsage() sampling can miss.
 */
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { PRIMARY_SEPARATION_MODEL, formatBytes, memorySource, separate } from '@stemsplit/core';
import { decodeToModelPcm } from './ffmpeg.ts';
import { ensureModel } from './models.ts';
import { createOrtRunner } from './ort-runner.ts';

async function vmHwmBytes(): Promise<number | null> {
  try {
    const status = await readFile('/proc/self/status', 'utf8');
    const m = /VmHWM:\s+(\d+)\s+kB/.exec(status);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

export interface BenchResult {
  readonly host: string;
  readonly threads: number;
  readonly audioSec: number;
  readonly computeSec: number;
  readonly rtf: number;
  readonly rssBeforeSession: number | null;
  readonly rssAfterSession: number | null;
  readonly peakRss: number | null;
  readonly sessionCreateSec: number;
}

export async function bench(inputPath: string, seconds: number, threads: number): Promise<BenchResult> {
  const model = PRIMARY_SEPARATION_MODEL;
  const path = await ensureModel(model);
  const [l, r] = await decodeToModelPcm(inputPath);
  const frames = Math.min(l.length, Math.round(seconds * model.io!.sampleRate));
  const rssBeforeSession = await vmHwmBytes();
  const t0 = performance.now();
  const runner = await createOrtRunner(model, path, { intraOpThreads: threads, skipHashCheck: true });
  const sessionCreateSec = (performance.now() - t0) / 1000;
  const rssAfterSession = await vmHwmBytes();
  const t1 = performance.now();
  await separate(memorySource([l.subarray(0, frames), r.subarray(0, frames)], model.io!.sampleRate), runner, { write: () => {} });
  const computeSec = (performance.now() - t1) / 1000;
  const peakRss = await vmHwmBytes();
  await runner.release();
  const audioSec = frames / model.io!.sampleRate;
  return {
    host: `${process.platform}-${process.arch}, ${availableParallelism()} vCPU`,
    threads,
    audioSec,
    computeSec,
    rtf: computeSec / audioSec,
    rssBeforeSession,
    rssAfterSession,
    peakRss,
    sessionCreateSec,
  };
}

export function formatBench(b: BenchResult): string {
  const f = (v: number | null) => (v === null ? 'n/a' : formatBytes(v));
  return [
    `host               ${b.host} (intra-op threads: ${b.threads || 'auto'})`,
    `audio              ${b.audioSec.toFixed(1)} s`,
    `session create     ${b.sessionCreateSec.toFixed(2)} s`,
    `compute            ${b.computeSec.toFixed(1)} s  (RTF ${b.rtf.toFixed(2)})`,
    `peak RSS pre-load  ${f(b.rssBeforeSession)}`,
    `peak RSS post-load ${f(b.rssAfterSession)}`,
    `peak RSS overall   ${f(b.peakRss)}`,
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, secs = '31.2', threads = '4'] = process.argv.slice(2);
  if (!input) throw new Error('usage: bench.ts <audio> [seconds] [threads]');
  console.log(formatBench(await bench(input, Number(secs), Number(threads))));
}
