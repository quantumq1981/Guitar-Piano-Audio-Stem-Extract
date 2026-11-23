import { describe, expect, it } from 'vitest';
import { FFT, hannWindow } from '../src/dsp/fft.ts';
import { rng } from './helpers.ts';

describe('FFT', () => {
  it('matches a naive DFT', () => {
    const n = 64;
    const r = rng(3);
    const xr = Float64Array.from({ length: n }, () => r() - 0.5);
    const xi = Float64Array.from({ length: n }, () => r() - 0.5);
    const re = new Float64Array(xr);
    const im = new Float64Array(xi);
    new FFT(n).forward(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += xr[t]! * Math.cos(a) - xi[t]! * Math.sin(a);
        si += xr[t]! * Math.sin(a) + xi[t]! * Math.cos(a);
      }
      expect(re[k]).toBeCloseTo(sr, 9);
      expect(im[k]).toBeCloseTo(si, 9);
    }
  });

  it('inverse undoes forward', () => {
    const n = 4096;
    const r = rng(9);
    const x = Float64Array.from({ length: n }, () => r());
    const re = new Float64Array(x);
    const im = new Float64Array(n);
    const f = new FFT(n);
    f.forward(re, im);
    f.inverse(re, im);
    for (let i = 0; i < n; i += 17) {
      expect(re[i]).toBeCloseTo(x[i]!, 10);
      expect(Math.abs(im[i]!)).toBeLessThan(1e-10);
    }
  });

  it('rejects non-power-of-two sizes', () => {
    expect(() => new FFT(1000)).toThrow(RangeError);
    expect(() => new FFT(1)).toThrow(RangeError);
  });

  it('periodic Hann at 75% overlap sums w² to a constant 1.5', () => {
    const n = 1024;
    const w = hannWindow(n);
    for (let i = 0; i < n / 4; i++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += w[i + (k * n) / 4]! ** 2;
      expect(s).toBeCloseTo(1.5, 10);
    }
  });
});
