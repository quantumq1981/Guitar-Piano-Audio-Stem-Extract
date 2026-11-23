import { describe, expect, it } from 'vitest';
import { resolveGains, sliderToGain } from '../src/audio/mix-logic.ts';

const ch = (over: Partial<{ muted: boolean; soloed: boolean; gain: number }> = {}) => ({ muted: false, soloed: false, gain: 1, ...over });

describe('resolveGains', () => {
  it('plays everything when nothing is soloed or muted', () => {
    expect(resolveGains({ a: ch(), b: ch({ gain: 0.5 }) })).toEqual({ a: 1, b: 0.5 });
  });
  it('solo isolates; mute beats solo', () => {
    expect(resolveGains({ a: ch({ soloed: true }), b: ch(), c: ch({ soloed: true, muted: true }) })).toEqual({ a: 1, b: 0, c: 0 });
  });
  it('clamps invalid gains', () => {
    expect(resolveGains({ a: ch({ gain: 9 }), b: ch({ gain: Number.NaN }), c: ch({ gain: -1 }) })).toEqual({ a: 2, b: 0, c: 0 });
  });
});

describe('sliderToGain', () => {
  it('maps 0 → silence, 0.75 → unity, 1 → 16/9 (+5 dB)', () => {
    expect(sliderToGain(0)).toBe(0);
    expect(sliderToGain(0.75)).toBeCloseTo(1, 12);
    expect(sliderToGain(1)).toBeCloseTo(16 / 9, 12);
    expect(sliderToGain(5)).toBeCloseTo(16 / 9, 12);
  });
});
