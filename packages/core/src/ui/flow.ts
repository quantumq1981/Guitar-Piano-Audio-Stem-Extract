/**
 * The app's screen flow and wording, as pure functions: which screen to show, what each separation choice offers,
 * what a planned run will take and why one cannot start, and how far a run has got. The React layer only renders
 * these results, so every rule here is headless-testable.
 *
 * Wording rules: speak to a listener, not an engineer. "Part" (one model window), "this phone", "our server".
 * Never offer a control that cannot work in this build.
 */
import type { SeparationScope } from '../api/contract.ts';
import { LOCAL_LIMITS, SERVER_LIMITS } from '../api/contract.ts';
import type { FormFactor } from '../capability/probe.ts';
import type { RouteDecision, RouteReason } from '../capability/routing.ts';
import { deviceOutputs } from '../capability/routing.ts';
import { planChunks } from '../dsp/chunking.ts';
import type { ModelArtifact, StemName } from '../models/registry.ts';
import { downloadBytes } from '../models/registry.ts';
import { runStorageNeed } from '../separation/resume.ts';

// ── screens ──────────────────────────────────────────────────────────────

/** Session phases, as the web session reports them. */
export type FlowPhase =
  | 'idle'
  | 'decoding'
  | 'model-download'
  | 'local'
  | 'waking'
  | 'uploading'
  | 'queued-offline'
  | 'server'
  | 'ready'
  | 'paused'
  | 'disk-done'
  | 'error';

/** Phases during which a job is running: inputs and other jobs are locked. */
export const BUSY_FLOW_PHASES: ReadonlySet<FlowPhase> = new Set<FlowPhase>(['decoding', 'model-download', 'local', 'waking', 'uploading', 'server']);

export type Screen =
  /** Pick a song; lists what is stored on this device. */
  | 'home'
  /** A song is chosen: pick the stems, see time and space, start. */
  | 'choose'
  /** A job is running. */
  | 'working'
  /** A stored on-device run stopped before the end and can resume. */
  | 'paused'
  /** Stems stored on this device (disk path). */
  | 'stems'
  /** Stems held in memory for the mixer (desktop device path, or the server). */
  | 'player'
  /** Device checks and the experimental model card. */
  | 'diagnostics';

/** Where the user asked to go. `auto` follows the session. */
export type Nav = 'auto' | 'home' | 'stored' | 'diagnostics';

export type StoredState = 'complete' | 'stopped' | 'unusable' | null;

export interface ScreenInput {
  readonly phase: FlowPhase;
  readonly hasFile: boolean;
  readonly stored: StoredState;
  readonly nav: Nav;
}

/**
 * The one screen to show. A running job always wins (nothing else may start meanwhile); then where the user asked
 * to go; then what the session's last outcome calls for.
 */
export function screenFor({ phase, hasFile, stored, nav }: ScreenInput): Screen {
  if (BUSY_FLOW_PHASES.has(phase)) return 'working';
  switch (nav) {
    case 'diagnostics':
      return 'diagnostics';
    case 'home':
      return 'home';
    case 'stored':
      return stored === 'complete' ? 'stems' : stored === 'stopped' ? 'paused' : 'home';
    case 'auto':
      break;
  }
  if (phase === 'ready') return 'player';
  // The stored-run scan finishes just after a run ends: these screens show a short "checking" state meanwhile.
  if (phase === 'disk-done') return 'stems';
  if (phase === 'paused') return 'paused';
  return hasFile ? 'choose' : 'home';
}

// ── stems and choices ────────────────────────────────────────────────────

export const STEM_LABELS: Readonly<Record<StemName, string>> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  guitar: 'Guitar',
  piano: 'Piano',
  other: 'Everything else',
  guitar_lead: 'Lead guitar',
  guitar_rhythm: 'Rhythm guitar',
};

export interface ScopeOption {
  readonly scope: SeparationScope;
  readonly title: string;
  readonly summary: string;
  /** What the user gets back, in display order. */
  readonly stems: readonly StemName[];
  readonly needsServer: boolean;
}

const SCOPE_OPTIONS: readonly ScopeOption[] = [
  { scope: 'quick', title: '4 stems', summary: 'The essentials. Guitar and piano stay in “everything else”.', stems: deviceOutputs('quick'), needsServer: false },
  { scope: 'full', title: '6 stems', summary: 'Adds guitar and piano on their own tracks.', stems: deviceOutputs('full'), needsServer: false },
  {
    scope: 'guitar',
    title: 'Guitar focus',
    summary: 'Splits the guitar into lead and rhythm. Runs on our server.',
    stems: ['vocals', 'drums', 'bass', 'guitar_lead', 'guitar_rhythm', 'piano', 'other'],
    needsServer: true,
  },
];

