/**
 * Session orchestration hook: routing decision → device or server path →
 * stems loaded into the player. UI components only render this state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapabilitySnapshot, CreateJobRequest, JobRecord, JobWarning, RouteDecision, SeparationScope, StemName, UserPreference } from '@stemsplit/core';
import { PRIMARY_SEPARATION_MODEL, SCOPE_OUTPUTS, decideRoute, deviceOutputs, deviceThreads, estimateDeviceSeconds, requireIO } from '@stemsplit/core';
import { ServerClient } from './api/server-client.ts';
import { decodeForModel, probeDuration } from './audio/decode.ts';
import { StemPlayer } from './audio/stem-player.ts';
import { DiskRunStopped, runOnDisk, type DiskRunHandle } from './inference/disk-run-client.ts';
import { LocalAbortError, runLocal } from './inference/local-client.ts';
import { clearCrashFlag } from './platform/crash-flag.ts';
import { deleteDeviceRun, scanDeviceRun, type StoredDeviceRun } from './platform/disk-store.ts';
import { gatherCapabilities } from './platform/probe.ts';
import { outbox, requestBackgroundFlush } from './platform/outbox.ts';

/**
 * Processing-server base URL. Static hosts (GitHub Pages) serve only the PWA, so
 * a production build without VITE_API_BASE has *no* server: device-eligible jobs
 * still run, server-routed ones explain why they cannot. An https page also
 * cannot call an http API (mixed content), so production values must be https.
 */
const configuredApi = (import.meta.env.VITE_API_BASE as string | undefined)?.trim();
export const API_BASE: string | null = configuredApi ? configuredApi : import.meta.env.DEV ? 'http://localhost:8787' : null;

export const NO_SERVER_MESSAGE =
  'This build has no processing server configured, and this job needs one (the guitar lead/rhythm split, piano refinement, and tracks over the on-device limits run on the server). ' +
  'Deploy `stemsplit serve` behind HTTPS and rebuild with VITE_API_BASE set — see README › GitHub Pages.';

export type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'decoding' }
  | { readonly kind: 'model-download'; readonly fraction: number }
  | { readonly kind: 'local'; readonly fraction: number; readonly etaSec: number | null }
  | { readonly kind: 'waking' }
  | { readonly kind: 'uploading'; readonly fraction: number }
  | { readonly kind: 'queued-offline' }
  | { readonly kind: 'server'; readonly job: JobRecord }
  | { readonly kind: 'ready'; readonly stems: readonly StemName[]; readonly source: 'device' | 'server'; readonly warnings: readonly JobWarning[] }
  /** A disk-path run stopped before the end; `stored` holds what can resume. */
  | { readonly kind: 'paused'; readonly reason: string }
  /** A disk-path run finished; its stems are in `stored` (they survive a reload). */
  | { readonly kind: 'disk-done'; readonly clipped: readonly string[] }
  | { readonly kind: 'error'; readonly message: string; readonly canRetryOnServer: boolean };

/** Phases during which a job is running (inputs and other jobs are locked). */
export const BUSY_PHASES: ReadonlySet<Phase['kind']> = new Set(['decoding', 'model-download', 'local', 'waking', 'uploading', 'server']);

const randomKey = () => crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

const CONTENT_TYPES: Readonly<Record<string, string>> = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4', ogg: 'audio/ogg' };

export class NoServerError extends Error {
  constructor() {
    super(NO_SERVER_MESSAGE);
    this.name = 'NoServerError';
  }
}

/** `?debug=1` exposes the player for automated parity tests (scripts/e2e). */
function exposeDebug(player: StemPlayer): void {
  if (new URLSearchParams(location.search).has('debug')) (globalThis as { __stemsplit?: unknown }).__stemsplit = { player };
}

