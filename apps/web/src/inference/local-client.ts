/**
 * UI-thread controller for on-device separation. Owns the lifecycle guards: crash marker, abort on page hidden,
 * abort on low battery.
 *
 * Removed 2026-11-25: abort on "critical" Compute Pressure. Chromium derives that state from CPU utilisation, so a
 * multi-threaded WASM run that uses every core (as intended) drives it to critical by itself and was terminated
 * mid-window: measured in headless Chromium 158, 4 vCPU, 4 threads: fair → serious → critical at 15 s, the run
 * stopped with "the device is thermally throttling"; without the observer the same build finished in 30 s. A hot
 * device downclocks itself (slower, nothing lost), so the guard cost every desktop run and protected nothing.
 */
import type { SeparationProgress, StemName } from '@stemsplit/core';
import { LOCAL_LIMITS, MODEL_SAMPLE_RATE } from '@stemsplit/core';
import { clearCrashFlag, setCrashFlag } from '../platform/crash-flag.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

export interface LocalRunCallbacks {
  readonly onModelProgress: (loaded: number, total: number) => void;
  readonly onProgress: (p: SeparationProgress) => void;
}

export type StemBuffers = Map<StemName, [Float32Array, Float32Array]>;

export class LocalAbortError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`On-device processing stopped: ${reason}`);
    this.reason = reason;
  }
}

export async function runLocal(
  ep: 'webgpu' | 'wasm',
  left: Float32Array,
  right: Float32Array,
  wanted: readonly StemName[],
  cb: LocalRunCallbacks,
): Promise<StemBuffers> {
  const frames = left.length;
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "stemsplit-inference" });
  const out: StemBuffers = new Map(wanted.filter((s) => s !== 'guitar_lead' && s !== 'guitar_rhythm').map((s) => [s, [new Float32Array(frames), new Float32Array(frames)]]));
  const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let fail: ((error: Error) => void) | undefined;
  const abort = (reason: string) => {
    if (abortTimer !== undefined) return;
    send({ type: 'abort', reason });
    abortTimer = setTimeout(() => fail?.(new LocalAbortError(reason)), 5000);
  };
  const heartbeat = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => fail?.(new Error('Inference worker stopped responding. Reload or retry with a shorter clip.')), 300_000);
  };

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') abort('the page was hidden (mobile browsers throttle background tabs)');
  };
  document.addEventListener('visibilitychange', onVisibility);

  let battery: { level: number; charging: boolean; addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void } | null = null;
  const onBattery = () => {
    if (battery && !battery.charging && battery.level < LOCAL_LIMITS.minBatteryLevel) abort('battery dropped below 20%');
  };
  try {
    battery = (await (navigator as Navigator & { getBattery?: () => Promise<typeof battery> }).getBattery?.()) ?? null;
    battery?.addEventListener('levelchange', onBattery);
    battery?.addEventListener('chargingchange', onBattery);
  } catch {
    battery = null;
  }

  setCrashFlag({ startedAt: Date.now(), durationSec: frames / MODEL_SAMPLE_RATE, ep });
  const cleanup = () => {
    clearTimeout(abortTimer);
    clearTimeout(watchdog);
    document.removeEventListener('visibilitychange', onVisibility);
    battery?.removeEventListener('levelchange', onBattery);
    battery?.removeEventListener('chargingchange', onBattery);
    worker.terminate();
  };

  return new Promise<StemBuffers>((resolve, reject) => {
    fail = (error) => {
      if (error instanceof LocalAbortError) clearCrashFlag();
      cleanup();
      reject(error);
    };
    heartbeat();
    worker.onmessageerror = () => fail?.(new Error('Inference worker message could not be decoded'));
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      heartbeat();
      const m = e.data;
      switch (m.type) {
        case 'model-progress':
          cb.onModelProgress(m.loaded, m.total);
          break;
        case 'session-ready':
          break;
        case 'progress':
          cb.onProgress(m.progress);
          break;
        case 'block':
          for (const [stem, l, r] of m.stems) {
            const dst = out.get(stem);
            dst?.[0].set(l, m.start);
            dst?.[1].set(r, m.start);
          }
          break;
        case 'done':
          clearCrashFlag();
          cleanup();
          resolve(out);
          break;
        case 'error':
          // A clean abort is not a crash; an exception inside ORT might be memory-related, so keep the flag.
          if (m.aborted) clearCrashFlag();
          cleanup();
          reject(m.aborted ? new LocalAbortError(m.message) : new Error(m.message));
          break;
      }
    };
    worker.onerror = (e) => {
      cleanup();
      reject(new Error(e.message || 'Inference worker crashed'));
    };
    // Copies are transferred; the caller keeps its own buffers for playback of the original.
    const l = new Float32Array(left);
    const r = new Float32Array(right);
    send({ type: 'run', ep, left: l, right: r, wanted }, [l.buffer, r.buffer]);
  });
}
