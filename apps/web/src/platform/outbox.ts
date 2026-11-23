/**
 * Offline outbox for server jobs. Entries persist in IndexedDB (file Blob +
 * request) and are flushed on `online`, on SW "flush-outbox" messages, and at
 * startup. The idempotency key makes a flush safe to repeat after a crash.
 */
import type { CreateJobRequest } from '@stemsplit/core';

export interface OutboxEntry {
  readonly id: string;
  readonly request: CreateJobRequest;
  readonly file: Blob;
  readonly queuedAt: number;
}

const DB = 'stemsplit';
const STORE = 'outbox';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const outbox = {
  put: (e: OutboxEntry) => tx('readwrite', (s) => s.put(e)),
  remove: (id: string) => tx('readwrite', (s) => s.delete(id)),
  list: () => tx<OutboxEntry[]>('readonly', (s) => s.getAll() as IDBRequest<OutboxEntry[]>),
};

/** Ask the SW to wake us when connectivity returns (Chromium Background Sync). */
export async function requestBackgroundFlush(): Promise<boolean> {
  const reg = await navigator.serviceWorker?.ready.catch(() => undefined);
  const sync = (reg as (ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }) | undefined)?.sync;
  if (!sync) return false;
  try {
    await sync.register('flush-outbox');
    return true;
  } catch {
    return false;
  }
}
