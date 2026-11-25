import { describe, expect, it } from 'vitest';
import { PARITY_MAX_ERROR_DB_RE_MIX, PARITY_MIN_SNR_DB, stemEnergies, stemParity } from '../src/index.ts';

/** Energies for a stem `levelDb` re mix whose error is `snrDb` below the stem (mix energy 1). */
const at = (levelDb: number, snrDb: number) => {
  const reference = 10 ** (levelDb / 10);
  return { reference, error: reference / 10 ** (snrDb / 10), mix: 1 };
};

describe('stemParity (level-aware parity contract)', () => {
  it('passes on SNR alone at or above the threshold', () => {
    expect(stemParity(at(-5, PARITY_MIN_SNR_DB))).toMatchObject({ pass: true, by: 'snr' });
    expect(stemParity(at(-5, 53.1))).toMatchObject({ pass: true, by: 'snr' });
  });

  it('passes the measured near-silent stems by error level', () => {
    // fp32 → fp16w, Feel Like Makin' Love, piano: 39.3 dB at −63.5 dB re mix (error −102.8 dB re mix).
    const v = stemParity(at(-63.5, 39.3));
    expect(v).toMatchObject({ pass: true, by: 'error-level' });
    expect(v.errorDbReMix).toBeCloseTo(-102.8, 6);
  });

  it('still fails the Stage IV WASM reduction defect (error −61 dB re mix)', () => {
    // Stage III: vocals 24.96 dB SNR; at −36 dB re mix the error is −61 dB re mix.
    const v = stemParity(at(-36, 25));
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.reason).toMatch(/SNR 25\.0 dB < 40/);
  });

  it('fails a loud stem with a large error even though the error is below the mix', () => {
    expect(stemParity(at(-3, 30)).pass).toBe(false); // error −33 dB re mix
  });

  it('applies the error threshold inclusively', () => {
    expect(stemParity(at(-60, 30)).pass).toBe(true); // error exactly −90 dB re mix
    expect(stemParity(at(-59.9, 30)).pass).toBe(false);
    expect(PARITY_MAX_ERROR_DB_RE_MIX).toBe(-90);
  });

  it('judges a silent reference stem by its error alone', () => {
    expect(stemParity({ reference: 0, error: 1e-12, mix: 1 })).toMatchObject({ pass: true, by: 'error-level', snrDb: -Infinity });
    expect(stemParity({ reference: 0, error: 1e-3, mix: 1 }).pass).toBe(false);
  });

  it('treats identical output as a pass, even on a silent mix', () => {
    expect(stemParity({ reference: 0, error: 0, mix: 0 })).toMatchObject({ pass: true, by: 'identical' });
    expect(stemParity({ reference: 1, error: 0, mix: 2 })).toMatchObject({ pass: true, by: 'identical', snrDb: Infinity });
  });

  it('never passes a silent mix with any difference', () => {
    expect(stemParity({ reference: 0, error: 1e-30, mix: 0 }).pass).toBe(false);
  });

  it('fails invalid energies (NaN output) instead of hiding them', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(stemParity({ reference: 1, error: bad, mix: 1 }).pass).toBe(false);
      expect(stemParity({ reference: bad, error: 1e-9, mix: 1 }).pass).toBe(false);
      expect(stemParity({ reference: 1, error: 1e-9, mix: bad }).pass).toBe(false);
    }
  });
});

describe('stemEnergies', () => {
  it('sums reference, difference and mix energies; NaN output propagates', () => {
    const e = stemEnergies(new Float32Array([1, 2]), new Float32Array([1, 3]), new Float32Array([3, 4]));
    expect(e).toEqual({ reference: 5, error: 1, mix: 25 });
    expect(Number.isNaN(stemEnergies(new Float32Array([1]), new Float32Array([Number.NaN]), new Float32Array([1])).error)).toBe(true);
    expect(() => stemEnergies(new Float32Array(2), new Float32Array(3), new Float32Array(2))).toThrow(RangeError);
  });
});
