/**
 * Model weights in Cache Storage, keyed by sha256 so a registry bump can never
 * serve stale weights. Verification happens once, before the first write.
 */
import type { ModelArtifact } from '@stemsplit/core';

const cacheName = (m: ModelArtifact) => `models-${m.id}`;
const cacheKey = (m: ModelArtifact) => `/__models/${m.sha256 ?? 'unpinned'}.onnx`;

export async function isModelCached(model: ModelArtifact): Promise<boolean> {
  if (!('caches' in globalThis) || model.sha256 === null) return false;
  try {
    return (await (await caches.open(cacheName(model))).match(cacheKey(model))) !== undefined;
  } catch {
    return false;
  }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ModelIntegrityError extends Error {}

/**
 * Optional self-hosted mirror (e.g. R2/CDN in front of the API), addressed by
 * sha256 so a mirror can never serve a different artifact unnoticed. The bytes
 * are still verified against the registry pin after download.
 */
export function resolveModelUrl(model: ModelArtifact): string {
  const mirror = import.meta.env.VITE_MODEL_MIRROR as string | undefined;
  if (mirror && model.sha256) return `${mirror.replace(/\/$/, '')}/${model.sha256}.onnx`;
  if (model.url === null) throw new Error(`Model ${model.id} has no download URL`);
  return model.url;
}

/** Returns the model bytes, downloading + verifying + caching on first use. */
export async function loadModel(model: ModelArtifact, onProgress: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  if (model.url === null || model.sha256 === null || model.bytes === null) throw new Error(`Model ${model.id} is not deployable`);
  const cache = await caches.open(cacheName(model));
  const hit = await cache.match(cacheKey(model));
  if (hit) {
    const buf = await hit.arrayBuffer();
    onProgress(buf.byteLength, buf.byteLength);
    return buf;
  }
  // Drop any older versions of this model id before downloading the new one.
  for (const req of await cache.keys()) await cache.delete(req);

  const res = await fetch(resolveModelUrl(model), { mode: 'cors', credentials: 'omit' });
  if (!res.ok || !res.body) throw new Error(`Model download failed: HTTP ${res.status}`);
  const total = model.bytes;
  const buf = new Uint8Array(total);
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > total) throw new ModelIntegrityError('Model is larger than its pinned size');
    buf.set(value, loaded);
    loaded += value.length;
    onProgress(loaded, total);
  }
  if (loaded !== total) throw new ModelIntegrityError(`Model truncated: ${loaded}/${total} bytes`);
  const actual = await sha256Hex(buf.buffer);
  if (actual !== model.sha256) throw new ModelIntegrityError(`Model sha256 ${actual} ≠ pinned ${model.sha256}`);
  try {
    await cache.put(cacheKey(model), new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch (e) {
    // Private browsing / low quota: caching is an optimisation, not a requirement.
    // The run proceeds; the next visit re-downloads (and routing sees modelCached=false).
    console.warn(`Model not cached (${e instanceof Error ? e.message : String(e)}); continuing in memory.`);
  }
  return buf.buffer;
}
