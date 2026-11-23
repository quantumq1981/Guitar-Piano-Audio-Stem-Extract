import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  SERVER_LIMITS,
  canTransition,
  estimateServerSeconds,
  isJobRecord,
  isTerminal,
  stemFileName,
  transition,
  validateCreateJobRequest,
} from '../src/index.ts';

const valid = {
  scope: 'guitar',
  options: { refinePiano: false, formats: ['wav24', 'mp3', 'wav24'] },
  input: { filename: 'Song.MP3', bytes: 3_000_000, contentType: 'audio/mpeg', durationSec: 200 },
  clientModelSha256: null,
  idempotencyKey: 'abcDEF12_-',
};

describe('validateCreateJobRequest', () => {
  it('accepts a valid request and de-duplicates formats', () => {
    const r = validateCreateJobRequest(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.options.formats).toEqual(['wav24', 'mp3']);
  });

  it('collects every error rather than failing fast', () => {
    const r = validateCreateJobRequest({
      scope: 'karaoke',
      options: { refinePiano: 'yes', formats: [] },
      input: { filename: 'a.exe', bytes: -1, contentType: 1, durationSec: 999 },
      clientModelSha256: 'XYZ',
      idempotencyKey: 'short',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(8);
  });

  it('enforces upload size and duration limits', () => {
    const big = validateCreateJobRequest({ ...valid, input: { ...valid.input, bytes: SERVER_LIMITS.maxUploadBytes + 1 } });
    expect(big.ok).toBe(false);
    const long = validateCreateJobRequest({ ...valid, input: { ...valid.input, durationSec: 361 } });
    expect(long.ok).toBe(false);
    const unknown = validateCreateJobRequest({ ...valid, input: { ...valid.input, durationSec: null } });
    expect(unknown.ok).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(validateCreateJobRequest(null).ok).toBe(false);
    expect(validateCreateJobRequest([]).ok).toBe(false);
  });
});

describe('job state machine', () => {
  it('allows the happy path and rejects illegal jumps', () => {
    const path = ['awaiting_upload', 'queued', 'decoding', 'separating', 'refining', 'encoding', 'succeeded', 'expired'] as const;
    for (let i = 1; i < path.length; i++) expect(transition(path[i - 1]!, path[i]!)).toBe(path[i]);
    expect(() => transition('succeeded', 'separating')).toThrow(IllegalTransitionError);
    expect(canTransition('expired', 'queued')).toBe(false);
    expect(canTransition('separating', 'encoding')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('queued')).toBe(false);
  });

  it('estimates server wall time monotonically in duration and stages', () => {
    const a = estimateServerSeconds(60, { rtf: 0.5, leadRhythm: false, pianoRefine: false });
    const b = estimateServerSeconds(120, { rtf: 0.5, leadRhythm: false, pianoRefine: false });
    const c = estimateServerSeconds(120, { rtf: 0.5, leadRhythm: true, pianoRefine: true });
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(estimateServerSeconds(0, { rtf: 1, leadRhythm: false, pianoRefine: false })).toBe(0);
  });
});

describe('misc contract helpers', () => {
  it('names stem files unambiguously', () => {
    expect(stemFileName('piano', 'wav16')).toBe('piano.wav');
    expect(stemFileName('piano', 'wav24')).toBe('piano.24bit.wav');
    expect(stemFileName('guitar_lead', 'flac')).toBe('guitar_lead.flac');
  });

  it('type-guards job records', () => {
    expect(isJobRecord({ id: 'x', revision: 1, status: 'queued', scope: 'full', stems: [], warnings: [], error: null })).toBe(true);
    expect(isJobRecord({ id: 'x', revision: 1, status: 'nope', scope: 'full', stems: [], warnings: [], error: null })).toBe(false);
  });
});
