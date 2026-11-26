import { useEffect, useMemo, useRef, useState } from 'react';
import type { StemName } from '@stemsplit/core';
import { STEM_LABELS, formatClock } from '@stemsplit/core';
import { downloadBlob, shareFiles } from '../audio/export.ts';
import type { StoredDeviceRun } from '../platform/disk-store.ts';
import { Icon, Notice, STEM_COLORS, TopBar, mb } from './ui.tsx';

const base = (name: string) => name.replace(/\.[^.]+$/, '');

/**
 * Stems stored on this device (disk path). One stem plays at a time, straight from device storage: a stem File is
 * disk-backed, so playing or saving it never decodes six stems into memory (a phone cannot hold them).
 */
export function StoredStems({ stored, checking, clipped, busy, onDelete, onBack }: {
  stored: StoredDeviceRun | null;
  /** The stored-run scan is still in flight. */
  checking: boolean;
  clipped: readonly string[];
  busy: boolean;
  onDelete: () => void;
  onBack: () => void;
}) {
  const complete = stored?.state === 'complete' ? stored : null;
  const urls = useMemo(() => (complete ? complete.stems.map((s) => ({ ...s, url: URL.createObjectURL(s.file) })) : []), [complete]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u.url)), [urls]);

  const audio = useRef<HTMLAudioElement | null>(null);
  const [active, setActive] = useState<StemName | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState({ position: 0, duration: 0 });

  useEffect(() => () => audio.current?.pause(), []);

  if (!complete) {
    return (
      <div className="screen">
        <TopBar onBack={onBack} title="Your stems" />
        <p className="muted">{checking ? 'Checking what was saved…' : 'These stems are no longer on this device.'}</p>
      </div>
    );
  }

  const toggle = (stem: StemName, url: string) => {
    const el = audio.current;
    if (!el) return;
    if (active === stem) {
      if (el.paused) void el.play();
      else el.pause();
      return;
    }
    el.src = url;
    setActive(stem);
    setTime({ position: 0, duration: 0 });
    void el.play();
  };

  const fileFor = (stem: StemName, file: File) => new File([file], `${base(complete.sourceName)} - ${STEM_LABELS[stem]}.wav`, { type: 'audio/wav' });

  const saveOne = async (stem: StemName, file: File, url: string) => {
    const f = fileFor(stem, file);
    if (await shareFiles([f])) return; // iOS: the share sheet saves to Files
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    a.click();
  };

  const saveAll = async () => {
    const files = complete.stems.map((s) => fileFor(s.stem, s.file));
    if (await shareFiles(files)) return;
    for (const f of files) downloadBlob(f, f.name);
  };

  return (
    <div className="screen stored-run">
      <TopBar onBack={onBack} title={complete.sourceName} subtitle={`${complete.stems.length} stems · saved on this device`} />
      <h1 className="visually-hidden">Stems on this device</h1>
      {clipped.length > 0 && <Notice tone="warn">Some stems are louder than full scale and may clip: {clipped.join(', ')}.</Notice>}

      <audio
        ref={audio}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime({ position: e.currentTarget.currentTime, duration: e.currentTarget.duration || 0 })}
        onLoadedMetadata={(e) => setTime((t) => ({ ...t, duration: e.currentTarget.duration || 0 }))}
      />

      <ul className="stem-list">
        {urls.map(({ stem, file, url }) => {
          const on = active === stem;
          const color = STEM_COLORS[stem];
          return (
            <li key={stem} className={on ? 'stem-row stem-row--on' : 'stem-row'} style={on ? { borderColor: color } : undefined}>
              <button
                type="button"
                className="stem-row__play"
                style={on && playing ? { background: color, color: '#111317' } : undefined}
                aria-label={`${on && playing ? 'Pause' : 'Play'} ${STEM_LABELS[stem]}`}
                onClick={() => toggle(stem, url)}
              >
                <Icon name={on && playing ? 'pause' : 'play'} size={18} />
              </button>
              <div className="stem-row__main">
                <span className="stem-row__name">
                  <span className="dot" style={{ background: color }} aria-hidden="true" />
                  {STEM_LABELS[stem]}
                </span>
                {on ? (
                  <div className="stem-row__seek">
                    <input
                      type="range"
                      min={0}
                      max={time.duration || 1}
                      step={0.1}
                      value={time.position}
                      style={{ accentColor: color }}
                      aria-label={`${STEM_LABELS[stem]} position`}
                      onChange={(e) => {
                        if (audio.current) audio.current.currentTime = Number(e.target.value);
                      }}
                    />
                    <span className="time">{formatClock(time.position)}</span>
                  </div>
                ) : (
                  <span className="stem-row__meta">{mb(file.size)}</span>
                )}
              </div>
              <button type="button" className="icon-button icon-button--outline" aria-label={`Save ${STEM_LABELS[stem]}`} onClick={() => void saveOne(stem, file, url)}>
                <Icon name="save" size={18} />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="grow" />
      <div className="stack">
        <button type="button" className="button button--primary button--wide" onClick={() => void saveAll()}>
          <Icon name="save" />
          Save all
        </button>
        <button type="button" className="button button--text" disabled={busy} onClick={onDelete}>
          Delete from this device · frees {mb(complete.bytes)}
        </button>
      </div>
    </div>
  );
}
