import type { FlowPhase } from '@stemsplit/core';
import { formatEta, partProgress, workingTitle } from '@stemsplit/core';
import { Icon, Notice, PartBar, ProgressRing } from './ui.tsx';

/** A job is running: what it is doing, how far it has got, and (on the disk path) Pause. */
export function Working({ phase, fraction, etaSec, totalParts, songName, scopeTitle, diskActive, onPause, queuePosition }: {
  phase: FlowPhase;
  /** 0–1, or null when the phase has no measurable progress. */
  fraction: number | null;
  etaSec: number | null;
  /** Parts (model windows) of this song, when known. */
  totalParts: number | null;
  songName: string;
  scopeTitle: string;
  diskActive: boolean;
  onPause: () => void;
  queuePosition: number | null;
}) {
  const separatingHere = phase === 'local';
  const parts = separatingHere && totalParts !== null && fraction !== null ? partProgress(fraction, totalParts) : null;
  const eta = formatEta(etaSec);
  const percent = fraction === null ? null : Math.round(Math.min(1, Math.max(0, fraction)) * 100);

  return (
    <div className="screen working" data-phase={phase}>
      <header className="stack stack--tight">
        <span className="muted">
          {songName} · {scopeTitle}
        </span>
        <h1 className="title">{workingTitle(phase)}</h1>
      </header>

      <section className="card working__card status" aria-live="polite">
        <ProgressRing fraction={fraction}>
          {percent !== null ? <span className="ring__value">{percent}%</span> : <span className="ring__value ring__value--small">…</span>}
          {parts && (
            <span className="muted">
              Part {Math.min(parts.done + 1, parts.total)} of {parts.total}
            </span>
          )}
        </ProgressRing>
        <progress className="visually-hidden" max={1} value={fraction ?? undefined} aria-label={workingTitle(phase)} />
        <p className="working__line">
          {phase === 'model-download'
            ? 'Downloading the model. This only happens the first time.'
            : phase === 'decoding'
              ? 'Getting the audio ready.'
              : phase === 'server' && queuePosition
                ? `In the queue · position ${queuePosition}`
                : eta
                  ? `${eta[0]!.toUpperCase()}${eta.slice(1)} left`
                  : separatingHere
                    ? 'Working out how long it will take…'
                    : ' '}
        </p>
        {parts && <PartBar done={parts.done} total={parts.total} running />}
        {diskActive && <p className="fine center">Each finished part is saved here as it goes.</p>}
      </section>

      {diskActive && (
        <Notice tone="info" icon="phone" title="Keep this page open">
          The screen stays awake by itself. If you leave the page it pauses, and it carries on from where it stopped.
        </Notice>
      )}

      <div className="grow" />
      {diskActive && (
        <button type="button" className="button button--secondary button--wide" onClick={onPause}>
          <Icon name="pause" />
          Pause
        </button>
      )}
    </div>
  );
}
