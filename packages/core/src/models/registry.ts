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

/** A file pinned by exact size and SHA-256. */
export interface PinnedFile {
  /** File name. For external data it is the name the graph records, so it must not be renamed on disk. */
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ExternalDataFile extends PinnedFile {
  readonly url: string;
}

/** ORT graph optimisation an artifact was validated with, per tier. */
export type GraphOptimization = 'all' | 'disabled';

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
  /** Weights stored beside the graph (ONNX external data); `url`/`bytes`/`sha256` above then pin the graph file. */
  readonly externalData?: ExternalDataFile;
  /**
   * Validated maximum sizes (WebAssembly pages, tried in order) for a shared WASM memory the browser runtime asks
   * for. ORT's threaded build requests 4 GiB, which Safari may refuse to reserve. Only for an artifact whose browser
   * heap is measured to fit; absent: no cap.
   */
  readonly browserWasmMemoryCapPages?: readonly number[];
  /** Graph optimisation each tier must use (validated settings). Absent: 'all' everywhere. */
  readonly graphOptimization?: Readonly<Record<ExecutionTier, GraphOptimization>>;
  readonly notes: readonly string[];
}

/** Graph optimisation `model` must run with on `tier`. */
export function graphOptimizationFor(model: ModelArtifact, tier: ExecutionTier): GraphOptimization {
  return model.graphOptimization?.[tier] ?? 'all';
}

/** Bytes to download for `model`: the graph plus any external data (null when unpinned). */
export function downloadBytes(model: ModelArtifact): number | null {
  return model.bytes === null ? null : model.bytes + (model.externalData?.bytes ?? 0);
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
 * Previous canonical (v1, until 2026-11-25) and the parity reference for v2. Constant-folded export of htdemucs_6s
 * that every EP (CPU, WASM, WebGPU) can place. Kept published so a rollback is a one-line switch.
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

/** GitHub Pages copy of the Stage IV files. pages.yml rebuilds them deterministically from the fp16w source and
 * fails the deploy unless both SHA-256s match the pins below, so this URL serves exactly these bytes. */
const STAGE4_BASE_URL = 'https://quantumq1981.github.io/Guitar-Piano-Audio-Stem-Extract/models/';

/**
 * Canonical v2 artifact (owner decision 2026-11-25, Stage V option A): the Stage IV memory-optimised graph of the
 * fp16-weight model, with weights as ONNX external data. One file pair on every tier; each tier opens it with its
 * validated graph optimisation (browser 'disabled': folding re-enables ORT's buffer-reuse trap in WASM, +1.3 GiB).
 * Built by scripts/mobile_graph.py then scripts/mobile_memory.py --external-data --accurate-reductions.
 * Rollback: point PRIMARY_SEPARATION_MODEL back at HTDEMUCS_6S_FOLDED; every loader handles both.
 */
export const HTDEMUCS_6S_STAGE4: ModelArtifact = {
  id: 'htdemucs_6s-stage4',
  version: '2026.11-stage4-a343b853',
  role: 'primary-separation',
  displayName: 'HT-Demucs 6-stem (Stage IV memory-optimised, fp16-stored weights)',
  availability: 'published',
  hfRepo: null,
  hfFile: null,
  url: `${STAGE4_BASE_URL}candidate-memory.onnx`,
  bytes: 1_201_735,
  sha256: 'a343b853a28752f05e7188b42b4d1724d97de8ea3057d225bd8a4d76f7fc1110',
  weightsDtype: 'fp16-stored',
  license: 'MIT',
  io: htdemucsIO,
  epSupport: { cpu: 'supported', wasm: 'supported', webgpu: 'unsupported', coreml: 'untested', nnapi: 'untested', cuda: 'untested' },
  allowedTiers: ['server', 'browser', 'native'],
  externalData: {
    file: 'candidate-memory.onnx.data',
    url: `${STAGE4_BASE_URL}candidate-memory.onnx.data`,
    bytes: 129_090_048,
    sha256: '514978cfe52041f8272a52f91510b5f930cf9bc90504fccd5a51800f976069db',
  },
  graphOptimization: { server: 'all', native: 'all', browser: 'disabled' },
  // 1 GiB, then 768 MiB: the heap peaks at 616 MiB reserved (iPhone and Chromium, byte-identical sequence) [M].
  browserWasmMemoryCapPages: [16_384, 12_288],
  notes: [
    'vs. the fp32 v1 artifact, 8 songs × 3 windows: passes stemParity on every stem with graph optimisation disabled and all (min SNR 40.1 dB, on a piano at −63.5 dB re mix; error ≤ −90 dB re mix wherever SNR < 49 dB) [M].',
    'Server, 4 vCPU, 31.2 s, two quiet runs each: RTF 0.44–0.46 and peak RSS 1.50–1.59 GiB with optimisation all (disabled: 0.48–0.49, 1.48–1.63 GiB), vs 0.58–0.62 and 2.76 GiB for v1 [M] (docs/ARCHITECTURE.md § 8).',
    'Browser WASM heap 616 MiB reserved / 510 MiB touched on a physical iPhone, flat over a whole song [M].',
    'WebGPU: session partitioning fails with dynamic shapes (/real_istft/Slice_2041) [M]; needs its own static-shape variant.',
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
  HTDEMUCS_6S_STAGE4,
  HTDEMUCS_6S_FOLDED,
  HTDEMUCS_6S_UPSTREAM,
  HTDEMUCS_6S_FOLDED_FP16W,
  GUITAR_LEAD_RHYTHM_ML,
  BANQUET_PIANO,
];

/** The artifact every tier must use for primary separation in this release (rollback: HTDEMUCS_6S_FOLDED). */
export const PRIMARY_SEPARATION_MODEL: ModelArtifact = HTDEMUCS_6S_STAGE4;

export function findModel(id: string): ModelArtifact | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

export function requireIO(model: ModelArtifact): ModelIO {
  if (model.io === null) {
    throw new Error(`Model ${model.id} has no tensor I/O spec (availability: ${model.availability}).`);
  }
  return model.io;
}
