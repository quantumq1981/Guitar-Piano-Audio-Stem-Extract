/**
 * Capability snapshot — plain data gathered by the UI layer (see
 * apps/web/src/platform/probe.ts) and fed into the pure routing function.
 *
 * Every field that a browser may not expose is modelled as `null`, never
 * guessed: Safari and Firefox do not implement navigator.deviceMemory or
 * navigator.getBattery(), and Chromium quantises deviceMemory to
 * {0.25, 0.5, 1, 2, 4, 8} and caps it at 8.
 */

export type FormFactor = 'phone' | 'tablet' | 'desktop';
export type BrowserEngine = 'webkit' | 'blink' | 'gecko' | 'unknown';

export interface WebGpuInfo {
  readonly available: boolean;
  /** GPUAdapter.limits.maxBufferSize, bytes. */
  readonly maxBufferSize: number | null;
  readonly maxStorageBufferBindingSize: number | null;
  readonly isFallbackAdapter: boolean;
}

export interface BatteryInfo {
  /** 0..1 */
  readonly level: number;
  readonly charging: boolean;
}

export interface CapabilitySnapshot {
  readonly formFactor: FormFactor;
  readonly engine: BrowserEngine;
  /** iOS/iPadOS: every browser is WebKit with WebKit's memory policy. */
  readonly isAppleMobile: boolean;
  /** navigator.deviceMemory in GiB, or null when the API is absent. */
  readonly deviceMemoryGiB: number | null;
  readonly hardwareConcurrency: number | null;
  readonly webgpu: WebGpuInfo;
  /** Needed for multithreaded WASM (SharedArrayBuffer). */
  readonly crossOriginIsolated: boolean;
  readonly battery: BatteryInfo | null;
  /** Set when a previous local run did not reach its completion marker. */
  readonly crashFlag: boolean;
  readonly online: boolean;
  /** navigator.storage.estimate() quota − usage, bytes; null when unknown. */
  readonly storageAvailableBytes: number | null;
  /** True when the primary model is already in Cache Storage with the pinned sha256. */
  readonly modelCached: boolean;
}

export const DEVICE_MEMORY_BUCKETS = [0.25, 0.5, 1, 2, 4, 8] as const;

/** Normalise a raw navigator.deviceMemory value; anything non-finite or ≤ 0 becomes null. */
export function normaliseDeviceMemory(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.min(raw, 8);
}

/** Classify from a UA string when UA-Client-Hints are unavailable. Pure; tested headlessly. */
export function classifyUserAgent(
  userAgent: string,
  maxTouchPoints: number,
  uaDataMobile: boolean | null,
): { formFactor: FormFactor; engine: BrowserEngine; isAppleMobile: boolean } {
  const ua = userAgent;
  const iPhone = /iPhone|iPod/.test(ua);
  // iPadOS 13+ reports a desktop Mac UA; touch points disambiguate.
  const iPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const androidPhone = android && /Mobile/.test(ua);

  let formFactor: FormFactor;
  if (uaDataMobile === true || iPhone || androidPhone) formFactor = 'phone';
  else if (iPad || android) formFactor = 'tablet';
  else formFactor = 'desktop';

  let engine: BrowserEngine;
  if (iPhone || iPad) engine = 'webkit';
  else if (/Firefox\//.test(ua) && !/Seamonkey/.test(ua)) engine = 'gecko';
  else if (/Chrome\/|Chromium\/|Edg\//.test(ua)) engine = 'blink';
  else if (/AppleWebKit\//.test(ua) && /Safari\//.test(ua)) engine = 'webkit';
  else engine = 'unknown';

  return { formFactor, engine, isAppleMobile: iPhone || iPad };
}
