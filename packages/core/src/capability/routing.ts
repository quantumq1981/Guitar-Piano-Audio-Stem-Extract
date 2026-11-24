/**
 * Tier routing: capability snapshot × input × scope → where the job runs.
 *
 * Pure and total: every input produces a decision with machine-readable reason
 * codes, so the UI banner, telemetry and tests all read the same explanation.
 * Rules are evaluated in priority order; the first "server" rule wins, but all
 * applicable reasons are collected for diagnostics.
 */
import type { SeparationOptions, SeparationScope } from '../api/contract.ts';
import { LOCAL_LIMITS, SERVER_LIMITS, scopeRequiresServer } from '../api/contract.ts';
import type { ModelArtifact } from '../models/registry.ts';
import { PRIMARY_SEPARATION_MODEL } from '../models/registry.ts';
import type { MemoryProjection } from '../memory/budget.ts';
import { PLATFORM_CEILINGS, platformClass, projectPeakMemory } from '../memory/budget.ts';
import type { CapabilitySnapshot } from './probe.ts';

export type RouteReason =
  | 'user_forced_server'
  | 'scope_server_only'
  | 'crash_flag'
  | 'phone_form_factor'
  | 'device_memory_low'
  | 'device_memory_unknown_mobile'
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

export type RouteDecision =
  | {
      readonly target: 'device';
      readonly ep: 'webgpu' | 'wasm';
      readonly model: ModelArtifact;
      readonly memory: MemoryProjection;
      readonly reasons: readonly RouteReason[];
      readonly warnings: readonly RouteWarning[];
    }
  | {
      readonly target: 'server';
      readonly reasons: readonly RouteReason[];
      readonly warnings: readonly RouteWarning[];
      /** Input exceeds server limits too — the UI must ask the user to trim. */
      readonly rejected: null | 'too_long' | 'too_large';
      readonly memory: MemoryProjection | null;
    };

export function decideRoute(req: RouteRequest): RouteDecision {
  const { caps, input, scope, options, preference } = req;
  const model = req.model ?? PRIMARY_SEPARATION_MODEL;
  const blockers: RouteReason[] = [];
  const warnings: RouteWarning[] = [];

  const rejected: null | 'too_long' | 'too_large' =
    input.durationSec > SERVER_LIMITS.maxDurationSec ? 'too_long' : input.bytes > SERVER_LIMITS.maxUploadBytes ? 'too_large' : null;

  if (preference === 'force-server') blockers.push('user_forced_server');
  if (scopeRequiresServer(scope, options)) blockers.push('scope_server_only');
  if (caps.crashFlag) blockers.push('crash_flag');
  if (!model.allowedTiers.includes('browser')) blockers.push('model_not_browser_eligible');

  // Phones always offload; "prefer-device" does not override this — it is a safety rule, not a preference.
  if (caps.formFactor === 'phone') blockers.push('phone_form_factor');
  if (caps.deviceMemoryGiB !== null && caps.deviceMemoryGiB <= 4) blockers.push('device_memory_low');
  if (caps.deviceMemoryGiB === null && caps.formFactor !== 'desktop') blockers.push('device_memory_unknown_mobile');
  if (caps.battery !== null && !caps.battery.charging && caps.battery.level < LOCAL_LIMITS.minBatteryLevel) {
    blockers.push('battery_low');
  }

  const webgpu = caps.webgpu.available && !caps.webgpu.isFallbackAdapter;
  const ep: 'webgpu' | 'wasm' = webgpu ? 'webgpu' : 'wasm';
  const localCap = webgpu ? LOCAL_LIMITS.maxDurationSecWebGpu : LOCAL_LIMITS.maxDurationSecWasm;
  if (input.durationSec > localCap) blockers.push('duration_over_local_cap');
  // Single-threaded WASM on a 7.8 s htdemucs window is minutes per chunk; not a product.
  if (!webgpu && !caps.crossOriginIsolated) blockers.push('no_webgpu_wasm_unthreaded');

  let memory: MemoryProjection | null = null;
  if (model.bytes !== null && model.io !== null) {
    memory = projectPeakMemory({
      model,
      ep,
      inputFrames: Math.ceil(input.durationSec * model.io.sampleRate),
      streamInput: false,
      inputCopies: 2,
      retainedOutputStems: model.io.stems.length,
    });
    const ceiling = PLATFORM_CEILINGS[platformClass(caps, ep)];
    if (memory.projectedPeakBytes > ceiling.abortAboveBytes.value) blockers.push('memory_projection_exceeds_ceiling');
    if (memory.hasEstimates) warnings.push('memory_numbers_are_estimates');
  }
  if (!caps.modelCached && caps.storageAvailableBytes !== null && model.bytes !== null && caps.storageAvailableBytes < model.bytes * 1.5) {
    blockers.push('insufficient_storage_for_model');
  }

  if (blockers.length === 0 && memory !== null) {
    if (ep === 'wasm') warnings.push('wasm_slow_path');
    warnings.push('lower_fidelity_than_server');
    return {
      target: 'device',
      ep,
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
  phone_form_factor: 'Phones process on our servers to protect battery and avoid the browser closing the tab.',
  device_memory_low: 'This device reports 4 GB of memory or less.',
  device_memory_unknown_mobile: 'This browser does not report device memory, so we play it safe.',
  battery_low: 'Battery is below 20% and not charging.',
  duration_over_local_cap: 'This track is longer than the on-device limit.',
  no_webgpu_wasm_unthreaded: 'This browser lacks WebGPU and multithreaded WebAssembly.',
  memory_projection_exceeds_ceiling: 'The model would need more memory than this browser safely allows.',
  model_not_browser_eligible: 'The current model release is server-only.',
  insufficient_storage_for_model: 'Not enough free storage to cache the model.',
  eligible_webgpu: 'Processing on this device with WebGPU.',
  eligible_wasm: 'Processing on this device with WebAssembly (slower).',
};
