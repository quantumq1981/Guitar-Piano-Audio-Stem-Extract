/**
 * In-place iterative radix-2 complex FFT with cached twiddles and bit-reversal.
 * Split real/imag Float64Arrays to avoid object allocation in hot loops.
 */
export class FFT {
  readonly size: number;
  readonly #cos: Float64Array;
  readonly #sin: Float64Array;
  readonly #rev: Uint32Array;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw new RangeError(`FFT size must be a power of two ≥ 2, got ${size}`);
    }
    this.size = size;
    const half = size >> 1;
    this.#cos = new Float64Array(half);
    this.#sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.#cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.#sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    const bits = Math.log2(size);
    this.#rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
      this.#rev[i] = r;
    }
  }

  /** Forward transform (sign −1). */
  forward(re: Float64Array, im: Float64Array): void {
    this.#transform(re, im, false);
  }

  /** Inverse transform, including the 1/N scale. */
  inverse(re: Float64Array, im: Float64Array): void {
    this.#transform(re, im, true);
    const inv = 1 / this.size;
    for (let i = 0; i < this.size; i++) {
      re[i]! *= inv;
      im[i]! *= inv;
    }
  }

  #transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.size;
    if (re.length !== n || im.length !== n) throw new RangeError(`Buffers must have length ${n}`);
    const rev = this.#rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        let t = re[i]!;
        re[i] = re[j]!;
        re[j] = t;
        t = im[i]!;
        im[i] = im[j]!;
        im[j] = t;
      }
    }
    const sign = inverse ? -1 : 1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.#cos[k * step]!;
          const wi = sign * this.#sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a]! += xr;
          im[a]! += xi;
        }
      }
    }
  }
}

/** Periodic Hann window (COLA-friendly for STFT). */
export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}
