import { describe, expect, it } from 'vitest';
import type { FinalizedBlock, ModelIO, SegmentRunner, StemName, WavFormat } from '../src/index.ts';
import { WAV_HEADER_BYTES, decodeWav, encodeWav, memorySource, separate, wavStemSink } from '../src/index.ts';
import { noise } from './helpers.ts';

const STEMS: StemName[] = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
const io: ModelIO = { inputName: 'mix', outputName: 'stems', segmentFrames: 2048, sampleRate: 44_100, channels: 2, stems: STEMS };
const pcm16: WavFormat = { sampleRate: 44_100, channels: 2, sampleFormat: 'pcm16' };

/** Fake model: stem s = input × gains[s]. */
function gainRunner(gains: number[]): SegmentRunner {
  return {
    io,
    async run(input) {
      const n = io.segmentFrames;
      const out = new Float32Array(STEMS.length * 2 * n);
      for (let s = 0; s < STEMS.length; s++) {
        for (let c = 0; c < 2; c++) for (let k = 0; k < n; k++) out[(s * 2 + c) * n + k] = input[c * n + k]! * gains[s]!;
      }
      return out;
    },
  };
}

/** In-memory stand-in for the OPFS sync access handles: one growable byte array per stem. */
function memoryFiles(stems: number) {
  const files = Array.from({ length: stems }, () => new Uint8Array(0));
  const writes: number[] = [];
  return {
    files,
    writes,
    port(stem: number, offset: number, bytes: Uint8Array) {
      writes.push(stem);
      const old = files[stem]!;
      if (offset + bytes.length > old.length) {
        const grown = new Uint8Array(offset + bytes.length);
        grown.set(old);
        files[stem] = grown;
      }
      files[stem]!.set(bytes, offset);
    },
  };
}

describe('wavStemSink', () => {
  it('streams a whole separation into one valid WAV per stem, equal to encoding the collected stems at once', async () => {
    const frames = 9_000; // several chunks, last one partial
    const left = noise(frames, 11);
    const right = noise(frames, 12);
    const gains = [0.1, 0.2, 0.3, 0.15, 0.15, 0.1];
    const store = memoryFiles(STEMS.length);
    const sink = wavStemSink(STEMS.length, frames, pcm16, store.port);
    const collected: FinalizedBlock[] = [];
    await separate(memorySource([left, right], 44_100), gainRunner(gains), {
      async write(block) {
        collected.push(block);
        await sink.write(block);
      },
    });
    const summary = sink.finish();
    expect(summary.frames).toBe(frames);
    expect(summary.fileBytes).toBe(WAV_HEADER_BYTES + frames * 4);
    for (let s = 0; s < STEMS.length; s++) {
      const file = store.files[s]!;
      expect(file.length).toBe(summary.fileBytes);
      const planar = [0, 1].map((c) => {
        const out = new Float32Array(frames);
        for (const b of collected) out.set(b.planes[s]![c]!, b.start);
        return out;
      });
      expect(file).toEqual(encodeWav(planar, pcm16));
      const decoded = decodeWav(file);
      expect(decoded.channels[0]!.length).toBe(frames);
      expect(summary.peaks[s]).toBeCloseTo(Math.max(...planar.flatMap((p) => Array.from(p, Math.abs))), 6);
    }
  });

  it('writes each header once, with the first block', async () => {
    const store = memoryFiles(1);
    const sink = wavStemSink(1, 4, pcm16, store.port);
    const block = (start: number, frames: number): FinalizedBlock => ({
      start, frames, planes: [[new Float32Array(frames).fill(0.5), new Float32Array(frames).fill(-0.5)]],
    });
    await sink.write(block(0, 2));
    await sink.write(block(2, 2));
    expect(store.writes).toEqual([0, 0, 0]); // header, block 1, block 2
    expect(sink.finish().peaks).toEqual([0.5]);
  });

  it('reports a clipping peak above 1 and still writes saturated samples', async () => {
    const store = memoryFiles(1);
    const sink = wavStemSink(1, 2, pcm16, store.port);
    await sink.write({ start: 0, frames: 2, planes: [[Float32Array.of(1.5, 0), Float32Array.of(-2, 0)]] });
    expect(sink.finish().peaks[0]).toBe(2);
    expect(decodeWav(store.files[0]!).channels[0]![0]).toBeCloseTo(32767 / 32768, 6);
  });

  it('rejects gaps, overruns, wrong stem or channel counts, and an incomplete finish', async () => {
    const one = (start: number, frames: number, channels = 2): FinalizedBlock => ({
      start, frames, planes: [Array.from({ length: channels }, () => new Float32Array(frames))],
    });
    const make = () => wavStemSink(1, 10, pcm16, () => {});
    await expect(make().write(one(2, 2))).rejects.toThrow(/contiguous/);
    await expect(make().write(one(0, 11))).rejects.toThrow(/beyond/);
    await expect(make().write(one(0, 2, 1))).rejects.toThrow(/channels/);
    await expect(wavStemSink(2, 10, pcm16, () => {}).write(one(0, 2))).rejects.toThrow(/stems/);
    const partial = make();
    await partial.write(one(0, 4));
    expect(() => partial.finish()).toThrow(/Only 4 of 10/);
    expect(() => wavStemSink(0, 10, pcm16, () => {})).toThrow(RangeError);
  });
});
