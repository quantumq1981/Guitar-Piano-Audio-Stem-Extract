import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('apps/web/node_modules/onnxruntime-web/dist');
const fallback = resolve('node_modules/onnxruntime-web/dist');
const server = createServer((req,res) => {
  const name = new URL(req.url,'http://localhost').pathname;
  if (name === '/') {res.setHeader('Content-Type','text/html');res.end('<html><body>WebGPU benchmark</body></html>');return;}
  if (name !== '/candidate.onnx' && !/^\/ort[\w.-]+\.(mjs|wasm)$/.test(name)) {res.writeHead(404).end();return;}
  let file = name === '/candidate.onnx' ? resolve('candidate.onnx') : resolve(root,name.slice(1));
  try {statSync(file);} catch {file=resolve(fallback,name.slice(1));}
  try {
    res.setHeader('Content-Length',statSync(file).size);
    res.setHeader('Content-Type',name.endsWith('.mjs')?'text/javascript':name.endsWith('.wasm')?'application/wasm':'application/octet-stream');
    createReadStream(file).pipe(res);
  } catch {res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try {
  browser=await chromium.launch({args:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage();
  page.on('console',m=>console.log(m.text()));
  await page.goto('http://127.0.0.1:'+server.address().port);
  const result=await page.evaluate(async()=>{
    if (!navigator.gpu || !await navigator.gpu.requestAdapter()) throw Error('No WebGPU adapter in CI');
    const ort=await import('/ort.webgpu.bundle.min.mjs');
    ort.env.wasm.numThreads=1;
    const start=performance.now();
    const s=await ort.InferenceSession.create('/candidate.onnx',{executionProviders:['webgpu'],graphOptimizationLevel:'disabled',enableMemPattern:false,enableCpuMemArena:false});
    console.log('Initialized in '+(performance.now()-start)/1000+' s');
    const x=new ort.Tensor('float32',new Float32Array(2*343980).fill(0.01),[1,2,343980]);
    let out;
    try {
      out=await s.run({mix:x});
      const y=await out.stems.getData();
      if(y.length!==6*2*343980 || !y.every(Number.isFinite)) throw Error('Invalid output');
      return {pass:true,seconds:(performance.now()-start)/1000};
    } finally {x.dispose();if(out)Object.values(out).forEach(t=>t.dispose());await s.release();}
  });
  console.log(JSON.stringify(result));
} finally {await browser?.close();server.close();}
