import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateJobRequest, CreateJobResponse, JobRecord, ModelIO, SegmentRunner } from '@stemsplit/core';
import { PRIMARY_SEPARATION_MODEL, decodeWav, encodeWav } from '@stemsplit/core';
import { createApiServer, signedUrl, verify, sign } from '../src/http.ts';
import { JobStore } from '../src/job-store.ts';
import { JobWorker } from '../src/worker.ts';

const io: ModelIO = { ...PRIMARY_SEPARATION_MODEL.io!, segmentFrames: 44_100 };

/** Fake 6-stem model: each stem = input / 6, so Σ stems == mix exactly. */
const fakeRunner: SegmentRunner = {
  io,
  async run(input) {
    const n = io.segmentFrames;
    const out = new Float32Array(io.stems.length * 2 * n);
    for (let s = 0; s < io.stems.length; s++) for (let i = 0; i < 2 * n; i++) out[s * 2 * n + i] = input[i]! / 6;
    return out;
  },
};

let dir: string;
let base: string;
let close: () => Promise<void>;
let wavBytes: Uint8Array;
const secret = 'test-secret';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stemsplit-api-'));
  const store = new JobStore(join(dir, 'jobs'));
  await store.load();
  let publicBase = '';
  const worker = new JobWorker({
    store,
    runner: fakeRunner,
    modelLabel: 'fake',
    rtf: 0.1,
    signUrl: (id, file, exp) => signedUrl(publicBase, secret, `/v1/jobs/${id}/stems/${file}`, exp),
  });
  const server = createApiServer({ store, worker, primary: PRIMARY_SEPARATION_MODEL, publicBaseUrl: () => publicBase, signingSecret: secret, corsOrigin: '*' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  publicBase = base;
  close = () => new Promise((r) => server.close(() => r()));
  // 2.5 s stereo sine at 44.1 kHz.
  const frames = 110_250;
  const l = Float32Array.from({ length: frames }, (_, i) => 0.3 * Math.sin(i * 0.05));
  const r = Float32Array.from({ length: frames }, (_, i) => 0.3 * Math.cos(i * 0.03));
  wavBytes = encodeWav([l, r], { sampleRate: 44100, channels: 2, sampleFormat: 'pcm16' });
  await writeFile(join(dir, 'in.wav'), wavBytes);
});

afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

const request = (over: Partial<CreateJobRequest> = {}): CreateJobRequest => ({
  scope: 'guitar',
  options: { refinePiano: true, formats: ['wav24'] },
  input: { filename: 'in.wav', bytes: wavBytes.length, contentType: 'audio/wav', durationSec: 2.5 },
  clientModelSha256: PRIMARY_SEPARATION_MODEL.sha256,
  idempotencyKey: `key-${Math.random().toString(36).slice(2, 12)}`,
  ...over,
});

async function create(body: unknown): Promise<Response> {
  return fetch(`${base}/v1/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('v1 job API', () => {
  it('runs a job end to end: create → upload → long-poll → download', async () => {
    const res = await create(request());
    expect(res.status).toBe(201);
    const { job, upload } = (await res.json()) as CreateJobResponse;
    expect(job.status).toBe('awaiting_upload');

    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: wavBytes });
    expect(put.status).toBe(202);
    let current = (await put.json()) as JobRecord;
    const seen = new Set<string>([current.status]);
    while (!['succeeded', 'failed'].includes(current.status)) {
      current = (await (await fetch(`${base}/v1/jobs/${job.id}?since=${current.revision}`)).json()) as JobRecord;
      seen.add(current.status);
    }
    expect(current.error).toBeNull();
    expect(current.status).toBe('succeeded');
    expect(seen.has('queued')).toBe(true);
    expect(current.stems.map((s) => s.stem).sort()).toEqual(['bass', 'drums', 'guitar_lead', 'guitar_rhythm', 'other', 'piano', 'vocals']);
    expect(current.warnings.map((w) => w.code).sort()).toEqual(['lead_rhythm_heuristic', 'piano_refinement_unavailable']);

    const stem = current.stems.find((s) => s.stem === 'vocals')!;
    const dl = await fetch(stem.url);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    const decoded = decodeWav(new Uint8Array(await dl.arrayBuffer()));
    expect(decoded.format.sampleFormat).toBe('pcm24');
    expect(decoded.channels[0]!.length).toBe(110_250);

    const tampered = stem.url.replace(/sig=[^&]+/, 'sig=AAAA');
    expect((await fetch(tampered)).status).toBe(403);
  });

  it('is idempotent on idempotencyKey', async () => {
    const body = request();
    const a = (await (await create(body)).json()) as CreateJobResponse;
    const second = await create(body);
    expect(second.status).toBe(200);
    expect(((await second.json()) as CreateJobResponse).job.id).toBe(a.job.id);
  });

  it('rejects drifted client models, invalid bodies and unknown jobs', async () => {
    expect((await create(request({ clientModelSha256: 'f'.repeat(64) }))).status).toBe(409);
    const bad = await create({ scope: 'nope' });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    expect((await fetch(`${base}/v1/jobs/${'0'.repeat(32)}`)).status).toBe(404);
    expect((await fetch(`${base}/v1/jobs/..%2F..%2Fetc`)).status).toBe(404);
  });

  it('rejects unsigned uploads and fails undecodable input with a typed error', async () => {
    const { job, upload } = (await (await create(request({ scope: 'quick', options: { refinePiano: false, formats: ['wav16'] } }))).json()) as CreateJobResponse;
    expect((await fetch(`${base}/v1/jobs/${job.id}/input`, { method: 'PUT', body: wavBytes })).status).toBe(403);
    const put = await fetch(upload.url, { method: 'PUT', body: new Uint8Array([1, 2, 3, 4]) });
    expect(put.status).toBe(202);
    let current = (await put.json()) as JobRecord;
    while (!['succeeded', 'failed'].includes(current.status)) {
      current = (await (await fetch(`${base}/v1/jobs/${job.id}?since=${current.revision}`)).json()) as JobRecord;
    }
    expect(current.status).toBe('failed');
    expect(current.error?.code).toBe('decode_failed');
  });

  it('serves the model manifest', async () => {
    const m = (await (await fetch(`${base}/v1/models`)).json()) as { primary: { sha256: string } };
    expect(m.primary.sha256).toBe(PRIMARY_SEPARATION_MODEL.sha256);
  });
});

describe('URL signing', () => {
  it('verifies, expires and resists tampering', () => {
    const exp = Date.now() + 1000;
    const sig = sign('s', '/a', exp);
    expect(verify('s', '/a', exp, sig)).toBe(true);
    expect(verify('s', '/b', exp, sig)).toBe(false);
    expect(verify('t', '/a', exp, sig)).toBe(false);
    expect(verify('s', '/a', exp, sig, exp + 1)).toBe(false);
    expect(verify('s', '/a', Number.NaN, sig)).toBe(false);
  });
});
