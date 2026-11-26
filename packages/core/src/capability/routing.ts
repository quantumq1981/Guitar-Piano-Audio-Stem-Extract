/**
 * Tier routing: capability snapshot × input × scope → where the job runs.
 *
 * Pure and total: every input produces a decision with machine-readable reason
 * codes, so the UI banner, telemetry and tests all read the same explanation.
 * Rules are evaluated in priority order; the first "server" rule wins, but all
 * applicable reasons are collected for diagnostics.
 */
import type { SeparationOptions, SeparationScope } from '../api/contract.ts';
import { LOCAL_LIMITS, SCOPE_OUTPUTS, SERVER_LIMITS, scopeRequiresServer } from '../api/contract.ts';
import { runStorageNeed } from '../separation/resume.ts';
import { planChunks } from '../dsp/chunking.ts';
import type { ModelArtifact } from '../models/registry.ts';
import { PRIMARY_SEPARATION_MODEL, downloadBytes } from '../models/registry.ts';
import type { DiskRunProjection, MemoryProjection } from '../memory/budget.ts';
import { PLATFORM_CEILINGS, platformClass, projectDiskRunPeak, projectPeakMemory } from '../memory/budget.ts';
import type { StemName } from '../models/registry.ts';
import type { CapabilitySnapshot } from './probe.ts';

export type RouteReason =
  | 'user_forced_server'
  | 'scope_server_only'
  | 'crash_flag'
  | 'mobile_profile_unmeasured'
  | 'storage_not_writable'
  | 'insufficient_storage_for_stems'
  | 'device_memory_low'
  | 'battery_low'
  | 'duration_over_local_cap'
  | 'no_webgpu_wasm_unthreaded'
  | 'memory_projection_exceeds_ceiling'
  | 'model_not_browser_eligible'
  | 'insufficient_storage_for_model'
  | 'eligible_webgpu'
  | 'eligible_wasm';

export type RouteWarning = 'wasm_slow_path' | 'memory_numbers_are_estimates' | 'offline_server_job_queued' | 'lower_fidelity_than_server';

export interface InputDescriptor {
  readonly durationSec: number;
  readonly bytes: number;
}

export type UserPreference = 'auto' | 'force-server' | 'prefer-device';

export interface RouteRequest {
  readonly caps: CapabilitySnapshot;
  readonly input: InputDescriptor;
  readonly scope: SeparationScope;
  readonly options: Pick<SeparationOptions, 'refinePiano'>;
  readonly preference: UserPreference;
  readonly model?: ModelArtifact;
}

/**
 * Where a device run keeps the song and its stems.
 *  - `memory` (desktop): stems are posted to the page and decoded for the mixer.
 *  - `disk` (phones, tablets): the song and the stems stream through OPFS, memory stays flat, and a stopped run
 *    resumes (separation/resume.ts).
 */
export type DeviceStorage = 'memory' | 'disk';

export type RouteDecision =
  | {
      readonly target: 'device';
      readonly ep: 'webgpu' | 'wasm';
      readonly storage: DeviceStorage;
      /** WASM threads to request (the worker still lowers it to what the page allows). */
      readonly threads: number;
      readonly model: ModelArtifact;
      readonly memory: MemoryProjection | DiskRunProjection;
      readonly reasons: readonly RouteReason[];
      readonly warnings: readonly RouteWarning[];
    }
  | {
      readonly target: 'server';
      readonly reasons: readonly RouteReason[];
      readonly warnings: readonly RouteWarning[];
      /** Input exceeds server limits too — the UI must ask the user to trim. */
      readonly rejected: null | 'too_long' | 'too_large';
      readonly memory: MemoryProjection | DiskRunProjection | null;
    };

/** Stems a device run writes for `scope` (lead/rhythm needs the server, so it is never a device output). */
export function deviceOutputs(scope: SeparationScope): readonly StemName[] {
  return SCOPE_OUTPUTS[scope].filter((s) => s !== 'guitar_lead' && s !== 'guitar_rhythm');
}

/**
 * WASM threads for a device run. Phones and tablets: 1 until the owner's iPhone thread test (Stage V step 0) is
 * measured; parity is identical at 1/2/4 threads, but phone speed and heap at 2/4 threads are not measured yet.
 * Desktop: up to 4 when the page is cross-origin isolated (measured 5.7 s per window at 4 threads, 4 vCPU).
 */
