import { describe, expect, it } from 'vitest';
import type { CapabilitySnapshot, RouteRequest } from '../src/index.ts';
import { HTDEMUCS_6S_UPSTREAM, REASON_COPY, classifyUserAgent, decideRoute, normaliseDeviceMemory } from '../src/index.ts';

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
  it('runs capable desktop WebGPU jobs on device', () => {
    const d = decideRoute(base());
    expect(d.target).toBe('device');
    if (d.target !== 'device') return;
    expect(d.ep).toBe('webgpu');
    expect(d.reasons).toEqual(['eligible_webgpu']);
    expect(d.warnings).toContain('lower_fidelity_than_server');
    expect(d.warnings).toContain('memory_numbers_are_estimates');
  });

  it('always offloads phones, even when the user prefers the device', () => {
    const d = decideRoute(base({ caps: iphone, preference: 'prefer-device' }));
    expect(d.target).toBe('server');
    expect(d.reasons).toContain('phone_form_factor');
  });

  it('offloads iPad (WebKit, no deviceMemory) and flags the memory projection', () => {
    const d = decideRoute(base({ caps: { ...iphone, formFactor: 'tablet' } }));
    expect(d.target).toBe('server');
    expect(d.reasons).toEqual(expect.arrayContaining(['device_memory_unknown_mobile', 'memory_projection_exceeds_ceiling']));
  });

  it('offloads an 8 GiB Android tablet with WebGPU on the measured memory budget alone', () => {
    const tablet = { ...desktop, formFactor: 'tablet' as const, deviceMemoryGiB: 8 };
    const d = decideRoute(base({ caps: tablet }));
    expect(d.target).toBe('server');
    expect(d.reasons).toEqual(['memory_projection_exceeds_ceiling']);
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

  it('applies the 90 s WebGPU cap and 30 s WASM cap', () => {
    expect(decideRoute(base({ input: { durationSec: 91, bytes: 1e6 } })).reasons).toContain('duration_over_local_cap');
    const noGpu = { ...desktop, webgpu: { ...desktop.webgpu, available: false } };
    const wasmOk = decideRoute(base({ caps: noGpu, input: { durationSec: 30, bytes: 1e6 } }));
    expect(wasmOk.target).toBe('device');
    if (wasmOk.target === 'device') {
      expect(wasmOk.ep).toBe('wasm');
      expect(wasmOk.warnings).toContain('wasm_slow_path');
    }
    expect(decideRoute(base({ caps: noGpu, input: { durationSec: 31, bytes: 1e6 } })).reasons).toContain('duration_over_local_cap');
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
    expect(decideRoute(base({ caps: { ...iphone, online: false } })).warnings).toContain('offline_server_job_queued');
  });

  it('has user-facing copy for every reason', () => {
    for (const v of Object.values(REASON_COPY)) expect(v.length).toBeGreaterThan(10);
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
