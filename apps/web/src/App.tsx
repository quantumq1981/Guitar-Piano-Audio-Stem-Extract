import type { SeparationScope } from '@stemsplit/core';
import { SERVER_LIMITS } from '@stemsplit/core';
import { RoutingBanner } from './components/RoutingBanner.tsx';
import { StemMixer } from './components/StemMixer.tsx';
import { useSeparation } from './session.ts';

const SCOPES: ReadonlyArray<{ id: SeparationScope; label: string; detail: string }> = [
  { id: 'quick', label: 'Quick', detail: 'Vocals, drums, bass, other' },
  { id: 'full', label: 'Full', detail: '+ guitar and piano' },
  { id: 'guitar', label: 'Guitar focus', detail: 'Lead / rhythm guitar split (server)' },
];

export function App() {
  const s = useSeparation();
  const busy = ['decoding', 'model-download', 'local', 'uploading', 'server'].includes(s.phase.kind);

  return (
    <main className="app">
      <header>
        <h1>Stem Splitter</h1>
        <p className="muted">Guitar and piano isolation. Phones process on our servers; capable desktops can run on-device.</p>
      </header>

      <section className="card">
        <label className="file">
          <input type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg" disabled={busy} onChange={(e) => void s.chooseFile(e.target.files?.[0] ?? null)} />
          <span>{s.file ? s.file.name : 'Choose an audio file'}</span>
        </label>
        {s.duration !== null && (
          <p className="muted">
            {Math.round(s.duration)} s · {(s.file!.size / 1e6).toFixed(1)} MB
            {s.duration > SERVER_LIMITS.maxDurationSec ? ' · over the 6-minute limit' : ''}
          </p>
        )}

        <fieldset className="scopes" disabled={busy}>
          <legend>Separation</legend>
          {SCOPES.map((o) => (
            <label key={o.id} className={s.scope === o.id ? 'scope scope--on' : 'scope'}>
              <input type="radio" name="scope" value={o.id} checked={s.scope === o.id} onChange={() => s.setScope(o.id)} />
              <span>{o.label}</span>
              <small>{o.detail}</small>
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={s.refinePiano} onChange={(e) => s.setRefinePiano(e.target.checked)} />
            Refine piano (server)
          </label>
          <label className="check">
            <input type="checkbox" checked={s.preference === 'force-server'} onChange={(e) => s.setPreference(e.target.checked ? 'force-server' : 'auto')} />
            Always use the server
          </label>
        </fieldset>

        {s.decision && <RoutingBanner decision={s.decision} />}

        <button type="button" className="primary" disabled={!s.decision || busy} onClick={() => void s.start()}>
          Separate
        </button>
      </section>

      {renderStatus()}

      {s.phase.kind === 'ready' && s.player.current && (
        <>
          {s.phase.warnings.map((w) => (
            <p key={w.code} className="warning">
              {w.message}
            </p>
          ))}
          <StemMixer player={s.player.current} stems={s.phase.stems} baseName={s.file?.name.replace(/\.[^.]+$/, '') ?? 'stems'} />
        </>
      )}
    </main>
  );

  function renderStatus() {
    const p = s.phase;
    switch (p.kind) {
      case 'idle':
      case 'ready':
        return null;
      case 'decoding':
        return <p className="status">Decoding audio…</p>;
      case 'model-download':
        return <Progress label="Downloading model (first run only)" fraction={p.fraction} />;
      case 'local':
        return <Progress label={`Separating on device${p.etaSec !== null ? ` · ~${p.etaSec}s left` : ''}`} fraction={p.fraction} />;
      case 'uploading':
        return <Progress label="Uploading" fraction={p.fraction} />;
      case 'queued-offline':
        return <p className="status">Saved. We will send it to the server when you are back online.</p>;
      case 'server': {
        const j = p.job;
        const label =
          j.status === 'queued'
            ? `Queued${j.queuePosition ? ` · position ${j.queuePosition}` : ''}${j.etaSec ? ` · ~${j.etaSec}s` : ''}`
            : `${j.status[0]!.toUpperCase()}${j.status.slice(1)}${j.etaSec ? ` · ~${j.etaSec}s left` : ''}`;
        return <Progress label={label} fraction={j.progress?.fraction ?? 0} />;
      }
      case 'error':
        return (
          <div className="error">
            <p>{p.message}</p>
            {p.canRetryOnServer && (
              <button type="button" onClick={() => void s.start(true)}>
                Process on our servers instead
              </button>
            )}
          </div>
        );
    }
  }
}

function Progress({ label, fraction }: { label: string; fraction: number }) {
  return (
    <div className="status">
      <span>{label}</span>
      <progress max={1} value={fraction} />
    </div>
  );
}
