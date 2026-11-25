import { describe, expect, it } from 'vitest';
import {
  capWasmMemoryDescriptor,
  HTDEMUCS_6S_FOLDED_FP16W,
  maxAbsDifference,
  MOBILE_STAGE4_CANDIDATE,
  STAGE4_THREAD_OPTIONS,
  stage4Threads,
  MODEL_REGISTRY,
  stage4TestSignal,
  touchedBytes,
  WASM_CAP_LADDER_PAGES,
  WASM_PAGE_BYTES,
} from '../src/index.ts';

describe('MOBILE_STAGE4_CANDIDATE', () => {
  it('pins both files to the CI-validated bytes and keeps the data name the graph records', () => {
    const c = MOBILE_STAGE4_CANDIDATE;
    for (const f of [c.graph, c.data]) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.bytes).toBeGreaterThan(0);
    }
    expect(c.data.file).toBe(`${c.graph.file}.data`);
    expect(c.sourceSha256).toBe(HTDEMUCS_6S_FOLDED_FP16W.sha256);
    expect(c.io.segmentFrames).toBe(343_980);
    expect(c.session.graphOptimizationLevel).toBe('disabled');
  });

  it('is never part of the routed registry', () => {
    expect(MODEL_REGISTRY.map((m) => m.id)).not.toContain(MOBILE_STAGE4_CANDIDATE.id);
  });
});

describe('capWasmMemoryDescriptor', () => {
  const ortRequest = { initial: 256, maximum: 65_536, shared: true };

  it('lowers the 4 GiB maximum of a shared memory to the cap', () => {
    expect(capWasmMemoryDescriptor(ortRequest, 16_384)).toEqual({ initial: 256, maximum: 16_384, shared: true });
  });

  it('passes through unshared memories, small maxima and descriptors without a maximum', () => {
    const unshared = { initial: 256, maximum: 65_536 };
    const small = { initial: 1, maximum: 100, shared: true };
    const open = { initial: 1 };
    expect(capWasmMemoryDescriptor(unshared, 16_384)).toBe(unshared);
    expect(capWasmMemoryDescriptor(small, 16_384)).toBe(small);
    expect(capWasmMemoryDescriptor(open, 16_384)).toBe(open);
  });

  it('never caps below the initial size', () => {
    const big = { initial: 20_000, maximum: 65_536, shared: true };
    expect(capWasmMemoryDescriptor(big, 16_384).maximum).toBe(20_000);
  });

  it('ladders down and leaves room for the measured 616 MiB heap', () => {
    expect([...WASM_CAP_LADDER_PAGES].sort((a, b) => b - a)).toEqual([...WASM_CAP_LADDER_PAGES]);
    expect(Math.min(...WASM_CAP_LADDER_PAGES) * WASM_PAGE_BYTES).toBeGreaterThan(616 * 2 ** 20);
  });
});

describe('touchedBytes', () => {
  it('counts 4 KiB pages holding any non-zero byte', () => {
    const heap = new ArrayBuffer(16 * 4096);
    const bytes = new Uint8Array(heap);
    expect(touchedBytes(heap)).toBe(0);
    bytes[0] = 1;
    bytes[4096 * 5 + 4095] = 7;
    bytes[4096 * 5 + 10] = 7;
    expect(touchedBytes(heap)).toBe(2 * 4096);
  });

  it('handles a trailing partial page', () => {
    const heap = new ArrayBuffer(4096 + 8);
    new Uint8Array(heap)[4100] = 1;
    expect(touchedBytes(heap)).toBe(4096);
  });
});

describe('stage4TestSignal', () => {
  it('is deterministic, finite, bounded and different per channel', () => {
    const a = stage4TestSignal(44_100);
    const b = stage4TestSignal(44_100);
    expect(maxAbsDifference(a, b)).toBe(0);
    expect(a.every(Number.isFinite)).toBe(true);
    expect(Math.max(...a.map(Math.abs))).toBeLessThan(1);
    expect(maxAbsDifference(a.subarray(0, 44_100), a.subarray(44_100))).toBeGreaterThan(0.01);
  });
});

describe('maxAbsDifference', () => {
  it('reports the largest gap and Infinity for a length mismatch', () => {
    expect(maxAbsDifference([1, 2, 3], [1, 2.5, 3])).toBe(0.5);
    expect(maxAbsDifference([1], [1, 2])).toBe(Infinity);
  });
});

describe('stage4Threads', () => {
  const isolated = { crossOriginIsolated: true, hardwareConcurrency: 4 };

  it('uses the requested count on an isolated page with enough cores', () => {
    for (const t of STAGE4_THREAD_OPTIONS) expect(stage4Threads(t, isolated)).toBe(t);
  });

  it('falls back to one thread without cross-origin isolation (no SharedArrayBuffer)', () => {
    expect(stage4Threads(4, { crossOriginIsolated: false, hardwareConcurrency: 8 })).toBe(1);
  });

  it('never asks for more threads than the reported cores', () => {
    expect(stage4Threads(4, { crossOriginIsolated: true, hardwareConcurrency: 2 })).toBe(2);
    expect(stage4Threads(4, { crossOriginIsolated: true, hardwareConcurrency: 2.5 })).toBe(2);
    expect(stage4Threads(4, { crossOriginIsolated: true })).toBe(4); // unknown core count: no cap
    expect(stage4Threads(4, { crossOriginIsolated: true, hardwareConcurrency: 0 })).toBe(4);
  });

  it('treats invalid requests as one thread and rounds fractions down', () => {
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) expect(stage4Threads(bad, isolated)).toBe(1);
    expect(stage4Threads(2.9, isolated)).toBe(2);
  });

  it('offers only counts that start from one and stay within a phone', () => {
    expect(STAGE4_THREAD_OPTIONS[0]).toBe(1);
    expect(Math.max(...STAGE4_THREAD_OPTIONS)).toBeLessThanOrEqual(4);
  });
});
