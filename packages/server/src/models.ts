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

export async function ensureModel(model: ModelArtifact, log: (msg: string) => void = () => {}): Promise<string> {
  if (model.availability !== 'published' || model.url === null) {
    throw new Error(`Model ${model.id} is not downloadable (availability: ${model.availability})`);
  }
  const target = modelPath(model);
  if (await exists(target)) {
    if (model.sha256 === null || (await sha256File(target)) === model.sha256) return target;
    log(`Cached ${target} failed sha256 verification; re-downloading`);
    await rm(target);
  }
  await mkdir(dirname(target), { recursive: true });
  const part = `${target}.part`;
  log(`Downloading ${model.url}`);
  const res = await fetch(model.url);
  if (!res.ok || res.body === null) throw new Error(`Download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(part));
  if (model.sha256 !== null) {
    const actual = await sha256File(part);
    if (actual !== model.sha256) {
      await rm(part);
      throw new Error(`Downloaded ${model.id} sha256 ${actual} ≠ pinned ${model.sha256}`);
    }
  }
  await rename(part, target);
  log(`Model ready at ${target}`);
  return target;
}
