import { describe, expect, it } from 'vitest';
import type { ModelIO, ResumeExpectation, RunManifest, SegmentRunner, StemName, StoredRunFiles, WavFormat } from '../src/index.ts';
import {
  RUN_MANIFEST_VERSION,
  WAV_HEADER_BYTES,
  decideResume,
  encodeInterleavedF32,
  inputFileBytes,
  interleavedFileSource,
  isRunManifest,
  memorySource,
  parseRunManifest,
  planChunks,
  runStorageNeed,
  separate,
  stemFileBytes,
  wavStemSink,
} from '../src/index.ts';
import { noise } from './helpers.ts';

const STEMS: StemName[] = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
const io: ModelIO = { inputName: 'mix', outputName: 'stems', segmentFrames: 2048, sampleRate: 44_100, channels: 2, stems: STEMS };
const pcm24: WavFormat = { sampleRate: 44_100, channels: 2, sampleFormat: 'pcm24' };
const FRAME_BYTES = 6;
const GRAPH_SHA = 'a'.repeat(64);

/**
 * Deterministic but nonlinear fake model: each output sample depends on its own input sample and on the window's
 * mean, so overlap-add cannot hide a wrong tail through linearity, and a wrong window position changes the mean.
 */
function nonlinearRunner(): SegmentRunner & { calls: number } {
  return {
    io,
    calls: 0,
    async run(input) {
      this.calls++;
      const n = io.segmentFrames;
      let mean = 0;
      for (let i = 0; i < input.length; i++) mean += input[i]!;
      mean /= input.length;
      const out = new Float32Array(STEMS.length * 2 * n);
      for (let s = 0; s < STEMS.length; s++) {
        for (let c = 0; c < 2; c++) {
          for (let k = 0; k < n; k++) {
            const x = input[c * n + k]!;
            out[(s * 2 + c) * n + k] = Math.tanh(x * (s + 1)) * 0.4 + x * x * 0.1 * (c + 1) + mean;
          }
        }
      }
      return out;
    },
  };
}

function memoryFiles(stems: number) {
  const files = Array.from({ length: stems }, () => new Uint8Array(0));
  return {
    files,
    port(stem: number, offset: number, bytes: Uint8Array) {
      const old = files[stem]!;
      if (offset + bytes.length > old.length) {
        const grown = new Uint8Array(offset + bytes.length);
        grown.set(old);
        files[stem] = grown;
      }
      files[stem]!.set(bytes, offset);
    },
    truncate(stem: number, bytes: number) {
      files[stem] = files[stem]!.slice(0, bytes);
    },
  };
}

function manifestFor(totalFrames: number, overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    version: RUN_MANIFEST_VERSION,
    modelId: 'test-model',
    graphSha256: GRAPH_SHA,
    totalFrames,
    sampleRate: io.sampleRate,
    channels: io.channels,
    segmentFrames: io.segmentFrames,
    overlapRatio: 0.25,
    sampleFormat: 'pcm24',
    stems: STEMS,
    source: { name: 'song.m4a', bytes: 12345 },
    threads: 1,
    createdAt: '2026-11-25T00:00:00.000Z',
    ...overrides,
  };
}

const expectation: ResumeExpectation = {
  modelId: 'test-model',
  graphSha256: GRAPH_SHA,
  sampleRate: io.sampleRate,
  channels: io.channels,
  segmentFrames: io.segmentFrames,
  overlapRatio: 0.25,
  stems: STEMS,
};

class Stop extends Error {}

/** A full run into memory files. */
async function uninterrupted(left: Float32Array, right: Float32Array) {
  const mem = memoryFiles(STEMS.length);
  await separate(memorySource([left, right], io.sampleRate), nonlinearRunner(), wavStemSink(STEMS.length, left.length, pcm24, mem.port));
  return mem.files;
}

