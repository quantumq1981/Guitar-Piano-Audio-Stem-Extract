#!/usr/bin/env node
/**
 * Decide which audio files a "Separate songs" workflow run should process, and
 * emit them as a GitHub Actions matrix: [{ path, name }].
 *
 *   push:              audio files added/modified under inbox/ in the pushed commits
 *   workflow_dispatch: the single file named in the `file` input (any path in the repo)
 *
 * Usage: node scripts/ci/pick-audio.mjs --before <sha> --after <sha> [--file <path>]
 * Writes `matrix=<json>` and `count=<n>` to $GITHUB_OUTPUT when set, else prints JSON.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'];
const ZERO_SHA = /^0{40}$/;

export function isAudio(path) {
  const dot = path.lastIndexOf('.');
  return dot > 0 && AUDIO_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

/** Artifact- and directory-safe name: keeps letters (any script), digits, space, dot, dash, underscore, apostrophe. */
export function safeName(path) {
  const base = path.split('/').at(-1).replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[^\p{L}\p{N} ._'-]+/gu, '_').replace(/\s+/g, ' ').trim();
  return (cleaned || 'song').slice(0, 80);
}

/** Pure selection over a list of changed paths (unit-tested). */
export function selectInboxAudio(changedPaths) {
  const seen = new Set();
  const out = [];
  for (const p of changedPaths) {
    if (!p.startsWith('inbox/') || !isAudio(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Disambiguate equal names (two "take.mp3" in different folders). */
export function toMatrix(paths) {
  const used = new Map();
  return paths.map((path) => {
    let name = safeName(path);
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    return { path, name };
  });
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function changedFiles(before, after) {
  // core.quotePath=false: otherwise git prints non-ASCII names as quoted octal escapes ("\303\234…").
  if (!before || ZERO_SHA.test(before)) return git('-c', 'core.quotePath=false', 'ls-files', 'inbox'); // first push of the branch
  return git('-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=AMR', `${before}`, `${after}`, '--', 'inbox');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { before: { type: 'string' }, after: { type: 'string' }, file: { type: 'string' } } });
  let paths;
  if (values.file && values.file.trim()) {
    const file = values.file.trim();
    if (!existsSync(file)) throw new Error(`No such file in the repository: ${file}`);
    if (!isAudio(file)) throw new Error(`Not a supported audio file (${AUDIO_EXTENSIONS.join(', ')}): ${file}`);
    paths = [file];
  } else {
    paths = selectInboxAudio(changedFiles(values.before, values.after ?? 'HEAD'));
  }
  const matrix = JSON.stringify(toMatrix(paths));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\ncount=${paths.length}\n`);
  else console.log(matrix);
}
