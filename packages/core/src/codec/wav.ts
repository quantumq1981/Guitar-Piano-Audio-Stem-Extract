/**
 * RIFF/WAVE PCM codec — 16/24-bit integer and 32-bit float.
 *
 * Streaming-friendly: the header depends only on (frames, channels, rate,
 * format), so a writer can emit the header first and then append PCM blocks as
 * the overlap-add accumulator finalises them.
 *
 * Edge cases handled:
 *  - RIFF size field is u32: data > 4 GiB − 44 bytes is rejected (RF64 not supported).
 *  - Integer conversion rounds to nearest and saturates at the integer range; NaN/±Inf → 0.
 *  - Odd-sized chunks in the decoder are word-aligned per the RIFF spec.
 *  - WAVE_FORMAT_EXTENSIBLE is accepted when its sub-format GUID is PCM or IEEE float.
 */

export type WavSampleFormat = 'pcm16' | 'pcm24' | 'float32';

export interface WavFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly sampleFormat: WavSampleFormat;
}

export const WAV_HEADER_BYTES = 44;
const MAX_RIFF_DATA = 0xffff_ffff - 36;

export function bytesPerSample(format: WavSampleFormat): 2 | 3 | 4 {
  switch (format) {
    case 'pcm16':
      return 2;
    case 'pcm24':
      return 3;
    case 'float32':
      return 4;
  }
}

export function wavDataBytes(frames: number, format: WavFormat): number {
  return frames * format.channels * bytesPerSample(format.sampleFormat);
}

export function encodeWavHeader(frames: number, format: WavFormat): Uint8Array {
  validateFormat(format);
  if (!Number.isSafeInteger(frames) || frames < 0) throw new RangeError(`Invalid frame count ${frames}`);
  const dataBytes = wavDataBytes(frames, format);
  if (dataBytes > MAX_RIFF_DATA) {
    throw new RangeError(`WAV data of ${dataBytes} bytes exceeds the 4 GiB RIFF limit`);
  }
  const bps = bytesPerSample(format.sampleFormat);
  const buf = new ArrayBuffer(WAV_HEADER_BYTES);
  const v = new DataView(buf);
  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeAscii(v, 8, 'WAVE');
  writeAscii(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, format.sampleFormat === 'float32' ? 3 : 1, true);
  v.setUint16(22, format.channels, true);
  v.setUint32(24, format.sampleRate, true);
  v.setUint32(28, format.sampleRate * format.channels * bps, true);
  v.setUint16(32, format.channels * bps, true);
  v.setUint16(34, bps * 8, true);
  writeAscii(v, 36, 'data');
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

/** Interleave planar channels into PCM bytes for the given format. */
export function encodePcmBlock(planar: readonly Float32Array[], sampleFormat: WavSampleFormat): Uint8Array {
  const channels = planar.length;
  if (channels === 0) throw new RangeError('No channels');
  const frames = planar[0]!.length;
  for (const p of planar) if (p.length !== frames) throw new RangeError('Channel length mismatch');
  const bps = bytesPerSample(sampleFormat);
  const out = new Uint8Array(frames * channels * bps);
  const view = new DataView(out.buffer);
  let o = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = planar[c]![i]!;
      switch (sampleFormat) {
        case 'pcm16':
          view.setInt16(o, floatToInt(s, 32768), true);
          break;
        case 'pcm24': {
          const v = floatToInt(s, 8_388_608);
          out[o] = v & 0xff;
          out[o + 1] = (v >> 8) & 0xff;
          out[o + 2] = (v >> 16) & 0xff;
          break;
        }
        case 'float32':
          view.setFloat32(o, Number.isFinite(s) ? s : 0, true);
          break;
      }
      o += bps;
    }
  }
  return out;
}

export function encodeWav(planar: readonly Float32Array[], format: WavFormat): Uint8Array {
  if (planar.length !== format.channels) throw new RangeError('planar.length must equal format.channels');
  const frames = planar[0]?.length ?? 0;
  const header = encodeWavHeader(frames, format);
  const body = encodePcmBlock(planar, format.sampleFormat);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

export interface DecodedWav {
  readonly format: WavFormat;
  readonly channels: Float32Array[];
}

export function decodeWav(bytes: Uint8Array): DecodedWav {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || readAscii(v, 0) !== 'RIFF' || readAscii(v, 8) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= bytes.byteLength) {
    const id = readAscii(v, offset);
    const size = v.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16) throw new Error('fmt chunk too small');
      let audioFormat = v.getUint16(body, true);
      if (audioFormat === 0xfffe && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE: first two bytes of the sub-format GUID carry the real tag.
        audioFormat = v.getUint16(body + 24, true);
      }
      fmt = {
        audioFormat,
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bits: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, bytes.byteLength - body);
      break;
    }
    offset = body + size + (size & 1);
  }
  if (!fmt) throw new Error('Missing fmt chunk');
  if (dataOffset < 0) throw new Error('Missing data chunk');

  let sampleFormat: WavSampleFormat;
  if (fmt.audioFormat === 1 && fmt.bits === 16) sampleFormat = 'pcm16';
  else if (fmt.audioFormat === 1 && fmt.bits === 24) sampleFormat = 'pcm24';
  else if (fmt.audioFormat === 3 && fmt.bits === 32) sampleFormat = 'float32';
  else throw new Error(`Unsupported WAV encoding: format=${fmt.audioFormat} bits=${fmt.bits}`);

  const format: WavFormat = { sampleRate: fmt.sampleRate, channels: fmt.channels, sampleFormat };
  validateFormat(format);
  const bps = bytesPerSample(sampleFormat);
  const frames = Math.floor(dataLength / (bps * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  let o = dataOffset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      let s: number;
      switch (sampleFormat) {
        case 'pcm16':
          s = v.getInt16(o, true) / 32768;
          break;
        case 'pcm24': {
          let x = bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16);
          if (x & 0x80_0000) x |= ~0xff_ffff;
          s = x / 8_388_608;
          break;
        }
        case 'float32':
          s = v.getFloat32(o, true);
          break;
      }
      channels[c]![i] = s;
      o += bps;
    }
  }
  return { format, channels };
}

function floatToInt(sample: number, scale: number): number {
  if (!Number.isFinite(sample)) return 0;
  const scaled = Math.round(sample * scale);
  return scaled > scale - 1 ? scale - 1 : scaled < -scale ? -scale : scaled;
}

function validateFormat(format: WavFormat): void {
  if (!Number.isInteger(format.channels) || format.channels < 1 || format.channels > 32) {
    throw new RangeError(`Invalid channel count ${format.channels}`);
  }
  if (!Number.isInteger(format.sampleRate) || format.sampleRate < 8000 || format.sampleRate > 384_000) {
    throw new RangeError(`Invalid sample rate ${format.sampleRate}`);
  }
}

function writeAscii(v: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
}

function readAscii(v: DataView, offset: number): string {
  return String.fromCharCode(v.getUint8(offset), v.getUint8(offset + 1), v.getUint8(offset + 2), v.getUint8(offset + 3));
}
