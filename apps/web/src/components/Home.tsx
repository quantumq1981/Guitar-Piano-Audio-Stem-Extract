import type { StoredDeviceRun } from '../platform/disk-store.ts';
import { Icon, Notice, mb } from './ui.tsx';

const ACCEPT = 'audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg';

/** Start screen: pick a song, and see what is saved on this device. */
export function Home({ stored, onFile, onOpenStored, onResume, onDelete, onDiagnostics, error, deviceWord, localOnly }: {
  stored: StoredDeviceRun | null;
  onFile: (file: File | null) => void;
  onOpenStored: () => void;
  onResume: () => void;
  onDelete: () => void;
  onDiagnostics: () => void;
  /** A failure with no song chosen (e.g. a resume that failed). */
  error: string | null;
  /** "phone", "tablet" or "computer". */
  deviceWord: string;
  /** No server in this build: nothing ever leaves the device. */
  localOnly: boolean;
}) {
  return (
    <div className="screen screen--home">
      <header className="brand">
        <Icon name="bars" size={26} />
        <span>Stem Splitter</span>
      </header>

      <section className="card hero">
        <div className="hero__badge">
          <Icon name="note" size={30} />
        </div>
        <h1>Pull a song apart</h1>
        <p className="muted">Vocals, drums, bass, guitar and piano, each on its own track. {localOnly ? `It all happens on this ${deviceWord}. Nothing is uploaded.` : `It runs on this ${deviceWord} when it can, and on our server when you ask for more.`}</p>
        <label className="button button--primary button--wide file-pick">
          <input type="file" accept={ACCEPT} className="visually-hidden" onChange={(e) => {
            onFile(e.target.files?.[0] ?? null);
            e.target.value = ''; // picking the same song again still fires
          }} />
          <Icon name="plus" />
          Choose a song
        </label>
        <p className="fine">MP3, WAV, M4A or FLAC · up to 10 minutes</p>
      </section>

      {error && <Notice tone="problem" title="That didn’t work">{error}</Notice>}

      {stored && (
        <section className="stack">
          <h2 className="eyebrow">On this {deviceWord}</h2>
          {stored.state === 'complete' && (
            <button type="button" className="row-card" onClick={onOpenStored}>
              <span className="row-card__icon row-card__icon--stems" aria-hidden="true">
                <Icon name="bars" />
              </span>
              <span className="row-card__text">
                <span className="row-card__title">{stored.sourceName}</span>
                <span className="row-card__meta">
                  {stored.stems.length} stems · {mb(stored.bytes)}
                </span>
              </span>
              <Icon name="chevron" />
            </button>
          )}
          {stored.state === 'stopped' && (
            <div className="row-card">
              <span className="row-card__icon" aria-hidden="true">
                <Icon name="pause" />
              </span>
              <button type="button" className="row-card__text row-card__link" onClick={onOpenStored}>
                <span className="row-card__title">{stored.sourceName}</span>
                <span className="row-card__meta">
                  Paused · {stored.done} of {stored.total} parts done
                </span>
              </button>
              <button type="button" className="button button--text" onClick={onResume}>
                Resume
              </button>
            </div>
          )}
          {stored.state === 'unusable' && (
            <div className="row-card">
              <span className="row-card__text">
                <span className="row-card__title">Files from an earlier run</span>
                <span className="row-card__meta">They can’t be resumed ({stored.reason}).</span>
              </span>
              <button type="button" className="button button--text button--danger" onClick={onDelete}>
                Delete · {mb(stored.bytes)}
              </button>
            </div>
          )}
        </section>
      )}

      <div className="grow" />
      <footer className="footer">
        <a href="#diagnostics" onClick={(e) => (e.preventDefault(), onDiagnostics())}>
          Device check &amp; diagnostics
        </a>
      </footer>
    </div>
  );
}
