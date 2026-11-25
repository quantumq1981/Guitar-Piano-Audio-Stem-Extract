/** Messages between the experimental benchmark card and mobile-stage4.worker.ts. */
export type Stage4Request =
  | { readonly type: 'test'; readonly windows: number }
  /** Planar stereo at the model rate; both buffers are transferred. */
  | { readonly type: 'song'; readonly left: Float32Array; readonly right: Float32Array };

export interface Stage4Message {
  readonly message: string;
  readonly done?: boolean;
}

/** Stem files are 24-bit PCM WAV, as the server exports by default: 16-bit measurably limited quiet stems
 * (a stem at -32 dB re mix: 44.6 dB SNR vs the float output, against 63 dB for the computation itself). */
export const STAGE4_STEM_SAMPLE_FORMAT = 'pcm24';
export const STAGE4_STEM_BYTES_PER_SAMPLE = 3;

/** OPFS directory holding the stems as `<stem>.wav`. The page frees it before checking quota for a new song and the
 * worker recreates it; the page scans it on load and after every run, so stems left by a stopped run can be deleted. */
export const STAGE4_STEM_DIRECTORY = 'stage4-stems';
