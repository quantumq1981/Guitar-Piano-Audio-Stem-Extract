import { useEffect, useMemo } from 'react';
import type { StemName } from '@stemsplit/core';
import { shareFiles } from '../audio/export.ts';
import type { StoredDeviceRun } from '../platform/disk-store.ts';

const LABELS: Readonly<Record<StemName, string>> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Other',
  guitar: 'Guitar',
  piano: 'Piano',
  guitar_lead: 'Lead guitar',
  guitar_rhythm: 'Rhythm guitar',
};
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;
const base = (name: string) => name.replace(/\.[^.]+$/, '');

/**
 * What the last on-device (disk path) run left: finished stems, played and shared straight from device storage
 * (disk-backed Files, never decoded into memory), or a stopped run with Resume. Survives reloads.
 */
export function StoredRun({ stored, busy, onResume, onDelete }: {
  stored: StoredDeviceRun;
  busy: boolean;
  onResume: () => void;
  onDelete: () => void;
}) {
  const urls = useMemo(
    () => (stored.state === 'complete' ? stored.stems.map((s) => ({ ...s, url: URL.createObjectURL(s.file) })) : []),
    [stored],
  );
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u.url)), [urls]);

  const share = async (stem: StemName, file: File, name: string) => {
    // iOS: the share sheet saves to Files; elsewhere fall back to a download link.
    if (await shareFiles([new File([file], name, { type: 'audio/wav' })])) return;
    const a = document.createElement('a');
    a.href = urls.find((u) => u.stem === stem)!.url;
    a.download = name;
    a.click();
  };

  const remove = (
    <button type="button" disabled={busy} onClick={onDelete}>
      Delete from this device ({mb(stored.bytes)})
    </button>
  );

  if (stored.state === 'complete') {
    return (
      <section className="card stored-run">
        <h2>Stems on this device</h2>
        <p className="muted">{stored.sourceName} · 24-bit WAV, saved on this device (they stay after a reload).</p>
        <ul className="stems">
          {urls.map(({ stem, file, url }) => {
            const name = `${base(stored.sourceName)} - ${stem}.wav`;
            return (
              <li key={stem} className="channel">
                <span className="channel__name">{LABELS[stem]}</span>
                <audio controls preload="none" src={url} />
                <button type="button" onClick={() => void share(stem, file, name)}>
                  Save ({mb(file.size)})
                </button>
              </li>
            );
          })}
        </ul>
        {remove}
      </section>
    );
  }
  if (stored.state === 'stopped') {
    return (
      <section className="card stored-run">
        <h2>Paused separation</h2>
        <p>
          {stored.sourceName}: {stored.done} of {stored.total} windows are finished and saved on this device. Resume continues from there; nothing is redone
          except one window.
        </p>
        <button type="button" className="primary" disabled={busy} onClick={onResume}>
          Resume
        </button>
        {remove}
      </section>
    );
  }
  if (stored.state === 'unusable') {
    return (
      <section className="card stored-run">
        <p className="muted">Files from an earlier on-device run are stored here, but it cannot be resumed: {stored.reason}.</p>
        {remove}
      </section>
    );
  }
  return null;
}