/** A run that the "OS" stops just before chunk `stopAt`, leaving whatever the sink had written. */
async function stoppedRun(left: Float32Array, right: Float32Array, stopAt: number) {
  const mem = memoryFiles(STEMS.length);
  await expect(separate(memorySource([left, right], io.sampleRate), nonlinearRunner(), wavStemSink(STEMS.length, left.length, pcm24, mem.port), {
    beforeChunk: (chunk) => {
      if (chunk.index === stopAt) throw new Stop();
    },
  })).rejects.toBeInstanceOf(Stop);
  return mem;
}

/** What the web worker does on "Resume": decide from file sizes, truncate, restart the engine. */
async function resume(mem: ReturnType<typeof memoryFiles>, left: Float32Array, right: Float32Array) {
  const decision = decideResume(manifestFor(left.length), expectation, {
    inputBytes: inputFileBytes(left.length, 2),
    stemBytes: mem.files.map((f) => f.length),
  });
  if (decision.kind !== 'resume') throw new Error(`expected resume, got ${decision.kind}`);
  for (let s = 0; s < STEMS.length; s++) mem.truncate(s, decision.keepBytes);
  const runner = nonlinearRunner();
  const sink = wavStemSink(STEMS.length, left.length, pcm24, mem.port, { resumeFrom: decision.keepFrames });
  await separate(memorySource([left, right], io.sampleRate), runner, sink, { startChunk: decision.startChunk });
  sink.finish();
  return { decision, runner };
}

describe('resuming a stopped separation', () => {
  // 1 chunk, exactly 2 chunks' worth of stride, and ragged multi-chunk songs.
  for (const frames of [1500, 2048, 2048 + 1536, 9001, 20_000]) {
    it(`gives byte-identical stems after a stop before any chunk (${frames} frames)`, async () => {
      const left = noise(frames, 11);
      const right = noise(frames, 12);
      const reference = await uninterrupted(left, right);
      const count = planChunks(frames, io.segmentFrames).chunks.length;
      for (let stopAt = 0; stopAt < count; stopAt++) {
        const mem = await stoppedRun(left, right, stopAt);
        const { decision, runner } = await resume(mem, left, right);
        expect(decision.startChunk).toBe(stopAt);
        // Chunks from stopAt on, plus one re-run for the overlap tail when there is a previous chunk.
        expect(runner.calls).toBe(count - stopAt + (stopAt > 0 ? 1 : 0));
        for (let s = 0; s < STEMS.length; s++) expect(mem.files[s]).toEqual(reference[s]);
      }
    });
  }

  it('recovers from a write torn mid-block and stems that stopped at different blocks', async () => {
    const frames = 20_000;
    const left = noise(frames, 21);
    const right = noise(frames, 22);
    const reference = await uninterrupted(left, right);
    const mem = await stoppedRun(left, right, 6); // blocks 0-5 written: 6 × 1536 frames
    // Torn: stem 2 lost part of its last block; stem 4 lost a whole block plus a few bytes; stem 5 lost 1 byte.
    mem.truncate(2, mem.files[2]!.length - 1000);
    mem.truncate(4, mem.files[4]!.length - 1536 * FRAME_BYTES - 7);
    mem.truncate(5, mem.files[5]!.length - 1);
    const { decision } = await resume(mem, left, right);
    expect(decision.startChunk).toBe(4);
    expect(decision.keepFrames).toBe(4 * 1536);
    for (let s = 0; s < STEMS.length; s++) expect(mem.files[s]).toEqual(reference[s]);
  });

  it('restarts from scratch when a stem has no complete header or is missing', async () => {
    const frames = 9001;
    const left = noise(frames, 31);
    const right = noise(frames, 32);
    const reference = await uninterrupted(left, right);
    const mem = await stoppedRun(left, right, 3);
    mem.truncate(1, 20); // header torn
    const { decision } = await resume(mem, left, right);
    expect(decision).toMatchObject({ startChunk: 0, keepFrames: 0, keepBytes: 0 });
    for (let s = 0; s < STEMS.length; s++) expect(mem.files[s]).toEqual(reference[s]);

    const missing = decideResume(manifestFor(frames), expectation, {
      inputBytes: inputFileBytes(frames, 2),
      stemBytes: [...reference.map((f) => f.length).slice(0, 5), null],
    });
    expect(missing).toMatchObject({ kind: 'resume', startChunk: 0, keepBytes: 0 });
  });

  it('reports a finished run as complete', () => {
    const frames = 9001;
    const d = decideResume(manifestFor(frames), expectation, {
      inputBytes: inputFileBytes(frames, 2),
      stemBytes: STEMS.map(() => stemFileBytes(frames, pcm24)),
    });
    expect(d.kind).toBe('complete');
  });

  it('refuses runs it cannot continue exactly', () => {
    const frames = 9001;
    const files: StoredRunFiles = { inputBytes: inputFileBytes(frames, 2), stemBytes: STEMS.map(() => 100) };
    const reason = (m: RunManifest, f = files) => {
      const d = decideResume(m, expectation, f);
      return d.kind === 'unusable' ? d.reason : d.kind;
    };
    expect(reason(manifestFor(frames, { graphSha256: 'b'.repeat(64) }))).toMatch(/model/);
    expect(reason(manifestFor(frames, { modelId: 'other' }))).toMatch(/model/);
    expect(reason(manifestFor(frames, { sampleRate: 48_000 }))).toMatch(/audio format/);
    expect(reason(manifestFor(frames, { overlapRatio: 0.2 }))).toMatch(/geometry/);
    expect(reason(manifestFor(frames, { stems: [...STEMS].reverse() }))).toMatch(/stem order/);
    expect(reason(manifestFor(frames), { ...files, inputBytes: null })).toMatch(/missing/);
    expect(reason(manifestFor(frames), { ...files, inputBytes: inputFileBytes(frames, 2) - 4 })).toMatch(/incomplete/);
    expect(reason(manifestFor(frames), { ...files, stemBytes: STEMS.map(() => stemFileBytes(frames, pcm24) + 1) })).toMatch(/longer/);
    expect(() => decideResume(manifestFor(frames), expectation, { ...files, stemBytes: [100] })).toThrow(RangeError);
  });
});

