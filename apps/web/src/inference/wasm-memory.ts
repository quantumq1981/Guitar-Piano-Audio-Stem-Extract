/**
 * Caps (and tracks) the shared WebAssembly.Memory that ONNX Runtime's threaded WASM build creates. ORT asks for a
 * 4 GiB maximum; a shared memory cannot move, so Safari must reserve that address space up front and may refuse.
 * The ladder comes from the artifact's validated `browserWasmMemoryCapPages` (core registry).
 *
 * Must be installed before ORT is imported (ORT creates its memory while initialising). Idempotent: the first
 * ladder installed wins, and later calls only return the tracker.
 */
import { capWasmMemoryDescriptor, touchedBytes } from '@stemsplit/core';

export interface WasmMemoryTracker {
  /** "WASM heap N MiB (touched M MiB)" over every memory created since installation. */
  heap(): string;
  /** What happened to the last requested maximum. */
  readonly capNote: string;
}

const mib = (bytes: number) => (bytes / 2 ** 20).toFixed(0) + ' MiB';
let tracker: WasmMemoryTracker | null = null;

export function installWasmMemoryCap(ladderPages: readonly number[]): WasmMemoryTracker {
  if (tracker) return tracker;
  const memories: WebAssembly.Memory[] = [];
  let capNote = 'no shared memory requested';
  const NativeMemory = WebAssembly.Memory;
  function CappedMemory(descriptor: WebAssembly.MemoryDescriptor): WebAssembly.Memory {
    let lastError: unknown;
    for (const cap of ladderPages) {
      const capped = capWasmMemoryDescriptor(descriptor, cap);
      try {
        const memory = new NativeMemory(capped);
        memories.push(memory);
        capNote = capped === descriptor ? 'requested maximum kept' : `maximum capped at ${mib(cap * 65_536)}`;
        return memory;
      } catch (error) {
        if (!(error instanceof RangeError) || capped === descriptor) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
  CappedMemory.prototype = NativeMemory.prototype;
  (WebAssembly as unknown as { Memory: unknown }).Memory = CappedMemory;
  tracker = {
    heap() {
      const reserved = memories.reduce((sum, m) => sum + m.buffer.byteLength, 0);
      const touched = memories.reduce((sum, m) => sum + touchedBytes(m.buffer), 0);
      return `WASM heap ${mib(reserved)} (touched ${mib(touched)})`;
    },
    get capNote() {
      return capNote;
    },
  };
  return tracker;
}
