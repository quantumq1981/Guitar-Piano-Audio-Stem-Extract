import { useEffect, useRef, useState } from 'react';
import { MOBILE_STAGE4_CANDIDATE } from '@stemsplit/core';
const KEY = 'stemsplit.experimentalBenchmark';
const LOG = 'stemsplit.experimentalBenchmarkLog';
function savedLog(): string {try {return localStorage.getItem(LOG) ?? '';} catch {return '';}}
type Test = {kind: 'webgpu'; infer: boolean} | {kind: 'stage4'; windows: number};
const STAGE4_MB = Math.round((MOBILE_STAGE4_CANDIDATE.graph.bytes + MOBILE_STAGE4_CANDIDATE.data.bytes) / 1e6);
export function MobileBenchmark({disabled, onBusy}: {disabled: boolean; onBusy: (busy: boolean) => void}) {
  const worker = useRef<Worker | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState(savedLog);
  const log = useRef(report);
  const [initialized, setInitialized] = useState(false);
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
  function start(test: Test) {
    if (worker.current || disabled || interrupted) return;
    if (!window.confirm('Experimental model test may exhaust browser memory or close this tab. Save other work first. Continue?')) return;
    if (test.kind === 'webgpu' && test.infer && !initialized) return;
    if (test.kind === 'webgpu' && !test.infer) setInitialized(false);
    log.current = '';
    append(test.kind === 'stage4'
      ? `Starting Stage IV low-memory test (WASM, ${test.windows} windows)…`
      : 'Starting provider compatibility benchmark (basic optimization)…');
    try {localStorage.setItem(KEY, String(Date.now()));} catch {}
    // A hidden page stops the test, so keep the screen on while it runs (Safari 16.4+, Chromium).
    navigator.wakeLock?.request('screen').then(lock => {wakeLock.current = lock;}).catch(() => {});
    try {
      const w = test.kind === 'stage4'
        ? new Worker(new URL('../inference/mobile-stage4.worker.ts', import.meta.url), {type:'module', name:'mobile-stage4'})
        : new Worker(new URL('../inference/mobile-bench.worker.ts', import.meta.url), {type:'module', name:'mobile-benchmark'});
      worker.current = w; setRunning(true); onBusy(true);
      const minutes = test.kind === 'stage4' ? 15 : 5;
      timer.current = setTimeout(() => stop(`Stopped: ${minutes}-minute timeout`), minutes * 60_000);
      w.onmessage = (e: MessageEvent<{message: string; done?: boolean}>) => {
        if (worker.current !== w) return;
        if (e.data.done) {
          if (test.kind === 'webgpu' && !test.infer && e.data.message === 'Benchmark complete') setInitialized(true);
          stop(e.data.message);
        } else append(e.data.message);
      };
      w.onerror = e => stop('Worker error: ' + e.message);
      w.onmessageerror = () => stop('Worker message error');
      w.postMessage(test.kind === 'stage4' ? {windows: test.windows} : test.infer);
    } catch (e) {stop(String(e));}
  }
  const blocked = disabled || running || interrupted;
  return <section className="card">
    <h2>Experimental AI model test</h2>
    <p><strong>Stage IV low-memory test (recommended).</strong> Runs the memory-reduced six-stem model on WebAssembly with one thread. Downloads {STAGE4_MB} MB. No audio upload. Each 7.8-second window takes roughly 20–60 s on a phone. Every step and the WebAssembly memory are logged, so the last stage stays visible if the browser closes the tab. Keep this page visible.</p>
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
