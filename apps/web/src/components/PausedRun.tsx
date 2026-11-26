import { pauseMessage } from '@stemsplit/core';
import type { StoredDeviceRun } from '../platform/disk-store.ts';
import { Icon, PartBar, TopBar, mb } from './ui.tsx';

/** A stored on-device run that stopped before the end: Resume, or delete and start over. */
export function PausedRun({ stored, checking, reason, busy, onResume, onDelete, onBack }: {
  stored: StoredDeviceRun | null;
  /** The stored-run scan is still in flight. */
  checking: boolean;
  /** The stop reason when it paused in this session; null after a reload. */
  reason: string | null;
  busy: boolean;
  onResume: () => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  if (stored?.state !== 'stopped') {
    return (
      <div className="screen">
        <TopBar onBack={onBack} title="Paused" />
        <p className="muted">{checking ? 'Checking what was saved…' : stored === null ? 'It paused before anything was saved. Go back and start it again.' : 'This run can’t be resumed any more.'}</p>
      </div>
    );
  }
  return (
    <div className="screen stored-run">
      <TopBar onBack={onBack} title={stored.sourceName} subtitle={`${stored.outputs.length} stems`} />

      <section className="paused">
        <div className="hero__badge hero__badge--large">
          <Icon name="pause" size={36} />
        </div>
        <h1 className="title">Paused separation</h1>
        <p className="muted">
          {pauseMessage(reason)} {stored.done} of {stored.total} parts are done and saved here.
        </p>
      </section>
      <PartBar done={stored.done} total={stored.total} running={false} />

      <div className="grow" />
      <div className="stack">
        <button type="button" className="button button--primary button--wide" disabled={busy} onClick={onResume}>
          <Icon name="play" />
          Resume
        </button>
        <p className="fine center">It picks up where it stopped. Only one part is redone.</p>
        <button type="button" className="button button--text button--danger" disabled={busy} onClick={onDelete}>
          Delete and start over · {mb(stored.bytes)}
        </button>
      </div>
    </div>
  );
}
