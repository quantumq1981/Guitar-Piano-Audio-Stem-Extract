import { describe, expect, it } from 'vitest';
import type { CapabilitySnapshot, RouteRequest } from '../src/index.ts';
import {
  DISK_RUN_DECODE_COPIES,
  HTDEMUCS_6S_FOLDED,
  HTDEMUCS_6S_UPSTREAM,
  LOCAL_LIMITS,
  PLATFORM_CEILINGS,
  PRIMARY_SEPARATION_MODEL,
  REASON_COPY,
  classifyUserAgent,
  decideRoute,
  deviceOutputs,
  deviceThreads,
  estimateDeviceSeconds,
  downloadBytes,
  normaliseDeviceMemory,
  projectDiskRunPeak,
  runStorageNeed,
} from '../src/index.ts';

const desktop: CapabilitySnapshot = {
  formFactor: 'desktop',
  engine: 'blink',
  isAppleMobile: false,
  deviceMemoryGiB: 8,
  hardwareConcurrency: 8,
  webgpu: { available: true, maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 30, isFallbackAdapter: false },
  crossOriginIsolated: true,
  battery: { level: 0.9, charging: true },
  crashFlag: false,
  online: true,
  storageAvailableBytes: 10 * 2 ** 30,
  modelCached: true,
  opfsWritable: true,
};

const iphone: CapabilitySnapshot = {
  ...desktop,
  formFactor: 'phone',
  engine: 'webkit',
  isAppleMobile: true,
  deviceMemoryGiB: null,
  battery: null,
};

const base = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  caps: desktop,
  input: { durationSec: 60, bytes: 5e6 },
  scope: 'full',
  options: { refinePiano: false },
  preference: 'auto',
  ...over,
});

