import { useEffect, useRef, useState } from 'react';
import {
  MOBILE_STAGE4_CANDIDATE, RUN_INPUT_FILE, RUN_MANIFEST_FILE, STAGE4_RESUME_EXPECTATION, STAGE4_THREAD_OPTIONS, WAV_HEADER_BYTES,
  decideResume, parseRunManifest, planChunks, runStorageNeed, stage4Threads, storedStem,
} from '@stemsplit/core';
import { decodeForModel, probeDuration } from '../audio/decode.ts';
import { STAGE4_STEM_DIRECTORY, STAGE4_STEM_SAMPLE_FORMAT, type Stage4Message, type Stage4Request } from '../inference/stage4-protocol.ts';
const KEY = 'stemsplit.experimentalBenchmark';
const THREADS_KEY = 'stemsplit.stage4Threads';
function savedThreads(): number {
  try {const t = Number(localStorage.getItem(THREADS_KEY)); return STAGE4_THREAD_OPTIONS.includes(t) ? t : 1;} catch {return 1;}
}
const LOG = 'stemsplit.experimentalBenchmarkLog';
function savedLog(): string {try {return localStorage.getItem(LOG) ?? '';} catch {return '';}}
type Test = {kind: 'webgpu'; infer: boolean} | {kind: 'stage4'; windows: number} | {kind: 'song'; file: File} | {kind: 'resume'; windowsLeft: number};
type Stem = {name: string; url: string; bytes: number};
/** A run in OPFS. `stems` lists the six files only when a run finished all of them; otherwise every file counts as
 * unfinished. `bytes` is what Delete frees (files that could not be read count 0). `resume` is set when core
 * decideResume() can continue the stopped run; `cannotResume` says why not, for a stopped run that has a run.json. */
type Stored = {
  stems: Stem[]; bytes: number; unfinished: number; sourceName: string | null;
  resume: {done: number; total: number} | null; cannotResume: string | null;
  /** A stopped worker still holds some files (terminate() releases OPFS locks asynchronously): scan again soon. */
  locked: boolean;
};
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
const STEM_FORMAT = {sampleRate: IO.sampleRate, channels: IO.channels, sampleFormat: STAGE4_STEM_SAMPLE_FORMAT} as const;
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;

async function stemDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!opfsAvailable()) return null;
  try {return await (await navigator.storage.getDirectory()).getDirectoryHandle(STAGE4_STEM_DIRECTORY);}
  catch {return null;} // NotFoundError: nothing stored
}

const LOCKED = Symbol('locked');
/** The file (a disk-backed Blob: no copy in memory), null if it was never created, or LOCKED while a stopping
 * worker still holds it. */
async function fileIn(dir: FileSystemDirectoryHandle, name: string): Promise<File | null | typeof LOCKED> {
  try {return await (await dir.getFileHandle(name)).getFile();}
  catch (err) {return err instanceof DOMException && err.name === 'NotFoundError' ? null : LOCKED;}
}

