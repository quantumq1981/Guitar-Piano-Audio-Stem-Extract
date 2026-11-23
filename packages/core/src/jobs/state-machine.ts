/**
 * Job lifecycle as an explicit transition table. Both the reference Node server
 * and a Durable Object implementation must route every status change through
 * `transition()` so illegal jumps (e.g. succeeded → separating) are impossible.
 */
import type { JobStatus } from '../api/contract.ts';

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  awaiting_upload: ['queued', 'cancelled', 'expired', 'failed'],
  queued: ['decoding', 'cancelled', 'failed'],
  decoding: ['separating', 'failed', 'cancelled'],
  separating: ['refining', 'encoding', 'failed', 'cancelled'],
  refining: ['encoding', 'failed', 'cancelled'],
  encoding: ['succeeded', 'failed', 'cancelled'],
  succeeded: ['expired'],
  failed: ['expired'],
  cancelled: ['expired'],
  expired: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  readonly from: JobStatus;
  readonly to: JobStatus;
  constructor(from: JobStatus, to: JobStatus) {
    super(`Illegal job transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function transition(from: JobStatus, to: JobStatus): JobStatus {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Wall-time estimate for a server job. `rtf` = compute seconds per audio second
 * for primary separation on the target container (measured, see docs §3).
 */
export function estimateServerSeconds(durationSec: number, opts: { rtf: number; leadRhythm: boolean; pianoRefine: boolean }): number {
  if (!(durationSec > 0) || !(opts.rtf > 0)) return 0;
  const decodeEncode = 2 + durationSec * 0.05;
  const separate = durationSec * opts.rtf;
  const leadRhythm = opts.leadRhythm ? durationSec * 0.03 : 0;
  // Banquet ≈ one extra separation pass at similar cost (estimate until built).
  const piano = opts.pianoRefine ? durationSec * opts.rtf : 0;
  return Math.ceil(decodeEncode + separate + leadRhythm + piano);
}