export function deviceThreads(caps: Pick<CapabilitySnapshot, 'formFactor' | 'crossOriginIsolated' | 'hardwareConcurrency'>): number {
  if (!caps.crossOriginIsolated || caps.formFactor !== 'desktop') return 1;
  return Math.max(1, Math.min(4, caps.hardwareConcurrency ?? 2));
}

/**
 * Measured seconds per 7.8 s window of the primary artifact, by thread count [M]:
 *  - mobile: the owner's iPhone, Safari, Low Power Mode off (window test 11.9–12.9 s at 1 thread). With Low Power
 *    Mode on it was ~23 s. 2 and 4 threads are not measured on a phone yet (Stage V step 0).
 *  - desktop: 4 vCPU container, Chromium, the real app (WebKit within 1 s).
 */
export const DEVICE_SECONDS_PER_WINDOW: Readonly<Record<'mobile' | 'desktop', Readonly<Record<number, number>>>> = {
  mobile: { 1: 12.5 },
  desktop: { 1: 18.0, 2: 10.1, 4: 5.7 },
};

/**
 * Expected separation time for a device run, from DEVICE_SECONDS_PER_WINDOW and the engine's window count, or null
 * when that thread count is unmeasured on this kind of device. Excludes the first model download.
 */
export function estimateDeviceSeconds(durationSec: number, threads: number, formFactor: CapabilitySnapshot['formFactor'], segmentFrames: number, sampleRate: number): number | null {
  const perWindow = DEVICE_SECONDS_PER_WINDOW[formFactor === 'desktop' ? 'desktop' : 'mobile'][threads];
  if (perWindow === undefined || !(durationSec > 0)) return null;
  return planChunks(Math.max(1, Math.round(durationSec * sampleRate)), segmentFrames).chunks.length * perWindow;
}

