/**
 * Session orchestration hook: routing decision → device or server path →
 * stems loaded into the player. UI components only render this state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapabilitySnapshot, CreateJobRequest, JobRecord, JobWarning, RouteDecision, SeparationScope, StemName, UserPreference } from '@stemsplit/core';
import { PRIMARY_SEPARATION_MODEL, SCOPE_OUTPUTS, decideRoute } from '@stemsplit/core';
import { ServerClient } from './api/server-client.ts';
import { decodeForModel, probeDuration } from './audio/decode.ts';
import { StemPlayer } from './audio/stem-player.ts';
import { LocalAbortError, runLocal } from './inference/local-client.ts';
import { gatherCapabilities } from './platform/probe.ts';
import { outbox, requestBackgroundFlush } from './platform/outbox.ts';

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8787';

export type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'decoding' }
  | { readonly kind: 'model-download'; readonly fraction: number }
  | { readonly kind: 'local'; readonly fraction: number; readonly etaSec: number | null }
  | { readonly kind: 'uploading'; readonly fraction: number }
  | { readonly kind: 'queued-offline' }
  | { readonly kind: 'server'; readonly job: JobRecord }
  | { readonly kind: 'ready'; readonly stems: readonly StemName[]; readonly source: 'device' | 'server'; readonly warnings: readonly JobWarning[] }
  | { readonly kind: 'error'; readonly message: string; readonly canRetryOnServer: boolean };

const randomKey = () => crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

const CONTENT_TYPES: Readonly<Record<string, string>> = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4', ogg: 'audio/ogg' };

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
  const client = useRef(new ServerClient(API_BASE)).current;

  useEffect(() => {
    void gatherCapabilities().then(setCaps);
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

  const decision: RouteDecision | null =
    caps && file && duration !== null
      ? decideRoute({ caps, input: { durationSec: duration, bytes: file.size }, scope, options: { refinePiano }, preference })
      : null;

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
    setPhase({ kind: 'uploading', fraction: 0 });
    const created = await client.create(request);
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
    if (!navigator.onLine) return;
    for (const entry of await outbox.list()) {
      await outbox.remove(entry.id);
      await runServer(new File([entry.file], entry.request.input.filename), entry.request).catch((e: unknown) =>
        setPhase({ kind: 'error', message: String(e), canRetryOnServer: true }),
      );
    }
  }

  const start = useCallback(
    async (forceServer = false) => {
      if (!file || !decision) return;
      try {
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
          canRetryOnServer: e instanceof LocalAbortError || decision.target === 'device',
        });
        // A local failure may have been a memory kill-in-progress: refresh caps (crash flag).
        void gatherCapabilities().then(setCaps);
      }
    },
    [file, decision, scope, refinePiano, duration],
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
  };
}
