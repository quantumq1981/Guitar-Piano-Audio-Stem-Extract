/**
 * Crash-recovery marker. Mobile browsers kill over-budget tabs without any
 * event we can observe, so we write a marker before local inference and clear
 * it on completion or clean abort. A marker found at startup means the last
 * run died → route to the server next time.
 */
const KEY = 'stemsplit.localRunInFlight';

export interface CrashMarker {
  readonly startedAt: number;
  readonly durationSec: number;
  readonly ep: string;
}

export function setCrashFlag(marker: CrashMarker): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(marker));
  } catch {
    // Private mode / quota: degrade to no crash detection.
  }
}

export function clearCrashFlag(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function readCrashFlag(): CrashMarker | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CrashMarker) : null;
  } catch {
    return null;
  }
}
