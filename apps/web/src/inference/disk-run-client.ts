/**
 * UI-thread driver for the disk path (device-run.worker.ts). Owns the lifecycle guards:
 *  - page hidden → stop. iOS suspends background tabs and may kill them; the stems so far stay on disk and the run
 *    resumes from its last whole block, so stopping costs at most one window.
 *  - battery below the local limit while not charging → stop (resumable).
 *  - screen wake lock while running (Safari 16.4+, Chromium), so a locked screen does not hide the page.
 * No crash marker: a killed disk run is routine on a phone and resumes (routing does not consult it for this path).
 */
import type { SeparationProgress } from '@stemsplit/core';
import { LOCAL_LIMITS } from '@stemsplit/core';
import type { FromDeviceRun, ToDeviceRun } from './device-run-protocol.ts';

export interface DiskRunCallbacks {
  readonly onModelProgress: (loaded: number, total: number) => void;
  readonly onProgress: (p: SeparationProgress) => void;
  readonly onLog?: (message: string) => void;
}

/** The run stopped before the end and can resume; the stems written so far are on disk. */
export class DiskRunStopped extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`On-device separation paused: ${reason}`);
    this.name = 'DiskRunStopped';
    this.reason = reason;
  }
}

export interface DiskRunHandle {
  readonly done: Promise<{ readonly clipped: readonly string[] }>;
  /** Stops the run (resumable). */
  stop(reason: string): void;
}

export function runOnDisk(request: ToDeviceRun, cb: DiskRunCallbacks): DiskRunHandle {
  const worker = new Worker(new URL('./device-run.worker.ts', import.meta.url), { type: 'module', name: 'stemsplit-device-run' });
  let wakeLock: WakeLockSentinel | null = null;
  let settle: ((outcome: { clipped: readonly string[] } | Error) => void) | null = null;
  let battery: { level: number; charging: boolean; addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void } | null = null;

  const done = new Promise<{ readonly clipped: readonly string[] }>((resolve, reject) => {
    settle = (outcome) => {
      settle = null;
      cleanup();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
  });
  const stop = (reason: string) => settle?.(new DiskRunStopped(reason));

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') stop('the page was hidden (leaving Safari or locking the phone stops the run)');
  };
  const onBattery = () => {
    if (battery && !battery.charging && battery.level < LOCAL_LIMITS.minBatteryLevel) stop('battery dropped below 20%');
  };
  function cleanup() {
    document.removeEventListener('visibilitychange', onVisibility);
    battery?.removeEventListener('levelchange', onBattery);
    battery?.removeEventListener('chargingchange', onBattery);
    void wakeLock?.release().catch(() => {});
    wakeLock = null;
    worker.terminate();
  }

  document.addEventListener('visibilitychange', onVisibility);
  void (navigator as Navigator & { getBattery?: () => Promise<typeof battery> }).getBattery?.().then((b) => {
    if (!b || !settle) return;
    battery = b;
    b.addEventListener('levelchange', onBattery);
    b.addEventListener('chargingchange', onBattery);
  }).catch(() => {});
  void navigator.wakeLock?.request('screen').then((lock) => {
    if (settle) wakeLock = lock;
    else void lock.release().catch(() => {});
  }).catch(() => {});

  worker.onmessage = (e: MessageEvent<FromDeviceRun>) => {
    const m = e.data;
    switch (m.type) {
      case 'log':
        cb.onLog?.(m.message);
        break;
      case 'model-progress':
        cb.onModelProgress(m.loaded, m.total);
        break;
      case 'progress':
        cb.onProgress(m.progress);
        break;
      case 'done':
        settle?.({ clipped: m.clipped });
        break;
      case 'error':
        settle?.(new Error(m.message));
        break;
    }
  };
  worker.onerror = (e) => settle?.(new Error(e.message || 'On-device worker crashed'));
  worker.onmessageerror = () => settle?.(new Error('On-device worker message could not be decoded'));

  if (request.type === 'start') worker.postMessage(request, [request.left.buffer, request.right.buffer]);
  else worker.postMessage(request);
  return { done, stop };
}
