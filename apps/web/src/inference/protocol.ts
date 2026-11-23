/** Typed message protocol between the UI thread and the inference worker. */
import type { SeparationProgress, StemName } from '@stemsplit/core';

export type ToWorker =
  | { readonly type: 'run'; readonly ep: 'webgpu' | 'wasm'; readonly left: Float32Array; readonly right: Float32Array; readonly wanted: readonly StemName[] }
  | { readonly type: 'abort'; readonly reason: string };

export type FromWorker =
  | { readonly type: 'model-progress'; readonly loaded: number; readonly total: number }
  | { readonly type: 'session-ready'; readonly ep: string; readonly createMs: number }
  | { readonly type: 'progress'; readonly progress: SeparationProgress }
  | { readonly type: 'block'; readonly start: number; readonly frames: number; readonly stems: ReadonlyArray<readonly [StemName, Float32Array, Float32Array]> }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly message: string; readonly aborted: boolean };
