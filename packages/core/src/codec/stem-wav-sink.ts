/**
 * A StemSink that streams each stem into its own WAV file through an injected write port, so a full song can be
 * separated without holding six copies of it in memory. The browser backs the port with OPFS sync access handles;
 * tests back it with byte arrays.
 *
 * Layout per stem file: the 44-byte header (sized for `totalFrames`, written with the first block), then
 * interleaved PCM blocks at offset 44 + start × channels × bytesPerSample. Blocks must arrive contiguous and in
 * order, as StreamingOverlapAdd produces them. `finish()` checks that every frame was written.
 */
import type { FinalizedBlock } from '../dsp/chunking.ts';
import type { StemSink } from '../separation/engine.ts';
import { WAV_HEADER_BYTES, bytesPerSample, encodePcmBlock, encodeWavHeader, type WavFormat } from './wav.ts';

/** Writes `bytes` at byte `offset` of stem file `stem` (index into the model's stem order). */
export type StemWritePort = (stem: number, offset: number, bytes: Uint8Array) => void | Promise<void>;

export interface StemWavSummary {
  readonly frames: number;
  /** Largest absolute sample per stem before conversion; > 1 means the integer output clipped. */
  readonly peaks: readonly number[];
  /** Bytes per stem file, header included. */
  readonly fileBytes: number;
}

export interface StemWavSink extends StemSink {
  finish(): StemWavSummary;
}

export function wavStemSink(stems: number, totalFrames: number, format: WavFormat, port: StemWritePort): StemWavSink {
  if (!Number.isSafeInteger(stems) || stems < 1) throw new RangeError(`stems must be ≥ 1, got ${stems}`);
  const header = encodeWavHeader(totalFrames, format);
  const frameBytes = format.channels * bytesPerSample(format.sampleFormat);
  const peaks = new Array<number>(stems).fill(0);
  let written = 0;

  return {
    async write(block: FinalizedBlock) {
      if (block.start !== written) {
        throw new Error(`Stem blocks must be contiguous: expected frame ${written}, got ${block.start}`);
      }
      if (block.start + block.frames > totalFrames) {
        throw new RangeError(`Block ends at frame ${block.start + block.frames}, beyond ${totalFrames}`);
      }
      if (block.planes.length !== stems) throw new RangeError(`Block has ${block.planes.length} stems, expected ${stems}`);
      for (let stem = 0; stem < stems; stem++) {
        const planes = block.planes[stem]!;
        if (planes.length !== format.channels) {
          throw new RangeError(`Stem ${stem} has ${planes.length} channels, expected ${format.channels}`);
        }
        let peak = peaks[stem]!;
        for (const plane of planes) {
          for (let i = 0; i < plane.length; i++) {
            const a = Math.abs(plane[i]!);
            if (a > peak) peak = a;
          }
        }
        peaks[stem] = peak;
        if (written === 0) await port(stem, 0, header);
        await port(stem, WAV_HEADER_BYTES + block.start * frameBytes, encodePcmBlock(planes, format.sampleFormat));
      }
      written += block.frames;
    },
    finish() {
      if (written !== totalFrames) throw new Error(`Only ${written} of ${totalFrames} frames were written`);
      return { frames: written, peaks: [...peaks], fileBytes: WAV_HEADER_BYTES + totalFrames * frameBytes };
    },
  };
}

/**
 * What a stem file found in storage holds, judged from its first 44 bytes and its size. `wavStemSink` writes the
 * header (sized for the whole song) with the first block, then PCM in order, so a run that was cancelled or killed
 * leaves a file shorter than its header promises.
 *  - `complete`: every frame the header promises is present.
 *  - `partial`: the run stopped before the end (includes a file too short to hold a header).
 *  - `invalid`: not a canonical 44-byte-header PCM/float WAV, or longer than its header says.
 */
export type StoredStemState = 'complete' | 'partial' | 'invalid';

export interface StoredStem {
  readonly state: StoredStemState;
  /** Frames the header promises (0 when the header is missing or invalid). */
  readonly frames: number;
}

export function storedStem(header: Uint8Array, fileSize: number): StoredStem {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) throw new RangeError(`Invalid file size ${fileSize}`);
  if (fileSize < WAV_HEADER_BYTES || header.length < WAV_HEADER_BYTES) {
    return { state: fileSize < WAV_HEADER_BYTES ? 'partial' : 'invalid', frames: 0 };
  }
  const v = new DataView(header.buffer, header.byteOffset, WAV_HEADER_BYTES);
  const tag = (at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
  const blockAlign = v.getUint16(32, true);
  const dataBytes = v.getUint32(40, true);
  const canonical = tag(0) === 'RIFF' && tag(8) === 'WAVE' && tag(12) === 'fmt ' && tag(36) === 'data' &&
    v.getUint32(16, true) === 16 && v.getUint32(4, true) === 36 + dataBytes &&
    blockAlign > 0 && dataBytes % blockAlign === 0;
  if (!canonical) return { state: 'invalid', frames: 0 };
  const frames = dataBytes / blockAlign;
  const expected = WAV_HEADER_BYTES + dataBytes;
  return { state: fileSize === expected ? 'complete' : fileSize < expected ? 'partial' : 'invalid', frames };
}
