import { describe, expect, it } from 'vitest';
import type { CapabilitySnapshot, FlowPhase, PlanInput, RouteRequest } from '../src/index.ts';
import {
  BUSY_FLOW_PHASES,
  PRIMARY_SEPARATION_MODEL,
  decideRoute,
  downloadBytes,
  formatClock,
  formatEta,
  partProgress,
  partsFor,
  pauseMessage,
  planFor,
  problemCopy,
  runStorageNeed,
  scopeOptions,
  screenFor,
  usableScope,
} from '../src/index.ts';

const iphone: CapabilitySnapshot = {
  formFactor: 'phone',
  engine: 'webkit',
  isAppleMobile: true,
  deviceMemoryGiB: null,
  hardwareConcurrency: 6,
  webgpu: { available: false, maxBufferSize: null, maxStorageBufferBindingSize: null, isFallbackAdapter: false },
  crossOriginIsolated: true,
  battery: null,
  crashFlag: false,
  online: true,
  storageAvailableBytes: 20 * 2 ** 30,
  modelCached: false,
  opfsWritable: true,
};

const route = (over: Partial<RouteRequest> = {}) =>
  decideRoute({ caps: iphone, input: { durationSec: 240, bytes: 9e6 }, scope: 'full', options: { refinePiano: false }, preference: 'auto', ...over });

const plan = (over: Partial<PlanInput> = {}) =>
  planFor({
    decision: route(),
    scope: 'full',
    serverConfigured: false,
    estimateSec: 540,
    durationSec: 240,
    formFactor: 'phone',
    modelCached: false,
    model: PRIMARY_SEPARATION_MODEL,
    ...over,
  });

describe('screenFor', () => {
  const at = (phase: FlowPhase, over: Partial<Parameters<typeof screenFor>[0]> = {}) =>
    screenFor({ phase, hasFile: false, stored: null, nav: 'auto', ...over });

  it('shows the running job whatever the user asked for', () => {
    for (const phase of BUSY_FLOW_PHASES) {
      for (const nav of ['auto', 'home', 'stored', 'diagnostics'] as const) expect(at(phase, { nav, hasFile: true })).toBe('working');
    }
  });

  it('starts at home and moves to the choice once a song is picked', () => {
    expect(at('idle')).toBe('home');
    expect(at('idle', { hasFile: true })).toBe('choose');
    expect(at('error', { hasFile: true })).toBe('choose'); // the error shows beside the choice, ready to retry
    expect(at('queued-offline', { hasFile: true })).toBe('choose');
  });

  it('follows a finished or paused run, even before the stored scan returns', () => {
    expect(at('disk-done', { hasFile: true })).toBe('stems');
    expect(at('paused', { hasFile: true })).toBe('paused');
    expect(at('ready', { hasFile: true })).toBe('player');
  });

  it('honours where the user navigated', () => {
    expect(at('disk-done', { nav: 'home', stored: 'complete' })).toBe('home');
    expect(at('idle', { nav: 'stored', stored: 'complete' })).toBe('stems');
    expect(at('idle', { nav: 'stored', stored: 'stopped' })).toBe('paused');
    expect(at('idle', { nav: 'stored', stored: 'unusable' })).toBe('home');
    expect(at('idle', { nav: 'stored', stored: null })).toBe('home'); // deleted meanwhile
    expect(at('ready', { nav: 'diagnostics' })).toBe('diagnostics');
  });
});

describe('scope choices', () => {
  it('offers only what this build can deliver', () => {
    expect(scopeOptions(false).map((o) => o.scope)).toEqual(['quick', 'full']);
    expect(scopeOptions(true).map((o) => o.scope)).toEqual(['quick', 'full', 'guitar']);
    expect(scopeOptions(false).map((o) => o.title)).toEqual(['4 stems', '6 stems']);
  });

  it('lists the stems each choice writes on a device', () => {
    const [quick, full] = scopeOptions(false);
    expect(quick!.stems).toEqual(['vocals', 'drums', 'bass', 'other']);
    expect(full!.stems).toEqual(['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']);
  });

  it('falls back to 6 stems when a server-only scope cannot run', () => {
    expect(usableScope('guitar', false)).toBe('full');
    expect(usableScope('guitar', true)).toBe('guitar');
    expect(usableScope('quick', false)).toBe('quick');
  });
});