export function useSeparation() {
  const [caps, setCaps] = useState<CapabilitySnapshot | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [scope, setScope] = useState<SeparationScope>('full');
  const [refinePiano, setRefinePiano] = useState(false);
  const [preference, setPreference] = useState<UserPreference>('auto');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const playerRef = useRef<StemPlayer | null>(null);
  const client = useRef(API_BASE ? new ServerClient(API_BASE) : null).current;
  const [stored, setStored] = useState<StoredDeviceRun | null>(null);
  const diskRun = useRef<DiskRunHandle | null>(null);
  const [diskActive, setDiskActive] = useState(false);

  // What the last on-device run left (finished stems, or a stopped run to resume). A stopping worker releases its
  // file locks shortly after terminate(), so a 'busy' scan is retried.
  const refreshStored = useCallback(async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await scanDeviceRun().catch(() => null);
      if (result?.state !== 'busy') {
        setStored(result);
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    setStored(null);
    return null;
  }, []);

  useEffect(() => {
    void gatherCapabilities().then(setCaps);
    void refreshStored();
    const online = () => {
      void gatherCapabilities().then(setCaps);
      void flushOutbox();
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', online);
    navigator.serviceWorker?.addEventListener('message', (e: MessageEvent<{ type?: string }>) => {
      if (e.data?.type === 'flush-outbox') void flushOutbox();
    });
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', online);
    };
  }, []);

  const chooseFile = useCallback(async (f: File | null) => {
    setFile(f);
    setDuration(f ? await probeDuration(f) : null);
    setPhase({ kind: 'idle' });
  }, []);

  // A new on-device run replaces the stored one, so its bytes count as free for the storage check.
  const effectiveCaps: CapabilitySnapshot | null =
    caps && stored && caps.storageAvailableBytes !== null ? { ...caps, storageAvailableBytes: caps.storageAvailableBytes + stored.bytes } : caps;
  const decision: RouteDecision | null =
    effectiveCaps && file && duration !== null
      ? decideRoute({ caps: effectiveCaps, input: { durationSec: duration, bytes: file.size }, scope, options: { refinePiano }, preference })
      : null;
  const io = requireIO(PRIMARY_SEPARATION_MODEL);
  const estimateSec =
    decision?.target === 'device' && caps && duration !== null ? estimateDeviceSeconds(duration, decision.threads, caps.formFactor, io.segmentFrames, io.sampleRate) : null;

  const freshPlayer = async (): Promise<StemPlayer> => {
    await playerRef.current?.close();
    playerRef.current = new StemPlayer();
    return playerRef.current;
  };

  const buildRequest = (f: File): CreateJobRequest => ({
    scope,
    options: { refinePiano, formats: ['wav24', 'mp3'] },
    input: { filename: f.name, bytes: f.size, contentType: f.type || CONTENT_TYPES[f.name.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream', durationSec: duration },
    clientModelSha256: PRIMARY_SEPARATION_MODEL.sha256,
    idempotencyKey: randomKey(),
  });

  async function runServer(f: File, request: CreateJobRequest): Promise<void> {
    if (!client) throw new NoServerError();
    setPhase({ kind: 'uploading', fraction: 0 });
    const created = await client.create(request, { onWaiting: () => setPhase({ kind: 'waking' }) });
    let job = await client.upload(created, f, (fraction) => setPhase({ kind: 'uploading', fraction }));
    for await (const next of client.watch(job)) {
      job = next;
      setPhase({ kind: 'server', job });
    }
    if (job.status !== 'succeeded') throw new Error(job.error?.message ?? `Job ${job.status}`);
    const player = await freshPlayer();
    const wavs = job.stems.filter((s) => s.format === 'wav24');
    await Promise.all(
      wavs.map(async (s) => {
        const bytes = await (await fetch(s.url)).arrayBuffer();
        player.setStemBuffer(s.stem, await player.context.decodeAudioData(bytes));
      }),
    );
    exposeDebug(player);
    setPhase({ kind: 'ready', stems: wavs.map((s) => s.stem), source: 'server', warnings: job.warnings });
  }

  async function flushOutbox(): Promise<void> {
    if (!navigator.onLine || !client) return;
    for (const entry of await outbox.list()) {
      await outbox.remove(entry.id);
      await runServer(new File([entry.file], entry.request.input.filename), entry.request).catch((e: unknown) =>
        setPhase({ kind: 'error', message: String(e), canRetryOnServer: true }),
      );
    }
  }

  /** Drives a disk-path run (start or resume) to its end, a pause, or an error. */
  async function driveDisk(handle: DiskRunHandle): Promise<void> {
    diskRun.current = handle;
    setDiskActive(true);
    try {
      const { clipped } = await handle.done;
      setPhase({ kind: 'disk-done', clipped });
    } catch (e) {
      if (e instanceof DiskRunStopped) setPhase({ kind: 'paused', reason: e.reason });
      else setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e), canRetryOnServer: client !== null });
    } finally {
      diskRun.current = null;
      setDiskActive(false);
      await refreshStored();
      void gatherCapabilities().then(setCaps); // storage changed
    }
  }

  const diskCallbacks = {
    onModelProgress: (loaded: number, total: number) => setPhase({ kind: 'model-download', fraction: loaded / total }),
    onProgress: (p: { fraction: number; etaMs: number | null }) =>
      setPhase({ kind: 'local', fraction: p.fraction, etaSec: p.etaMs === null ? null : Math.round(p.etaMs / 1000) }),
  };

  async function startDisk(f: File, threads: number): Promise<void> {
    setPhase({ kind: 'decoding' });
    await playerRef.current?.close();
    playerRef.current = null;
    setStored(null); // hide the old stems at once; the new run replaces them (their space was counted as free)
    await deleteDeviceRun();
    const input = await decodeForModel(f);
    // Own buffers, so they can be transferred; the decoded AudioBuffer is then free to be collected.
    const left = input.left.slice();
    const right = input.right.slice();
    await driveDisk(runOnDisk({ type: 'start', left, right, outputs: deviceOutputs(scope), threads, source: { name: f.name, bytes: f.size } }, diskCallbacks));
  }

  const resumeStored = useCallback(async () => {
    if (stored?.state !== 'stopped' || !caps || diskRun.current) return;
    setPhase({ kind: 'local', fraction: stored.done / stored.total, etaSec: null });
    await driveDisk(runOnDisk({ type: 'resume', outputs: stored.outputs, threads: deviceThreads(caps) }, diskCallbacks));
  }, [stored, caps]);

  const pauseDisk = useCallback(() => diskRun.current?.stop('you paused it'), []);

  const deleteStored = useCallback(async () => {
    if (diskRun.current) return;
    await deleteDeviceRun().catch(() => 0);
    setPhase({ kind: 'idle' });
    await refreshStored();
    void gatherCapabilities().then(setCaps);
  }, [refreshStored]);

  /** A crash marker locks the in-memory path out; without a server that is permanent, so let the user clear it. */
  const clearCrash = useCallback(() => {
    clearCrashFlag();
    void gatherCapabilities().then(setCaps);
  }, []);

  const start = useCallback(
    async (forceServer = false) => {
      if (!file || !decision) return;
      try {
        if (decision.target === 'device' && decision.storage === 'disk' && !forceServer) {
          await startDisk(file, decision.threads);
          return;
        }
        if (decision.target === 'device' && !forceServer) {
          setPhase({ kind: 'decoding' });
          const input = await decodeForModel(file);
          const stems = await runLocal(decision.ep, input.left, input.right, SCOPE_OUTPUTS[scope], {
            onModelProgress: (loaded, total) => setPhase({ kind: 'model-download', fraction: loaded / total }),
            onProgress: (p) => setPhase({ kind: 'local', fraction: p.fraction, etaSec: p.etaMs === null ? null : Math.round(p.etaMs / 1000) }),
          });
          const player = await freshPlayer();
          for (const [stem, [l, r]] of stems) player.setStem(stem, l, r);
          exposeDebug(player);
          setPhase({ kind: 'ready', stems: [...stems.keys()], source: 'device', warnings: [] });
          return;
        }
        if (decision.target === 'server' && decision.rejected) {
          setPhase({
            kind: 'error',
            message: decision.rejected === 'too_long' ? 'Tracks are limited to 6 minutes. Trim the file and try again.' : 'Files are limited to 64 MB.',
            canRetryOnServer: false,
          });
          return;
        }
        if (!client) throw new NoServerError();
        const request = buildRequest(file);
        if (!navigator.onLine) {
          await outbox.put({ id: request.idempotencyKey, request, file, queuedAt: Date.now() });
          await requestBackgroundFlush();
          setPhase({ kind: 'queued-offline' });
          return;
        }
        await runServer(file, request);
      } catch (e) {
        setPhase({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
          canRetryOnServer: client !== null && (e instanceof LocalAbortError || decision.target === 'device'),
        });
        // A local failure may have been a memory kill-in-progress: refresh caps (crash flag).
        void gatherCapabilities().then(setCaps);
      }
    },
    [file, decision, scope, refinePiano, duration, stored],
  );

  return {
    caps,
    file,
    duration,
    scope,
    setScope,
    refinePiano,
    setRefinePiano,
    preference,
    setPreference,
    decision,
    phase,
    chooseFile,
    start,
    player: playerRef,
    serverConfigured: client !== null,
    estimateSec,
    stored,
    resumeStored,
    pauseDisk,
    diskActive,
    deleteStored,
    clearCrash,
  };
}
