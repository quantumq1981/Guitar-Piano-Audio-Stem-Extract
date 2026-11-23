/**
 * ONNX model inventory — the single source of truth shared by every tier.
 *
 * Anti-drift rule: a stage runs the *same file* (pinned by sha256) on server,
 * browser and native. The registry is served verbatim by `GET /v1/models` so a
 * client can refuse to run locally when its cached artifact differs from the
 * server's.
 */

export const MODEL_SAMPLE_RATE = 44_100;
export const MODEL_CHANNELS = 2;

export const STEM_NAMES = [
  'drums',
  'bass',
  'other',
  'vocals',
  'guitar',
  'piano',
  'guitar_lead',
  'guitar_rhythm',
] as const;
export type StemName = (typeof STEM_NAMES)[number];

export function isStemName(value: unknown): value is StemName {
  return typeof value === 'string' && (STEM_NAMES as readonly string[]).includes(value);
}

/** ONNX Runtime execution providers we reason about. */
export type ExecutionProvider = 'cpu' | 'wasm' | 'webgpu' | 'coreml' | 'nnapi' | 'cuda';

export type EpSupport = 'supported' | 'unsupported' | 'untested';

/** Whether the artifact can be fetched today, needs a build step, or does not exist openly. */
export type Availability = 'published' | 'build-required' | 'unavailable';

export type ModelRole = 'primary-separation' | 'guitar-lead-rhythm' | 'piano-refinement';

export type ExecutionTier = 'server' | 'browser' | 'native';

export interface ModelIO {
  readonly inputName: string;
  readonly outputName: string;
  /** Fixed window length the graph was exported with (samples per channel). */
  readonly segmentFrames: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Output stem order along axis 1 of the output tensor. */
  readonly stems: readonly StemName[];
}

export interface ModelArtifact {
  readonly id: string;
  readonly version: string;
  readonly role: ModelRole;
  readonly displayName: string;
  readonly availability: Availability;
  /** Hugging Face repo id, when one exists. */
  readonly hfRepo: string | null;
  readonly hfFile: string | null;
  readonly url: string | null;
  readonly bytes: number | null;
  /** Lowercase hex sha256 of the exact file; null when not yet pinned. */
  readonly sha256: string | null;
  readonly weightsDtype: 'fp32' | 'fp16-stored' | 'unknown';
  readonly license: string;
  readonly io: ModelIO | null;
  readonly epSupport: Readonly<Record<ExecutionProvider, EpSupport>>;
  /** Tiers allowed to run this artifact by policy (not just by capability). */
  readonly allowedTiers: readonly ExecutionTier[];
  readonly notes: readonly string[];
}

const HTDEMUCS_6S_STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'] as const satisfies readonly StemName[];

/** 7.8 s × 44.1 kHz — the htdemucs training segment baked into the export. */
export const HTDEMUCS_SEGMENT_FRAMES = 343_980;

const htdemucsIO: ModelIO = {
  inputName: 'mix',
  outputName: 'stems',
  segmentFrames: HTDEMUCS_SEGMENT_FRAMES,
  sampleRate: MODEL_SAMPLE_RATE,
  channels: MODEL_CHANNELS,
  stems: HTDEMUCS_6S_STEMS,
};

/**
 * Canonical v1 artifact. Constant-folded export of htdemucs_6s that every EP
 * (CPU, WASM, WebGPU) can place, so server and browser run byte-identical weights.
 */
export const HTDEMUCS_6S_FOLDED: ModelArtifact = {
  id: 'htdemucs_6s-folded',
  version: '2026.06-kramp-a3f50506',
  role: 'primary-separation',
  displayName: 'HT-Demucs 6-stem (constant-folded, WebGPU-compatible)',
  availability: 'published',
  hfRepo: 'kramp/htdemucs-6s-webgpu-onnx',
  hfFile: 'htdemucs_6s.onnx',
  url: 'https://huggingface.co/kramp/htdemucs-6s-webgpu-onnx/resolve/main/htdemucs_6s.onnx',
  bytes: 284_797_240,
  sha256: 'a3f5050696cda4b2344d465123acb21ee699dad7d0634dba1d282497a04ac86a',
  weightsDtype: 'fp32',
  license: 'MIT',
  io: htdemucsIO,
  epSupport: { cpu: 'supported', wasm: 'supported', webgpu: 'supported', coreml: 'untested', nnapi: 'untested', cuda: 'untested' },
  allowedTiers: ['server', 'browser', 'native'],
  notes: [
    'Folded from StemSplitio/htdemucs-6s-onnx; the inverse-STFT ConstantOfShape node is replaced by a Constant so the WebGPU EP can place it.',
    'Measured on this repo (ORT 1.31 CPU EP, Linux x64): 2.4 GiB steady peak RSS per session, RTF ≈ 0.45–0.6 on 4 vCPU (docs/ARCHITECTURE.md §3).',
  ],
};

