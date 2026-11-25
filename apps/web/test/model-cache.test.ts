import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelArtifact } from '@stemsplit/core';
import { HTDEMUCS_6S_STAGE4 } from '@stemsplit/core';
import { ModelIntegrityError, isModelCached, loadModel } from '../src/platform/model-cache.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const graph = new Uint8Array([1, 2, 3, 4, 5]);
const data = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));

/** A two-file artifact shaped like Stage IV, with tiny pinned files. */
const model: ModelArtifact = {
  ...HTDEMUCS_6S_STAGE4,
  id: 'test-model',
  url: 'https://models.test/graph.onnx',
  bytes: graph.length,
  sha256: sha(graph),
  externalData: { file: 'graph.onnx.data', url: 'https://models.test/graph.onnx.data', bytes: data.length, sha256: sha(data) },
};

/** In-memory stand-in for Cache Storage (keys are request paths). */
function fakeCaches() {
  const stores = new Map<string, Map<string, Uint8Array>>();
  const open = async (name: string) => {
    const store = stores.get(name) ?? new Map<string, Uint8Array>();
    stores.set(name, store);
    return {
      match: async (key: string) => (store.has(key) ? new Response(store.get(key)! as Uint8Array<ArrayBuffer>) : undefined),
      put: async (key: string, res: Response) => void store.set(key, new Uint8Array(await res.arrayBuffer())),
      delete: async (key: string | Request) => store.delete(typeof key === 'string' ? key : new URL(key.url).pathname),
      keys: async () => [...store.keys()].map((k) => new Request(`https://app.test${k}`)),
    };
  };
  return { stores, api: { open } };
}

let served: Record<string, Uint8Array>;
let fetches: string[];
let cachesFake: ReturnType<typeof fakeCaches>;

beforeEach(() => {
  served = { [model.url!]: graph, [model.externalData!.url]: data };
  fetches = [];
  cachesFake = fakeCaches();
  vi.stubGlobal('caches', cachesFake.api);
  vi.stubGlobal('fetch', async (url: string) => {
    fetches.push(url);
    const body = served[url];
    return body ? new Response(body as Uint8Array<ArrayBuffer>) : new Response(null, { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('model cache (graph + external data)', () => {
  it('downloads and verifies both files, reports progress over both, then serves them from the cache', async () => {
    const progress: number[] = [];
    const first = await loadModel(model, (loaded, total) => {
      expect(total).toBe(graph.length + data.length);
      progress.push(loaded);
    });
    expect(first.graph).toEqual(graph);
    expect(first.data).toEqual(data);
    expect(progress.at(-1)).toBe(graph.length + data.length);
    expect(fetches).toHaveLength(2);
    expect(await isModelCached(model)).toBe(true);

    const second = await loadModel(model, () => {});
    expect(second.data).toEqual(data);
    expect(fetches).toHaveLength(2); // no network on a cache hit
  });

  it('rejects a file whose bytes do not match its pin', async () => {
    served[model.externalData!.url] = data.map((b) => b ^ 1);
    await expect(loadModel(model, () => {})).rejects.toBeInstanceOf(ModelIntegrityError);
    expect(await isModelCached(model)).toBe(false);
  });

  it('rejects truncated and oversized downloads', async () => {
    served[model.externalData!.url] = data.subarray(0, 10);
    await expect(loadModel(model, () => {})).rejects.toThrow(/truncated/);
    served[model.externalData!.url] = new Uint8Array(data.length + 1);
    await expect(loadModel(model, () => {})).rejects.toThrow(/larger than/);
  });

  it('evicts a damaged cached entry and downloads it again', async () => {
    await loadModel(model, () => {});
    const store = cachesFake.stores.get('models-test-model')!;
    store.set(`/__models/${model.externalData!.sha256}.onnx.data`, data.subarray(0, 3));
    const again = await loadModel(model, () => {});
    expect(again.data).toEqual(data);
    expect(fetches.filter((u) => u === model.externalData!.url)).toHaveLength(2);
  });

  it('drops files of older versions of the same model id', async () => {
    const store = (await cachesFake.api.open('models-test-model'), cachesFake.stores.get('models-test-model')!);
    store.set('/__models/0000.onnx', new Uint8Array([9]));
    await loadModel(model, () => {});
    expect([...store.keys()].sort()).toEqual([`/__models/${model.sha256}.onnx`, `/__models/${model.externalData!.sha256}.onnx.data`].sort());
  });

  it('works for a single-file artifact (rollback to v1)', async () => {
    const { externalData: _omitted, ...single } = model;
    const loaded = await loadModel(single, () => {});
    expect(loaded.data).toBeNull();
    expect(fetches).toEqual([model.url]);
  });
});