describe('planFor', () => {
  it('on a phone: runs here, with time and space for stems + song + first download', () => {
    const p = plan();
    expect(p.canStart).toBe(true);
    expect(p.runsOn).toBe('this-phone');
    expect(p.etaSec).toBe(540);
    expect(p.cta).toBe('Separate into 6 stems');
    const io = PRIMARY_SEPARATION_MODEL.io!;
    const need = runStorageNeed(240 * io.sampleRate, 6, { sampleRate: io.sampleRate, channels: io.channels, sampleFormat: 'pcm24' }).total;
    expect(p.storageBytes).toBe(need + downloadBytes(PRIMARY_SEPARATION_MODEL)!);
    expect(p.downloadBytes).toBe(downloadBytes(PRIMARY_SEPARATION_MODEL));
  });

  it('counts no download once the model is cached, and fewer stems for 4', () => {
    const six = plan({ modelCached: true });
    const four = plan({ modelCached: true, scope: 'quick', decision: route({ scope: 'quick' }) });
    expect(six.downloadBytes).toBeNull();
    expect(four.storageBytes!).toBeLessThan(six.storageBytes!);
    expect(four.cta).toBe('Separate into 4 stems');
  });

  it('explains, in plain words, why it cannot run without a server', () => {
    const priv = plan({ decision: route({ caps: { ...iphone, opfsWritable: false } }) });
    expect(priv.canStart).toBe(false);
    expect(priv.problem).toMatch(/normal Safari tab/);

    const long = plan({ durationSec: 900, decision: route({ input: { durationSec: 900, bytes: 30e6 } }) });
    expect(long.problem).toBe('Songs up to 10 minutes can be separated on this phone. Trim it and try again.');

    const battery = plan({ decision: route({ caps: { ...iphone, battery: { level: 0.1, charging: false } } }) });
    expect(battery.problem).toMatch(/below 20%/);
  });

  it('puts the most fixable problem first', () => {
    const both = plan({ decision: route({ caps: { ...iphone, opfsWritable: false }, input: { durationSec: 900, bytes: 30e6 } }) });
    expect(both.problem).toMatch(/Private Browsing/);
  });

  it('sends to the server when one is configured, and states server limits', () => {
    const guitar = plan({ serverConfigured: true, scope: 'guitar', decision: route({ scope: 'guitar' }) });
    expect(guitar).toMatchObject({ canStart: true, runsOn: 'server', cta: 'Separate on our server', problem: null });
    const tooLong = plan({ serverConfigured: true, scope: 'guitar', decision: route({ scope: 'guitar', input: { durationSec: 1200, bytes: 9e6 } }) });
    expect(tooLong.canStart).toBe(false);
    expect(tooLong.problem).toMatch(/up to 6 minutes/);
  });

  it('offers to clear a crash marker only without a server', () => {
    const desktop: CapabilitySnapshot = { ...iphone, formFactor: 'desktop', crashFlag: true, deviceMemoryGiB: 8 };
    const d = decideRoute({ caps: desktop, input: { durationSec: 60, bytes: 1e6 }, scope: 'full', options: { refinePiano: false }, preference: 'auto' });
    expect(planFor({ ...basePlanInput(), decision: d, formFactor: 'desktop' }).canClearCrash).toBe(true);
    expect(planFor({ ...basePlanInput(), decision: d, formFactor: 'desktop', serverConfigured: true }).canClearCrash).toBe(false);
  });

  it('cannot start before there is a decision', () => {
    expect(plan({ decision: null })).toMatchObject({ canStart: false, problem: null });
  });
});

function basePlanInput(): PlanInput {
  return { decision: null, scope: 'full', serverConfigured: false, estimateSec: null, durationSec: 60, formFactor: 'phone', modelCached: true, model: PRIMARY_SEPARATION_MODEL };
}

describe('problemCopy', () => {
  it('names the device and has copy for every blocker', () => {
    expect(problemCopy('insufficient_storage_for_stems', 'tablet')).toMatch(/this tablet/);
    expect(problemCopy('duration_over_local_cap', 'desktop')).toMatch(/90 seconds.*computer/);
    expect(problemCopy('device_memory_low', 'phone')).toMatch(/^This phone/);
    expect(problemCopy('eligible_wasm', 'phone')).toBeNull();
  });
});

describe('progress and wording', () => {
  it('counts parts the way the engine plans windows', () => {
    expect(partsFor(43.2, PRIMARY_SEPARATION_MODEL)).toBe(8); // the owner's iPhone run: 8 windows
    expect(partsFor(null, PRIMARY_SEPARATION_MODEL)).toBeNull();
    expect(partsFor(0, PRIMARY_SEPARATION_MODEL)).toBeNull();
  });

  it('turns a fraction into finished parts, clamped', () => {
    expect(partProgress(3 / 8, 8)).toEqual({ done: 3, total: 8, percent: 38 });
    expect(partProgress(0.374, 8)).toEqual({ done: 2, total: 8, percent: 37 });
    expect(partProgress(1, 8)).toEqual({ done: 8, total: 8, percent: 100 });
    expect(partProgress(Number.NaN, 8)).toEqual({ done: 0, total: 8, percent: 0 });
    expect(partProgress(1.5, 0)).toEqual({ done: 1, total: 1, percent: 100 });
  });

  it('formats times for people', () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(40)).toBe('under a minute');
    expect(formatEta(540)).toBe('about 9 min');
    expect(formatEta(3900)).toBe('about 1 h 5 min');
    expect(formatClock(252)).toBe('4:12');
    expect(formatClock(Number.NaN)).toBe('–:––');
  });

  it('says why a run paused', () => {
    expect(pauseMessage('the page was hidden (leaving Safari or locking the phone stops the run)')).toBe('You left the page, so it paused.');
    expect(pauseMessage('battery dropped below 20%')).toMatch(/Plug in/);
    expect(pauseMessage('you paused it')).toBe('You paused it.');
    expect(pauseMessage(null)).toBe('It stopped before it finished.');
  });
});
