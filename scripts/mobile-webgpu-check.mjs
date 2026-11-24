import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, statSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const validate = process.env.ORT_VALIDATE === '1';
const provider = process.env.ORT_PROVIDER || 'webgpu';
const pinned = process.env.ORT_PINNED === '1';
const root = resolve(pinned ? 'ort-compat/node_modules/onnxruntime-web/dist' : 'apps/web/node_modules/onnxruntime-web/dist');
const fallback = resolve('node_modules/onnxruntime-web/dist');
const server = createServer((req,res) => {
  const name = new URL(req.url,'http://localhost').pathname;
  if (name === '/') {res.setHeader('Content-Type','text/html');res.end('<html><body>WebGPU benchmark</body></html>');return;}
  if (!['/candidate.onnx','/reference-input.bin','/reference-output.bin'].includes(name) && !/^\/ort[\w.-]+\.(mjs|wasm)$/.test(name)) {res.writeHead(404).end();return;}
  let file = ['/candidate.onnx','/reference-input.bin','/reference-output.bin'].includes(name) ? resolve(name.slice(1)) : resolve(root,name.slice(1));
  try {statSync(file);} catch {if (pinned) {res.writeHead(404).end();return;} file=resolve(fallback,name.slice(1));}
  try {
    res.setHeader('Content-Length',statSync(file).size);
    res.setHeader('Content-Type',name.endsWith('.mjs')?'text/javascript':name.endsWith('.wasm')?'application/wasm':'application/octet-stream');
    createReadStream(file).pipe(res);
  } catch {res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
let peakKiB = 0, baselineKiB = 0, samples = 0;
function sample() {
  let sum = 0;
  for (const pid of readdirSync('/proc').filter(x=>/^\d+$/.test(x))) {
    try {
      const cmd = readFileSync('/proc/'+pid+'/cmdline','utf8');
      if (!cmd.includes('chrome') && !cmd.includes('chromium')) continue;
      const match = readFileSync('/proc/'+pid+'/smaps_rollup','utf8').match(/^Pss:\s+(\d+) kB/m);
      if (match) sum += Number(match[1]);
    } catch {}
  }
  if (sum) {samples++; peakKiB=Math.max(peakKiB,sum);}
  return sum;
}
let timer;
try {
  browser=await chromium.launch({args:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage();
  page.on('console',m=>console.log(m.text()));
  await page.goto('http://127.0.0.1:'+server.address().port);
  baselineKiB=sample();
  timer=setInterval(sample,250);
  const result=await page.evaluate(async({provider,validate})=>{
    if (provider === 'webgpu' && (!navigator.gpu || !await navigator.gpu.requestAdapter())) throw Error('No WebGPU adapter in CI');
    const ort=await import(provider === 'wasm' ? '/ort.wasm.min.mjs' : '/ort.webgpu.bundle.min.mjs');
    ort.env.wasm.numThreads=1;
    const start=performance.now();
    const s=await ort.InferenceSession.create('/candidate.onnx',{executionProviders:[provider],graphOptimizationLevel:'disabled',enableMemPattern:false,enableCpuMemArena:false});
    console.log('Initialized in '+(performance.now()-start)/1000+' s');
    if (validate) {
      const load = async name => {
        const r=await fetch(name);
        if (!r.ok) throw Error('Reference HTTP '+r.status);
        return new Float32Array(await r.arrayBuffer());
      };
      try {
        const input=await load('/reference-input.bin');
        const ref=await load('/reference-output.bin');
        const n=2*343980;
        if(input.length!==n || ref.length!==6*n) throw Error('Reference shape mismatch');
        const runs=[];
        for(let run=0;run<3;run++){
          const x=new ort.Tensor('float32',input,[1,2,343980]);
          let out;
          const t=performance.now();
          try {
            out=await s.run({mix:x});
            const y=await out.stems.getData();
            if(y.length!==ref.length || !y.every(Number.isFinite)) throw Error('Invalid output');
            const stems=[];
            for(let k=0;k<6;k++){
              let signal=0,error=0,maxAbs=0;
              for(let i=k*n;i<(k+1)*n;i++){
                const d=y[i]-ref[i];
                signal+=ref[i]*ref[i];error+=d*d;maxAbs=Math.max(maxAbs,Math.abs(d));
              }
              const snr=10*Math.log10(Math.max(signal,1e-30)/Math.max(error,1e-30));
              stems.push({stem:k,snr,maxAbs});
              if(!Number.isFinite(snr) || (snr<40 && maxAbs>1e-5)) throw Error('Parity failure '+JSON.stringify(stems));
            }
            runs.push({seconds:(performance.now()-t)/1000,stems});
            console.log(JSON.stringify({run,...runs.at(-1)}));
          } finally {x.dispose();if(out)Object.values(out).forEach(t=>t.dispose());}
        }
        return {pass:true,runs};
      } finally {await s.release();}
    }
    const x=new ort.Tensor('float32',Float32Array.from({length:2*343980},(_,i)=>0.05*Math.sin(2*Math.PI*(i<343980?440:660)*i/44100)),[1,2,343980]);
    let out;
    try {
      out=await s.run({mix:x});
      const y=await out.stems.getData();
      if(y.length!==6*2*343980 || !y.every(Number.isFinite)) throw Error('Invalid output');
      return {pass:true,seconds:(performance.now()-start)/1000};
    } finally {x.dispose();if(out)Object.values(out).forEach(t=>t.dispose());await s.release();}
  },{provider,validate});
  console.log(JSON.stringify({provider,pinned,...result}));
} finally {clearInterval(timer);sample();console.log(JSON.stringify({baselineKiB,peakKiB,samples,metric:'aggregate Chromium PSS; sampled, not device RAM'}));await browser?.close();server.close();}
