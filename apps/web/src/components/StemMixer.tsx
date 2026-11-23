import { useEffect, useState } from 'react';
import type { StemName } from '@stemsplit/core';
import type { StemPlayer } from '../audio/stem-player.ts';
import type { StemChannelState } from '../audio/mix-logic.ts';
import { sliderToGain } from '../audio/mix-logic.ts';
import { downloadBlob, shareFiles, stemFilename, stemToWavBlob } from '../audio/export.ts';

const LABELS: Readonly<Record<StemName, string>> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Other',
  guitar: 'Guitar',
  piano: 'Piano',
  guitar_lead: 'Lead guitar',
  guitar_rhythm: 'Rhythm guitar',
};

interface Channel extends StemChannelState {
  readonly slider: number;
}

export function StemMixer({ player, stems, baseName }: { player: StemPlayer; stems: readonly StemName[]; baseName: string }) {
  const [channels, setChannels] = useState<Record<string, Channel>>(() =>
    Object.fromEntries(stems.map((s) => [s, { muted: false, soloed: false, gain: 1, slider: 0.75 }])),
  );
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);

  useEffect(() => player.applyMix(channels), [channels, player]);
  useEffect(() => {
    const id = setInterval(() => {
      setPosition(player.position);
      setPlaying(player.playing);
    }, 200);
    return () => clearInterval(id);
  }, [player]);

  const patch = (stem: string, p: Partial<Channel>) => setChannels((c) => ({ ...c, [stem]: { ...c[stem]!, ...p } }));

  const exportStem = async (stem: StemName, share: boolean) => {
    const data = player.channelData(stem);
    if (!data) return;
    const blob = stemToWavBlob(data[0], data[1], 24);
    const name = stemFilename(baseName, stem, 24);
    if (share && (await shareFiles([new File([blob], name, { type: 'audio/wav' })]))) return;
    downloadBlob(blob, name);
  };

  return (
    <section className="mixer">
      <div className="transport">
        <button type="button" onClick={() => (playing ? player.pause() : void player.play())}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          min={0}
          max={player.duration || 1}
          step={0.01}
          value={position}
          onChange={(e) => player.seek(Number(e.target.value))}
          aria-label="Position"
        />
        <span className="time">{fmt(position)} / {fmt(player.duration)}</span>
      </div>
      {stems.map((stem) => {
        const ch = channels[stem]!;
        return (
          <div className="channel" key={stem}>
            <span className="channel__name">{LABELS[stem]}</span>
            <button type="button" aria-pressed={ch.soloed} className={ch.soloed ? 'on' : ''} onClick={() => patch(stem, { soloed: !ch.soloed })}>
              S
            </button>
            <button type="button" aria-pressed={ch.muted} className={ch.muted ? 'on' : ''} onClick={() => patch(stem, { muted: !ch.muted })}>
              M
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={ch.slider}
              aria-label={`${LABELS[stem]} level`}
              onChange={(e) => {
                const slider = Number(e.target.value);
                patch(stem, { slider, gain: sliderToGain(slider) });
              }}
            />
            <button type="button" onClick={() => void exportStem(stem, true)}>
              Export
            </button>
          </div>
        );
      })}
    </section>
  );
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}
