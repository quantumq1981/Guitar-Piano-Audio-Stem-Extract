/** Client-side export: WAV via the shared core codec, shared with the Web Share API when possible. */
import type { StemName } from '@stemsplit/core';
import { MODEL_SAMPLE_RATE, encodeWav } from '@stemsplit/core';

export function stemToWavBlob(left: Float32Array, right: Float32Array, bits: 16 | 24): Blob {
  const bytes = encodeWav([left, right], { sampleRate: MODEL_SAMPLE_RATE, channels: 2, sampleFormat: bits === 16 ? 'pcm16' : 'pcm24' });
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/wav' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function shareFiles(files: File[]): Promise<boolean> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (!nav.share || !nav.canShare?.({ files })) return false;
  try {
    await nav.share({ files, title: 'Stems' });
    return true;
  } catch {
    return false;
  }
}

export function stemFilename(base: string, stem: StemName, bits: 16 | 24): string {
  return `${base} - ${stem}${bits === 24 ? ' (24-bit)' : ''}.wav`;
}
