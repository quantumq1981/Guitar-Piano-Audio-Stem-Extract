import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiskRunStopped, runOnDisk } from '../src/inference/disk-run-client.ts';
import type { ToDeviceRun } from '../src/inference/device-run-protocol.ts';

/** Records what the client does with its worker; never runs one. */
class FakeWorker {
  static last: FakeWorker | null = null;
  posted: unknown[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
}

function fakeBattery(level: number, charging: boolean) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    level,
    charging,
    addEventListener: (t: string, f: () => void) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(f),
    removeEventListener: (t: string, f: () => void) => void listeners.get(t)?.delete(f),
    listeners,
  };
}

let visibility: DocumentVisibilityState;
let battery: ReturnType<typeof fakeBattery> | null;
const resume: ToDeviceRun = { type: 'resume', outputs: ['vocals', 'other'], threads: 1 };
const callbacks = { onModelProgress: () => {}, onProgress: () => {} };
/** Lets the client's getBattery().then(...) run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  visibility = 'visible';
  battery = null;
  FakeWorker.last = null;
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('document', {
    get visibilityState() {
      return visibility;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal('navigator', { getBattery: async () => battery });
});
afterEach(() => vi.unstubAllGlobals());

describe('runOnDisk lifecycle guards', () => {
  it('starts the run when the page is visible and the battery is fine', async () => {
    battery = fakeBattery(0.8, false);
    const run = runOnDisk(resume, callbacks);
    await settle();
    expect(FakeWorker.last!.posted).toEqual([resume]);
    expect(FakeWorker.last!.terminated).toBe(false);
    expect(battery.listeners.get('levelchange')?.size).toBe(1);
    run.stop('test over');
    await expect(run.done).rejects.toBeInstanceOf(DiskRunStopped);
  });

  it('does not start when the page is already hidden (it was hidden during decode)', async () => {
    visibility = 'hidden';
    const run = runOnDisk(resume, callbacks);
    await expect(run.done).rejects.toThrow(/page was hidden/);
    expect(FakeWorker.last!.posted).toEqual([]);
    expect(FakeWorker.last!.terminated).toBe(true);
  });

  it('stops at once when the battery is already below the limit and not charging (resume skips routing)', async () => {
    battery = fakeBattery(0.15, false);
    const run = runOnDisk(resume, callbacks);
    await expect(run.done).rejects.toThrow(/battery dropped below 20%/);
    expect(FakeWorker.last!.terminated).toBe(true);
    expect(battery.listeners.get('levelchange')?.size ?? 0).toBe(0);
  });

  it('keeps running on a low battery that is charging', async () => {
    battery = fakeBattery(0.15, true);
    const run = runOnDisk(resume, callbacks);
    await settle();
    expect(FakeWorker.last!.terminated).toBe(false);
    run.stop('test over');
    await expect(run.done).rejects.toBeInstanceOf(DiskRunStopped);
  });
});
