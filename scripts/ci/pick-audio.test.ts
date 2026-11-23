import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations
import { isAudio, safeName, selectInboxAudio, toMatrix } from './pick-audio.mjs';

describe('pick-audio', () => {
  it('selects only audio files under inbox/, de-duplicated', () => {
    expect(
      selectInboxAudio(['inbox/a.mp3', 'inbox/README.md', 'song.mp3', 'inbox/b.WAV', 'inbox/a.mp3', 'inbox/sub/c.m4a', 'inbox/x.mp4']),
    ).toEqual(['inbox/a.mp3', 'inbox/b.WAV', 'inbox/sub/c.m4a']);
  });

  it('recognises every supported extension case-insensitively', () => {
    for (const ext of ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'MP3']) expect(isAudio(`x.${ext}`)).toBe(true);
    expect(isAudio('.mp3')).toBe(false);
    expect(isAudio('notes.txt')).toBe(false);
  });

  it('makes artifact-safe names and keeps apostrophes', () => {
    expect(safeName("inbox/D'Angelo - Lady.mp3")).toBe("D'Angelo - Lady");
    expect(safeName('inbox/a:b*c?.mp3')).toBe('a_b_c_');
    expect(safeName('inbox/.mp3')).toBe('song');
    expect(safeName('inbox/Ünïcode Café.mp3')).toBe('Ünïcode Café');
  });

  it('disambiguates duplicate names', () => {
    expect(toMatrix(['inbox/take.mp3', 'inbox/v2/take.wav']).map((m: { name: string }) => m.name)).toEqual(['take', 'take (2)']);
  });
});
