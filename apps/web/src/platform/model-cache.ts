/**
 * Model files in Cache Storage, keyed by sha256 so a registry bump can never serve stale weights. An artifact is
 * its graph plus, for external-data models (Stage IV), its weights file; each file is verified once, before its first
 * write, and a corrupt or partial entry is evicted rather than trusted.
 */
import type { ModelArtifact } from '@stemsplit/core';
import { downloadBytes } from '@stemsplit/core';

/** One file of an artifact, as the cache and the downloader see it. */
interface ModelFile {
  readonly role: 'graph' | 'data';
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mirrorSuffix: string;
}

const cacheName = (m: ModelArtifact) => `models-${m.id}`;
const cacheKey = (f: ModelFile) => `/__models/${f.sha256}${f.mirrorSuffix}`;

function filesOf(model: ModelArtifact): ModelFile[] | null {
  if (model.url === null || model.sha256 === null || model.bytes === null) return null;
  const files: ModelFile[] = [{ role: 'graph', url: model.url, bytes: model.bytes, sha256: model.sha256, mirrorSuffix: '.onnx' }];
  const d = model.externalData;
  if (d) files.push({ role: 'data', url: d.url, bytes: d.bytes, sha256: d.sha256, mirrorSuffix: '.onnx.data' });
  return files;
}

export async function isModelCached(model: ModelArtifact): Promise<boolean> {
  const files = filesOf(model);
  if (!('caches' in globalThis) || files === null) return false;
  try {
    const cache = await caches.open(cacheName(model));
    for (const f of files) if ((await cache.match(cacheKey(f))) === undefined) return false;
    return true;
  } catch {
    return false;
  }
}

async function sha256Hex(buf: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ModelIntegrityError extends Error {}

/**
 * Optional self-hosted mirror (e.g. R2/CDN in front of the API), addressed by sha256 (`<sha>.onnx` for a graph,
 * `<sha>.onnx.data` for external data) so a mirror can never serve a different artifact unnoticed. The bytes are
 * still verified against the registry pin after download.
 */
function resolveUrl(f: ModelFile): string {
  const mirror = import.meta.env.VITE_MODEL_MIRROR as string | undefined;
  return mirror ? `${mirror.replace(/\/$/, '')}/${f.sha256}${f.mirrorSuffix}` : f.url;
}

/** Back-compat for callers that only need the graph's URL. */
export function resolveModelUrl(model: ModelArtifact): string {
  const files = filesOf(model);
  if (files === null) throw new Error(`Model ${model.id} has no download URL`);
  return resolveUrl(files[0]!);
}

async function download(f: ModelFile, onBytes: (n: number) => void): Promise<Uint8Array> {
  const res = await fetch(resolveUrl(f), { mode: 'cors', credentials: 'omit' });
  if (!res.ok || !res.body) throw new Error(`Model ${f.role} download failed: HTTP ${res.status}`);
  const buf = new Uint8Array(f.bytes);
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > f.bytes) throw new ModelIntegrityError(`Model ${f.role} is larger than its pinned size`);
    buf.set(value, loaded);
    loaded += value.length;
    onBytes(value.length);
  }
  if (loaded !== f.bytes) throw new ModelIntegrityError(`Model ${f.role} truncated: ${loaded}/${f.bytes} bytes`);
  const actual = await sha256Hex(buf);
  if (actual !== f.sha256) throw new ModelIntegrityError(`Model ${f.role} sha256 ${actual} ≠ pinned ${f.sha256}`);
  return buf;
}

export interface LoadedModel {
  readonly graph: Uint8Array;
  /** External data (weights), when the artifact has it; pass it to ORT as `externalData`. */
  readonly data: Uint8Array | null;
}

/** Returns the model's files, downloading + verifying + caching on first use. */
export async function loadModel(model: ModelArtifact, onProgress: (loaded: number, total: number) => void): Promise<LoadedModel> {
  const files = filesOf(model);
  const total = downloadBytes(model);
  if (files === null || total === null) throw new Error(`Model ${model.id} is not deployable`);
  const cache = await caches.open(cacheName(model));
  const wanted = new Set(files.map(cacheKey));
  // Drop files of older versions of this model id (other sha256s) before downloading new ones.
  for (const req of await cache.keys()) if (!wanted.has(new URL(req.url).pathname)) await cache.delete(req);

  let loaded = 0;
  const out = new Map<ModelFile['role'], Uint8Array>();
  for (const f of files) {
    const hit = await cache.match(cacheKey(f));
    if (hit) {
      const buf = new Uint8Array(await hit.arrayBuffer());
      // A cached file is checked by size only (a full hash on every start would cost seconds on a phone); it was
      // hashed before it was written. A wrong size means a damaged entry: evict it and download again.
      if (buf.byteLength === f.bytes) {
        out.set(f.role, buf);
        loaded += buf.byteLength;
        onProgress(loaded, total);
        continue;
      }
      await cache.delete(cacheKey(f));
    }
    const buf = await download(f, (n) => {
      loaded += n;
      onProgress(loaded, total);
    });
    try {
      await cache.put(cacheKey(f), new Response(buf as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'application/octet-stream' } }));
    } catch (e) {
      // Private browsing / low quota: caching is an optimisation, not a requirement.
      // The run proceeds; the next visit re-downloads (and routing sees modelCached=false).
      console.warn(`Model ${f.role} not cached (${e instanceof Error ? e.message : String(e)}); continuing in memory.`);
    }
    out.set(f.role, buf);
  }
  return { graph: out.get('graph')!, data: out.get('data') ?? null };
}
