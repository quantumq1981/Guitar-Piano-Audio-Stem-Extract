import { useEffect, useRef, useState } from 'react';
const KEY = 'stemsplit.experimentalBenchmark';
export function MobileBenchmark({disabled, onBusy}: {disabled: boolean; onBusy: (busy: boolean) => void}) {
  const worker = useRef<Worker | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState('');
  const [interrupted, setInterrupted] = useState(() => {try {return localStorage.getItem(KEY) !== null;} catch {return false;}});
  function stop(message: string) {
    worker.current?.terminate(); worker.current = null;
    clearTimeout(timer.current);
    try {localStorage.removeItem(KEY);} catch {}
    setRunning(false); onBusy(false);
    setReport(old => old + '\n' + message);
  }
  useEffect(() => {
    const hide = () => {if (document.hidden && worker.current) stop('Stopped: page hidden');};
    document.addEventListener('visibilitychange', hide);
    return () => {document.removeEventListener('visibilitychange', hide); worker.current?.terminate(); clearTimeout(timer.current);};
  }, []);
  function start(infer: boolean) {
    if (worker.current || disabled || interrupted) return;
    if (!window.confirm('Experimental model test may exhaust browser memory or close this tab. Save other work first. Continue?')) return;
    setReport('Starting experimental benchmark…');
    try {localStorage.setItem(KEY, String(Date.now()));} catch {}
    try {
      const w = new Worker(new URL('../inference/mobile-bench.worker.ts', import.meta.url), {type:'module', name:'mobile-benchmark'});
      worker.current = w; setRunning(true); onBusy(true);
      timer.current = setTimeout(() => stop('Stopped: five-minute timeout'), 300000);
      w.onmessage = (e: MessageEvent<{message: string; done?: boolean}>) => {
        if (e.data.done) stop(e.data.message);
        else setReport(old => old + '\n' + e.data.message);
      };
      w.onerror = e => stop('Worker error: ' + e.message);
      w.onmessageerror = () => stop('Worker message error');
      w.postMessage(infer);
    } catch (e) {stop(String(e));}
  }
  return <section className="card">
    <h2>Experimental AI model test</h2>
    <p>Downloads 143 MB. No audio upload. This test may close the tab if memory is insufficient. Keep this page visible.</p>
    {interrupted && <><p>Previous test was interrupted. Retry only after closing other tabs.</p><button onClick={() => {try {localStorage.removeItem(KEY);} catch {} setInterrupted(false);}}>Acknowledge interruption</button></>}
    <button disabled={disabled || running || interrupted} onClick={() => start(false)}>Test model initialization</button>
    <button disabled={disabled || running || interrupted} onClick={() => start(true)}>Test single-window inference</button>
    {running && <button onClick={() => stop('Cancelled')}>Cancel test</button>}
    <pre style={{whiteSpace:'pre-wrap', overflowWrap:'anywhere'}}>{report}</pre>
  </section>;
}
