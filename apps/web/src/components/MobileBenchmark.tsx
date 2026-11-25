import { useEffect, useRef, useState } from 'react';
import { MOBILE_STAGE4_CANDIDATE, WAV_HEADER_BYTES, planChunks, storedStem } from '@stemsplit/core';
import { decodeForModel, probeDuration } from '../audio/decode.ts';
import { STAGE4_STEM_BYTES_PER_SAMPLE, STAGE4_STEM_DIRECTORY, type Stage4Message, type Stage4Request } from '../inference/stage4-protocol.ts';
const KEY = 'stemsplit.experimentalBenchmark';
const LOG = 'stemsplit.experimentalBenchmarkLog';
function savedLog(): string {try {return localStorage.getItem(LOG) ?? '';} catch {return '';}}
type Test = {kind: 'webgpu'; infer: boolean} | {kind: 'stage4'; windows: number} | {kind: 'song'; file: File};
type Stem = {name: string; url: string; bytes: number};
/** Stems in OPFS. `stems` lists the six files only when a run finished all of them; otherwise every file counts as
 * unfinished. `bytes` is what Delete frees (files that could not be read count 0). */
type Stored = {stems: Stem[]; bytes: number; unfinished: number};
const IO = MOBILE_STAGE4_CANDIDATE.io;
const STAGE4_MB = Math.round((MOBILE_STAGE4_CANDIDATE.graph.bytes + MOBILE_STAGE4_CANDIDATE.data.bytes) / 1e6);
/** Measured on the first iPhone run (docs/MOBILE-INFERENCE-DEVELOPMENT.md); other devices differ. */
const IPHONE_SECONDS_PER_WINDOW = 12.5;
const windowsFor = (seconds: number) => planChunks(Math.max(1, Math.round(seconds * IO.sampleRate)), IO.segmentFrames).chunks.length;
// Sync access handles exist only inside dedicated workers, so the page can check for OPFS itself; the worker
// checks for createSyncAccessHandle before writing.
const opfsAvailable = () => typeof navigator.storage?.getDirectory === 'function';

/**
 * Why this window cannot store the stems, or null if it can. getDirectory() alone creates nothing. Measured in WebKit:
 * an ephemeral session (what Safari Private Browsing uses) rejects it with "UnknownError: The operation failed for an
 * unknown transient reason (e.g. out of memory)" on the page and in workers, while storage.estimate() still reports a
 * 1 GiB quota, so the quota check alone does not catch it.
 */
async function storageProblem(): Promise<string | null> {
  if (!opfsAvailable()) return 'This browser has no origin-private file system (OPFS), which the song test needs to store the stems.';
  try {
    await navigator.storage.getDirectory();
    return null;
  } catch (err) {
    return `This window cannot store files on the device (${String(err).replace(/\.$/, '')}). Safari blocks this storage in Private Browsing: ` +
      'open the page in a normal tab to separate a song. The Stage IV memory test below still works here.';
  }
}
const STEM_FILES = IO.stems.map(stem => `${stem}.wav`);
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;

async function stemDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!opfsAvailable()) return null;
  try {return await (await navigator.storage.getDirectory()).getDirectoryHandle(STAGE4_STEM_DIRECTORY);}
  catch {return null;} // NotFoundError: nothing stored
}

/** What an earlier run (finished, cancelled, or killed with the tab) left on the device. */
async function scanStored(): Promise<Stored | null> {
  const dir = await stemDirectory();
  if (!dir) return null;
  const found: {name: string; file: File | null; complete: boolean; frames: number}[] = [];
  for (const name of STEM_FILES) {
    let handle: FileSystemFileHandle;
    try {handle = await dir.getFileHandle(name);} catch {continue;} // never created
    try {
      const file = await handle.getFile(); // disk-backed Blob: no copy in memory
      const {state, frames} = storedStem(new Uint8Array(await file.slice(0, WAV_HEADER_BYTES).arrayBuffer()), file.size);
      found.push({name, file, complete: state === 'complete', frames});
    } catch {found.push({name, file: null, complete: false, frames: 0});} // still locked by a stopping worker
  }
  const bytes = found.reduce((sum, f) => sum + (f.file?.size ?? 0), 0);
  const finished = found.length === STEM_FILES.length && found.every(f => f.complete && f.frames === found[0]!.frames);
  if (!finished) return {stems: [], bytes, unfinished: found.length};
  return {stems: found.map(f => ({name: f.name, url: URL.createObjectURL(f.file!), bytes: f.file!.size})), bytes, unfinished: 0};
}

/** Frees the space a previous run used, so the quota check sees it. Returns the bytes removed. */
async function removeStored(): Promise<number> {
  const before = await scanStored();
  if (!before) return 0;
  for (const s of before.stems) URL.revokeObjectURL(s.url);
  await (await navigator.storage.getDirectory()).removeEntry(STAGE4_STEM_DIRECTORY, {recursive: true});
  return before.bytes;
}