describe('decideRoute', () => {
  it('runs capable desktop WebGPU jobs on device (WebGPU-placeable artifact)', () => {
    const d = decideRoute(base({ model: HTDEMUCS_6S_FOLDED }));
    expect(d.target).toBe('device');
    if (d.target !== 'device') return;
    expect(d.ep).toBe('webgpu');
    expect(d.reasons).toEqual(['eligible_webgpu']);
    expect(d.warnings).toContain('lower_fidelity_than_server');
    expect(d.warnings).toContain('memory_numbers_are_estimates');
  });

  it('runs the primary (Stage IV) on WASM even where WebGPU is available, since it cannot be placed there', () => {
    expect(PRIMARY_SEPARATION_MODEL.epSupport.webgpu).toBe('unsupported');
    const d = decideRoute(base());
    expect(d.target).toBe('device');
    if (d.target !== 'device') return;
    expect(d.ep).toBe('wasm');
    expect(d.reasons).toEqual(['eligible_wasm']);
  });

  it('budgets storage and memory on the graph plus its external data', () => {
    const total = downloadBytes(PRIMARY_SEPARATION_MODEL)!;
    expect(total).toBe(PRIMARY_SEPARATION_MODEL.bytes! + PRIMARY_SEPARATION_MODEL.externalData!.bytes);
    const tight = decideRoute(base({ caps: { ...desktop, modelCached: false, storageAvailableBytes: total * 1.4 } }));
    expect(tight.reasons).toContain('insufficient_storage_for_model');
    const roomy = decideRoute(base({ caps: { ...desktop, modelCached: false, storageAvailableBytes: total * 1.6 } }));
    expect(roomy.target).toBe('device');
  });

  it('runs a phone on device on the disk path when the evidence holds (measured heap, writable OPFS, isolation)', () => {
    const d = decideRoute(base({ caps: iphone, input: { durationSec: 240, bytes: 8e6 } }));
    expect(d.target).toBe('device');
    if (d.target !== 'device') return;
    expect(d).toMatchObject({ storage: 'disk', ep: 'wasm', threads: 1, reasons: ['eligible_wasm'] });
    expect(d.memory.kind).toBe('disk');
  });

  it("takes the disk path on the owner's iPhone too, whose desktop-class UA classifies as a tablet", () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15';
    const caps = { ...iphone, ...classifyUserAgent(ua, 5, null) };
    expect(caps.formFactor).toBe('tablet');
    const d = decideRoute(base({ caps }));
    expect(d.target === 'device' && d.storage).toBe('disk');
  });

  it('runs an 8 GiB Android tablet with WebGPU on the WASM disk path (the validated build)', () => {
    const tablet = { ...desktop, formFactor: 'tablet' as const, deviceMemoryGiB: 8 };
    const d = decideRoute(base({ caps: tablet }));
    expect(d.target === 'device' && [d.storage, d.ep]).toEqual(['disk', 'wasm']);
  });

  it('keeps phones on the server when the window cannot store files (Safari Private Browsing)', () => {
    for (const opfsWritable of [false, null]) {
      const d = decideRoute(base({ caps: { ...iphone, opfsWritable }, preference: 'prefer-device' }));
      expect(d.target).toBe('server');
      expect(d.reasons).toContain('storage_not_writable');
    }
  });

  it('keeps phones on the server for a model without a measured mobile profile', () => {
    const d = decideRoute(base({ caps: iphone, model: HTDEMUCS_6S_FOLDED }));
    expect(d.target).toBe('server');
    expect(d.reasons).toContain('mobile_profile_unmeasured');
  });

  it('applies the mobile duration cap', () => {
    const cap = LOCAL_LIMITS.maxDurationSecMobile;
    expect(decideRoute(base({ caps: iphone, input: { durationSec: cap, bytes: 20e6 } })).target).toBe('device');
    expect(decideRoute(base({ caps: iphone, input: { durationSec: cap + 1, bytes: 20e6 } })).reasons).toContain('duration_over_local_cap');
  });

  it('checks storage for the projected stems plus the stored song, so a quick scope needs less', () => {
    const frames = 300 * 44_100;
    const fmt = { sampleRate: 44_100, channels: 2, sampleFormat: 'pcm24' } as const;
    const full = runStorageNeed(frames, deviceOutputs('full').length, fmt).total;
    const quick = runStorageNeed(frames, deviceOutputs('quick').length, fmt).total;
    expect(deviceOutputs('quick')).toEqual(['vocals', 'drums', 'bass', 'other']);
    expect(quick).toBeLessThan(full);
    const caps = { ...iphone, storageAvailableBytes: (quick + full) / 2 * 1.1 };
    const input = { durationSec: 300, bytes: 10e6 };
    expect(decideRoute(base({ caps, input, scope: 'full' })).reasons).toContain('insufficient_storage_for_stems');
    expect(decideRoute(base({ caps, input, scope: 'quick' })).target).toBe('device');
  });

  it('does not lock phones out after a killed run (it resumes), but still guards the in-memory desktop path', () => {
    expect(decideRoute(base({ caps: { ...iphone, crashFlag: true } })).target).toBe('device');
    expect(decideRoute(base({ caps: { ...desktop, crashFlag: true } })).reasons).toContain('crash_flag');
  });

  it('offloads phones reporting 2 GiB or less, but not 4 GiB', () => {
    const android = { ...desktop, formFactor: 'phone' as const };
    expect(decideRoute(base({ caps: { ...android, deviceMemoryGiB: 2 } })).reasons).toContain('device_memory_low');
    expect(decideRoute(base({ caps: { ...android, deviceMemoryGiB: 4 } })).target).toBe('device');
  });

  it('offloads ≤ 4 GiB devices', () => {
    const d = decideRoute(base({ caps: { ...desktop, deviceMemoryGiB: 4 } }));
    expect(d.reasons).toContain('device_memory_low');
  });

  it('honours crash flag, low battery and forced-server preference', () => {
    expect(decideRoute(base({ caps: { ...desktop, crashFlag: true } })).reasons).toContain('crash_flag');
    expect(decideRoute(base({ caps: { ...desktop, battery: { level: 0.1, charging: false } } })).reasons).toContain('battery_low');
    expect(decideRoute(base({ caps: { ...desktop, battery: { level: 0.1, charging: true } } })).target).toBe('device');
    expect(decideRoute(base({ preference: 'force-server' })).reasons).toContain('user_forced_server');
  });

  it('keeps lead/rhythm and piano refinement server-only', () => {
    expect(decideRoute(base({ scope: 'guitar' })).reasons).toContain('scope_server_only');
    expect(decideRoute(base({ options: { refinePiano: true } })).reasons).toContain('scope_server_only');
    expect(decideRoute(base({ scope: 'quick' })).target).toBe('device');
  });

  it('applies the 90 s local cap on WebGPU and on threaded WASM', () => {
    expect(decideRoute(base({ model: HTDEMUCS_6S_FOLDED, input: { durationSec: 91, bytes: 1e6 } })).reasons).toContain('duration_over_local_cap');
    const noGpu = { ...desktop, webgpu: { ...desktop.webgpu, available: false } };
    const wasmOk = decideRoute(base({ caps: noGpu, input: { durationSec: 90, bytes: 1e6 } }));
    expect(wasmOk.target).toBe('device');
    if (wasmOk.target === 'device') {
      expect(wasmOk.ep).toBe('wasm');
      expect(wasmOk.warnings).toContain('wasm_slow_path');
    }
    expect(decideRoute(base({ caps: noGpu, input: { durationSec: 91, bytes: 1e6 } })).reasons).toContain('duration_over_local_cap');
  });

  it('treats a software fallback adapter as no WebGPU, and refuses unthreaded WASM', () => {
    const fallback = { ...desktop, crossOriginIsolated: false, webgpu: { ...desktop.webgpu, isFallbackAdapter: true } };
    expect(decideRoute(base({ caps: fallback, input: { durationSec: 10, bytes: 1e6 } })).reasons).toContain('no_webgpu_wasm_unthreaded');
  });

  it('refuses models that are not browser-eligible (one-file-everywhere rule)', () => {
    expect(decideRoute(base({ model: HTDEMUCS_6S_UPSTREAM })).reasons).toContain('model_not_browser_eligible');
  });

  it('requires storage headroom when the model is not cached yet', () => {
    const d = decideRoute(base({ caps: { ...desktop, modelCached: false, storageAvailableBytes: 100e6 } }));
    expect(d.reasons).toContain('insufficient_storage_for_model');
  });

  it('flags inputs that exceed server limits too', () => {
    const d = decideRoute(base({ input: { durationSec: 382, bytes: 5e6 } }));
    expect(d.target).toBe('server');
    if (d.target === 'server') expect(d.rejected).toBe('too_long');
  });

  it('warns that offline server jobs will be queued', () => {
    expect(decideRoute(base({ caps: { ...iphone, online: false }, preference: 'force-server' })).warnings).toContain('offline_server_job_queued');
  });

  it('has user-facing copy for every reason', () => {
    for (const v of Object.values(REASON_COPY)) expect(v.length).toBeGreaterThan(10);
  });
});

