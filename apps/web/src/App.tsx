import { useEffect, useState } from 'react';
import type { Nav } from '@stemsplit/core';
import { REASON_COPY, formatBytes, scopeOption, scopeOptions, screenFor } from '@stemsplit/core';
import { ChooseStems } from './components/ChooseStems.tsx';
import { GpuDiagnostics } from './components/GpuDiagnostics.tsx';
import { Home } from './components/Home.tsx';
import { MobileBenchmark } from './components/MobileBenchmark.tsx';
import { PausedRun } from './components/PausedRun.tsx';
import { StemMixer } from './components/StemMixer.tsx';
import { StoredStems } from './components/StoredStems.tsx';
import { Notice, TopBar } from './components/ui.tsx';
import { Working } from './components/Working.tsx';
import { BUSY_PHASES, useSeparation } from './session.ts';

const DIAGNOSTICS_HASH = '#diagnostics';
const initialNav = (): Nav => (location.hash === DIAGNOSTICS_HASH ? 'diagnostics' : 'auto');

/**
 * One screen at a time (core `screenFor`): home → choose → working → paused / stems. Device checks and the
 * experimental model card live on their own screen (`#diagnostics`), out of the everyday flow.
 */
export function App() {
  const s = useSeparation();
  const [nav, setNavState] = useState<Nav>(initialNav);
  const [benchmarkBusy, setBenchmarkBusy] = useState(false);
  const busy = benchmarkBusy || BUSY_PHASES.has(s.phase.kind);

  const setNav = (next: Nav) => {
    setNavState(next);
    const hash = next === 'diagnostics' ? DIAGNOSTICS_HASH : '';
    if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  };
  useEffect(() => {
    const onHash = () => setNavState(initialNav());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // A finished, paused or failed job brings the user to its outcome.
  useEffect(() => {
    if (BUSY_PHASES.has(s.phase.kind)) setNavState((n) => (n === 'diagnostics' ? n : 'auto'));
  }, [s.phase.kind]);

  const screen = screenFor({ phase: s.phase.kind, hasFile: s.file !== null, stored: s.stored?.state === 'busy' ? null : (s.stored?.state ?? null), nav });
  const deviceWord = s.caps === null || s.caps.formFactor === 'desktop' ? 'computer' : s.caps.formFactor;
  const goHome = () => {
    void s.chooseFile(null);
    setNav('home');
  };
  const p = s.phase;
  const songName = s.file?.name ?? (s.stored && 'sourceName' in s.stored ? s.stored.sourceName : 'Your song');
  const replaces = s.stored && 'sourceName' in s.stored ? s.stored.sourceName : null;

  return (
    <main className="app">
      {screen === 'home' && (
        <Home
          stored={s.stored?.state === 'busy' ? null : s.stored}
          onFile={(f) => {
            setNav('auto');
            void s.chooseFile(f);
          }}
          onOpenStored={() => setNav('stored')}
          onResume={() => {
            setNav('auto');
            void s.resumeStored();
          }}
          onDelete={() => void s.deleteStored()}
          onDiagnostics={() => setNav('diagnostics')}
          error={p.kind === 'error' && !s.file ? p.message : null}
          deviceWord={deviceWord}
          localOnly={!s.serverConfigured}
        />
      )}

      {screen === 'choose' && s.file && (
        <ChooseStems
          fileName={s.file.name}
          fileBytes={s.file.size}
          durationSec={s.duration}
          options={scopeOptions(s.serverConfigured)}
          scope={s.scope}
          onScope={s.setScope}
          plan={s.plan}
          checking={s.decision === null}
          diskPath={s.decision?.target === 'device' && s.decision.storage === 'disk'}
          serverConfigured={s.serverConfigured}
          forceServer={s.preference === 'force-server'}
          onForceServer={(on) => s.setPreference(on ? 'force-server' : 'auto')}
          replaces={s.decision?.target === 'device' && s.decision.storage === 'disk' ? replaces : null}
          error={p.kind === 'error' ? { message: p.message, canRetryOnServer: p.canRetryOnServer } : null}
          queuedOffline={p.kind === 'queued-offline'}
          onStart={(forceServer) => {
            setNav('auto');
            void s.start(forceServer);
          }}
          onBack={goHome}
          onClearCrash={s.clearCrash}
        />
      )}

      {screen === 'working' && (
        <Working
          phase={p.kind}
          fraction={p.kind === 'model-download' || p.kind === 'local' || p.kind === 'uploading' ? p.fraction : p.kind === 'server' ? (p.job.progress?.fraction ?? 0) : null}
          etaSec={p.kind === 'local' ? p.etaSec : p.kind === 'server' ? (p.job.etaSec ?? null) : null}
          totalParts={s.totalParts ?? (s.stored?.state === 'stopped' ? s.stored.total : null)}
          songName={songName}
          scopeTitle={scopeOption(s.scope).title}
          diskActive={s.diskActive}
          onPause={s.pauseDisk}
          queuePosition={p.kind === 'server' ? (p.job.queuePosition ?? null) : null}
        />
      )}

      {screen === 'paused' && (
        <PausedRun
          stored={s.stored?.state === 'busy' ? null : s.stored}
          checking={s.scanning}
          reason={p.kind === 'paused' ? p.reason : null}
          busy={busy}
          onResume={() => {
            setNav('auto');
            void s.resumeStored();
          }}
          onDelete={() => {
            void s.deleteStored();
            goHome();
          }}
          // Paused before anything was stored (hidden during decode): back to the same song's choice.
          onBack={() => (s.file && s.stored?.state !== 'stopped' ? void s.chooseFile(s.file) : goHome())}
        />
      )}

      {screen === 'stems' && (
        <StoredStems
          stored={s.stored?.state === 'busy' ? null : s.stored}
          checking={s.scanning}
          clipped={p.kind === 'disk-done' ? p.clipped : []}
          busy={busy}
          onDelete={() => {
            void s.deleteStored();
            goHome();
          }}
          onBack={goHome}
        />
      )}

      {screen === 'player' && p.kind === 'ready' && s.player.current && (
        <div className="screen">
          <TopBar onBack={goHome} title={s.file?.name ?? 'Your stems'} subtitle={`${p.stems.length} stems · ${p.source === 'server' ? 'from our server' : 'made on this device'}`} />
          <h1 className="visually-hidden">Your stems</h1>
          {p.warnings.map((w) => (
            <Notice key={w.code} tone="warn">
              {w.message}
            </Notice>
          ))}
          <StemMixer player={s.player.current} stems={p.stems} baseName={s.file?.name.replace(/\.[^.]+$/, '') ?? 'stems'} />
        </div>
      )}

      {screen === 'diagnostics' && (
        <div className="screen diagnostics">
          <TopBar onBack={() => setNav('auto')} title="Device check & diagnostics" subtitle="Tools for testing this device" />
          {s.decision && (
            <section className="card">
              <h2>Where the chosen song would run</h2>
              <p>{s.decision.target === 'device' ? `On this device (${s.decision.ep === 'webgpu' ? 'WebGPU' : 'WebAssembly'}, ${s.decision.storage === 'disk' ? 'stems saved to storage' : 'stems in memory'})` : 'On the server'}</p>
              <ul>
                {s.decision.reasons.map((r) => (
                  <li key={r}>{REASON_COPY[r]}</li>
                ))}
              </ul>
              {s.decision.memory && (
                <p className="muted">
                  Projected peak memory {formatBytes(s.decision.memory.projectedPeakBytes)}
                  {s.decision.memory.hasEstimates ? ' (includes estimates)' : ''}.
                </p>
              )}
            </section>
          )}
          <GpuDiagnostics disabled={busy} />
          <MobileBenchmark disabled={busy} onBusy={setBenchmarkBusy} />
        </div>
      )}
    </main>
  );
}
