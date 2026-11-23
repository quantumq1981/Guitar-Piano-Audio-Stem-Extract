/**
 * Tier 1 pipeline: probe → decode → separate (streamed to float32 masters) →
 * lead/rhythm split → [piano refinement] → encode requested formats.
 *
 * Peak memory beyond the ORT session is O(segment) during separation, plus one
 * full-length guitar stem during the lead/rhythm split (≈ 127 MB for 6 min).
 */
import { open, mkdir, readFile, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobError, JobStage, JobWarning, OutputFormat, SegmentRunner, SeparationOptions, SeparationScope, StemName } from '@stemsplit/core';
import {
  GUITAR_LEAD_RHYTHM_ML,
  BANQUET_PIANO,
  MODEL_SAMPLE_RATE,
  SCOPE_OUTPUTS,
  SERVER_LIMITS,
  buildProjection,
  decodeWav,
  encodePcmBlock,
  encodeWavHeader,
  memorySource,
  projectBlock,
  separate,
  spatialLeadRhythmSplit,
  stemFileName,
} from '@stemsplit/core';
import { FfmpegError, decodeToModelPcm, probe, transcode } from './ffmpeg.ts';

export class PipelineError extends Error {
  readonly code: JobError['code'];
  readonly retryable: boolean;
  constructor(code: JobError['code'], message: string, retryable = false) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface PipelineRequest {
  readonly inputPath: string;
  readonly outDir: string;
  readonly scope: SeparationScope;
  readonly options: SeparationOptions;
  readonly runner: SegmentRunner;
  /** Primary model identifier recorded in `producedBy`. */
  readonly modelLabel: string;
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: JobStage, fraction: number) => void;
  /** Override duration limit (CLI local runs may lift it). */
  readonly maxDurationSec?: number;
}

export interface PipelineStem {
  readonly stem: StemName;
  readonly format: OutputFormat;
  readonly path: string;
  readonly bytes: number;
  readonly producedBy: string;
}

export interface PipelineResult {
  readonly durationSec: number;
  readonly outputSampleRate: number;
  readonly stems: readonly PipelineStem[];
  readonly warnings: readonly JobWarning[];
  readonly peaks: Readonly<Partial<Record<StemName, number>>>;
}

/** Streams planar float32 blocks into a pre-sized float32 WAV. */
class Float32WavWriter {
  readonly path: string;
  #fh: FileHandle | null = null;
  #position = 0;
  peak = 0;
  constructor(path: string) {
    this.path = path;
  }
  async open(frames: number): Promise<void> {
    this.#fh = await open(this.path, 'w');
    const header = encodeWavHeader(frames, { sampleRate: MODEL_SAMPLE_RATE, channels: 2, sampleFormat: 'float32' });
    await this.#fh.write(header, 0, header.length, 0);
    this.#position = header.length;
  }
  async write(channels: readonly Float32Array[]): Promise<void> {
    if (!this.#fh) throw new Error('writer not open');
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) {
        const a = Math.abs(ch[i]!);
        if (a > this.peak) this.peak = a;
      }
    }
    const bytes = encodePcmBlock(channels, 'float32');
    await this.#fh.write(bytes, 0, bytes.length, this.#position);
    this.#position += bytes.length;
  }
  async close(): Promise<void> {
    await this.#fh?.close();
    this.#fh = null;
  }
}

