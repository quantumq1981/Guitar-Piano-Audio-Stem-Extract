/** Messages between the experimental benchmark card and mobile-stage4.worker.ts. */
/** `threads`: requested WASM threads; the worker reduces it with stage4Threads() (isolation, core count). */
export type Stage4Request =
  | { readonly type: 'test'; readonly windows: number; readonly threads: number }
  /** Planar stereo at the model rate; both buffers are transferred. `source` names the chosen file (run.json). */
  | {
    readonly type: 'song';
    readonly left: Float32Array;
    readonly right: Float32Array;
    readonly threads: number;
    readonly source: { readonly name: string; readonly bytes: number };
  }
  /** Continue the stopped run stored in STAGE4_STEM_DIRECTORY (core decideResume). */
  | { readonly type: 'resume'; readonly threads: number };

export interface Stage4Message {
  readonly message: string;
  readonly done?: boolean;
}

/** Stem files are 24-bit PCM WAV, as the server exports by default: 16-bit measurably limited quiet stems
 * (a stem at -32 dB re mix: 44.6 dB SNR vs the float output, against 63 dB for the computation itself). */
export const STAGE4_STEM_SAMPLE_FORMAT = 'pcm24';

/** OPFS directory of one run: `run.json` (core RunManifest), the song as `input.f32` (kept until the stems are
 * complete, so a stopped run can resume) and the stems as `<stem>.wav`. The page frees it before checking quota for
 * a new song and the worker recreates it; the page scans it on load and after every run, so a stopped run can be
 * resumed or deleted. */
export const STAGE4_STEM_DIRECTORY = 'stage4-stems';
