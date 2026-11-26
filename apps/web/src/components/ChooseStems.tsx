import type { Plan, ScopeOption, SeparationScope } from '@stemsplit/core';
import { formatClock, formatEta } from '@stemsplit/core';
import { Icon, Notice, StemChips, mb } from './ui.tsx';

const RUNS_ON: Readonly<Record<NonNullable<Plan['runsOn']>, string>> = {
  'this-phone': 'This phone',
  'this-device': 'This computer',
  server: 'Our server',
};

/** A song is chosen: pick what comes out, see what it takes, start. */
export function ChooseStems(p: {
  fileName: string;
  fileBytes: number;
  durationSec: number | null;
  options: readonly ScopeOption[];
  scope: SeparationScope;
  onScope: (scope: SeparationScope) => void;
  plan: Plan;
  /** The capability probe or duration is still being read. */
  checking: boolean;
  /** The run stores its stems on this device and pauses when the page is hidden. */
  diskPath: boolean;
  serverConfigured: boolean;
  forceServer: boolean;
  onForceServer: (on: boolean) => void;
  /** The name of a stored song (or paused run) this run would replace. */
  replaces: string | null;
  error: { message: string; canRetryOnServer: boolean } | null;
  queuedOffline: boolean;
  onStart: (forceServer?: boolean) => void;
  onBack: () => void;
  onClearCrash: () => void;
}) {
  const eta = formatEta(p.plan.etaSec);
  return (
    <div className="screen">
      <header className="topbar">
        <button type="button" className="icon-button" aria-label="Back" onClick={p.onBack}>
          <Icon name="back" size={22} />
        </button>
        <div className="topbar__text">
          <span className="topbar__title">{p.fileName}</span>
          <span className="topbar__subtitle">
            {formatClock(p.durationSec)} · {mb(p.fileBytes)}
          </span>
        </div>
      </header>

      <h1 className="title">What do you want out of it?</h1>

      <fieldset className="choices">
        <legend className="visually-hidden">Stems</legend>
        {p.options.map((o) => (
          <label key={o.scope} className={o.scope === p.scope ? 'choice choice--on' : 'choice'}>
            <input type="radio" name="scope" value={o.scope} checked={o.scope === p.scope} onChange={() => p.onScope(o.scope)} className="visually-hidden" />
            <span className="choice__head">
              <span className="choice__title">{o.title}</span>
              <span className="radio" aria-hidden="true" />
            </span>
            <span className="choice__summary">{o.summary}</span>
            <StemChips stems={o.stems} />
          </label>
        ))}
      </fieldset>

      {!p.serverConfigured && (
        <p className="soon">
          <Icon name="clock" size={18} />
          Lead and rhythm guitar split: coming soon
        </p>
      )}
      {p.serverConfigured && (
        <label className="switch">
          <input type="checkbox" checked={p.forceServer} onChange={(e) => p.onForceServer(e.target.checked)} />
          <span>Always use our server</span>
        </label>
      )}

      {p.error && (
        <Notice tone="problem" title="That didn’t work">
          {p.error.message}
          {p.error.canRetryOnServer && (
            <button type="button" className="button button--secondary notice__action" onClick={() => p.onStart(true)}>
              Try on our server instead
            </button>
          )}
        </Notice>
      )}
      {p.queuedOffline && <Notice tone="info">Saved. It will be sent to our server when you’re back online.</Notice>}
      {!p.checking && p.plan.problem && (
        <Notice tone="problem">
          {p.plan.problem}
          {p.plan.canClearCrash && (
            <button type="button" className="button button--secondary notice__action" onClick={p.onClearCrash}>
              Try on this device again
            </button>
          )}
        </Notice>
      )}

      <div className="grow" />

      <div className="stack">
        {p.plan.canStart && (
          <dl className="facts">
            <div>
              <dt>Takes</dt>
              <dd>{eta ? eta.replace(/^about /, '~') : p.plan.runsOn === 'server' ? 'a few min' : '–'}</dd>
            </div>
            <div>
              <dt>Space needed</dt>
              <dd>{p.plan.storageBytes !== null ? mb(p.plan.storageBytes) : '–'}</dd>
            </div>
            <div>
              <dt>Runs on</dt>
              <dd>{p.plan.runsOn ? RUNS_ON[p.plan.runsOn] : '–'}</dd>
            </div>
          </dl>
        )}
        {p.plan.canStart && p.plan.downloadBytes !== null && (
          <p className="fine center">The first time, the model is downloaded too ({mb(p.plan.downloadBytes)}). After that it’s kept.</p>
        )}
        {p.plan.canStart && p.replaces && <p className="fine center">This replaces “{p.replaces}”, saved here.</p>}
        <button type="button" className="button button--primary button--wide" disabled={!p.plan.canStart || p.checking} onClick={() => p.onStart()}>
          {p.checking ? 'Checking this device…' : p.plan.cta}
        </button>
        {p.plan.canStart && p.diskPath && <p className="fine center">Keep this page open. If you switch away it pauses, and you can resume.</p>}
      </div>
    </div>
  );
}