/** The choices this build can deliver: server-only ones appear only when a server is configured. */
export function scopeOptions(serverConfigured: boolean): readonly ScopeOption[] {
  return SCOPE_OPTIONS.filter((o) => serverConfigured || !o.needsServer);
}

export function scopeOption(scope: SeparationScope): ScopeOption {
  return SCOPE_OPTIONS.find((o) => o.scope === scope)!;
}

/** A scope this build cannot run falls back to the default (6 stems). */
export function usableScope(scope: SeparationScope, serverConfigured: boolean): SeparationScope {
  return scopeOptions(serverConfigured).some((o) => o.scope === scope) ? scope : 'full';
}

// ── the plan for a chosen song ───────────────────────────────────────────

export type RunsOn = 'this-phone' | 'this-device' | 'server';

export interface PlanInput {
  readonly decision: RouteDecision | null;
  readonly scope: SeparationScope;
  readonly serverConfigured: boolean;
  /** Measured-basis separation time (estimateDeviceSeconds), or null when unmeasured. */
  readonly estimateSec: number | null;
  readonly durationSec: number | null;
  readonly formFactor: FormFactor | null;
  readonly modelCached: boolean;
  readonly model: ModelArtifact;
}

export interface Plan {
  readonly canStart: boolean;
  readonly runsOn: RunsOn | null;
  /** Separation time, excluding a first model download. */
  readonly etaSec: number | null;
  /** Device storage the run needs: stems + stored song (disk path) + the model if it is not cached yet. */
  readonly storageBytes: number | null;
  /** Bytes of the first model download, or null when the model is cached (or the job runs on the server). */
  readonly downloadBytes: number | null;
  /** The start button's words. */
  readonly cta: string;
  /** Why it cannot start, in plain words; null when it can. */
  readonly problem: string | null;
  /** The decision's reasons include a crash marker the user can clear (only offered without a server). */
  readonly canClearCrash: boolean;
}

const minutesLimit = (sec: number) => `${Math.round(sec / 60)} minutes`;
const secondsOrMinutes = (sec: number) => (sec < 120 ? `${Math.round(sec)} seconds` : minutesLimit(sec));

/** Plain-language explanation for a routing blocker on a device that would otherwise run it. */
export function problemCopy(reason: RouteReason, formFactor: FormFactor | null): string | null {
  const device = formFactor === null || formFactor === 'desktop' ? 'this computer' : formFactor === 'phone' ? 'this phone' : 'this tablet';
  switch (reason) {
    case 'storage_not_writable':
      return 'This window can’t save files, so the stems would have nowhere to go. Private Browsing does this: open the page in a normal Safari tab.';
    case 'insufficient_storage_for_stems':
    case 'insufficient_storage_for_model':
      return `There isn’t enough free space on ${device}. Delete the stems you’ve saved here, or free some space, and try again.`;
    case 'battery_low':
      return 'The battery is below 20%. Plug in to charge, then try again.';
    case 'duration_over_local_cap':
      return formFactor === 'desktop' || formFactor === null
        ? `Songs up to ${secondsOrMinutes(LOCAL_LIMITS.maxDurationSecWasm)} can be separated on a computer. Trim it, or use a phone (up to ${minutesLimit(LOCAL_LIMITS.maxDurationSecMobile)}).`
        : `Songs up to ${minutesLimit(LOCAL_LIMITS.maxDurationSecMobile)} can be separated on ${device}. Trim it and try again.`;
    case 'device_memory_low':
      return `${device[0]!.toUpperCase()}${device.slice(1)} reports too little memory to separate songs.`;
    case 'memory_projection_exceeds_ceiling':
      return `This song would need more memory than the browser allows on ${device}. A shorter song will work.`;
    case 'no_webgpu_wasm_unthreaded':
      return 'This browser can’t run the model fast enough. Try a current Chrome, Edge or Safari.';
    case 'crash_flag':
      return 'The last attempt on this device didn’t finish, so it’s switched off for now.';
    case 'mobile_profile_unmeasured':
    case 'model_not_browser_eligible':
      return 'This version of the model can’t run on this device yet.';
    case 'scope_server_only':
    case 'user_forced_server':
    case 'eligible_webgpu':
    case 'eligible_wasm':
      return null;
  }
}

/** Blockers in the order a user should fix them (the first one shown is the one that matters most). */
const PROBLEM_ORDER: readonly RouteReason[] = [
  'storage_not_writable',
  'duration_over_local_cap',
  'battery_low',
  'insufficient_storage_for_model',
  'insufficient_storage_for_stems',
  'memory_projection_exceeds_ceiling',
  'device_memory_low',
  'no_webgpu_wasm_unthreaded',
  'crash_flag',
  'mobile_profile_unmeasured',
  'model_not_browser_eligible',
];

