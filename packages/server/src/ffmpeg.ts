/**
 * FFmpeg/ffprobe adapters. The server always decodes the *original upload* with
 * FFmpeg, so MP3/AAC encoder-delay handling is identical for every job — a
 * browser's decodeAudioData trims priming samples differently per engine, which
 * is a real (sample-offset) source of client/server drift.
 */
import { spawn } from 'node:child_process';
import { MODEL_SAMPLE_RATE } from '@stemsplit/core';

export interface ProbeResult {
  readonly durationSec: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly codec: string;
}

export class FfmpegError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'FfmpegError';
    this.stderr = stderr;
  }
}

function run(cmd: string, args: readonly string[], opts: { collectStdout: boolean }): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      if (opts.collectStdout) chunks.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-8000);
    });
    child.on('error', (e) => reject(new FfmpegError(`${cmd} failed to start: ${e.message}`, stderr)));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(chunks), stderr });
      else reject(new FfmpegError(`${cmd} exited with code ${code}`, stderr));
    });
  });
}

export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels,codec_name:format=duration', '-of', 'json', path],
    { collectStdout: true },
  );
  const parsed: unknown = JSON.parse(stdout.toString('utf8'));
  const root = parsed as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const stream = root.streams?.[0];
  if (!stream) throw new FfmpegError('No audio stream found', '');
  const durationSec = Number(root.format?.duration);
  const sampleRate = Number(stream.sample_rate);
  const channels = Number(stream.channels);
  if (!(durationSec > 0) || !(sampleRate > 0) || !(channels > 0)) {
    throw new FfmpegError(`Unusable probe result: ${JSON.stringify(stream)}`, '');
  }
  return { durationSec, sampleRate, channels, codec: String(stream.codec_name) };
}

/**
 * Decode any supported input to planar stereo float32 at the model rate.
 * Resampling uses SoX (libsoxr) at very-high quality when needed; mono is
 * duplicated and multichannel is folded down by FFmpeg's default matrix.
 */
export async function decodeToModelPcm(path: string): Promise<[Float32Array, Float32Array]> {
  const { stdout } = await run(
    'ffmpeg',
    ['-v', 'error', '-nostdin', '-i', path, '-vn', '-af', 'aresample=resampler=soxr:precision=28', '-ac', '2', '-ar', String(MODEL_SAMPLE_RATE), '-f', 'f32le', '-'],
    { collectStdout: true },
  );
  if (stdout.byteLength % 8 !== 0) throw new FfmpegError(`Decoded byte length ${stdout.byteLength} is not frame-aligned`, '');
  // Copy into an aligned buffer: Buffer pooling can yield unaligned byteOffsets.
  const aligned = new Float32Array(stdout.byteLength / 4);
  new Uint8Array(aligned.buffer).set(stdout);
  const frames = aligned.length / 2;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = aligned[2 * i]!;
    right[i] = aligned[2 * i + 1]!;
  }
  return [left, right];
}

const CODEC_ARGS: Readonly<Record<'flac' | 'mp3' | 'wav16' | 'wav24', readonly string[]>> = {
  flac: ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'],
  mp3: ['-c:a', 'libmp3lame', '-b:a', '320k'],
  // TPDF dither when truncating float masters to 16-bit.
  wav16: ['-c:a', 'pcm_s16le'],
  wav24: ['-c:a', 'pcm_s24le'],
};

/** Encode a float32 master to `format`, resampling with SoX when `sampleRate` differs. */
export async function transcode(inputWav: string, output: string, format: 'flac' | 'mp3' | 'wav16' | 'wav24', sampleRate: number): Promise<void> {
  const filter = `aresample=resampler=soxr:precision=28${format === 'wav16' ? ':dither_method=triangular' : ''}`;
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', inputWav, '-af', filter, '-ar', String(sampleRate), ...CODEC_ARGS[format], output], {
    collectStdout: false,
  });
}
