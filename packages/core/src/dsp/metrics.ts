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

/**
 * Alternative pass for quiet stems (owner-approved 2026-11-25): the difference itself is at least this far below
 * the mix. Per-stem SNR on a near-silent stem measures how quiet the stem is, not model error. Measured on real
 * music: fp16 weights vs fp32 give 39.3 dB SNR on a piano at −63.5 dB re mix, an error of −103.6 dB re mix.
 * Reference points: native vs native ≈ −140 dB; the WASM reduction defect fixed in Stage IV reached −61 dB, which
 * this rule still fails. docs/MOBILE-INFERENCE-DEVELOPMENT.md, "Stage V progress".
 */
export const PARITY_MAX_ERROR_DB_RE_MIX = -90;

/** Energies of one stem over one window: the reference stem, the difference (estimate − reference), and the mix. */
export interface StemEnergies {
  readonly reference: number;
  readonly error: number;
  readonly mix: number;
}

export type ParityVerdict =
  | { readonly pass: true; readonly by: 'identical' | 'snr' | 'error-level'; readonly snrDb: number; readonly errorDbReMix: number }
  | { readonly pass: false; readonly reason: string; readonly snrDb: number; readonly errorDbReMix: number };

const energyDb = (num: number, den: number) => (num === 0 ? Number.NEGATIVE_INFINITY : den === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10(num / den));

/**
 * The per-stem parity contract: pass when SNR ≥ PARITY_MIN_SNR_DB, or when the error is at least
 * |PARITY_MAX_ERROR_DB_RE_MIX| dB below the mix. Works from energies so a silent reference stem (SNR −∞) is judged by
 * its error alone. Non-finite energies (NaN output) always fail; a silent mix passes only an exact match.
 */
export function stemParity(e: StemEnergies): ParityVerdict {
  const snr = energyDb(e.reference, e.error);
  const errorDbReMix = energyDb(e.error, e.mix);
  if (![e.reference, e.error, e.mix].every((v) => Number.isFinite(v) && v >= 0)) {
    return { pass: false, reason: 'non-finite or negative energy (invalid model output)', snrDb: Number.NaN, errorDbReMix: Number.NaN };
  }
  if (e.error === 0) return { pass: true, by: 'identical', snrDb: snr, errorDbReMix };
  if (snr >= PARITY_MIN_SNR_DB) return { pass: true, by: 'snr', snrDb: snr, errorDbReMix };
  if (e.mix > 0 && errorDbReMix <= PARITY_MAX_ERROR_DB_RE_MIX) return { pass: true, by: 'error-level', snrDb: snr, errorDbReMix };
  return {
    pass: false,
    reason: `SNR ${snr.toFixed(1)} dB < ${PARITY_MIN_SNR_DB} and error ${errorDbReMix.toFixed(1)} dB re mix > ${PARITY_MAX_ERROR_DB_RE_MIX}`,
    snrDb: snr,
    errorDbReMix,
  };
}

/** Energies of `estimate` vs `reference` against `mix` (all one stem's samples over the same window). */
export function stemEnergies(reference: Float32Array, estimate: Float32Array, mix: Float32Array): StemEnergies {
  if (reference.length !== estimate.length) throw new RangeError('length mismatch');
  let ref = 0;
  let err = 0;
  for (let i = 0; i < reference.length; i++) {
    const r = reference[i]!;
    const d = estimate[i]! - r;
    ref += r * r;
    err += d * d;
  }
  let m = 0;
  for (let i = 0; i < mix.length; i++) m += mix[i]! * mix[i]!;
  return { reference: ref, error: err, mix: m };
}
