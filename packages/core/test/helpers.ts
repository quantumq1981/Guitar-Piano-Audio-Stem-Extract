/** Deterministic PRNG (mulberry32) so tests never flake. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function noise(frames: number, seed: number, amp = 0.5): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = (r() * 2 - 1) * amp;
  return out;
}

export function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}
