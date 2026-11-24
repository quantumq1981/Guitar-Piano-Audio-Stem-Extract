import { useEffect, useRef, useState } from 'react';
import { MOBILE_STAGE4_CANDIDATE, planChunks } from '@stemsplit/core';
import { decodeForModel, probeDuration } from '../audio/decode.ts';
import { STAGE4_STEM_BYTES_PER_SAMPLE, STAGE4_STEM_DIRECTORY, type Stage4Message, type Stage4Request } from '../inference/stage4-protocol.ts';
const KEY = 'stemsplit.experimentalBenchmark';
const LOG = 'stemsplit.experimentalBenchmarkLog';
function savedLog(): string {try {return localStorage.getItem(LOG) ?? '';} catch {return '';}}
type Test = {kind: 'webgpu'; infer: boolean} | {kind: 'stage4'; windows: number} | {kind: 'song'; file: File};
type Stem = {name: string; url: string; bytes: number};
const IO = MOBILE_STAGE4_CANDIDATE.io;
const STAGE4_MB = Math.round((MOBILE_STAGE4_CANDIDATE.graph.bytes + MOBILE_STAGE4_CANDIDATE.data.bytes) / 1e6);
/** Measured on the first iPhone run (docs/MOBILE-INFERENCE-DEVELOPMENT.md); other devices differ. */
const IPHONE_SECONDS_PER_WINDOW = 12.5;
const windowsFor = (seconds: number) => planChunks(Math.max(1, Math.round(seconds * IO.sampleRate)), IO.segmentFrames).chunks.length;
// Sync access handles exist only inside dedicated workers, so the page can check for OPFS itself; the worker
// checks for createSyncAccessHandle before writing.
const opfsAvailable = () => typeof navigator.storage?.getDirectory === 'function';

