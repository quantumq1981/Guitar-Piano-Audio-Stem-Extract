import type { RouteDecision } from '@stemsplit/core';
import { REASON_COPY, formatBytes } from '@stemsplit/core';

const minutes = (sec: number) => (sec < 90 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`);

export function RoutingBanner({ decision, serverConfigured, estimateSec, replacesStored, onClearCrash }: {
  decision: RouteDecision;
  serverConfigured: boolean;
  /** Measured-basis separation time (core estimateDeviceSeconds), or null when unmeasured. */
  estimateSec: number | null;
  /** A stored on-device run (stems or a paused run) that this job would replace. */
  replacesStored: boolean;
  onClearCrash: () => void;
}) {
  const onDevice = decision.target === 'device';
  const disk = decision.target === 'device' && decision.storage === 'disk';
  return (
    <section className={`banner ${onDevice ? 'banner--device' : 'banner--server'}`} aria-live="polite">
      <strong>{onDevice ? 'Processing on this device' : 'Processing on our servers'}</strong>
      <ul>
        {decision.reasons.map((r) => (
          <li key={r}>{REASON_COPY[r]}</li>
        ))}
      </ul>
      {decision.memory && (
        <p className="muted">
          Projected peak memory {formatBytes(decision.memory.projectedPeakBytes)}
          {decision.memory.hasEstimates ? ' (includes estimates)' : ''}.
        </p>
      )}
      {decision.warnings.includes('lower_fidelity_than_server') && (
        <p className="muted">On-device output is the 6-stem model only. Lead/rhythm guitar and piano refinement need the server.</p>
      )}
      {disk && (
        <p className="muted">
          The stems are saved on this device as they are made. Keep this page open and the screen on: leaving Safari or locking the phone pauses the
          run, and Resume continues from the last finished window.
        </p>
      )}
      {onDevice && estimateSec !== null && (
        <p className="muted">
          About {minutes(estimateSec)} of separation{disk ? ' (measured on an iPhone at one thread; Low Power Mode roughly doubles it)' : ' (measured on a 4-core computer)'}, plus
          the first model download (130 MB).
        </p>
      )}
      {decision.warnings.includes('wasm_slow_path') && !disk && estimateSec === null && <p className="muted">Runs on the CPU with WebAssembly: on a 4-core computer it takes about as long as the song, plus the first model download.</p>}
      {onDevice && replacesStored && <p className="muted">This replaces the stems (or paused run) stored on this device.</p>}
      {!onDevice && !serverConfigured && (
        <p className="warning">
          No processing server is configured for this build, so this job cannot run here. On-device separation covers Quick and Full: up to 10 minutes on
          phones and tablets, 90 s on computers.
        </p>
      )}
      {!onDevice && decision.reasons.includes('crash_flag') && !serverConfigured && (
        <button type="button" onClick={onClearCrash}>
          Try on this device again
        </button>
      )}
      {decision.warnings.includes('offline_server_job_queued') && <p className="muted">You are offline. The job will be sent when you reconnect.</p>}
    </section>
  );
}
