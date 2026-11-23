/**
 * Solo/mute gain resolution — pure, so it is unit-tested headlessly.
 * DAW semantics: if any stem is soloed, only soloed (and not muted) stems play.
 */
export interface StemChannelState {
  readonly muted: boolean;
  readonly soloed: boolean;
  /** Linear fader gain, 0..2. */
  readonly gain: number;
}

export function resolveGains<K extends string>(states: Readonly<Record<K, StemChannelState>>): Record<K, number> {
  const keys = Object.keys(states) as K[];
  const anySolo = keys.some((k) => states[k].soloed);
  const out = {} as Record<K, number>;
  for (const k of keys) {
    const s = states[k];
    const audible = !s.muted && (!anySolo || s.soloed);
    out[k] = audible ? clampGain(s.gain) : 0;
  }
  return out;
}

export function clampGain(g: number): number {
  return Number.isFinite(g) ? Math.min(2, Math.max(0, g)) : 0;
}

/** Equal-power-ish fader law: slider 0..1 → gain, with 0.75 ≈ unity. */
export function sliderToGain(position: number): number {
  const p = Math.min(1, Math.max(0, position));
  return p === 0 ? 0 : Math.pow(p / 0.75, 2);
}
