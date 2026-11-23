#!/usr/bin/env node
/**
 * stemsplit CLI — same engine and models as the server and the PWA.
 *
 *   stemsplit separate <input> [-o dir] [--scope quick|full|guitar] [--format wav24,mp3] [--refine-piano] [--threads N] [--no-limit]
 *   stemsplit serve [--port 8787] [--host 0.0.0.0] [--data .data] [--threads N]
 *   stemsplit submit <input> --server http://host:8787 [--scope …] [--format …] [-o dir]
 *   stemsplit models fetch | list
 *   stemsplit bench <input> [--seconds 31.2] [--threads 4]
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import type { CreateJobRequest, CreateJobResponse, JobRecord, OutputFormat, SeparationScope } from '@stemsplit/core';
import { MODEL_REGISTRY, OUTPUT_FORMATS, PRIMARY_SEPARATION_MODEL, SEPARATION_SCOPES, extensionOf, formatBytes, isJobRecord } from '@stemsplit/core';
import { bench, formatBench } from './bench.ts';
import { probe } from './ffmpeg.ts';
import { createApiServer, signedUrl } from './http.ts';
import { JobStore } from './job-store.ts';
import { ensureModel } from './models.ts';
import { createOrtRunner } from './ort-runner.ts';
import { runPipeline } from './pipeline.ts';
import { JobWorker } from './worker.ts';

const log = (msg: string) => process.stderr.write(`${msg}\n`);

function parseScope(v: string | undefined): SeparationScope {
  const s = v ?? 'full';
  if (!(SEPARATION_SCOPES as readonly string[]).includes(s)) throw new Error(`--scope must be one of ${SEPARATION_SCOPES.join(', ')}`);
  return s as SeparationScope;
}

function parseFormats(v: string | undefined): OutputFormat[] {
  const list = (v ?? 'wav24').split(',').map((s) => s.trim());
  for (const f of list) if (!(OUTPUT_FORMATS as readonly string[]).includes(f)) throw new Error(`Unknown format ${f}; use ${OUTPUT_FORMATS.join(', ')}`);
  return list as OutputFormat[];
}

function bar(fraction: number, width = 24): string {
  const n = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return `[${'#'.repeat(n)}${'.'.repeat(width - n)}]`;
}

async function cmdSeparate(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      scope: { type: 'string' },
      format: { type: 'string' },
      'refine-piano': { type: 'boolean', default: false },
      threads: { type: 'string' },
      'no-limit': { type: 'boolean', default: false },
    },
  });
  const input = positionals[0];
  if (!input) throw new Error('usage: stemsplit separate <input> [-o dir]');
  const scope = parseScope(values.scope);
  const formats = parseFormats(values.format);
  const outDir = resolve(values.out ?? join('out', basename(input).replace(/\.[^.]+$/, '')));
  const model = PRIMARY_SEPARATION_MODEL;
  const path = await ensureModel(model, log);
  const runner = await createOrtRunner(model, path, { intraOpThreads: Number(values.threads ?? 0) });
  const t0 = performance.now();
  let lastLine = '';
  const result = await runPipeline({
    inputPath: input,
    outDir,
    scope,
    options: { refinePiano: values['refine-piano'], formats },
    runner,
    modelLabel: `${model.id}@${model.version}`,
    ...(values['no-limit'] ? { maxDurationSec: Number.POSITIVE_INFINITY } : {}),
    onStage: (stage, fraction) => {
      const line = `${stage.padEnd(12)} ${bar(fraction)} ${(fraction * 100).toFixed(0).padStart(3)}%`;
      if (line !== lastLine && process.stderr.isTTY) process.stderr.write(`\r${line}`);
      else if (line !== lastLine && fraction === 1) log(line);
      lastLine = line;
    },
  });
  await runner.release();
  if (process.stderr.isTTY) process.stderr.write('\n');
  const secs = (performance.now() - t0) / 1000;
  log(`\n${result.durationSec.toFixed(1)} s of audio in ${secs.toFixed(1)} s (RTF ${(secs / result.durationSec).toFixed(2)})`);
  for (const w of result.warnings) log(`warning [${w.code}] ${w.message}`);
  for (const s of result.stems) log(`  ${s.stem.padEnd(14)} ${s.format.padEnd(6)} ${formatBytes(s.bytes).padStart(9)}  ${s.path}`);
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ input: basename(input), scope, model: model.id, sha256: model.sha256, ...result }, null, 2));
}

async function cmdServe(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: 'string' }, host: { type: 'string' }, data: { type: 'string' }, threads: { type: 'string' }, rtf: { type: 'string' } },
  });
  const port = Number(values.port ?? process.env.PORT ?? 8787);
  // Hugging Face Spaces inject SPACE_HOST (e.g. "owner-name.hf.space"), so signed links work with zero config there.
  const publicBaseUrl =
    process.env.STEMSPLIT_PUBLIC_URL ?? (process.env.SPACE_HOST ? `https://${process.env.SPACE_HOST}` : `http://localhost:${port}`);
  const secret = process.env.STEMSPLIT_SIGNING_SECRET ?? randomBytes(32).toString('hex');
  if (!process.env.STEMSPLIT_SIGNING_SECRET) log('STEMSPLIT_SIGNING_SECRET not set; using an ephemeral secret (URLs die on restart).');
  const model = PRIMARY_SEPARATION_MODEL;
  const runner = await createOrtRunner(model, await ensureModel(model, log), { intraOpThreads: Number(values.threads ?? 0) });
  const store = new JobStore(resolve(values.data ?? '.data/jobs'));
  await store.load();
  const worker = new JobWorker({
    store,
    runner,
    modelLabel: `${model.id}@${model.version}`,
    rtf: Number(values.rtf ?? 0.6),
    signUrl: (id, file, exp) => signedUrl(publicBaseUrl, secret, `/v1/jobs/${id}/stems/${file}`, exp),
    log,
  });
  const server = createApiServer({ store, worker, primary: model, publicBaseUrl, signingSecret: secret, corsOrigin: process.env.STEMSPLIT_CORS_ORIGIN ?? '*', log });
  setInterval(() => void store.sweep().catch((e: unknown) => log(`sweep failed: ${String(e)}`)), 3600_000).unref();
  // Behind a TLS reverse proxy, bind to 127.0.0.1 so the plain-HTTP port is never exposed.
  const host = values.host ?? process.env.STEMSPLIT_HOST ?? '0.0.0.0';
  server.listen(port, host, () => log(`stemsplit API listening on ${publicBaseUrl} (model ${model.id}, sha256 ${model.sha256?.slice(0, 12)}…)`));
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
};

async function cmdSubmit(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { server: { type: 'string' }, scope: { type: 'string' }, format: { type: 'string' }, out: { type: 'string', short: 'o' }, 'refine-piano': { type: 'boolean', default: false } },
  });
  const input = positionals[0];
  const server = values.server ?? process.env.STEMSPLIT_SERVER;
  if (!input || !server) throw new Error('usage: stemsplit submit <input> --server <url>');
  const info = await probe(input);
  const bytes = (await stat(input)).size;
  const body: CreateJobRequest = {
    scope: parseScope(values.scope),
    options: { refinePiano: values['refine-piano'], formats: parseFormats(values.format) },
    input: { filename: basename(input), bytes, contentType: CONTENT_TYPES[extensionOf(input)] ?? 'application/octet-stream', durationSec: info.durationSec },
    clientModelSha256: PRIMARY_SEPARATION_MODEL.sha256,
    idempotencyKey: randomBytes(12).toString('base64url'),
  };
  const created = await fetch(`${server}/v1/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!created.ok) throw new Error(`create failed: HTTP ${created.status} ${await created.text()}`);
  const { job, upload } = (await created.json()) as CreateJobResponse;
  log(`job ${job.id} created; uploading ${formatBytes(bytes)}`);
  const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: await readFile(input) });
  if (!put.ok) throw new Error(`upload failed: HTTP ${put.status} ${await put.text()}`);
  let current = (await put.json()) as JobRecord;
  while (current.status !== 'succeeded' && current.status !== 'failed' && current.status !== 'cancelled') {
    const res = await fetch(`${server}/v1/jobs/${job.id}?since=${current.revision}`);
    const next: unknown = await res.json();
    if (!isJobRecord(next)) throw new Error('server returned an invalid job record');
    current = next;
    const p = current.progress;
    log(`${current.status.padEnd(10)} ${p ? bar(p.fraction) : ''} ${current.queuePosition ? `queue #${current.queuePosition}` : ''} ${current.etaSec !== null ? `eta ${current.etaSec}s` : ''}`);
  }
  if (current.status !== 'succeeded') throw new Error(`job ${current.status}: ${current.error?.message ?? ''}`);
  const outDir = resolve(values.out ?? join('out', `${basename(input).replace(/\.[^.]+$/, '')}.remote`));
  await mkdir(outDir, { recursive: true });
  for (const w of current.warnings) log(`warning [${w.code}] ${w.message}`);
  for (const s of current.stems) {
    const file = new URL(s.url).pathname.split('/').at(-1)!;
    const res = await fetch(s.url);
    if (!res.ok || !res.body) throw new Error(`download ${file} failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(join(outDir, file)));
    log(`  downloaded ${file} (${formatBytes(s.bytes)})`);
  }
}

async function cmdModels(argv: string[]): Promise<void> {
  if (argv[0] === 'fetch') {
    await ensureModel(PRIMARY_SEPARATION_MODEL, log);
    return;
  }
  for (const m of MODEL_REGISTRY) {
    log(`${m.id.padEnd(28)} ${m.availability.padEnd(15)} ${m.bytes ? formatBytes(m.bytes).padStart(9) : '        —'}  ${m.hfRepo ?? '(no public artifact)'}`);
  }
}

async function cmdBench(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { seconds: { type: 'string' }, threads: { type: 'string' } } });
  if (!positionals[0]) throw new Error('usage: stemsplit bench <input>');
  console.log(formatBench(await bench(positionals[0], Number(values.seconds ?? 31.2), Number(values.threads ?? 4))));
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (argv: string[]) => Promise<void>> = {
  separate: cmdSeparate,
  serve: cmdServe,
  submit: cmdSubmit,
  models: cmdModels,
  bench: cmdBench,
};
const fn = command ? commands[command] : undefined;
if (!fn) {
  log('usage: stemsplit <separate|serve|submit|models|bench> …');
  process.exit(2);
}
fn(rest).catch((e: unknown) => {
  log(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
