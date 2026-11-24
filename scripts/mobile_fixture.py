"""Deterministic, licence-free music fixture for the mobile parity and quality gates.

Every sample is synthesised here from a seeded generator, so the fixture can be committed, regenerated and
published without clearance. One model window (343,980 frames, 44.1 kHz stereo) of a I-vi-IV-V progression
at 120 BPM with all six htdemucs_6s stems present, each in its own stereo position:

  drums  - kick (pitch-swept sine), snare (band-limited noise + tone), closed hats (high-passed noise)
  bass   - fundamental-dominant pluck on the chord roots
  other  - detuned sustained pad, wide
  vocals - additive glottal source through vowel formants, with vibrato, centred
  guitar - Karplus-Strong strummed chords, left
  piano  - inharmonic additive partials with per-partial decay, right

The music is synthetic, so separation scores are out of distribution for the model. They are a sanity check
that each stem receives its own energy, and a second, independent measure of whether two runtimes agree.

Usage: python scripts/mobile_fixture.py <mix.bin> <stems.bin>
  mix.bin   float32 little-endian [1, 2, 343980]
  stems.bin float32 little-endian [6, 2, 343980], order drums, bass, other, vocals, guitar, piano
"""
import argparse
import hashlib
import json

import numpy as np

SR = 44100
FRAMES = 343980
STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano']
BEAT = 0.5  # 120 BPM
# I-vi-IV-V in C, one chord per bar (two seconds); MIDI note numbers
CHORDS = [[48, 52, 55, 60], [45, 52, 57, 60], [41, 53, 57, 60], [43, 50, 55, 59]]
MELODY = [72, 74, 76, 74, 72, 69, 72, 71, 69, 67, 69, 72, 74, 72, 71, 67]  # one note per beat


def hz(midi):
    return 440.0 * 2.0 ** ((np.asarray(midi, dtype=np.float64) - 69) / 12)


def pan(mono, position):
    """Constant-power pan, position -1 (left) .. 1 (right)."""
    angle = (position + 1) * np.pi / 4
    return np.stack([np.cos(angle) * mono, np.sin(angle) * mono])


def onset_env(n, attack, decay):
    t = np.arange(n) / SR
    return np.minimum(1.0, t / attack) * np.exp(-t / decay)


def place(track, start_s, signal):
    start = int(round(start_s * SR))
    if start >= len(track):
        return
    end = min(len(track), start + len(signal))
    track[start:end] += signal[:end - start]


def drums(rng):
    kick, snare, hats = (np.zeros(FRAMES) for _ in range(3))
    t = np.arange(int(0.35 * SR)) / SR
    k = np.sin(2 * np.pi * np.cumsum(45 + 75 * np.exp(-t / 0.03)) / SR) * np.exp(-t / 0.12)
    k[:64] += np.linspace(0.6, 0, 64) * rng.standard_normal(64)
    for beat in range(0, 16, 2):
        place(kick, beat * BEAT, 0.9 * k)
    ts = np.arange(int(0.25 * SR)) / SR
    for beat in range(1, 16, 2):
        noise = rng.standard_normal(len(ts))
        noise = np.convolve(noise, np.ones(4) / 4, mode='same') - np.convolve(noise, np.ones(40) / 40, mode='same')
        place(snare, beat * BEAT, (0.5 * noise * np.exp(-ts / 0.06) + 0.3 * np.sin(2 * np.pi * 185 * ts) * np.exp(-ts / 0.04)))
    th = np.arange(int(0.06 * SR)) / SR
    for eighth in range(32):
        noise = rng.standard_normal(len(th))
        noise = noise - np.convolve(noise, np.ones(8) / 8, mode='same')
        place(hats, eighth * BEAT / 2, (0.25 if eighth % 2 else 0.18) * noise * np.exp(-th / 0.015))
    return pan(kick, 0) + pan(snare, 0.05) + pan(hats, 0.35)


def bass():
    track = np.zeros(FRAMES)
    t = np.arange(int(1.0 * SR)) / SR
    for bar, chord in enumerate(CHORDS):
        f = hz(chord[0] - 12)
        for step in range(4):
            note = sum(a * np.sin(2 * np.pi * k * f * t) for k, a in ((1, 1.0), (2, 0.35), (3, 0.12)))
            place(track, bar * 2.0 + step * BEAT, 0.5 * note * onset_env(len(t), 0.004, 0.35))
    return pan(track, 0)


