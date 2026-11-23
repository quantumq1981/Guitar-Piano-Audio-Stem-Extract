import { describe, expect, it } from 'vitest';
import { spatialLeadRhythmSplit } from '../src/dsp/spatial-split.ts';
import { rms } from '../src/dsp/metrics.ts';
import { maxAbsDiff, noise } from './helpers.ts';

const frames = 44100;

function sine(freq: number, amp: number): Float32Array {
  return Float32Array.from({ length: frames }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / 44100));
}

describe('spatial-similarity-v0 lead/rhythm split', () => {
  it('is mixture-consistent: lead + rhythm == input', () => {
    const left = noise(frames, 1);
    const right = noise(frames, 2);
    const { lead, rhythm } = spatialLeadRhythmSplit({ left, right });
    const sumL = lead.left.map((v, i) => v + rhythm.left[i]!);
    expect(maxAbsDiff(sumL, left)).toBeLessThan(1e-6);
  });

  it('routes a centre-panned mono source to lead', () => {
    const s = sine(440, 0.5);
    const { lead, rhythm } = spatialLeadRhythmSplit({ left: s, right: new Float32Array(s) });
    expect(rms(lead.left) / rms(s)).toBeGreaterThan(0.99);
    expect(rms(rhythm.left) / rms(s)).toBeLessThan(0.02);
  });

  it('routes decorrelated wide (double-tracked) content to rhythm', () => {
    const left = noise(frames, 5, 0.3);
    const right = noise(frames, 6, 0.3);
    const { lead, rhythm } = spatialLeadRhythmSplit({ left, right });
    expect(rms(rhythm.left)).toBeGreaterThan(3 * rms(lead.left));
  });

  it('separates a centred lead from a wide rhythm bed', () => {
    const leadSrc = sine(660, 0.3);
    const bedL = noise(frames, 21, 0.2);
    const bedR = noise(frames, 22, 0.2);
    const left = leadSrc.map((v, i) => v + bedL[i]!);
    const right = leadSrc.map((v, i) => v + bedR[i]!);
    const { lead } = spatialLeadRhythmSplit({ left, right });
    // Correlation of extracted lead with the true lead should be high.
    let dot = 0;
    let a = 0;
    let b = 0;
    for (let i = 4096; i < frames - 4096; i++) {
      dot += lead.left[i]! * leadSrc[i]!;
      a += lead.left[i]! ** 2;
      b += leadSrc[i]! ** 2;
    }
    expect(dot / Math.sqrt(a * b)).toBeGreaterThan(0.8);
  });

  it('validates parameters', () => {
    const x = new Float32Array(10);
    expect(() => spatialLeadRhythmSplit({ left: x, right: new Float32Array(11) })).toThrow(RangeError);
    expect(() => spatialLeadRhythmSplit({ left: x, right: x }, { hopSize: 4096 })).toThrow(RangeError);
    expect(() => spatialLeadRhythmSplit({ left: x, right: x }, { smoothing: 1 })).toThrow(RangeError);
  });
});