describe('separate() startChunk', () => {
  it('rejects out-of-range start chunks', async () => {
    const src = memorySource([noise(5000, 1), noise(5000, 2)], io.sampleRate);
    const sink = { write: () => {} };
    for (const startChunk of [-1, 1.5, 4, 99]) {
      await expect(separate(src, nonlinearRunner(), sink, { startChunk })).rejects.toThrow(RangeError);
    }
  });

  it('reports progress over the whole song and an ETA from this call only', async () => {
    const frames = 20_000; // 13 chunks
    const src = memorySource([noise(frames, 1), noise(frames, 2)], io.sampleRate);
    let t = 0;
    const progress: { chunk: number; etaMs: number | null }[] = [];
    await separate(src, { io, run: async (x) => { t += 10; return nonlinearRunner().run(x); } }, { write: () => {} }, {
      startChunk: 10,
      now: () => t,
      onProgress: (p) => progress.push({ chunk: p.chunk, etaMs: p.etaMs }),
    });
    expect(progress.map((p) => p.chunk)).toEqual([11, 12, 13]);
    // First progress: two runs (re-run of chunk 9 + chunk 10) took 20 ms → 10 ms per chunk, 2 chunks left.
    expect(progress[0]!.etaMs).toBe(20);
    expect(progress.at(-1)!.etaMs).toBe(0);
  });
});

