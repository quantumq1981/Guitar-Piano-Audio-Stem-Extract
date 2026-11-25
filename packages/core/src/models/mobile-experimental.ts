/**
 * Experimental mobile artifact (Stage IV, docs/MOBILE-INFERENCE-DEVELOPMENT.md). Not in MODEL_REGISTRY and
 * never routed to: it exists so the opt-in device benchmark can load exactly the bytes CI validated.
 *
 * Built deterministically from HTDEMUCS_6S_FOLDED_FP16W by scripts/mobile_graph.py and then
 * scripts/mobile_memory.py --external-data --accurate-reductions. CI and a local rebuild produce identical
 * SHA-256s for both files. Measured in Chromium (WASM, one thread): parity vs native source ≥ 61.9 dB per stem
 * on the music fixture, WASM heap ≤ 616 MiB. It is not yet measured on a physical phone.
 */
import { HTDEMUCS_6S_FOLDED_FP16W, requireIO, type ModelIO } from './registry.ts';

export interface PinnedFile {
  /** File name under `<base>/models/`. The graph records the data file's name, so it must not be renamed. */
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ExternalDataArtifact {
  readonly id: string;
  readonly sourceSha256: string;
  readonly graph: PinnedFile;
  readonly data: PinnedFile;
  readonly io: ModelIO;
  /** ORT session settings the artifact was validated with. Graph optimisation must stay disabled: constant
   * folding would make shapes static and re-enable ORT's buffer-reuse planning (+1.3 GiB, measured).
   * `numThreads` is the default; see STAGE4_THREAD_OPTIONS for the validated alternatives. */
  readonly session: {
    readonly graphOptimizationLevel: 'disabled';
    readonly enableMemPattern: false;
    readonly enableCpuMemArena: false;
    readonly numThreads: 1;
  };
}

export const MOBILE_STAGE4_CANDIDATE: ExternalDataArtifact = {
  id: 'htdemucs_6s-mobile-stage4',
  sourceSha256: HTDEMUCS_6S_FOLDED_FP16W.sha256 ?? '',
  graph: {
    file: 'candidate-memory.onnx',
    bytes: 1_201_735,
    sha256: 'a343b853a28752f05e7188b42b4d1724d97de8ea3057d225bd8a4d76f7fc1110',
  },
  data: {
    file: 'candidate-memory.onnx.data',
    bytes: 129_090_048,
    sha256: '514978cfe52041f8272a52f91510b5f930cf9bc90504fccd5a51800f976069db',
  },
  io: requireIO(HTDEMUCS_6S_FOLDED_FP16W),
  session: { graphOptimizationLevel: 'disabled', enableMemPattern: false, enableCpuMemArena: false, numThreads: 1 },
};

/**
 * WASM thread counts the experimental card offers. Measured in Chromium (4 vCPU, music fixture, ORT 1.31.1):
 * parity is unchanged by threading (minimum 84.1 dB per stem vs native at 1, 2 and 4 threads, repeats
 * bit-identical); one window takes 18.0 / 9.7–10.0 / 5.5–6.8 s; the heap is 515 / 515 / 618 MiB.
 */
export const STAGE4_THREAD_OPTIONS: readonly number[] = [1, 2, 4];

export interface ThreadEnvironment {
  /** ORT's WASM threads share memory, which needs SharedArrayBuffer and so a cross-origin isolated page. */
  readonly crossOriginIsolated: boolean;
  /** `navigator.hardwareConcurrency`; absent or invalid means unknown. */
  readonly hardwareConcurrency?: number;
}

/** Threads to actually use for `requested`: 1 unless the page is isolated, and never more than the reported cores. */
export function stage4Threads(requested: number, env: ThreadEnvironment): number {
  if (!Number.isFinite(requested) || requested < 1 || !env.crossOriginIsolated) return 1;
  const cores = env.hardwareConcurrency;
  const limit = cores !== undefined && Number.isFinite(cores) && cores >= 1 ? Math.floor(cores) : Infinity;
  return Math.max(1, Math.min(Math.floor(requested), limit));
}

/** One WebAssembly page is 64 KiB. */
export const WASM_PAGE_BYTES = 65_536;

/**
 * Maximum sizes tried, in pages, for a shared WebAssembly.Memory that asks for more. ORT's threaded build
 * requests a 4 GiB maximum. A shared memory cannot move, so Safari must reserve that address space up front,
 * and on a phone already holding the page that reservation can fail (seen in Tab Translator Pro on iPhone).
 * The Stage IV candidate's heap peaks at 616 MiB in Chromium, so 1 GiB and then 768 MiB leave room.
 */
export const WASM_CAP_LADDER_PAGES: readonly number[] = [16_384, 12_288];

/** Structural `WebAssembly.MemoryDescriptor` (core is built without DOM types). Sizes are in pages. */
export interface WasmMemoryDescriptor {
  readonly initial: number;
  readonly maximum?: number;
  readonly shared?: boolean;
}

/** Lower `maximum` of a shared memory descriptor to `capPages`; every other descriptor passes through unchanged. */
export function capWasmMemoryDescriptor<T extends WasmMemoryDescriptor>(descriptor: T, capPages: number): T {
  if (descriptor.shared !== true || descriptor.maximum === undefined || descriptor.maximum <= capPages) return descriptor;
  return { ...descriptor, maximum: Math.max(capPages, descriptor.initial) };
}

/**
 * Bytes of a WebAssembly heap that were ever written: grown pages stay zero and non-resident until used, and a
 * freed page keeps its old bytes. Counts 4 KiB pages holding any non-zero byte. This is closer to what a phone
 * must commit than `buffer.byteLength`, which includes emscripten's geometric growth slack.
 */
export function touchedBytes(heap: ArrayBufferLike, pageBytes = 4096): number {
  const words = new Uint32Array(heap, 0, Math.floor(heap.byteLength / 4));
  const step = pageBytes / 4;
  let pages = 0;
  for (let start = 0; start < words.length; start += step) {
    const end = Math.min(start + step, words.length);
    for (let i = start; i < end; i++) {
      if (words[i] !== 0) {
        pages++;
        break;
      }
    }
  }
  return pages * pageBytes;
}

/**
 * Deterministic planar stereo test window ([channels][frames]): a chord, a bass line, noise bursts and a vibrato
 * tone, so every stem head sees some energy. It is meant for memory and stability measurement; numerical
 * parity is gated in CI on scripts/mobile_fixture.py.
 */
export function stage4TestSignal(frames: number, channels = 2, sampleRate = 44_100): Float32Array {
  const out = new Float32Array(channels * frames);
  let seed = 0x2545f491;
  const noise = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 2_147_483_648 - 1;
  };
  const chord = [261.63, 329.63, 392];
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const beat = t % 0.5;
    const burst = beat < 0.05 ? noise() * 0.3 * (1 - beat / 0.05) : 0;
    const bass = 0.2 * Math.sin(2 * Math.PI * 65.41 * t);
    const tone = 0.08 * Math.sin(2 * Math.PI * 440 * t + 0.6 * Math.sin(2 * Math.PI * 5.5 * t));
    let pad = 0;
    for (const f of chord) pad += 0.05 * Math.sin(2 * Math.PI * f * t);
    for (let c = 0; c < channels; c++) {
      const side = c === 0 ? 0.6 : 0.4;
      out[c * frames + i] = burst + bass + tone * (1 - side) + pad * side;
    }
  }
  return out;
}

/** Largest absolute difference between two equal-length outputs, or Infinity if the lengths differ. */
export function maxAbsDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return worst;
}
