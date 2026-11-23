import { describe, expect, it } from 'vitest';
import type { FinalizedBlock, ModelIO, SegmentRunner, StemName } from '../src/index.ts';
import { SCOPE_OUTPUTS, SeparationAbortedError, buildProjection, memorySource, projectBlock, separate } from '../src/index.ts';
import { maxAbsDiff, noise } from './helpers.ts';

const STEMS: StemName[] = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
const io: ModelIO = { inputName: 'mix', outputName: 'stems', segmentFrames: 2048, sampleRate: 44100, channels: 2, stems: STEMS };

/** Fake model: stem s = input × gains[s]; gains sum to 1 so stems sum to the mix. */
function gainRunner(gains: number[]): SegmentRunner & { calls: number } {
  return {
    io,
    calls: 0,
    async run(input) {
      this.calls++;
      const n = io.segmentFrames;
      const out = new Float32Array(STEMS.length * 2 * n);
      for (let s = 0; s < STEMS.length; s++) {
        for (let c = 0; c < 2; c++) {
          for (let k = 0; k < n; k++) out[(s * 2 + c) * n + k] = input[c * n + k]! * gains[s]!;
        }
      }
      return out;
    },
  };
}

function collect() {
  const blocks: FinalizedBlock[] = [];
  return { blocks, sink: { write: (b: FinalizedBlock) => void blocks.push(b) } };
}

describe('separate()', () => {
  const gains = [0.1, 0.2, 0.3, 0.15, 0.15, 0.1];
  const left = noise(10_000, 1);
  const right = noise(10_000, 2);

  it('streams finalised blocks whose stems equal gain × input', async () => {
    const runner = gainRunner(gains);
    const { blocks, sink } = collect();
    const plan = await separate(memorySource([left, right], 44100), runner, sink);
    expect(runner.calls).toBe(plan.chunks.length);
    const total = blocks.reduce((a, b) => a + b.frames, 0);
    expect(total).toBe(10_000);
    const guitarL = new Float32Array(10_000);
    for (const b of blocks) guitarL.set(b.planes[4]![0]!, b.start);
    const expected = left.map((v) => v * 0.15);
    expect(maxAbsDiff(guitarL, expected)).toBeLessThan(1e-6);
  });

  it('quick projection folds guitar+piano into other and preserves the mixture', async () => {
    const { blocks, sink } = collect();
    await separate(memorySource([left, right], 44100), gainRunner(gains), sink);
    const proj = buildProjection(STEMS, SCOPE_OUTPUTS.quick);
    expect([...proj.keys()].sort()).toEqual(['bass', 'drums', 'other', 'vocals']);
    expect(proj.get('other')).toEqual([2, 4, 5]);
    for (const b of blocks) {
      const stems = projectBlock(b, proj);
      for (let i = 0; i < b.frames; i += 97) {
        let sum = 0;
        for (const ch of stems.values()) sum += ch[0]![i]!;
        expect(sum).toBeCloseTo(left[b.start + i]!, 5);
      }
    }
  });

  it('guitar scope keeps the guitar source for downstream lead/rhythm split', () => {
    const proj = buildProjection(STEMS, SCOPE_OUTPUTS.guitar);
    expect(proj.get('guitar')).toEqual([4]);
    expect(proj.get('other')).toEqual([2]);
    expect(proj.has('guitar_lead')).toBe(false);
  });

  it('duplicates mono sources into both model channels', async () => {
    const { blocks, sink } = collect();
    const src = memorySource([left], 44100);
    await separate({ ...src, read: (s, f, out) => src.read(s, f, out) }, gainRunner(gains), sink);
    expect(maxAbsDiff(blocks[0]!.planes[0]![0]!, blocks[0]!.planes[0]![1]!)).toBe(0);
  });

  it('refuses sources at the wrong sample rate', async () => {
    await expect(separate(memorySource([left, right], 48000), gainRunner(gains), collect().sink)).rejects.toThrow(/Resample/);
  });

  it('honours AbortSignal and beforeChunk vetoes between chunks', async () => {
    const ac = new AbortController();
    ac.abort('user');
    await expect(separate(memorySource([left, right], 44100), gainRunner(gains), collect().sink, { signal: ac.signal })).rejects.toBeInstanceOf(
      SeparationAbortedError,
    );
    const runner = gainRunner(gains);
    await expect(
      separate(memorySource([left, right], 44100), runner, collect().sink, {
        beforeChunk: (c) => {
          if (c.index === 2) throw new Error('page hidden');
        },
      }),
    ).rejects.toThrow('page hidden');
    expect(runner.calls).toBe(2);
  });

  it('reports monotonic progress ending at 1', async () => {
    const fractions: number[] = [];
    let t = 0;
    await separate(memorySource([left, right], 44100), gainRunner(gains), collect().sink, {
      onProgress: (p) => fractions.push(p.fraction),
      now: () => (t += 10),
    });
    expect(fractions.at(-1)).toBe(1);
    for (let i = 1; i < fractions.length; i++) expect(fractions[i]!).toBeGreaterThan(fractions[i - 1]!);
  });
});