def pad(rng):
    left, right = np.zeros(FRAMES), np.zeros(FRAMES)
    t = np.arange(int(2.0 * SR)) / SR
    window = np.minimum(1, np.minimum(t / 0.3, (2.0 - t) / 0.3))
    for bar, chord in enumerate(CHORDS):
        for note in chord[1:]:
            for detune, side in ((-0.06, left), (0.06, right)):
                f = hz(note + detune)
                phase = rng.uniform(0, 2 * np.pi)
                saw = sum(np.sin(2 * np.pi * k * f * t + k * phase) / k for k in range(1, 9))
                place(side, bar * 2.0, 0.035 * saw * window)
    return np.stack([left, right])


def vocals():
    track = np.zeros(FRAMES)
    formants = [(800, 80, 1.0), (1150, 90, 0.5), (2900, 120, 0.25)]  # vowel "ah"
    t = np.arange(int(BEAT * SR)) / SR
    for beat, note in enumerate(MELODY):
        f0 = hz(note) * 2 ** (0.4 / 12 * np.sin(2 * np.pi * 5.5 * t))
        phase = 2 * np.pi * np.cumsum(f0) / SR
        voice = np.zeros_like(t)
        for k in range(1, 40):
            fk = k * hz(note)
            if fk > 5000:
                break
            gain = sum(a / (1 + ((fk - fc) / bw) ** 2) for fc, bw, a in formants)
            voice += gain * np.sin(k * phase) / k ** 0.5
        place(track, beat * BEAT, 0.18 * voice * np.minimum(1, np.minimum(t / 0.03, (BEAT - t) / 0.05)))
    return pan(track, 0)


def guitar(rng):
    track = np.zeros(FRAMES)
    length = int(1.0 * SR)
    for bar, chord in enumerate(CHORDS):
        voicing = sorted(set(chord + [chord[1] + 12, chord[2] + 12]))
        for strum in range(4):
            for string, note in enumerate(voicing):
                period = int(round(SR / hz(note)))
                buf = rng.uniform(-1, 1, period)
                out = np.zeros(length)
                out[:period] = buf
                # Karplus-Strong in blocks of one period: each block depends only on the previous one
                for start in range(period, length, period):
                    prev = out[start - period:start]
                    nxt = 0.996 * 0.5 * (prev + np.roll(prev, 1))
                    out[start:start + period] = nxt[:min(period, length - start)]
                place(track, bar * 2.0 + strum * BEAT + string * 0.012, 0.09 * out)
    return pan(track, -0.6)


def piano():
    track = np.zeros(FRAMES)
    t = np.arange(int(1.5 * SR)) / SR
    for bar, chord in enumerate(CHORDS):
        for hit in (0, 1.0):
            for note in chord[1:] + [chord[0] + 12]:
                f = hz(note)
                b = 2e-4
                tone = sum(np.sin(2 * np.pi * k * f * np.sqrt(1 + b * k * k) * t) * np.exp(-t * (1.2 + 0.6 * k)) / k
                           for k in range(1, 12))
                place(track, bar * 2.0 + hit + 0.25, 0.12 * tone * np.minimum(1, t / 0.002))
    return pan(track, 0.55)


def render(seed=20261124):
    rng = np.random.default_rng(seed)
    stems = np.stack([drums(rng), bass(), pad(rng), vocals(), guitar(rng), piano()])
    peak = np.max(np.abs(stems.sum(axis=0)))
    stems *= 0.8 / peak
    return stems.sum(axis=0)[None].astype(np.float32), stems.astype(np.float32)


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('mix')
    p.add_argument('stems')
    args = p.parse_args()
    mix, stems = render()
    mix.astype('<f4').tofile(args.mix)
    stems.astype('<f4').tofile(args.stems)
    rms = np.sqrt(np.mean(np.square(mix.astype(np.float64))))
    print(json.dumps({
        'mixSha256': hashlib.sha256(mix.astype('<f4').tobytes()).hexdigest(),
        'mixRms': rms, 'peak': float(np.max(np.abs(mix))),
        'stemDbReMix': {name: round(10 * np.log10(np.mean(np.square(s.astype(np.float64))) / rms ** 2), 2)
                        for name, s in zip(STEMS, stems)},
    }, indent=2))


if __name__ == '__main__':
    main()
