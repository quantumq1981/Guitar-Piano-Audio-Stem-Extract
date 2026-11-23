/**
 * Channel-layout normalisation. The model is strictly stereo; inputs may be
 * mono, stereo, or multichannel. All buffers are planar Float32Array per channel.
 */

/** Mono → duplicated stereo; stereo → as-is; >2 channels → ITU-style L/R fold-down. */
export function toStereoPlanar(channels: readonly Float32Array[]): [Float32Array, Float32Array] {
  if (channels.length === 0) throw new RangeError('At least one channel is required');
  const frames = channels[0]!.length;
  for (const ch of channels) {
    if (ch.length !== frames) throw new RangeError('All channels must have equal length');
  }
  if (channels.length === 1) {
    const mono = channels[0]!;
    return [mono, new Float32Array(mono)];
  }
  if (channels.length === 2) return [channels[0]!, channels[1]!];

  // 5.1 order (WAV/FFmpeg): FL FR FC LFE BL BR. Centre at −3 dB, surrounds at −3 dB, LFE dropped.
  const g = Math.SQRT1_2;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const fl = channels[0]!;
  const fr = channels[1]!;
  const fc = channels[2];
  const bl = channels[4];
  const br = channels[5];
  for (let i = 0; i < frames; i++) {
    const c = fc ? fc[i]! * g : 0;
    left[i] = fl[i]! + c + (bl ? bl[i]! * g : 0);
    right[i] = fr[i]! + c + (br ? br[i]! * g : 0);
  }
  const peak = Math.max(peakAbs(left), peakAbs(right));
  if (peak > 1) {
    const inv = 1 / peak;
    for (let i = 0; i < frames; i++) {
      left[i]! *= inv;
      right[i]! *= inv;
    }
  }
  return [left, right];
}

export function peakAbs(x: Float32Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]!);
    if (v > m) m = v;
  }
  return m;
}

/** Interleaved [L0,R0,L1,R1,…] → planar. */
export function deinterleave(interleaved: Float32Array, channels: number): Float32Array[] {
  if (channels < 1) throw new RangeError('channels must be ≥ 1');
  if (interleaved.length % channels !== 0) {
    throw new RangeError(`Interleaved length ${interleaved.length} is not a multiple of ${channels}`);
  }
  const frames = interleaved.length / channels;
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) out[c]![i] = interleaved[i * channels + c]!;
  }
  return out;
}
