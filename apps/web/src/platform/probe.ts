/**
 * Browser capability probe → CapabilitySnapshot. All feature detection lives
 * here; the routing decision itself is the pure `decideRoute()` in core.
 */
import type { CapabilitySnapshot, WebGpuInfo } from '@stemsplit/core';
import { PRIMARY_SEPARATION_MODEL, classifyUserAgent, normaliseDeviceMemory } from '@stemsplit/core';
import { readCrashFlag } from './crash-flag.ts';
import { isModelCached } from './model-cache.ts';

interface NavigatorExtras {
  deviceMemory?: number;
  userAgentData?: { mobile?: boolean };
  getBattery?: () => Promise<{ level: number; charging: boolean }>;
  gpu?: { requestAdapter(opts?: { powerPreference?: string }): Promise<GpuAdapterLike | null> };
}

interface GpuAdapterLike {
  readonly limits: { readonly maxBufferSize: number; readonly maxStorageBufferBindingSize: number };
  readonly info?: { readonly isFallbackAdapter?: boolean };
  readonly isFallbackAdapter?: boolean;
}

async function probeWebGpu(nav: NavigatorExtras): Promise<WebGpuInfo> {
  const none: WebGpuInfo = { available: false, maxBufferSize: null, maxStorageBufferBindingSize: null, isFallbackAdapter: false };
  if (!nav.gpu) return none;
  try {
    const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return none;
    return {
      available: true,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      isFallbackAdapter: Boolean(adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter),
    };
  } catch {
    return none;
  }
}

async function probeBattery(nav: NavigatorExtras): Promise<CapabilitySnapshot['battery']> {
  if (!nav.getBattery) return null; // Safari, Firefox
  try {
    const b = await nav.getBattery();
    return { level: b.level, charging: b.charging };
  } catch {
    return null;
  }
}

async function probeStorage(): Promise<number | null> {
  try {
    const est = await navigator.storage?.estimate();
    if (!est || est.quota === undefined) return null;
    return Math.max(0, est.quota - (est.usage ?? 0));
  } catch {
    return null;
  }
}

export async function gatherCapabilities(): Promise<CapabilitySnapshot> {
  const nav = navigator as Navigator & NavigatorExtras;
  const ua = classifyUserAgent(nav.userAgent, nav.maxTouchPoints ?? 0, nav.userAgentData?.mobile ?? null);
  const [webgpu, battery, storageAvailableBytes, modelCached] = await Promise.all([
    probeWebGpu(nav),
    probeBattery(nav),
    probeStorage(),
    isModelCached(PRIMARY_SEPARATION_MODEL),
  ]);
  return {
    ...ua,
    deviceMemoryGiB: normaliseDeviceMemory(nav.deviceMemory),
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    webgpu,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    battery,
    crashFlag: readCrashFlag() !== null,
    online: nav.onLine,
    storageAvailableBytes,
    modelCached,
  };
}