describe('wavStemSink resumeFrom', () => {
  it('appends after the kept frames without rewriting the header', async () => {
    const mem = memoryFiles(1);
    const sink = wavStemSink(1, 3000, pcm24, mem.port, { resumeFrom: 1536 });
    await expect(sink.write({ start: 0, frames: 10, planes: [[new Float32Array(10), new Float32Array(10)]] })).rejects.toThrow(/contiguous/);
    await sink.write({ start: 1536, frames: 1464, planes: [[new Float32Array(1464), new Float32Array(1464)]] });
    expect(sink.finish().frames).toBe(3000);
    expect(mem.files[0]!.subarray(0, WAV_HEADER_BYTES).every((b) => b === 0)).toBe(true); // header untouched
    expect(mem.files[0]!.length).toBe(stemFileBytes(3000, pcm24));
  });

  it('rejects resume points outside the song', () => {
    for (const resumeFrom of [-1, 3000, 0.5]) expect(() => wavStemSink(1, 3000, pcm24, () => {}, { resumeFrom })).toThrow(RangeError);
  });
});

describe('run manifest', () => {
  it('round-trips through JSON and rejects malformed files', () => {
    const m = manifestFor(9001);
    expect(parseRunManifest(JSON.stringify(m))).toEqual(m);
    expect(parseRunManifest('{')).toBeNull();
    expect(parseRunManifest('null')).toBeNull();
    const bad: unknown[] = [
      { ...m, version: 2 },
      { ...m, graphSha256: 'ABC' },
      { ...m, totalFrames: 0 },
      { ...m, totalFrames: 1.5 },
      { ...m, overlapRatio: 0.5 },
      { ...m, sampleFormat: 'mp3' },
      { ...m, stems: [] },
      { ...m, stems: ['a', 'a'] },
      { ...m, source: { name: 'x' } },
      { ...m, threads: 0 },
      [m],
    ];
    for (const b of bad) expect(isRunManifest(b)).toBe(false);
  });
});

describe('stored input', () => {
  it('reads back exactly what was encoded, in bounded blocks', async () => {
    const frames = 5000;
    const left = noise(frames, 41);
    const right = noise(frames, 42);
    const file = new Uint8Array(inputFileBytes(frames, 2));
    for (let start = 0; start < frames; start += 1777) {
      const n = Math.min(1777, frames - start);
      file.set(encodeInterleavedF32([left, right], start, n), start * 8);
    }
    const src = interleavedFileSource(frames, io.sampleRate, 2, (offset, into) => {
      const part = file.subarray(offset, offset + into.length);
      into.set(part);
      return part.length;
    });
    const out = [new Float32Array(600), new Float32Array(600)];
    await src.read(4400, 600, out);
    expect(out[0]).toEqual(left.subarray(4400, 5000));
    expect(out[1]).toEqual(right.subarray(4400, 5000));
    await expect(src.read(4500, 600, out)).rejects.toThrow(RangeError);
  });

  it('fails loudly on a short read', async () => {
    const src = interleavedFileSource(100, io.sampleRate, 2, () => 3);
    await expect(src.read(0, 10, [new Float32Array(10), new Float32Array(10)])).rejects.toThrow(/Short read/);
  });

  it('gives the same stems from the stored file as from memory', async () => {
    const frames = 9001;
    const left = noise(frames, 51);
    const right = noise(frames, 52);
    const file = encodeInterleavedF32([left, right], 0, frames);
    const reference = await uninterrupted(left, right);
    const mem = memoryFiles(STEMS.length);
    const src = interleavedFileSource(frames, io.sampleRate, 2, (offset, into) => {
      into.set(file.subarray(offset, offset + into.length));
      return into.length;
    });
    await separate(src, nonlinearRunner(), wavStemSink(STEMS.length, frames, pcm24, mem.port));
    for (let s = 0; s < STEMS.length; s++) expect(mem.files[s]).toEqual(reference[s]);
  });

  it('sizes the storage a run needs', () => {
    const need = runStorageNeed(44_100 * 240, 6, pcm24);
    expect(need.stems).toBe(6 * (44 + 44_100 * 240 * 6));
    expect(need.input).toBe(44_100 * 240 * 8);
    expect(need.total).toBe(need.stems + need.input);
  });
});
