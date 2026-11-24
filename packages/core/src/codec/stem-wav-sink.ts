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