export function planFor(i: PlanInput): Plan {
  const option = scopeOption(i.scope);
  const none: Plan = { canStart: false, runsOn: null, etaSec: null, storageBytes: null, downloadBytes: null, cta: `Separate into ${option.title}`, problem: null, canClearCrash: false };
  const d = i.decision;
  if (d === null) return none;
  const modelDownload = i.modelCached ? null : downloadBytes(i.model);

  if (d.target === 'device') {
    const io = i.model.io;
    let storage: number | null = modelDownload;
    if (d.storage === 'disk' && io !== null && i.durationSec !== null) {
      const frames = Math.ceil(Math.max(0, i.durationSec) * io.sampleRate);
      const run = runStorageNeed(frames, deviceOutputs(i.scope).length, { sampleRate: io.sampleRate, channels: io.channels, sampleFormat: 'pcm24' });
      storage = run.total + (modelDownload ?? 0);
    }
    return {
      canStart: true,
      runsOn: i.formFactor === 'desktop' ? 'this-device' : 'this-phone',
      etaSec: i.estimateSec,
      storageBytes: storage,
      downloadBytes: modelDownload,
      cta: `Separate into ${option.title}`,
      problem: null,
      canClearCrash: false,
    };
  }

  // Server-routed.
  if (i.serverConfigured) {
    if (d.rejected === 'too_long') return { ...none, problem: `Songs up to ${minutesLimit(SERVER_LIMITS.maxDurationSec)} can be sent to our server. Trim it and try again.` };
    if (d.rejected === 'too_large') return { ...none, problem: `Files up to ${Math.round(SERVER_LIMITS.maxUploadBytes / 1e6)} MB can be sent to our server.` };
    return { ...none, canStart: true, runsOn: 'server', cta: option.needsServer ? `Separate on our server` : `Separate into ${option.title} on our server` };
  }
  const first = PROBLEM_ORDER.find((r) => d.reasons.includes(r));
  const problem = (first && problemCopy(first, i.formFactor)) ?? 'This needs our processing server, which this version of the app doesn’t have.';
  return { ...none, problem, canClearCrash: d.reasons.includes('crash_flag') };
}

// ── progress ─────────────────────────────────────────────────────────────

/** How many parts (model windows) a song of this length is separated in. */
export function partsFor(durationSec: number | null, model: ModelArtifact): number | null {
  const io = model.io;
  if (io === null || durationSec === null || !(durationSec > 0)) return null;
  return planChunks(Math.max(1, Math.round(durationSec * io.sampleRate)), io.segmentFrames).chunks.length;
}

export interface PartProgress {
  /** Finished parts. */
  readonly done: number;
  readonly total: number;
  /** 0–100, whole numbers. */
  readonly percent: number;
}

/** Progress fraction → finished parts. Out-of-range or non-finite input clamps (never NaN on screen). */
export function partProgress(fraction: number, total: number): PartProgress {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const t = Number.isFinite(total) && total >= 1 ? Math.floor(total) : 1;
  // Within a hair of a part boundary counts as that part done (float sums of 1/total).
  return { done: Math.min(t, Math.floor(f * t + 1e-9)), total: t, percent: Math.round(f * 100) };
}

/** "under a minute", "about 1 min", "about 9 min", "about 1 h 5 min". */
export function formatEta(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return null;
  if (sec < 60) return 'under a minute';
  const min = Math.round(sec / 60);
  if (min < 60) return `about ${min} min`;
  return `about ${Math.floor(min / 60)} h ${min % 60} min`;
}

/** m:ss for a song length. */
export function formatClock(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return '–:––';
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

/** What a running phase is doing, in a few words. */
export function workingTitle(phase: FlowPhase): string {
  switch (phase) {
    case 'decoding':
      return 'Reading the song…';
    case 'model-download':
      return 'Getting the model ready…';
    case 'local':
      return 'Separating…';
    case 'waking':
      return 'Waking our server…';
    case 'uploading':
      return 'Uploading…';
    case 'server':
      return 'Separating on our server…';
    default:
      return 'Working…';
  }
}

/** Why a disk run paused, from the run client's stop reason (null after a reload, when the reason is unknown). */
export function pauseMessage(reason: string | null): string {
  if (reason === null) return 'It stopped before it finished.';
  if (/hidden/.test(reason)) return 'You left the page, so it paused.';
  if (/battery/.test(reason)) return 'The battery dropped below 20%, so it paused. Plug in to continue.';
  if (/you paused/.test(reason)) return 'You paused it.';
  return `It paused: ${reason}.`;
}
