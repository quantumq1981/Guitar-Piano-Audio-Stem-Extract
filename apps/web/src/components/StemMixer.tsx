import { useEffect, useState } from 'react';
import type { StemName } from '@stemsplit/core';
import { STEM_LABELS } from '@stemsplit/core';
import type { StemPlayer } from '../audio/stem-player.ts';
import type { StemChannelState } from '../audio/mix-logic.ts';
import { sliderToGain } from '../audio/mix-logic.ts';
import { downloadBlob, shareFiles, stemFilename, stemToWavBlob } from '../audio/export.ts';
import { Icon, STEM_COLORS } from './ui.tsx';


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
    <section className="mixer stack">
      <div className="transport card">
        <button type="button" className="transport__play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => (playing ? player.pause() : void player.play())}>
          <Icon name={playing ? 'pause' : 'play'} size={22} />
        </button>
        <input type="range" min={0} max={player.duration || 1} step={0.01} value={position} onChange={(e) => player.seek(Number(e.target.value))} aria-label="Position" />
        <span className="time">
          {fmt(position)} / {fmt(player.duration)}
        </span>
      </div>
      <ul className="stem-list">
        {stems.map((stem) => {
          const ch = channels[stem]!;
          const color = STEM_COLORS[stem];
          return (
            <li className="stem-row channel" key={stem}>
              <div className="stem-row__main">
                <span className="stem-row__name">
                  <span className="dot" style={{ background: color }} aria-hidden="true" />
                  {STEM_LABELS[stem]}
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={ch.slider}
                  style={{ accentColor: color }}
                  aria-label={`${STEM_LABELS[stem]} level`}
                  onChange={(e) => {
                    const slider = Number(e.target.value);
                    patch(stem, { slider, gain: sliderToGain(slider) });
                  }}
                />
              </div>
              <button type="button" className={ch.soloed ? 'toggle toggle--on' : 'toggle'} aria-pressed={ch.soloed} aria-label={`Solo ${STEM_LABELS[stem]}`} onClick={() => patch(stem, { soloed: !ch.soloed })}>
                Solo
              </button>
              <button type="button" className={ch.muted ? 'toggle toggle--on' : 'toggle'} aria-pressed={ch.muted} aria-label={`Mute ${STEM_LABELS[stem]}`} onClick={() => patch(stem, { muted: !ch.muted })}>
                Mute
              </button>
              <button type="button" className="icon-button icon-button--outline" aria-label={`Save ${STEM_LABELS[stem]}`} onClick={() => void exportStem(stem, true)}>
                <Icon name="save" size={18} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}
