import { useEffect, useRef, useState } from 'react';
const KEY = 'stemsplit.experimentalBenchmark';
const LOG = 'stemsplit.experimentalBenchmarkLog';
function savedLog(): string {try {return localStorage.getItem(LOG) ?? '';} catch {return '';}}
export function MobileBenchmark({disabled, onBusy}: {disabled: boolean; onBusy: (busy: boolean) => void}) {
  const worker = useRef<Worker | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
    try {localStorage.removeItem(KEY);} catch {}
    setRunning(false); onBusy(false);
    append(message);
  }
  useEffect(() => {
    const hide = () => {if (document.hidden && worker.current) stop('Stopped: page hidden');};
    document.addEventListener('visibilitychange', hide);
    return () => {document.removeEventListener('visibilitychange', hide); worker.current?.terminate(); clearTimeout(timer.current);};
  }, []);
  function start(infer: boolean) {
    if (worker.current || disabled || interrupted) return;
    if (!window.confirm('Experimental model test may exhaust browser memory or close this tab. Save other work first. Continue?')) return;
    if (infer && !initialized) return;
    if (!infer) setInitialized(false);
    log.current = '';
    append('Starting provider compatibility benchmark (basic optimization)…');
    try {localStorage.setItem(KEY, String(Date.now()));} catch {}
    try {
      const w = new Worker(new URL('../inference/mobile-bench.worker.ts', import.meta.url), {type:'module', name:'mobile-benchmark'});
      worker.current = w; setRunning(true); onBusy(true);
      timer.current = setTimeout(() => stop('Stopped: five-minute timeout'), 300000);
      w.onmessage = (e: MessageEvent<{message: string; done?: boolean}>) => {
        if (worker.current !== w) return;
        if (e.data.done) {
          if (!infer && e.data.message === 'Benchmark complete') setInitialized(true);
          stop(e.data.message);
        } else append(e.data.message);
      };
      w.onerror = e => stop('Worker error: ' + e.message);
      w.onmessageerror = () => stop('Worker message error');
      w.postMessage(infer);
    } catch (e) {stop(String(e));}
  }
  return <section className="card">
    <h2>Experimental AI model test</h2>
    <p>Provider compatibility experiment: basic graph optimization. Downloads 143 MB. No audio upload. Basic optimization can expand FP16 weights to FP32; this test may close the tab if memory is insufficient. Keep this page visible.</p>
    {interrupted && <><p>Previous test was interrupted. The last recorded stage is shown below. Retry only after closing other tabs.</p><button onClick={() => {try {localStorage.removeItem(KEY);} catch {} setInterrupted(false);}}>Acknowledge interruption</button></>}
    <button disabled={disabled || running || interrupted} onClick={() => start(false)}>Test model initialization</button>
    <button disabled={disabled || running || interrupted || !initialized} onClick={() => start(true)}>Test single-window inference</button>
    {running && <button onClick={() => stop('Cancelled')}>Cancel test</button>}
    <pre style={{whiteSpace:'pre-wrap', overflowWrap:'anywhere'}}>{report}</pre>
  </section>;
}
