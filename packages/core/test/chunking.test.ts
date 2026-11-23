import { describe, expect, it } from 'vitest';
import { StreamingOverlapAdd, chunkWeight, planChunks } from '../src/dsp/chunking.ts';
import { maxAbsDiff, noise } from './helpers.ts';

describe('planChunks', () => {
  it('uses one chunk when input fits a single segment', () => {
    for (const total of [1, 999, 1000]) {
      const p = planChunks(total, 1000);
      expect(p.chunks).toHaveLength(1);
      expect(p.chunks[0]).toMatchObject({ start: 0, validFrames: total, isFirst: true, isLast: true });
    }
  });

  it('covers every frame exactly once beyond overlaps, with no wasted trailing chunk', () => {
    const n = 1000;
    for (const total of [1001, 1750, 1751, 2500, 10_000, 12_345]) {
      const p = planChunks(total, n);
      expect(p.overlapFrames).toBe(250);
      expect(p.strideFrames).toBe(750);
      const last = p.chunks.at(-1)!;
      expect(last.start + last.validFrames).toBe(total);
      // The previous chunk must not already reach the end (otherwise the last one is wasted).
      const prev = p.chunks.at(-2)!;
      expect(prev.start + n).toBeLessThan(total);
      for (const c of p.chunks.slice(0, -1)) expect(c.validFrames).toBe(n);
    }
  });

  it('rejects invalid geometry', () => {
    expect(() => planChunks(0, 100)).toThrow(RangeError);
    expect(() => planChunks(10, 1)).toThrow(RangeError);
    expect(() => planChunks(10, 100, 0.5)).toThrow(RangeError);
    expect(() => planChunks(1.5, 100)).toThrow(RangeError);
  });
});

describe('chunkWeight', () => {
  it('adjacent fades are complementary', () => {
    const n = 400;
    const o = 100;
    const s = n - o;
    for (let k = 0; k < o; k++) {
      const fadeOut = chunkWeight(s + k, o, n, true, false);
      const fadeIn = chunkWeight(k, o, n, false, true);
      expect(fadeOut + fadeIn).toBeCloseTo(1, 12);
    }
  });
  it('first chunk has no fade-in and last chunk has no fade-out', () => {
    expect(chunkWeight(0, 100, 400, true, false)).toBe(1);
    expect(chunkWeight(399, 100, 400, false, true)).toBe(1);
  });
});

describe('StreamingOverlapAdd', () => {
  const runIdentity = (signal: Float32Array, n: number, overlap = 0.25) => {
    const plan = planChunks(signal.length, n, overlap);
    const ola = new StreamingOverlapAdd(plan, 1, 1);
    const out = new Float32Array(signal.length);
    let cursor = 0;
    for (const c of plan.chunks) {
      const seg = new Float32Array(n);
      seg.set(signal.subarray(c.start, c.start + c.validFrames));
      const block = ola.add(c, seg);
      expect(block.start).toBe(cursor);
      out.set(block.planes[0]![0]!, block.start);
      cursor += block.frames;
    }
    expect(cursor).toBe(signal.length);
    expect(ola.done).toBe(true);
    return out;
  };

  it('reconstructs the input exactly through an identity model', () => {
    for (const total of [37, 1000, 1001, 5_432, 20_000]) {
      const x = noise(total, total);
      expect(maxAbsDiff(runIdentity(x, 1000), x)).toBeLessThan(1e-6);
    }
  });

  it('reconstructs with zero overlap as well', () => {
    const x = noise(4321, 7);
    expect(maxAbsDiff(runIdentity(x, 1000, 0), x)).toBeLessThan(1e-7);
  });

  it('holds O(segment) memory independent of input length', () => {
    const small = new StreamingOverlapAdd(planChunks(2_000, 1000), 6, 2);
    const huge = new StreamingOverlapAdd(planChunks(50_000_000, 1000), 6, 2);
    expect(huge.residentBytes).toBe(small.residentBytes);
    expect(small.residentBytes).toBe(13 * 1000 * 4);
  });

  it('rejects out-of-order chunks and wrong output sizes', () => {
    const plan = planChunks(3000, 1000);
    const ola = new StreamingOverlapAdd(plan, 2, 2);
    expect(() => ola.add(plan.chunks[1]!, new Float32Array(4000))).toThrow(/in order/);
    expect(() => ola.add(plan.chunks[0]!, new Float32Array(10))).toThrow(RangeError);
  });

  it('cross-fades disagreeing chunk outputs smoothly (no step at the seam)', () => {
    // Model that outputs a constant equal to its chunk index: seams must be linear ramps.
    const n = 1000;
    const plan = planChunks(1750, n);
    const ola = new StreamingOverlapAdd(plan, 1, 1);
    const out = new Float32Array(1750);
    for (const c of plan.chunks) {
      const block = ola.add(c, new Float32Array(n).fill(c.index));
      out.set(block.planes[0]![0]!, block.start);
    }
    for (let i = 1; i < out.length; i++) expect(Math.abs(out[i]! - out[i - 1]!)).toBeLessThan(1 / 249 + 1e-6);
    expect(out[0]).toBe(0);
    expect(out[1749]).toBe(1);
  });
});
