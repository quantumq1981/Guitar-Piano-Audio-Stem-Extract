/**
 * The main app's stored on-device run (the disk path's OPFS directory), seen from the page: what a previous run left
 * (finished stems, a stopped run that can resume, or leftovers that cannot), and deleting it. Reads only headers and
 * sizes; the stem Files are disk-backed, so playing or sharing them does not copy them into memory.
 */
import type { StemName } from '@stemsplit/core';
import {
  PRIMARY_SEPARATION_MODEL,
  RUN_INPUT_FILE,
  RUN_MANIFEST_FILE,
  WAV_HEADER_BYTES,
  decideResume,
  isStemName,
  parseRunManifest,
  resumeExpectationFor,
  storedStem,
} from '@stemsplit/core';
import { DEVICE_RUN_DIRECTORY } from '../inference/device-run-protocol.ts';

export interface StoredStemFile {
  readonly stem: StemName;
  readonly file: File;
}

export type StoredDeviceRun =
  | { readonly state: 'complete'; readonly sourceName: string; readonly stems: readonly StoredStemFile[]; readonly bytes: number }
  | { readonly state: 'stopped'; readonly sourceName: string; readonly outputs: readonly StemName[]; readonly done: number; readonly total: number; readonly bytes: number }
  | { readonly state: 'unusable'; readonly reason: string; readonly bytes: number }
  /** A stopping worker still holds some files (terminate() releases OPFS locks asynchronously): scan again soon. */
  | { readonly state: 'busy'; readonly bytes: number };

const LOCKED = Symbol('locked');

async function fileIn(dir: FileSystemDirectoryHandle, name: string): Promise<File | null | typeof LOCKED> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (err) {
    return err instanceof DOMException && err.name === 'NotFoundError' ? null : LOCKED;
  }
}

async function runDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator.storage?.getDirectory !== 'function') return null;
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(DEVICE_RUN_DIRECTORY);
  } catch {
    return null; // nothing stored, or storage blocked (Private Browsing)
  }
}

/** What the last on-device run left, or null when nothing is stored. */
export async function scanDeviceRun(): Promise<StoredDeviceRun | null> {
  const dir = await runDirectory();
  if (!dir) return null;
  const manifestEntry = await fileIn(dir, RUN_MANIFEST_FILE);
  const names: string[] = [];
  for await (const name of (dir as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) names.push(name);
  const entries = await Promise.all(names.map(async (name) => [name, await fileIn(dir, name)] as const));
  const bytes = entries.reduce((sum, [, f]) => sum + (f && f !== LOCKED ? f.size : 0), 0);
  if (entries.some(([, f]) => f === LOCKED) || manifestEntry === LOCKED) return { state: 'busy', bytes };
  if (entries.length === 0) return null;
  if (!manifestEntry) return { state: 'unusable', reason: 'it stopped before the song was stored', bytes };
  const manifest = parseRunManifest(await manifestEntry.text().catch(() => ''));
  if (!manifest) return { state: 'unusable', reason: 'its run.json is not valid', bytes };
  if (!manifest.stems.every(isStemName)) return { state: 'unusable', reason: 'it lists stems this version does not know', bytes };
  const outputs = manifest.stems as readonly StemName[];
  const files = new Map(entries.filter((e): e is readonly [string, File | null] => e[1] !== LOCKED));

  // Finished: every output stem's header promises the whole song and the file holds it (the song file is gone).
  const stems: StoredStemFile[] = [];
  for (const stem of outputs) {
    const file = files.get(`${stem}.wav`);
    if (!file) break;
    const { state, frames } = storedStem(new Uint8Array(await file.slice(0, WAV_HEADER_BYTES).arrayBuffer()), file.size);
    if (state !== 'complete' || frames !== manifest.totalFrames) break;
    stems.push({ stem, file });
  }
  if (stems.length === outputs.length) return { state: 'complete', sourceName: manifest.source.name, stems, bytes };

  let expectation;
  try {
    expectation = resumeExpectationFor(PRIMARY_SEPARATION_MODEL, outputs);
  } catch {
    return { state: 'unusable', reason: 'the current model is not pinned', bytes };
  }
  const d = decideResume(manifest, expectation, {
    inputBytes: files.get(RUN_INPUT_FILE)?.size ?? null,
    stemBytes: outputs.map((s) => files.get(`${s}.wav`)?.size ?? null),
  });
  if (d.kind === 'resume') return { state: 'stopped', sourceName: manifest.source.name, outputs, done: d.startChunk, total: d.plan.chunks.length, bytes };
  return { state: 'unusable', reason: d.kind === 'unusable' ? d.reason : 'its stems are inconsistent', bytes };
}

/** Removes the stored run. Returns the bytes freed. */
export async function deleteDeviceRun(): Promise<number> {
  const before = await scanDeviceRun().catch(() => null);
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(DEVICE_RUN_DIRECTORY, { recursive: true }).catch((err: unknown) => {
    if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err;
  });
  return before?.bytes ?? 0;
}
