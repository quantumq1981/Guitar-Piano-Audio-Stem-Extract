/**
 * Model cache: download once, verify sha256, atomically rename into place.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { ModelArtifact } from '@stemsplit/core';
import { sha256File } from './ort-runner.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function modelsDir(): string {
  return process.env.STEMSPLIT_MODELS_DIR ?? join(REPO_ROOT, 'models');
}

export function modelPath(model: ModelArtifact): string {
  return join(modelsDir(), `${model.id}.onnx`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Where `model`'s external data must sit: next to the graph, under the name the graph records. */
export function externalDataPath(model: ModelArtifact): string | null {
  return model.externalData ? join(dirname(modelPath(model)), model.externalData.file) : null;
}

/** Downloads `url` to `target` unless a file there already has `sha256`; verifies before the atomic rename. */
async function ensureFile(url: string, target: string, sha256: string | null, label: string, log: (msg: string) => void): Promise<void> {
  if (await exists(target)) {
    if (sha256 === null || (await sha256File(target)) === sha256) return;
    log(`Cached ${target} failed sha256 verification; re-downloading`);
    await rm(target);
  }
  await mkdir(dirname(target), { recursive: true });
  const part = `${target}.part`;
  log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || res.body === null) throw new Error(`Download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(part));
  if (sha256 !== null) {
    const actual = await sha256File(part);
    if (actual !== sha256) {
      await rm(part);
      throw new Error(`Downloaded ${label} sha256 ${actual} ≠ pinned ${sha256}`);
    }
  }
  await rename(part, target);
}

/** Ensures the graph (and its external data, if any) are present and verified; returns the graph path. */
export async function ensureModel(model: ModelArtifact, log: (msg: string) => void = () => {}): Promise<string> {
  if (model.availability !== 'published' || model.url === null) {
    throw new Error(`Model ${model.id} is not downloadable (availability: ${model.availability})`);
  }
  const target = modelPath(model);
  // Data first: a graph without its data cannot be opened, so never leave that state as "ready".
  if (model.externalData) {
    await ensureFile(model.externalData.url, externalDataPath(model)!, model.externalData.sha256, `${model.id} external data`, log);
  }
  await ensureFile(model.url, target, model.sha256, model.id, log);
  log(`Model ready at ${target}`);
  return target;
}