export function MobileBenchmark({disabled, onBusy}: {disabled: boolean; onBusy: (busy: boolean) => void}) {
  const worker = useRef<Worker | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState(savedLog);
  const log = useRef(report);
  const [initialized, setInitialized] = useState(false);
  const [song, setSong] = useState<{file: File; seconds: number | null} | null>(null);
  const [stored, setStored] = useState<Stored | null>(null);
  const [storageBlocked, setStorageBlocked] = useState<string | null>(null);
  // Scans finish asynchronously; a result is applied only if no newer scan or run started meanwhile.
  const scanGeneration = useRef(0);
  async function refreshStored() {
    const generation = ++scanGeneration.current;
    const result = await scanStored().catch(() => null);
    if (generation === scanGeneration.current) setStored(result);
    else for (const s of result?.stems ?? []) URL.revokeObjectURL(s.url);
  }
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
    void refreshStored();
  }
  useEffect(() => {
    const hide = () => {if (document.hidden && worker.current) stop('Stopped: page hidden');};
    document.addEventListener('visibilitychange', hide);
    void refreshStored(); // stems left by a run before a reload or a killed tab
    void storageProblem().then(setStorageBlocked);
    return () => {document.removeEventListener('visibilitychange', hide); worker.current?.terminate(); clearTimeout(timer.current);};
  }, []);
  useEffect(() => () => {for (const s of stored?.stems ?? []) URL.revokeObjectURL(s.url);}, [stored]);

  async function deleteStems() {
    scanGeneration.current++;
    setStored(null);
    try {
      const freed = await removeStored();
      append(`Deleted the stems from this device (${mb(freed)})`);
    } catch (err) {append('Could not delete the stems: ' + String(err));}
    void refreshStored();
  }

  async function startSong(file: File, w: Worker) {
    const problem = await storageProblem();
    if (problem) {setStorageBlocked(problem); throw new Error(problem);}
    // The worker replaces the stems too, but only after this quota check: free the old ones first.
    const freed = await removeStored();
    if (freed > 0) append(`Removed the previous stems (${mb(freed)}) to make room`);
    append(`Decoding ${file.name} (${(file.size / 1e6).toFixed(1)} MB) at ${IO.sampleRate} Hz…`);
    const decoded = await decodeForModel(file);
    const frames = decoded.left.length;
    const need = IO.stems.length * (WAV_HEADER_BYTES + frames * IO.channels * STAGE4_STEM_BYTES_PER_SAMPLE);
    const {quota, usage} = await navigator.storage.estimate();
    if (quota !== undefined && quota - (usage ?? 0) < need * 1.1) {
      throw new Error(`Not enough on-device storage: stems need ${mb(need)}, ${mb(quota - (usage ?? 0))} available`);
    }
    // Copies own their buffers, so they can be transferred; the decoded AudioBuffer is then free to be collected.
    const left = decoded.left.slice();
    const right = decoded.right.slice();
    append(`Decoded ${decoded.durationSec.toFixed(1)} s (${decoded.sourceChannels} channel${decoded.sourceChannels === 1 ? '' : 's'}) · stems will need ${mb(need)} on the device`);
    const request: Stage4Request = {type: 'song', left, right};
    w.postMessage(request, [left.buffer, right.buffer]);
  }

  function start(test: Test) {
    if (worker.current || disabled || interrupted) return;
    if (!window.confirm('Experimental model test may exhaust browser memory or close this tab. Save other work first. Continue?')) return;
    if (test.kind === 'webgpu' && test.infer && !initialized) return;
    if (test.kind === 'webgpu' && !test.infer) setInitialized(false);
    if (test.kind === 'song') {scanGeneration.current++; setStored(null);}
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
          stop(e.data.message); // rescans storage: a finished song shows its stems
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
    {storageBlocked && <p className="warning">{storageBlocked}</p>}
    <label className="file">
      <input type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg" disabled={blocked || storageBlocked !== null} onChange={e => void chooseSong(e.target.files?.[0] ?? null)} />
      <span>{song ? song.file.name : 'Choose a song'}</span>
    </label>
    {song && <p>{song.seconds ? `${song.seconds.toFixed(0)} s · ${windows} windows · about ${Math.ceil((windows ?? 0) * IPHONE_SECONDS_PER_WINDOW / 60)} min on the iPhone tested (${IPHONE_SECONDS_PER_WINDOW} s per window)` : 'Reading duration…'}</p>}
    <button disabled={blocked || !song || storageBlocked !== null} onClick={() => song && start({kind: 'song', file: song.file})}>Separate this song on this device</button>
    {stored && stored.stems.length > 0 && <ul className="stems">{stored.stems.map(s => <li key={s.name}>
      <strong>{s.name.replace(/\.wav$/, '')}</strong> <audio controls preload="none" src={s.url} /> <a href={s.url} download={`${song?.file.name.replace(/\.[^.]+$/, '') ?? 'song'} - ${s.name}`}>Download ({mb(s.bytes)})</a>
    </li>)}</ul>}
    {stored && stored.stems.length === 0 && <p>Unfinished stems from a stopped run are stored on this device{stored.bytes > 0 ? ` (${mb(stored.bytes)})` : ''}. Starting a new song replaces them.</p>}
    {stored && <button disabled={running} onClick={() => void deleteStems()}>Delete stems from this device{stored.bytes > 0 ? ` (${mb(stored.bytes)})` : ''}</button>}
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
