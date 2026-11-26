/**
 * Small presentational pieces shared by the screens: icons, stem chips, the progress ring and bar, notices.
 * No state and no browser APIs beyond rendering.
 */
import type { ReactNode } from 'react';
import type { StemName } from '@stemsplit/core';
import { STEM_LABELS } from '@stemsplit/core';

/** One colour per stem. They differ in lightness as well as hue, and every use carries the stem's name too. */
export const STEM_COLORS: Readonly<Record<StemName, string>> = {
  vocals: '#ff8a65',
  drums: '#ffd166',
  bass: '#7aa2ff',
  guitar: '#5bd6a0',
  guitar_lead: '#5bd6a0',
  guitar_rhythm: '#2fa877',
  piano: '#c792ea',
  other: '#9aa3af',
};

type IconName = 'back' | 'plus' | 'note' | 'pause' | 'play' | 'save' | 'chevron' | 'clock' | 'phone' | 'trash' | 'bars';

const PATHS: Readonly<Record<IconName, ReactNode>> = {
  back: <path d="M15 6l-6 6 6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  note: (
    <>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>
  ),
  pause: <path d="M9 6v12M15 6v12" />,
  play: <path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />,
  save: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  bars: <path d="M5 10v4M9.5 6v12M14 8v8M18.5 4v16" />,
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function StemChips({ stems }: { stems: readonly StemName[] }) {
  return (
    <ul className="chips" aria-label="Stems">
      {stems.map((s) => (
        <li key={s} className="chip">
          <span className="dot" style={{ background: STEM_COLORS[s] }} aria-hidden="true" />
          {STEM_LABELS[s]}
        </li>
      ))}
    </ul>
  );
}

/** A screen's top row: optional back button and a title block. */
export function TopBar({ onBack, title, subtitle }: { onBack?: () => void; title: ReactNode; subtitle?: ReactNode }) {
  return (
    <header className="topbar">
      {onBack && (
        <button type="button" className="icon-button" aria-label="Back" onClick={onBack}>
          <Icon name="back" size={22} />
        </button>
      )}
      <div className="topbar__text">
        <span className="topbar__title">{title}</span>
        {subtitle && <span className="topbar__subtitle">{subtitle}</span>}
      </div>
    </header>
  );
}

/** Circular progress, 0–1. Indeterminate (null) shows a slow spin. */
export function ProgressRing({ fraction, children }: { fraction: number | null; children?: ReactNode }) {
  const r = 84;
  const c = 2 * Math.PI * r;
  const f = fraction === null ? 0.25 : Math.min(1, Math.max(0, fraction));
  return (
    <div className={fraction === null ? 'ring ring--spin' : 'ring'}>
      <svg viewBox="0 0 196 196" aria-hidden="true">
        <circle cx="98" cy="98" r={r} className="ring__track" />
        <circle cx="98" cy="98" r={r} className="ring__fill" strokeDasharray={`${(c * f).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 98 98)" />
      </svg>
      <div className="ring__label">{children}</div>
    </div>
  );
}

/** One segment per part: done, in progress, to do. */
export function PartBar({ done, total, running }: { done: number; total: number; running: boolean }) {
  return (
    <div className="parts" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={i < done ? 'part part--done' : i === done && running ? 'part part--now' : 'part'} />
      ))}
    </div>
  );
}

export function Notice({ tone, icon, title, children }: { tone: 'info' | 'problem' | 'warn'; icon?: IconName; title?: string; children: ReactNode }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'problem' ? 'alert' : undefined}>
      {icon && <Icon name={icon} />}
      <div className="notice__body">
        {title && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export const mb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