export async function runPipeline(req: PipelineRequest): Promise<PipelineResult> {
  const warnings: JobWarning[] = [];
  const stage = req.onStage ?? (() => {});
  const maxDuration = req.maxDurationSec ?? SERVER_LIMITS.maxDurationSec;
  const io = req.runner.io;
  await mkdir(req.outDir, { recursive: true });
  const masterDir = join(req.outDir, '.masters');
  await mkdir(masterDir, { recursive: true });

  // ── decode ───────────────────────────────────────────────────────────
  stage('decode', 0);
  let info;
  try {
    info = await probe(req.inputPath);
  } catch (e) {
    throw new PipelineError('decode_failed', e instanceof FfmpegError ? `${e.message}: ${e.stderr.trim()}` : String(e));
  }
  if (info.durationSec > maxDuration) {
    throw new PipelineError('input_too_long', `Input is ${info.durationSec.toFixed(1)} s; limit is ${maxDuration} s`);
  }
  if (info.sampleRate < SERVER_LIMITS.minSampleRate || info.sampleRate > SERVER_LIMITS.maxSampleRate) {
    throw new PipelineError('unsupported_format', `Sample rate ${info.sampleRate} Hz is outside 16–48 kHz`);
  }
  if (info.sampleRate !== MODEL_SAMPLE_RATE) {
    warnings.push({ code: 'input_resampled', message: `Resampled ${info.sampleRate} Hz → ${MODEL_SAMPLE_RATE} Hz for the model.` });
  }
  if (info.channels === 1) warnings.push({ code: 'input_upmixed', message: 'Mono input duplicated to stereo; lead/rhythm split will put all guitar in lead.' });
  if (info.channels > 2) warnings.push({ code: 'input_downmixed', message: `${info.channels}-channel input folded down to stereo.` });

  let left: Float32Array;
  let right: Float32Array;
  try {
    [left, right] = await decodeToModelPcm(req.inputPath);
  } catch (e) {
    throw new PipelineError('decode_failed', e instanceof FfmpegError ? `${e.message}: ${e.stderr.trim()}` : String(e));
  }
  if (left.length === 0) throw new PipelineError('decode_failed', 'Decoded zero frames');
  const frames = left.length;
  stage('decode', 1);

  // ── separate ─────────────────────────────────────────────────────────
  const wanted = SCOPE_OUTPUTS[req.scope];
  const projection = buildProjection(io.stems, wanted);
  const writers = new Map<StemName, Float32WavWriter>();
  for (const stem of projection.keys()) {
    const w = new Float32WavWriter(join(masterDir, `${stem}.f32.wav`));
    await w.open(frames);
    writers.set(stem, w);
  }
  try {
    await separate(
      memorySource([left, right], MODEL_SAMPLE_RATE),
      req.runner,
      {
        async write(block) {
          for (const [stem, channels] of projectBlock(block, projection)) await writers.get(stem)!.write(channels);
        },
      },
      {
        ...(req.signal ? { signal: req.signal } : {}),
        onProgress: (p) => stage('separate', p.fraction),
      },
    );
  } catch (e) {
    if (e instanceof Error && e.name === 'SeparationAbortedError') throw e;
    throw new PipelineError('inference_failed', e instanceof Error ? e.message : String(e), true);
  } finally {
    for (const w of writers.values()) await w.close();
  }
  // Release the decoded mix before the next full-length stage.
  left = new Float32Array(0);
  right = new Float32Array(0);

  const masters = new Map<StemName, { path: string; producedBy: string; peak: number }>();
  for (const [stem, w] of writers) masters.set(stem, { path: w.path, producedBy: req.modelLabel, peak: w.peak });

  // ── lead / rhythm ────────────────────────────────────────────────────
  if (wanted.includes('guitar_lead') || wanted.includes('guitar_rhythm')) {
    stage('lead_rhythm', 0);
    if (GUITAR_LEAD_RHYTHM_ML.availability !== 'published') {
      warnings.push({
        code: 'lead_rhythm_heuristic',
        message: 'Lead/rhythm split uses the spatial-similarity-v0 DSP heuristic (centre = lead, wide/double-tracked = rhythm), not an ML model.',
      });
    }
    const guitar = decodeWav(await readFile(masters.get('guitar')!.path));
    const split = spatialLeadRhythmSplit({ left: guitar.channels[0]!, right: guitar.channels[1]! });
    for (const [stem, pair] of [
      ['guitar_lead', split.lead],
      ['guitar_rhythm', split.rhythm],
    ] as const) {
      const w = new Float32WavWriter(join(masterDir, `${stem}.f32.wav`));
      await w.open(frames);
      await w.write([pair.left, pair.right]);
      await w.close();
      masters.set(stem, { path: w.path, producedBy: `${req.modelLabel}+${split.algorithm}`, peak: w.peak });
    }
    if (!wanted.includes('guitar')) masters.delete('guitar');
    stage('lead_rhythm', 1);
  }

  // ── piano refinement ─────────────────────────────────────────────────
  if (req.options.refinePiano) {
    stage('piano_refine', 0);
    if (BANQUET_PIANO.availability !== 'published') {
      warnings.push({
        code: 'piano_refinement_unavailable',
        message: 'Banquet piano refinement is not built yet; returning the htdemucs_6s piano stem unrefined.',
      });
    }
    stage('piano_refine', 1);
  }

  // ── encode ───────────────────────────────────────────────────────────
  const outputSampleRate = Math.max(MODEL_SAMPLE_RATE, info.sampleRate);
  const results: PipelineStem[] = [];
  const peaks: Partial<Record<StemName, number>> = {};
  const total = wanted.length * req.options.formats.length;
  let done = 0;
  stage('encode', 0);
  for (const stem of wanted) {
    const master = masters.get(stem);
    if (!master) throw new PipelineError('internal', `No master produced for ${stem}`);
    peaks[stem] = master.peak;
    for (const format of req.options.formats) {
      const path = join(req.outDir, stemFileName(stem, format));
      await encodeStem(master.path, path, format, outputSampleRate);
      results.push({ stem, format, path, bytes: (await stat(path)).size, producedBy: master.producedBy });
      stage('encode', ++done / total);
    }
  }
  const clipped = Object.entries(peaks).filter(([, p]) => (p ?? 0) > 1);
  if (clipped.length > 0) {
    warnings.push({
      code: 'clipping_in_output',
      message: `Stems exceed 0 dBFS (${clipped.map(([s, p]) => `${s} ${(20 * Math.log10(p!)).toFixed(1)} dB`).join(', ')}); integer formats are clipped, float masters are not normalised to preserve the mixture sum.`,
    });
  }
  await rm(masterDir, { recursive: true, force: true });
  return { durationSec: frames / MODEL_SAMPLE_RATE, outputSampleRate, stems: results, warnings, peaks };
}

async function encodeStem(master: string, output: string, format: OutputFormat, sampleRate: number): Promise<void> {
  // FFmpeg handles lossy/FLAC, any resampling, and 16-bit (TPDF dither).
  if (format !== 'wav24' || sampleRate !== MODEL_SAMPLE_RATE) {
    await transcode(master, output, format, sampleRate);
    return;
  }
  // 24-bit at the model rate needs no dither or resampling: the core codec writes it directly.
  const decoded = decodeWav(await readFile(master));
  const frames = decoded.channels[0]!.length;
  const fh = await open(output, 'w');
  try {
    await fh.write(encodeWavHeader(frames, { sampleRate, channels: 2, sampleFormat: 'pcm24' }));
    const block = MODEL_SAMPLE_RATE * 10;
    for (let s = 0; s < frames; s += block) {
      await fh.write(encodePcmBlock(decoded.channels.map((c) => c.subarray(s, s + block)), 'pcm24'));
    }
  } finally {
    await fh.close();
  }
}
