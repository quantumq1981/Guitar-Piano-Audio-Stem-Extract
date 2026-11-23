import { describe, expect, it } from 'vitest';
import { WAV_HEADER_BYTES, decodeWav, encodePcmBlock, encodeWav, encodeWavHeader } from '../src/codec/wav.ts';
import { maxAbsDiff, noise } from './helpers.ts';

describe('WAV codec', () => {
  const l = noise(1234, 11, 0.9);
  const r = noise(1234, 12, 0.9);

  it.each([
    ['pcm16', 1 / 32768],
    ['pcm24', 1 / 8_388_608],
    ['float32', 0],
  ] as const)('round-trips %s within one LSB', (sampleFormat, lsb) => {
    const bytes = encodeWav([l, r], { sampleRate: 44100, channels: 2, sampleFormat });
    const dec = decodeWav(bytes);
    expect(dec.format).toEqual({ sampleRate: 44100, channels: 2, sampleFormat });
    expect(dec.channels[0]!.length).toBe(1234);
    expect(maxAbsDiff(dec.channels[0]!, l)).toBeLessThanOrEqual(lsb);
    expect(maxAbsDiff(dec.channels[1]!, r)).toBeLessThanOrEqual(lsb);
  });

  it('writes a canonical 44-byte header', () => {
    const h = encodeWavHeader(100, { sampleRate: 48000, channels: 2, sampleFormat: 'pcm24' });
    const v = new DataView(h.buffer);
    expect(h.length).toBe(WAV_HEADER_BYTES);
    expect(v.getUint32(4, true)).toBe(36 + 600);
    expect(v.getUint32(28, true)).toBe(48000 * 6);
    expect(v.getUint16(34, true)).toBe(24);
    expect(v.getUint32(40, true)).toBe(600);
  });

  it('saturates out-of-range and non-finite samples', () => {
    const block = encodePcmBlock([new Float32Array([2, -2, Number.NaN, 1, -1])], 'pcm16');
    const v = new DataView(block.buffer);
    expect([0, 2, 4, 6, 8].map((o) => v.getInt16(o, true))).toEqual([32767, -32768, 0, 32767, -32768]);
  });

  it('rejects >4 GiB data and invalid formats', () => {
    expect(() => encodeWavHeader(2 ** 30, { sampleRate: 44100, channels: 2, sampleFormat: 'float32' })).toThrow(/4 GiB/);
    expect(() => encodeWavHeader(10, { sampleRate: 100, channels: 2, sampleFormat: 'pcm16' })).toThrow(/sample rate/);
    expect(() => decodeWav(new Uint8Array(20))).toThrow(/RIFF/);
  });

  it('skips unknown and odd-sized chunks and parses WAVE_FORMAT_EXTENSIBLE', () => {
    const pcm = encodePcmBlock([new Float32Array([0.5, -0.5])], 'pcm16');
    const parts: number[] = [];
    const push32 = (n: number) => parts.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
    const push16 = (n: number) => parts.push(n & 255, (n >> 8) & 255);
    const ascii = (s: string) => [...s].forEach((c) => parts.push(c.charCodeAt(0)));
    ascii('RIFF');
    push32(0);
    ascii('WAVE');
    ascii('LIST');
    push32(3);
    parts.push(1, 2, 3, 0); // odd chunk + pad byte
    ascii('fmt ');
    push32(40);
    push16(0xfffe);
    push16(1);
    push32(44100);
    push32(88200);
    push16(2);
    push16(16);
    push16(22);
    push16(16);
    push32(0);
    push16(1); // sub-format PCM
    for (let i = 0; i < 14; i++) parts.push(0);
    ascii('data');
    push32(pcm.length);
    parts.push(...pcm);
    const dec = decodeWav(new Uint8Array(parts));
    expect(dec.format.sampleFormat).toBe('pcm16');
    expect(Array.from(dec.channels[0]!)).toEqual([0.5, -0.5]);
  });
});
