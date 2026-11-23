/**
 * Web Audio stem player: one AudioBufferSourceNode + GainNode per stem, all
 * started at the same AudioContext time so stems stay sample-locked.
 */
import type { StemName } from '@stemsplit/core';
import { MODEL_SAMPLE_RATE } from '@stemsplit/core';
import type { StemChannelState } from './mix-logic.ts';
import { resolveGains } from './mix-logic.ts';

export class StemPlayer {
  readonly #ctx: AudioContext;
  readonly #buffers = new Map<StemName, AudioBuffer>();
  readonly #gains = new Map<StemName, GainNode>();
  #sources: AudioBufferSourceNode[] = [];
  #startedAt = 0;
  #offset = 0;
  #playing = false;

  constructor() {
    this.#ctx = new AudioContext({ latencyHint: 'playback' });
  }

  get duration(): number {
    return [...this.#buffers.values()][0]?.duration ?? 0;
  }

  get position(): number {
    return this.#playing ? Math.min(this.duration, this.#offset + this.#ctx.currentTime - this.#startedAt) : this.#offset;
  }

  get playing(): boolean {
    return this.#playing;
  }

  setStem(stem: StemName, left: Float32Array, right: Float32Array): void {
    const buf = this.#ctx.createBuffer(2, left.length, MODEL_SAMPLE_RATE);
    buf.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
    this.#buffers.set(stem, buf);
    if (!this.#gains.has(stem)) {
      const g = this.#ctx.createGain();
      g.connect(this.#ctx.destination);
      this.#gains.set(stem, g);
    }
  }

  setStemBuffer(stem: StemName, buf: AudioBuffer): void {
    this.#buffers.set(stem, buf);
    if (!this.#gains.has(stem)) {
      const g = this.#ctx.createGain();
      g.connect(this.#ctx.destination);
      this.#gains.set(stem, g);
    }
  }

  /** Planar channel data for export (views into the AudioBuffer; do not mutate). */
  channelData(stem: StemName): [Float32Array, Float32Array] | null {
    const buf = this.#buffers.get(stem);
    if (!buf) return null;
    const left = buf.getChannelData(0);
    return [left, buf.numberOfChannels > 1 ? buf.getChannelData(1) : left];
  }

  get context(): AudioContext {
    return this.#ctx;
  }

  applyMix(states: Readonly<Partial<Record<StemName, StemChannelState>>>): void {
    const gains = resolveGains(states as Record<StemName, StemChannelState>);
    for (const [stem, value] of Object.entries(gains) as [StemName, number][]) {
      // Short ramp avoids zipper clicks on solo/mute.
      this.#gains.get(stem)?.gain.setTargetAtTime(value, this.#ctx.currentTime, 0.01);
    }
  }

  async play(): Promise<void> {
    if (this.#playing) return;
    await this.#ctx.resume();
    const at = this.#ctx.currentTime + 0.05;
    this.#sources = [...this.#buffers].map(([stem, buf]) => {
      const src = this.#ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.#gains.get(stem)!);
      src.start(at, this.#offset);
      return src;
    });
    this.#sources[0]?.addEventListener('ended', () => {
      if (this.#playing && this.position >= this.duration - 0.05) this.stop(0);
    });
    this.#startedAt = at;
    this.#playing = true;
  }

  pause(): void {
    if (!this.#playing) return;
    this.#offset = this.position;
    this.#halt();
  }

  stop(rewindTo = 0): void {
    this.#halt();
    this.#offset = rewindTo;
  }

  seek(seconds: number): void {
    const wasPlaying = this.#playing;
    this.#halt();
    this.#offset = Math.max(0, Math.min(this.duration, seconds));
    if (wasPlaying) void this.play();
  }

  #halt(): void {
    for (const s of this.#sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    this.#sources = [];
    this.#playing = false;
  }

  async close(): Promise<void> {
    this.#halt();
    await this.#ctx.close();
  }
}
