/**
 * UI-thread controller for on-device separation. Owns the lifecycle guards the
 * spec requires: crash marker, abort on page hidden, abort on low battery, and
 * abort on critical CPU pressure (Compute Pressure API, where available).
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

interface PressureObserverLike {
  observe(source: 'cpu'): Promise<void>;
  disconnect(): void;
}
type PressureCtor = new (cb: (records: Array<{ state: string }>) => void) => PressureObserverLike;

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
  const abort = (reason: string) => send({ type: 'abort', reason });

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

  let pressure: PressureObserverLike | null = null;
  const Pressure = (globalThis as { PressureObserver?: PressureCtor }).PressureObserver;
  if (Pressure) {
    try {
      pressure = new Pressure((records) => {
        if (records.some((r) => r.state === 'critical')) abort('the device is thermally throttling');
      });
      await pressure.observe('cpu');
    } catch {
      pressure = null;
    }
  }

  setCrashFlag({ startedAt: Date.now(), durationSec: frames / MODEL_SAMPLE_RATE, ep });
  const cleanup = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    battery?.removeEventListener('levelchange', onBattery);
    battery?.removeEventListener('chargingchange', onBattery);
    pressure?.disconnect();
    worker.terminate();
  };

  return new Promise<StemBuffers>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
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
