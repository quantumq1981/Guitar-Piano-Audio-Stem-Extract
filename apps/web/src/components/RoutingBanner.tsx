import type { RouteDecision } from '@stemsplit/core';
import { REASON_COPY, formatBytes } from '@stemsplit/core';

export function RoutingBanner({ decision, serverConfigured }: { decision: RouteDecision; serverConfigured: boolean }) {
  const onDevice = decision.target === 'device';
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
      {decision.warnings.includes('wasm_slow_path') && <p className="muted">No WebGPU: using WebAssembly, which is several times slower.</p>}
      {!onDevice && !serverConfigured && (
        <p className="warning">No processing server is configured for this build, so this job cannot run here. On a desktop with WebGPU, choose Quick or Full for a track of 90 s or less to process it on this device.</p>
      )}
      {decision.warnings.includes('offline_server_job_queued') && <p className="muted">You are offline. The job will be sent when you reconnect.</p>}
    </section>
  );
}
