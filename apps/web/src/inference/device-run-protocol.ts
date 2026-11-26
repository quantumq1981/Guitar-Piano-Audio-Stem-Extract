/** Messages between the main app (inference/disk-run-client.ts) and device-run.worker.ts (the disk path). */
import type { SeparationProgress, StemName } from '@stemsplit/core';

/** OPFS directory of the main app's stored run (the experimental card uses its own). */
export const DEVICE_RUN_DIRECTORY = 'device-run';
/** Stems are 24-bit PCM WAV, as the server exports by default (16-bit measurably limited quiet stems). */
export const DEVICE_RUN_SAMPLE_FORMAT = 'pcm24';

export type ToDeviceRun =
  /** Planar stereo at the model rate; both buffers are transferred. `outputs` are the scope's stems, in file order. */
  | {
    readonly type: 'start';
    readonly left: Float32Array;
    readonly right: Float32Array;
    readonly outputs: readonly StemName[];
    readonly threads: number;
    readonly source: { readonly name: string; readonly bytes: number };
  }
  | { readonly type: 'resume'; readonly outputs: readonly StemName[]; readonly threads: number };

export type FromDeviceRun =
  | { readonly type: 'log'; readonly message: string }
  | { readonly type: 'model-progress'; readonly loaded: number; readonly total: number }
  | { readonly type: 'progress'; readonly progress: SeparationProgress }
  | { readonly type: 'done'; readonly clipped: readonly string[] }
  | { readonly type: 'error'; readonly message: string };
