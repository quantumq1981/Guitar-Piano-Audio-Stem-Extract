/**
 * Peak-memory projection for one local separation session.
 *
 * Every constant carries provenance. "measured" numbers come from
 * `npm run bench:memory` on this repo; "estimate" numbers are engineering
 * judgement awaiting on-device measurement and must not be presented as fact.
 */
import type { ExecutionProvider, ModelArtifact } from '../models/registry.ts';
import { downloadBytes, requireIO } from '../models/registry.ts';
import type { CapabilitySnapshot } from '../capability/probe.ts';

export type Provenance = 'measured' | 'estimate' | 'policy';

export interface Sourced<T> {
  readonly value: T;
  readonly provenance: Provenance;
  readonly note: string;
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * Activation + runtime-arena peak for a single htdemucs_6s 7.8 s segment,
 * excluding the weights themselves.
 */
export const ACTIVATION_PEAK_BYTES: Readonly<Record<'cpu' | 'wasm' | 'webgpu', Sourced<number>>> = {
  cpu: {
    value: 2000 * MiB,
    provenance: 'measured',
    note:
      'onnxruntime-node 1.31 CPU EP, Linux x64, arena+mem-pattern off: steady peak RSS 2.40 GiB minus 435 MiB loaded session. ' +
      'Thread count (1–4) does not change it. With ORT defaults the peak climbs to 4.7 GiB by the second run.',
  },
  wasm: {
    value: 2000 * MiB,
    provenance: 'estimate',
    note: 'Assumed equal to the CPU EP (same kernels). Must fit in the 4 GiB wasm32 address space with weights.',
  },
  webgpu: {
    value: 2000 * MiB,
    provenance: 'estimate',
    note: 'Unmeasured; assumed parity with CPU until profiled on device. On unified-memory devices (iOS, Apple Silicon, most Android) GPU buffers count against the tab.',
  },
};

/**
 * Session-creation transient, as a multiple of model file bytes.
 */
export const SESSION_CREATE_WEIGHT_COPIES: Readonly<Record<'cpu' | 'wasm' | 'webgpu', Sourced<number>>> = {
  cpu: { value: 1.6, provenance: 'measured', note: '435 MiB RSS after create() for a 272 MiB file (optimised graph + prepacked weights).' },
  wasm: { value: 2.6, provenance: 'estimate', note: 'JS ArrayBuffer (1×) + WASM-heap session (≈1.6×) until the JS buffer is released.' },
  webgpu: { value: 3.6, provenance: 'estimate', note: 'JS ArrayBuffer + WASM-heap protobuf + GPU buffers during create().' },
};

export type PlatformClass =
  | 'ios-safari'
  | 'android-chrome-webgpu'
  | 'android-chrome-wasm'
  | 'desktop-webgpu'
  | 'desktop-wasm'
  | 'server';

export interface PlatformCeiling {
  readonly platform: PlatformClass;
  /** Approximate point at which the OS/browser kills the tab or process. */
  readonly killThresholdBytes: Sourced<number>;
  /** Projected peak above which we refuse to start locally. */
  readonly abortAboveBytes: Sourced<number>;
}

export const PLATFORM_CEILINGS: Readonly<Record<PlatformClass, PlatformCeiling>> = {
  'ios-safari': {
    platform: 'ios-safari',
    killThresholdBytes: { value: 1.5 * GiB, provenance: 'estimate', note: 'Jetsam kills WebContent well before 2.5 GiB on 4–6 GiB iPhones.' },
    abortAboveBytes: { value: 1 * GiB, provenance: 'policy', note: 'Spec hard limit.' },
  },
  'android-chrome-webgpu': {
    platform: 'android-chrome-webgpu',
    killThresholdBytes: { value: 2 * GiB, provenance: 'estimate', note: 'Low-memory killer pressure on 8 GiB devices; far lower on 4 GiB.' },
    abortAboveBytes: { value: 1.25 * GiB, provenance: 'policy', note: 'Leaves headroom for the decoded input and the GPU process.' },
  },
  'android-chrome-wasm': {
    platform: 'android-chrome-wasm',
    killThresholdBytes: { value: 1.5 * GiB, provenance: 'estimate', note: 'Large contiguous wasm memory.grow() fails first on fragmented 32-bit-era heaps.' },
    abortAboveBytes: { value: 1 * GiB, provenance: 'policy', note: 'Spec: WASM heap ~1 GiB practical cap.' },
  },
  'desktop-webgpu': {
    platform: 'desktop-webgpu',
    killThresholdBytes: { value: 4 * GiB, provenance: 'estimate', note: 'Renderer process limits on 64-bit Chromium.' },
    abortAboveBytes: { value: 3 * GiB, provenance: 'policy', note: '' },
  },
  'desktop-wasm': {
    platform: 'desktop-wasm',
    killThresholdBytes: { value: 4 * GiB, provenance: 'measured', note: 'wasm32 address space is 4 GiB.' },
    abortAboveBytes: { value: 3 * GiB, provenance: 'policy', note: '' },
  },
  server: {
    platform: 'server',
    killThresholdBytes: { value: 4 * GiB, provenance: 'policy', note: 'Container memory limit (standard-2 / 4 GiB class).' },
    abortAboveBytes: { value: 3.5 * GiB, provenance: 'policy', note: 'One session per container; concurrency via more containers.' },
  },
};

export function platformClass(caps: CapabilitySnapshot, ep: 'wasm' | 'webgpu'): PlatformClass {
  if (caps.isAppleMobile) return 'ios-safari';
  const mobile = caps.formFactor !== 'desktop';
  if (mobile) return ep === 'webgpu' ? 'android-chrome-webgpu' : 'android-chrome-wasm';
  return ep === 'webgpu' ? 'desktop-webgpu' : 'desktop-wasm';
}

export interface MemoryProjection {
  readonly kind: 'in-memory';
  readonly ep: ExecutionProvider;
  readonly weightsBytes: number;
  readonly sessionCreatePeakBytes: number;
  readonly inferencePeakBytes: number;
  readonly audioBuffersBytes: number;
  /** max(session-create, inference) + audio buffers. */
  readonly projectedPeakBytes: number;
  readonly hasEstimates: boolean;
}

export interface ProjectionInput {
  readonly model: ModelArtifact;
  readonly ep: 'cpu' | 'wasm' | 'webgpu';
  readonly inputFrames: number;
  /** When false, the full decoded input is held in memory (no OPFS streaming). */
  readonly streamInput: boolean;
  /** Full-length stereo output buffers retained by the browser client. */
  readonly retainedOutputStems?: number;
  /** Number of simultaneous full-track input copies. */
  readonly inputCopies?: number;
}

export function projectPeakMemory({ model, ep, inputFrames, streamInput, retainedOutputStems = 0, inputCopies = 1 }: ProjectionInput): MemoryProjection {
  const total = downloadBytes(model); // graph + external data: the weights live in the data file
  if (total === null) throw new Error(`Model ${model.id} has no pinned size; cannot budget it`);
  const io = requireIO(model);
  const weightsBytes = total;
  const copies = SESSION_CREATE_WEIGHT_COPIES[ep];
  const act = ACTIVATION_PEAK_BYTES[ep];

  const ioTensors = (io.channels + io.stems.length * io.channels) * io.segmentFrames * 4;
  const accumulator = (io.stems.length * io.channels + 1) * io.segmentFrames * 4;
  const decodedInput = streamInput ? io.channels * io.segmentFrames * 4 : io.channels * inputFrames * 4 * inputCopies;
  const retainedOutput = retainedOutputStems * io.channels * inputFrames * 4;

  const sessionCreatePeakBytes = weightsBytes * copies.value;
  const inferencePeakBytes = weightsBytes + act.value + ioTensors;
  const audioBuffersBytes = accumulator + decodedInput + retainedOutput;
  return {
    kind: 'in-memory',
    ep,
    weightsBytes,
    sessionCreatePeakBytes,
    inferencePeakBytes,
    audioBuffersBytes,
    projectedPeakBytes: Math.max(sessionCreatePeakBytes, inferencePeakBytes) + audioBuffersBytes,
    hasEstimates: copies.provenance === 'estimate' || act.provenance === 'estimate',
  };
}

/**
 * Decoded-PCM copies alive at once while the page decodes a song for the disk path: the AudioBuffer, the planar
 * copies made for transfer, and a resampler temporary when the source rate is not 44.1 kHz. The first two are
 * certain; the third is an allowance [E].
 */
export const DISK_RUN_DECODE_COPIES: Sourced<number> = {
  value: 3,
  provenance: 'estimate',
  note: 'AudioBuffer + transfer copies (2, by construction) + one resampling temporary (allowance).',
};

export interface DiskRunProjection {
  readonly kind: 'disk';
  /** Page while decoding: the compressed file plus DISK_RUN_DECODE_COPIES of the decoded stereo PCM. */
  readonly decodePeakBytes: number;
  /** Worker during separation: the measured WASM heap plus overlap-add state and one block of stems in flight. */
  readonly inferencePeakBytes: number;
  /**
   * The larger of the two. They do not overlap: the worker stores the song in OPFS and drops its copy before it
   * creates the session, and the page releases its copies once they are transferred.
   */
  readonly projectedPeakBytes: number;
  readonly hasEstimates: boolean;
}

export interface DiskRunInput {
  readonly model: ModelArtifact;
  readonly inputFrames: number;
  /** Size of the file the user picked (compressed), held while decoding. */
  readonly compressedBytes: number;
}

/**
 * Peak memory of an on-device run that streams its input and stems through OPFS (core `separate()` with
 * interleavedFileSource + wavStemSink). Song length only enters through decoding; separation is flat (measured:
 * 616 MiB heap over a whole song on a physical iPhone). Null when the model has no measured browser heap.
 */
export function projectDiskRunPeak({ model, inputFrames, compressedBytes }: DiskRunInput): DiskRunProjection | null {
  if (model.browserHeapBytes === undefined) return null;
  if (!Number.isSafeInteger(inputFrames) || inputFrames < 0) throw new RangeError(`Invalid frame count ${inputFrames}`);
  const io = requireIO(model);
  const pcmBytes = inputFrames * io.channels * 4;
  const decodePeakBytes = Math.max(0, compressedBytes) + DISK_RUN_DECODE_COPIES.value * pcmBytes;
  const accumulator = (io.stems.length * io.channels + 1) * io.segmentFrames * 4;
  const blockInFlight = io.stems.length * io.channels * io.segmentFrames * 4 * 2; // float32 block + its encoded copy (upper bound)
  const inferencePeakBytes = model.browserHeapBytes + accumulator + blockInFlight;
  return {
    kind: 'disk',
    decodePeakBytes,
    inferencePeakBytes,
    projectedPeakBytes: Math.max(decodePeakBytes, inferencePeakBytes),
    hasEstimates: DISK_RUN_DECODE_COPIES.provenance === 'estimate',
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(2)} GiB`;
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(0)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}