export function decideRoute(req: RouteRequest): RouteDecision {
  const { caps, input, scope, options, preference } = req;
  const model = req.model ?? PRIMARY_SEPARATION_MODEL;
  const blockers: RouteReason[] = [];
  const warnings: RouteWarning[] = [];

  const rejected: null | 'too_long' | 'too_large' =
    input.durationSec > SERVER_LIMITS.maxDurationSec ? 'too_long' : input.bytes > SERVER_LIMITS.maxUploadBytes ? 'too_large' : null;

  if (preference === 'force-server') blockers.push('user_forced_server');
  if (scopeRequiresServer(scope, options)) blockers.push('scope_server_only');
  const mobile = caps.formFactor !== 'desktop';
  const storage: DeviceStorage = mobile ? 'disk' : 'memory';
  // A killed disk run is routine on a phone (switching apps) and resumes, so the crash marker only guards the
  // in-memory path, whose kill has no recovery.
  if (caps.crashFlag && storage === 'memory') blockers.push('crash_flag');
  if (!model.allowedTiers.includes('browser')) blockers.push('model_not_browser_eligible');

  if (mobile) {
    // Evidence, not form factor: a measured whole-song heap for this artifact, and storage the stems can stream to.
    if (model.browserHeapBytes === undefined) blockers.push('mobile_profile_unmeasured');
    if (caps.opfsWritable !== true) blockers.push('storage_not_writable');
    // The disk path's heap is measured on a phone that does not report deviceMemory, so "unknown" is not a blocker;
    // a reported 2 GiB or less leaves no room beside the OS for a 616 MiB heap.
    if (caps.deviceMemoryGiB !== null && caps.deviceMemoryGiB <= 2) blockers.push('device_memory_low');
  } else if (caps.deviceMemoryGiB !== null && caps.deviceMemoryGiB <= 4) {
    blockers.push('device_memory_low');
  }
  if (caps.battery !== null && !caps.battery.charging && caps.battery.level < LOCAL_LIMITS.minBatteryLevel) {
    blockers.push('battery_low');
  }

  // The model must be placeable on WebGPU too: the Stage IV artifact is not (partitioning fails, measured).
  // The disk path runs the WASM build only (the one validated on the iPhone).
  const webgpu = !mobile && caps.webgpu.available && !caps.webgpu.isFallbackAdapter && model.epSupport.webgpu !== 'unsupported';
  const ep: 'webgpu' | 'wasm' = webgpu ? 'webgpu' : 'wasm';
  const localCap = mobile ? LOCAL_LIMITS.maxDurationSecMobile : webgpu ? LOCAL_LIMITS.maxDurationSecWebGpu : LOCAL_LIMITS.maxDurationSecWasm;
  if (input.durationSec > localCap) blockers.push('duration_over_local_cap');
  // Single-threaded WASM on a 7.8 s htdemucs window is minutes per chunk on desktop; not a product. (Phones run one
  // thread by choice, on an isolated page; the same isolation keeps the option of more threads.)
  if (!webgpu && !caps.crossOriginIsolated) blockers.push('no_webgpu_wasm_unthreaded');

  let memory: MemoryProjection | DiskRunProjection | null = null;
  const inputFrames = model.io ? Math.ceil(Math.max(0, input.durationSec) * model.io.sampleRate) : 0;
  if (model.bytes !== null && model.io !== null) {
    memory = storage === 'disk'
      ? projectDiskRunPeak({ model, inputFrames, compressedBytes: input.bytes })
      : projectPeakMemory({ model, ep, inputFrames, streamInput: false, inputCopies: 2, retainedOutputStems: model.io.stems.length });
    if (memory !== null) {
      const ceiling = PLATFORM_CEILINGS[platformClass(caps, ep)];
      if (memory.projectedPeakBytes > ceiling.abortAboveBytes.value) blockers.push('memory_projection_exceeds_ceiling');
      if (memory.hasEstimates) warnings.push('memory_numbers_are_estimates');
    }
  }
  const modelBytes = downloadBytes(model); // graph + external data
  const modelNeed = caps.modelCached || modelBytes === null ? 0 : modelBytes * 1.5;
  if (caps.storageAvailableBytes !== null && caps.storageAvailableBytes < modelNeed) {
    blockers.push('insufficient_storage_for_model');
  } else if (storage === 'disk' && caps.storageAvailableBytes !== null && model.io !== null) {
    const need = runStorageNeed(inputFrames, deviceOutputs(scope).length, { sampleRate: model.io.sampleRate, channels: model.io.channels, sampleFormat: 'pcm24' });
    if (caps.storageAvailableBytes < modelNeed + need.total * 1.1) blockers.push('insufficient_storage_for_stems');
  }

  if (blockers.length === 0 && memory !== null) {
    if (ep === 'wasm') warnings.push('wasm_slow_path');
    warnings.push('lower_fidelity_than_server');
    return {
      target: 'device',
      ep,
      storage,
      threads: deviceThreads(caps),
      model,
      memory,
      reasons: [ep === 'webgpu' ? 'eligible_webgpu' : 'eligible_wasm'],
      warnings,
    };
  }

  if (!caps.online) warnings.push('offline_server_job_queued');
  return { target: 'server', reasons: blockers, warnings, rejected, memory };
}

/** Human-readable explanations for the routing banner. */
export const REASON_COPY: Readonly<Record<RouteReason, string>> = {
  user_forced_server: 'You chose server processing.',
  scope_server_only: 'Lead/rhythm guitar and piano refinement only run on our servers.',
  crash_flag: 'A previous on-device run did not finish, so we are using the server this time.',
  mobile_profile_unmeasured: 'This model release has not been measured on phones yet, so phones use the server.',
  storage_not_writable:
    'This window cannot store files on the device, which on-device separation needs for the stems. Safari blocks this in Private Browsing: open the page in a normal tab.',
  insufficient_storage_for_stems: 'Not enough free storage on this device for the stems.',
  device_memory_low: 'This device reports too little memory for on-device separation.',
  battery_low: 'Battery is below 20% and not charging.',
  duration_over_local_cap: 'This track is longer than the on-device limit.',
  no_webgpu_wasm_unthreaded: 'This browser lacks WebGPU and multithreaded WebAssembly.',
  memory_projection_exceeds_ceiling: 'The model would need more memory than this browser safely allows.',
  model_not_browser_eligible: 'The current model release is server-only.',
  insufficient_storage_for_model: 'Not enough free storage to cache the model.',
  eligible_webgpu: 'Processing on this device with WebGPU.',
  eligible_wasm: 'Processing on this device with WebAssembly (slower).',
};