describe('disk-run memory projection', () => {
  it('is flat in song length during separation and stays under the iOS ceiling at the mobile cap', () => {
    const model = PRIMARY_SEPARATION_MODEL;
    const short = projectDiskRunPeak({ model, inputFrames: 44_100 * 30, compressedBytes: 1e6 })!;
    const long = projectDiskRunPeak({ model, inputFrames: 44_100 * LOCAL_LIMITS.maxDurationSecMobile, compressedBytes: 20e6 })!;
    expect(long.inferencePeakBytes).toBe(short.inferencePeakBytes);
    expect(short.inferencePeakBytes).toBeGreaterThan(model.browserHeapBytes!);
    expect(long.decodePeakBytes).toBe(20e6 + DISK_RUN_DECODE_COPIES.value * 44_100 * LOCAL_LIMITS.maxDurationSecMobile * 2 * 4);
    expect(long.projectedPeakBytes).toBe(Math.max(long.decodePeakBytes, long.inferencePeakBytes));
    expect(long.projectedPeakBytes).toBeLessThanOrEqual(PLATFORM_CEILINGS['ios-safari'].abortAboveBytes.value);
    expect(long.hasEstimates).toBe(true); // the resampler allowance
  });

  it('has no projection for a model without a measured browser heap', () => {
    expect(projectDiskRunPeak({ model: HTDEMUCS_6S_FOLDED, inputFrames: 1000, compressedBytes: 0 })).toBeNull();
  });
});

