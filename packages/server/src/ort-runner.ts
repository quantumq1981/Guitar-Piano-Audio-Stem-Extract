/**
 * onnxruntime-node SegmentRunner. One InferenceSession per process: the
 * htdemucs_6s session peaks above 1 GiB, so concurrency is achieved with more
 * containers, not more sessions.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import * as ort from 'onnxruntime-node';
import type { ModelArtifact, ModelIO, SegmentRunner } from '@stemsplit/core';
import { graphOptimizationFor, requireIO } from '@stemsplit/core';

export interface OrtRunnerOptions {
  readonly intraOpThreads?: number;
  /** Skip the sha256 check (tests with synthetic models only). */
  readonly skipHashCheck?: boolean;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class ModelHashMismatchError extends Error {
  constructor(path: string, expected: string, actual: string) {
    super(`Model at ${path} has sha256 ${actual}, registry pins ${expected}. Refusing to run a drifted artifact.`);
    this.name = 'ModelHashMismatchError';
  }
}

export interface OrtSegmentRunner extends SegmentRunner {
  release(): Promise<void>;
}

export async function createOrtRunner(model: ModelArtifact, path: string, opts: OrtRunnerOptions = {}): Promise<OrtSegmentRunner> {
  const io: ModelIO = requireIO(model);
  if (!opts.skipHashCheck && model.sha256 !== null) {
    const actual = await sha256File(path);
    if (actual !== model.sha256) throw new ModelHashMismatchError(path, model.sha256, actual);
  }
  if (!opts.skipHashCheck && model.externalData) {
    // ORT reads the data file by the name the graph records, from the graph's directory.
    const dataPath = join(dirname(path), model.externalData.file);
    const actual = await sha256File(dataPath).catch(() => 'missing');
    if (actual !== model.externalData.sha256) throw new ModelHashMismatchError(dataPath, model.externalData.sha256, actual);
  }
  const session = await ort.InferenceSession.create(path, {
    executionProviders: ['cpu'],
    // Validated per tier (registry). Stage IV on the server: 'all' is ~7 % faster than 'disabled', same memory and parity [M].
    graphOptimizationLevel: graphOptimizationFor(model, 'server'),
    intraOpNumThreads: opts.intraOpThreads ?? 0,
    // Measured: arena + memory-pattern planning push peak RSS from 2.4 GiB to 4.7 GiB
    // by the second segment for a <20% speed gain. Bounded memory wins on shared containers.
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
  const shape = [1, io.channels, io.segmentFrames];
  const expectedOut = io.stems.length * io.channels * io.segmentFrames;

  return {
    io,
    async run(input: Float32Array): Promise<Float32Array> {
      const feeds = { [io.inputName]: new ort.Tensor('float32', input, shape) };
      const result = await session.run(feeds);
      const out = result[io.outputName];
      if (!out || !(out.data instanceof Float32Array) || out.data.length !== expectedOut) {
        throw new Error(`Unexpected model output for ${io.outputName}: dims=${String(out?.dims)}`);
      }
      // ORT may reuse the output buffer on the next run; copy before returning.
      return new Float32Array(out.data);
    },
    async release() {
      await session.release();
    },
  };
}