export function MobileBenchmark({disabled, onBusy}: {disabled: boolean; onBusy: (busy: boolean) => void}) {
  const worker = useRef<Worker | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState(savedLog);
  const log = useRef(report);
  const [initialized, setInitialized] = useState(false);
  const [song, setSong] = useState<{file: File; seconds: number | null} | null>(null);
  const [stems, setStems] = useState<Stem[]>([]);
  function append(message: string) {
    log.current += '\n' + new Date().toISOString() + ' ' + message;
    try {localStorage.setItem(LOG, log.current);} catch {}
    setReport(log.current);
  }
  const [interrupted, setInterrupted] = useState(() => {try {return localStorage.getItem(KEY) !== null;} catch {return false;}});
  function stop(message: string) {
    worker.current?.terminate(); worker.current = null;
    clearTimeout(timer.current);
    void wakeLock.current?.release().catch(() => {}); wakeLock.current = null;
    try {localStorage.removeItem(KEY);} catch {}
    setRunning(false); onBusy(false);
    append(message);
  }
  useEffect(() => {
    const hide = () => {if (document.hidden && worker.current) stop('Stopped: page hidden');};
    document.addEventListener('visibilitychange', hide);
    return () => {document.removeEventListener('visibilitychange', hide); worker.current?.terminate(); clearTimeout(timer.current);};
  }, []);
  useEffect(() => () => {for (const s of stems) URL.revokeObjectURL(s.url);}, [stems]);

  async function showStems(files: readonly string[]) {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(STAGE4_STEM_DIRECTORY);
    const out: Stem[] = [];
    for (const name of files) {
      const file = await (await dir.getFileHandle(name)).getFile(); // disk-backed Blob: no copy in memory
      out.push({name, url: URL.createObjectURL(file), bytes: file.size});
    }
    setStems(out);
  }

  async function deleteStems() {
    setStems([]);
    try {
      await (await navigator.storage.getDirectory()).removeEntry(STAGE4_STEM_DIRECTORY, {recursive: true});
      append('Deleted the stems from this device');
    } catch (err) {append('Could not delete the stems: ' + String(err));}
  }

  async function startSong(file: File, w: Worker) {
    if (!opfsAvailable()) throw new Error('This browser has no origin-private file system (OPFS), needed to store the stems');
    append(`Decoding ${file.name} (${(file.size / 1e6).toFixed(1)} MB) at ${IO.sampleRate} Hz…`);
    const decoded = await decodeForModel(file);
    const frames = decoded.left.length;
    const need = IO.stems.length * (44 + frames * IO.channels * STAGE4_STEM_BYTES_PER_SAMPLE);
    const {quota, usage} = await navigator.storage.estimate();
    if (quota !== undefined && quota - (usage ?? 0) < need * 1.1) {
      throw new Error(`Not enough on-device storage: stems need ${(need / 1e6).toFixed(0)} MB, ${((quota - (usage ?? 0)) / 1e6).toFixed(0)} MB available`);
    }
    // Copies own their buffers, so they can be transferred; the decoded AudioBuffer is then free to be collected.
    const left = decoded.left.slice();
    const right = decoded.right.slice();
    append(`Decoded ${decoded.durationSec.toFixed(1)} s (${decoded.sourceChannels} channel${decoded.sourceChannels === 1 ? '' : 's'}) · stems will need ${(need / 1e6).toFixed(0)} MB on the device`);
    const request: Stage4Request = {type: 'song', left, right};
    w.postMessage(request, [left.buffer, right.buffer]);
  }

  function start(test: Test) {
    if (worker.current || disabled || interrupted) return;
    if (!window.confirm('Experimental model test may exhaust browser memory or close this tab. Save other work first. Continue?')) return;
    if (test.kind === 'webgpu' && test.infer && !initialized) return;
    if (test.kind === 'webgpu' && !test.infer) setInitialized(false);
    if (test.kind === 'song') setStems([]);
    log.current = '';
    append(test.kind === 'song' ? 'Starting on-device song separation (Stage IV, WASM)…'
      : test.kind === 'stage4' ? `Starting Stage IV low-memory test (WASM, ${test.windows} windows)…`
      : 'Starting provider compatibility benchmark (basic optimization)…');
    try {localStorage.setItem(KEY, String(Date.now()));} catch {}
    // A hidden page stops the test, so keep the screen on while it runs (Safari 16.4+, Chromium).
    navigator.wakeLock?.request('screen').then(lock => {wakeLock.current = lock;}).catch(() => {});
    try {
      const w = test.kind === 'webgpu'
        ? new Worker(new URL('../inference/mobile-bench.worker.ts', import.meta.url), {type:'module', name:'mobile-benchmark'})
        : new Worker(new URL('../inference/mobile-stage4.worker.ts', import.meta.url), {type:'module', name:'mobile-stage4'});
      worker.current = w; setRunning(true); onBusy(true);
      const minutes = test.kind === 'song' ? 10 + Math.ceil((song?.seconds ?? 600) / 7.8 * 1.5) : test.kind === 'stage4' ? 15 : 5;
      timer.current = setTimeout(() => stop(`Stopped: ${minutes}-minute timeout`), minutes * 60_000);
      w.onmessage = (e: MessageEvent<Stage4Message>) => {
        if (worker.current !== w) return;
        if (e.data.done) {
          if (test.kind === 'webgpu' && !test.infer && e.data.message === 'Benchmark complete') setInitialized(true);
          const files = e.data.files;
          stop(e.data.message);
          if (files) showStems(files).catch(err => append('Could not open the stems: ' + String(err)));
        } else append(e.data.message);
      };
      w.onerror = e => stop('Worker error: ' + e.message);
      w.onmessageerror = () => stop('Worker message error');
      if (test.kind === 'song') startSong(test.file, w).catch(err => {if (worker.current === w) stop('FAIL: ' + String(err));});
      else w.postMessage(test.kind === 'stage4' ? {type: 'test', windows: test.windows} satisfies Stage4Request : test.infer);
    } catch (e) {stop(String(e));}
  }

  async function chooseSong(file: File | null) {
    setSong(file ? {file, seconds: null} : null);
    if (file) {
      const seconds = await probeDuration(file);
      setSong(current => current?.file === file ? {file, seconds} : current);
    }
  }

  const blocked = disabled || running || interrupted;
  const windows = song?.seconds ? windowsFor(song.seconds) : null;
  return <section className="card">
    <h2>Experimental AI model test</h2>
    <p><strong>Separate a song on this device (experimental).</strong> Runs the Stage IV six-stem model on WebAssembly with one thread. No upload: the song stays on this device. Downloads the {STAGE4_MB} MB model, then writes six 24-bit WAV stems to this browser's storage. Keep this page visible and the screen on until it finishes.</p>
    <label className="file">
      <input type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg" disabled={blocked} onChange={e => void chooseSong(e.target.files?.[0] ?? null)} />
      <span>{song ? song.file.name : 'Choose a song'}</span>
    </label>
    {song && <p>{song.seconds ? `${song.seconds.toFixed(0)} s · ${windows} windows · about ${Math.ceil((windows ?? 0) * IPHONE_SECONDS_PER_WINDOW / 60)} min on the iPhone tested (${IPHONE_SECONDS_PER_WINDOW} s per window)` : 'Reading duration…'}</p>}
    <button disabled={blocked || !song} onClick={() => song && start({kind: 'song', file: song.file})}>Separate this song on this device</button>
    {stems.length > 0 && <ul className="stems">{stems.map(s => <li key={s.name}>
      <strong>{s.name.replace(/\.wav$/, '')}</strong> <audio controls preload="none" src={s.url} /> <a href={s.url} download={`${song?.file.name.replace(/\.[^.]+$/, '') ?? 'song'} - ${s.name}`}>Download ({(s.bytes / 1e6).toFixed(0)} MB)</a>
    </li>)}</ul>}
    {stems.length > 0 && <button disabled={running} onClick={() => void deleteStems()}>Delete stems from this device</button>}
    <p><strong>Stage IV memory test.</strong> Synthetic windows; logs the WebAssembly memory after each.</p>
    {interrupted && <><p>Previous test was interrupted. The last recorded stage is shown below. Retry only after closing other tabs.</p><button onClick={() => {try {localStorage.removeItem(KEY);} catch {} setInterrupted(false);}}>Acknowledge interruption</button></>}
    <button disabled={blocked} onClick={() => start({kind: 'stage4', windows: 1})}>Stage IV: load + 1 window</button>
    <button disabled={blocked} onClick={() => start({kind: 'stage4', windows: 3})}>Stage IV: load + 3 windows</button>
    <p>Older WebGPU experiment: basic graph optimization (143 MB). Known to close the tab on iPhone during initialization.</p>
    <button disabled={blocked} onClick={() => start({kind: 'webgpu', infer: false})}>Test model initialization</button>
    <button disabled={blocked || !initialized} onClick={() => start({kind: 'webgpu', infer: true})}>Test single-window inference</button>
    {running && <button onClick={() => stop('Cancelled')}>Cancel test</button>}
    <pre style={{whiteSpace:'pre-wrap', overflowWrap:'anywhere'}}>{report}</pre>
  </section>;
}