describe('deviceThreads', () => {
  it('uses one thread on phones and tablets until the iPhone thread test is measured, up to 4 on desktop', () => {
    expect(deviceThreads({ formFactor: 'phone', crossOriginIsolated: true, hardwareConcurrency: 6 })).toBe(1);
    expect(deviceThreads({ formFactor: 'tablet', crossOriginIsolated: true, hardwareConcurrency: 8 })).toBe(1);
    expect(deviceThreads({ formFactor: 'desktop', crossOriginIsolated: true, hardwareConcurrency: 8 })).toBe(4);
    expect(deviceThreads({ formFactor: 'desktop', crossOriginIsolated: true, hardwareConcurrency: 2 })).toBe(2);
    expect(deviceThreads({ formFactor: 'desktop', crossOriginIsolated: false, hardwareConcurrency: 8 })).toBe(1);
    expect(deviceThreads({ formFactor: 'desktop', crossOriginIsolated: true, hardwareConcurrency: null })).toBe(2);
  });
});

describe('estimateDeviceSeconds', () => {
  const io = PRIMARY_SEPARATION_MODEL.io!;
  it('multiplies the measured seconds per window by the window count', () => {
    // 43.2 s → 8 windows (the first full iPhone song); 4 min → 41 windows.
    expect(estimateDeviceSeconds(43.2, 1, 'tablet', io.segmentFrames, io.sampleRate)).toBeCloseTo(8 * 12.5, 6);
    expect(estimateDeviceSeconds(240, 1, 'phone', io.segmentFrames, io.sampleRate)).toBeCloseTo(41 * 12.5, 6);
    expect(estimateDeviceSeconds(240, 4, 'desktop', io.segmentFrames, io.sampleRate)).toBeCloseTo(41 * 5.7, 6);
  });
  it('returns null for an unmeasured thread count or an unknown duration', () => {
    expect(estimateDeviceSeconds(60, 4, 'phone', io.segmentFrames, io.sampleRate)).toBeNull();
    expect(estimateDeviceSeconds(0, 1, 'phone', io.segmentFrames, io.sampleRate)).toBeNull();
    expect(estimateDeviceSeconds(Number.NaN, 1, 'phone', io.segmentFrames, io.sampleRate)).toBeNull();
  });
});

describe('capability helpers', () => {
  it('normalises deviceMemory', () => {
    expect(normaliseDeviceMemory(undefined)).toBeNull();
    expect(normaliseDeviceMemory(0)).toBeNull();
    expect(normaliseDeviceMemory(Number.NaN)).toBeNull();
    expect(normaliseDeviceMemory(16)).toBe(8);
    expect(normaliseDeviceMemory(4)).toBe(4);
  });

  it('classifies user agents, including iPadOS desktop-mode UAs', () => {
    const ipadDesktopUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
    expect(classifyUserAgent(ipadDesktopUa, 5, null)).toEqual({ formFactor: 'tablet', engine: 'webkit', isAppleMobile: true });
    expect(classifyUserAgent(ipadDesktopUa, 0, null)).toEqual({ formFactor: 'desktop', engine: 'webkit', isAppleMobile: false });
    const pixel = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
    expect(classifyUserAgent(pixel, 5, true)).toMatchObject({ formFactor: 'phone', engine: 'blink' });
    const iphoneChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1';
    expect(classifyUserAgent(iphoneChrome, 5, null)).toMatchObject({ formFactor: 'phone', engine: 'webkit', isAppleMobile: true });
    const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0';
    expect(classifyUserAgent(firefox, 0, false)).toMatchObject({ formFactor: 'desktop', engine: 'gecko' });
  });
});
