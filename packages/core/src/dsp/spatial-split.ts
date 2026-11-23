/**
 * `spatial-similarity-v0` — a labelled DSP heuristic for lead/rhythm guitar.
 *
 * This is NOT an ML separator. It fills the lead/rhythm slot until an openly
 * licensed model exists (see GUITAR_LEAD_RHYTHM_ML in the registry).
 *
 * Premise (common mixing practice, not a law): rhythm guitars are double-tracked
 * and panned wide, so L/R are decorrelated; lead guitar is a single take near
 * centre, so L/R are coherent. We use the Avendano–Jot inter-channel similarity
 *
 *     ψ(k,t) = 2·|Φ_LR| / (Φ_LL + Φ_RR),   Φ smoothed recursively over frames,
 *
 * (Φ also pooled over ±2 neighbouring bins), which is 1 for a centre-panned mono source and → 0 for hard-panned or
 * decorrelated content. The centre mask is m = ψ^γ.
 *
 * Packing trick: Z = X_L + i·X_R is the FFT of (l + i·r). Because m is real and
 * conjugate-symmetric, the masked stereo pair is IFFT(m·Z) — one forward and one
 * inverse FFT per frame for both channels. Rhythm = input − lead in the time
 * domain, so lead + rhythm reconstructs the guitar stem exactly (mixture
 * consistency by construction).
 *
 * Failure modes: mono guitar mixes (everything → lead), centre-panned rhythm,
 * stereo-chorused leads (leak to rhythm). The UI must label the result.
 */
import { FFT, hannWindow } from './fft.ts';

export interface SpatialSplitOptions {
  readonly fftSize?: number;
  readonly hopSize?: number;
  /** Recursive smoothing factor for cross-spectra, 0 ≤ α < 1. */
  readonly smoothing?: number;
  /** Half-width (bins) of frequency pooling for the cross-spectra. */
  readonly bandRadius?: number;
  /** Mask exponent γ; higher → stricter "centre" criterion. */
  readonly exponent?: number;
}

export interface StereoPlanar {
  readonly left: Float32Array;
  readonly right: Float32Array;
}

export interface SpatialSplitResult {
  readonly lead: StereoPlanar;
  readonly rhythm: StereoPlanar;
  readonly algorithm: 'spatial-similarity-v0';
}

export function spatialLeadRhythmSplit(input: StereoPlanar, options: SpatialSplitOptions = {}): SpatialSplitResult {
  const n = options.fftSize ?? 4096;
  const hop = options.hopSize ?? n / 4;
  const alpha = options.smoothing ?? 0.8;
  const bandRadius = options.bandRadius ?? 2;
  const gamma = options.exponent ?? 2;
  const { left, right } = input;
  if (left.length !== right.length) throw new RangeError('left/right length mismatch');
  if (!Number.isInteger(hop) || hop < 1 || hop > n / 2) throw new RangeError('hopSize must be an integer in [1, fftSize/2]');
  if (!(alpha >= 0 && alpha < 1)) throw new RangeError('smoothing must be in [0, 1)');

  const frames = left.length;
  const fft = new FFT(n);
  const win = hannWindow(n);
  const pad = n - hop;
  const paddedLen = frames + 2 * pad;
  const leadL = new Float64Array(paddedLen);
  const leadR = new Float64Array(paddedLen);
  const wsum = new Float64Array(paddedLen);

  const half = n >> 1;
  const phiLL = new Float64Array(half + 1);
  const phiRR = new Float64Array(half + 1);
  const phiLRre = new Float64Array(half + 1);
  const phiLRim = new Float64Array(half + 1);
  const mask = new Float64Array(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  for (let start = 0; start + n <= paddedLen; start += hop) {
    for (let k = 0; k < n; k++) {
      const src = start + k - pad;
      const inRange = src >= 0 && src < frames;
      re[k] = inRange ? left[src]! * win[k]! : 0;
      im[k] = inRange ? right[src]! * win[k]! : 0;
    }
    fft.forward(re, im);

    for (let k = 0; k <= half; k++) {
      const j = (n - k) % n;
      // Unpack the two real spectra from Z.
      const lr = 0.5 * (re[k]! + re[j]!);
      const li = 0.5 * (im[k]! - im[j]!);
      const rr = 0.5 * (im[k]! + im[j]!);
      const ri = -0.5 * (re[k]! - re[j]!);
      phiLL[k] = alpha * phiLL[k]! + (1 - alpha) * (lr * lr + li * li);
      phiRR[k] = alpha * phiRR[k]! + (1 - alpha) * (rr * rr + ri * ri);
      // L · conj(R)
      phiLRre[k] = alpha * phiLRre[k]! + (1 - alpha) * (lr * rr + li * ri);
      phiLRim[k] = alpha * phiLRim[k]! + (1 - alpha) * (li * rr - lr * ri);
    }
    // Pool cross-spectra over ±bandRadius bins: raises the effective number of
    // averages without smearing transients in time (coherence of independent
    // noise is biased upward roughly as 1/√K for K averages).
    for (let k = 0; k <= half; k++) {
      let sLL = 0;
      let sRR = 0;
      let sRe = 0;
      let sIm = 0;
      const lo = Math.max(0, k - bandRadius);
      const hi = Math.min(half, k + bandRadius);
      for (let b = lo; b <= hi; b++) {
        sLL += phiLL[b]!;
        sRR += phiRR[b]!;
        sRe += phiLRre[b]!;
        sIm += phiLRim[b]!;
      }
      const denom = sLL + sRR;
      const psi = denom > 1e-20 ? (2 * Math.hypot(sRe, sIm)) / denom : 0;
      const m = Math.pow(Math.min(1, psi), gamma);
      mask[k] = m;
      mask[(n - k) % n] = m;
    }
    for (let k = 0; k < n; k++) {
      re[k]! *= mask[k]!;
      im[k]! *= mask[k]!;
    }
    fft.inverse(re, im);
    for (let k = 0; k < n; k++) {
      const w = win[k]!;
      leadL[start + k]! += re[k]! * w;
      leadR[start + k]! += im[k]! * w;
      wsum[start + k]! += w * w;
    }
  }

  const outLeadL = new Float32Array(frames);
  const outLeadR = new Float32Array(frames);
  const outRhyL = new Float32Array(frames);
  const outRhyR = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const w = wsum[i + pad]!;
    const l = w > 1e-12 ? leadL[i + pad]! / w : 0;
    const r = w > 1e-12 ? leadR[i + pad]! / w : 0;
    outLeadL[i] = l;
    outLeadR[i] = r;
    outRhyL[i] = left[i]! - l;
    outRhyR[i] = right[i]! - r;
  }
  return {
    lead: { left: outLeadL, right: outLeadR },
    rhythm: { left: outRhyL, right: outRhyR },
    algorithm: 'spatial-similarity-v0',
  };
}
