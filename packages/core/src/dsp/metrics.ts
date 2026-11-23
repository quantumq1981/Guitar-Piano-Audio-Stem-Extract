/**
 * Objective comparison metrics used for cross-tier parity tests.
 *
 * Byte-identical output across EPs is not achievable (kernel fusion, FMA and
 * reduction order differ between CPU, WASM-SIMD and WebGPU). The parity contract
 * is therefore numeric: per-stem SNR of tier output vs. the server reference.
 */

/** Signal-to-noise ratio of `estimate` against `reference`, in dB. +Infinity when identical. */
export function snrDb(reference: Float32Array, estimate: Float32Array): number {
  if (reference.length !== estimate.length) throw new RangeError('length mismatch');
  let sig = 0;
  let err = 0;
  for (let i = 0; i < reference.length; i++) {
    const r = reference[i]!;
    const d = r - estimate[i]!;
    sig += r * r;
    err += d * d;
  }
  if (err === 0) return Number.POSITIVE_INFINITY;
  if (sig === 0) return Number.NEGATIVE_INFINITY;
  return 10 * Math.log10(sig / err);
}

/** Scale-invariant SDR (Le Roux et al., 2019), in dB. */
export function siSdrDb(reference: Float32Array, estimate: Float32Array): number {
  if (reference.length !== estimate.length) throw new RangeError('length mismatch');
  let dot = 0;
  let refEnergy = 0;
  for (let i = 0; i < reference.length; i++) {
    dot += reference[i]! * estimate[i]!;
    refEnergy += reference[i]! * reference[i]!;
  }
  if (refEnergy === 0) return Number.NEGATIVE_INFINITY;
  const alpha = dot / refEnergy;
  let target = 0;
  let noise = 0;
  for (let i = 0; i < reference.length; i++) {
    const t = alpha * reference[i]!;
    const e = estimate[i]! - t;
    target += t * t;
    noise += e * e;
  }
  if (noise === 0) return Number.POSITIVE_INFINITY;
  return 10 * Math.log10(target / noise);
}

export function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return x.length === 0 ? 0 : Math.sqrt(s / x.length);
}

export function rmsDbfs(x: Float32Array): number {
  const r = rms(x);
  return r === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(r);
}

/** Minimum SNR (dB) a non-reference tier must reach per stem to be considered "the same model output". */
export const PARITY_MIN_SNR_DB = 40;