/** Unfolded upstream export — reference only; WebGPU cannot place it. */
export const HTDEMUCS_6S_UPSTREAM: ModelArtifact = {
  id: 'htdemucs_6s-upstream',
  version: '2026.05-stemsplit',
  role: 'primary-separation',
  displayName: 'HT-Demucs 6-stem (upstream export)',
  availability: 'published',
  hfRepo: 'StemSplitio/htdemucs-6s-onnx',
  hfFile: 'htdemucs_6s.onnx',
  url: 'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s.onnx',
  bytes: 258_159_781,
  sha256: null,
  weightsDtype: 'fp32',
  license: 'MIT',
  io: htdemucsIO,
  epSupport: { cpu: 'supported', wasm: 'supported', webgpu: 'unsupported', coreml: 'untested', nnapi: 'untested', cuda: 'untested' },
  allowedTiers: [],
  notes: ['Not deployable: violates the one-file-everywhere rule because WebGPU needs the folded variant.'],
};

/**
 * Planned v2 artifact: fp16-stored weights + the same constant fold. Halves the
 * download (136 MB upstream) but must replace v1 on *all* tiers in one release.
 */
export const HTDEMUCS_6S_FOLDED_FP16W: ModelArtifact = {
  id: 'htdemucs_6s-folded-fp16w',
  version: 'candidate-1333aa4a',
  role: 'primary-separation',
  displayName: 'HT-Demucs 6-stem (fp16-stored weights, folded)',
  availability: 'build-required',
  hfRepo: 'StemSplitio/htdemucs-6s-onnx',
  hfFile: 'htdemucs_6s_fp16weights.onnx',
  url: null,
  bytes: 143_359_115,
  sha256: '1333aa4a748126703b2824286c6a38dd0774491f7b2ad9fb802eba190191946f',
  weightsDtype: 'fp16-stored',
  license: 'MIT',
  io: htdemucsIO,
  epSupport: { cpu: 'supported', wasm: 'untested', webgpu: 'untested', coreml: 'untested', nnapi: 'untested', cuda: 'untested' },
  allowedTiers: [],
  notes: [
    'Built by scripts/fold_webgpu.py from the upstream fp16-weights export: 0 ConstantOfShape nodes left, max |Δ| = 0 vs its source on CPU.',
    'vs. the fp32 canonical artifact on real audio: worst-segment SNR ≥ 49 dB on every stem (gate: 40 dB).',
    'Promotion blockers: verify WebGPU placement on a real GPU, then host it and switch every tier in one release.',
  ],
};

/**
 * Lead/rhythm guitar ML model. MVSep's lead/rhythm checkpoints are service-only;
 * no open ONNX artifact exists on the Hub as of 2026-11. The pipeline ships a
 * labelled DSP heuristic (`spatial-similarity-v0`) in this slot instead.
 */
export const GUITAR_LEAD_RHYTHM_ML: ModelArtifact = {
  id: 'guitar-lead-rhythm-ml',
  version: 'unavailable',
  role: 'guitar-lead-rhythm',
  displayName: 'Lead/Rhythm guitar separator (ML)',
  availability: 'unavailable',
  hfRepo: null,
  hfFile: null,
  url: null,
  bytes: null,
  sha256: null,
  weightsDtype: 'unknown',
  license: 'unknown — MVSep models are not openly licensed',
  io: null,
  epSupport: { cpu: 'untested', wasm: 'unsupported', webgpu: 'unsupported', coreml: 'untested', nnapi: 'untested', cuda: 'untested' },
  allowedTiers: ['server'],
  notes: ['Quoted MVSep metrics (lead SI-SDR ≈ 6.43 dB) are vendor-reported and unverified here.'],
};

/**
 * Banquet (Watcharasupat & Lerch, ISMIR 2024) — query-based single-decoder
 * separator. Code is public; weights are trained on MoisesDB, whose licence is
 * non-commercial. No ONNX export exists; the PaSST query encoder must be exported too.
 */
export const BANQUET_PIANO: ModelArtifact = {
  id: 'banquet-piano',
  version: 'unbuilt',
  role: 'piano-refinement',
  displayName: 'Banquet query-based piano refinement',
  availability: 'build-required',
  hfRepo: null,
  hfFile: null,
  url: null,
  bytes: null,
  sha256: null,
  weightsDtype: 'unknown',
  license: 'Verify before shipping: MoisesDB-trained weights are non-commercial',
  io: null,
  epSupport: { cpu: 'untested', wasm: 'unsupported', webgpu: 'unsupported', coreml: 'untested', nnapi: 'untested', cuda: 'untested' },
  allowedTiers: ['server'],
  notes: ['Server-only by policy. Until built, the pipeline returns the htdemucs_6s piano stem and flags the skip.'],
};

export const MODEL_REGISTRY: readonly ModelArtifact[] = [
  HTDEMUCS_6S_FOLDED,
  HTDEMUCS_6S_UPSTREAM,
  HTDEMUCS_6S_FOLDED_FP16W,
  GUITAR_LEAD_RHYTHM_ML,
  BANQUET_PIANO,
];

/** The artifact every tier must use for primary separation in this release. */
export const PRIMARY_SEPARATION_MODEL: ModelArtifact = HTDEMUCS_6S_FOLDED;

export function findModel(id: string): ModelArtifact | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

export function requireIO(model: ModelArtifact): ModelIO {
  if (model.io === null) {
    throw new Error(`Model ${model.id} has no tensor I/O spec (availability: ${model.availability}).`);
  }
  return model.io;
}
