/**
 * Decode a user file to planar stereo at the model rate. An OfflineAudioContext
 * created at 44.1 kHz makes decodeAudioData resample for us (a plain
 * AudioContext would decode at the *hardware* rate, often 48 kHz).
 *
 * Known drift: MP3/AAC priming-sample trimming differs across engines, so the
 * device path can be offset by up to ~1 frame of 1152 samples vs. the server's
 * FFmpeg decode. Server jobs always upload the original file for this reason.
 */
import { MODEL_SAMPLE_RATE, toStereoPlanar } from '@stemsplit/core';

export interface DecodedInput {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly durationSec: number;
  readonly sourceChannels: number;
}

export async function decodeForModel(file: Blob): Promise<DecodedInput> {
  const bytes = await file.arrayBuffer();
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: MODEL_SAMPLE_RATE });
  const buffer = await ctx.decodeAudioData(bytes);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const [left, right] = toStereoPlanar(channels);
  return { left, right, durationSec: buffer.duration, sourceChannels: buffer.numberOfChannels };
}

/** Cheap duration probe without decoding the whole file into memory. */
export function probeDuration(file: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => done(null);
    audio.src = url;
  });
}