/** What an earlier run (finished, cancelled, or killed with the tab) left on the device. */
async function scanStored(): Promise<Stored | null> {
  const dir = await stemDirectory();
  if (!dir) return null;
  const found: {name: string; file: File | null; complete: boolean; frames: number}[] = [];
  let locked = false;
  for (const name of STEM_FILES) {
    const file = await fileIn(dir, name);
    if (file === null) continue; // never created
    if (file === LOCKED) {locked = true; found.push({name, file: null, complete: false, frames: 0}); continue;}
    const {state, frames} = storedStem(new Uint8Array(await file.slice(0, WAV_HEADER_BYTES).arrayBuffer()), file.size);
    found.push({name, file, complete: state === 'complete', frames});
  }
  const [manifestEntry, inputEntry] = await Promise.all([fileIn(dir, RUN_MANIFEST_FILE), fileIn(dir, RUN_INPUT_FILE)]);
  if (manifestEntry === LOCKED || inputEntry === LOCKED) locked = true;
  const manifestFile = manifestEntry === LOCKED ? null : manifestEntry;
  const input = inputEntry === LOCKED ? null : inputEntry;
  const manifest = manifestFile ? parseRunManifest(await manifestFile.text().catch(() => '')) : null;
  const bytes = found.reduce((sum, f) => sum + (f.file?.size ?? 0), 0) + (manifestFile?.size ?? 0) + (input?.size ?? 0);
  const sourceName = manifest?.source.name ?? null;
  const finished = found.length === STEM_FILES.length && found.every(f => f.complete && f.frames === found[0]!.frames);
  if (finished) {
    return {stems: found.map(f => ({name: f.name, url: URL.createObjectURL(f.file!), bytes: f.file!.size})), bytes, unfinished: 0,
      sourceName, resume: null, cannotResume: null, locked: false};
  }
  if (bytes === 0 && found.length === 0 && !locked) return null; // an empty directory from a run that stopped before writing
  if (locked) return {stems: [], bytes, unfinished: found.length, sourceName, resume: null, cannotResume: 'the stopped run is still releasing its files', locked};
  let resume: Stored['resume'] = null;
  let cannotResume: string | null = !manifestFile ? 'it stopped before the song was stored'
    : !manifest ? 'its run.json is not valid' : null;
  if (manifest) {
    const sizes = STEM_FILES.map(name => found.find(f => f.name === name)?.file?.size ?? null);
    const d = decideResume(manifest, STAGE4_RESUME_EXPECTATION, {inputBytes: input?.size ?? null, stemBytes: sizes});
    if (d.kind === 'resume') resume = {done: d.startChunk, total: d.plan.chunks.length};
    else if (d.kind === 'unusable') cannotResume = d.reason;
  }
  return {stems: [], bytes, unfinished: found.length, sourceName, resume, cannotResume, locked};
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
  const threadEnv = {crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency};
  const threadChoices = STAGE4_THREAD_OPTIONS.filter(t => stage4Threads(t, threadEnv) === t);
  const [threads, setThreadsState] = useState(() => stage4Threads(savedThreads(), threadEnv));
  function setThreads(t: number) {
    setThreadsState(t);
    try {localStorage.setItem(THREADS_KEY, String(t));} catch {}
  }
  const [storageBlocked, setStorageBlocked] = useState<string | null>(null);
  // Scans finish asynchronously; a result is applied only if no newer scan or run started meanwhile.
  const scanGeneration = useRef(0);
  async function refreshStored(attempt = 0) {
    const generation = ++scanGeneration.current;
    const result = await scanStored().catch(() => null);
    if (generation !== scanGeneration.current) {
      for (const s of result?.stems ?? []) URL.revokeObjectURL(s.url);
      return;
    }
    setStored(result);
    // A stopped worker releases its file locks shortly after terminate(); look again until it has.
    if (result?.locked && attempt < 10) setTimeout(() => {if (generation === scanGeneration.current) void refreshStored(attempt + 1);}, 500);
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
    return () => {
      document.removeEventListener('visibilitychange', hide);
      // Leaving the diagnostics screen mid-test unmounts the card: release the app-wide busy lock with the worker.
      const wasRunning = worker.current !== null;
      worker.current?.terminate(); worker.current = null;
      clearTimeout(timer.current);
      void wakeLock.current?.release().catch(() => {}); wakeLock.current = null;
      if (wasRunning) onBusy(false);
    };
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

  async function startSong(file: File, w: Worker, threads: number) {
    const problem = await storageProblem();
    if (problem) {setStorageBlocked(problem); throw new Error(problem);}
    // The worker replaces the stems too, but only after this quota check: free the old ones first.
    const freed = await removeStored();
    if (freed > 0) append(`Removed the previous stems (${mb(freed)}) to make room`);
    append(`Decoding ${file.name} (${(file.size / 1e6).toFixed(1)} MB) at ${IO.sampleRate} Hz…`);
    const decoded = await decodeForModel(file);
    const frames = decoded.left.length;
    // The song is stored too (float32, freed when the stems are complete) so that a stopped run can resume.
    const need = runStorageNeed(frames, IO.stems.length, STEM_FORMAT);
    const {quota, usage} = await navigator.storage.estimate();
    if (quota !== undefined && quota - (usage ?? 0) < need.total * 1.1) {
      throw new Error(`Not enough on-device storage: stems and the stored song need ${mb(need.total)}, ${mb(quota - (usage ?? 0))} available`);
    }
    // Copies own their buffers, so they can be transferred; the decoded AudioBuffer is then free to be collected.
    const left = decoded.left.slice();
    const right = decoded.right.slice();
    append(`Decoded ${decoded.durationSec.toFixed(1)} s (${decoded.sourceChannels} channel${decoded.sourceChannels === 1 ? '' : 's'}) · ` +
      `stems will need ${mb(need.stems)} on the device, plus ${mb(need.input)} for the song until they are done`);
    const request: Stage4Request = {type: 'song', left, right, threads, source: {name: file.name, bytes: file.size}};
    w.postMessage(request, [left.buffer, right.buffer]);
  }

  function start(test: Test) {
    if (worker.current || disabled || interrupted) return;
    if (!window.confirm('Experimental model test may exhaust browser memory or close this tab. Save other work first. Continue?')) return;
    if (test.kind === 'webgpu' && test.infer && !initialized) return;
    if (test.kind === 'webgpu' && !test.infer) setInitialized(false);
    if (test.kind === 'song' || test.kind === 'resume') {scanGeneration.current++; setStored(null);}
    // A resumed run keeps the stopped run's log, so the whole song's history stays in one place.
    if (test.kind !== 'resume') log.current = '';
    const threadNote = `${threads} thread${threads === 1 ? '' : 's'}`;
    append(test.kind === 'resume' ? `Resuming on-device song separation (Stage IV, WASM, ${threadNote})…`
      : test.kind === 'song' ? `Starting on-device song separation (Stage IV, WASM, ${threadNote})…`
      : test.kind === 'stage4' ? `Starting Stage IV low-memory test (WASM, ${threadNote}, ${test.windows} windows)…`
      : 'Starting provider compatibility benchmark (basic optimization)…');
    try {localStorage.setItem(KEY, String(Date.now()));} catch {}
    // A hidden page stops the test, so keep the screen on while it runs (Safari 16.4+, Chromium).
    navigator.wakeLock?.request('screen').then(lock => {wakeLock.current = lock;}).catch(() => {});
    try {
      const w = test.kind === 'webgpu'
        ? new Worker(new URL('../inference/mobile-bench.worker.ts', import.meta.url), {type:'module', name:'mobile-benchmark'})
        : new Worker(new URL('../inference/mobile-stage4.worker.ts', import.meta.url), {type:'module', name:'mobile-stage4'});
      worker.current = w; setRunning(true); onBusy(true);
      const minutes = test.kind === 'song' ? 10 + Math.ceil((song?.seconds ?? 600) / 7.8 * 1.5)
        : test.kind === 'resume' ? 10 + Math.ceil((test.windowsLeft + 1) * 1.5) : test.kind === 'stage4' ? 15 : 5;
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
      if (test.kind === 'song') startSong(test.file, w, threads).catch(err => {if (worker.current === w) stop('FAIL: ' + String(err));});
      else if (test.kind === 'resume') w.postMessage({type: 'resume', threads} satisfies Stage4Request);
      else w.postMessage(test.kind === 'stage4' ? {type: 'test', windows: test.windows, threads} satisfies Stage4Request : test.infer);
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
    <p><strong>Separate a song on this device (experimental).</strong> Runs the Stage IV six-stem model on WebAssembly with one thread. No upload: the song stays on this device. Downloads the {STAGE4_MB} MB model, then writes six 24-bit WAV stems to this browser's storage. Keep this page visible and the screen on until it finishes: switching apps, locking the phone or leaving Safari stops the run. Come back and tap <em>Resume</em> to continue from the last finished window.</p>
    <label className="threads">WASM threads (song and Stage IV tests){' '}
      <select value={threads} disabled={blocked} onChange={e => setThreads(Number(e.target.value))}>
        {threadChoices.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
    </label>
    {threadChoices.length === 1 && <p className="muted">More threads need a cross-origin isolated page and more than one core.</p>}
    {storageBlocked && <p className="warning">{storageBlocked}</p>}
    <label className="file">
      <input type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg" disabled={blocked || storageBlocked !== null} onChange={e => void chooseSong(e.target.files?.[0] ?? null)} />
      <span>{song ? song.file.name : 'Choose a song'}</span>
    </label>
    {song && <p>{song.seconds ? `${song.seconds.toFixed(0)} s · ${windows} windows · about ${Math.ceil((windows ?? 0) * IPHONE_SECONDS_PER_WINDOW / 60)} min on the iPhone tested at 1 thread (${IPHONE_SECONDS_PER_WINDOW} s per window)` : 'Reading duration…'}</p>}
    <button disabled={blocked || !song || storageBlocked !== null} onClick={() => song && start({kind: 'song', file: song.file})}>Separate this song on this device</button>
    {stored && stored.stems.length > 0 && <ul className="stems">{stored.stems.map(s => <li key={s.name}>
      <strong>{s.name.replace(/\.wav$/, '')}</strong> <audio controls preload="none" src={s.url} /> <a href={s.url} download={`${(stored.sourceName ?? song?.file.name ?? 'song').replace(/\.[^.]+$/, '')} - ${s.name}`}>Download ({mb(s.bytes)})</a>
    </li>)}</ul>}
    {stored && stored.stems.length === 0 && <p>Unfinished stems from a stopped run{stored.sourceName ? ` of ${stored.sourceName}` : ''} are stored on this device{stored.bytes > 0 ? ` (${mb(stored.bytes)})` : ''}.{' '}
      {stored.resume ? `${stored.resume.done} of ${stored.resume.total} windows are finished; Resume continues from there.`
        : `It cannot be resumed${stored.cannotResume ? `: ${stored.cannotResume}` : ''}.`} Starting a new song replaces them.</p>}
    {stored?.resume && <button disabled={blocked || storageBlocked !== null}
      onClick={() => stored.resume && start({kind: 'resume', windowsLeft: stored.resume.total - stored.resume.done})}>
      Resume ({stored.resume.total - stored.resume.done} windows left, about {Math.ceil((stored.resume.total - stored.resume.done + 1) * IPHONE_SECONDS_PER_WINDOW / 60)} min on the iPhone tested)</button>}
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
